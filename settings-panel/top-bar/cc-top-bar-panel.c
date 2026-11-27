/* SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Settings of the modified GNOME Shell: its top bar, the activity pill in it
 * and the app grid.
 */

#include "config.h"

#include <glib/gi18n.h>

#include "cc-top-bar-panel.h"

#include "cc-top-bar-resources.h"

#define TOP_BAR_SCHEMA "org.gnome.shell.top-bar"
#define GLOBAL_MENU_SCHEMA "org.gnome.shell.extensions.global-menu"

/* The rows that depend on another row bind their own sensitivity */
#define BIND_FLAGS (G_SETTINGS_BIND_DEFAULT | G_SETTINGS_BIND_NO_SENSITIVITY)

struct _CcTopBarPanel {
    CcPanel parent_instance;

    GSettings *settings;
    GSettings *global_menu_settings;

    AdwSpinRow *activity_blur_row;
    AdwSwitchRow *activity_copies_row;
    AdwSwitchRow *activity_downloads_row;
    AdwSwitchRow *activity_music_row;
    AdwSwitchRow *activity_pill_row;
    AdwSpinRow *activity_tint_row;
    AdwSpinRow *animation_speed_row;
    AdwSpinRow *app_icon_size_row;
    AdwSpinRow *background_opacity_row;
    AdwSwitchRow *bell_always_visible_row;
    AdwComboRow *close_effect_row;
    AdwSpinRow *folder_width_row;
    AdwPreferencesGroup *global_menu_group;
    AdwSpinRow *height_row;
    AdwSwitchRow *menu_app_name_row;
    AdwSwitchRow *menu_bundled_row;
    AdwSwitchRow *menu_enabled_row;
    AdwSwitchRow *menu_fallback_row;
    AdwSwitchRow *menu_scan_row;
    AdwSwitchRow *menu_shortcuts_row;
    AdwComboRow *minimize_effect_row;
    AdwComboRow *open_effect_row;
    AdwSwitchRow *raise_windows_row;
    AdwSwitchRow *remember_hidden_row;
    AdwSwitchRow *show_border_row;
    AdwSwitchRow *show_hide_button_row;
    GtkStack *stack;
};

CC_PANEL_REGISTER (CcTopBarPanel, cc_top_bar_panel)

/* The keys of the global menu that have a row */
static const char *const global_menu_keys[] = {
    "enabled", "hide-app-name", "shortcut-labels", "shortcut-menus-enabled", "scan-menus", "enable-fallback-menu",
};

/* The shell is installed in a prefix of its own, where GSettings does not look */
static GSettings *
load_settings (const char *schema_id, const char *required_key)
{
    g_autoptr(GSettingsSchemaSource) source = NULL;
    g_autoptr(GSettingsSchema) schema = NULL;
    g_autoptr(GError) error = NULL;

    source = g_settings_schema_source_new_from_directory (TOP_BAR_SCHEMA_DIR, g_settings_schema_source_get_default (),
                                                          FALSE, &error);
    if (!source) {
        g_warning ("Cannot read the schemas of the shell: %s", error->message);
        return NULL;
    }

    schema = g_settings_schema_source_lookup (source, schema_id, TRUE);
    if (!schema || !g_settings_schema_has_key (schema, required_key))
        return NULL;

    return g_settings_new_full (schema, NULL, NULL);
}

static gboolean
get_shortcut_labels (GValue *value, GVariant *variant, gpointer user_data)
{
    g_value_set_boolean (value, g_strcmp0 (g_variant_get_string (variant, NULL), "never") != 0);
    return TRUE;
}

static GVariant *
set_shortcut_labels (const GValue *value, const GVariantType *type, gpointer user_data)
{
    return g_variant_new_string (g_value_get_boolean (value) ? "always" : "never");
}

/* All window animations. What a row offers is up to the schema. */
static const struct {
    const char *id;
    const char *name;
} effects[] = {
    { "magic-lamp", N_("Magic Lamp") }, { "scale", N_("Scale to Icon") }, { "zoom", N_("Zoom") },
    { "glide", N_("Glide") },           { "slide", N_("Slide") },         { "fade", N_("Fade") },
    { "default", N_("GNOME Default") }, { "none", N_("None") },
};

