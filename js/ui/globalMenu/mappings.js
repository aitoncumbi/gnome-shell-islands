// Menus built from the documented keyboard shortcuts of applications that
// export no menu of their own.
//
// The ~300 bundled mappings live in a GResource next to an index from window
// identifier to mapping (see build-aux/generate-global-menu.py). The file is
// mapped into memory and a mapping is only parsed when its application is
// first focused, so unused ones cost nothing. The user's own mappings in
// ~/.config/global-menu/shortcuts/apps take precedence.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseAccelerator} from './accelerator.js';
import {activateActionAfterMenu, sendShortcutAfterMenu} from './keySynth.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const RESOURCE_PATH = '/org/gnome/shell/global-menu';

// Parsed mappings kept around; the rest is read again on focus
const MAX_PARSED = 8;

function _readResource(name) {
    const bytes = Gio.resources_lookup_data(
        `${RESOURCE_PATH}/${name}`, Gio.ResourceLookupFlags.NONE);
    return JSON.parse(new TextDecoder().decode(bytes.toArray()));
}

/**
 * Keeps only what the menu code understands.
 *
 * @param {object[]} items - items from a file that is not bundled
 * @returns {object[]} the valid ones
 */
export function sanitizeItems(items) {
    const out = [];
    for (const item of items) {
        if (item?.separator === true) {
            out.push({separator: true});
            continue;
        }
        if (typeof item?.label !== 'string' || item.label === '')
            continue;
        if (Array.isArray(item.items)) {
            out.push({label: item.label, items: sanitizeItems(item.items)});
            continue;
        }

        const leaf = {label: item.label};
        if (item.shortcut !== undefined) {
            if (!parseAccelerator(item.shortcut))
                continue;
            leaf.shortcut = item.shortcut;
        }
        if (typeof item.action === 'string' && item.action !== '') {
            if (item.target !== undefined && !Number.isInteger(item.target))
                continue;
            leaf.action = item.action;
            leaf.target = item.target;
        }
        out.push(leaf);
    }
    return out;
}

/**
 * @param {object} raw - parsed mapping file
 * @param {string} stem - file name without extension
 * @returns {object|null} the cleaned up mapping
 */
export function validateMapping(raw, stem) {
    if (raw?.format !== 1 || raw.app !== stem || !Array.isArray(raw.menus) ||
        !Array.isArray(raw.identifiers))
        return null;

    const identifiers = raw.identifiers
        .filter(id => typeof id === 'string' && id.trim() !== '')
        .map(id => id.toLowerCase());
    if (identifiers.length === 0)
        return null;

    return {
        app: raw.app,
        identifiers,
        blank: raw.blank === true,
        menus: raw.menus
            .filter(m => typeof m?.label === 'string' && m.label !== '' && Array.isArray(m.items))
            .map(m => ({label: m.label, items: sanitizeItems(m.items)})),
    };
}

export class MappingStore {
    constructor() {
        this._index = null; // {apps: [app, ...], ids: {identifier: position in apps}}
        this._parsed = new Map(); // app -> mapping, oldest first
        this._user = [];
        this._userApps = new Set();
        this._cancellable = null;

        try {
            this._resource = Gio.Resource.load(
                `${global.datadir}/gnome-shell-global-menu.gresource`);
            this._resource._register();
            this._index = _readResource('index.json');
        } catch (e) {
            console.warn(`Global menu: cannot load the bundled menus: ${e.message}`);
        }
    }

    /**
     * Reads the user's own mappings again.
     */
    async reloadUser() {
        this._cancellable?.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();

        const dir = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'global-menu', 'shortcuts', 'apps']));
        const names = [];
        try {
            const enumerator = await dir.enumerate_children_async(
                'standard::name', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_LOW, cancellable);
            let infos;
            do {
                // eslint-disable-next-line no-await-in-loop
                infos = await enumerator.next_files_async(
                    100, GLib.PRIORITY_LOW, cancellable);
                names.push(...infos.map(info => info.get_name()));
            } while (infos.length > 0);
        } catch {
            // no user mappings
        }

        const user = [];
        for (const name of names.filter(n => n.endsWith('.json')).sort()) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const [contents] = await dir.get_child(name)
                    .load_contents_async(cancellable);
                const mapping = validateMapping(
                    JSON.parse(new TextDecoder().decode(contents)), name.slice(0, -5));
                if (!mapping)
                    throw new Error('not a valid mapping');
                user.push(mapping);
            } catch (e) {
                if (!cancellable.is_cancelled())
                    console.warn(`Global menu: skipping ${name}: ${e.message}`);
            }
        }

        if (cancellable.is_cancelled())
            return;
        this._user = user;
        this._userApps = new Set(user.map(m => m.app));
    }

    /**
     * @param {string[]} candidates - lower case identifiers of a window
     * @param {string[]} disabled - apps that should not get a mapping
     * @returns {object|null} the mapping of the window
     */
    resolve(candidates, disabled) {
        for (const mapping of this._user) {
            if (mapping.identifiers.some(id => candidates.includes(id)))
                return disabled.includes(mapping.app) ? null : mapping;
        }

        if (!this._index)
            return null;

        const {apps, ids} = this._index;
        let best = -1;
        for (const id of candidates) {
            const pos = Object.hasOwn(ids, id) ? ids[id] : -1;
            if (pos !== -1 && (best === -1 || pos < best) && !this._userApps.has(apps[pos]))
                best = pos;
        }
        if (best === -1 || disabled.includes(apps[best]))
            return null;
        return this._load(apps[best]);
    }

    _load(app) {
        let mapping = this._parsed.get(app);
        if (mapping) {
            // most recently used goes last
            this._parsed.delete(app);
        } else {
            try {
                mapping = _readResource(`apps/${app}.json`);
            } catch (e) {
                console.warn(`Global menu: cannot read the menu of ${app}: ${e.message}`);
                return null;
            }
            if (this._parsed.size >= MAX_PARSED)
                this._parsed.delete(this._parsed.keys().next().value);
        }
        this._parsed.set(app, mapping);
        return mapping;
    }
}

// Menus built from a mapping
export class MappingMenu {
    constructor(mapping) {
        this._menus = mapping.menus;
        this.titles = mapping.menus.map(m => m.label);
    }

    getItems(index) {
        const menu = this._menus[index];
        return menu ? this._toSpecs(menu.items) : [];
    }

    _toSpecs(items) {
        return items.map(item => {
            const {label, shortcut, action, target} = item;
            if (item.separator)
                return item;
            if (item.items)
                return {label, children: () => this._toSpecs(item.items)};
            if (action) {
                return {
                    label,
                    accel: shortcut,
                    onActivate: () => activateActionAfterMenu(action, target, shortcut),
                };
            }
            if (shortcut) {
                return {
                    label,
                    accel: shortcut,
                    onActivate: () => sendShortcutAfterMenu(shortcut),
                };
            }
            return {label, enabled: false};
        });
    }
}
