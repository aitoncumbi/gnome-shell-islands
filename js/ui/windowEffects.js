// The window animations that can be picked in Settings. windowManager.js falls
// back to its own for the 'default' ones.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as TopBarSettings from '../misc/topBarSettings.js';
import * as Main from './main.js';

const LAMP_EFFECT_NAME = 'gnome-shell-window-lamp';

const LAMP_TIME = 520;
const LAMP_CLOSE_TIME = 420;
const LAMP_FADE = 0.18; // the last part of the way, where the window fades
const SCALE_TIME = 340;
const MINIMIZE_TIME = 240;
const RESTORE_TIME = 300;
const OPEN_TIME = 260;
const CLOSE_TIME = 180;
const DIALOG_FACTOR = 0.8;

// Where the window goes if nobody said where its icon is
const FALLBACK_TARGET_SIZE = 48;

// How a window looks at the far end of its animation, next to being invisible.
// Distances are logical pixels.
const AWAY = {
    'fade': {},
    'zoom': {scale: 0.9},
    'glide': {scale: 0.94, angle: -14, distance: 28},
    'slide': {scale: 0.98, distance: 56},
};

/**
 * @param {string} key - 'minimize-effect', 'open-effect' or 'close-effect'
 * @param {Clutter.Actor} actor - a window actor
 * @returns {string} the effect to use: 'default' is the one of GNOME, which
 *   also knows how to handle reduced motion
 */
export function getEffect(key, actor) {
    if (St.Settings.get().reducedMotion === St.ReducedMotion.REDUCE)
        return 'default';

    const effect = TopBarSettings.get(key);
    // moving something that covers the screen rather shows what is behind it
    if (key === 'minimize-effect' && actor.meta_window.is_fullscreen() && effect !== 'none')
        return 'default';

    return effect;
}

/**
 * Puts a window actor back to normal
 *
 * @param {Clutter.Actor} actor
 */
export function reset(actor) {
    actor.remove_effect_by_name(LAMP_EFFECT_NAME);
    actor.set_scale(1, 1);
    actor.set_pivot_point(0, 0);
    actor.rotation_angle_x = 0;
    actor.translation_x = 0;
    actor.translation_y = 0;
    actor.opacity = 255;
}

/**
 * @param {Clutter.Actor} actor
 * @param {string} effect
 * @param {Function} onStopped
 */
export function minimize(actor, effect, onStopped) {
    if (effect === 'magic-lamp')
        _lamp(actor, 0, 1, LAMP_TIME, onStopped);
    else if (effect === 'scale')
        _scaleToIcon(actor, true, onStopped);
    else
        _leave(actor, effect, MINIMIZE_TIME, onStopped);
}

/**
 * @param {Clutter.Actor} actor
 * @param {string} effect
 * @param {Function} onStopped
 */
export function unminimize(actor, effect, onStopped) {
    // the effect of GNOME leaves minimized windows at their icon
    const {x, y} = actor.meta_window.get_buffer_rect();
    actor.set_position(x, y);

    if (effect === 'magic-lamp') {
        _lamp(actor, 1, 0, LAMP_TIME, onStopped);
    } else if (effect === 'scale') {
        _scaleToIcon(actor, false, onStopped);
    } else {
        prepareOpen(actor, effect);
        actor.show();
        _arrive(actor, RESTORE_TIME, onStopped);
    }
}

/**
 * Makes a window invisible, for open() to bring it in
 *
 * @param {Clutter.Actor} actor
 * @param {string} effect
 */
export function prepareOpen(actor, effect) {
    actor.set_pivot_point(0.5, 0.5);
    actor.set({..._awayProps(effect), opacity: 0});
}

/**
 * @param {Clutter.Actor} actor
 * @param {boolean} dialog
 * @param {Function} onStopped
 */
export function open(actor, dialog, onStopped) {
    _arrive(actor, OPEN_TIME * (dialog ? DIALOG_FACTOR : 1), onStopped);
}

/**
 * @param {Clutter.Actor} actor
 * @param {string} effect
 * @param {boolean} dialog
 * @param {Function} onStopped
 */
export function close(actor, effect, dialog, onStopped) {
    if (effect === 'magic-lamp' && !dialog) {
        _lamp(actor, 0, 1, LAMP_CLOSE_TIME, onStopped);
        return;
    }

    _leave(actor, effect === 'magic-lamp' ? 'zoom' : effect,
        CLOSE_TIME * (dialog ? DIALOG_FACTOR : 1), onStopped);
}

