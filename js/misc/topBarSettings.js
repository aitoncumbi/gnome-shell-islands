// The settings of the Top Bar panel in Settings. The shell works the same
// without the schema, just with these values.

import {loadSettings} from './prefixSettings.js';

const SCHEMA_ID = 'org.gnome.shell.top-bar';

const DEFAULTS = {
    'height': 28,
    'background-opacity': 0,
    'show-border': true,
    'show-hide-button': true,
    'remember-hidden': false,
    'hidden': false,
    'activity-pill': true,
    'activity-music': true,
    'activity-copies': true,
    'activity-downloads': true,
    'activity-blur': 18,
    'activity-tint': 16,
    'bell-always-visible': false,
    'raise-windows': true,
    'app-icon-size': 56,
    'folder-width': 85,
    'minimize-effect': 'magic-lamp',
    'open-effect': 'zoom',
    'close-effect': 'zoom',
    'animation-speed': 100,
};

let _settings;

function _getSettings() {
    if (_settings === undefined)
        _settings = loadSettings(SCHEMA_ID, 'animation-speed');
    return _settings;
}

/**
 * @param {string} key
 * @returns {boolean|number|string}
 */
export function get(key) {
    return _getSettings()?.get_value(key).deepUnpack() ?? DEFAULTS[key];
}

/**
 * @param {string} key
 * @param {boolean} value
 */
export function setBoolean(key, value) {
    _getSettings()?.set_boolean(key, value);
}

/**
 * Calls a function whenever one of the settings changes, until the owner
 * is destroyed.
 *
 * @param {string[]} keys
 * @param {Function} callback
 * @param {object} owner
 */
export function watch(keys, callback, owner) {
    for (const key of keys)
        _getSettings()?.connectObject(`changed::${key}`, () => callback(), owner);
}
