#!/bin/sh
# Adds the Top Bar panel to an unpacked gnome-control-center source tree.
# Usage: apply.sh GNOME_CONTROL_CENTER_SOURCE
set -e
here=$(dirname "$(readlink -f "$0")")
cd "$1"
[ -f shell/cc-panel-loader.c ] || { echo "not a gnome-control-center source" >&2; exit 1; }
rm -rf panels/top-bar
cp -r "$here/top-bar" panels/

grep -q "'top-bar'" panels/meson.build ||
    sed -i "/^  'system',/a \\  'top-bar'," panels/meson.build
grep -q shell_prefix meson_options.txt ||
    echo "option('shell_prefix', type: 'string', value: '/usr', description: 'prefix of the GNOME Shell that has the top bar settings')" >> meson_options.txt
grep -q top_bar shell/cc-panel-loader.c ||
    sed -i -e '/^extern GType cc_system_panel_get_type/a extern GType cc_top_bar_panel_get_type (void);' \
           -e '/PANEL_TYPE ("system", /a \    PANEL_TYPE ("top-bar", cc_top_bar_panel_get_type, NULL),' shell/cc-panel-loader.c
grep -q '"top-bar"' shell/cc-panel-list.c ||
    sed -i '/^    "multitasking",/a \    "top-bar",' shell/cc-panel-list.c

for f in panels/meson.build meson_options.txt shell/cc-panel-loader.c shell/cc-panel-list.c; do
    grep -q 'top.bar' "$f" || [ "$f" = meson_options.txt ] || { echo "could not patch $f" >&2; exit 1; }
done
