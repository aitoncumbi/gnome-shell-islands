// Global menu: the menu bar of the focused application, at the start of the
// top bar. Based on the Orbit Global Menu extension (GPL-3.0-or-later).
//
// A menu comes from the first of these that has one:
//   1. the application itself (gtkMenuSource.js, dbusMenuSource.js)
//   2. a bundled description of its keyboard shortcuts (mappings.js)
//   3. what a scan of the application turns up (scanner.js)
//   4. generic window and session actions (fallbackMenu.js)
//
// What keeps it cheap:
//   - focus changes are coalesced, and one that ends up at the same menu
//     touches no actor
//   - the buttons are never destroyed, only relabelled, shown and hidden
//   - menu items exist while their menu is open and not any longer

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {ensureActorVisibleInScrollView} from '../../misc/animationUtils.js';
import * as Main from '../main.js';
import * as PanelMenu from '../panelMenu.js';
import * as PopupMenu from '../popupMenu.js';

import {acceleratorLabel} from './accelerator.js';
import {GtkActions, desktopActionSpecs} from './appActions.js';
import {DBusMenuSource, Registrar} from './dbusMenuSource.js';
import {FallbackMenu, appMenuSpecs} from './fallbackMenu.js';
import {GtkMenuSource} from './gtkMenuSource.js';
import {MappingMenu, MappingStore} from './mappings.js';
import {Scanner} from './scanner.js';
import {getSettings} from './settings.js';

// The focus is briefly nowhere while windows close and switch
const FOCUS_LOST_DELAY_MS = 200;

// How long an application may take to deliver its menu before something else
// is shown in the meantime
const EXPORT_GRACE_MS = 250;

// Only scan applications that get used, not those passed by on the way
const SCAN_DELAY_MS = 1500;

const MAX_KNOWN_EMPTY = 64;

// mutter refuses transient-for loops, but bound the walk anyway
const MAX_TRANSIENT_STEPS = 8;

// The theme has no opacity property; this is the 55% of a dim label
const ACCEL_OPACITY = 140;

// Separators only between items, never two in a row
function _tidy(specs) {
    const out = [];
    for (const spec of specs) {
        if (!spec.separator || (out.length > 0 && !out.at(-1).separator))
            out.push(spec);
    }
    if (out.at(-1)?.separator)
        out.pop();
    return out;
}

function _sameShape(a, b) {
    return !a.separator === !b.separator && a.label === b.label &&
        a.accel === b.accel && !a.children === !b.children;
}

// Keeps the items of one menu (or submenu) in line with a list of specs:
// {separator} or {label, accel, enabled, ornament, onActivate, beforeClose}
// or {label, enabled, children, onOpen, onClose}
class ItemList {
    constructor(menu, button) {
        this._menu = menu;
        this._button = button;
        this._specs = [];
        this._items = [];
        this.openSubmenu = null;
    }

    clear() {
        this.openSubmenu = null;
        this._specs = [];
        this._items = [];
        this._menu.removeAll();
    }

    sync(newSpecs) {
        const specs = _tidy(newSpecs);
        if (specs.length === this._specs.length &&
            specs.every((spec, i) => _sameShape(spec, this._specs[i]))) {
            this._specs = specs;
            this._items.forEach((item, i) => this._update(item, specs[i]));
            return;
        }

        this.clear();
        this._specs = specs;
        this._items = specs.map(spec => this._create(spec));
    }

