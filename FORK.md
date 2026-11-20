# GNOME Shell 51.1 – islands fork

A **cosmetic** fork of GNOME Shell 51.1. It is based on the
`gnome-shell-performance` package sources (the performance-patched GNOME Shell
build), and only changes how the shell looks and how the overview is laid out.
It does not touch the performance patches, session handling, or anything
outside the shell's JS UI and theme.

## What changed

**Top bar**
- Two floating "islands" instead of a full-width bar: the clock on the left, the
  status area (quick settings) on the right. The bar itself is transparent.
- Islands use GNOME's usual gray, slightly translucent, 32px tall in a 40px bar.
- A chevron hides the status island (and the bar stops reserving screen space);
  a small tab brings it back.
- The Activities button is removed.

**Activity pill** (`js/ui/notch.js`)
- Sits next to the status island and shows live activity:
  - music (MPRIS): album art with a progress ring, visualizer, and on hover
    title/artist, play/pause/skip and a progress fill in the album's accent color
  - file copies
  - browser downloads (Chrome `.crdownload` detection)
- A timer activity exists in the code but is disabled (`TIMER_ENABLED = false`).

**Overview**
- Launchpad-style: app grid only, no window thumbnails or workspace strip.
- Grid adapts to the screen size, smaller icons, dotted pagination instead of
  arrows, translucent background and folders.
- Pages follow the live app order, so removing an app or changing the screen
  re-flows the grid instead of using the stale saved layout.

Touched files: `js/ui/{notch,panel,sessionMode,layout,overview,overviewControls,appDisplay,iconGrid,workspacesView}.js`,
`js/js-resources.gresource.xml`, and `data/theme/gnome-shell-sass/widgets/{_panel,_app-grid,_overview}.scss`.

**Windows** (`js/ui/windowAttentionHandler.js`)
- Windows that ask for attention are raised instead of showing a "window is
  ready" notification, unless you were typing in the last ~1.2 s, in which case
  the notification is shown so focus is never stolen mid-keystroke.

## Build and install (per-user, no root)

```bash
meson setup _build --prefix=$HOME/.local/gs-notch
ninja -C _build && meson install -C _build
```

Run it by starting a session whose `org.gnome.Shell@wayland.service` executes
`$HOME/.local/gs-notch/bin/gnome-shell`. A wrapper that falls back to
`/usr/bin/gnome-shell` when the patched binary is missing is a good idea so a
broken build never leaves you without a desktop.

## Status

Tested in headless sessions (one and two virtual monitors). Real-hardware
dual-monitor behavior, real Spotify cover colors and multi-page app lists have
had little testing. Expect rough edges.
