#!/usr/bin/env python3
"""Mana Pool scanner: real token use from Claude Code's own transcripts.

Why this exists: the 5-hour (5H) and weekly (7D) limits are shown as a percent
only.  Every model call Claude Code makes is logged in
~/.claude/projects/**/*.jsonl with its exact token counts, so adding those up
gives the real work behind the percent.  Plain local file reading: it never
calls a model and costs zero tokens.

Called by the mod (hooks/register.tsx) with:
  scan.py <window start epoch> [<window start> ...]
          --session-id=<uuid>   this session: <uuid>.jsonl plus <uuid>/subagents/*.jsonl
          --since5h=<epoch>     start of the current 5H window
          --now=<epoch>         the mod's clock
          --busy=1              a turn is still running (the newest turn is not finished)
          --model=<id>          the model the session is on now (e.g. claude-opus-5-5)
          --plugin=<name>       the mod's name: its data folder is <config>/plugins/data/<name>
          --data-dir=<path>     or that folder given directly (tests)
          --reading=<kind>|<resetsAt>|<pct>   a meter reading taken just now (one per window)
  scan.py --backfill --plugin=<name>   reads EVERY transcript once and fills the daily
         history (history.json) for days the normal scan no longer reaches
  stdin: {"samples": [...], "ledger": [...]}  what the mod has saved (may be empty;
         samples here only seed the tick log file the first time)

  scan.py --export=<csv path>   with the same stdin: writes the ledger as CSV

Prints one JSON object (see the bottom of this file for its fields).

The tick log is shared by every open session.  It lives in its own file,
changed only under an exclusive file lock, so two sessions saving readings at
the same moment can never overwrite each other's (the mod's key-value store
has no way to do that safely).

Units: "work units" weigh each token by type and model, so a cheap cache read
does not count like an expensive output token.  1 unit = one Sonnet input
token at list price.  The weights start at API list prices and switch to
weights fitted from your own meter ticks once there are enough clean ticks.
"""
import csv, glob, hashlib, json, os, re, sys, time

# File locking: fcntl on macOS and Linux, msvcrt on Windows.
try:
    import fcntl

    def lock(f):
        fcntl.flock(f, fcntl.LOCK_EX)

    def unlock(f):
        fcntl.flock(f, fcntl.LOCK_UN)
except ImportError:
    import msvcrt

    def lock(f):
        # LK_LOCK itself retries for about 10 s; give up after 30 s in all,
        # so a stuck lock fails the scan (and shows) instead of hanging it.
        f.seek(0)
        deadline = time.time() + 30
        while True:
            try:
                msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
                return
            except OSError:
                if time.time() > deadline:
                    raise

    def unlock(f):
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
starts, session_id, since5h, now, busy, export = [], "", 0.0, 0.0, False, ""
backfill = False  # --backfill: build the daily history from every transcript once (slow; run in the background)
cur_model, data_dir, readings = "", "", []
# Claude Code's own folder: ~/.claude, or wherever CLAUDE_CONFIG_DIR points.
CONFIG = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")
for a in sys.argv[1:]:
    if a.startswith("--plugin="):
        # the mod's data folder: <config>/plugins/data/<plugin name>
        data_dir = os.path.join(CONFIG, "plugins", "data", a.split("=", 1)[1].strip())
    elif a.startswith("--model="):
        cur_model = a.split("=", 1)[1].strip()
    elif a.startswith("--data-dir="):
        data_dir = os.path.expanduser(a.split("=", 1)[1])
    elif a.startswith("--reading="):
        kind_, ra_, pct_ = a.split("=", 1)[1].split("|")
        readings.append((kind_, ra_, float(pct_)))
    elif a.startswith("--session-id="):
        session_id = a.split("=", 1)[1].strip()
    elif a.startswith("--since5h="):
        since5h = float(a.split("=", 1)[1])
    elif a.startswith("--now="):
        now = float(a.split("=", 1)[1])
    elif a.startswith("--busy="):
        busy = a.split("=", 1)[1] == "1"
    elif a == "--backfill":
        backfill = True
    elif a.startswith("--export="):
        export = os.path.expanduser(a.split("=", 1)[1])
    else:
        starts.append(float(a))
if not now:
    now = datetime.now(timezone.utc).timestamp()

try:
    given = json.loads(sys.stdin.read() or "{}")
except Exception:
    given = {}
samples = given.get("samples") or []
ledger = given.get("ledger") or []

# The tick log file (one reading per line).  Read here without the lock: a
# reading appended a moment later only matters to the next scan.  Seeded once
# from the mod's store when the file does not exist yet.
SAMPLES_FILE = os.path.join(data_dir, "samples.jsonl") if data_dir else ""
LOCK_FILE = os.path.join(data_dir, "lock") if data_dir else ""


def read_log():
    out = []
    with open(SAMPLES_FILE) as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except Exception:
                pass  # a half-written line from a crash: skip it
    return out


if SAMPLES_FILE and os.path.exists(SAMPLES_FILE):
    samples = read_log()

ROOT = os.path.join(CONFIG, "projects")
SPAN = {"five_hour": 5 * 3600, "seven_day": 7 * 86400}

