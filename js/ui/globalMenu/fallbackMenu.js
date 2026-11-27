// The menus shown for applications that neither export a menu nor have a
// bundled one: window, workspace and session actions.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as SystemActions from '../../misc/systemActions.js';
import * as Dialog from '../dialog.js';
import * as Main from '../main.js';
import * as ModalDialog from '../modalDialog.js';
import {showScreenshotUI} from '../screenshot.js';

import {sendShortcutAfterMenu} from './keySynth.js';
import {windowSpecs} from './windowActions.js';

Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const TRASH_BATCH_SIZE = 100;
const MAX_UNTITLED_FOLDERS = 100;

let _trashDialog = null;

function _launchSettings() {
    const system = Shell.AppSystem.get_default();
    const app = system.lookup_app('org.gnome.Settings.desktop') ??
        system.lookup_app('gnome-control-center.desktop');
    app?.activate();
}

function _openHome() {
    Gio.AppInfo.launch_default_for_uri_async(
        GLib.filename_to_uri(GLib.get_home_dir(), null),
        global.create_app_launch_context(0, -1), null, (_o, res) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(res);
            } catch (e) {
                console.warn(`Global menu: cannot open the home folder: ${e.message}`);
            }
        });
}

async function _makeDesktopFolder() {
    const desktop = Gio.File.new_for_path(
        GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Desktop']));

    for (let n = 0; n <= MAX_UNTITLED_FOLDERS; n++) {
        // the first round makes sure that the desktop folder itself exists
        const file = n === 0 ? desktop : desktop.get_child(n === 1
            ? _('Untitled Folder') : _('Untitled Folder %d').format(n));
        try {
            // eslint-disable-next-line no-await-in-loop
            await file.make_directory_async(GLib.PRIORITY_DEFAULT, null);
            if (n > 0)
                return;
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                console.warn(`Global menu: cannot create a folder: ${e.message}`);
                return;
            }
        }
    }
}

// GIO has no call to empty the trash; deleting a top level trash item deletes
// its contents
async function _deleteTrashItems() {
    const trash = Gio.File.new_for_uri('trash:///');
    try {
        const entries = await trash.enumerate_children_async(
            Gio.FILE_ATTRIBUTE_STANDARD_NAME,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW, null);
        let infos;
        do {
            // eslint-disable-next-line no-await-in-loop
            infos = await entries.next_files_async(TRASH_BATCH_SIZE, GLib.PRIORITY_LOW, null);
            // eslint-disable-next-line no-await-in-loop
            const results = await Promise.allSettled(infos.map(info =>
                entries.get_child(info).delete_async(GLib.PRIORITY_LOW, null)));
            for (const {reason} of results) {
                if (reason)
                    console.warn(`Global menu: cannot delete a trash item: ${reason.message}`);
            }
        } while (infos.length > 0);
    } catch (e) {
        console.warn(`Global menu: cannot read the trash: ${e.message}`);
    }
}

function _confirmEmptyTrash() {
    if (_trashDialog)
        return;

    const dialog = _trashDialog = new ModalDialog.ModalDialog();
    dialog.connect('closed', () => (_trashDialog = null));
    dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
        title: _('Empty all items from Trash?'),
        description: _('All items in the Trash will be permanently deleted.'),
    }));
    dialog.setButtons([{
        label: _('Cancel'),
        action: () => dialog.close(),
        key: Clutter.KEY_Escape,
    }, {
        label: _('Empty Trash'),
        action: () => {
            dialog.close();
            _deleteTrashItems().catch(logError);
        },
    }]);
    dialog.open();
}

function _hibernate() {
    Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1',
        'org.freedesktop.login1.Manager', 'Hibernate',
        new GLib.Variant('(b)', [true]), null, Gio.DBusCallFlags.NONE, -1, null,
        (bus, res) => {
            try {
                bus.call_finish(res);
            } catch (e) {
                console.warn(`Global menu: cannot hibernate: ${e.message}`);
            }
        });
}

function _minimizeAll() {
    global.workspace_manager.get_active_workspace().list_windows()
        .filter(w => !w.minimized && !w.is_skip_taskbar())
        .forEach(w => w.minimize());
}

function _switchWorkspace(direction) {
    const active = global.workspace_manager.get_active_workspace();
    const neighbor = active.get_neighbor(direction);
    if (neighbor !== active)
        neighbor.activate(global.get_current_time());
}

const SEPARATOR = {separator: true};

const _keys = (label, accel) =>
    ({label, accel, onActivate: () => sendShortcutAfterMenu(accel)});

const _run = (label, onActivate, enabled = true) => ({label, onActivate, enabled});

