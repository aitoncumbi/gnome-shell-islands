// Uninstall apps from the app grid's context menu.
//
// Three kinds of app can be removed:
//  - Flatpak apps, with `flatpak uninstall` (polkit asks for a password for
//    system-wide installs),
//  - pacman packages, with `pkexec pacman -Rns` after a dry run that lists
//    what goes and refuses if other packages still need it,
//  - launchers in ~/.local/share/applications, which are moved to the Trash.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Dialog from './dialog.js';
import * as Main from './main.js';
import * as ModalDialog from './modalDialog.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.File.prototype, 'trash_async');

const PACMAN_LOCK = '/var/lib/pacman/db.lck';

// Packages the desktop needs. Uninstalling an app that belongs to one of
// these, or whose removal would take one of these with it, is refused.
const PROTECTED_PACKAGES = new Set([
    'base', 'bash', 'dbus', 'filesystem', 'gdm', 'glib2', 'glibc',
    'gnome-control-center', 'gnome-keyring', 'gnome-session',
    'gnome-settings-daemon', 'gnome-shell', 'gtk3', 'gtk4', 'linux',
    'mutter', 'pacman', 'pkexec', 'polkit', 'sudo', 'systemd',
    'xdg-desktop-portal', 'xdg-desktop-portal-gnome',
]);

export const Kind = {
    FLATPAK: 'flatpak',
    PACMAN: 'pacman',
    LOCAL: 'local',
};

const _inProgress = new Set();

/**
 * Work out how an app could be removed, without running anything.
 *
 * @param {Shell.App} app - the app
 * @returns {object|null} - {kind, path, flatpakId, flatpakUser}, or null
 *   when the app can't be uninstalled from here
 */
export function classify(app) {
    const appInfo = app?.app_info;
    const path = appInfo?.get_filename();
    if (!path)
        return null;

    const flatpakId = appInfo.has_key('X-Flatpak')
        ? appInfo.get_string('X-Flatpak') : null;
    if (flatpakId) {
        if (!GLib.find_program_in_path('flatpak'))
            return null;
        const userDir = GLib.build_filenamev(
            [GLib.get_user_data_dir(), 'flatpak']);
        return {
            kind: Kind.FLATPAK,
            path,
            flatpakId,
            flatpakUser: path.startsWith(`${userDir}/`),
        };
    }

    const localDir = GLib.build_filenamev(
        [GLib.get_user_data_dir(), 'applications']);
    if (path.startsWith(`${localDir}/`))
        return {kind: Kind.LOCAL, path};

    if (path.startsWith('/usr/share/applications/') &&
        GLib.find_program_in_path('pacman') &&
        GLib.find_program_in_path('pkexec'))
        return {kind: Kind.PACMAN, path};

    return null;
}

/**
 * @param {Shell.App} app - the app
 * @returns {bool} - whether the menu should offer to uninstall it
 */
export function canUninstall(app) {
    return !_inProgress.has(app?.get_id()) && classify(app) !== null;
}

async function _run(argv) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.setenv('LC_ALL', 'C', true);
    const proc = launcher.spawnv(argv);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
    return {
        status: proc.get_exit_status(),
        stdout: stdout ?? '',
        stderr: stderr ?? '',
    };
}

function _lastLines(text, n = 3) {
    return text.trim().split('\n').slice(-n).join('\n');
}

class UninstallError extends Error {}

// Find the pacman package that owns the launcher and the full set of
// packages `pacman -Rns` would take with it.
async function _pacmanPlan(path) {
    const owner = await _run(['pacman', '-Qqo', path]);
    const pkg = owner.stdout.trim();
    if (owner.status !== 0 || !pkg)
        throw new UninstallError(_('No installed package owns this app.'));

    if (PROTECTED_PACKAGES.has(pkg)) {
        throw new UninstallError(
            _('It is part of “%s”, which the desktop needs.').format(pkg));
    }

    // A dry run needs no root: it prints what would go, or fails if other
    // packages depend on this one.
    const dry = await _run(['pacman', '-Rsp', '--print-format', '%n', pkg]);
    if (dry.status !== 0) {
        const output = `${dry.stdout}\n${dry.stderr}`;
        const needers = [...output.matchAll(/required by (\S+)/g)]
            .map(m => m[1]);
        const unique = [...new Set(needers)];
        if (unique.length > 0) {
            const shown = unique.slice(0, 4).join(', ');
            const more = unique.length > 4 ? ', …' : '';
            throw new UninstallError(
                _('Package “%s” is needed by %s.').format(pkg, shown + more));
        }
        throw new UninstallError(_lastLines(dry.stderr) ||
            _('pacman could not plan the removal.'));
    }

    const removed = dry.stdout.trim().split('\n').filter(n => n);
    const blocked = removed.filter(n => PROTECTED_PACKAGES.has(n));
    if (blocked.length > 0) {
        throw new UninstallError(
            _('It would also remove “%s”, which the desktop needs.')
                .format(blocked.join(', ')));
    }

    return {pkg, extra: removed.filter(n => n !== pkg)};
}