/* The ids of the effects in a row, in the order of its model */
static const char *const *
get_row_ids (AdwComboRow *row)
{
    return g_object_get_data (G_OBJECT (row), "effect-ids");
}

static gboolean
get_effect (GValue *value, GVariant *variant, gpointer user_data)
{
    const char *const *ids = get_row_ids (user_data);
    const char *id = g_variant_get_string (variant, NULL);

    for (guint i = 0; ids[i]; i++) {
        if (g_str_equal (ids[i], id)) {
            g_value_set_uint (value, i);
            return TRUE;
        }
    }
    return FALSE;
}

static GVariant *
set_effect (const GValue *value, const GVariantType *type, gpointer user_data)
{
    const char *const *ids = get_row_ids (user_data);
    guint selected = g_value_get_uint (value);

    if (selected >= g_strv_length ((char **) ids))
        return NULL;
    return g_variant_new_string (ids[selected]);
}

static void
bind_effect (CcTopBarPanel *self, const char *key_name, AdwComboRow *row)
{
    g_autoptr(GSettingsSchema) schema = NULL;
    g_autoptr(GSettingsSchemaKey) key = NULL;
    g_autoptr(GtkStringList) model = gtk_string_list_new (NULL);
    g_autoptr(GStrvBuilder) ids = g_strv_builder_new ();

    g_object_get (self->settings, "settings-schema", &schema, NULL);
    key = g_settings_schema_get_key (schema, key_name);

    for (guint i = 0; i < G_N_ELEMENTS (effects); i++) {
        g_autoptr(GVariant) value = g_variant_ref_sink (g_variant_new_string (effects[i].id));

        if (!g_settings_schema_key_range_check (key, value))
            continue;
        g_strv_builder_add (ids, effects[i].id);
        gtk_string_list_append (model, _(effects[i].name));
    }

    g_object_set_data_full (G_OBJECT (row), "effect-ids", g_strv_builder_end (ids), (GDestroyNotify) g_strfreev);
    adw_combo_row_set_model (row, G_LIST_MODEL (model));
    g_settings_bind_with_mapping (self->settings, key_name, row, "selected", BIND_FLAGS, get_effect, set_effect, row,
                                  NULL);
}

static void
reset_activated_cb (CcTopBarPanel *self)
{
    g_autoptr(GSettingsSchema) schema = NULL;
    g_auto(GStrv) keys = NULL;

    g_object_get (self->settings, "settings-schema", &schema, NULL);
    keys = g_settings_schema_list_keys (schema);
    for (guint i = 0; keys[i]; i++) {
        /* That is state of the shell */
        if (g_strcmp0 (keys[i], "hidden") != 0)
            g_settings_reset (self->settings, keys[i]);
    }

    if (self->global_menu_settings) {
        for (guint i = 0; i < G_N_ELEMENTS (global_menu_keys); i++)
            g_settings_reset (self->global_menu_settings, global_menu_keys[i]);
    }
}

static void
cc_top_bar_panel_finalize (GObject *object)
{
    CcTopBarPanel *self = CC_TOP_BAR_PANEL (object);

    g_clear_object (&self->settings);
    g_clear_object (&self->global_menu_settings);

    G_OBJECT_CLASS (cc_top_bar_panel_parent_class)->finalize (object);
}

static void
cc_top_bar_panel_class_init (CcTopBarPanelClass *klass)
{
    GObjectClass *object_class = G_OBJECT_CLASS (klass);
    GtkWidgetClass *widget_class = GTK_WIDGET_CLASS (klass);

    object_class->finalize = cc_top_bar_panel_finalize;

    gtk_widget_class_set_template_from_resource (widget_class, "/org/gnome/control-center/top-bar/cc-top-bar-panel.ui");

    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, activity_blur_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, activity_copies_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, activity_downloads_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, activity_music_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, activity_pill_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, activity_tint_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, animation_speed_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, app_icon_size_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, close_effect_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, minimize_effect_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, open_effect_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, background_opacity_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, bell_always_visible_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, folder_width_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, global_menu_group);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, height_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, menu_app_name_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, menu_bundled_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, menu_enabled_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, menu_fallback_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, menu_scan_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, menu_shortcuts_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, raise_windows_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, remember_hidden_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, show_border_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, show_hide_button_row);
    gtk_widget_class_bind_template_child (widget_class, CcTopBarPanel, stack);

    gtk_widget_class_bind_template_callback (widget_class, reset_activated_cb);
}