function _duration(time) {
    return Math.round(time * 100 / TopBarSettings.get('animation-speed'));
}

function _awayProps(effect) {
    const {scale = 1, angle = 0, distance = 0} = AWAY[effect] ?? AWAY['fade'];
    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);

    return {
        scale_x: scale,
        scale_y: scale,
        rotation_angle_x: angle,
        translation_y: distance * scaleFactor,
    };
}

function _arrive(actor, time, onStopped) {
    const duration = _duration(time);

    actor.ease({
        scale_x: 1,
        scale_y: 1,
        rotation_angle_x: 0,
        translation_y: 0,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_QUINT,
    });
    // last, since it is what every effect changes
    actor.ease({
        opacity: 255,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        onStopped,
    });
}

function _leave(actor, effect, time, onStopped) {
    const duration = _duration(time);

    actor.set_pivot_point(0.5, 0.5);
    actor.ease({
        ..._awayProps(effect),
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });
    actor.ease({
        opacity: 0,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onStopped,
    });
}

// The icon of a window in stage coordinates, and the side of the monitor it
// is at
function _getTarget(actor) {
    const window = actor.meta_window;
    const monitor = Main.layoutManager.monitors[window.get_monitor()] ??
        Main.layoutManager.primaryMonitor;

    let rect = null;
    for (let w = window; w && !rect; w = w.get_transient_for()) {
        const [success, geom] = w.get_icon_geometry();
        if (success && geom.width > 0 && geom.height > 0)
            rect = geom;
    }

    if (!rect) {
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const size = FALLBACK_TARGET_SIZE * scaleFactor;
        rect = {
            x: monitor.x + (monitor.width - size) / 2,
            y: monitor.y + monitor.height - size,
            width: size,
            height: size,
        };
        return {rect, side: St.Side.BOTTOM};
    }

    const x = rect.x + rect.width / 2 - monitor.x;
    const y = rect.y + rect.height / 2 - monitor.y;
    const [side] = [
        [St.Side.BOTTOM, monitor.height - y],
        [St.Side.LEFT, x],
        [St.Side.RIGHT, monitor.width - x],
        [St.Side.TOP, y],
    ].reduce((a, b) => b[1] < a[1] ? b : a);

    return {rect, side};
}

function _lamp(actor, from, to, time, onStopped) {
    const {rect, side} = _getTarget(actor);
    const [x, y] = [actor.x, actor.y];

    const lamp = new Shell.LampEffect({progress: from});
    lamp.set_target(side, rect.x - x, rect.y - y, rect.width, rect.height);
    actor.add_effect_with_name(LAMP_EFFECT_NAME, lamp);

    const duration = _duration(time);
    const fade = Math.round(duration * LAMP_FADE);
    if (from > to)
        actor.opacity = 0;
    actor.show();
    actor.ease({
        opacity: from > to ? 255 : 0,
        duration: fade,
        delay: from > to ? 0 : duration - fade,
        mode: Clutter.AnimationMode.LINEAR,
    });
    // the effect has its own easing
    actor.ease_property(`@effects.${LAMP_EFFECT_NAME}.progress`, to, {
        duration,
        mode: Clutter.AnimationMode.LINEAR,
        onStopped,
    });
}

function _scaleToIcon(actor, minimizing, onStopped) {
    const {rect} = _getTarget(actor);
    const [x, y] = [actor.x, actor.y];
    // keeps its shape, and fits into the icon
    const scale = Math.min(rect.width / actor.width, rect.height / actor.height);
    const away = {
        scale_x: scale,
        scale_y: scale,
        translation_x: rect.x + (rect.width - actor.width * scale) / 2 - x,
        translation_y: rect.y + (rect.height - actor.height * scale) / 2 - y,
    };
    const inPlace = {scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0};

    const duration = _duration(SCALE_TIME);
    const fade = Math.round(duration * 0.5);

    actor.set_pivot_point(0, 0);
    if (!minimizing)
        actor.set({...away, opacity: 0});
    actor.show();
    actor.ease({
        opacity: minimizing ? 0 : 255,
        duration: fade,
        delay: minimizing ? duration - fade : 0,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
    actor.ease({
        ...minimizing ? away : inPlace,
        duration,
        mode: minimizing
            ? Clutter.AnimationMode.EASE_IN_OUT_CUBIC
            : Clutter.AnimationMode.EASE_OUT_QUINT,
        onStopped,
    });
}
