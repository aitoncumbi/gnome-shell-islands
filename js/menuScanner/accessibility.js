// Reads the menu bar that an application shows in its window from what it
// tells assistive technologies.
//
// Only looks at applications that do so anyway. Most toolkits (Qt, Chromium,
// Electron, Firefox) wait for an assistive technology to run, and pretending
// that there is one would slow all of them down.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {call, namesOfProcess} from './dbus.js';

const ACCESSIBLE = 'org.a11y.atspi.Accessible';
const ACTION = 'org.a11y.atspi.Action';
const ROOT = '/org/a11y/atspi/accessible/root';

const Role = {
    CHECK_MENU_ITEM: 8,
    MENU: 33,
    MENU_BAR: 34,
    MENU_ITEM: 35,
    RADIO_MENU_ITEM: 45,
    SEPARATOR: 50,
};
// those never contain a menu bar, but can contain a lot
const LEAF_ROLES = new Set([31, 49, 55, 60, 61, 65, 66, 79, 82, 95]);

const State = {CHECKED: 4, SENSITIVE: 24};

const MAX_SEARCHED = 400;
const MAX_ITEMS = 1500;
const MAX_DEPTH = 12;
const TIME_LIMIT_US = 8 * 1000 * 1000;

class Reader {
    constructor(bus) {
        this._bus = bus;
        this._deadline = GLib.get_monotonic_time() + TIME_LIMIT_US;
        this.count = 0;
    }

    get late() {
        return GLib.get_monotonic_time() > this._deadline;
    }

    children([name, path]) {
        return call(this._bus, name, path, ACCESSIBLE, 'GetChildren')?.[0] ?? [];
    }

    role([name, path]) {
        return call(this._bus, name, path, ACCESSIBLE, 'GetRole')?.[0] ?? -1;
    }

    label([name, path]) {
        return call(this._bus, name, path, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [ACCESSIBLE, 'Name']))?.[0] ?? '';
    }

    findMenuBar(root) {
        const queue = [[root, 0]];
        for (let n = 0; queue.length > 0 && n < MAX_SEARCHED && !this.late; n++) {
            const [object, depth] = queue.shift();
            const role = this.role(object);
            if (role === Role.MENU_BAR)
                return object;
            if (depth < MAX_DEPTH && !LEAF_ROLES.has(role))
                queue.push(...this.children(object).map(o => [o, depth + 1]));
        }
        return null;
    }

    readItems(object, depth = 0) {
        const items = [];
        for (const child of this.children(object)) {
            if (++this.count > MAX_ITEMS || depth > 6 || this.late)
                break;
            const item = this._readItem(child, depth);
            // separators only between items
            if (item && (!item.separator || (items.length > 0 && !items.at(-1).separator)))
                items.push(item);
        }
        if (items.at(-1)?.separator)
            items.pop();
        return items;
    }

    _readItem(object, depth) {
        const role = this.role(object);
        if (role === Role.SEPARATOR)
            return {separator: true};
        const label = this.label(object);
        if (!label)
            return null;
        if (role === Role.MENU) {
            // Qt has the menu inside of its item, GTK its items
            return {label, items: this.readItems(object, depth + 1)};
        }
        if (![Role.MENU_ITEM, Role.CHECK_MENU_ITEM, Role.RADIO_MENU_ITEM].includes(role))
            return null;

        const submenu = this.children(object);
        if (submenu.length > 0) {
            const inner = submenu.length === 1 && this.role(submenu[0]) === Role.MENU
                ? submenu[0] : object;
            return {label, items: this.readItems(inner, depth + 1)};
        }

        const [name, path] = object;
        const actions = call(this._bus, name, path, ACTION, 'GetActions')?.[0] ?? [];
        const index = Math.max(actions.findIndex(([action]) => /click|press|activate/i.test(action)), 0);
        const [low] = call(this._bus, name, path, ACCESSIBLE, 'GetState')?.[0] ?? [0];
        // insensitive items have no actions until they become sensitive
        const item = {label, ref: [name, path], action: index};
        item.enabled = (low & (1 << State.SENSITIVE)) !== 0;
        if (role !== Role.MENU_ITEM) {
            item.toggle = role === Role.RADIO_MENU_ITEM ? 'radio' : 'check';
            item.checked = (low & (1 << State.CHECKED)) !== 0;
        }
        // 'mnemonic;full path;shortcut'
        const shortcut = actions[index]?.[2]?.split(';')[2];
        if (shortcut)
            item.accel = shortcut;
        return item;
    }
}

/**
 * @param {number} pid - a process
 * @returns {{result: object|null, detail: string}} what was found
 */
export function scan(pid) {
    const address = call(Gio.DBus.session, 'org.a11y.Bus', '/org/a11y/bus',
        'org.a11y.Bus', 'GetAddress')?.[0];
    if (!address)
        return {result: null, detail: 'no accessibility bus'};

    const bus = Gio.DBusConnection.new_for_address_sync(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
        Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, null, null);
    const reader = new Reader(bus);

    const names = new Set(namesOfProcess(bus, pid));
    const apps = reader.children(['org.a11y.atspi.Registry', ROOT])
        .filter(([name]) => names.has(name));
    if (apps.length === 0)
        return {result: null, detail: 'application is not accessible'};

    for (const app of apps) {
        const bar = reader.findMenuBar(app);
        if (!bar)
            continue;
        const menus = reader.readItems(bar)
            .filter(m => m.items?.some(i => !i.separator));
        if (menus.length > 0) {
            return {
                result: {kind: 'accessibility', address, menus},
                detail: `menu bar with ${reader.count} items`,
            };
        }
    }
    return {result: null, detail: 'application shows no menu bar'};
}