const UninstallDialog = GObject.registerClass(
class UninstallDialog extends ModalDialog.ModalDialog {
    _init(title, description, onConfirm) {
        super._init({styleClass: 'uninstall-dialog'});

        this.contentLayout.add_child(
            new Dialog.MessageDialogContent({title, description}));

        this.setButtons([{
            label: _('Cancel'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        }, {
            label: _('Uninstall'),
            action: () => {
                onConfirm();
                this.close();
            },
        }]);
    }
});

function _describe(plan, info) {
    switch (info.kind) {
    case Kind.FLATPAK:
        return _('This removes the Flatpak app %s. Its saved data in ~/.var/app is kept.')
            .format(info.flatpakId);
    case Kind.LOCAL:
        return _('This moves the launcher %s to the Trash. The program it starts is not removed.')
            .format(GLib.path_get_basename(info.path));
    case Kind.PACMAN: {
        let text = _('This removes the package “%s”.').format(plan.pkg);
        if (plan.extra.length > 0) {
            text += ' ';
            text += _('These packages are no longer needed and go too: %s.')
                .format(plan.extra.join(', '));
        }
        return text;
    }
    }
    return '';
}

async function _remove(info, plan) {
    switch (info.kind) {
    case Kind.FLATPAK: {
        const result = await _run([
            'flatpak', 'uninstall', '--noninteractive', '-y',
            info.flatpakUser ? '--user' : '--system',
            info.flatpakId,
        ]);
        if (result.status !== 0)
            throw new UninstallError(_lastLines(result.stderr || result.stdout));
        return true;
    }
    case Kind.LOCAL: {
        const file = Gio.File.new_for_path(info.path);
        try {
            await file.trash_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED))
                throw e;
            file.delete(null);
        }
        return true;
    }
    case Kind.PACMAN: {
        if (GLib.file_test(PACMAN_LOCK, GLib.FileTest.EXISTS)) {
            throw new UninstallError(
                _('Another package operation is running. Try again when it finishes.'));
        }
        const pacman = GLib.find_program_in_path('pacman');
        const result = await _run(
            ['pkexec', pacman, '-Rns', '--noconfirm', plan.pkg]);
        // 126: the password dialog was dismissed; 127: not authorized.
        if (result.status === 126)
            return false;
        if (result.status === 127)
            throw new UninstallError(_('Not authorized.'));
        if (result.status !== 0)
            throw new UninstallError(_lastLines(result.stderr || result.stdout));
        return true;
    }
    }
    return false;
}

/**
 * Ask to uninstall an app, then remove it. The app grid drops the icon on
 * its own once the launcher file is gone.
 *
 * @param {Shell.App} app - the app
 */
export async function uninstall(app) {
    const info = classify(app);
    const id = app.get_id();
    if (!info || _inProgress.has(id))
        return;

    const name = app.get_name();
    /* Translators: %s is an application name */
    const failTitle = _('Couldn’t Uninstall “%s”').format(name);

    _inProgress.add(id);
    let plan = null;
    try {
        if (info.kind === Kind.PACMAN)
            plan = await _pacmanPlan(info.path);
    } catch (e) {
        _inProgress.delete(id);
        Main.notifyError(failTitle,
            e instanceof UninstallError ? e.message : String(e));
        return;
    }

    /* Translators: %s is an application name */
    const title = _('Uninstall “%s”?').format(name);
    let confirmed = false;
    const dialog = new UninstallDialog(title, _describe(plan, info),
        async () => {
            confirmed = true;
            try {
                if (await _remove(info, plan)) {
                    /* Translators: %s is an application name */
                    Main.notify(_('“%s” Uninstalled').format(name));
                }
            } catch (e) {
                Main.notifyError(failTitle,
                    e instanceof UninstallError ? e.message : String(e));
            } finally {
                _inProgress.delete(id);
            }
        });
    dialog.connect('closed', () => {
        if (!confirmed)
            _inProgress.delete(id);
    });
    if (!dialog.open()) {
        _inProgress.delete(id);
        dialog.destroy();
    }
}