# ---------------------------------------------------------------------------
# Weights.  List prices per model VERSION in $ per million tokens: input,
# output, cache write (1-hour kind), cache read.  Source: Anthropic's pricing
# page, platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-09).
# Versions of one family can differ a lot (Fable 5.2 is 20% cheaper than 5.1,
# Sonnet 5.5 reads cache at half Sonnet 5's price), so each call is priced on
# the exact version it ran on.
# Units: dollars divided by $2 (Sonnet 5.5 input), so 1 unit = 1 Sonnet input token.
# ---------------------------------------------------------------------------
PRICES = {
    ("fable", "5.2"): (8, 40, 16, 0.20),
    ("fable", "5.1"): (10, 50, 20, 0.25),
    ("fable", "5"): (10, 50, 20, 1.00),
    ("opus", "5.5"): (4, 20, 8, 0.20),
    ("opus", "5"): (5, 25, 10, 0.50),
    ("opus", "4.8"): (5, 25, 10, 0.50),
    ("opus", "4.7"): (5, 25, 10, 0.50),
    ("opus", "4.6"): (5, 25, 10, 0.50),
    ("opus", "4.5"): (5, 25, 10, 0.50),
    ("opus", "4.1"): (15, 75, 30, 1.50),
    ("opus", "4"): (15, 75, 30, 1.50),
    ("sonnet", "5.5"): (2, 10, 4, 0.10),
    ("sonnet", "5"): (2, 10, 4, 0.20),
    ("sonnet", "4.6"): (3, 15, 6, 0.30),
    ("sonnet", "4.5"): (3, 15, 6, 0.30),
    ("sonnet", "4"): (3, 15, 6, 0.30),
    ("haiku", "5.5"): (0.10, 0.50, 0.20, 0.01),
    ("haiku", "4.5"): (1, 5, 2, 0.10),
}
# Cache writes come in two lifetimes: the 1-hour kind (2x input, the column
# above) and the 5-minute kind (1.25x input).  Claude Code's main thread uses
# the 1-hour kind; subagents mostly the 5-minute kind.
WRITE_5M = 1.25
# Fast mode (usage.speed == "fast") costs this many times every price.
FAST = 2.0
# Priced by prompt length: a call whose prompt (input + cache write + cache
# read) is over the threshold pays every price times the multiplier.
LONG = {("haiku", "5.5"): (100_000, 5.0)}
# The version to assume when a model id names no known version, and for
# "what if this ran on Fable" before you have used that family yourself.
NEWEST = {"fable": "5.2", "opus": "5.5", "sonnet": "5.5", "haiku": "5.5"}
UNIT_DOLLARS = 2.0
MODELS = ["fable", "opus", "sonnet", "haiku"]
# A fresh session that takes over through a handoff note does not start from
# the bare system prompt: it also reads the note and re-reads a few files.
# Assumed allowance, in tokens (see the manual: "fresh session").
HANDOFF_EXTRA = 15000
# Output tokens the old session spends writing the handoff note.
HANDOFF_NOTE_OUT = 3000


def key_of(model):
    m = (model or "").lower()
    if "fable" in m or "mythos" in m:
        return "fable"
    if "opus" in m:
        return "opus"
    if "haiku" in m:
        return "haiku"
    if "sonnet" in m:
        return "sonnet"
    return ""  # unknown: left unpriced (and listed), never guessed


# "claude-opus-5-5" -> "5.5", "claude-haiku-4-5-20251001" -> "4.5",
# "claude-opus-4-20250514" -> "4".  The negative lookahead stops a date
# suffix being read as a minor version.
VER_RE = re.compile(r"(?:fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)")


def ver_of(model):
    m = VER_RE.search((model or "").lower())
    if not m:
        return ""
    return m.group(1) + ("." + m.group(2) if m.group(2) else "")


def price(fam, ver, prompt, fast=False):
    """Units per token for one call: input, output, cache write (1 hour),
    cache read, cache write (5 minutes)."""
    p = PRICES.get((fam, ver)) or PRICES[(fam, NEWEST[fam])]
    ver = ver if (fam, ver) in PRICES else NEWEST[fam]
    lim = LONG.get((fam, ver))
    big = (lim[1] if lim and prompt > lim[0] else 1.0) * (FAST if fast else 1.0)
    return [x / UNIT_DOLLARS * big for x in (*p, p[0] * WRITE_5M)]


def cost(c, ww):
    """One call's tokens times a weight vector (from price() or w())."""
    w5 = c.get("w5", 0)
    return c["i"] * ww[0] + c["o"] * ww[1] + (c["w"] - w5) * ww[2] + c["r"] * ww[3] + w5 * ww[4]


def ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


# Fitted multipliers per token type (K) and per model (MM); 1.0 = list price.
K = [1.0, 1.0, 1.0, 1.0]
MM = {k: 1.0 for k in MODELS}
# The version each family is re-priced on ("what if this ran on Opus"): the
# newest one you have actually used, filled in after the transcripts are read.
DEFAULT = dict(NEWEST)


def w(model_key, prompt, ver=None, fast=False):
    """Unit weight per token type for one call on model_key (fitted weights).
    Both cache-write kinds take the fitted cache-write factor K[2]."""
    base = price(model_key, ver or DEFAULT[model_key], prompt, fast)
    return [base[i] * K[i if i < 4 else 2] * MM[model_key] for i in range(5)]


def units(c, model_key=None):
    """Work units of one call: as it ran (its own version), or re-priced on a
    family's current version (the one you are on now, else the one you used
    last).  Re-pricing applies within a family too: Haiku 4.5 turns forecast
    on Haiku 5.5 at Haiku 5.5's prices."""
    if model_key is None:
        ww = w(c["k"], c["p"], c["v"], c.get("fast", False))
    else:
        ww = w(model_key, c["p"])  # re-priced: at standard speed
    return cost(c, ww)


def is_long(c):
    lim = LONG.get((c["k"], c["v"] if (c["k"], c["v"]) in PRICES else NEWEST[c["k"]]))
    return bool(lim and c["p"] > lim[0])


def list_units(c):
    """The same at plain list prices: the fixed yardstick of the ledger.
    It never changes when the fit does, so old and new rows stay comparable."""
    return cost(c, price(c["k"], c["v"], c["p"], c.get("fast", False)))


# ---------------------------------------------------------------------------
# CSV export: no transcript reading needed.
# ---------------------------------------------------------------------------
def et(epoch):
    """A time for the CSV, in the computer's own time zone (named, e.g. "PST")."""
    return datetime.fromtimestamp(epoch).astimezone().strftime("%Y-%m-%d %H:%M %Z")


