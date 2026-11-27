// Menu bar of an application that exports com.canonical.dbusmenu (Qt,
// Electron, Chromium, Firefox; under XWayland), and the registrar those
// applications announce it to.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Signals from '../../misc/signals.js';
import * as PopupMenu from '../popupMenu.js';

import {stripMnemonic} from './labels.js';

const REGISTRAR_NAME = 'com.canonical.AppMenu.Registrar';
const REGISTRAR_PATH = '/com/canonical/AppMenu/Registrar';
const REGISTRAR_XML = `
<node>
  <interface name="com.canonical.AppMenu.Registrar">
    <method name="RegisterWindow">
      <arg name="windowId" type="u" direction="in"/>
      <arg name="menuObjectPath" type="o" direction="in"/>
    </method>
    <method name="UnregisterWindow">
      <arg name="windowId" type="u" direction="in"/>
    </method>
    <method name="GetMenuForWindow">
      <arg name="windowId" type="u" direction="in"/>
      <arg name="service" type="s" direction="out"/>
      <arg name="menuObjectPath" type="o" direction="out"/>
    </method>
    <method name="GetMenus">
      <arg name="menus" type="a(uso)" direction="out"/>
    </method>
    <signal name="WindowRegistered">
      <arg name="windowId" type="u"/>
      <arg name="service" type="s"/>
      <arg name="menuObjectPath" type="o"/>
    </signal>
    <signal name="WindowUnregistered">
      <arg name="windowId" type="u"/>
    </signal>
  </interface>
</node>`;

const MENU_IFACE = 'com.canonical.dbusmenu';

// Only ask for what is shown; icons in particular are large
const PROPERTIES = [
    'type', 'label', 'visible', 'enabled', 'children-display',
    'toggle-type', 'toggle-state', 'shortcut',
];

const CALL_TIMEOUT_MS = 2000;
const LAYOUT_DELAY_MS = 100;

const SEPARATOR = {separator: true};

