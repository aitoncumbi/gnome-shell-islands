#!/bin/sh
# Builds this GNOME Shell and installs it for the current user, next to the
# GNOME Shell of the system, which stays untouched and is used whenever this
# one is missing or broken. Optionally also builds Settings with its Top Bar
# panel. Needs no root.
#
#   ./install.sh                  shell only
#   ./install.sh --with-settings  shell and the Top Bar panel in Settings
#   ./install.sh --settings-only  Settings only, e.g. after Settings was updated
#   ./install.sh --uninstall      go back to the GNOME Shell and Settings of the
#                                 system (add --purge to also delete the files)
#
# Options: --prefix DIR (default ~/.local/gs-notch), --settings-source DIR (an
# unpacked gnome-control-center source of the installed version, instead of
# downloading it), --build-dir DIR (default _build here), --yes (do not ask
# before downloading or building for another GNOME version).
#
# The new shell starts at the next login. To go back from a text console:
#   touch ~/.config/gs-notch-disable
set -eu

here=$(dirname "$(readlink -f "$0")")
prefix="$HOME/.local/gs-notch"
shell=yes
settings=no
uninstall=no
purge=no
settings_source=
assume_yes=no
build="$here/_build"

config="${XDG_CONFIG_HOME:-$HOME/.config}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/gs-notch"
dropin_dir="$config/systemd/user/org.gnome.Shell@.service.d"

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --prefix) prefix=$(readlink -m "$2"); shift ;;
        --with-settings) settings=yes ;;
        --settings-only) settings=yes; shell=no ;;
        --settings-source) settings_source=$(readlink -f "$2"); shift ;;
        --build-dir) build=$(readlink -m "$2"); shift ;;
        --uninstall) uninstall=yes ;;
        --purge) purge=yes ;;
        --yes|-y) assume_yes=yes ;;
        -h|--help) sed -n '2,/^set /{/^set /!p}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option $1 (see --help)" ;;
    esac
    shift
done

[ "$(id -u)" -ne 0 ] || die "run this as your own user, not as root"

need() {
    for program; do
        command -v "$program" >/dev/null 2>&1 ||
            die "$program is missing; on Arch: sudo pacman -S --needed base-devel meson ninja sassc gjs python blueprint-compiler"
    done
}

ask() {
    [ "$assume_yes" = yes ] && return 0
    printf '%s [y/N] ' "$1"
    read -r answer || return 1
    case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# ---- uninstall ------------------------------------------------------------

if [ "$uninstall" = yes ]; then
    say "Removing the session override and the Settings launcher"
    rm -f "$dropin_dir/gs-notch.conf"
    [ -f "$dropin_dir/override.conf" ] &&
        grep -q gnome-shell-session "$dropin_dir/override.conf" &&
        rm -f "$dropin_dir/override.conf"
    rmdir "$dropin_dir" 2>/dev/null || true
    if grep -q "gs-notch\|gnome-control-center\.in\|Top Bar panel" "$HOME/.local/bin/gnome-control-center" 2>/dev/null; then
        rm -f "$HOME/.local/bin/gnome-control-center"
    fi
    if grep -q "$HOME/.local/bin/gnome-control-center" "$data/dbus-1/services/org.gnome.Settings.service" 2>/dev/null; then
        rm -f "$data/dbus-1/services/org.gnome.Settings.service"
    fi
    rm -f "$data/applications/gnome-top-bar-panel.desktop" \
          "$data/icons/hicolor/scalable/apps/org.gnome.Settings-top-bar-symbolic.svg"
    systemctl --user daemon-reload 2>/dev/null || true
    busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null 2>&1 || true
    if [ "$purge" = yes ]; then
        # only a directory that this script installed into
        [ -x "$prefix/bin/gnome-shell-session" ] && [ "$prefix" != "$HOME" ] ||
            die "$prefix does not look like an install of this shell, not deleting it"
        say "Deleting $prefix and its backups"
        rm -rf "$prefix" "$prefix".bak-[0-9]*-[0-9]*
    fi
    say "Done. The GNOME Shell of the system starts at the next login."
    exit 0
fi

# ---- shell ----------------------------------------------------------------

install_shell() {
    need meson ninja sassc gjs python3 pkg-config glib-compile-schemas

    system_version=$(gnome-shell --version 2>/dev/null | awk '{print $3}')
    own_version=$(sed -n "s/^ *version: '\([0-9.]*\)'.*/\1/p" "$here/meson.build" | head -1)
    case "$system_version" in
        "${own_version%%.*}".*) ;;
        *) printf 'The system has GNOME Shell %s, this is %s, which needs mutter %s.\n' \
               "${system_version:-?}" "$own_version" "${own_version%%.*}"
           ask "Build anyway?" || exit 1 ;;
    esac

    if [ -d "$build" ] && [ "$(meson introspect "$build" --buildoptions 2>/dev/null |
            python3 -c 'import json,sys; print(next(o["value"] for o in json.load(sys.stdin) if o["name"]=="prefix"))' 2>/dev/null)" != "$prefix" ]; then
        say "Reconfiguring the build for $prefix"
        meson setup --reconfigure "$build" "$here" --prefix="$prefix"
    fi
    if [ ! -d "$build" ]; then
        say "Configuring"
        meson setup "$build" "$here" --prefix="$prefix" --buildtype=debugoptimized \
            -Dtests=false -Dextensions_tool=false -Dman=false -Dgtk_doc=false
    fi

    say "Building GNOME Shell"
    ninja -C "$build"

    if [ -d "$prefix" ]; then
        backup="$prefix.bak-$(date +%Y%m%d-%H%M%S)"
        say "Keeping the previous install in $backup"
        cp -a "$prefix" "$backup"
        # the two newest backups made here are enough
        ls -d "$prefix".bak-[0-9]*-[0-9]* 2>/dev/null | sort -r | tail -n +3 |
            while read -r old; do rm -rf "$old"; done
    fi

    say "Installing into $prefix"
    meson install -C "$build" --no-rebuild --quiet
    glib-compile-schemas "$prefix/share/glib-2.0/schemas"

    "$prefix/bin/gnome-shell" --version >/dev/null ||
        die "the installed shell does not start; nothing was switched over"

    sed "s|@PREFIX@|$prefix|" "$here/install/gnome-shell-session.in" > "$prefix/bin/gnome-shell-session"
    chmod 755 "$prefix/bin/gnome-shell-session"

    say "Starting it from the next login on"
    mkdir -p "$dropin_dir"
    # older installs called the file override.conf
    if [ -f "$dropin_dir/override.conf" ] && grep -q gnome-shell-session "$dropin_dir/override.conf"; then
        rm -f "$dropin_dir/override.conf"
    fi
    cat > "$dropin_dir/gs-notch.conf" <<EOF
