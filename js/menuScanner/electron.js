// Reads the application menu out of the code of Electron applications.
//
// On Wayland those only draw their menu in the window, if at all. But the
// template it is built from is part of the application: look for calls of
// Menu.buildFromTemplate() and work out their argument.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Evaluator, UnknownCall, asArray, asObject} from './evaluator.js';
import {Source, parseBody, parseExpression, walk} from './source.js';

const MAX_FILE_SIZE = 24 * 1024 * 1024;
const MAX_TOTAL_SIZE = 256 * 1024 * 1024;
const MAX_HEADER_SIZE = 32 * 1024 * 1024;
const NEEDLE = new TextEncoder().encode('buildFromTemplate');

const MAX_ITEMS = 1500;
const MAX_LABEL = 80;

// What Electron does for items with a role (on Linux)
const ROLES = {
    undo: ['Undo', '<Ctrl>Z'],
    redo: ['Redo', '<Ctrl><Shift>Z'],
    cut: ['Cut', '<Ctrl>X'],
    copy: ['Copy', '<Ctrl>C'],
    paste: ['Paste', '<Ctrl>V'],
    pasteandmatchstyle: ['Paste and Match Style', '<Ctrl><Shift>V'],
    delete: ['Delete', 'Delete'],
    selectall: ['Select All', '<Ctrl>A'],
    reload: ['Reload', '<Ctrl>R'],
    forcereload: ['Force Reload', '<Ctrl><Shift>R'],
    toggledevtools: ['Toggle Developer Tools', '<Ctrl><Shift>I'],
    resetzoom: ['Actual Size', '<Ctrl>0'],
    zoomin: ['Zoom In', '<Ctrl>plus'],
    zoomout: ['Zoom Out', '<Ctrl>minus'],
    togglefullscreen: ['Toggle Full Screen', 'F11'],
    minimize: ['Minimize', '<Ctrl>M'],
    close: ['Close Window', '<Ctrl>W'],
    quit: ['Quit', '<Ctrl>Q'],
    about: ['About', null],
};

const _separator = {type: 'separator'};
const ROLE_MENUS = {
    filemenu: ['File', ['quit']],
    editmenu: ['Edit', ['undo', 'redo', null, 'cut', 'copy', 'paste', 'delete', null, 'selectall']],
    viewmenu: ['View', ['reload', 'forcereload', 'toggledevtools', null,
        'resetzoom', 'zoomin', 'zoomout', null, 'togglefullscreen']],
    windowmenu: ['Window', ['minimize', 'close']],
};

const MODIFIERS = {
    commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl',
    alt: 'Alt', option: 'Alt', shift: 'Shift',
    super: 'Super', meta: 'Super', command: 'Super', cmd: 'Super',
};

// key names that differ from those of js/ui/globalMenu/accelerator.js
const KEYS = {
    plus: 'plus', space: 'space', esc: 'Escape', escape: 'Escape', enter: 'Return',
    return: 'Return', pageup: 'Page_Up', pagedown: 'Page_Down',
    numadd: 'KP_Add', numsub: 'KP_Subtract', nummult: 'KP_Multiply',
    numdiv: 'KP_Divide', numdec: 'KP_Decimal', printscreen: 'Print',
    tab: 'Tab', backspace: 'BackSpace', delete: 'Delete', insert: 'Insert',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
    arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
};

/**
 * @param {any} accelerator - such as 'CmdOrCtrl+Shift+N'
 * @returns {string|null} such as '<Ctrl><Shift>N'
 */
export function convertAccelerator(accelerator) {
    if (typeof accelerator !== 'string' || accelerator === '')
        return null;

    // the key itself can be a plus
    const parts = accelerator.replace(/\+\+$/, '+Plus').split('+').map(p => p.trim());
    const key = parts.pop();
    const modifiers = [];
    for (const part of parts) {
        const modifier = MODIFIERS[part.toLowerCase()];
        if (!modifier)
            return null;
        if (!modifiers.includes(modifier))
            modifiers.push(modifier);
    }

    const lower = key.toLowerCase();
    let name = KEYS[lower];
    if (!name && /^f(?:[1-9]|1[0-2])$/.test(lower))
        name = key.toUpperCase();
    if (!name && /^num[0-9]$/.test(lower))
        name = `KP_${lower[3]}`;
    if (!name && /^[!-~]$/.test(key))
        name = key === '<' ? 'less' : key === '>' ? 'greater' : key;
    return name ? modifiers.map(m => `<${m}>`).join('') + name : null;
}

// 'menu.file.openRecent' -> 'Open Recent'
function _humanize(key) {
    if (/\s/.test(key) || !/[.:_/]/.test(key))
        return key;
    const word = key.split(/[.:/]/).filter(s => s).at(-1) ?? '';
    return word.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b[a-z]/g, c => c.toUpperCase());
}