if export:
    os.makedirs(os.path.dirname(export), exist_ok=True)
    cols = ["window", "start", "end", "models", "meter_pct", "work_units_list", "units_per_1pct",
            "raw_input", "raw_output", "raw_cache_write", "raw_cache_read", "raw_total",
            "outside_use_pct", "last_reading", "weights", "recorded"]
    with open(export, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(cols)
        for r in sorted(ledger, key=lambda r: (r.get("kind", ""), r.get("start", 0))):
            t = r.get("tokens") or [0, 0, 0, 0]
            wr.writerow([
                "5H" if r.get("kind") == "five_hour" else "7D",
                et(r.get("start", 0)), et(r.get("end", 0)), " + ".join(r.get("models") or []),
                r.get("pct", 0), round(r.get("units", 0)), round(r.get("per1", 0)) if r.get("per1") else "",
                t[0], t[1], t[2], t[3], sum(t),
                r.get("outside", 0), et(r.get("seen", 0)) if r.get("seen") else "",
                r.get("weights", "list"), et(r.get("at", 0)) if r.get("at") else "",
            ])
    print(json.dumps({"exported": export, "rows": len(ledger)}))
    sys.exit(0)

def clean(lst):
    """A window's percent only goes up; a lower reading is stale (another open session)."""
    top, out = {}, []
    for s in sorted(lst, key=lambda s: s.get("at", 0)):
        k = (s.get("kind"), s.get("resetsAt") or "")
        if s.get("pct", -1) <= top.get(k, -1):
            continue
        top[k] = s["pct"]
        out.append(s)
    return out


samples = clean(samples)


def cut(s):
    """The moment a reading covers work up to.  Readings saved before
    2026-11-09 were rounded down to the whole second (they carry no "ts"
    mark), so a reply in that same second may be missing: for those, count to
    the end of the second.  Marked readings are exact, even at .000."""
    at = s.get("at", 0)
    return at + 1 if not s.get("ts") and float(at).is_integer() else at


def win_bounds(kind, resets_at):
    end = ts(resets_at) if resets_at else 0
    return (end - SPAN[kind], end) if end else (0, 0)


# Windows that have ended and are not in the ledger yet (only those whose
# transcripts are still on disk: Claude Code keeps about 30 days).
# Rows from older rules counted work past the last
# reading, so they can read too high.  They are rebuilt below while their
# transcripts and readings are still on disk, and left out of the limit check
# otherwise.
RULE = 3  # 3: 2026-11-09 evening (exact reading times); 2 had the whole-second cutoff
# A row is also redone when the log holds a higher reading for its window
# than the row used (a session saved its reading after another session had
# already closed the window).
top_pct = {}
for s in samples:
    k = (s.get("kind"), s.get("resetsAt"))
    top_pct[k] = max(top_pct.get(k, -1), s.get("pct", -1))
done = {(r.get("kind"), r.get("resetsAt")) for r in ledger
        if (r.get("rule") or 0) >= RULE and (r.get("pct") or 0) >= top_pct.get((r.get("kind"), r.get("resetsAt")), -1)}
closing = {}
for s in samples:
    k = (s.get("kind"), s.get("resetsAt"))
    if k[0] not in SPAN or not k[1] or k in done:
        continue
    st, en = win_bounds(*k)
    if en and en <= now and st >= now - 29 * 86400:
        closing[k] = (st, en)

# How far back to read: the oldest window asked for, every closing window,
# and every saved tick (for the weight fit).
oldest = min([*starts, *(b[0] for b in closing.values()), now - 3600] or [now])
for s in samples:
    if s.get("kind") == "five_hour" and s.get("resetsAt"):
        oldest = min(oldest, win_bounds("five_hour", s["resetsAt"])[0])
oldest = max(oldest, now - 29 * 86400)

# ---------------------------------------------------------------------------
# Read the transcripts, incrementally.
#
# Claude Code only ever appends to a transcript.  So for each file the scanner
# keeps (in scan-cache.json, next to the tick log) what it already pulled out
# of it, plus its size, modified time, how far it has read (a byte offset) and
# a fingerprint of its first bytes.  On the next scan an unchanged file is not
# opened at all, a grown one is read only from the offset, and one that shrank
# or whose start changed is read again from the beginning.  Only complete
# lines are consumed, so a line still being written is picked up next time.
# Without a data folder (tests, --export) it simply reads everything.
# ---------------------------------------------------------------------------
CACHE_FILE = os.path.join(data_dir, "scan-cache.json") if data_dir else ""
CACHE_V = 3   # bump when the record layout below changes: forces a full re-read
HEAD = 4096   # bytes fingerprinted at the start of each file


CWD_RE = re.compile(r'"cwd":"((?:[^"\\]|\\.)*)"')


def head_hash(fh, n):
    fh.seek(0)
    return hashlib.sha1(fh.read(n)).hexdigest()


def parse(lines):
    """Pull out only what the scanner needs (never any text):
    calls:   [time, model id, input, output, cache write, of which 5-minute,
              cache read, sidechain 0/1, stop reason, message id, fast 0/1]
    prompts: times of your own messages
    compact: [time, tokens before, trigger] of each compaction
    cwd:     the folder the session runs in (first one seen): its project"""
    rec = {"calls": [], "prompts": [], "compact": [], "cwd": ""}
    for line in lines:
        if not rec["cwd"] and '"cwd":"' in line:
            m_ = CWD_RE.search(line)
            if m_:
                try:
                    rec["cwd"] = json.loads('"' + m_.group(1) + '"')
                except Exception:
                    pass
        if '"compact_boundary"' in line:
            try:
                d = json.loads(line)
                if d.get("subtype") == "compact_boundary":
                    md = d.get("compactMetadata") or {}
                    rec["compact"].append([ts(d.get("timestamp", "")), md.get("preTokens") or 0, md.get("trigger") or ""])
            except Exception:
                pass
            continue
        if '"type":"user"' in line and '"tool_result"' not in line:
            # Your own message (not a tool result, not a system note, not a summary)
            try:
                d = json.loads(line)
                if d.get("isMeta") or d.get("isSidechain") or d.get("isCompactSummary"):
                    continue
                c = (d.get("message") or {}).get("content")
                if isinstance(c, str) or (isinstance(c, list) and any(isinstance(x, dict) and x.get("type") == "text" for x in c)):
                    rec["prompts"].append(ts(d.get("timestamp", "")))
            except Exception:
                pass
            continue
        if '"usage"' not in line or '"assistant"' not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        m = d.get("message") or {}
        u = m.get("usage")
        if d.get("type") != "assistant" or not u or m.get("model") == "<synthetic>":
            continue
        cc = u.get("cache_creation") or {}
        rec["calls"].append([ts(d.get("timestamp", "")), m.get("model") or "?",
                             u.get("input_tokens", 0) or 0, u.get("output_tokens", 0) or 0,
                             u.get("cache_creation_input_tokens", 0) or 0, cc.get("ephemeral_5m_input_tokens", 0) or 0,
                             u.get("cache_read_input_tokens", 0) or 0, 1 if d.get("isSidechain") else 0,
                             m.get("stop_reason"), m.get("id") or d.get("uuid"), 1 if u.get("speed") == "fast" else 0])
    return rec



# ---------------------------------------------------------------------------
# Daily history (the History pane).  One bucket per local calendar day:
#   m: work units per model (list prices, the ledger's fixed yardstick)
#   p: work units per project (the folder a session ran in)
#   h: work units per hour of the day (24 numbers)
#   r: the part of those units spent re-reading the conversation (cache reads)
#   n: model calls
# Kept in <data folder>/history.json.  Days the normal scan reaches are rebuilt
# on every scan (it sees every call of those days); older days stay as they
# were, so the file is the only place their history survives once Claude Code
# deletes old transcripts.  Token counts only, never conversation text.
# ---------------------------------------------------------------------------
HIST_FILE = os.path.join(data_dir, "history.json") if data_dir else ""
HIST_V = 1
HIST_KEEP = 400   # days kept in the file
HIST_SEND = 92    # days sent to the mod (the 90-day view plus slack)
HOME = os.path.expanduser("~")


def proj_of(cwd):
    """A project's name: the folder a session ran in.  A worktree counts as
    the repository it belongs to; the home folder itself is "Home"."""
    if not cwd:
        return "?"
    cwd = cwd.split(f"{os.sep}.claude{os.sep}worktrees{os.sep}")[0].rstrip(os.sep)
    if cwd == HOME.rstrip(os.sep):
        return "Home"
    return os.path.basename(cwd) or "?"


def show_of(model):
    """The model's name in the History pane.  Mythos is priced as Fable's
    family (key_of) but drawn on its own."""
    m = (model or "").lower()
    return "mythos" if "mythos" in m else (key_of(m) or "other")


def day_of(t):
    """Local calendar day and hour of an epoch time."""
    d = datetime.fromtimestamp(t)
    return d.strftime("%Y-%m-%d"), d.hour


def day_start(t):
    """Epoch of the first local midnight at or after t."""
    d = datetime.fromtimestamp(t)
    mid = d.replace(hour=0, minute=0, second=0, microsecond=0)
    return mid.timestamp() if mid.timestamp() >= t else (mid.timestamp() + 86400)


def roll(calls_):
    """Daily buckets from priced calls (each a dict as built below)."""
    days = {}
    for c in calls_:
        k, hr = day_of(c["t"])
        b = days.setdefault(k, {"m": {}, "p": {}, "h": [0.0] * 24, "r": 0.0, "n": 0})
        pr = price(c["k"], c["v"], c["p"], c.get("fast", False))
        lu = cost(c, pr)
        name = show_of(c["model"])
        b["m"][name] = b["m"].get(name, 0.0) + lu
        b["p"][c["proj"]] = b["p"].get(c["proj"], 0.0) + lu
        b["h"][hr] += lu
        b["r"] += c["r"] * pr[3]
        b["n"] += 1
    for b in days.values():
        b["m"] = {k: round(v) for k, v in b["m"].items()}
        b["p"] = {k: round(v) for k, v in b["p"].items()}
        b["h"] = [round(x) for x in b["h"]]
        b["r"] = round(b["r"])
    return days


def hist_merge(fresh, replace_from=None, fill_only=False):
    """Fold fresh day buckets into history.json under the shared lock.
    replace_from: days on or after this key are replaced (the normal scan saw
    all of them); fill_only: only days the file lacks are added (backfill),
    and the file is marked complete.  Returns the file's days."""
    if not HIST_FILE:
        return fresh, False
    os.makedirs(data_dir, exist_ok=True)
    with open(LOCK_FILE, "a+") as lk:
        lock(lk)
        try:
            try:
                with open(HIST_FILE) as f:
                    got = json.load(f)
                if got.get("v") != HIST_V:
                    got = {}
            except Exception:
                got = {}
            days, full = got.get("days") or {}, bool(got.get("full"))
            if fill_only:
                for k, b in fresh.items():
                    days.setdefault(k, b)
                full = True
            else:
                if replace_from:
                    for k in [k for k in days if k >= replace_from]:
                        del days[k]
                days.update(fresh)
            keep = sorted(days)[-HIST_KEEP:]
            days = {k: days[k] for k in keep}
            tmp = f"{HIST_FILE}.{os.getpid()}.tmp"
            with open(tmp, "w") as f:
                f.write(json.dumps({"v": HIST_V, "full": full, "days": days}, separators=(",", ":")))
            os.replace(tmp, HIST_FILE)
            return days, full
        finally:
            unlock(lk)


if backfill:
    # Every transcript, start to end, once.  The same reply can be logged more
    # than once (while it streams, and in forked or resumed sessions), so
    # calls are kept by message id, newest copy wins, as in the normal scan.
    seen = {}
    for path in glob.glob(os.path.join(ROOT, "**", "*.jsonl"), recursive=True):
        try:
            with open(path, "rb") as fh:
                rec = parse(fh.read().decode("utf-8", errors="ignore").splitlines())
        except OSError:
            continue
        proj = proj_of(rec["cwd"])
        for t, model, i, o, w_, w5, r, side, stop, key, fast in rec["calls"]:
            fam = key_of(model)
            if not fam or not t:
                continue  # unpriced models are left out, as everywhere else
            prev = seen.get(key)
            if prev is None or t >= prev["t"]:
                seen[key] = {"t": t, "k": fam, "v": ver_of(model), "model": model, "i": i, "o": o, "w": w_,
                             "w5": min(w5, w_), "r": r, "p": i + w_ + r, "fast": bool(fast), "proj": proj}
    days, full = hist_merge(roll(seen.values()), fill_only=True)
    print(json.dumps({"backfill": len(seen), "days": len(days)}))
    sys.exit(0)

cache = {}
if CACHE_FILE:
    try:
        with open(CACHE_FILE) as f:
            got = json.load(f)
        if got.get("v") == CACHE_V:
            cache = got.get("files") or {}
    except Exception:
        cache = {}  # missing or damaged: rebuilt by this scan
dirty = False
entries = {}  # path -> its records, for every file in range
for path in glob.glob(os.path.join(ROOT, "**", "*.jsonl"), recursive=True):
    try:
        st_ = os.stat(path)
    except OSError:
        continue
    e = cache.get(path)
    if st_.st_mtime < oldest:
        if e and st_.st_mtime >= now - 31 * 86400:
            entries[path] = None  # out of range for this scan, but keep its cache
        continue
    if e and e["size"] == st_.st_size and e["mtime"] == st_.st_mtime:
        entries[path] = e
        continue
    try:
        with open(path, "rb") as fh:
            grown = bool(e) and st_.st_size >= e["off"] and head_hash(fh, e["hlen"]) == e["head"]
            if not grown:
                e = {"off": 0, "calls": [], "prompts": [], "compact": [], "cwd": ""}
            fh.seek(e["off"])
            chunk = fh.read()
            end = chunk.rfind(b"\n") + 1  # complete lines only
            rec = parse(chunk[:end].decode("utf-8", errors="ignore").splitlines())
            for k_ in ("calls", "prompts", "compact"):
                e[k_] = e[k_] + rec[k_]
            e["cwd"] = e.get("cwd") or rec["cwd"]
            e["off"] += end
            e["hlen"] = min(HEAD, e["off"])
            e["head"] = head_hash(fh, e["hlen"])
            e["size"], e["mtime"] = st_.st_size, st_.st_mtime
    except OSError:
        continue
    entries[path] = e
    dirty = True
if CACHE_FILE and (dirty or len(entries) != len(cache)):
    keep = {pth: (e if e is not None else cache[pth]) for pth, e in entries.items()}
    try:
        os.makedirs(data_dir, exist_ok=True)
        tmp = f"{CACHE_FILE}.{os.getpid()}.tmp"  # one per process: parallel scans never share a temp file
        with open(tmp, "w") as f:
            # dumps (C encoder) then one write: several times faster than dump(f)
            f.write(json.dumps({"v": CACHE_V, "files": keep}, separators=(",", ":")))
        os.replace(tmp, CACHE_FILE)
    except OSError:
        pass  # a cache that can't be saved only costs speed

# Merge every file's records into one view for this session.
calls = {}       # message id -> call (one reply is logged several times while it streams: keep the last copy)
prompts = []     # your own messages in THIS session
all_prompts = [] # every session's own messages (turn counts per window)
compactions = [] # this session's compactions: (time, tokens before, trigger)
auto = []        # (time, tokens before) of auto-compacts anywhere (the real trigger point)
unpriced = {}    # model id -> calls: models the price table does not know, left out
main_path = ""
sub_dir = f"{os.sep}{session_id}{os.sep}subagents{os.sep}" if session_id else None
last_main = None  # newest main-thread assistant record in this session

for path, e in entries.items():
    if e is None:
        continue
    is_main = bool(session_id) and os.path.basename(path) == session_id + ".jsonl"
    is_sub = bool(sub_dir) and sub_dir in path
    if is_main:
        main_path = path
    for t, pre, trig in e["compact"]:
        if trig == "auto" and pre:
            auto.append((t, pre))
        if is_main:
            compactions.append((t, pre, trig))
    for t in e["prompts"]:
        if t >= oldest:
            all_prompts.append(t)
        if is_main:
            prompts.append(t)
    for t, model, i, o, w_, w5, r, side, stop, key, fast in e["calls"]:
        if t < oldest and not is_main:
            continue
        fam = key_of(model)
        if not fam:
            unpriced[model] = unpriced.get(model, 0) + 1
            continue
        c = {"t": t, "k": fam, "v": ver_of(model), "model": model,
             "i": i, "o": o, "w": w_, "w5": min(w5, w_), "r": r, "p": i + w_ + r, "fast": bool(fast),
             "main": is_main and not side, "sub": bool(is_sub or (is_main and side)), "stop": stop,
             "proj": proj_of(e.get("cwd", ""))}
        prev = calls.get(key)
        # The same reply can be logged more than once: while it streams
        # (keep the newest copy's token counts) and in a forked or resumed
        # session's transcript (a copy of the parent's history).  Whether
        # it belongs to THIS session must not depend on which file was read
        # last, so the flags are combined across every copy.
        if prev is None or t >= prev["t"]:
            if prev is not None:
                c["main"] = c["main"] or prev["main"]
                c["sub"] = c["sub"] or prev["sub"]
            calls[key] = c
        else:
            prev["main"] = prev["main"] or c["main"]
            prev["sub"] = prev["sub"] or c["sub"]
        if c["main"] and (last_main is None or t >= last_main["t"]):
            last_main = c

compactions.sort()
auto_pre = [pre for _, pre in sorted(auto)]

# Daily history: every day from the first midnight the scan fully covers.
_cover = day_start(oldest)
_fresh = roll([c for c in calls.values() if c["t"] >= _cover])
_hdays, _hfull = hist_merge(_fresh, replace_from=day_of(_cover)[0])

CALLS = sorted(calls.values(), key=lambda c: c["t"])
prompts.sort()
all_prompts.sort()

# Re-price each family on the version you used most recently (CALLS is in
# time order, so the last one seen wins); families you have not used keep NEWEST.
for c in CALLS:
    if (c["k"], c["v"]) in PRICES:
        DEFAULT[c["k"]] = c["v"]
# The model you are on right now wins for its own family.
if (key_of(cur_model), ver_of(cur_model)) in PRICES:
    DEFAULT[key_of(cur_model)] = ver_of(cur_model)

# ---------------------------------------------------------------------------
# Weight fit from real meter ticks (5H only: it moves often enough).
# A tick = two readings in a row of the same window.  Its local work is every
# call between the two readings.  Needs enough clean ticks to trust.
# ---------------------------------------------------------------------------
def solve3(A, b):
    """Least squares for 3 unknowns, by the normal equations (no numpy here)."""
    n = 3
    M = [[sum(A[r][i] * A[r][j] for r in range(len(A))) for j in range(n)] for i in range(n)]
    v = [sum(A[r][i] * b[r] for r in range(len(A))) for i in range(n)]
    # Gaussian elimination with partial pivoting
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-30:
            return None
        M[col], M[piv] = M[piv], M[col]
        v[col], v[piv] = v[piv], v[col]
        for r in range(col + 1, n):
            f = M[r][col] / M[col][col]
            for c2 in range(col, n):
                M[r][c2] -= f * M[col][c2]
            v[r] -= f * v[col]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (v[r] - sum(M[r][c2] * x[c2] for c2 in range(r + 1, n))) / M[r][r]
    return x


def calls_between(a, b):
    # CALLS is sorted by time; a linear filter is fine at these sizes
    return [c for c in CALLS if a < c["t"] <= b]


ticks = []  # (dp, [list-weighted output, write(+input), read], {model: list units}, start, end)
by_win = {}
for s in samples:
    if s.get("kind") == "five_hour" and s.get("resetsAt"):
        by_win.setdefault(s["resetsAt"], []).append(s)
for ra, lst in by_win.items():
    lst.sort(key=lambda s: s["at"])
    for a, b in zip(lst, lst[1:]):
        dp = b["pct"] - a["pct"]
        if dp <= 0 or a["at"] < oldest:
            continue
        x = [0.0, 0.0, 0.0]
        per_model = {}
        for c in calls_between(cut(a), cut(b)):
            L = price(c["k"], c["v"], c["p"], c.get("fast", False))
            x[0] += c["o"] * L[1]
            x[1] += (c["w"] - c["w5"]) * L[2] + c["w5"] * L[4] + c["i"] * L[0]
            x[2] += c["r"] * L[3]
            per_model[c["k"]] = per_model.get(c["k"], 0.0) + list_units(c)
        ticks.append((dp, x, per_model, a["at"], b["at"]))

fit = {"source": "list", "ticks": len(ticks), "r2": None, "K": [1, 1, 1, 1], "MM": dict(MM), "model_ticks": {}}
usable = [t for t in ticks if sum(t[1]) > 0]
if len(usable) >= 15:
    A = [t[1] for t in usable]
    b = [t[0] for t in usable]
    x = solve3(A, b)
    if x and all(v > 0 for v in x):
        pred = [sum(A[r][i] * x[i] for i in range(3)) for r in range(len(A))]
        mean = sum(b) / len(b)
        ss_res = sum((b[r] - pred[r]) ** 2 for r in range(len(b)))
        ss_tot = sum((v - mean) ** 2 for v in b) or 1e-9
        r2 = 1 - ss_res / ss_tot
        fit["r2"] = round(r2, 3)
        if r2 >= 0.5:
            # Keep output at list weight (the anchor) and scale the others by
            # what the meter says they are worth relative to output.
            K[1] = 1.0
            K[2] = x[1] / x[0]
            K[0] = K[2]
            K[3] = x[2] / x[0]
            fit["source"] = "fit"
            fit["K"] = [round(v, 4) for v in K]
# Model multipliers: ticks done (85%+) on one model, compared with the rest.
rates = []
per_model_rates = {k: [] for k in MODELS}
for dp, x, pm, a, b in usable:
    tot = sum(pm.values())
    if tot <= 0:
        continue
    u = x[0] * K[1] + x[1] * K[2] + x[2] * K[3]
    if u <= 0:
        continue
    rates.append(dp / u)
    for k, v in pm.items():
        if v / tot >= 0.85:
            per_model_rates[k].append(dp / u)


def median(a):
    a = sorted(a)
    if not a:
        return 0.0
    n = len(a)
    return a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2


# A model's own multiplier is used only with 8+ ticks on it whose spread is
# tight (middle half within 60% of the median); otherwise it stays at list.
fit["measured"] = {}
mid = median(rates) if len(rates) >= 15 else 0
for k in MODELS:
    rk = sorted(per_model_rates[k])
    fit["model_ticks"][k] = len(rk)
    if not rk or mid <= 0:
        continue
    m_ = median(rk) / mid
    q1, q3 = rk[len(rk) // 4] / mid, rk[(3 * len(rk)) // 4] / mid
    spread = (q3 - q1) / m_ if m_ > 0 else 9
    fit["measured"][k] = {"x": round(m_, 3), "ticks": len(rk), "spread": round(spread, 2)}
    if len(rk) >= 8 and spread <= 0.6:
        MM[k] = m_
fit["MM"] = {k: round(v, 3) for k, v in MM.items()}
if any(v != 1.0 for v in MM.values()):
    fit["source"] = "fit" if fit["source"] == "fit" else "fit-models"

# ---------------------------------------------------------------------------
# Window totals.
# ---------------------------------------------------------------------------
def totals(a, b=None, pred=None):
    r = {"input": 0, "output": 0, "cache_write": 0, "cache_write_5m": 0, "cache_read": 0, "messages": 0, "units": 0.0, "listUnits": 0.0, "models": {}}
    for c in CALLS:
        if c["t"] < a or (b is not None and c["t"] > b) or (pred and not pred(c)):
            continue
        r["input"] += c["i"]; r["output"] += c["o"]; r["cache_write"] += c["w"]; r["cache_write_5m"] += c["w5"]; r["cache_read"] += c["r"]
        r["messages"] += 1
        u = units(c)
        r["units"] += u
        r["listUnits"] += list_units(c)
        # Calls billed at a long-prompt price are kept apart ("#long"), so the
        # ledger can re-price them at that price later.
        mm = r["models"].setdefault(c["model"] + ("#long" if is_long(c) else "") + ("#fast" if c["fast"] else ""),
                                    {"input": 0, "output": 0, "cache_write": 0, "cache_write_5m": 0, "cache_read": 0, "units": 0.0})
        mm["input"] += c["i"]; mm["output"] += c["o"]; mm["cache_write"] += c["w"]; mm["cache_write_5m"] += c["w5"]; mm["cache_read"] += c["r"]; mm["units"] += u
    r["units"] = round(r["units"])
    r["listUnits"] = round(r["listUnits"])
    for mm in r["models"].values():
        mm["units"] = round(mm["units"])
    return r


out = {"now": now}
for s in starts:
    t = totals(s)
    t["turns"] = sum(1 for p in all_prompts if p >= s)
    out[str(int(s))] = t

# ---------------------------------------------------------------------------
# This session, turn by turn (subagents included).
# ---------------------------------------------------------------------------
mine = [c for c in CALLS if c["main"] or c["sub"]]
main_calls = [c for c in mine if c["main"]]
base = main_calls[0]["p"] if main_calls else 0  # the context the session started from
turns = []
if mine:
    bounds = prompts + [float("inf")]
    # calls before the first prompt we know of (a resumed session) join the first turn
    for idx in range(len(prompts)):
        a, b = (-float("inf") if idx == 0 else bounds[idx]), bounds[idx + 1]
        tc = [c for c in mine if a <= c["t"] < b]
        if not tc:
            continue
        mc = [c for c in tc if c["main"]]
        ctx0 = mc[0]["p"] if mc else 0
        # A compaction during this turn shrinks the context: history is what was there before
        hist_tok = max(0, ctx0 - base)
        u_all = 0.0; u_hist = 0.0; u_fresh = 0.0; out_tok = 0; by_model = {}
        # The same turn priced on every model, two ways: "here" = the turn as it
        # ran (old conversation included) but with a WARM cache, "fresh" = the
        # turn in a new session after a hand-off (old conversation gone, the
        # hand-off allowance read).  "here" is warm on purpose: when a turn ran
        # on a cold cache, its re-cache is a one-time cost the mod adds back
        # only when the cache is cold now, so it is never counted twice.
        on_here = {k: 0.0 for k in MODELS}
        on_fresh = {k: 0.0 for k in MODELS}
        for c in tc:
            u = units(c)
            u_all += u
            out_tok += c["o"]
            by_model[c["k"]] = by_model.get(c["k"], 0.0) + u
            fc = c
            wc = c
            if c["main"]:
                ww = w(c["k"], c["p"], c["v"], c["fast"])
                h = min(hist_tok, c["p"])
                # history normally comes from the warm cache; past what was
                # read, it was sent again: as a cache write, or (rarely) as
                # plain input.  `split` says how much of a resent part came
                # from each, so tokens are moved, never invented or lost.
                def split(n):
                    from_w = min(n, c["w"])
                    return from_w, min(n - from_w, c["i"])
                from_read = min(h, c["r"])
                hw, hi = split(h - from_read)
                u_hist += from_read * ww[3] + hw * ww[2] + hi * ww[0]
                # Warm baseline (a forecast, never the measured cost): the whole
                # prompt this turn started from counts as a cache read, on the
                # first turn too, because the next turn re-sends all of it.
                reuse = min(ctx0, c["p"])
                rw, ri = split(reuse - min(reuse, c["r"]))
                wc = dict(c, r=c["r"] + rw + ri, w=c["w"] - rw, w5=min(c["w5"], c["w"] - rw), i=c["i"] - ri)
                # Fresh session: the history is gone, the hand-off allowance read.
                fc = dict(c, r=c["r"] - from_read + HANDOFF_EXTRA, w=c["w"] - hw, w5=min(c["w5"], c["w"] - hw), i=c["i"] - hi,
                          p=max(0, c["p"] - h + HANDOFF_EXTRA))
            # The fresh-session price uses the fresh prompt's own length, so a
            # call that drops under a long-prompt threshold (Haiku 5.5 past
            # 100k) is priced at the normal rate.
            u_fresh += cost(fc, w(fc["k"], fc["p"], fc["v"], fc["fast"]))
            for k in MODELS:
                on_here[k] += units(wc, k)
                on_fresh[k] += units(fc, k)
        model = max(by_model, key=by_model.get) if by_model else ""
        turns.append({
            "t": round(prompts[idx]), "u": round(u_all), "h": round(min(u_hist, u_all)),
            "f": round(u_fresh),
            "n": len(tc), "subs": sum(1 for c in tc if c["sub"]), "out": out_tok,
            "ctx": ctx0, "k": model,
            "on": {k: round(v) for k, v in on_here.items()},
            "onf": {k: round(v) for k, v in on_fresh.items()},
        })

# Is the newest turn still running?  The mod knows (busy); the transcript
# agrees when its newest main reply has not ended the turn yet.
live = busy or (last_main is not None and last_main.get("stop") not in ("end_turn", "stop_sequence", "max_tokens", "refusal")
                and turns and last_main["t"] >= turns[-1]["t"])
if turns:
    turns[-1]["live"] = bool(live)

# Growth per turn: the context at the start of a turn, minus the one before,
# skipping turns with an auto-compact in between.  Median of the last 8.
growth = []
for a, b in zip(turns, turns[1:]):
    if any(a["t"] <= ct < b["t"] for ct, _, _ in compactions):
        continue
    if a["ctx"] and b["ctx"] and b["ctx"] > a["ctx"]:
        growth.append(b["ctx"] - a["ctx"])
grow = median(growth[-8:]) if growth else 0

ses = None
if main_path or mine:
    since = since5h or 0
    win_calls = [c for c in mine if c["t"] >= since]
    all_on = {k: round(sum(units(c, k) for c in win_calls)) for k in MODELS}
    t5 = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0, "messages": 0, "units": 0}
    for c in win_calls:
        t5["input"] += c["i"]; t5["output"] += c["o"]; t5["cache_write"] += c["w"]; t5["cache_read"] += c["r"]
        t5["messages"] += 1
    t5["units"] = round(sum(units(c) for c in win_calls))
    hour_all = sum(units(c) for c in CALLS if c["t"] >= now - 3600)
    hour_me = sum(units(c) for c in mine if c["t"] >= now - 3600)
    ses = {
        "since5h": t5, "allOn": all_on, "base": base, "grow": round(grow),
        "turns": turns[-80:], "turnCount": len(turns),
        "turnsIn5h": sum(1 for t in turns if t["t"] >= since),
        "share1h": round(hour_me / hour_all, 4) if hour_all > 0 else None,
        "hourUnits": round(hour_all),
        "compactions": len([c for c in compactions if c[2] == "auto"]),
        "compactionsAll": len(compactions),
        "lastCompact": compactions[-1][0] if compactions else None,
        "lastSeen": last_main["t"] if last_main else None,
        # A prompt cache belongs to one model: the mod compares this with the
        # model you are on now to know whether the cache is still yours.
        "lastModel": (last_main["k"] + ("-" + last_main["v"] if last_main["v"] else "")) if last_main else None,
        "subagentCalls": sum(1 for c in mine if c["sub"]),
    }
out["_session"] = ses
out["_which"] = "session" if main_path else "none"
out["_compactAt"] = round(median(auto_pre[-6:])) if auto_pre else None
out["_fit"] = fit
out["_weights"] = {k: [round(x, 5) for x in w(k, 0)] for k in MODELS}
# Long-prompt tier per family (current version): the threshold and the weights
# past it, so the mod prices a reload or a model switch at the context's real
# length (a 200k-token Haiku 5.5 reload pays 5x).
out["_long"] = {k: {"over": LONG[(k, DEFAULT[k])][0], "w": [round(x, 5) for x in w(k, float("inf"))]}
                for k in MODELS if (k, DEFAULT[k]) in LONG}
out["_handoff"] = {"extra": HANDOFF_EXTRA, "noteOut": HANDOFF_NOTE_OUT}

# ---------------------------------------------------------------------------
# Ledger: one record per finished window.  The meter figure is the last
# reading seen, and the units are counted only up to that same moment: work
# done after the last reading moved the meter unseen, so counting it would
# make a percent look bigger than it was (and a later window look shrunk).
# A tick with almost no local work behind it is "outside use" (claude.ai
# chat or the phone app's own chats: the meter moved, nothing here did).
# ---------------------------------------------------------------------------
def outside(kind, resets_at, per1):
    lst = sorted([s for s in samples if s.get("kind") == kind and s.get("resetsAt") == resets_at], key=lambda s: s["at"])
    if per1 <= 0:
        return 0
    odd = 0
    for a, b in zip(lst, lst[1:]):
        dp = b["pct"] - a["pct"]
        if dp <= 0:
            continue
        u = sum(list_units(c) for c in calls_between(cut(a), cut(b)))
        if u < 0.25 * per1 * dp:
            odd += dp
    return odd


new_rows = []
for (kind, ra), (st, en) in sorted(closing.items(), key=lambda kv: kv[1][0]):
    lst = [s for s in samples if s.get("kind") == kind and s.get("resetsAt") == ra]
    top = max(lst, key=lambda s: s["pct"])
    tot = totals(st, min(en, cut(top)))
    mu = sorted(tot["models"].items(), key=lambda kv: -kv[1]["units"])
    models = [key_of(m).capitalize() for m, v in mu if tot["units"] and v["units"] / tot["units"] >= 0.1]
    # per exact model id, so the audit can re-price each version on its own
    by_model = {}
    for m, v in tot["models"].items():
        bm = by_model.setdefault(m, [0, 0, 0, 0, 0])
        for j, f_ in enumerate(("input", "output", "cache_write", "cache_read", "cache_write_5m")):
            bm[j] += v[f_]
    # per 1% in list units (the fixed yardstick)
    per1 = tot["listUnits"] / top["pct"] if top["pct"] > 0 else 0
    new_rows.append({
        "kind": kind, "resetsAt": ra, "start": st, "end": en, "pct": top["pct"], "seen": top["at"],
        "units": tot["listUnits"], "per1": round(per1) if per1 else None,
        "tokens": [tot["input"], tot["output"], tot["cache_write"], tot["cache_read"]], "byModel": by_model,
        "models": sorted(set(models), key=models.index), "outside": outside(kind, ra, per1),
        "weights": "list", "at": now, "readings": len(lst), "rule": RULE,
    })
out["_ledgerNew"] = new_rows

# Limit check: units per 1% in this 5H window against your usual range
# (finished 5H windows that reached 20%+, so the per-1% figure means something).
# Compared at the CURRENT weights (fitted per model when there are enough
# ticks), recomputed from each row's per-model tokens, so a Fable-heavy window
# and an Opus-heavy one are measured with the same ruler.
def row_units(r):
    bm = r.get("byModel")
    if not bm:
        return r.get("units") or 0
    tot = 0.0
    # keys are model ids, "#long" for calls billed at a long-prompt price
    # (older rows: family names, priced on that family's usual version)
    for m, t in bm.items():
        fam = key_of(m)
        if not fam:
            continue
        # [input, output, cache write, cache read, of the writes 5-minute] (older rows: 4 numbers)
        ww = w(fam, float("inf") if "#long" in m else 0, ver_of(m) or None, "#fast" in m)
        tot += cost({"i": t[0], "o": t[1], "w": t[2], "r": t[3], "w5": t[4] if len(t) > 4 else 0}, ww)
    return tot


rebuilt = {(r["kind"], r["resetsAt"]) for r in new_rows}
kept = [r for r in ledger if (r.get("rule") or 0) >= RULE and (r.get("kind"), r.get("resetsAt")) not in rebuilt]
full = [r for r in kept + new_rows if r.get("kind") == "five_hour" and (r.get("pct") or 0) >= 20]
vals = sorted(row_units(r) / r["pct"] for r in full if row_units(r) > 0)
chk = None
if starts and since5h:
    cur = out.get(str(int(since5h)))
    cur_s = [s for s in samples if s.get("kind") == "five_hour" and abs(win_bounds("five_hour", s.get("resetsAt"))[0] - since5h) < 120]
    cur_pct = max([s["pct"] for s in cur_s] or [0])
    # Count work only up to the newest reading, the same rule as the ledger:
    # anything after it has not shown on the meter yet.
    cur_at = max([cut(s) for s in cur_s if s["pct"] == cur_pct] or [now])
    cur = totals(since5h, cur_at) if cur_s else cur
    per1_now = cur["units"] / cur_pct if cur and cur_pct > 0 else None
    if vals:
        q = lambda p: vals[min(len(vals) - 1, max(0, int(round(p * (len(vals) - 1)))))]
        lo_, hi_ = (q(0.25), q(0.75)) if len(vals) >= 4 else (vals[0], vals[-1])
    else:
        lo_ = hi_ = None
    rs = cur_s[0]["resetsAt"] if cur_s else None
    chk = {"per1": round(per1_now) if per1_now else None, "pct": cur_pct, "lo": round(lo_) if lo_ else None, "hi": round(hi_) if hi_ else None, "n": len(vals), "weights": fit["source"],
           "outside": outside("five_hour", rs, (cur["listUnits"] / cur_pct) if cur and cur_pct > 0 else 0) if rs else 0}
out["_check"] = chk
# ---------------------------------------------------------------------------
# Save this scan's meter readings to the shared tick log, under an exclusive
# lock: read the newest log, add a reading only if its window's percent went
# up, write, release.  Other sessions wait their turn for these few
# milliseconds, so no reading is ever lost.  The time is kept to the
# fraction of a second, so "work up to this reading" never drops a reply
# that landed in the same second.
# ---------------------------------------------------------------------------
def sample_of(kind, ra, pct):
    st = win_bounds(kind, ra)[0] if ra else now - SPAN[kind]
    t = totals(st, now)
    models = {m: [v["input"], v["output"], v["cache_write"], v["cache_read"]] for m, v in t["models"].items()}
    return {"at": now, "ts": 2, "kind": kind, "pct": pct, "lu": t["listUnits"], "fresh": t["input"] + t["output"] + t["cache_write"],
            "resetsAt": ra, "mix": [t["input"], t["output"], t["cache_write"], t["cache_read"]], "models": models}


if SAMPLES_FILE:
    os.makedirs(data_dir, exist_ok=True)
    with open(LOCK_FILE, "a+") as lk:
        lock(lk)
        try:
            exists = os.path.exists(SAMPLES_FILE)
            log = read_log() if exists else clean(given.get("samples") or [])
            top = {}
            for s in log:
                k = (s.get("kind"), s.get("resetsAt") or "")
                top[k] = max(top.get(k, -1), s.get("pct", -1))
            add = [sample_of(kind, ra, pct) for kind, ra, pct in readings
                   if kind in SPAN and pct > top.get((kind, ra or ""), -1)]
            log += add
            # Older than 30 days is no use (its transcripts are gone): rewrite
            # without it once in a while; otherwise just append.
            keep = [s for s in log if s.get("at", 0) >= now - 30 * 86400][-3000:]
            if not exists or len(keep) < len(log):
                tmp = SAMPLES_FILE + ".tmp"
                with open(tmp, "w") as f:
                    for s in keep:
                        f.write(json.dumps(s, separators=(",", ":")) + "\n")
                os.replace(tmp, SAMPLES_FILE)
                log = keep
            elif add:
                with open(SAMPLES_FILE, "a") as f:
                    for s in add:
                        f.write(json.dumps(s, separators=(",", ":")) + "\n")
            samples = clean(log)
            out["_samplesFile"] = True
        finally:
            unlock(lk)
    out["_samples"] = samples

out["_unpriced"] = unpriced  # model id -> calls left out (not in the price table)
out["_history"] = {"full": _hfull, "days": {k: _hdays[k] for k in sorted(_hdays)[-HIST_SEND:]}}
out["_ticks"] = len(samples)
print(json.dumps(out))
