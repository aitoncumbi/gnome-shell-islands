// The settings are shared with the global-menu@unmade.space extension (same
// schema id and path), so its preferences window keeps working.

import {loadSettings} from '../../misc/prefixSettings.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.global-menu';

let _settings;

/**
 * @returns {Gio.Settings|null} the settings, or null when the schema is not
 *   installed
 */
export function getSettings() {
    if (_settings !== undefined)
        return _settings;

    // not the schema of the extension, which lacks some keys
    _settings = loadSettings(SCHEMA_ID, 'scan-menus');
    if (!_settings)
        console.warn('Global menu: settings schema not found, staying off');
    return _settings;
}
