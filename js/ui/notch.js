import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as TopBarSettings from '../misc/topBarSettings.js';
import * as Background from './background.js';
import * as Main from './main.js';
import * as Mpris from './mpris.js';

// Sizes in logical pixels, taken from the design
const ISLAND_GAP = 10;
const EXPANDED_WIDTH = 300;
const ART_CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gs-notch', 'art']);
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
let artSession = null;
// [collapsed width, extra height when expanded] per activity
const SIZES = {
    music: [92, 120],
    copy: [104, 66],
    timer: [106, 66],
    download: [118, 66],
};
// The timer activity is switched off for now; flip this to bring back the
// timer pill, its D-Bus control and the Clocks presets menu in the panel.
export const TIMER_ENABLED = false;
const MAX_TIMER_SECONDS = 24 * 60 * 60;
const NOTCH_DBUS_PATH = '/org/gnome/Shell/Notch';
const NOTCH_DBUS_XML = `
<node>
  <interface name="org.gnome.Shell.Notch">
    <method name="StartTimer">
      <arg type="u" direction="in" name="seconds"/>
      <arg type="s" direction="in" name="label"/>
    </method>
    <method name="StopTimer"/>
  </interface>
</node>`;
const EXPANDED_RADIUS = 24;
// The glass background: the wallpaper, blurred, beneath a black tint that gets
// denser as the pill expands, so the details stay readable on any wallpaper
const GLASS_BRIGHTNESS = 0.75;
const GLASS_TINT_EXPANDED = 0.55;
const FILL_ALPHA = 0.6; // the song's progress lets the glass through
const ART_SIZE = 22;
const RING_SIZE = 22;
const OPEN_DELAY = 120;
const POINTER_SLACK = 8;
const COPY_MISSES_BEFORE_END = 3;
const SLIDE_DISTANCE = 80;
const PAUSE_GRACE_SECONDS = 120;
const EQ_BARS = 4;
const EQ_MIN = 4;
const EQ_MAX = 14;
const EQ_TICK_MS = 130;

const COPY_WATCHER = String.raw`
import os, stat, time, json, sys, glob, shutil, sqlite3, subprocess, tempfile
MIN_SIZE = 4 * 1024 * 1024
SKIP = ('/proc/', '/dev/', '/sys/', '/run/', '/memfd', '/tmp/.X11')
ME = str(os.getpid())
last_pos = {}

def scan():
    best = None
    seen = set()
    for pid in os.listdir('/proc'):
        if not pid.isdigit() or pid == ME:
            continue
        base = '/proc/%s/' % pid
        try:
            fds = os.listdir(base + 'fd')
        except OSError:
            continue
        reads, writes = [], []
        for fd in fds:
            try:
                path = os.readlink(base + 'fd/' + fd)
                if not path.startswith('/') or path.startswith(SKIP):
                    continue
                st = os.stat(base + 'fd/' + fd)
                if not stat.S_ISREG(st.st_mode):
                    continue
                with open(base + 'fdinfo/' + fd) as f:
                    info = f.read()
                pos = int(info.split('pos:')[1].split()[0])
                acc = int(info.split('flags:')[1].split()[0], 8) & 3
            except Exception:
                continue
            if acc == 0 and st.st_size >= MIN_SIZE:
                reads.append((path, pos, st.st_size))
            elif acc == 1:
                writes.append((path, pos))
        for rpath, rpos, rsize in reads:
            key = (pid, rpath)
            seen.add(key)
            prev = last_pos.get(key)
            last_pos[key] = rpos
            # a copy moves forward and its write offset tracks the read offset
            if prev is None or rpos <= prev or not (0 < rpos < rsize):
                continue
            slack = 4 * 1024 * 1024 + rpos // 10
            if any(w[0] != rpath and abs(w[1] - rpos) <= slack for w in writes):
                if best is None or rsize > best[2]:
                    best = (os.path.basename(rpath), rpos / rsize, rsize)
    for key in list(last_pos):
        if key not in seen:
            del last_pos[key]
    return best

# ---- browser downloads -------------------------------------------------
# Chrome writes "<name>.crdownload" while downloading (Firefox: ".part"). The
# file grows as data arrives; the total size comes from Chrome's History
# database (read from a copy, as the browser keeps it locked).
DL_SUFFIXES = ('.crdownload', '.part')
HOME = os.path.expanduser('~')
BROWSER_GLOBS = ('google-chrome*', 'chromium*', 'BraveSoftware/*', 'microsoft-edge*')

def download_dirs():
    dirs = []
    try:
        out = subprocess.run(['xdg-user-dir', 'DOWNLOAD'], capture_output=True,
                             text=True, timeout=2).stdout.strip()
        if out:
            dirs.append(out)
    except Exception:
        pass
    dirs.append(os.path.join(HOME, 'Downloads'))
    for pat in BROWSER_GLOBS:
        for prefs in glob.glob(os.path.join(HOME, '.config', pat, '*', 'Preferences')):
            try:
                with open(prefs) as f:
                    d = json.load(f).get('download', {}).get('default_directory')
                if d:
                    dirs.append(d)
            except Exception:
                pass
    # test hook: extra colon-separated directories
    dirs += [d for d in os.environ.get('NOTCH_EXTRA_DOWNLOAD_DIRS', '').split(':') if d]
    return sorted({d for d in dirs if os.path.isdir(d)})

def read_totals():
    totals = {}
    histories = []
    for pat in BROWSER_GLOBS:
        histories += glob.glob(os.path.join(HOME, '.config', pat, '*', 'History'))
    # test hook: extra colon-separated History files
    histories += [h for h in os.environ.get('NOTCH_EXTRA_HISTORY', '').split(':') if h]
    for hist in histories:
        tmp = tempfile.mkdtemp(prefix='notch-history-')
        try:
            shutil.copyfile(hist, tmp + '/History')
            if os.path.exists(hist + '-wal'):
                shutil.copyfile(hist + '-wal', tmp + '/History-wal')
            db = sqlite3.connect('file:%s/History?mode=ro' % tmp, uri=True)
            for path, total in db.execute(
                    'SELECT current_path, total_bytes FROM downloads WHERE state = 0'):
                if path and total and total > 0:
                    totals[path] = total
            db.close()
        except Exception:
            pass
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return totals

dl_dirs, dl_dirs_at = [], 0
dl_seen = {}
dl_totals, dl_totals_at = {}, 0

def scan_downloads(now):
    global dl_dirs, dl_dirs_at, dl_totals, dl_totals_at
    if now - dl_dirs_at > 30:
        dl_dirs, dl_dirs_at = download_dirs(), now
    best = None
    present = set()
    for d in dl_dirs:
        try:
            entries = list(os.scandir(d))
        except OSError:
            continue
        for e in entries:
            if not e.name.endswith(DL_SUFFIXES):
                continue
            try:
                st = e.stat()
            except OSError:
                continue
            present.add(e.path)
            prev = dl_seen.get(e.path)
            if prev is None:
                last = now if now - st.st_mtime < 3 else 0
            elif st.st_size > prev[0]:
                last = now
            else:
                last = prev[1]
            dl_seen[e.path] = (st.st_size, last)
            if now - last < 4 and (best is None or last > best[2]):
                best = (e.path, st.st_size, last)
    for p in list(dl_seen):
        if p not in present:
            del dl_seen[p]
    if best is None:
        return None
    path, size, _last = best
    if path not in dl_totals and now - dl_totals_at > 3:
        dl_totals, dl_totals_at = read_totals(), now
    name = os.path.basename(path)
    for suffix in DL_SUFFIXES:
        if name.endswith(suffix):
            name = name[:-len(suffix)]
    return {'name': name, 'bytes': size, 'total': dl_totals.get(path)}

# Scanning every process's file descriptors costs ~50 ms of CPU, so only do it
# when the system is actually writing (nr_dirtied counts pages dirtied by any
# filesystem, including FUSE/network ones), while a copy is known, and once in
# a while as a backstop for very slow copies.
def dirtied():
    try:
        with open('/proc/vmstat') as f:
            for line in f:
                if line.startswith('nr_dirtied '):
                    return int(line.split()[1])
    except Exception:
        pass
    return None

WRITE_PAGES = 128      # ~0.5 MB dirtied since the last check counts as activity
BUSY_FOR = 8           # keep scanning this long after the last activity
BACKSTOP = 15
IDLE_LINES = 6         # idle lines the shell needs to see before we go quiet
PARENT = os.getppid()
last_dirt = dirtied()
busy_until = 0
last_scan = 0
b = None
idle_sent = 0
while True:
    # Quiet when idle means no broken-pipe error to end us: leave on our own
    # when the shell that started us is gone
    if os.getppid() != PARENT:
        sys.exit(0)
    now = time.time()
    d = dirtied()
    if d is None or last_dirt is None or d - last_dirt >= WRITE_PAGES:
        busy_until = now + BUSY_FOR
    last_dirt = d
    if b is not None or now < busy_until or now - last_scan >= BACKSTOP:
        try:
            b = scan()
        except Exception:
            b = None
        last_scan = now
    try:
        dl = scan_downloads(now)
    except Exception:
        dl = None
    if b is None and dl is None:
        idle_sent += 1
        if idle_sent > IDLE_LINES:
            time.sleep(1)
            continue
    else:
        idle_sent = 0
    print(json.dumps({
        'copy': {'name': b[0], 'pct': b[1]} if b else None,
        'download': dl,
    }))
    sys.stdout.flush()
    time.sleep(1)
`;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = v => Math.min(Math.max(v, 0), 1);

