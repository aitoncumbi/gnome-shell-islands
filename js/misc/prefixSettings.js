import Gio from 'gi://Gio';

/**
 * Settings of a schema that is installed along with the shell. The shell may
 * live in its own prefix, which need not be in XDG_DATA_DIRS.
 *
 * @param {string} schemaId
 * @param {string} requiredKey - a key that the schema must have
 * @returns {Gio.Settings|null} the settings, or null when the schema is not
 *   installed (constructing Gio.Settings would abort the shell then)
 */
export function loadSettings(schemaId, requiredKey) {
    try {
        const dir = Gio.File.new_for_path(global.datadir)
            .resolve_relative_path('../glib-2.0/schemas').get_path();
        const source = Gio.SettingsSchemaSource.new_from_directory(
            dir, Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(schemaId, true);
        if (schema?.has_key(requiredKey))
            return new Gio.Settings({settings_schema: schema});
    } catch (e) {
        console.warn(`Cannot read the settings schema ${schemaId}: ${e.message}`);
    }
    return null;
}
