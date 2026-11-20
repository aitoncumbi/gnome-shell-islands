// Windows-style snap assist.
//
// * Dragging a window into a screen corner shows a quarter-screen preview and
//   snaps it there on release (mutter itself only knows left/right halves).
// * After a window was snapped to a half or quarter, the free area is offered
//   to the other windows on that monitor, one area at a time. Picking a window
//   places it there; Esc or a click outside stops the assist.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from './main.js';

const CORNER_ZONE = 40;     // px from both edges that count as "in the corner"
const POLL_MS = 33;
const SETTLE_MS = 90;       // let mutter finish its own tiling before we look
const TOLERANCE = 12;       // px slack when matching a window to a snap slot
const CARD_W = 168;
const CARD_H = 118;

// slot name -> [col, row, colSpan, rowSpan] on a 2x2 grid
const SLOTS = {
    'left': [0, 0, 1, 2],
    'right': [1, 0, 1, 2],
    'top-left': [0, 0, 1, 1],
    'top-right': [1, 0, 1, 1],
    'bottom-left': [0, 1, 1, 1],
    'bottom-right': [1, 1, 1, 1],
};

// slots to offer after a window took `slot`, in order
const FOLLOW_UP = {
    'left': ['right'],
    'right': ['left'],
    'top-left': ['top-right', 'bottom-left', 'bottom-right'],
    'top-right': ['top-left', 'bottom-right', 'bottom-left'],
    'bottom-left': ['bottom-right', 'top-left', 'top-right'],
    'bottom-right': ['bottom-left', 'top-right', 'top-left'],
};

function slotRect(area, slot) {
    const [c, r, cs, rs] = SLOTS[slot];
    const w = Math.floor(area.width / 2);
    const h = Math.floor(area.height / 2);
    return {
        x: area.x + c * w,
        y: area.y + r * h,
        width: cs === 2 ? area.width : (c === 1 ? area.width - w : w),
        height: rs === 2 ? area.height : (r === 1 ? area.height - h : h),
    };
}

function near(a, b) {
    return Math.abs(a - b) <= TOLERANCE;
}

export class SnapAssist {
    constructor() {
        this._pollId = 0;
        this._dragWindow = null;
        this._cornerSlot = null;
        this._preview = null;
        this._picker = null;
        this._settleId = 0;

        global.display.connectObject(
            'grab-op-begin', this._onGrabBegin.bind(this),
            'grab-op-end', this._onGrabEnd.bind(this),
            this);
    }

    destroy() {
        this._stopDrag();
        this._closePicker();
        global.display.disconnectObject(this);
    }

    // --- geometry helpers ---------------------------------------------

    _monitorAt(x, y) {
        const monitors = Main.layoutManager.monitors;
        const i = monitors.findIndex(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        return i >= 0 ? i : Main.layoutManager.primaryIndex;
    }

    _workArea(monitorIndex) {
        return global.workspace_manager.get_active_workspace()
            .get_work_area_for_monitor(monitorIndex);
    }

    _slotAt(area, px, py) {
        const left = px - area.x < CORNER_ZONE;
        const right = area.x + area.width - px <= CORNER_ZONE;
        const top = py - area.y < CORNER_ZONE;
        const bottom = area.y + area.height - py <= CORNER_ZONE;
        if (top && left)
            return 'top-left';
        if (top && right)
            return 'top-right';
        if (bottom && left)
            return 'bottom-left';
        if (bottom && right)
            return 'bottom-right';
        return null;
    }

    // Which slot a window currently fills, or null
    _slotOfWindow(window, area) {
        const f = window.get_frame_rect();
        for (const slot of Object.keys(SLOTS)) {
            const r = slotRect(area, slot);
            if (near(f.x, r.x) && near(f.y, r.y) &&
                near(f.width, r.width) && near(f.height, r.height))
                return slot;
        }
        return null;
    }

    _place(window, rect) {
        if (window.is_maximized())
            window.unmaximize();
        window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
    }

    // --- drag tracking ---------------------------------------------------

    _onGrabBegin(display, window, op) {
        if (op !== Meta.GrabOp.MOVING || !window)
            return;
        this._closePicker();
        this._dragWindow = window;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _poll() {
        const [px, py] = global.get_pointer();
        const mon = this._monitorAt(px, py);
        const area = this._workArea(mon);
        const slot = this._slotAt(area, px, py);
        this._cornerSlot = slot ? {slot, mon} : null;
        if (!slot) {
            this._hidePreview();
            return;
        }
        this._showPreview(slotRect(area, slot));
    }

    _showPreview(rect) {
        if (!this._preview) {
            this._preview = new St.Widget({style_class: 'snap-preview'});
            Main.layoutManager.addChrome(this._preview, {affectsInputRegion: false});
        }
        this._preview.set({x: rect.x, y: rect.y, width: rect.width, height: rect.height});
        this._preview.show();
    }

    _hidePreview() {
        if (this._preview)
            this._preview.hide();
    }

    _stopDrag() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._settleId) {
            GLib.source_remove(this._settleId);
            this._settleId = 0;
        }
        if (this._preview) {
            Main.layoutManager.removeChrome(this._preview);
            this._preview.destroy();
            this._preview = null;
        }
        this._dragWindow = null;
    }