function _fileSpecs(win) {
    return [
        _run(_('New Folder on Desktop'), () => _makeDesktopFolder().catch(logError)),
        _keys(_('New Tab'), '<Ctrl>T'),
        _keys(_('Open'), 'Return'),
        SEPARATOR,
        _keys(_('Properties'), '<Alt>Return'),
        SEPARATOR,
        _run(_('Show Desktop'), _minimizeAll),
        SEPARATOR,
        _run(_('Close Window'), () => win.delete(global.get_current_time()),
            win?.can_close() ?? false),
    ];
}

function _editSpecs() {
    return [
        _keys(_('Undo'), '<Ctrl>Z'),
        _keys(_('Redo'), '<Ctrl>Y'),
        SEPARATOR,
        _keys(_('Cut'), '<Ctrl>X'),
        _keys(_('Copy'), '<Ctrl>C'),
        _keys(_('Paste'), '<Ctrl>V'),
        _keys(_('Delete'), 'Delete'),
        SEPARATOR,
        _keys(_('Select All'), '<Ctrl>A'),
        SEPARATOR,
        _keys(_('Take Screenshot'), 'Print'),
        _keys(_('Screenshot of Window'), '<Alt>Print'),
        _run(_('Screenshot of Area'), () => showScreenshotUI()),
    ];
}

function _goSpecs() {
    const {MotionDirection} = Meta;
    const wm = global.workspace_manager;
    return [
        _keys(_('Back'), '<Alt>Left'),
        _keys(_('Forward'), '<Alt>Right'),
        SEPARATOR,
        _run(_('Next Workspace'), () => _switchWorkspace(wm.layout_rows === -1
            ? MotionDirection.DOWN : MotionDirection.RIGHT)),
        _run(_('Previous Workspace'), () => _switchWorkspace(wm.layout_rows === -1
            ? MotionDirection.UP : MotionDirection.LEFT)),
        _run(_('First Workspace'), () =>
            wm.get_workspace_by_index(0).activate(global.get_current_time())),
    ];
}

function _windowMenuSpecs(win) {
    return [
        ...windowSpecs(win),
        SEPARATOR,
        _keys(_('Snap Window Left'), '<Super>Left'),
        _keys(_('Snap Window Right'), '<Super>Right'),
        SEPARATOR,
        _keys(_('Switch Between Applications'), '<Super>Tab'),
        _keys(_('Cycle Through Windows'), '<Alt>Escape'),
        _keys(_('Window Menu'), '<Alt>space'),
    ];
}

function _systemSpecs() {
    const actions = SystemActions.getDefault();
    return [
        _run(_('Show Applications'), () => Main.overview.showApps()),
        _run(_('Show Notifications'), () => Main.panel.toggleNotifications()),
        SEPARATOR,
        _run(_('Open Files'), _openHome),
        _run(_('Settings'), _launchSettings),
        SEPARATOR,
        _run(_('Empty Trash…'), _confirmEmptyTrash),
        SEPARATOR,
        _run(_('Lock Screen'), () => actions.activateLockScreen(), actions.canLockScreen),
        _run(_('Suspend'), () => actions.activateSuspend(), actions.canSuspend),
        _run(_('Hibernate'), _hibernate),
        SEPARATOR,
        _run(_('Log Out'), () => actions.activateLogout(), actions.canLogout),
        _run(_('Power Off / Restart'), () => actions.activatePowerOff(), actions.canPowerOff),
    ];
}

export class FallbackMenu {
    constructor() {
        this._menus = [
            [_('File'), _fileSpecs],
            [_('Edit'), _editSpecs],
            [_('Go'), _goSpecs],
            [_('Window'), _windowMenuSpecs],
            [_('System'), _systemSpecs],
        ];
        this.titles = this._menus.map(([title]) => title);
    }

    getItems(index) {
        return this._menus[index][1](global.display.focus_window);
    }
}

/**
 * The menu behind the application name.
 *
 * @param {Shell.App|null} app - the focused app
 * @param {object[]} exported - what the app itself exports for this menu
 * @param {object[]} actions - other actions of the app
 * @param {object|null} scan - what starts a scan for menus
 * @returns {object[]} menu item specs
 */
export function appMenuSpecs(app, exported, actions, scan) {
    if (!app) {
        return [
            _run(_('Open Files'), _openHome),
            _run(_('Settings'), _launchSettings),
        ];
    }

    const name = app.get_name();
    const specs = [...exported, SEPARATOR];
    if (app.can_open_new_window())
        specs.push(_run(_('New Window'), () => app.open_new_window(-1)));
    specs.push(
        _run(_('Hide %s').format(name), () => app.get_windows()
            .filter(w => w.can_minimize() && !w.minimized)
            .forEach(w => w.minimize())),
        SEPARATOR,
        ...actions,
        SEPARATOR,
        ...scan ? [scan, SEPARATOR] : [],
        _run(_('Quit %s').format(name), () => app.request_quit()));
    return specs;
}
