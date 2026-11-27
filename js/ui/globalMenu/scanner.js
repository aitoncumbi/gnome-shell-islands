// Finds menus that applications expose but do not announce, by running
// js/menuScanner as a process of its own.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {AccessibilityMenu} from './accessibilityMenu.js';
import {DBusMenuSource} from './dbusMenuSource.js';
import {GtkMenuSource} from './gtkMenuSource.js';
import {MappingMenu, sanitizeItems} from './mappings.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const TIMEOUT_SECONDS = 30;
const MAX_ENTRIES = 32;
const MAX_OUTPUT = 4 * 1024 * 1024;

function _toMenu(result) {
    const menus = result.menus
        .filter(m => typeof m?.label === 'string' && Array.isArray(m.items));
    if (menus.length === 0)
        return null;
    if (result.kind === 'accessibility')
        return new AccessibilityMenu(result.address, menus);
    return new MappingMenu({
        menus: menus.map(m => ({label: m.label, items: sanitizeItems(m.items)})),
    });
}

// What is known about the menus of a process
class Entry {
    constructor(output) {
        const {result, report} = JSON.parse(output);
        this.report = report;
        this.forced = false;
        // a menu to show as it is ...
        this.menu = null;
        // ... or where to find one: {key, create()}
        this.native = null;

        switch (result?.kind) {
        case 'dbusmenu':
            this.native = {
                key: DBusMenuSource.keyFor(result),
                create: () => new DBusMenuSource(result),
            };
            break;
        case 'gtk': {
            // as if the window had announced it
            const win = {
                gtk_unique_bus_name: result.service,
                gtk_menubar_object_path: result.path,
                gtk_application_object_path: result.appPath,
                gtk_window_object_path: result.windowPath,
                gtk_app_menu_object_path: null,
            };
            this.native = {
                key: GtkMenuSource.keyForWindow(win),
                create: () => new GtkMenuSource(win),
            };
            break;
        }
        case 'accessibility':
        case 'shortcuts':
            this.menu = _toMenu(result);
            break;
        }
    }

    get found() {
        return this.menu !== null || this.native !== null;
    }
}

export class Scanner {
    constructor() {
        this._entries = new Map(); // key -> Entry, or null while it is scanned
        this._queue = Promise.resolve();
    }

    _key(win, app) {
        return `${win.get_pid()} ${app.get_id()}`;
    }

    /**
     * @param {Meta.Window} win - a window
     * @param {Shell.App} app - its application
     * @returns {Entry|null|undefined} what is known, undefined if never scanned
     */
    get(win, app) {
        return this._entries.get(this._key(win, app));
    }

    /**
     * @param {Meta.Window} win - a window
     * @param {Shell.App} app - its application
     * @returns {Promise<Entry|null>} what was found out
     */
    async scan(win, app) {
        const key = this._key(win, app);
        const pid = win.get_pid();
        if (pid <= 0)
            return null;

        this._entries.delete(key);
        this._entries.set(key, null);
        if (this._entries.size > MAX_ENTRIES)
            this._entries.delete(this._entries.keys().next().value);

        // one at a time
        const run = this._queue.then(() => this._run(pid));
        this._queue = run.catch(() => {});
        const entry = await run.catch(e => {
            console.warn(`Global menu: cannot scan the menus of ${app.get_id()}: ${e.message}`);
            return null;
        });
        if (entry)
            this._entries.set(key, entry);
        return entry;
    }

    async _run(pid) {
        const proc = Gio.Subprocess.new([
            'timeout', `${TIMEOUT_SECONDS}`, 'nice', '-n', '19',
            'gjs', '-m', `${global.datadir}/menu-scanner/main.js`, '--json', `${pid}`,
        ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [stdout] = await proc.communicate_utf8_async(null, null);
        if (!proc.get_successful() || !stdout || stdout.length > MAX_OUTPUT)
            throw new Error('the scanner failed');
        return new Entry(stdout);
    }
}
