// Menu bar of an application that exports a GMenuModel (GTK, LibreOffice).
//
// GIO does the D-Bus work: submenus are only subscribed to once something
// looks at them, and action states are read from its local cache.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from '../../misc/signals.js';
import * as PopupMenu from '../popupMenu.js';

import {stripMnemonic} from './labels.js';

const STRING_TYPE = new GLib.VariantType('s');
const BOOLEAN_TYPE = new GLib.VariantType('b');

const SEPARATOR = {separator: true};

function _stringAttribute(model, index, name) {
    const value = model.get_item_attribute_value(index, name, STRING_TYPE);
    return value ? value.get_string()[0] : null;
}

export class GtkMenuSource extends Signals.EventEmitter {
    /**
     * @param {Meta.Window} win - the window to look at
     * @returns {string|null} what identifies the menu of the window, null
     *   if it has none
     */
    static keyForWindow(win) {
        const bus = win.gtk_unique_bus_name;
        const path = win.gtk_menubar_object_path;
        const appMenuPath = win.gtk_app_menu_object_path;
        if (!bus || (!path && !appMenuPath))
            return null;
        return ['gtk', bus, path, appMenuPath, win.gtk_window_object_path].join(' ');
    }

    constructor(win) {
        super();

        const busName = win.gtk_unique_bus_name;
        const bus = Gio.DBus.session;
        const model = path => path ? Gio.DBusMenuModel.get(bus, busName, path) : null;

        this.key = GtkMenuSource.keyForWindow(win);
        this._menubar = model(win.gtk_menubar_object_path);
        this._appMenu = model(win.gtk_app_menu_object_path);

        this._busName = busName;
        this._groupPaths = {
            app: win.gtk_application_object_path,
            win: win.gtk_window_object_path,
            unity: win.gtk_menubar_object_path,
        };
        this._groups = new Map(); // prefix -> Gio.DBusActionGroup|null
        this._tracked = new Map(); // Gio.MenuModel -> signal id
        this._topLevel = new Set(); // models that make up the bar itself
        this._watchIds = []; // [group, signal id], while a menu is open

        this._entries = [];
        this._readBar();
    }

    // whether there is any point in waiting for titles
    get hasBar() {
        return this._menubar !== null;
    }

    get titles() {
        return this._entries.map(e => e.label);
    }

    // Fetches what opening the menu will need
    prefetch(index) {
        const model = this._entries[index]?.model;
        if (!model)
            return;
        this._track(model);
        for (const prefix of ['app', 'win', 'unity'])
            this._group(prefix)?.list_actions();
    }

    menuOpened(index) {
        this._watchGroups();
        this._setSubmenuAction(this._entries[index]?.submenuAction, true);
    }

    menuClosed(index) {
        this._unwatchGroups();
        this._setSubmenuAction(this._entries[index]?.submenuAction, false);
    }

    getItems(index) {
        const model = this._entries[index]?.model;
        return model ? this._buildSpecs(model) : [];
    }

    getAppItems() {
        return this._appMenu ? this._buildSpecs(this._appMenu) : [];
    }

    destroy() {
        this._unwatchGroups();
        for (const [model, id] of this._tracked)
            model.disconnect(id);
        this._tracked.clear();
        this._groups.clear();
        this._entries = [];
    }

    // Subscribes to the model, which makes GIO fetch its contents
    _track(model) {
        if (!this._tracked.has(model)) {
            this._tracked.set(model, model.connect('items-changed', () => {
                if (this._topLevel.has(model)) {
                    this._readBar();
                    this.emit('titles-changed');
                } else {
                    this.emit('items-changed');
                }
            }));
        }
        return model.get_n_items();
    }

    _readBar() {
        this._entries = [];
        if (this._menubar)
            this._readBarSection(this._menubar);
    }

