// The Window menu: actions on the focused window

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from '../main.js';
import * as PopupMenu from '../popupMenu.js';

// A move or resize grab cannot start while the menu holds the input grab
const GRAB_DELAY_MS = 100;

function _beginGrabAfterMenu(win, op) {
    GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, GRAB_DELAY_MS, () => {
        if (global.display.focus_window !== win)
            return;
        const backend = global.stage.get_context().get_backend();
        win.begin_grab_op(op, backend.get_pointer_sprite(global.stage),
            global.get_current_time(), null);
    });
}

function _check(checked) {
    return checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE;
}

function _workspaceSpecs(win) {
    if (!Main.sessionMode.hasWorkspaces ||
        (Meta.prefs_get_workspaces_only_on_primary() && !win.is_on_primary_monitor()))
        return [];

    const specs = [];
    const isSticky = win.is_on_all_workspaces();
    if (!win.is_always_on_all_workspaces()) {
        specs.push({
            label: _('Always on Visible Workspace'),
            ornament: _check(isSticky),
            onActivate: () => isSticky ? win.unstick() : win.stick(),
        });
    }
    if (isSticky)
        return specs;

    const workspace = win.get_workspace();
    const {MotionDirection} = Meta;
    for (const [label, direction] of [
        [_('Move to Workspace Left'), MotionDirection.LEFT],
        [_('Move to Workspace Right'), MotionDirection.RIGHT],
        [_('Move to Workspace Up'), MotionDirection.UP],
        [_('Move to Workspace Down'), MotionDirection.DOWN],
    ]) {
        const neighbor = workspace.get_neighbor(direction);
        if (neighbor !== workspace)
            specs.push({label, onActivate: () => win.change_workspace(neighbor)});
    }
    return specs;
}

function _monitorSpecs(win) {
    const {display} = global;
    const current = win.get_monitor();
    if (display.get_n_monitors() <= 1 || current < 0)
        return [];

    const specs = [];
    const {DisplayDirection} = Meta;
    for (const [label, direction] of [
        [_('Move to Monitor Up'), DisplayDirection.UP],
        [_('Move to Monitor Down'), DisplayDirection.DOWN],
        [_('Move to Monitor Left'), DisplayDirection.LEFT],
        [_('Move to Monitor Right'), DisplayDirection.RIGHT],
    ]) {
        const index = display.get_monitor_neighbor_index(current, direction);
        if (index !== -1)
            specs.push({label, onActivate: () => win.move_to_monitor(index)});
    }
    return specs;
}

/**
 * @param {Meta.Window|null} win - the focused window
 * @returns {object[]} menu item specs
 */
export function windowSpecs(win) {
    if (!win)
        return [{label: _('No Window'), enabled: false}];

    const specs = [];
    const maximized = win.is_maximized();
    const type = win.get_window_type();

    if (win.can_minimize())
        specs.push({label: _('Minimize'), onActivate: () => win.minimize()});
    if (win.can_maximize()) {
        specs.push(maximized
            ? {label: _('Restore'), onActivate: () => win.unmaximize()}
            : {label: _('Maximize'), onActivate: () => win.maximize()});
    }
    if (win.allows_move()) {
        specs.push({
            label: _('Move'),
            onActivate: () => _beginGrabAfterMenu(win, Meta.GrabOp.KEYBOARD_MOVING),
        });
    }
    if (win.allows_resize()) {
        specs.push({
            label: _('Resize'),
            onActivate: () => _beginGrabAfterMenu(win, Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN),
        });
    }
    if (!maximized && type !== Meta.WindowType.DOCK &&
        type !== Meta.WindowType.DESKTOP && type !== Meta.WindowType.SPLASHSCREEN) {
        const above = win.is_above();
        specs.push({
            label: _('Always on Top'),
            ornament: _check(above),
            onActivate: () => above ? win.unmake_above() : win.make_above(),
        });
    }

    specs.push(..._workspaceSpecs(win), ..._monitorSpecs(win));

    if (win.can_close()) {
        specs.push({
            label: _('Close'),
            onActivate: () => win.delete(global.get_current_time()),
        });
    }
    return specs;
}