// 4:32 -> "04:32", 1h05 -> "1:05:00"
function formatClock(seconds) {
    seconds = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const sec = seconds % 60;
    const mm = m.toString().padStart(2, '0');
    const ss = sec.toString().padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Human readable duration for menus: "45 s", "30 min", "1 h 30 min"
export function formatDuration(seconds) {
    if (seconds < 60)
        return _('%d s').format(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (h === 0)
        return _('%d min').format(m);
    return m === 0 ? _('%d h').format(h) : _('%d h %d min').format(h, m);
}

// The timers saved in GNOME Clocks (org.gnome.clocks "timers"): used as presets
export function getClocksTimerPresets() {
    try {
        const source = Gio.SettingsSchemaSource.get_default();
        if (!source?.lookup('org.gnome.clocks', true))
            return [];

        const settings = new Gio.Settings({schema_id: 'org.gnome.clocks'});
        const unpack = v => v instanceof GLib.Variant ? v.deepUnpack() : v;
        return settings.get_value('timers').deepUnpack()
            .map(t => ({
                seconds: Number(unpack(t.duration)),
                name: String(unpack(t.name) ?? ''),
            }))
            .filter(t => t.seconds > 0 && t.seconds <= MAX_TIMER_SECONDS);
    } catch (e) {
        log(`Notch: could not read GNOME Clocks timers: ${e.message}`);
        return [];
    }
}

// Short size for the collapsed pill: "28 MB", "1.2 GB"
function formatShortSize(bytes) {
    if (bytes >= 1e9)
        return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6)
        return `${Math.round(bytes / 1e6)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function formatTime(us) {
    const total = Math.max(0, Math.round(us / 1e6));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---- accent color from the album art -----------------------------------
//
// The progress fill sits behind white text, so it has to stay dark enough for
// that text to remain readable: the fill is pushed to a relative luminance
// where white has well over 4.5:1 contrast (WCAG AA), while still being
// clearly lighter than the black pill. A lighter tint of the same hue is
// derived for the thin bar and the visualizer, which sit on dark colors.

const FILL_LUMINANCE = 0.075;  // white on it: about 8:1
const TINT_LUMINANCE = 0.50;
const DEFAULT_ACCENT = [90, 169, 255];

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
    if (s === 0) {
        const v = Math.round(l * 255);
        return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = t => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map(v => Math.round(v * 255));
}

function relativeLuminance([r, g, b]) {
    const lin = v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Same hue and saturation, lightness searched until the luminance matches
function withLuminance(h, s, target) {
    let lo = 0.02;
    let hi = 0.95;
    for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (relativeLuminance(hslToRgb(h, s, mid)) < target)
            lo = mid;
        else
            hi = mid;
    }
    return hslToRgb(h, s, (lo + hi) / 2);
}

// Dominant vivid hue of an image file -> {fill, tint} as [r, g, b]
function accentFromFile(path) {
    try {
        return accentFromPixbuf(GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 32, 32, false));
    } catch (e) {
        log(`Notch: could not read the album art colors: ${e.message}`);
        return null;
    }
}

function accentFromPixbuf(pixbuf) {
    try {
        const pixels = pixbuf.get_pixels();
        const channels = pixbuf.get_n_channels();
        const stride = pixbuf.get_rowstride();
        const bins = Array.from({length: 12}, () => ({w: 0, r: 0, g: 0, b: 0}));

        for (let y = 0; y < pixbuf.get_height(); y++) {
            for (let x = 0; x < pixbuf.get_width(); x++) {
                const i = y * stride + x * channels;
                const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
                const [h, s, l] = rgbToHsl(r, g, b);
                if (s < 0.2 || l < 0.12 || l > 0.92)
                    continue;      // grey, near-black or near-white
                const weight = s * (1 - Math.abs(l - 0.5));
                const bin = bins[Math.min(11, Math.floor(h * 12))];
                bin.w += weight;
                bin.r += r * weight;
                bin.g += g * weight;
                bin.b += b * weight;
            }
        }

        const best = bins.reduce((a, b) => b.w > a.w ? b : a);
        let h, s;
        if (best.w < 0.5) {
            // Mostly grey artwork: a calm neutral blue-grey accent
            [h, s] = [0.6, 0.18];
        } else {
            [h, s] = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
            s = Math.min(0.85, Math.max(0.4, s));
        }
        return {
            fill: withLuminance(h, s, FILL_LUMINANCE),
            tint: withLuminance(h, Math.min(0.9, s + 0.1), TINT_LUMINANCE),
        };
    } catch (e) {
        log(`Notch: could not read the album art colors: ${e.message}`);
        return null;
    }
}

function defaultAccent() {
    const [h, s] = rgbToHsl(...DEFAULT_ACCENT);
    return {
        fill: withLuminance(h, 0.5, FILL_LUMINANCE),
        tint: DEFAULT_ACCENT,
    };
}

const cssColor = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;

// A thin horizontal progress bar
const ProgressBar = GObject.registerClass(
class ProgressBar extends St.Widget {
    _init() {
        super._init({
            style_class: 'notch-bar',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        this._fraction = 0;
        this._fill = new St.Widget({
            style_class: 'notch-bar-fill',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._fill);
        this.connect('notify::allocation', () => this._sync());
    }

    set fraction(value) {
        this._fraction = clamp01(value);
        this._sync();
    }

    setColor(css) {
        this._fill.style = css ? `background-color: ${css};` : '';
    }

    _sync() {
        // width is only the requested size (-1 if unset): use the allocation
        const box = this.get_allocation_box();
        const width = Math.max(0, box.x2 - box.x1);
        this._fill.width = Math.max(0, Math.round(width * this._fraction));
    }
});

// A circular progress ring (the file-copy glyph)
const ProgressRing = GObject.registerClass(
class ProgressRing extends St.DrawingArea {
    _init() {
        super._init({
            width: RING_SIZE,
            height: RING_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fraction = 0;
        this._spinning = false;
        this._spinId = 0;
    }

    set fraction(value) {
        value = clamp01(value);
        if (value === this._fraction)
            return;
        this._fraction = value;
        this.queue_repaint();
    }

    // Unknown progress: a quarter arc that keeps turning
    set spinning(spinning) {
        if (spinning === this._spinning)
            return;
        this._spinning = spinning;

        if (spinning && !this._spinId) {
            this._spinId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 70, () => {
                if (!this._spinning || !this.mapped) {
                    this._spinId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this.queue_repaint();
                return GLib.SOURCE_CONTINUE;
            });
            GLib.Source.set_name_by_id(this._spinId, '[gnome-shell] notch ring spinner');
        }
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const radius = Math.min(w, h) / 2 - 1.5;
        const start = -Math.PI / 2;

        cr.setLineWidth(3);
        cr.setLineCap(1); // round

        cr.setSourceRGBA(1, 1, 1, 0.22);
        cr.arc(w / 2, h / 2, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._spinning) {
            const turn = (GLib.get_monotonic_time() / 1e6) * 2 * Math.PI * 1.2;
            cr.setSourceRGBA(0.353, 0.663, 1, 1);
            cr.arc(w / 2, h / 2, radius, turn, turn + Math.PI / 2);
            cr.stroke();
        } else if (this._fraction > 0) {
            cr.setSourceRGBA(0.353, 0.663, 1, 1); // #5aa9ff
            cr.arc(w / 2, h / 2, radius, start, start + 2 * Math.PI * this._fraction);
            cr.stroke();
        }
        cr.$dispose();
    }
});

// The elapsed-time fill of the music pill. It spans the whole pill and paints
// a plain rectangle, clipped to the pill's rounded outline (like overflow:
// hidden), so it never pokes out of the rounded ends.
const FillArea = GObject.registerClass(
class FillArea extends St.DrawingArea {
    _init() {
        super._init({
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this._color = [0, 0, 0];
        this._radius = 0;
        this._fraction = 0;
    }

    setColor(rgb) {
        this._color = rgb;
        this.queue_repaint();
    }

    setRadius(radius) {
        if (radius === this._radius)
            return;
        this._radius = radius;
        this.queue_repaint();
    }

    set fraction(value) {
        value = clamp01(value);
        if (value === this._fraction)
            return;
        this._fraction = value;
        // A repaint is a cairo draw plus a texture upload: skip it unless the
        // filled width actually moved by a pixel
        if (Math.round(this.width * value) === this._paintedPx)
            return;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        this._paintedPx = Math.round(this.width * this._fraction);
        const r = Math.max(0, Math.min(this._radius, w / 2, h / 2));
        const [red, green, blue] = this._color;

        // the pill's outline
        cr.newPath();
        cr.moveTo(r, 0);
        cr.lineTo(w - r, 0);
        cr.arc(w - r, r, r, -Math.PI / 2, 0);
        cr.lineTo(w, h - r);
        cr.arc(w - r, h - r, r, 0, Math.PI / 2);
        cr.lineTo(r, h);
        cr.arc(r, h - r, r, Math.PI / 2, Math.PI);
        cr.lineTo(0, r);
        cr.arc(r, r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
        cr.clip();

        // the elapsed part
        cr.setSourceRGBA(red / 255, green / 255, blue / 255, FILL_ALPHA);
        cr.rectangle(0, 0, w * this._fraction, h);
        cr.fill();
        cr.$dispose();
    }
});

// The activity pill: sits just left of the status island at the top right.
// It is hidden while nothing is going on, shows a compact live activity
// (music playing, file copy in progress) and expands on hover for details.
export const NotchIsland = GObject.registerClass(
class NotchIsland extends St.Widget {
    _init(panel) {
        super._init({
            name: 'panelNotchBg',
            clip_to_allocation: true,
            reactive: false,
            opacity: 0,
            layout_manager: new Clutter.BinLayout(),
        });

        this._panel = panel;
        this._expanded = false;
        this._player = null;
        this._activity = null;
        this._copy = null;
        this._copyMisses = 0;
        this._copySamples = [];
        this._timer = null;
        this._timerId = 0;
        this._accent = defaultAccent();
        this._progressFraction = 0;
        this._pausedGrace = false;
        this._graceId = 0;
        this._lastStatus = null;
        this._download = null;
        this._fileDownload = null;
        this._downloadMisses = 0;
        this._downloadSamples = [];
        this._launcherEntries = new Map();
        this._fromW = this._toW = SIZES.music[0];
        this._fromH = this._toH = SIZES.music[1];
        this._hidden = false;
        this._showMusic = this._showCopies = this._showDownloads = true;
        this._glassBlur = this._glassTint = 0;
        this._eqRunning = false;
        this._eqTimer = 0;
        this._pollId = 0;
        this._hoverPollId = 0;
        this._positionId = 0;
        this._cancellable = new Gio.Cancellable();

        // hover expansion, presence of an activity, music(0) -> copy(1) size
        const makeAdjustment = () => {
            const adj = new St.Adjustment({
                actor: this, lower: -1, upper: 2, value: 0, step_increment: 0.01,
            });
            adj.connect('notify::value', () => this._applyGeometry());
            return adj;
        };
        this._expand = makeAdjustment();
        this._presence = makeAdjustment();
        this._kind = makeAdjustment();
        this._slide = makeAdjustment();

        // elapsed fraction of the song, eased between the once-a-second polls
        this._fillAdj = new St.Adjustment({
            actor: this, lower: 0, upper: 1, value: 0, step_increment: 0.01,
        });
        this._fillAdj.connect('notify::value', () => {
            this._fill.fraction = this._fillAdj.value;
        });

        this._buildUi();

        Main.layoutManager.addChrome(this, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        // Beneath the panel, which is transparent around the islands
        Main.layoutManager.uiGroup.set_child_below_sibling(
            this, Main.layoutManager.panelBox);

        panel._rightBox.connectObject(
            'notify::allocation', () => this._applyGeometry(), this);
        panel.connectObject('notify::hover', () => this._onPanelHover(), this);
        Main.sessionMode.connectObject('updated', () => this._applyGeometry(), this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            if (this._bgManager)
                this._createWallpaper();
        }, this);

        this._mpris = new Mpris.MprisSource();
        this._mpris.connectObject(
            'player-added', () => this._pickPlayer(),
            'player-removed', () => this._pickPlayer(),
            this);
        this._pickPlayer();
        this._watchLauncherEntries();
        this._exportDBus();
        this._syncGlass();
        this._syncActivities();
        TopBarSettings.watch(['activity-blur', 'activity-tint'],
            () => this._syncGlass(), this);
        TopBarSettings.watch(
            ['activity-pill', 'activity-music', 'activity-copies', 'activity-downloads'],
            () => this._syncActivities(), this);
    }

    // ---- settings ------------------------------------------------------

    _syncGlass() {
        this._glassBlur = TopBarSettings.get('activity-blur');
        this._glassTint = TopBarSettings.get('activity-tint') / 100;
        this._applyGeometry();
    }

    _syncActivities() {
        const pill = TopBarSettings.get('activity-pill');
        this._showMusic = pill && TopBarSettings.get('activity-music');
        this._showCopies = pill && TopBarSettings.get('activity-copies');
        this._showDownloads = pill && TopBarSettings.get('activity-downloads');

        // Nothing to watch the disk for while neither is shown
        if (this._showCopies || this._showDownloads)
            this._startCopyWatcher();
        else
            this._stopCopyWatcher();

        this._updateActivity();
    }

    // ---- UI ------------------------------------------------------------

    // Glass: our own copy of the wallpaper actor, lined up with the real one
    // and blurred. The blur is cached, so unlike a live backdrop blur it is
    // only redone while the pill moves or the wallpaper changes, and partial
    // redraws of the pill can't leak its own content into it.
    _buildGlass() {
        this._blur = new Shell.BlurEffect({
            name: 'notch-blur',
            brightness: GLASS_BRIGHTNESS,
        });
        this._glass = new St.Widget({
            clip_to_allocation: true,
            effect: this._blur,
        });
        this._wallpaper = new St.Widget();
        this._glass.add_child(this._wallpaper);
        this.add_child(this._glass);

        this._tint = new St.Widget({
            style_class: 'notch-tint',
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._tint);
    }

    // Created with the first activity, and again when the monitors change
    _createWallpaper() {
        this._bgManager?.destroy();
        this._bgManager = null;

        const monitorIndex = Main.layoutManager.primaryIndex;
        if (monitorIndex < 0)
            return;

        this._bgManager = new Background.BackgroundManager({
            container: this._wallpaper,
            monitorIndex,
            controlPosition: false,
        });
        this._applyGeometry();
    }

    _buildUi() {
        this._buildGlass();

        // Elapsed-time fill (music): the accent color, painted beneath the
        // content, clipped to the pill's rounded shape
        this._fill = new FillArea();
        this.add_child(this._fill);

        // Top row: always visible, one child per activity kind
        this._top = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        this.add_child(this._top);

        this._musicRow = new St.BoxLayout({
            style_class: 'notch-activity',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        this._top.add_child(this._musicRow);

        this._art = new St.Widget({
            style_class: 'notch-art',
            width: ART_SIZE,
            height: ART_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._musicRow.add_child(this._art);

        // Title and artist live in the expanded view; the compact pill is just
        // the art on the left and the visualizer on the right
        this._musicRow.add_child(new St.Widget({x_expand: true}));

        this._eq = new St.BoxLayout({
            style_class: 'notch-eq',
            y_align: Clutter.ActorAlign.CENTER,
            height: EQ_MAX,
        });
        this._eqBars = [];
        for (let i = 0; i < EQ_BARS; i++) {
            // Fixed-size bar scaled from its bottom edge: scaling is a pure
            // transform, so the animation never triggers a relayout
            const bar = new St.Widget({
                style_class: 'notch-eq-bar',
                y_align: Clutter.ActorAlign.END,
                height: EQ_MAX,
                pivot_point: new Graphene.Point({x: 0.5, y: 1}),
                scale_y: EQ_MIN / EQ_MAX,
            });
            this._eqBars.push(bar);
            this._eq.add_child(bar);
        }
        this._musicRow.add_child(this._eq);

        this._copyRow = new St.BoxLayout({
            style_class: 'notch-activity',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        this._top.add_child(this._copyRow);

        this._ring = new ProgressRing();
        this._copyRow.add_child(this._ring);
        this._percent = new St.Label({
            style_class: 'notch-percent',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._copyRow.add_child(this._percent);

        this._timerRow = new St.BoxLayout({
            style_class: 'notch-activity',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        this._top.add_child(this._timerRow);

        this._timerRow.add_child(new St.Icon({
            icon_name: 'alarm-symbolic',
            style_class: 'notch-timer-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._timerTime = new St.Label({
            style_class: 'notch-percent',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timerRow.add_child(this._timerTime);

        // Details revealed on hover
        this._more = new St.BoxLayout({
            style_class: 'notch-more',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this.add_child(this._more);

        // Pushes the details below the top row. A spacer rather than a margin:
        // the stylesheet resets actor margins whenever the pill is restyled.
        this._moreSpacer = new St.Widget();
        this._more.add_child(this._moreSpacer);

        this._moreTitle = new St.Label({style_class: 'notch-more-title'});
        this._moreSub = new St.Label({style_class: 'notch-more-sub'});
        this._bar = new ProgressBar();
        this._times = new St.BoxLayout();
        this._timeNow = new St.Label({style_class: 'notch-times', x_expand: true});
        this._timeTotal = new St.Label({style_class: 'notch-times'});
        this._times.add_child(this._timeNow);
        this._times.add_child(this._timeTotal);
        this._more.add_child(this._moreTitle);
        this._more.add_child(this._moreSub);
        this._more.add_child(this._bar);
        this._more.add_child(this._times);

        // Transport controls (music only)
        this._controls = new St.BoxLayout({
            style_class: 'notch-controls',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        const mkButton = (styleClass, iconName, label, callback) => {
            const button = new St.Button({
                style_class: styleClass,
                can_focus: true,
                accessible_name: label,
                child: new St.Icon({icon_name: iconName}),
            });
            button.connect('clicked', callback);
            this._controls.add_child(button);
            return button;
        };
        this._prevButton = mkButton('notch-sk', 'media-skip-backward-symbolic',
            _('Previous track'), () => this._player?.previous());
        this._playButton = mkButton('notch-pp', 'media-playback-pause-symbolic',
            _('Pause'), () => this._player?.playPause());
        this._nextButton = mkButton('notch-sk', 'media-skip-forward-symbolic',
            _('Next track'), () => this._player?.next());
        this._more.add_child(this._controls);
    }

    // ---- activities ----------------------------------------------------

    _updateActivity() {
        // A running file copy takes priority over music
        // A file copy comes first, then a download, then a timer, then music
        const next = this._copy && this._showCopies
            ? 'copy'
            : this._download && this._showDownloads
                ? 'download'
                : this._timer
                    ? 'timer'
                    : this._musicShown() ? 'music' : null;

        if (next === 'copy')
            this._renderCopy();
        else if (next === 'download')
            this._renderDownload();
        else if (next === 'timer')
            this._renderTimer();

        if (next === this._activity)
            return;

        const previous = this._activity;
        this._activity = next;

        if (next) {
            if (!this._bgManager)
                this._createWallpaper();
            this._musicRow.visible = next === 'music';
            this._copyRow.visible = next === 'copy' || next === 'download';
            this._timerRow.visible = next === 'timer';
            this._moreTitle.visible = true;
            this._moreSub.visible = true;
            this._times.visible = next === 'music';
            this._controls.visible = next === 'music';
            this._fill.visible = next === 'music';
            if (next === 'music')
                this.add_style_class_name('notch-music');
            else
                this.remove_style_class_name('notch-music');
            this._applyAccent();

            this._retarget(next, previous !== null);

            if (next === 'music')
                this._renderMusic();
        }

        this._presence.ease(next ? 1 : 0, {
            duration: 350,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            onComplete: () => {
                if (!this._activity) {
                    this._musicRow.visible = false;
                    this._copyRow.visible = false;
                    this._timerRow.visible = false;
                    this._more.visible = false;
                    this._fill.visible = false;
                    this.remove_style_class_name('notch-music');
                    this._applyAccent();
                }
            },
        });

        if (!next)
            this._collapse();

        if (next === 'music') {
            this._startPositionPoll();
            this._syncEq();
        } else {
            this._stopPositionPoll();
            this._stopEq();
        }
    }

    // Animate the pill's collapsed size from the current activity to the next
    _retarget(type, animate) {
        const [w, h] = SIZES[type];
        if (animate) {
            const k = clamp01(this._kind.value);
            this._fromW = lerp(this._fromW, this._toW, k);
            this._fromH = lerp(this._fromH, this._toH, k);
            this._toW = w;
            this._toH = h;
            this._kind.value = 0;
            this._kind.ease(1, {
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            });
        } else {
            this._fromW = this._toW = w;
            this._fromH = this._toH = h;
            this._kind.value = 1;
        }
    }

    // ---- downloads ---------------------------------------------------------
    //
    // Chrome (and other apps using the Unity launcher API) report download
    // progress with the com.canonical.Unity.LauncherEntry "Update" signal:
    // (app_uri, {progress, progress-visible, count, count-visible, ...}).
    // Updates only carry the properties that changed, so they are merged.

    _watchLauncherEntries() {
        const bus = Gio.DBus.session;
        this._launcherSub = bus.signal_subscribe(
            null, 'com.canonical.Unity.LauncherEntry', 'Update', null, null,
            Gio.DBusSignalFlags.NONE,
            (connection, sender, path, iface, signal, params) =>
                this._onLauncherUpdate(sender, params));

        // Forget an app's progress when it leaves the bus (crash, quit)
        this._ownerSub = bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            null, null, Gio.DBusSignalFlags.NONE,
            (connection, sender, path, iface, signal, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (newOwner !== '')
                    return;
                let changed = false;
                for (const [uri, entry] of this._launcherEntries) {
                    if (entry.sender === name) {
                        this._launcherEntries.delete(uri);
                        changed = true;
                    }
                }
                if (changed)
                    this._refreshDownload();
            });
    }

    _onLauncherUpdate(sender, params) {
        let uri, props;
        try {
            [uri, props] = params.deepUnpack();
        } catch (e) {
            return;
        }

        const unpack = v => v instanceof GLib.Variant ? v.deepUnpack() : v;
        const entry = this._launcherEntries.get(uri) ??
            {sender, progress: 0, visible: false, count: 0};
        entry.sender = sender;
        if ('progress' in props)
            entry.progress = clamp01(Number(unpack(props.progress)));
        if ('progress-visible' in props)
            entry.visible = !!unpack(props['progress-visible']);
        if ('count' in props)
            entry.count = Number(unpack(props.count));
        this._launcherEntries.set(uri, entry);

        this._refreshDownload();
    }

    // A browser download (growing file) wins over an app-reported one
    _refreshDownload() {
        if (this._fileDownload) {
            const {name, bytes, total} = this._fileDownload;
            this._download = {
                name,
                bytes,
                total,
                progress: total > 0 ? clamp01(bytes / total) : null,
                app: null,
                count: 1,
            };
        } else {
            let found = null;
            for (const [uri, entry] of this._launcherEntries) {
                if (entry.visible) {
                    found = {
                        name: null,
                        bytes: 0,
                        total: 0,
                        progress: entry.progress,
                        app: this._appName(uri),
                        count: entry.count,
                    };
                    break;
                }
            }
            this._download = found;
        }
        this._updateActivity();
    }

    _appName(uri) {
        const id = uri.replace(/^application:\/\//, '');
        return Gio.DesktopAppInfo.new(id)?.get_name() ?? id.replace(/\.desktop$/, '');
    }

    _downloadEta() {
        const samples = this._downloadSamples;
        const total = this._download.total;
        if (samples.length < 2 || !(total > 0))
            return null;
        const first = samples[0];
        const last = samples[samples.length - 1];
        const rate = (last.bytes - first.bytes) / (last.t - first.t);
        if (!(rate > 0))
            return null;
        const seconds = Math.ceil((total - last.bytes) / rate);
        return seconds < 60
            ? _('%d s left').format(seconds)
            : _('%d min left').format(Math.ceil(seconds / 60));
    }

    _downloadSpeed() {
        const samples = this._downloadSamples;
        if (samples.length < 2)
            return null;
        const first = samples[0];
        const last = samples[samples.length - 1];
        const rate = (last.bytes - first.bytes) / (last.t - first.t);
        return rate > 0 ? `${GLib.format_size(rate)}/s` : null;
    }

    _renderDownload() {
        const d = this._download;
        const known = d.progress !== null;

        // Browsers keep a placeholder name until the file name is confirmed
        const name = d.name && !/^Unconfirmed \d+$/.test(d.name) ? d.name : null;

        // Total size unknown: a spinning ring, the size so far and the speed
        this._ring.spinning = !known;
        if (known)
            this._ring.fraction = d.progress;
        this._percent.text = known
            ? `${Math.round(d.progress * 100)}%`
            : formatShortSize(d.bytes);
        this._bar.visible = known;
        if (known)
            this._bar.fraction = d.progress;

        this._moreTitle.text = _('Downloading');
        const what = name ?? (d.app
            ? (d.count > 1 ? _('%s · %d files').format(d.app, d.count) : d.app)
            : _('File'));
        const detail = known
            ? this._downloadEta()
            : [GLib.format_size(d.bytes), this._downloadSpeed()].filter(x => x).join(' · ');
        this._moreSub.text = detail ? `${what} · ${detail}` : what;
    }

    // ---- timer -----------------------------------------------------------

    _exportDBus() {
        if (!TIMER_ENABLED)
            return;
        try {
            this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(NOTCH_DBUS_XML, this);
            this._dbusImpl.export(Gio.DBus.session, NOTCH_DBUS_PATH);
        } catch (e) {
            log(`Notch: could not export ${NOTCH_DBUS_PATH}: ${e.message}`);
        }
    }

    get timerRunning() {
        return !!this._timer;
    }

    // D-Bus: org.gnome.Shell.Notch.StartTimer(seconds, label)
    StartTimer(seconds, label) {
        if (!TIMER_ENABLED)
            return;
        seconds = Math.min(Math.floor(seconds), MAX_TIMER_SECONDS);
        if (!(seconds > 0))
            return;

        this._stopTimerTick();
        this._timer = {
            total: seconds,
            end: GLib.get_monotonic_time() + seconds * 1e6,
            label: label || _('Timer'),
        };
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._onTimerTick();
            return this._timerId ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._timerId, '[gnome-shell] notch timer tick');
        this._updateActivity();
    }

    // D-Bus: org.gnome.Shell.Notch.StopTimer()
    StopTimer() {
        this._stopTimerTick();
        this._timer = null;
        this._updateActivity();
    }

    _stopTimerTick() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _timerRemaining() {
        return Math.max(0, (this._timer.end - GLib.get_monotonic_time()) / 1e6);
    }

    _onTimerTick() {
        if (!this._timer)
            return;

        if (this._timerRemaining() <= 0) {
            const {label} = this._timer;
            this._stopTimerTick();
            this._timer = null;
            Main.notify(_('Timer finished'), label);
            this._updateActivity();
            return;
        }
        this._renderTimer();
    }

    _renderTimer() {
        if (!this._timer)
            return;
        this._bar.visible = true;
        const remaining = this._timerRemaining();
        this._timerTime.text = formatClock(remaining);
        this._moreTitle.text = this._timer.label;
        this._moreSub.text = _('Remaining of %s').format(formatClock(this._timer.total));
        this._bar.fraction = 1 - remaining / this._timer.total;
    }

    _renderMusic() {
        const player = this._player;
        if (!player)
            return;
        this._bar.visible = true;

        this._moreTitle.text = player.trackTitle;
        this._moreSub.text = player.trackArtists.join(', ');

        const playing = player.status === 'Playing';
        this._playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._playButton.accessible_name = playing ? _('Pause') : _('Play');
        this._prevButton.reactive = player.canGoPrevious;
        this._prevButton.opacity = player.canGoPrevious ? 255 : 90;
        this._nextButton.reactive = player.canGoNext;
        this._nextButton.opacity = player.canGoNext ? 255 : 90;

        this._setArt(player.trackCoverUrl);
    }

    // Local covers are used directly; web covers (Spotify, YouTube Music...)
    // are downloaded once into the user cache.
    _setArt(url) {
        url ||= '';
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        this._art.style = '';

        if (url.startsWith('file://')) {
            this._art.style = `background-image: url("${url}");`;
            this._setAccentFromFile(Gio.File.new_for_uri(url).get_path());
            return;
        }
        if (!/^https?:\/\//.test(url))
            return;

        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
        const path = GLib.build_filenamev([ART_CACHE_DIR, hash]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this._art.style = `background-image: url("file://${path}");`;
            this._setAccentFromFile(path);
            return;
        }
        this._fetchArt(url, path).catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                log(`Notch: could not fetch album art: ${e.message}`);
        });
    }

    async _fetchArt(url, path) {
        artSession ??= new Soup.Session({timeout: 10});
        const message = Soup.Message.new('GET', url);
        if (!message)
            return;

        const bytes = await artSession.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (message.get_status() !== Soup.Status.OK)
            return;

        GLib.mkdir_with_parents(ART_CACHE_DIR, 0o755);
        Gio.File.new_for_path(path).replace_contents(
            bytes.get_data(), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        // Ignore the result if the track changed while downloading
        if (this._artUrl === url) {
            this._art.style = `background-image: url("file://${path}");`;
            this._setAccentFromFile(path);
        }
    }

    // ---- progress fill ----------------------------------------------------

    _setAccentFromFile(path) {
        this._accent = (path && accentFromFile(path)) || defaultAccent();
        this._applyAccent();
    }

    // Colors the fill, the thin bar and the visualizer (music only)
    _applyAccent() {
        const music = this._activity === 'music';
        const tint = music ? cssColor(this._accent.tint) : null;

        this._bar.setColor(tint);
        for (const bar of this._eqBars)
            bar.style = tint ? `background-color: ${tint};` : '';

        this._fill.setColor(this._accent.fill);
    }

    _setProgress(fraction) {
        fraction = clamp01(fraction);
        this._progressFraction = fraction;
        this._bar.fraction = fraction;

        // The position arrives once a second. Gliding between samples meant a
        // full cairo repaint of the pill on every frame (~60/s), so just step.
        this._fillAdj.remove_transition('value');
        this._fillAdj.value = fraction;
    }

    _renderCopy() {
        const pct = this._copy.pct;
        this._ring.spinning = false;
        this._bar.visible = true;
        this._ring.fraction = pct;
        this._percent.text = `${Math.round(pct * 100)}%`;
        this._moreTitle.text = _('Copying %s').format(this._copy.name);
        this._moreSub.text = this._copyEta();
        this._bar.fraction = pct;
    }

    _copyEta() {
        const samples = this._copySamples;
        if (samples.length < 2)
            return _('Calculating…');
        const first = samples[0];
        const last = samples[samples.length - 1];
        const rate = (last.pct - first.pct) / (last.t - first.t);
        if (!(rate > 0))
            return _('Calculating…');
        const seconds = Math.ceil((1 - last.pct) / rate);
        if (seconds < 60)
            return _('%d s left').format(seconds);
        return _('%d min left').format(Math.ceil(seconds / 60));
    }

    // Equalizer bars next to the track. A slow timer jumps the bars to new
    // heights (~8 redraws a second); easing them at the frame rate kept the
    // whole panel redrawing 60 times a second for as long as music played.
    _startEq() {
        if (this._eqTimer)
            return;
        this._eqRunning = true;
        this._eqTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EQ_TICK_MS, () => {
            if (!this._eqRunning) {
                this._eqTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            // nothing to draw while the pill is hidden
            if (this._eq.mapped) {
                for (const bar of this._eqBars) {
                    if (Math.random() < 0.6)
                        bar.scale_y = (EQ_MIN + Math.random() * (EQ_MAX - EQ_MIN)) / EQ_MAX;
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._eqTimer, '[gnome-shell] notch equalizer');
    }

    _stopEq() {
        this._eqRunning = false;
        if (this._eqTimer) {
            GLib.source_remove(this._eqTimer);
            this._eqTimer = 0;
        }
        this._eqBars.forEach(bar => {
            bar.scale_y = EQ_MIN / EQ_MAX;
        });
    }

    // ---- music position -------------------------------------------------

    _startPositionPoll() {
        if (this._positionId)
            return;
        this._pollPosition();
        this._positionId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._pollPosition();
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._positionId, '[gnome-shell] notch position poll');
    }

    _stopPositionPoll() {
        if (!this._positionId)
            return;
        GLib.source_remove(this._positionId);
        this._positionId = 0;
    }

    _pollPosition() {
        const player = this._player;
        if (!player?._busName)
            return;

        const lengthVariant = player._playerProxy?.Metadata?.['mpris:length'];
        const length = Number(lengthVariant?.deepUnpack() ?? 0);

        Gio.DBus.session.call(
            player._busName, '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, 500, this._cancellable,
            (connection, res) => {
                try {
                    const [value] = connection.call_finish(res).deepUnpack();
                    const position = Number(value.deepUnpack());
                    this._setProgress(length > 0 ? position / length : 0);
                    this._timeNow.text = formatTime(position);
                    this._timeTotal.text = length > 0 ? formatTime(length) : '';
                } catch (e) {
                    // The player may not implement Position
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        this._setProgress(0);
                        this._timeNow.text = '';
                        this._timeTotal.text = '';
                    }
                }
            });
    }

    // ---- file copy watcher ------------------------------------------------

    _startCopyWatcher() {
        if (this._copyProc)
            return;

        try {
            this._copyProc = Gio.Subprocess.new(
                ['python3', '-u', '-c', COPY_WATCHER],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            log(`Notch: could not start the file copy watcher: ${e.message}`);
            return;
        }
        this._copyStream = new Gio.DataInputStream({
            base_stream: this._copyProc.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._readCopyLine();
    }

    _stopCopyWatcher() {
        this._copyProc?.force_exit();
        this._copyProc = null;
        this._copyStream = null;
        this._copy = null;
        this._copySamples = [];
        this._fileDownload = null;
        this._downloadSamples = [];
        this._refreshDownload();
    }

    _readCopyLine() {
        this._copyStream.read_line_async(
            GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
                try {
                    const [line] = stream.read_line_finish_utf8(res);
                    // ended, or stopped in the meantime
                    if (line === null || stream !== this._copyStream)
                        return;
                    this._onCopyLine(line);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e);
                    return;
                }
                this._readCopyLine();
            });
    }

    _onCopyLine(line) {
        let data;
        try {
            data = JSON.parse(line);
        } catch (e) {
            return;
        }

        const now = GLib.get_monotonic_time() / 1e6;

        // file copy
        if (data.copy) {
            this._copy = {name: data.copy.name, pct: data.copy.pct};
            this._copyMisses = 0;
            this._copySamples.push({t: now, pct: data.copy.pct});
            if (this._copySamples.length > 6)
                this._copySamples.shift();
        } else if (this._copy && ++this._copyMisses >= COPY_MISSES_BEFORE_END) {
            this._copy = null;
            this._copySamples = [];
        }

        // browser download (a growing .crdownload / .part file)
        if (data.download) {
            const {name, bytes, total} = data.download;
            this._fileDownload = {name, bytes, total: total ?? 0};
            this._downloadMisses = 0;
            this._downloadSamples.push({t: now, bytes});
            if (this._downloadSamples.length > 6)
                this._downloadSamples.shift();
        } else if (this._fileDownload && ++this._downloadMisses >= COPY_MISSES_BEFORE_END) {
            this._fileDownload = null;
            this._downloadSamples = [];
        }

        this._refreshDownload();
    }

    // ---- media ---------------------------------------------------------

    _pickPlayer() {
        const players = this._mpris.players;
        const next = players.find(p => p.status === 'Playing') ?? players[0] ?? null;

        if (next !== this._player) {
            this._player?.disconnectObject(this);
            this._player = next;
            this._player?.connectObject('changed', () => this._onPlayerChanged(), this);
        }
        this._onPlayerChanged();
    }

    _onPlayerChanged() {
        // After pausing, keep the pill around for a while so it can be resumed
        const status = this._player?.status ?? null;
        if (status === 'Paused' && this._lastStatus === 'Playing')
            this._startPauseGrace();
        else if (status !== 'Paused')
            this._clearPauseGrace();
        this._lastStatus = status;

        this._updateActivity();
        if (this._activity === 'music') {
            this._renderMusic();
            this._pollPosition();
            this._syncEq();
        }
    }

    _musicShown() {
        if (!this._showMusic)
            return false;

        const status = this._player?.status;
        return status === 'Playing' || (status === 'Paused' && this._pausedGrace);
    }

    _startPauseGrace() {
        this._clearPauseGrace();
        this._pausedGrace = true;
        this._graceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, PAUSE_GRACE_SECONDS, () => {
                // Don't vanish while the pill is open under the pointer
                if (this._expanded)
                    return GLib.SOURCE_CONTINUE;
                this._graceId = 0;
                this._pausedGrace = false;
                this._updateActivity();
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(this._graceId, '[gnome-shell] notch pause grace');
    }

    _clearPauseGrace() {
        if (this._graceId) {
            GLib.source_remove(this._graceId);
            this._graceId = 0;
        }
        this._pausedGrace = false;
    }

    // The visualizer only moves while the music is playing
    _syncEq() {
        if (this._player?.status === 'Playing')
            this._startEq();
        else
            this._stopEq();
    }

    // ---- hover / expansion ----------------------------------------------

    // The panel tracks hover; while the pointer is over it, watch for it
    // resting on the pill and expand after a short delay.
    _onPanelHover() {
        if (this._hoverPollId || !this._panel.hover)
            return;

        let dwell = 0;
        this._hoverPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            if (!this._panel.hover || this._expanded) {
                this._hoverPollId = 0;
                return GLib.SOURCE_REMOVE;
            }

            if (this._activity && !this._hidden && this._pointerInside(0) &&
                Main.modalCount === 0) {
                dwell += 40;
                if (dwell >= OPEN_DELAY) {
                    this._hoverPollId = 0;
                    this._expandPill();
                    return GLib.SOURCE_REMOVE;
                }
            } else {
                dwell = 0;
            }
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._hoverPollId, '[gnome-shell] notch hover poll');
    }

    _expandPill() {
        if (this._expanded)
            return;
        this._expanded = true;
        this._more.show();
        this._expand.ease(1, {
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });

        // Collapse once the pointer leaves the expanded pill
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => {
            if (this._activity && this._pointerInside(POINTER_SLACK))
                return GLib.SOURCE_CONTINUE;
            this._pollId = 0;
            this._collapse();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._pollId, '[gnome-shell] notch pointer poll');
    }

    _collapse() {
        if (!this._expanded)
            return;
        this._expanded = false;
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        this._expand.ease(0, {
            duration: 260,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            onComplete: () => {
                if (!this._expanded)
                    this._more.hide();
            },
        });
        this._onPanelHover();
    }

    _pointerInside(slack) {
        const [px, py] = global.get_pointer();
        const [x, y] = this.get_transformed_position();
        const [w, h] = this.get_transformed_size();
        return px >= x - slack && px <= x + w + slack &&
               py >= y - slack && py <= y + h + slack;
    }

    // Slides away together with the status island
    setHidden(hidden) {
        this._hidden = hidden;
        if (hidden)
            this._collapse();
        this._slide.ease(hidden ? 1 : 0, {
            duration: 350,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });
    }

    // ---- geometry ----------------------------------------------------------

    _applyGeometry() {
        const panel = this._panel;
        const monitor = Main.layoutManager.primaryMonitor;
        const right = panel._rightBox;
        if (!monitor || !right.mapped)
            return;

        const [rx, ry] = right.get_transformed_position();
        const [, rh] = right.get_transformed_size();
        if (!Number.isFinite(rx) || !Number.isFinite(ry) || !(rh > 0))
            return;

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const t = clamp01(this._expand.value);
        const a = clamp01(this._presence.value);
        const k = clamp01(this._kind.value);
        const slide = clamp01(this._slide.value);

        // Not shown on lock/login screens, which use another panel layout
        const offScreen = !!Main.sessionMode.panelStyle || a <= 0.001;
        this.reactive = !offScreen && slide < 0.5;

        const pillH = rh;
        const baseW = Math.round(lerp(this._fromW, this._toW, k) * scale);
        const extraH = Math.round(lerp(this._fromH, this._toH, k) * scale);
        const collapsedW = Math.round(lerp(pillH, baseW, a));
        const w = Math.round(lerp(collapsedW, Math.round(EXPANDED_WIDTH * scale), t));
        const h = Math.round(lerp(pillH, pillH + extraH, t));

        // Right edge sits just left of the status island
        const x = Math.round(rx - ISLAND_GAP * scale - w);
        this.set_position(x, ry);
        // Never smaller than the bar: the details box is pushed down by the
        // bar height and would get a negative size (and break drawing)
        const pillW = Math.max(w, pillH);
        const fullH = Math.max(h, pillH);
        this.set_size(pillW, fullH);

        const radius = Math.round(lerp(pillH / 2, EXPANDED_RADIUS * scale, t));
        this.opacity = offScreen ? 0 : Math.round(255 * a * (1 - slide));
        this.translation_y = -slide * Math.round(SLIDE_DISTANCE * scale);

        // the glass, the tint and the fill share the pill's rounding
        this._blur.set({
            radius: this._glassBlur * scale,
            corner_radius: radius,
        });
        const tint = lerp(this._glassTint,
            Math.max(this._glassTint, GLASS_TINT_EXPANDED), t).toFixed(3);
        this._tint.style = `border-radius: ${radius / scale}px; ` +
            `background-color: rgba(0, 0, 0, ${tint});`;
        this._fill.setRadius(radius);

        // keep the wallpaper copy lined up with the real one
        this._glass.set_size(pillW, fullH);
        this._wallpaper.set({
            translation_x: monitor.x - x,
            translation_y: monitor.y - (ry + this.translation_y),
        });

        this._top.set_height(pillH);
        this._musicRow.set_height(pillH);
        this._copyRow.set_height(pillH);
        this._timerRow.set_height(pillH);
        // No vertical padding on the details box: mid-animation it can be
        // shorter than any padding, which would give it a negative size
        this._moreSpacer.set_height(pillH + Math.round(4 * scale));
        this._more.opacity = Math.round(255 * t * t);
    }

    destroy() {
        for (const id of [this._launcherSub, this._ownerSub]) {
            if (id)
                Gio.DBus.session.signal_unsubscribe(id);
        }
        this._dbusImpl?.unexport();
        this._bgManager?.destroy();
        this._bgManager = null;
        this._clearPauseGrace();
        this._stopTimerTick();
        this._cancellable.cancel();
        this._copyProc?.force_exit();
        this._stopPositionPoll();
        this._stopEq();
        for (const id of [this._pollId, this._hoverPollId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._player?.disconnectObject(this);
        super.destroy();
    }
});