function _label(value) {
    let text = null;
    if (typeof value === 'string')
        text = value;
    else if (value instanceof UnknownCall) // most likely a translation
        text = _humanize(value.args.filter(a => typeof a === 'string').at(-1) ?? '');
    if (!text)
        return null;

    text = text.replace(/&(.)/g, '$1').replace(/\s+/g, ' ').trim();
    return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

class Converter {
    constructor() {
        this.count = 0;
        this.usable = 0;
    }

    menus(template) {
        const menus = [];
        for (const value of asArray(template) ?? []) {
            const menu = this._item(value, 0);
            if (menu?.items?.some(i => !i.separator) &&
                !menus.some(m => m.label === menu.label))
                menus.push(menu);
        }
        return menus;
    }

    _item(value, depth) {
        if (++this.count > MAX_ITEMS || depth > 6)
            return null;
        const item = typeof value === 'string' ? {role: value} : asObject(value);
        if (!item || item.visible === false)
            return null;
        if (item.type === 'separator')
            return {separator: true};

        const role = typeof item.role === 'string' ? item.role.toLowerCase() : null;
        let label = _label(item.label);

        const submenu = asArray(item.submenu) ?? this._roleMenu(role);
        if (submenu) {
            label ??= ROLE_MENUS[role]?.[0] ?? (role === 'help' ? 'Help' : null);
            if (!label)
                return null;
            return {label, items: this._items(submenu, depth + 1)};
        }

        const [roleLabel, roleShortcut] = ROLES[role] ?? [];
        label ??= roleLabel ?? null;
        if (!label)
            return null;
        // Without a shortcut there is no way to trigger the item from here
        const shortcut = convertAccelerator(item.accelerator) ?? roleShortcut;
        if (!shortcut)
            return {label};
        this.usable++;
        return {label, shortcut};
    }

    _roleMenu(role) {
        return ROLE_MENUS[role]?.[1].map(r => r === null ? _separator : r) ?? null;
    }

    _items(values, depth) {
        const items = [];
        const seen = new Set();
        for (const value of values) {
            const item = this._item(value, depth);
            if (!item)
                continue;
            if (item.separator) {
                if (items.length > 0 && !items.at(-1).separator)
                    items.push(item);
                continue;
            }
            // both branches of what could not be told apart
            const key = `${item.label}\0${!!item.items}`;
            if (seen.has(key) || item.items?.length === 0)
                continue;
            seen.add(key);
            items.push(item);
        }
        if (items.at(-1)?.separator)
            items.pop();
        return items;
    }
}

function _argumentAt(text, open) {
    // the first argument of the call whose bracket opens here
    let end = -1;
    let depth = 0;
    walk(text, open, {
        open: () => {
            depth++;
        },
        close: p => {
            if (--depth > 0)
                return false;
            end = p;
            return true;
        },
        other: (p, char) => {
            if (depth !== 1 || char !== ',')
                return false;
            end = p;
            return true;
        },
    });
    return end === -1 ? null : text.slice(open + 1, end);
}

/**
 * @param {string} text - code of an application
 * @param {string} appName - what it is called
 * @returns {{menus: object[], usable: number}|null} its menu, if it has one
 */
export function readMenu(text, appName) {
    const calls = [...text.matchAll(/\bbuildFromTemplate\s*\(/g)];
    if (calls.length === 0)
        return null;

    const source = new Source(text);
    let best = null;
    for (const call of calls) {
        const open = call.index + call[0].length - 1;
        const evaluator = new Evaluator(source, appName);

        // The template is often put together by the statements before
        const body = source.functionBodyAt(call.index);
        const statements = body !== null && body.length < 200000 ? parseBody(body) : null;
        if (statements)
            evaluator.run(statements, call.index);
        if (evaluator.templates.length === 0) {
            const argument = parseExpression(_argumentAt(text, open) ?? '');
            if (argument)
                evaluator.templates.push(evaluator.evaluate(argument, call.index));
        }

        for (const template of evaluator.templates) {
            const converter = new Converter();
            const menus = converter.menus(template);
            // the others are context and tray menus
            if (menus.length >= 2 && converter.usable > (best?.usable ?? 0))
                best = {menus, usable: converter.usable};
        }
    }
    return best;
}

// ---- application files ----

class Asar {
    constructor(file) {
        this.file = file;
        this._stream = file.read(null);
        // Two pickled values: the size of the header, and the header
        const prefix = this._read(0, 16);
        const view = new DataView(prefix.buffer, prefix.byteOffset, 16);
        const headerSize = view.getUint32(4, true);
        const jsonSize = view.getUint32(12, true);
        if (jsonSize > MAX_HEADER_SIZE || jsonSize > headerSize)
            throw new Error('not an asar archive');
        this._base = 8 + headerSize;
        this._header = JSON.parse(new TextDecoder().decode(this._read(16, jsonSize)));
    }

    *files(node = this._header, path = '') {
        for (const [name, entry] of Object.entries(node.files ?? {})) {
            const child = `${path}/${name}`;
            if (entry.files)
                yield* this.files(entry, child);
            else if (entry.offset !== undefined && !entry.unpacked)
                yield {path: child, size: entry.size, offset: Number(entry.offset)};
        }
    }

    load({offset, size}) {
        return this._read(this._base + offset, size);
    }

    close() {
        this._stream.close(null);
    }

    _read(offset, size) {
        this._stream.seek(offset, GLib.SeekType.SET, null);
        const data = new Uint8Array(size);
        let length = 0;
        while (length < size) {
            const chunk = this._stream.read_bytes(size - length, null).toArray();
            if (chunk.length === 0)
                throw new Error('unexpected end of file');
            data.set(chunk, length);
            length += chunk.length;
        }
        return data;
    }
}

class Directory {
    constructor(file) {
        this.file = file;
    }

    *files(dir = this.file, path = '') {
        const infos = dir.enumerate_children('standard::name,standard::type,standard::size',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (const info of infos) {
            const name = info.get_name();
            if (name === 'node_modules')
                continue;
            const child = dir.get_child(name);
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                yield* this.files(child, `${path}/${name}`);
            else if (info.get_file_type() === Gio.FileType.REGULAR)
                yield {path: `${path}/${name}`, size: info.get_size(), file: child};
        }
    }

    load({file}) {
        return file.load_contents(null)[1];
    }

    close() {
    }
}

/**
 * @param {number} pid - an Electron process
 * @returns {Gio.File|null} its code, either an archive or a directory
 */
export function findApp(pid) {
    const root = `/proc/${pid}/root`;
    const candidates = [];
    try {
        const exe = GLib.file_read_link(`/proc/${pid}/exe`);
        const resources = GLib.build_filenamev([GLib.path_get_dirname(exe), 'resources']);
        candidates.push(`${root}${resources}/app.asar`, `${root}${resources}/app`);
    } catch {
        // not ours to look at
    }
    // a shared Electron gets the application as an argument
    try {
        const [, cmdline] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        const args = new TextDecoder().decode(cmdline).split('\0').slice(1);
        const app = args.find(a => a.startsWith('/') && a.endsWith('.asar'));
        if (app)
            candidates.unshift(root + app);
    } catch {
        // gone
    }

    for (const path of candidates) {
        const file = Gio.File.new_for_path(path);
        if (file.query_exists(null) &&
            (path.endsWith('.asar') || file.get_child('package.json').query_exists(null)))
            return file;
    }
    return null;
}

// Looks for the bytes before anything gets decoded
function _contains(data, needle) {
    for (let i = data.indexOf(needle[0]); i !== -1; i = data.indexOf(needle[0], i + 1)) {
        let k = 1;
        while (k < needle.length && data[i + k] === needle[k])
            k++;
        if (k === needle.length)
            return true;
    }
    return false;
}

/**
 * @param {Gio.File} app - archive or directory
 * @returns {{menus: object[], usable: number, path: string, searched: number}}
 */
export function scanApp(app) {
    const isDirectory = app.query_file_type(Gio.FileQueryInfoFlags.NONE, null) ===
        Gio.FileType.DIRECTORY;
    const archive = isDirectory ? new Directory(app) : new Asar(app);
    try {
        const files = [...archive.files()];
        let appName = 'App';
        let mainDir = '/';
        const manifest = files.find(f => f.path === '/package.json');
        if (manifest) {
            const json = JSON.parse(new TextDecoder().decode(archive.load(manifest)));
            appName = json.productName ?? json.name ?? appName;
            if (typeof json.main === 'string')
                mainDir = `${GLib.path_get_dirname(`/${json.main.replace(/^\.?\/+/, '')}`)}/`;
        }

        const code = files
            .filter(f => /\.[cm]?js$/.test(f.path) && !f.path.includes('/node_modules/') &&
                f.size <= MAX_FILE_SIZE)
            // menus are made by the main process, so look around its code
            // first and at what is made for the windows last
            .map(f => {
                const forWindows = /renderer|preload|\/assets\/|\.min\.js$/.test(f.path);
                return {...f, rank: forWindows ? 2 : f.path.startsWith(mainDir) ? 0 : 1};
            })
            .sort((a, b) => a.rank - b.rank);

        let best = null;
        let searched = 0;
        let total = 0;
        for (const file of code) {
            if (best && file.rank > best.rank)
                break;
            total += file.size;
            if (total > MAX_TOTAL_SIZE)
                break;
            searched++;
            const data = archive.load(file);
            if (!_contains(data, NEEDLE))
                continue;
            const menu = readMenu(new TextDecoder().decode(data), appName);
            if (menu && menu.usable > (best?.usable ?? 0))
                best = {...menu, path: file.path, rank: file.rank};
        }
        return best ? {...best, searched} : {menus: [], usable: 0, searched};
    } finally {
        archive.close();
    }
}