# Written by $here/install.sh. Remove this file to go back to the GNOME
# Shell of the system.
[Service]
ExecStart=
ExecStart=$prefix/bin/gnome-shell-session --mode=%i
EOF
    systemctl --user daemon-reload 2>/dev/null || true
}

# ---- Settings -------------------------------------------------------------

install_settings() {
    need meson ninja curl sha256sum tar blueprint-compiler

    [ -x "$prefix/bin/gnome-shell" ] ||
        die "install the shell first: the panel reads its settings from $prefix"

    [ -x /usr/bin/gnome-control-center ] ||
        die "GNOME Settings (gnome-control-center) is not installed"
    version=$(/usr/bin/gnome-control-center --version 2>/dev/null | awk '{print $NF}')
    [ -n "$version" ] || die "GNOME Settings (gnome-control-center) is not installed"

    if [ -z "$settings_source" ]; then
        name="gnome-control-center-$version"
        settings_source="$cache/$name"
        if [ ! -f "$settings_source/shell/cc-panel-loader.c" ]; then
            major=${version%%.*}
            url="https://download.gnome.org/sources/gnome-control-center/$major/$name.tar.xz"
            printf 'Settings has no plugins, so it has to be built from its source:\n  %s\n' "$url"
            ask "Download it?" || exit 1
            mkdir -p "$cache"
            tmp=$(mktemp -d "$cache/download.XXXXXX")
            (cd "$tmp" &&
                curl -fL --proto '=https' -o "$name.tar.xz" "$url" &&
                curl -fsSL --proto '=https' -o "$name.sha256sum" "${url%.tar.xz}.sha256sum" &&
                grep " $name.tar.xz\$" "$name.sha256sum" | sha256sum -c - &&
                tar xf "$name.tar.xz") || { rm -rf "$tmp"; die "could not download $name"; }
            rm -rf "$settings_source"
            mv "$tmp/$name" "$settings_source"
            rm -rf "$tmp"
        fi
    fi

    got=$(sed -n "s/^ *version *: '\([0-9.]*\)'.*/\1/p" "$settings_source/meson.build" | head -1)
    [ "$got" = "$version" ] ||
        die "$settings_source is Settings $got, but $version is installed"

    say "Building Settings $version with the Top Bar panel"
    PREFIX="$prefix" "$here/settings-panel/install.sh" "$settings_source"
}

[ "$shell" = yes ] && install_shell
[ "$settings" = yes ] && install_settings

say "Done. Log out and back in to use it."
[ "$shell" = yes ] && printf 'If the desktop does not start, switch to a text console and run\n  touch ~/.config/gs-notch-disable\nto get the GNOME Shell of the system at the next login.\n'
exit 0