    _create(spec) {
        let item;
        if (spec.separator) {
            item = new PopupMenu.PopupSeparatorMenuItem();
            this._menu.addMenuItem(item);
            return item;
        }

        if (spec.children) {
            item = new SubMenuItem(spec, this, this._button);
        } else {
            item = new PopupMenu.PopupMenuItem(spec.label);
            item.label.x_expand = true;
            const accel = this._button.showAccels ? acceleratorLabel(spec.accel) : null;
            if (accel) {
                item.accelLabel = new St.Label({
                    text: accel,
                    style_class: 'global-menu-accel',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                item.add_child(item.accelLabel);
            }
            item.connect('activate', () => {
                const {onActivate, beforeClose} = item.spec;
                if (beforeClose)
                    onActivate?.();
                // releases the input grab, which many actions need
                this._button.menu.close();
                if (!beforeClose)
                    onActivate?.();
            });
        }
        item.connect('key-focus-in', () => this._button.scrollTo(item));
        this._menu.addMenuItem(item);
        this._update(item, spec);
        return item;
    }

    _update(item, spec) {
        item.spec = spec;
        if (spec.separator)
            return;

        const enabled = spec.enabled !== false;
        item.setSensitive(enabled);
        if (item.accelLabel)
            item.accelLabel.opacity = enabled ? ACCEL_OPACITY : 255;
        if (spec.ornament !== undefined)
            item.setOrnament(spec.ornament);
        if (spec.children && item.menu.isOpen)
            item.list.sync(spec.children());
    }
}

// A submenu that creates its items when opened, and that can be nested
class SubMenuItem extends PopupMenu.PopupSubMenuMenuItem {
    static {
        GObject.registerClass(this);
    }

    _init(spec, parentList, button) {
        super._init(spec.label);

        this._parentList = parentList;
        this._button = button;
        this.list = new ItemList(this.menu, button);
        this.spec = spec;

        // empty until opened, but that should not stop it from opening
        this.menu.isEmpty = () => false;
        this.menu.actor.connect('notify::height', () => {
            if (this.menu.isOpen)
                button.scrollTo(this.menu.actor);
        });
    }

    // Unlike the base class this does not track the open submenu on the top
    // level menu, as opening a nested submenu would close its parent
    _subMenuOpenStateChanged(_menu, open) {
        const parentList = this._parentList;
        if (open) {
            parentList.openSubmenu?.menu.close();
            parentList.openSubmenu = this;
            this.add_style_pseudo_class('open');
            this.add_style_pseudo_class('checked');
            this.spec.onOpen?.();
            this.list.sync(this.spec.children());
        } else {
            if (parentList.openSubmenu === this)
                parentList.openSubmenu = null;
            this.list.openSubmenu?.menu.close({animate: false});
            this.remove_style_pseudo_class('open');
            this.remove_style_pseudo_class('checked');
            this.spec.onClose?.();
        }
    }
}

const MenuTitle = GObject.registerClass(
class GlobalMenuTitle extends PanelMenu.Button {
    _init(bar, index) {
        super._init(0.0, '');

        this._bar = bar;
        this._index = index;
        this._clearId = 0;

        this.add_style_class_name('global-menu-title');
        if (index === 0)
            this.add_style_class_name('app-name');
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);
        this.label_actor = this._label;

        this.menu.actor.add_style_class_name('global-menu-popup');
        const section = new PopupMenu.PopupMenuSection();
        this._scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            clip_to_allocation: true,
            child: section.box,
        });
        this._scrollView._delegate = section;
        section.actor = this._scrollView;
        this.menu.addMenuItem(section);
        this._list = new ItemList(section, this);

        // empty until opened, but that should not stop it from opening
        this.menu.isEmpty = () => false;

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._bar.menuOpened(this._index);
                this._cancelClear();
                this._list.sync(this._bar.getItems(this._index));
                this.menu.setSourceAlignment(
                    this.text_direction === Clutter.TextDirection.RTL ? 1.0 : 0.0);
            } else {
                this._bar.menuClosed(this._index);
            }
        });
        // deferred because this can run from the handler of an item
        this.menu.connect('menu-closed', () => {
            this._clearId ||= GLib.idle_add_once(GLib.PRIORITY_LOW, () => {
                this._clearId = 0;
                if (!this.menu.isOpen)
                    this._list.clear();
            });
        });
        this.connect('notify::hover', () => {
            if (this.hover)
                this._bar.prefetch(this._index);
        });
        this.connect('destroy', () => this._cancelClear());
    }

    get text() {
        return this._label.text;
    }

    set text(text) {
        if (this._label.text === text)
            return;
        this._label.text = text;
        this.accessible_name = text;
    }

    get showAccels() {
        return this._bar.showAccels;
    }

    syncItems() {
        this._list.sync(this._bar.getItems(this._index));
    }

    scrollTo(actor) {
        if (actor.get_stage())
            ensureActorVisibleInScrollView(this._scrollView, actor);
    }

    _cancelClear() {
        if (this._clearId)
            GLib.source_remove(this._clearId);
        this._clearId = 0;
    }
});

const EMPTY_MENU = {titles: [], getItems: () => []};

