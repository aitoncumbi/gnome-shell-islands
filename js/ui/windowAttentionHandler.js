import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from './main.js';
import * as MessageTray from './messageTray.js';

// Windows that ask for attention are brought to the front right away, unless
// the user was typing a moment ago (then a notification is shown instead, so
// a window never grabs focus out from under the keyboard)
const TYPING_GRACE_MS = 1200;

export class WindowAttentionHandler {
    constructor() {
        this._lastKeyTime = 0;
        global.stage.connectObject('captured-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.KEY_PRESS)
                this._lastKeyTime = GLib.get_monotonic_time() / 1000;
            return Clutter.EVENT_PROPAGATE;
        }, this);
        this._tracker = Shell.WindowTracker.get_default();
        global.display.connectObject(
            'window-demands-attention', this._onWindowDemandsAttention.bind(this),
            'window-marked-urgent', this._onWindowDemandsAttention.bind(this),
            this);
    }

    _getTitleAndBanner(app, window) {
        const title = app.get_name();
        const banner = _('“%s” is ready').format(window.get_title());
        return [title, banner];
    }

    _onWindowDemandsAttention(display, window) {
        // We don't want to show the notification when the window is already focused,
        // because this is rather pointless.
        // Some apps (like GIMP) do things like setting the urgency hint on the
        // toolbar windows which would result into a notification even though GIMP itself is
        // focused.
        // We are just ignoring the hint on skip_taskbar windows for now.
        // (Which is the same behaviour as with metacity + panel)

        if (!window || window.has_focus() || window.is_skip_taskbar())
            return;

        const typing =
            GLib.get_monotonic_time() / 1000 - this._lastKeyTime < TYPING_GRACE_MS;
        if (!typing) {
            Main.activateWindow(window);
            return;
        }

        const app = this._tracker.get_window_app(window);
        const source = new WindowAttentionSource(app, window);
        Main.messageTray.add(source);

        let [title, body] = this._getTitleAndBanner(app, window);

        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            forFeedback: true,
        });
        notification.connect('activated', () => {
            source.open();
        });

        source.addNotification(notification);

        window.connectObject('notify::title', () => {
            [title, body] = this._getTitleAndBanner(app, window);
            notification.set({title, body});
        }, source);
    }
}

const WindowAttentionSource = GObject.registerClass(
class WindowAttentionSource extends MessageTray.Source {
    constructor(app, window) {
        super({
            title: app.get_name(),
            icon: app.get_icon(),
            policy: MessageTray.NotificationPolicy.newForApp(app),
        });

        this._window = window;
        this._window.connectObject(
            'notify::demands-attention', this._sync.bind(this),
            'notify::urgent', this._sync.bind(this),
            'focus', () => this.destroy(),
            'unmanaged', () => this.destroy(), this);
    }

    _sync() {
        if (this._window.demands_attention || this._window.urgent)
            return;
        this.destroy();
    }

    destroy(params) {
        this._window.disconnectObject(this);

        super.destroy(params);
    }

    open() {
        Main.activateWindow(this._window);
    }
});