    _onGrabEnd(display, window, op) {
        if (op !== Meta.GrabOp.MOVING || window !== this._dragWindow)
            return;

        const corner = this._cornerSlot;
        this._cornerSlot = null;
        const win = this._dragWindow;
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        this._hidePreview();

        // mutter applies its own edge tiling around now; look afterwards
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settleId = 0;
            this._afterDrop(win, corner);
            this._stopDrag();
            return GLib.SOURCE_REMOVE;
        });
    }

    _afterDrop(window, corner) {
        if (!window || !window.get_compositor_private())
            return;

        let mon, area, slot;
        if (corner) {
            mon = corner.mon;
            area = this._workArea(mon);
            slot = corner.slot;
            this._place(window, slotRect(area, slot));
        } else {
            mon = window.get_monitor();
            area = this._workArea(mon);
            slot = this._slotOfWindow(window, area);
            if (slot !== 'left' && slot !== 'right')
                return;
        }
        this.offer(window, mon, slot);
    }

    // --- picker --------------------------------------------------------

    // Offer the areas left free by `snapped` (which took `slot`) in turn
    offer(snapped, mon, slot) {
        this._closePicker();
        const queue = [...FOLLOW_UP[slot]];
        this._offerNext(snapped, mon, queue, new Set([snapped]));
    }

    _candidates(mon, exclude) {
        const ws = global.workspace_manager.get_active_workspace();
        const windows = ws.list_windows().filter(w =>
            !exclude.has(w) &&
            w.get_monitor() === mon &&
            !w.minimized &&
            !w.is_skip_taskbar() &&
            w.get_window_type() === Meta.WindowType.NORMAL &&
            w.get_compositor_private());
        return global.display.sort_windows_by_stacking(windows).reverse();
    }

    _offerNext(snapped, mon, queue, used) {
        if (!queue.length)
            return;
        const candidates = this._candidates(mon, used);
        if (!candidates.length)
            return;

        const area = this._workArea(mon);
        const slot = queue.shift();
        const rect = slotRect(area, slot);
        this._openPicker(rect, area, candidates, chosen => {
            if (chosen) {
                this._place(chosen, rect);
                used.add(chosen);
                Main.activateWindow(chosen);
                this._offerNext(snapped, mon, queue, used);
            }
        });
    }

    _openPicker(rect, area, windows, onDone) {
        this._closePicker();

        // full-work-area backdrop: catches clicks outside the panel
        const backdrop = new St.Widget({
            reactive: true,
            x: area.x, y: area.y, width: area.width, height: area.height,
            layout_manager: new Clutter.FixedLayout(),
        });
        const panel = new St.BoxLayout({
            style_class: 'snap-assist-panel',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x: rect.x - area.x, y: rect.y - area.y,
            width: rect.width, height: rect.height,
        });
        backdrop.add_child(panel);

        panel.add_child(new St.Label({
            style_class: 'snap-assist-title',
            text: _('Pick a window to snap here'),
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const flow = new St.Widget({
            style_class: 'snap-assist-cards',
            layout_manager: new Clutter.FlowLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                column_spacing: 14, row_spacing: 14,
                homogeneous: true,
            }),
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        panel.add_child(flow);

        const finish = chosen => {
            this._closePicker();
            onDone(chosen);
        };

        for (const win of windows.slice(0, 12))
            flow.add_child(this._makeCard(win, () => finish(win)));

        // Only a press on the empty backdrop dismisses. Presses on a card
        // bubble up to here too and must not cancel before the click lands.
        backdrop.connect('button-press-event', (_a, event) => {
            const src = event.get_source();
            if (src !== backdrop && panel.contains(src))
                return Clutter.EVENT_PROPAGATE;
            finish(null);
            return Clutter.EVENT_STOP;
        });
        backdrop.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                finish(null);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.layoutManager.addTopChrome(backdrop);
        this._modal = Main.pushModal(backdrop);
        backdrop.grab_key_focus();
        this._picker = backdrop;
    }

    _makeCard(window, onClick) {
        const actor = window.get_compositor_private();
        const [aw, ah] = actor.get_size();
        const scale = Math.min((CARD_W - 16) / aw, (CARD_H - 40) / ah, 1);

        const card = new St.Button({
            style_class: 'snap-card',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        const thumbBin = new St.Bin({
            width: CARD_W - 16, height: CARD_H - 40,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const clone = new Clutter.Clone({source: actor});
        clone.set_size(aw * scale, ah * scale);
        thumbBin.set_child(clone);
        box.add_child(thumbBin);
        box.add_child(new St.Label({
            style_class: 'snap-card-title',
            text: window.get_title() ?? '',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        card.set_child(box);
        card.set_size(CARD_W, CARD_H);
        card.connect('clicked', onClick);
        return card;
    }

    _closePicker() {
        if (!this._picker)
            return;
        const picker = this._picker;
        this._picker = null;
        if (this._modal) {
            Main.popModal(this._modal);
            this._modal = null;
        }
        Main.layoutManager.removeChrome(picker);
        picker.destroy();
    }
}