export class Registrar extends Signals.EventEmitter {
    constructor() {
        super();

        this._menus = new Map(); // window id -> {service, path}
        this._watches = new Map(); // service -> watch id

        this._impl = Gio.DBusExportedObject.wrapJSObject(REGISTRAR_XML, this);
        this._impl.export(Gio.DBus.session, REGISTRAR_PATH);
        Gio.DBus.session.own_name(REGISTRAR_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    lookup(win) {
        if (this._menus.size === 0 ||
            win.get_client_type() !== Meta.WindowClientType.X11)
            return null;
        // the description of an X11 window starts with its id
        const xid = parseInt(win.get_description()?.match(/^0x[0-9a-f]+/)?.[0]);
        return this._menus.get(xid) ?? null;
    }

    RegisterWindowAsync([windowId, path], invocation) {
        const service = invocation.get_sender();
        this._menus.set(windowId, {service, path});
        if (!this._watches.has(service)) {
            this._watches.set(service, Gio.DBus.session.watch_name(service,
                Gio.BusNameWatcherFlags.NONE, null, () => this._serviceVanished(service)));
        }
        invocation.return_value(null);
        this._impl.emit_signal('WindowRegistered',
            new GLib.Variant('(uso)', [windowId, service, path]));
        this.emit('changed');
    }

    UnregisterWindow(windowId) {
        if (!this._menus.delete(windowId))
            return;
        this._impl.emit_signal('WindowUnregistered', new GLib.Variant('(u)', [windowId]));
        this.emit('changed');
    }

    GetMenuForWindowAsync([windowId], invocation) {
        const menu = this._menus.get(windowId);
        if (menu) {
            invocation.return_value(new GLib.Variant('(so)', [menu.service, menu.path]));
        } else {
            invocation.return_error_literal(Gio.DBusError, Gio.DBusError.INVALID_ARGS,
                'This window has no menu');
        }
    }

    GetMenus() {
        return [...this._menus].map(([id, {service, path}]) => [id, service, path]);
    }

    _serviceVanished(service) {
        const watchId = this._watches.get(service);
        if (watchId) {
            this._watches.delete(service);
            Gio.DBus.session.unwatch_name(watchId);
        }
        for (const [id, menu] of this._menus) {
            if (menu.service === service)
                this._menus.delete(id);
        }
        this.emit('changed');
    }
}

// [['Control', 'S']] -> '<Control>S'
function _shortcutToAccel(shortcut) {
    const keys = shortcut?.[0];
    if (!Array.isArray(keys) || keys.length === 0)
        return undefined;
    return keys.slice(0, -1).map(k => `<${k}>`).join('') + keys.at(-1);
}

export class DBusMenuSource extends Signals.EventEmitter {
    static keyFor({service, path}) {
        return ['dbusmenu', service, path].join(' ');
    }

    constructor({service, path}) {
        super();

        this.key = DBusMenuSource.keyFor({service, path});
        this._service = service;
        this._path = path;
        this._cancellable = new Gio.Cancellable();
        this._bar = []; // top level nodes
        this._nodes = new Map(); // id -> node
        this._openIndex = -1;
        this._layoutId = 0;
        this._barOutdated = false;

        const subscribe = (signal, callback) => Gio.DBus.session.signal_subscribe(
            service, MENU_IFACE, signal, path, null, Gio.DBusSignalFlags.NONE,
            (_bus, _sender, _path, _iface, _signal, params) => callback(params.recursiveUnpack()));
        this._subscriptions = [
            subscribe('LayoutUpdated', ([, parent]) => this._layoutUpdated(parent)),
            subscribe('ItemsPropertiesUpdated', args => this._propertiesUpdated(...args)),
        ];

        this._fetchBar();
    }

    get hasBar() {
        return true;
    }

    get titles() {
        return this._visibleBar().map(n => this._label(n));
    }

    prefetch(index) {
        const node = this._visibleBar()[index];
        if (node && !node.complete)
            this._fetchNode(node);
    }

    menuOpened(index) {
        const node = this._visibleBar()[index];
        this._openIndex = index;
        if (node)
            this._showNode(node);
    }

    menuClosed(index) {
        const node = this._visibleBar()[index];
        this._openIndex = -1;
        if (node)
            this._event(node, 'closed');
    }

    getItems(index) {
        const node = this._visibleBar()[index];
        return node ? this._buildSpecs(node) : [];
    }

    getAppItems() {
        return [];
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of this._subscriptions)
            Gio.DBus.session.signal_unsubscribe(id);
        this._subscriptions = [];
        if (this._layoutId)
            GLib.source_remove(this._layoutId);
        this._layoutId = 0;
        this._nodes.clear();
        this._bar = [];
    }

    _visibleBar() {
        return this._bar.filter(n => n.props.visible !== false && this._label(n));
    }

    _label(node) {
        return stripMnemonic(node.props.label);
    }

    async _call(method, params, replyType) {
        const reply = await Gio.DBus.session.call(this._service, this._path,
            MENU_IFACE, method, params, replyType, Gio.DBusCallFlags.NONE,
            CALL_TIMEOUT_MS, this._cancellable);
        return reply.recursiveUnpack();
    }

    _event(node, name) {
        // nothing to do about applications that do not care for an event
        this._call('Event', new GLib.Variant('(isvu)',
            [node.id, name, GLib.Variant.new_int32(0), global.get_current_time()]),
        null).catch(() => {});
    }

    async _getLayout(id, depth) {
        const [, layout] = await this._call('GetLayout',
            new GLib.Variant('(iias)', [id, depth, PROPERTIES]),
            new GLib.VariantType('(u(ia{sv}av))'));
        return layout;
    }

    _parse([id, props, children], complete) {
        const node = {id, props, complete, children: []};
        this._nodes.set(id, node);
        node.children = children.map(child => this._parse(child, complete));
        return node;
    }

    _forget(node) {
        for (const child of node.children) {
            this._forget(child);
            this._nodes.delete(child.id);
        }
    }

    async _fetchBar() {
        try {
            const root = await this._getLayout(0, 1);
            this._nodes.clear();
            this._bar = this._parse(root, false).children;
            this.emit('titles-changed');
            if (this._openIndex !== -1)
                this._fetchOpen();
        } catch {
            // gone, or never answered: the bar stays as it is
        }
    }

    _fetchOpen() {
        const node = this._visibleBar()[this._openIndex];
        if (node)
            this._fetchNode(node);
    }

    async _fetchNode(node) {
        try {
            const layout = await this._getLayout(node.id, -1);
            if (this._nodes.get(node.id) !== node)
                return;
            this._forget(node);
            node.children = layout[2].map(child => this._parse(child, true));
            node.complete = true;
            this.emit('items-changed');
        } catch {
            // keep what is there
        }
    }

    // Applications fill menus when told that they are about to be shown
    async _showNode(node) {
        try {
            await this._call('AboutToShow', new GLib.Variant('(i)', [node.id]),
                new GLib.VariantType('(b)'));
        } catch {
            // optional
        }
        if (this._cancellable.is_cancelled())
            return;
        this._event(node, 'opened');
        this._fetchNode(node);
    }

    _layoutUpdated(parentId) {
        // A change inside a menu only matters once that menu is shown, and
        // opening fetches it anyway
        if (parentId !== 0 && this._openIndex === -1)
            return;

        this._barOutdated ||= parentId === 0;
        if (this._layoutId)
            return;
        this._layoutId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, LAYOUT_DELAY_MS, () => {
            this._layoutId = 0;
            if (this._barOutdated)
                this._fetchBar();
            else
                this._fetchOpen();
            this._barOutdated = false;
        });
    }

