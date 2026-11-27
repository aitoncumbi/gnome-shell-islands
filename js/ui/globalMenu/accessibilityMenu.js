// A menu bar inside of a window, operated like an assistive technology would

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from '../../misc/signals.js';
import * as PopupMenu from '../popupMenu.js';

const CALL_TIMEOUT_MS = 2000;

const State = {CHECKED: 4, SENSITIVE: 24};

Gio._promisify(Gio.DBusConnection, 'new_for_address');

let _connection = null;

function _getConnection(address) {
    _connection ??= Gio.DBusConnection.new_for_address(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
        Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, null, null);
    return _connection;
}

export class AccessibilityMenu extends Signals.EventEmitter {
    constructor(address, menus) {
        super();

        this._address = address;
        this._menus = menus;
        this.titles = menus.map(m => m.label);
    }

    getItems(index) {
        const menu = this._menus[index];
        return menu ? this._toSpecs(menu.items) : [];
    }

    menuOpened(index) {
        const menu = this._menus[index];
        if (menu)
            this._refresh(menu.items);
    }

    _toSpecs(items) {
        const {Ornament} = PopupMenu;
        return items.map(item => {
            if (item.separator)
                return item;
            const spec = {label: item.label};
            if (item.items) {
                spec.children = () => this._toSpecs(item.items);
                spec.onOpen = () => this._refresh(item.items);
                return spec;
            }
            spec.accel = item.accel;
            spec.enabled = item.enabled;
            if (item.toggle === 'check')
                spec.ornament = item.checked ? Ornament.CHECK : Ornament.NONE;
            else if (item.toggle === 'radio')
                spec.ornament = item.checked ? Ornament.DOT : Ornament.NO_DOT;
            spec.onActivate = () => this._call(item, 'org.a11y.atspi.Action',
                'DoAction', new GLib.Variant('(i)', [item.action])).catch(logError);
            return spec;
        });
    }

    async _call({ref: [name, path]}, iface, method, params = null) {
        const connection = await _getConnection(this._address);
        const reply = await connection.call(name, path, iface, method, params, null,
            Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, null);
        return reply.recursiveUnpack();
    }

    // What is enabled and checked may have changed since the scan
    async _refresh(items) {
        const results = await Promise.allSettled(items.filter(i => i.ref).map(async item => {
            const [[low]] = await this._call(item, 'org.a11y.atspi.Accessible', 'GetState');
            const enabled = (low & (1 << State.SENSITIVE)) !== 0;
            const checked = (low & (1 << State.CHECKED)) !== 0;
            const changed = enabled !== item.enabled || (item.toggle && checked !== item.checked);
            item.enabled = enabled;
            item.checked = checked;
            return changed;
        }));
        if (results.some(r => r.value))
            this.emit('items-changed');
    }
}
