#!/bin/sh
# Builds Settings with the Top Bar panel and installs it for this user, next to
# the shell in ~/.local/gs-notch. Everything else it needs (translations,
# helpers, ...) is used from the distribution's package of the same version.
# Usage: install.sh GNOME_CONTROL_CENTER_SOURCE
#        (blueprint-compiler has to be in PATH; PREFIX is where the shell is)
set -e
here=$(dirname "$(readlink -f "$0")")
src=$(readlink -f "$1")
prefix="${PREFIX:-$HOME/.local/gs-notch}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"

"$here/apply.sh" "$src"
# a build for another shell prefix is set up again
[ "$(cat "$src/_build/.gs-notch-prefix" 2>/dev/null)" = "$prefix" ] || rm -rf "$src/_build"
[ -d "$src/_build" ] || meson setup "$src/_build" "$src" --prefix=/usr --libexecdir=lib \
    --buildtype=release --wrap-mode=nodownload -Dtests=false -Dmalcontent=true \
    -Dshell_prefix="$prefix"
printf '%s' "$prefix" > "$src/_build/.gs-notch-prefix"
ninja -C "$src/_build" shell/gnome-control-center panels/top-bar/gnome-top-bar-panel.desktop

install -Dm755 -s "$src/_build/shell/gnome-control-center" "$prefix/bin/gnome-control-center"
mkdir -p "$HOME/.local/bin"
sed "s|@PREFIX@|$prefix|" "$here/gnome-control-center.in" > "$HOME/.local/bin/gnome-control-center"
chmod 755 "$HOME/.local/bin/gnome-control-center"
install -Dm644 "$src/_build/panels/top-bar/gnome-top-bar-panel.desktop" \
    "$data/applications/gnome-top-bar-panel.desktop"
install -Dm644 "$here/top-bar/icons/scalable/org.gnome.Settings-top-bar-symbolic.svg" \
    "$data/icons/hicolor/scalable/apps/org.gnome.Settings-top-bar-symbolic.svg"
# Settings is started over D-Bus by its launcher
mkdir -p "$data/dbus-1/services"
cat > "$data/dbus-1/services/org.gnome.Settings.service" <<EOF
[D-BUS Service]
Name=org.gnome.Settings
Exec=$HOME/.local/bin/gnome-control-center --gapplication-service
EOF
busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null