    _propertiesUpdated(updated, removed) {
        let barTouched = false;
        let itemsTouched = false;
        const touch = node => {
            if (this._bar.includes(node))
                barTouched = true;
            else
                itemsTouched = true;
        };

        for (const [id, props] of updated) {
            const node = this._nodes.get(id);
            if (!node)
                continue;
            for (const name of PROPERTIES) {
                if (name in props)
                    node.props[name] = props[name];
            }
            touch(node);
        }
        for (const [id, names] of removed) {
            const node = this._nodes.get(id);
            if (!node)
                continue;
            for (const name of names)
                delete node.props[name];
            touch(node);
        }

        if (barTouched)
            this.emit('titles-changed');
        if (itemsTouched && this._openIndex !== -1)
            this.emit('items-changed');
    }

    _buildSpecs(parent) {
        const specs = [];
        for (const node of parent.children) {
            const {props} = node;
            if (props.visible === false)
                continue;
            if (props.type === 'separator') {
                specs.push(SEPARATOR);
                continue;
            }
            const label = this._label(node);
            if (!label)
                continue;

            const spec = {label, enabled: props.enabled !== false};
            if (props['children-display'] === 'submenu' || node.children.length > 0) {
                spec.children = () => this._buildSpecs(this._nodes.get(node.id) ?? node);
                spec.onOpen = () => this._showNode(this._nodes.get(node.id) ?? node);
                spec.onClose = () => this._event(node, 'closed');
            } else {
                spec.accel = _shortcutToAccel(props.shortcut);
                const on = props['toggle-state'] === 1;
                if (props['toggle-type'] === 'checkmark')
                    spec.ornament = on ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE;
                else if (props['toggle-type'] === 'radio')
                    spec.ornament = on ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT;
                // applications may drop the item once the menu is closed
                spec.beforeClose = true;
                spec.onActivate = () => this._event(node, 'clicked');
            }
            specs.push(spec);
        }
        return specs;
    }
}