    _readBarSection(model) {
        this._topLevel.add(model);
        const nItems = this._track(model);
        for (let i = 0; i < nItems; i++) {
            const section = model.get_item_link(i, Gio.MENU_LINK_SECTION);
            if (section) {
                this._readBarSection(section);
                continue;
            }
            const submenu = model.get_item_link(i, Gio.MENU_LINK_SUBMENU);
            const label = stripMnemonic(_stringAttribute(model, i, 'label'));
            if (submenu && label) {
                this._entries.push({
                    label,
                    model: submenu,
                    submenuAction: _stringAttribute(model, i, 'submenu-action'),
                });
            }
        }
    }

    _buildSpecs(model, specs = []) {
        const nItems = this._track(model);
        for (let i = 0; i < nItems; i++) {
            const section = model.get_item_link(i, Gio.MENU_LINK_SECTION);
            if (section) {
                specs.push(SEPARATOR);
                this._buildSpecs(section, specs);
                specs.push(SEPARATOR);
                continue;
            }

            const label = stripMnemonic(_stringAttribute(model, i, 'label'));
            if (!label)
                continue;
            const submenu = model.get_item_link(i, Gio.MENU_LINK_SUBMENU);
            if (submenu) {
                const action = _stringAttribute(model, i, 'submenu-action');
                specs.push({
                    label,
                    children: () => this._buildSpecs(submenu),
                    onOpen: () => this._setSubmenuAction(action, true),
                    onClose: () => this._setSubmenuAction(action, false),
                });
            } else {
                const spec = this._leafSpec(model, i, label);
                if (spec)
                    specs.push(spec);
            }
        }
        return specs;
    }

    _leafSpec(model, index, label) {
        const spec = {label, enabled: false};
        const accel = _stringAttribute(model, index, 'accel');
        if (accel)
            spec.accel = accel;

        const hiddenWhen = _stringAttribute(model, index, 'hidden-when');
        const [group, name] = this._lookupAction(_stringAttribute(model, index, 'action'));
        if (!group?.has_action(name)) {
            if (group)
                this._waitForAction(group, name);
            return hiddenWhen === 'action-missing' || hiddenWhen === 'action-disabled'
                ? null : spec;
        }

        spec.enabled = group.get_action_enabled(name);
        if (!spec.enabled && hiddenWhen === 'action-disabled')
            return null;

        const target = model.get_item_attribute_value(index, 'target', null);
        const state = group.get_action_state(name);
        if (state && target)
            spec.ornament = state.equal(target) ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT;
        else if (state?.is_of_type(BOOLEAN_TYPE))
            spec.ornament = state.get_boolean() ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE;

        spec.onActivate = () => group.activate_action(name, target);
        return spec;
    }

    _lookupAction(action) {
        const dot = action?.indexOf('.') ?? -1;
        if (dot === -1)
            return [null, null];
        return [this._group(action.slice(0, dot)), action.slice(dot + 1)];
    }

    _group(prefix) {
        if (!this._groups.has(prefix)) {
            const path = this._groupPaths[prefix];
            this._groups.set(prefix, path
                ? Gio.DBusActionGroup.get(Gio.DBus.session, this._busName, path)
                : null);
        }
        return this._groups.get(prefix);
    }

    _setSubmenuAction(action, shown) {
        const [group, name] = this._lookupAction(action);
        if (group?.has_action(name))
            group.change_action_state(name, GLib.Variant.new_boolean(shown));
    }

    // The actions of a group arrive all at once, as one signal per action.
    // Listening for a single missing one is enough to notice, without being
    // called for each of the thousands that some applications have.
    _waitForAction(group, name) {
        if (this._waiting || this._watchIds.length === 0)
            return;
        this._waiting = true;
        this._watchIds.push([group, group.connect(`action-added::${name}`, () => {
            this._waiting = false;
            this.emit('items-changed');
        })]);
    }

    _watchGroups() {
        this._unwatchGroups();
        for (const prefix of ['app', 'win', 'unity']) {
            const group = this._group(prefix);
            if (!group)
                continue;
            for (const signal of ['action-enabled-changed', 'action-state-changed'])
                this._watchIds.push([group, group.connect(signal, () => this.emit('items-changed'))]);
        }
    }

    _unwatchGroups() {
        for (const [group, id] of this._watchIds)
            group.disconnect(id);
        this._watchIds = [];
        this._waiting = false;
    }
}
