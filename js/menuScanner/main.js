// Finds out what menus an application has, in whatever way it exposes them.
//
//   gjs -m main.js PID            human readable report
//   gjs -m main.js --json PID     for the shell
//
// Runs as a process of its own, so that nothing an application contains can
// slow down or crash the shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import * as Accessibility from './accessibility.js';
import * as DBus from './dbus.js';
import * as Electron from './electron.js';

// Change when the same application would give a different result
const VERSION = 1;
const CACHE_MAX_AGE = 90 * 24 * 60 * 60;

const CACHE_DIR = GLib.build_filenamev(
    [GLib.get_user_cache_dir(), 'gnome-shell', 'global-menu']);

// Reading the code of an application takes a moment, and the outcome is the
// same until it gets updated
function _cachePath(app) {
    const real = app.get_path().replace(/^\/proc\/\d+\/root/, '');
    const info = app.query_info('time::modified,time::modified-usec,standard::size',
        Gio.FileQueryInfoFlags.NONE, null);
    const key = [VERSION, real, info.get_size(),
        info.get_attribute_uint64('time::modified'),
        info.get_attribute_uint32('time::modified-usec')].join(' ');
    const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, -1);
    return GLib.build_filenamev([CACHE_DIR, `${name}.json`]);
}

function _readCache(path) {
    try {
        return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
    } catch {
        return null;
    }
}

function _writeCache(path, value) {
    try {
        GLib.mkdir_with_parents(CACHE_DIR, 0o700);
        GLib.file_set_contents(path, JSON.stringify(value));

        // results of applications that are gone or got updated
        const now = Date.now() / 1000;
        const dir = Gio.File.new_for_path(CACHE_DIR);
        for (const info of dir.enumerate_children('standard::name,time::modified',
            Gio.FileQueryInfoFlags.NONE, null)) {
            if (info.get_name().endsWith('.json') &&
                now - info.get_attribute_uint64('time::modified') > CACHE_MAX_AGE)
                dir.get_child(info.get_name()).delete(null);
        }
    } catch (e) {
        printerr(`cannot cache the result: ${e.message}`);
    }
}

function _scanElectron(pid) {
    const app = Electron.findApp(pid);
    if (!app)
        return {result: null, detail: 'not an Electron application'};

    const path = _cachePath(app);
    let found = _readCache(path);
    const cached = found !== null;
    if (!cached) {
        found = Electron.scanApp(app);
        _writeCache(path, found);
    }

    const suffix = cached ? ' (cached)' : '';
    if (found.menus.length === 0)
        return {result: null, detail: `no menu in ${found.searched} files${suffix}`};
    return {
        result: {kind: 'shortcuts', menus: found.menus},
        detail: `${found.menus.length} menus, ${found.usable} usable items, in ${found.path}${suffix}`,
    };
}

function _printItems(items, depth) {
    for (const {separator, label, shortcut, accel, items: children} of items) {
        const key = shortcut ?? accel;
        print('  '.repeat(depth) + (separator ? '---' : `${label}${key ? `  [${key}]` : ''}`));
        if (children)
            _printItems(children, depth + 1);
    }
}

function main(args) {
    const json = args[0] === '--json';
    const pid = Number(args[json ? 1 : 0]);
    if (!Number.isInteger(pid) || pid <= 0) {
        printerr('usage: main.js [--json] PID');
        return 2;
    }

    // Live menus first, they know what is enabled and checked
    const probes = [
        ['D-Bus', DBus.scan],
        ['Accessibility', Accessibility.scan],
        ['Electron', _scanElectron],
    ];
    const report = [];
    let result = null;
    for (const [name, scan] of probes) {
        let outcome;
        try {
            outcome = scan(pid);
        } catch (e) {
            outcome = {result: null, detail: `failed: ${e.message}`};
        }
        report.push([name, outcome.detail]);
        result ??= outcome.result;
        // the report is complete, the shell does not need it to be
        if (result && json)
            break;
    }

    if (json) {
        print(JSON.stringify({result, report}));
    } else {
        for (const [name, detail] of report)
            print(`${name}: ${detail}`);
        if (result?.menus) {
            print('');
            _printItems(result.menus, 0);
        }
    }
    return 0;
}

System.exit(main(ARGV));
