// What the menu behind the application name offers on top of the basics: the
// actions of the desktop file, and those a GTK application exports on the bus

import Gio from 'gi://Gio';

const MAX_ACTIONS = 60;

// 'show-help-overlay' -> 'Show Help Overlay'
function _humanize(name) {
    return name.replace(/[-_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/(^|\s)\p{Ll}/gu, c => c.toUpperCase()).trim();
}

/**
 * @param {Shell.App} app - an application
 * @returns {object[]} menu item specs
 */
export function desktopActionSpecs(app) {
    const info = app.get_app_info();
    return (info?.list_actions() ?? [])
        .filter(action => action !== 'new-window')
        .map(action => ({
            label: info.get_action_name(action),
            onActivate: () => app.launch_action(action, global.get_current_time(), -1),
        }));
}

/**
 * @param {Meta.Window|null} win - a window
 * @returns {Gio.DBusActionGroup[]} its action groups
 */
function _groups(win) {
    const bus = win?.gtk_unique_bus_name;
    if (!bus)
        return [];
    return [win.gtk_application_object_path, win.gtk_window_object_path]
        .filter(path => path)
        .map(path => Gio.DBusActionGroup.get(Gio.DBus.session, bus, path));
}

// The actions arrive some time after they were first asked for
export class GtkActions {
    constructor(win) {
        this._groups = _groups(win);
    }

    prefetch() {
        this._groups.forEach(group => group.list_actions());
    }

    getItems() {
        const specs = new Map();
        for (const group of this._groups) {
            for (const name of group.list_actions()) {
                // those with a parameter need to be told something
                if (specs.size >= MAX_ACTIONS || group.get_action_parameter_type(name) ||
                    group.get_action_state_type(name) || !group.get_action_enabled(name))
                    continue;
                const label = _humanize(name);
                if (label && !specs.has(label)) {
                    specs.set(label, {
                        label,
                        onActivate: () => group.activate_action(name, null),
                    });
                }
            }
        }
        return [...specs.values()].sort((a, b) => a.label.localeCompare(b.label));
    }
}
