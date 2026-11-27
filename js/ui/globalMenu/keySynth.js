// Sends key combinations to the focused window, for menu items that only
// know their keyboard shortcut.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseAccelerator} from './accelerator.js';

// Space chords out or apps waiting on a prefix key cannot tell them apart
const CHORD_GAP_US = 1000;

// Wait for the menu to release its grab, or the shell gets the keystroke
const AFTER_MENU_DELAY_MS = 100;

let _device = null;

function _synthesize(chords) {
    if (!_device) {
        const seat = global.stage.context.get_backend().get_default_seat();
        _device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }

    let t = GLib.get_monotonic_time();
    for (const {modifiers, keyval} of chords) {
        for (const mod of modifiers)
            _device.notify_keyval(t += 10, mod, Clutter.KeyState.PRESSED);
        _device.notify_keyval(t += 10, keyval, Clutter.KeyState.PRESSED);
        _device.notify_keyval(t += 10, keyval, Clutter.KeyState.RELEASED);
        for (const mod of [...modifiers].reverse())
            _device.notify_keyval(t += 10, mod, Clutter.KeyState.RELEASED);
        t += CHORD_GAP_US;
    }
}

function _sendShortcut(accel) {
    const chords = parseAccelerator(accel);
    if (chords)
        _synthesize(chords);
    else
        console.warn(`Global menu: unparseable accelerator ${accel}`);
}

// Runs func once the menu is gone, unless another window took the focus
// meanwhile (the keys must never land in a window the user did not mean)
function _afterMenu(func) {
    const win = global.display.focus_window;
    GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, AFTER_MENU_DELAY_MS, () => {
        const current = global.display.focus_window;
        if (!win || current === win)
            func(current);
    });
}

/**
 * @param {string} accel - an accelerator, or several separated by spaces
 */
export function sendShortcutAfterMenu(accel) {
    _afterMenu(() => _sendShortcut(accel));
}

/**
 * Activates an action of the focused GTK application, falling back to its
 * shortcut when the window has no action bus or the app refuses the action.
 *
 * @param {string} action - action name
 * @param {number=} target - integer action target
 * @param {string=} shortcut - fallback accelerator
 */
export function activateActionAfterMenu(action, target, shortcut) {
    _afterMenu(win => {
        const bus = win?.gtk_unique_bus_name;
        const path = win?.gtk_application_object_path;
        const fallback = () => {
            if (shortcut)
                _sendShortcut(shortcut);
        };
        if (!bus || !path) {
            fallback();
            return;
        }

        const parameter = target === undefined ? [] : [GLib.Variant.new_int32(target)];
        Gio.DBus.session.call(bus, path, 'org.gtk.Actions', 'Activate',
            new GLib.Variant('(sava{sv})', [action, parameter, {}]),
            null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch {
                    if (global.display.focus_window === win)
                        fallback();
                }
            });
    });
}