static void
bind_settings (CcTopBarPanel *self)
{
    g_settings_bind (self->settings, "height", self->height_row, "value", BIND_FLAGS);
    g_settings_bind (self->settings, "background-opacity", self->background_opacity_row, "value", BIND_FLAGS);
    g_settings_bind (self->settings, "show-border", self->show_border_row, "active", BIND_FLAGS);
    g_settings_bind (self->settings, "show-hide-button", self->show_hide_button_row, "active", BIND_FLAGS);
    g_settings_bind (self->settings, "remember-hidden", self->remember_hidden_row, "active", BIND_FLAGS);
    g_settings_bind (self->settings, "activity-pill", self->activity_pill_row, "active", BIND_FLAGS);
    g_settings_bind (self->settings, "activity-music", self->activity_music_row, "active", BIND_FLAGS);
    g_settings_bind (self->settings, "activity-copies", self->activity_copies_row, "active", BIND_FLAGS);
    g_settings_bind (self->settings, "activity-downloads", self->activity_downloads_row, "active", BIND_FLAGS);
    g_settings_bind (self->settings, "activity-blur", self->activity_blur_row, "value", BIND_FLAGS);
    g_settings_bind (self->settings, "activity-tint", self->activity_tint_row, "value", BIND_FLAGS);
    g_settings_bind (self->settings, "bell-always-visible", self->bell_always_visible_row, "active", BIND_FLAGS);
    g_settings_bind (self->settings, "raise-windows", self->raise_windows_row, "active", BIND_FLAGS);
    g_settings_bind (self->settings, "app-icon-size", self->app_icon_size_row, "value", BIND_FLAGS);
    g_settings_bind (self->settings, "folder-width", self->folder_width_row, "value", BIND_FLAGS);
    g_settings_bind (self->settings, "animation-speed", self->animation_speed_row, "value", BIND_FLAGS);

    bind_effect (self, "minimize-effect", self->minimize_effect_row);
    bind_effect (self, "open-effect", self->open_effect_row);
    bind_effect (self, "close-effect", self->close_effect_row);
}

static void
bind_global_menu_settings (CcTopBarPanel *self)
{
    GSettings *settings = self->global_menu_settings;

    g_settings_bind (settings, "enabled", self->menu_enabled_row, "active", BIND_FLAGS);
    g_settings_bind (settings, "hide-app-name", self->menu_app_name_row, "active",
                     BIND_FLAGS | G_SETTINGS_BIND_INVERT_BOOLEAN);
    g_settings_bind_with_mapping (settings, "shortcut-labels", self->menu_shortcuts_row, "active", BIND_FLAGS,
                                  get_shortcut_labels, set_shortcut_labels, NULL, NULL);
    g_settings_bind (settings, "shortcut-menus-enabled", self->menu_bundled_row, "active", BIND_FLAGS);
    g_settings_bind (settings, "scan-menus", self->menu_scan_row, "active", BIND_FLAGS);
    g_settings_bind (settings, "enable-fallback-menu", self->menu_fallback_row, "active", BIND_FLAGS);
}

static void
cc_top_bar_panel_init (CcTopBarPanel *self)
{
    g_resources_register (cc_top_bar_get_resource ());

    gtk_widget_init_template (GTK_WIDGET (self));

    self->settings = load_settings (TOP_BAR_SCHEMA, "animation-speed");
    if (!self->settings) {
        gtk_stack_set_visible_child_name (self->stack, "unavailable");
        return;
    }

    gtk_stack_set_visible_child_name (self->stack, "settings");
    bind_settings (self);

    self->global_menu_settings = load_settings (GLOBAL_MENU_SCHEMA, "scan-menus");
    if (self->global_menu_settings)
        bind_global_menu_settings (self);
    else
        gtk_widget_set_visible (GTK_WIDGET (self->global_menu_group), FALSE);
}