export const GlobalMenuBar = GObject.registerClass({
    // expected by the panel
    Signals: {'menu-set': {}},
}, class GlobalMenuBar extends St.BoxLayout {
    _init(panel) {
        super._init({
            style_class: 'global-menu-bar',
            x_expand: true,
            y_expand: true,
        });

        this.container = new St.Bin({child: this});

        this._panel = panel;
        this._titles = []; // MenuTitle, the first is the application's name
        this._openTitle = null;
        this._openIndex = -1;
        this._updateWhenClosed = false;

        this._app = null;
        this._blank = false;
        this._window = null;
        this._mapping = null;
        this._native = null; // the menu exported by the window, if any
        this._nativePending = null; // same, not shown yet
        this._knownEmpty = new Set(); // keys of exported menus without titles
        this._menu = EMPTY_MENU; // what is shown
        this._updateId = 0;
        this._pendingId = 0;
        this._syncItemsId = 0;
        this._scanId = 0;
        this._appActions = null;

        this._settings = getSettings();
        this._active = false;
        this._settings?.connectObject(
            'changed::enabled', () => this._syncEnabled(),
            'changed::enable-fallback-menu', () => this._update(),
            'changed::shortcut-menus-enabled', () => this._update(),
            'changed::shortcut-disabled-apps', () => this._update(),
            'changed::scan-menus', () => this._update(),
            'changed::hide-app-name', () => this._syncTitles(),
            'changed::shortcuts-revision', () => this._reloadMappings(),
            this);

        this.connect('destroy', () => this._deactivate());
        this._syncEnabled();
    }

    get showAccels() {
        return this._settings.get_string('shortcut-labels') !== 'never';
    }

    closeMenus(params) {
        this._openTitle?.menu.close(params);
    }

    // ---- called by the titles ----

    getItems(index) {
        if (index > 0)
            return this._menu.getItems(index - 1);
        return this._appItems();
    }

    prefetch(index) {
        if (index === 0)
            this._appActions?.prefetch();
        this._menu.prefetch?.(index - 1);
    }

    menuOpened(index) {
        // When moving along the bar the next menu opens before this one closes
        if (this._openTitle)
            this._menu.menuClosed?.(this._openIndex - 1);

        this._openTitle = this._titles[index];
        this._openIndex = index;
        this._menu.prefetch?.(index - 1);
        this._menu.menuOpened?.(index - 1);
    }

    menuClosed(index) {
        if (this._openTitle !== this._titles[index])
            return;

        this._openTitle = null;
        this._menu.menuClosed?.(index - 1);
        if (this._updateWhenClosed) {
            this._updateWhenClosed = false;
            this._queueUpdate();
        }
    }

    // ---- what to show ----

    _syncEnabled() {
        if (this._settings?.get_boolean('enabled') ?? false)
            this._activate();
        else
            this._deactivate();
    }

    _activate() {
        if (this._active)
            return;
        this._active = true;

        this._tracker = Shell.WindowTracker.get_default();
        this._fallback ??= new FallbackMenu();
        this._store ??= new MappingStore();
        this._scanner ??= new Scanner();
        this._reloadMappings();
        // applications only export to a registrar that is there when they
        // start, so it stays even when turned off
        this._registrar ??= new Registrar();
        this._registrar.connectObject('changed', () => this._queueUpdate(), this);

        this._tracker.connectObject('notify::focus-app', () => this._queueUpdate(), this);
        global.display.connectObject('notify::focus-window', () => this._queueUpdate(), this);
        Main.overview.connectObject(
            'showing', () => {
                this.closeMenus({animate: false});
                this._syncVisible(false);
            },
            'hidden', () => this._syncVisible(true), this);
        this.container.connectObject('notify::visible', () => this._queueUpdate(), this);

        this._syncVisible(!Main.overview.visible);
    }

    _deactivate() {
        if (!this._active)
            return;
        this._active = false;

        this.closeMenus({animate: false});
        this._registrar.disconnectObject(this);
        this._tracker.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this.container.disconnectObject(this);
        this._window?.disconnectObject(this);
        this._window = null;

        for (const id of ['_updateId', '_pendingId', '_syncItemsId', '_scanId']) {
            if (this[id])
                GLib.source_remove(this[id]);
            this[id] = 0;
        }
        this._setNative(null);
        this._setPending(null);
        this._menu = EMPTY_MENU;
        this.hide();
    }

    _syncVisible(visible) {
        this.visible = visible;
        if (this.visible)
            this._queueUpdate();
    }

    _reloadMappings() {
        this._store?.reloadUser().then(() => this._queueUpdate()).catch(logError);
    }

    _queueUpdate() {
        if (this._updateId)
            GLib.source_remove(this._updateId);

        const run = () => {
            this._updateId = 0;
            this._update();
        };
        this._updateId = global.display.focus_window
            ? GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, run)
            : GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, FOCUS_LOST_DELAY_MS, run);
    }

    _update() {
        // shown again later, with an update
        if (!this._active || !this.visible || !this.container.visible)
            return;

        const focusApp = this._tracker.focus_app;
        const win = focusApp ? this._menuWindow(focusApp) : null;

        if (this._openTitle) {
            // an open menu may take the focus away from the window
            if (!win || win === this._window) {
                this._updateWhenClosed = true;
                return;
            }
            this.closeMenus({animate: false});
        }

        this._trackWindow(win);
        this._app = win ? focusApp : null;
        this._mapping = win ? this._resolveMapping(win, focusApp) : null;
        this._resolveNative(win);
    }

    // The window itself, or the one of the same app that it is a dialog of
    _menuWindow(app) {
        let win = global.display.focus_window;
        for (let step = 0; win && step < MAX_TRANSIENT_STEPS; step++) {
            const parent = win.get_transient_for();
            if (!parent || this._tracker.get_window_app(parent) !== app)
                break;
            win = parent;
        }
        return win;
    }

    _trackWindow(win) {
        if (this._window === win)
            return;
        this._window?.disconnectObject(this);
        this._window = win;
        this._appActions = win ? new GtkActions(win) : null;
        this._cancelScan();
        // not necessarily known yet when a new window gets the focus
        win?.connectObject(
            'notify::gtk-unique-bus-name', () => this._queueUpdate(),
            'notify::gtk-menubar-object-path', () => this._queueUpdate(),
            'notify::wm-class', () => this._queueUpdate(),
            'unmanaged', () => this._trackWindow(null), this);
    }

    _resolveMapping(win, app) {
        if (!this._settings.get_boolean('shortcut-menus-enabled'))
            return null;

        const appId = app.get_id();
        const candidates = [
            appId,
            appId?.replace(/\.desktop$/, ''),
            win.get_wm_class(),
            win.get_wm_class_instance(),
            app.get_name(),
        ].filter(c => c).map(c => c.toLowerCase());
        return this._store.resolve(candidates,
            this._settings.get_strv('shortcut-disabled-apps'));
    }

    _resolveNative(win) {
        const native = win && !this._mapping?.blank ? this._findNative(win) : null;
        const key = native?.key;

        if (key && key === this._native?.key) {
            this._setPending(null);
            this._show();
            return;
        }
        if (key && key === this._nativePending?.key)
            return;

        if (!key) {
            this._setPending(null);
            this._setNative(null);
            this._show();
            return;
        }

        // Everything stays as it is until the menu is there, or overdue
        const source = native.create();
        this._setPending(source);
        const commit = () => {
            if (this._nativePending !== source)
                return;
            this._nativePending = null;
            this._setNative(source);
            this._show();
        };
        source.connect('titles-changed', () => {
            if (this._nativePending === source)
                commit();
            else if (this._native === source)
                this._show();
        });
        source.connect('items-changed', () => {
            if (this._menu === source)
                this._queueSyncItems();
        });
        if (source.titles.length > 0 || !source.hasBar || this._knownEmpty.has(key)) {
            commit();
        } else {
            this._pendingId = GLib.timeout_add_once(
                GLib.PRIORITY_DEFAULT, EXPORT_GRACE_MS, () => {
                    this._pendingId = 0;
                    if (this._knownEmpty.size >= MAX_KNOWN_EMPTY)
                        this._knownEmpty.clear();
                    this._knownEmpty.add(key);
                    commit();
                });
        }
    }

    _findNative(win) {
        // a registered window is sure to have a menu, the GTK one may be empty
        const entry = this._registrar.lookup(win);
        if (entry) {
            return {
                key: DBusMenuSource.keyFor(entry),
                create: () => new DBusMenuSource(entry),
            };
        }
        const key = GtkMenuSource.keyForWindow(win);
        if (key && !this._knownEmpty.has(key))
            return {key, create: () => new GtkMenuSource(win)};
        const scanned = this._scanned()?.native;
        if (scanned)
            return scanned;
        return key ? {key, create: () => new GtkMenuSource(win)} : null;
    }

    _setPending(source) {
        if (this._pendingId)
            GLib.source_remove(this._pendingId);
        this._pendingId = 0;
        this._nativePending?.destroy();
        this._nativePending = source;
    }

    _setNative(source) {
        if (this._pendingId)
            GLib.source_remove(this._pendingId);
        this._pendingId = 0;
        if (this._native === source)
            return;
        if (this._menu === this._native)
            this._menu = EMPTY_MENU;
        this._native?.destroy();
        this._native = source;
    }

    _show() {
        const scanned = this._scanned();
        let menu = EMPTY_MENU;
        this._blank = this._mapping?.blank ?? false;
        if (this._native?.titles.length > 0)
            menu = this._native;
        else if (scanned?.menu && (scanned.forced || !this._mapping))
            menu = scanned.menu;
        else if (this._mapping)
            menu = this._menu.mapping === this._mapping ? this._menu : this._mappingMenu();
        else if (!this._blank && this._settings.get_boolean('enable-fallback-menu'))
            menu = this._fallback;

        if (this._menu !== menu) {
            this.closeMenus({animate: false});
            this._menu = menu;
        }
        this._syncTitles();

        if (menu === this._fallback || (menu === EMPTY_MENU && !this._blank))
            this._queueScan();
    }

    // ---- scanning ----

    _scanned() {
        if (!this._window || !this._app || !this._settings.get_boolean('scan-menus'))
            return null;
        return this._scanner.get(this._window, this._app) ?? null;
    }

    _queueScan() {
        const win = this._window;
        const app = this._app;
        if (this._scanId || !win || !app || win.get_pid() <= 0 ||
            !this._settings.get_boolean('scan-menus') ||
            !this._settings.get_boolean('shortcut-menus-enabled') ||
            this._scanner.get(win, app) !== undefined)
            return;

        this._scanId = GLib.timeout_add_once(GLib.PRIORITY_LOW, SCAN_DELAY_MS, () => {
            this._scanId = 0;
            this._scan(win, app, false).catch(logError);
        });
    }

    _cancelScan() {
        if (this._scanId)
            GLib.source_remove(this._scanId);
        this._scanId = 0;
    }

    async _scan(win, app, forced) {
        this._cancelScan();
        const entry = await this._scanner.scan(win, app);
        if (entry) {
            entry.forced = forced;
            entry.menu?.connect?.('items-changed', () => {
                if (this._menu === entry.menu)
                    this._queueSyncItems();
            });
        }
        if (forced) {
            Main.notify(entry?.found
                ? _('Found Menus of %s').format(app.get_name())
                : _('No Menus Found in %s').format(app.get_name()),
            entry?.report.map(([name, detail]) => `${name}: ${detail}`).join('\n') ?? '');
        }
        if (this._window === win && (entry?.found || forced))
            this._queueUpdate();
    }

    _appItems() {
        const win = this._window;
        const app = this._app;
        const extra = [];
        if (app) {
            extra.push(...desktopActionSpecs(app));
            const actions = this._appActions?.getItems() ?? [];
            if (actions.length > 0)
                extra.push({label: _('Actions'), children: () => this._appActions?.getItems() ?? []});
        }
        const scan = win && app && this._menu !== this._native &&
            this._settings.get_boolean('scan-menus')
            ? {label: _('Scan for Menus'), onActivate: () => this._scan(win, app, true).catch(logError)}
            : null;
        return appMenuSpecs(app, this._native?.getAppItems() ?? [], extra, scan);
    }

    _mappingMenu() {
        const menu = new MappingMenu(this._mapping);
        menu.mapping = this._mapping;
        return menu;
    }

    _syncTitles() {
        if (!this._active)
            return;

        const texts = [this._app?.get_name() ?? _('Desktop'), ...this._menu.titles];
        for (let i = 0; i < Math.max(texts.length, this._titles.length); i++) {
            let show = i < texts.length && !this._blank;
            if (i === 0)
                show &&= !this._settings.get_boolean('hide-app-name');

            if (show)
                this._ensureTitle(i).text = texts[i];
            const container = this._titles[i]?.container;
            if (container && container.visible !== show) {
                if (!show)
                    this._titles[i].menu.close({animate: false});
                container.visible = show;
            }
        }
    }

    _ensureTitle(index) {
        // Titles are created in order, so that their position is their index
        while (this._titles.length <= index) {
            const title = new MenuTitle(this, this._titles.length);
            title.container.hide();
            this._titles.push(title);
            this.add_child(title.container);
            this._panel.menuManager.addMenu(title.menu);
        }
        return this._titles[index];
    }

    _queueSyncItems() {
        if (!this._openTitle || this._syncItemsId)
            return;
        this._syncItemsId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => {
            this._syncItemsId = 0;
            this._openTitle?.syncItems();
        });
    }
});
