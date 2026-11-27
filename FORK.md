# GNOME Shell 51.1 – islands fork

A **cosmetic** fork of GNOME Shell 51.1. It is based on the
`gnome-shell-performance` package sources (the performance-patched GNOME Shell
build), and only changes how the shell looks and how the overview is laid out.
It does not touch the performance patches, session handling, or anything
outside the shell's JS UI and theme.

## What changed

**Top bar**
- One floating status island on the right instead of a full-width bar:
  status icons and battery, then the clock (click for the calendar), then a bell
  button that opens the notification list in its own popup (the bell only
  appears while there are notifications, and is tinted when something is unread;
  Super+V opens it). The bar itself is transparent.
- Islands use GNOME's usual gray, slightly translucent, 32px tall in a 40px bar.
- A chevron hides the status island (and the bar stops reserving screen space);
  a small tab brings it back.
- The Activities button is removed.

**Global menu** (`js/ui/globalMenu/`, `data/global-menu/`)
- The menu bar of the focused application, at the start of the top bar. A native
  port of the [Orbit Global Menu](https://github.com/Unmade760/orbit-global-menu)
  extension 1.1.4 (GPL-3.0-or-later, which then applies to the combined work).
- Menus come from the application itself (GMenuModel or com.canonical.dbusmenu),
  else from one of 293 bundled shortcut menus, else from generic window and
  session actions. The shell reads exported menus and provides
  `com.canonical.AppMenu.Registrar` itself; there is no Python daemon.
- Applications without any of those are scanned once (`js/menuScanner/`, a low
  priority process of its own): for menus on the session bus that were never
  announced, for a menu bar visible to assistive technologies, and for Electron
  applications in the menu template inside their code, which is read but never
  run. "Scan for Menus" behind the application name does that by hand, also for
  applications with a bundled menu, and reports what it found. Results from code
  are cached in `~/.cache/gnome-shell/global-menu` until the application is
  updated. Off: `dconf write /org/gnome/shell/extensions/global-menu/scan-menus false`.
  Report for any process: `gjs -m <prefix>/share/gnome-shell/menu-scanner/main.js PID`.
- Built to cost little: mappings sit in a memory-mapped GResource and are parsed
  on first focus, exported submenus are fetched when pointed at, menu items only
  exist while their menu is open, and switching to a window with the same menu
  touches no actor.
- The extension `global-menu@unmade.space` is never run in this shell, but its
  preferences still edit the shared settings (General, Applications) and custom
  menus in `~/.config/global-menu/shortcuts/apps`. Its Appearance page has no
  effect except for hiding the app name and "never" showing shortcuts: the look
  is in `_panel.scss`.
- Turn it off with
  `dconf write /org/gnome/shell/extensions/global-menu/enabled false`.

**Activity pill** (`js/ui/notch.js`)
- Sits next to the status island and shows live activity:
  - music (MPRIS): album art with a progress ring, visualizer, and on hover
    title/artist, play/pause/skip and a progress fill in the album's accent color
  - file copies
  - browser downloads (Chrome `.crdownload` detection)
- Glass background: the wallpaper, blurred and cached (`ShellBlurEffect` gained a
  `corner-radius` for it), under a tint that darkens when the pill expands.
- A timer activity exists in the code but is disabled (`TIMER_ENABLED = false`).

**Overview**
- Launchpad-style: app grid only, no window thumbnails or workspace strip.
- Grid adapts to the screen size, smaller icons, dotted pagination instead of
  arrows, translucent background and folders.
- Pages follow the live app order, so removing an app or changing the screen
  re-flows the grid instead of using the stale saved layout.
- Folders use the icon size and cells of the main grid. The dialog is as big as
  its apps need (one row up to 5 apps, then a wide block) and only pages once it
  would outgrow the screen, instead of a fixed 720px box with a 3x3 grid.

Touched files: `js/ui/{notch,panel,sessionMode,layout,overview,overviewControls,appDisplay,iconGrid,workspacesView}.js`,
`js/js-resources.gresource.xml`, and `data/theme/gnome-shell-sass/widgets/{_panel,_app-grid,_overview}.scss`.

**Windows** (`js/ui/windowAttentionHandler.js`)
- Windows that ask for attention are raised instead of showing a "window is
  ready" notification, unless you were typing in the last ~1.2 s, in which case
  the notification is shown so focus is never stolen mid-keystroke.

**Window animations** (`js/ui/windowEffects.js`, `src/shell-lamp-effect.c`)
- Minimize/restore: Magic Lamp (default), Scale to Icon, Zoom, Glide, Slide, Fade,
  GNOME's own or none. Open and close: Zoom (default), Glide, Slide, Fade, GNOME's
  own or none; close also has Magic Lamp. A speed setting applies to all but
  GNOME's own.
- Magic Lamp pours the window into its dock icon, whichever screen edge the dock
  is at, or to the bottom center if no dock says where the icon is. The mesh is
  drawn by `ShellLampEffect`, not a `ClutterDeformEffect`, which draws nothing
  with software rendering.
- GNOME's own (fade) animations are used when reduced motion is on, and for
  minimizing fullscreen windows.

**Uninstall from the app grid** (`js/ui/appUninstall.js`)
- Right-clicking an app in the app grid or dash offers "Uninstall…", which asks
  for confirmation first.
- Flatpak apps are removed with `flatpak uninstall`; data in `~/.var/app` is
  kept. pacman apps are removed with `pkexec pacman -Rns` (asks for your
  password), after a dry run that lists which unused dependencies go too.
  Launchers in `~/.local/share/applications` are moved to the Trash.
- Refused when other packages need the app's package, when it belongs to a
  package the desktop needs (gnome-shell, mutter, gnome-control-center, gdm,
  polkit and similar), or while another pacman operation holds its lock.

**Settings** (`settings-panel/`, `js/misc/topBarSettings.js`)
- A "Top Bar" panel in the Settings app: bar height, background and hide button,
  global menu, activity pill, notifications bell, app grid icon size and folder
  width. Changes apply live (schema `org.gnome.shell.top-bar`).
- Settings has no panel plugins, so this needs a build of the
  gnome-control-center source of the installed version:
  `settings-panel/install.sh ~/Downloads/gnome-control-center-51.2.1`
  (with blueprint-compiler in PATH). It has to be repeated after Settings is
  updated; until then the wrapper in `~/.local/bin` starts the stock one.
- To go back, remove `~/.local/bin/gnome-control-center`,
  `~/.local/share/dbus-1/services/org.gnome.Settings.service` and
  `~/.local/share/applications/gnome-top-bar-panel.desktop`, or create
  `~/.config/gs-notch-settings-disable`.

## Screenshots and thanks

Screenshots are in [README.md](README.md) and `docs/screenshots/` (taken in a
headless session with stock GNOME apps and the Adwaita wallpaper). The global
menu is a port of [Orbit Global Menu](https://github.com/Unmade760/orbit-global-menu)
by Unmade760; thank you for the extension and its menu collection.

## Build and install (per-user, no root)

```bash
./install.sh --with-settings
```

builds the shell into `~/.local/gs-notch`, starts it from the next login on
through a systemd user drop-in, and adds the Top Bar panel to Settings (this
downloads the Settings source of the installed version, after asking). The
GNOME Shell of the system stays installed: a wrapper starts it instead when
the new one is missing or broken, or when `~/.config/gs-notch-disable` exists.

- After Settings was updated: `./install.sh --settings-only`
- Back to the system's shell and Settings: `./install.sh --uninstall`
  (`--purge` also deletes the install and its backups)
- Build dependencies on Arch: `sudo pacman -S --needed base-devel meson ninja sassc gjs python blueprint-compiler`,
  plus the build dependencies of the gnome-shell and gnome-control-center packages.

## Status

Tested in headless sessions (one and two virtual monitors). Real-hardware
dual-monitor behavior, real Spotify cover colors and multi-page app lists have
had little testing. Expect rough edges.
