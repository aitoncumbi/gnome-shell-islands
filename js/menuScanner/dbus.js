// Looks for menus on the session bus that the application did not announce:
// any object of one of its connections that speaks a menu protocol.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const CALL_TIMEOUT_MS = 500;
const MAX_NODES = 300;
const MAX_DEPTH = 9;
const TIME_LIMIT_US = 5 * 1000 * 1000;

/**
 * @param {Gio.DBusConnection} bus - a connection
 * @param {string} name - of the destination
 * @param {string} path - of the object
 * @param {string} iface - interface
 * @param {string} method - method
 * @param {GLib.Variant=} params - parameters
 * @returns {any} the unpacked reply, null on failure
 */
export function call(bus, name, path, iface, method, params = null) {
    try {
        return bus.call_sync(name, path, iface, method, params, null,
            Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, null).recursiveUnpack();
    } catch {
        return null;
    }
}

/**
 * @param {Gio.DBusConnection} bus - a connection
 * @param {number} pid - a process
 * @returns {string[]} the unique names of its connections
 */
export function namesOfProcess(bus, pid) {
    const ask = (method, params) => call(bus, 'org.freedesktop.DBus',
        '/org/freedesktop/DBus', 'org.freedesktop.DBus', method, params);
    return (ask('ListNames')?.[0] ?? []).filter(name => name.startsWith(':') &&
        ask('GetConnectionUnixProcessID', new GLib.Variant('(s)', [name]))?.[0] === pid);
}

function* _objects(bus, name) {
    const deadline = GLib.get_monotonic_time() + TIME_LIMIT_US;
    const queue = [['/', 0]];
    for (let n = 0; queue.length > 0 && n < MAX_NODES; n++) {
        if (GLib.get_monotonic_time() > deadline)
            return;
        const [path, depth] = queue.shift();
        const xml = call(bus, name, path, 'org.freedesktop.DBus.Introspectable', 'Introspect')?.[0];
        if (!xml)
            continue;
        let info;
        try {
            info = Gio.DBusNodeInfo.new_for_xml(xml);
        } catch {
            continue;
        }
        yield [path, new Set(info.interfaces.map(i => i.name))];
        if (depth < MAX_DEPTH) {
            for (const {path: child} of info.nodes) {
                if (child)
                    queue.push([`${path === '/' ? '' : path}/${child}`, depth + 1]);
            }
        }
    }
}

function _isDBusMenuBar(bus, name, path) {
    const layout = call(bus, name, path, 'com.canonical.dbusmenu', 'GetLayout',
        new GLib.Variant('(iias)', [0, 1, ['label', 'children-display']]));
    const children = layout?.[1]?.[2] ?? [];
    return children.filter(([, props]) => props['children-display'] === 'submenu').length >= 2;
}

function _isGtkMenuBar(bus, name, path) {
    const menus = call(bus, name, path, 'org.gtk.Menus', 'Start',
        new GLib.Variant('(au)', [[0]]))?.[0] ?? [];
    const items = menus.filter(([group, menu]) => group === 0 && menu === 0)
        .flatMap(([,, list]) => list);
    call(bus, name, path, 'org.gtk.Menus', 'End', new GLib.Variant('(au)', [[0]]));
    return items.filter(i => ':submenu' in i).length >= 2;
}

/**
 * @param {number} pid - a process
 * @returns {{result: object|null, detail: string}} what was found
 */
export function scan(pid) {
    const bus = Gio.DBus.session;
    const names = namesOfProcess(bus, pid);
    let count = 0;

    for (const name of names) {
        const objects = [..._objects(bus, name)];
        count += objects.length;

        // the menus of tray icons are not those of windows
        const trayMenus = new Set();
        for (const [path, ifaces] of objects) {
            if (ifaces.has('org.kde.StatusNotifierItem')) {
                trayMenus.add(call(bus, name, path, 'org.freedesktop.DBus.Properties', 'Get',
                    new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', 'Menu']))?.[0]);
            }
        }

        for (const [path, ifaces] of objects) {
            if (ifaces.has('com.canonical.dbusmenu') && !trayMenus.has(path) &&
                _isDBusMenuBar(bus, name, path)) {
                return {
                    result: {kind: 'dbusmenu', service: name, path},
                    detail: `dbusmenu at ${name} ${path}`,
                };
            }
            if (ifaces.has('org.gtk.Menus') && _isGtkMenuBar(bus, name, path)) {
                const actions = objects.filter(([, i]) => i.has('org.gtk.Actions')).map(([p]) => p);
                return {
                    result: {
                        kind: 'gtk',
                        service: name,
                        path,
                        windowPath: actions.find(p => /\/window\//.test(p)) ?? null,
                        appPath: actions.find(p => !/\/(?:window|menus)\//.test(p)) ?? null,
                    },
                    detail: `GTK menu at ${name} ${path}`,
                };
            }
        }
    }
    return {
        result: null,
        detail: names.length === 0
            ? 'no connection to the session bus'
            : `nothing on ${names.length} connections with ${count} objects`,
    };
}
