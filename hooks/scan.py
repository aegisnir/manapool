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
token at list price.  The per-model weights start at API list prices and
move toward what your own meter ticks measure, a little more with every
tick; the per-token-type weights stay at list prices (see "Token-type
weights" below).
"""
import csv, glob, hashlib, json, math, os, re, sys, time

# File locking: fcntl on macOS and Linux, msvcrt on Windows.
try:
    import fcntl

    def lock(f):
        fcntl.flock(f, fcntl.LOCK_EX)

    def unlock(f):
        fcntl.flock(f, fcntl.LOCK_UN)

    def try_lock(f):
        """Take the lock only if it is free right now (never wait)."""
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False
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

    def try_lock(f):
        f.seek(0)
        try:
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
from bisect import bisect_left, bisect_right
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
starts, session_id, since5h, now, busy, export = [], "", 0.0, 0.0, False, ""
backfill = False  # --backfill: build the daily history from every transcript once (slow; run in the background)
claim = ""  # --claim=<name>|<value>: claim a once-only alert across sessions (see below)
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
    elif a.startswith("--claim="):
        claim = a.split("=", 1)[1]
    elif a.startswith("--export="):
        export = os.path.expanduser(a.split("=", 1)[1])
    else:
        starts.append(float(a))
if not now:
    now = datetime.now(timezone.utc).timestamp()

# --claim=<name>|<value>: a once-only alert (the 5H "runs out" notification,
# once per window) claimed across every open session.  Under the shared file
# lock: read claims.json, and if <name> already holds <value> another session
# sent it ("claimed": false); otherwise write it and this session sends it.
# The mod's own store has no way to check and write in one step, so two
# sessions could both see "not sent yet" and both notify.  Returns before
# any transcript is read: a few milliseconds.
if claim:
    name_, _, value_ = claim.partition("|")
    got_ = False
    if data_dir:
        os.makedirs(data_dir, exist_ok=True)
        cf = os.path.join(data_dir, "claims.json")
        with open(os.path.join(data_dir, "lock"), "a+") as lk:
            lock(lk)
            try:
                try:
                    with open(cf) as f:
                        held = json.load(f)
                except Exception:
                    held = {}
                if held.get(name_) != value_:
                    held[name_] = value_
                    tmp = f"{cf}.{os.getpid()}.tmp"
                    with open(tmp, "w") as f:
                        json.dump(held, f)
                    os.replace(tmp, cf)
                    got_ = True
            finally:
                unlock(lk)
    print(json.dumps({"claimed": got_}))
    sys.exit(0)

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
# page, platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-09;
# Mythos added 2026-11-18: each version at its Fable twin's price).
# Versions of one family can differ a lot (Fable 5.2 is 20% cheaper than 5.1,
# Sonnet 5.5 reads cache at half Sonnet 5's price), so each call is priced on
# the exact version it ran on.
# Units: dollars divided by $2 (Sonnet 5.5 input), so 1 unit = 1 Sonnet input token.
# ---------------------------------------------------------------------------
PRICES = {
    ("mythos", "5.2"): (8, 40, 16, 0.20),
    ("mythos", "5.1"): (10, 50, 20, 0.25),
    ("mythos", "5"): (10, 50, 20, 1.00),
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
NEWEST = {"mythos": "5.2", "fable": "5.2", "opus": "5.5", "sonnet": "5.5", "haiku": "5.5"}
UNIT_DOLLARS = 2.0
MODELS = ["mythos", "fable", "opus", "sonnet", "haiku"]
# A fresh session that takes over through a handoff note does not start from
# the bare system prompt: it also reads the note and re-reads a few files.
# Assumed allowance, in tokens (see the manual: "fresh session").
HANDOFF_EXTRA = 15000
# Output tokens the old session spends writing the handoff note.
HANDOFF_NOTE_OUT = 3000


def key_of(model):
    m = (model or "").lower()
    # Mythos is priced per version (5, 5.1, 5.2).  A Mythos with no listed
    # price (Mythos Preview, a newer version) is left out and listed, like any
    # unknown model, never priced as Fable or as another version.
    if "mythos" in m:
        return "mythos" if ("mythos", ver_of(m)) in PRICES else ""
    # A known family on a version the price table does not list (a new one,
    # or an old id with no version) is left out and listed too: pricing it as
    # the newest version would be a guess.
    for fam in ("fable", "opus", "haiku", "sonnet"):
        if fam in m:
            return fam if (fam, ver_of(m)) in PRICES else ""
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


# Fast mode right now, and on which family: set once the transcripts are read
# (the newest main-thread reply of this session).  Used by re-pricing only.
FAST_NOW, FAST_FAM = False, ""

# Fitted multipliers per token type (K) and per model (MM); 1.0 = list price.
K = [1.0, 1.0, 1.0, 1.0]
MM = {k: 1.0 for k in MODELS}
# The version each family is re-priced on ("what if this ran on Opus"): the
# newest one you have actually used, filled in after the transcripts are read.
DEFAULT = dict(NEWEST)


def w(model_key, prompt, ver=None, fast=False):
    """Unit weight per token type for one call on model_key (model weight
    applied; token types at list, K = 1).  Both cache-write kinds take K[2]."""
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
        # Re-priced as a forecast: fast exactly when fast mode is on NOW (the
        # newest main reply ran fast) and on the family it is on (fast mode
        # belongs to the model it was turned on for).  One source for every
        # forecast, so after switching fast mode on or off the next turn
        # does not read double or half for a few turns.
        ww = w(model_key, c["p"], fast=FAST_NOW and model_key == FAST_FAM)
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
            "elsewhere_pct", "last_reading", "weights", "recorded"]
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
# 4: 5-minute cache writes priced apart (rule-3 rows priced every write as
#    the 1-hour kind, so the same work read up to 37.5% bigger)
# 3: exact reading times; 2 had the whole-second cutoff
# The History pane applies the same filter (register.tsx LEDGER_RULE: keep equal).
RULE = 4
# The rule a row's "outside" (elsewhere) count was made under.  A row from an
# older one is rebuilt while its readings and transcripts are on disk, and
# kept as it is otherwise (unlike RULE, an old count does not drop the row).
# 2: 0.7.1: window start counts as a reading, 1-point rounding ticks left
#    out, weighed by the work here
# 3: 0.7.7: a call already running at a reading counts towards it (LONGEST)
ORULE = 3
# A row is also redone when the log holds a higher reading for its window
# than the row used (a session saved its reading after another session had
# already closed the window).
top_pct = {}
for s in samples:
    k = (s.get("kind"), s.get("resetsAt"))
    top_pct[k] = max(top_pct.get(k, -1), s.get("pct", -1))
done = {(r.get("kind"), r.get("resetsAt")) for r in ledger
        if (r.get("rule") or 0) >= RULE and (r.get("orule") or 1) >= ORULE
        and (r.get("pct") or 0) >= top_pct.get((r.get("kind"), r.get("resetsAt")), -1)}
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
#   e: elsewhere, in list units: meter movement with no local work behind it
#      (see elsewhere_ticks).  Absent on days with none, and on days before
#      the field existed.
# Kept in <data folder>/history.json.  Days the normal scan reaches are rebuilt
# on every scan (it sees every call of those days); older days stay as they
# were, so the file is the only place their history survives once Claude Code
# deletes old transcripts.  Numbers and project folder names, never
# conversation text.
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
    """The model's name in the History pane (its own colour per name)."""
    m = (model or "").lower()
    return "mythos" if "mythos" in m else (key_of(m) or "other")


def day_of(t):
    """Local calendar day and hour of an epoch time."""
    d = datetime.fromtimestamp(t)
    return d.strftime("%Y-%m-%d"), d.hour


def day_start(t):
    """Epoch of the first local midnight at or after t.  The next midnight is
    found by stepping the calendar date, not by adding 24 hours: a day with a
    daylight-saving change is 23 or 25 hours long."""
    d = datetime.fromtimestamp(t)
    mid = d.replace(hour=0, minute=0, second=0, microsecond=0)
    if mid.timestamp() >= t:
        return mid.timestamp()
    return datetime.combine(mid.date() + timedelta(days=1), mid.time()).timestamp()


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


def hist_merge(fresh, replace_from=None, fill_only=False, early=None):
    """Fold fresh day buckets into history.json under the shared lock.
    replace_from: days on or after this key are replaced (the normal scan saw
    all of them); fill_only: only days the file lacks are added (backfill),
    and the file is marked complete.  early: elsewhere fields (e, s, es) for
    days before replace_from, set once on a day that has none yet (the first,
    partly covered day of the scan; never overwritten, since a later scan
    sees less of it).  Returns the file's days."""
    def add_early(days):
        for k, v in (early or {}).items():
            b = days.setdefault(k, {"m": {}, "p": {}, "h": [0] * 24, "r": 0, "n": 0})
            if "s" not in b:
                b.update(v)
    if not HIST_FILE:
        add_early(fresh)
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
                add_early(days)
            keep = sorted(days)[-HIST_KEEP:]
            days = {k: days[k] for k in keep}
            tmp = f"{HIST_FILE}.{os.getpid()}.tmp"
            with open(tmp, "w") as f:
                f.write(json.dumps({"v": HIST_V, "full": full, "days": days}, separators=(",", ":")))
            os.replace(tmp, HIST_FILE)
            return days, full
        finally:
            unlock(lk)


# The backfill runs once per computer, not once per open session:
# - backfill.lock: held for the whole run.  A session that finds it taken
#   says "busy" and leaves (another session is already doing it).  A file of
#   its own, so the shared `lock` (readings, history) is never held for the
#   seconds a backfill takes.
# - backfill.json: {"fails": n, "next": epoch}.  Written BEFORE the run as if
#   it will fail, removed when it succeeds, so a run that crashes or is killed
#   (its 10-minute timeout) counts as a failure too.  No session starts
#   another before "next"; the wait doubles with each failure (1 minute up to
#   a day).  The normal scan reports "next" (_backfillNext), so a session
#   learns it without starting a process.
BF_LOCK = os.path.join(data_dir, "backfill.lock") if data_dir else ""
BF_FILE = os.path.join(data_dir, "backfill.json") if data_dir else ""
BF_MAX_WAIT = 86400


def bf_state():
    try:
        with open(BF_FILE) as f:
            got = json.load(f)
        return int(got.get("fails") or 0), float(got.get("next") or 0)
    except Exception:
        return 0, 0.0


if backfill:
    lk_ = None
    if BF_LOCK:
        os.makedirs(data_dir, exist_ok=True)
        lk_ = open(BF_LOCK, "a+")
        if not try_lock(lk_):
            print(json.dumps({"backfill": "busy"}))
            sys.exit(0)
        fails_, next_ = bf_state()
        if next_ > now:
            print(json.dumps({"backfill": "wait", "next": next_}))
            sys.exit(0)
        with open(BF_FILE, "w") as f:
            json.dump({"fails": fails_ + 1, "next": now + min(BF_MAX_WAIT, 60 * 2 ** fails_)}, f)
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
    if BF_FILE:
        try:
            os.remove(BF_FILE)  # done: no back-off left
        except OSError:
            pass
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
            # Appended to = bigger than last time with the same start.  A file
            # that changed without growing was rewritten in place (somewhere
            # past the fingerprint, perhaps), so it is read again in full.
            grown = bool(e) and st_.st_size > e["size"] and head_hash(fh, e["hlen"]) == e["head"]
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
        # when this reply first appeared (its first streamed copy): the call
        # was running from then on (see LONGEST)
        c["t0"] = min(t, prev.get("t0", prev["t"])) if prev is not None else t
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
            prev["t0"] = min(prev.get("t0", prev["t"]), t)
        if c["main"] and (last_main is None or t >= last_main["t"]):
            last_main = c

compactions.sort()
auto_pre = [pre for _, pre in sorted(auto)]
if last_main is not None:
    FAST_NOW, FAST_FAM = bool(last_main["fast"]), last_main["k"]

# Daily history: every day from the first midnight the scan fully covers.
_cover = day_start(oldest)
_fresh = roll([c for c in calls.values() if c["t"] >= _cover])
# Saved further down, once the Elsewhere share of each day is known.

CALLS = sorted(calls.values(), key=lambda c: c["t"])
# Just the times, in the same order, so calls_between can binary-search them.
CALL_TS = [c["t"] for c in CALLS]
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
# Meter ticks (5H only: it moves often enough).  A tick = two readings in a
# row of the same window; its local work is every call between them.  They
# feed the model weights below.
# ---------------------------------------------------------------------------
def calls_between(a, b):
    # Calls with a < time <= b.  CALLS is sorted by time, so binary search
    # finds both ends directly instead of walking the whole list; this runs
    # thousands of times per scan, and the walk had become most of the scan.
    return CALLS[bisect_right(CALL_TS, a):bisect_right(CALL_TS, b)]


# ---------------------------------------------------------------------------
# Elsewhere: meter movement with no work here behind it (cloud sessions,
# claude.ai chat, the phone app, other computers: the meter moved, nothing
# here did).  Found here, before the weight fits, so the fits can leave those
# ticks out (they would credit the cloud's points to the models used here).
# Only lumpy ticks count.  Elsewhere use that runs alongside work here moves
# the meter the same way a smaller limit would, so it stays in the limit
# check instead.  The ledger and history.json keep the field name "outside".
# Everything here is in list units (plain list prices): it never depends on
# the fits, so finding it first changes nothing else.
# ---------------------------------------------------------------------------
def median(a):
    a = sorted(a)
    if not a:
        return 0.0
    n = len(a)
    return a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2


# Running total of list units over CALLS: the list units of any time range is
# two binary searches and a subtraction, not a walk over the calls.
_LU = [0.0]
for c in CALLS:
    _LU.append(_LU[-1] + list_units(c))


def running_at(t):
    """List units of the calls already running at time t: first logged at or
    before t, finished after it (see LONGEST)."""
    return sum(list_units(c) for c in CALLS[bisect_right(CALL_TS, t):bisect_right(CALL_TS, t + LONGEST)]
               if c.get("t0", c["t"]) <= t)


def lu_between(a, b):
    """List units of the calls with a < time <= b (calls_between's range)."""
    return _LU[bisect_right(CALL_TS, b)] - _LU[bisect_right(CALL_TS, a)]


def lu_from(a, b):
    """List units of the calls with a <= time <= b (totals' range)."""
    return _LU[bisect_right(CALL_TS, b)] - _LU[bisect_left(CALL_TS, a)]


# Every window's readings, oldest first, grouped once.
WIN = {}
for s in samples:
    if s.get("kind") in SPAN and s.get("resetsAt"):
        WIN.setdefault((s["kind"], s["resetsAt"]), []).append(s)
for _l in WIN.values():
    _l.sort(key=lambda s: s["at"])


# Work per 1% counts only the points the work here moved: the points moved
# elsewhere are in the meter but not in the work, so leaving them in would
# make a window used partly in the cloud look like a smaller limit (one gap
# shown twice, as elsewhere and as "buys less").  Rows keep the plain figure
# (per1, pct, outside), so this is worked out where it is used, old rows too
# (register.tsx herePts: keep equal).
def here_pts(r):
    return (r.get("pct") or 0) - (r.get("outside") or 0)


def per1_or_usual(kind, per1):
    """per1, or when there is none the ledger's usual (median) list units per
    1% of work here for windows of this kind."""
    if per1 > 0:
        return per1
    return median([r["per1"] * r["pct"] / here_pts(r) for r in ledger
                   if r.get("kind") == kind and r.get("per1") and here_pts(r) >= 3])


# A tick is only elsewhere when this computer was quiet around it.  The meter
# lags the work and shows whole points: a reading can show 0% after work has
# started, and during heavy work the meter catches up in jumps of several
# points within a minute, often with little work in that tick itself.  And
# use elsewhere at the same time as work here cannot be told apart from that
# (or from a smaller limit) anyway.  So the work of the QUIET seconds before a
# tick counts towards it, and so does under a point of rounding carried from
# earlier (the meter shows whole points: 4.9 points of work reads 4% until a
# little more work makes it 5%, however long that takes).  Work older than
# that has shown on the meter already, so a long stretch of work here cannot
# hide use elsewhere after it.  On real data every tick flagged without this
# was under 5 minutes long with points of work here just before it.
CARRY_ROUND = 0.95  # points
QUIET = 900         # seconds
# A reply is logged several times while it streams; the scan keeps the last
# copy's time (when it finished), but the meter counts the call while it
# runs.  A long call (a big cache rewrite, a long answer) can move the meter
# minutes before it finishes: on 2026-11-18 a 1.2M-unit call that started
# 61 s before a 2-point jump and finished 98 s after it made the jump look
# like use elsewhere.  So a call already running at a reading (its first
# copy at or before the reading, its last after) counts towards that tick,
# for this test only (it still belongs to the next tick everywhere else).
# Only calls finishing within LONGEST of the reading are looked at.
LONGEST = 1800      # seconds


def elsewhere_ticks(kind, resets_at, per1, fam=None):
    """[(tick start, reading time, % moved)] for each tick whose move has
    under a quarter of the work here it would take, counting work carried
    from earlier ticks (per1: list units per 1% in this window).
    A window starts at 0%, so its start counts as a reading: use before the
    first reading here (a cloud session while no session was open here, say)
    is tested like any other tick.  resetsAt sits on a 10-minute grid, so the
    start is at most 10 minutes early, and work in those minutes counts as
    work here.  On 7D every quiet night ticks 1 point of rounding, so 7D
    needs 2."""
    lst = WIN.get((kind, resets_at)) or []
    if per1 <= 0 or not lst:
        return []
    st, _ = win_bounds(kind, resets_at)
    if st and lst[0]["at"] > st:
        lst = [{"at": st, "pct": 0, "ts": 1}] + lst
    # The carry is worked out at the usual figure when it is higher: a window
    # used partly elsewhere has a figure too low until that use is found, and
    # at a too-low figure the work here would seem to cover more points than
    # it did, which then hides the use elsewhere.  "Usual" is for windows run
    # mostly on the same model (fam): list prices weigh models unlike the
    # meter does, so a Fable window buys about half the list units per 1% of
    # an Opus one, and an all-model usual would switch the carry off there.
    pc = max(per1, usual(kind, fam))
    odd, carry = [], 0.0
    for a, b in zip(lst, lst[1:]):
        # before `oldest` the scan has not read the calls, so no work would
        # show and every tick would look like elsewhere
        if a["at"] < oldest:
            carry = 0.0
            continue
        dp = b["pct"] - a["pct"]
        own = lu_between(cut(a), cut(b))
        # work of the quiet seconds before the tick (not before the window:
        # that work belongs to the last window's meter)
        near = lu_between(max(st, cut(a) - QUIET), cut(a)) if st else 0.0
        ahead = running_at(cut(b))
        if dp > 0 and carry + near + own + ahead < 0.25 * per1 * dp and (kind == "five_hour" or dp >= 2):
            odd.append((a["at"], b["at"], dp))
            left = carry + own  # these points were not this work's
        else:
            left = max(0.0, carry + own - pc * max(dp, 0))
        carry = min(left, CARRY_ROUND * pc)
    return odd


_USUAL = {}


def usual(kind, fam=None):
    """The usual list units per 1% of work here: the ledger's median over
    windows run mostly on model family `fam` (3 or more of them), else over
    all windows of this kind, or with no ledger yet (a new install) the
    median of the windows in the tick log."""
    if (kind, fam) not in _USUAL:
        same = [r["per1"] * r["pct"] / here_pts(r) for r in ledger
                if fam and r.get("kind") == kind and r.get("per1") and here_pts(r) >= 3
                and (r.get("models") or [""])[0].lower() == fam]
        if len(same) >= 3:
            _USUAL[(kind, fam)] = median(same)
            return _USUAL[(kind, fam)]
        u = per1_or_usual(kind, 0)
        if not u:
            own = []
            for (k, ra), lst in WIN.items():
                st, en = win_bounds(k, ra)
                top = max(lst, key=lambda x: x["pct"])
                if k == kind and st >= oldest and top["pct"] > 0:
                    own.append(lu_from(st, min(en, cut(top))) / top["pct"])
            u = median([p for p in own if p > 0])
        _USUAL[(kind, fam)] = u
    return _USUAL[(kind, fam)]


_FIT = {}


def else_fit(kind, resets_at):
    """(list units per 1%, elsewhere ticks) for one window, worked out once.
    The figure is the work here over the points the work here moved, not over
    the window's top reading: elsewhere points are in the top reading but not
    in the work, so dividing by the top would shrink the figure by the share
    used elsewhere (a window run to 30% in the cloud and 35% in all would
    weigh at 0.14x).  The elsewhere points depend on the figure and the
    figure on them, so this repeats until neither changes (a higher figure
    can only find more elsewhere, so it settles within a few rounds).  With
    under 3 points left to the work here the window has no figure of its
    own and uses the usual one."""
    key = (kind, resets_at)
    if key not in _FIT:
        lst = WIN.get(key) or []
        if not lst:
            _FIT[key] = (0, [])
            return _FIT[key]
        st, en = win_bounds(kind, resets_at)
        top = max(lst, key=lambda x: x["pct"])
        here = lu_from(st, min(en, cut(top)))
        # the model family with the most work here in this window
        by_fam = {}
        for c in CALLS[bisect_left(CALL_TS, st):bisect_right(CALL_TS, min(en, cut(top)))]:
            by_fam[c["k"]] = by_fam.get(c["k"], 0.0) + list_units(c)
        fam = max(by_fam, key=by_fam.get) if by_fam else None
        fallback = usual(kind, fam)
        p1 = here / top["pct"] if top["pct"] > 0 and here > 0 else fallback
        tk = elsewhere_ticks(kind, resets_at, p1, fam)
        for _ in range(12):
            left = top["pct"] - sum(t[2] for t in tk)
            new = here / left if left >= 3 and here > 0 else fallback
            if abs(new - p1) <= 1e-6 * max(1.0, p1):
                break
            p1 = new
            tk = elsewhere_ticks(kind, resets_at, p1, fam)
        _FIT[key] = (p1, tk)
    return _FIT[key]


def outside(kind, resets_at):
    return sum(t[2] for t in else_fit(kind, resets_at)[1])


# 5H ticks that are elsewhere, by (window, reading time), for the fits below.
ELSE_5H = {(ra, t[1]) for (k, ra) in WIN if k == "five_hour" and win_bounds(k, ra)[1] > oldest
           for t in else_fit(k, ra)[1]}


# Each tick: (dp, [list-weighted output, write(+input), read],
#             {model: the same three numbers for that model's calls}, start, end, calls)
# The three groups are the ones the token-type fit below scales (K), so the
# model fit can apply K first and measure only what K leaves unexplained.
ticks = []
for (kind_, ra), lst in WIN.items():
    if kind_ != "five_hour":
        continue
    for a, b in zip(lst, lst[1:]):
        dp = b["pct"] - a["pct"]
        # an elsewhere tick's points are not this work's: left out of the fits
        if dp <= 0 or a["at"] < oldest or (ra, b["at"]) in ELSE_5H:
            continue
        x = [0.0, 0.0, 0.0]
        per_model = {}
        n_calls = 0
        for c in calls_between(cut(a), cut(b)):
            L = price(c["k"], c["v"], c["p"], c.get("fast", False))
            g = (c["o"] * L[1],
                 (c["w"] - c["w5"]) * L[2] + c["w5"] * L[4] + c["i"] * L[0],
                 c["r"] * L[3])
            pm = per_model.setdefault(c["k"], [0.0, 0.0, 0.0])
            for j in range(3):
                x[j] += g[j]
                pm[j] += g[j]
            n_calls += 1
        ticks.append((dp, x, per_model, a["at"], b["at"], n_calls))

# Token-type weights (K) stay at list prices.  Up to 0.7.4 a fit tried to
# measure them from single ticks, gated by R² 0.5; it never passed (894 of
# 937 real ticks move exactly 1 point, so a tick holds no signal), and it
# ignored the model weights, so on real data it would have priced cache reads
# near 0.  A replay on whole windows (2026-11-18, checked independently)
# found cache reads cannot yet be told apart from the model weights: Fable
# work is mostly output, Opus work mostly reads, so "reads are cheap" and
# "Fable costs more" explain the meter equally well, and adding K did not
# predict held-out windows better.  K stays at 1.0 until that changes; the
# manual and README say so (see "How accurate").
fit = {"source": "list", "ticks": len(ticks), "K": [1, 1, 1, 1], "MM": dict(MM), "model_ticks": {}}
usable = [t for t in ticks if sum(t[1]) > 0]
# ---------------------------------------------------------------------------
# Model multipliers: how much each model moves the 5H meter per list-price
# unit, relative to your average tick (1.0x = what its list price says).
# Self-correcting, so it gets better on its own as ticks come in:
# - Pooled, not per tick.  A model's rate is all its meter movement divided by
#   all its work, over ticks done 85%+ on that model.  One tick carries up to
#   a reply of slop, so single ticks scatter widely (a fast model like Fable
#   ticks every 1 to 3 minutes); adding them up averages that out.
# - Blended toward list price while the evidence is thin.  The measured value
#   is pulled toward 1.0x by how uncertain it is (starting belief: within
#   about 2x of list).  More ticks, less uncertainty, closer to the measured
#   value.  No on/off threshold, so nothing jumps.
# - Recent ticks count more (30-day half-life), so if Anthropic changes how
#   the plan weighs a model, the estimate follows within weeks.
# - Ticks are kept in ticks.json for 180 days, so the estimate survives
#   Claude Code deleting transcripts after about 30 days.  A tick rebuilt
#   from fewer calls than the kept copy (one of its transcripts was deleted)
#   does not replace it: the kept copy is the complete one.
# Measured on units with the token-type weights K already applied, so a model
# whose work is mostly cache reads is not given a second adjustment for what
# K already accounts for.  Ticks keep their three token groups, not one total,
# so the current K applies to old ticks too.
# ---------------------------------------------------------------------------
TICKS_FILE = os.path.join(data_dir, "ticks.json") if data_dir else ""
TICK_V = 2  # 2: [start, end, % moved, {model: [output, write+input, read]}, calls]; 1 kept list totals only
TICK_KEEP_DAYS = 180
SEVEN_KEEP_DAYS = 120  # 7D readings in the tick log
FIVE_KEEP_DAYS = 120   # 5H readings too: the History pane's 5H windows chart draws 90 days of climbs
HALF_LIFE_DAYS = 30
PRIOR_SD = math.log(2)   # starting belief: a model's weight is within ~2x of list
TICK_SD_FLOOR = 0.4      # a single tick is at least ~40% off (one reply of slop)
DOMINANT = 0.85          # a tick counts for a model when 85%+ of its work was on it


def tick_merge(fresh):
    """Fold this scan's ticks into ticks.json under the shared lock.  A tick
    this scan rebuilt replaces the stored copy unless it saw fewer calls
    (a contributing transcript is gone); older ones come from the file.
    Returns every kept tick as
    [start, end, % moved, {model: [output, write+input, read]}, calls]."""
    rows = {f"{a:.3f}|{b:.3f}": [a, b, dp, {k: [round(v, 1) for v in g] for k, g in pm.items()}, n]
            for dp, x, pm, a, b, n in fresh}
    if not TICKS_FILE:
        return sorted(rows.values())
    try:
        os.makedirs(data_dir, exist_ok=True)
        with open(LOCK_FILE, "a+") as lk:
            lock(lk)
            try:
                try:
                    with open(TICKS_FILE) as f:
                        got = json.load(f)
                    if got.get("v") != TICK_V:
                        got = {}
                except Exception:
                    got = {}
                kept = {f"{t[0]:.3f}|{t[1]:.3f}": t for t in got.get("ticks") or [] if len(t) == 5}
                for key, t in rows.items():
                    old = kept.get(key)
                    if old is None or t[4] >= old[4]:
                        kept[key] = t
                rows = kept
                floor_ = now - TICK_KEEP_DAYS * 86400
                out = sorted((t for t in rows.values() if t[1] >= floor_), key=lambda t: (t[0], t[1]))
                tmp = f"{TICKS_FILE}.{os.getpid()}.tmp"
                with open(tmp, "w") as f:
                    f.write(json.dumps({"v": TICK_V, "ticks": out}, separators=(",", ":")))
                os.replace(tmp, TICKS_FILE)
                return out
            finally:
                unlock(lk)
    except Exception:
        return sorted(rows.values(), key=lambda t: (t[0], t[1]))  # a locked or unwritable file: use this scan's ticks


all_ticks = tick_merge(usable)
# Ticks kept from earlier scans may be ones now found elsewhere: leave them
# out too (the tick log keeps them; this is decided again every scan).
_else_ends = {t for _, t in ELSE_5H}
all_ticks = [t for t in all_ticks if t[1] not in _else_ends]
pool = {k: [] for k in MODELS}  # per model: (weight, % moved, K-weighted units)
ref_y = ref_x = 0.0
for a, b, dp, groups, _n in all_ticks:
    # output, write+input, read, each times its token-type factor
    pm = {k: g[0] * K[1] + g[1] * K[2] + g[2] * K[3] for k, g in groups.items()}
    tot = sum(pm.values())
    if tot <= 0 or dp <= 0:
        continue
    wt = 0.5 ** (max(0.0, now - b) / 86400 / HALF_LIFE_DAYS)
    ref_y += wt * dp
    ref_x += wt * tot
    k, v = max(pm.items(), key=lambda kv: kv[1])
    if k in pool and v / tot >= DOMINANT:
        pool[k].append((wt, dp, tot))
ref = ref_y / ref_x if ref_x > 0 else 0.0
# Anchor: every model is measured against Opus (Opus = 1.0x), not against the
# average of whatever was used recently.  Against the average, every weight
# moved whenever the mix moved: on two weeks of real data Fable went 1.58x ->
# 1.76x and Opus 0.74x -> 0.84x between the halves while Fable/Opus held at
# 2.15 -> 2.09.  A fixed ruler keeps stored figures comparable across weeks;
# the shape of every chart and every cost on the band (a percent, re-measured
# each window) is the same either way.  Opus has the most ticks for most users;
# with under ANCHOR_MIN Opus ticks it falls back to the average.
ANCHOR_MIN = 15
_op = pool.get("opus") or []
fit["anchor"] = "average"
if len(_op) >= ANCHOR_MIN:
    _sx = sum(wt * x for wt, y, x in _op)
    if _sx > 0 and sum(wt * y for wt, y, x in _op) > 0:
        ref = sum(wt * y for wt, y, x in _op) / _sx
        fit["anchor"] = "opus"
fit["measured"] = {}
fit["kept"] = len(all_ticks)
for k in MODELS:
    rows_ = pool[k]
    n = len(rows_)
    fit["model_ticks"][k] = n
    if n < 3 or ref <= 0:
        continue  # too few to say anything: list price
    sy = sum(wt * y for wt, y, x in rows_)
    sx = sum(wt * x for wt, y, x in rows_)
    rk = sy / sx
    if rk <= 0:
        continue
    # Uncertainty of the pooled rate (ratio estimator), as a share of it, never
    # below what n ticks of ~40% slop each can promise.
    n_eff = sum(wt for wt, y, x in rows_) ** 2 / sum(wt * wt for wt, y, x in rows_)
    var = sum((wt * (y - rk * x)) ** 2 for wt, y, x in rows_) / sx ** 2 * n / (n - 1)
    se = max(math.sqrt(var) / rk, TICK_SD_FLOOR / math.sqrt(n_eff))
    raw = math.log(rk / ref)
    trust = PRIOR_SD ** 2 / (PRIOR_SD ** 2 + se ** 2)  # 0 = list price, 1 = measured
    post, post_se = raw * trust, math.sqrt(trust) * se
    MM[k] = min(4.0, max(0.25, math.exp(post)))
    fit["measured"][k] = {"x": round(rk / ref, 3), "ticks": n, "used": round(MM[k], 3), "trust": round(trust, 2),
                          "lo": round(math.exp(post - 1.645 * post_se), 3), "hi": round(math.exp(post + 1.645 * post_se), 3)}
fit["MM"] = {k: round(v, 3) for k, v in MM.items()}
if any(v != 1.0 for v in MM.values()):
    fit["source"] = "fit-models"

# ---------------------------------------------------------------------------
# Limit by time (the History pane): how much work 1% of 5H holds, by weekday
# and 4-hour block of local time.  Answers "is my limit bigger at night or on
# weekends?"
# - From the kept ticks (180 days), not windows: a 5H window can span a
#   morning and an afternoon, a tick almost never does.
# - Work is model-adjusted (the same weights the costs use), or a slot where
#   you happened to use Fable would look like a smaller limit when it is only
#   a pricier model.
# - Left out: ticks longer than 90 minutes or crossing a block (they belong
#   to two slots), and ticks with almost no local work behind them (outside
#   use: claude.ai or the phone app moved the meter, not this computer).
# - Pooled per slot (all work over all % moved) with a 90% range, so a slot
#   with few ticks says so instead of looking certain.
# ---------------------------------------------------------------------------
BT_MAX_MIN = 90
BT_BLOCK_H = 4


def by_time(ticks_):
    rows = []
    for a, b, dp, groups, _n in ticks_:
        if dp <= 0 or b - a > BT_MAX_MIN * 60:
            continue
        da, db = datetime.fromtimestamp(a), datetime.fromtimestamp(b)
        if da.date() != db.date() or da.hour // BT_BLOCK_H != db.hour // BT_BLOCK_H:
            continue
        u = sum((g[0] * K[1] + g[1] * K[2] + g[2] * K[3]) * MM.get(k, 1.0) for k, g in groups.items())
        rows.append((da.weekday(), da.hour // BT_BLOCK_H, dp, u, da.date()))
    if not rows:
        return None
    mid = median([u / dp for _w, _b, dp, u, _d in rows])
    rows = [r for r in rows if r[3] >= 0.25 * mid * r[2]]  # outside use, the ledger's rule
    if not rows:
        return None
    every = sum(r[3] for r in rows) / sum(r[2] for r in rows)
    # how many separate days each weekday row pools (the chart's right edge):
    # a row is every Monday in the kept ticks, not one date
    days = [len({r[4] for r in rows if r[0] == wd}) for wd in range(7)]
    cells = {}
    for wd, blk, dp, u, _d in rows:
        cells.setdefault((wd, blk), []).append((dp, u))
    grid = [[None] * (24 // BT_BLOCK_H) for _ in range(7)]
    for (wd, blk), lst in cells.items():
        n = len(lst)
        sy = sum(dp for dp, u in lst)
        rk = sum(u for dp, u in lst) / sy
        # ratio estimator's spread, as in the model weights above; one tick is
        # at least ~40% off, so a slot never claims more than its count allows
        var = sum((u - rk * dp) ** 2 for dp, u in lst) / sy ** 2 * n / (n - 1) if n > 1 else rk ** 2
        se = max(math.sqrt(var), rk * TICK_SD_FLOOR / math.sqrt(n))
        grid[wd][blk] = {"per1": round(rk), "n": n, "pct": round(sy, 1), "err": round(1.645 * se)}
    return {"per1": round(every), "ticks": len(rows), "block": BT_BLOCK_H, "grid": grid, "days": days}


out_by_time = by_time(all_ticks)

# ---------------------------------------------------------------------------
# Window totals.
# ---------------------------------------------------------------------------
def totals(a, b=None, pred=None):
    r = {"input": 0, "output": 0, "cache_write": 0, "cache_write_5m": 0, "cache_read": 0, "messages": 0, "units": 0.0, "listUnits": 0.0, "models": {}}
    # Calls with a <= time <= b, found by binary search on the sorted times
    # (see calls_between) instead of checking every call on every use.
    lo = bisect_left(CALL_TS, a)
    hi = len(CALLS) if b is None else bisect_right(CALL_TS, b)
    for c in CALLS[lo:hi]:
        if pred and not pred(c):
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
        # The newest main reply ran in fast mode: the mod prices a reload or a
        # hand-off on this model at the fast price (FAST times every price).
        "fast": bool(last_main and last_main["fast"]),
        "fastX": FAST,
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
# Each row also counts its elsewhere points ("outside", see else_fit).
# ---------------------------------------------------------------------------
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
        "models": sorted(set(models), key=models.index), "outside": outside(kind, ra),
        "weights": "list", "at": now, "readings": len(lst), "rule": RULE, "orule": ORULE,
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
full = [r for r in kept + new_rows if r.get("kind") == "five_hour" and here_pts(r) >= 20]
vals = sorted(row_units(r) / here_pts(r) for r in full if row_units(r) > 0)
# Limit size (the History pane): each finished 5H window's work per 1% of
# work here, at the CURRENT model weights (as the Limit check above).  At
# plain list prices a window run mostly on Fable buys about half the units of
# an Opus one (the meter weighs Fable ~1.7x and Opus ~0.8x its list price),
# so model mix read as a shrinking limit.  Keyed by resetsAt.  Only windows
# with SIZE_MIN+ points of work here: the meter shows whole points and reads
# about a quarter point above zero work, so on real data windows of 1 to 2
# points read ~40% low and 3 to 7 points ~15% low; from 8 the spread is the
# limit's own (5 to 7%).
SIZE_MIN = 8
out["_limitSize"] = {r["resetsAt"]: round(row_units(r) / here_pts(r)) for r in kept + new_rows
                     if r.get("kind") == "five_hour" and here_pts(r) >= SIZE_MIN and row_units(r) > 0}


def row_mix(r):
    """Each model family's share of a window's work, in whole percent, at the
    same weights as row_units (so the shares are how much of the limit each
    model used, not its list price).  Families under 1% are left out."""
    fam_u = {}
    for m, t in (r.get("byModel") or {}).items():
        fam = key_of(m)
        if not fam:
            continue
        ww = w(fam, float("inf") if "#long" in m else 0, ver_of(m) or None, "#fast" in m)
        fam_u[fam] = fam_u.get(fam, 0.0) + cost({"i": t[0], "o": t[1], "w": t[2], "r": t[3], "w5": t[4] if len(t) > 4 else 0}, ww)
    tot = sum(fam_u.values())
    if tot <= 0:
        return {}
    return {f.capitalize(): round(u / tot * 100) for f, u in sorted(fam_u.items(), key=lambda kv: -kv[1]) if u / tot >= 0.01}


# Model mix per 5H window (the 5H windows tooltip), keyed by resetsAt.  Only
# rows with transcripts behind them (byModel), and only mixed windows: a
# one-model window says so already in its model list.
out["_limitMix"] = {r["resetsAt"]: mx for r in kept + new_rows
                    if r.get("kind") == "five_hour" for mx in [row_mix(r)] if len(mx) > 1}
chk = None
if starts and since5h:
    cur = out.get(str(int(since5h)))
    cur_s = [s for s in samples if s.get("kind") == "five_hour" and abs(win_bounds("five_hour", s.get("resetsAt"))[0] - since5h) < 120]
    cur_pct = max([s["pct"] for s in cur_s] or [0])
    # Count work only up to the newest reading, the same rule as the ledger:
    # anything after it has not shown on the meter yet.
    cur_at = max([cut(s) for s in cur_s if s["pct"] == cur_pct] or [now])
    cur = totals(since5h, cur_at) if cur_s else cur
    rs = cur_s[0]["resetsAt"] if cur_s else None
    odd_now = outside("five_hour", rs) if rs else 0
    per1_now = cur["units"] / (cur_pct - odd_now) if cur and cur_pct - odd_now > 0 else None
    if vals:
        q = lambda p: vals[min(len(vals) - 1, max(0, int(round(p * (len(vals) - 1)))))]
        lo_, hi_ = (q(0.25), q(0.75)) if len(vals) >= 4 else (vals[0], vals[-1])
    else:
        lo_ = hi_ = None
    chk = {"per1": round(per1_now) if per1_now else None, "pct": cur_pct, "herePct": cur_pct - odd_now, "lo": round(lo_) if lo_ else None, "hi": round(hi_) if hi_ else None, "n": len(vals), "weights": fit["source"],
           "outside": odd_now}
out["_check"] = chk
# % of 5H per work unit for the band's costs: the points the work here moved,
# over that work counted up to the newest reading (the ledger's rule).  Work
# after the reading has not shown on the meter yet; counting it made every
# cost read low.  None under SIZE_MIN points: too coarse (see _limitSize), so
# the mod keeps the last window's rate until then.
out["_rate5"] = None
if chk and cur and chk["herePct"] >= SIZE_MIN and cur["units"] > 0:
    out["_rate5"] = chk["herePct"] / cur["units"]

# Elsewhere per day, in history.json:
#   e: elsewhere list units: each elsewhere tick's % moved times its
#      window's list units per 1%, on the day of the reading that showed it.
#      Same rule and per-1% figure as the ledger, so the band's "elsewhere"
#      and the History pane agree.
#   s: meter readings taken that day.  None means elsewhere was not
#      measured that day: it can only show between two readings.
#   es: when a tick counted that day started on an earlier day (use while no
#      session was open here), the earliest such start, so the pane can say
#      "since Sat".
# 5H ticks first.  Then 7D ticks, for whole 5H windows used elsewhere that
# reset before a session here read the meter: a 7D jump of 2+ points that the
# work here (allowing one point of it still on its way) does not explain,
# after taking off what 5H ticks in the same span already counted, so nothing
# is counted twice.  The 7D meter moves in whole points and every quiet night
# moves it 1 (rounding of the work before it), so the jump must leave 2.
# Days before _cover (the first, partly covered day) are not rebuilt; their
# elsewhere fields go to `_early`, set once (hist_merge).  Only readings and
# ticks from `oldest` on count, where the scan has every call.
_early = {}


def _day(t):
    if t >= _cover:
        return _fresh.setdefault(day_of(t)[0], {"m": {}, "p": {}, "h": [0] * 24, "r": 0, "n": 0})
    return _early.setdefault(day_of(t)[0], {})


def _count(a_at, b_at, units):
    b = _day(b_at)
    b["e"] = b.get("e", 0) + round(units)
    if day_of(a_at)[0] != day_of(b_at)[0]:
        b["es"] = min(b.get("es") or a_at, a_at)


for s in samples:
    if s.get("kind") == "five_hour" and s.get("at", 0) >= oldest:
        b = _day(s["at"])
        b["s"] = b.get("s", 0) + 1

_caught = []  # (tick start, reading time, list units) of each 5H elsewhere tick
for (kind_, ra) in WIN:
    if kind_ != "five_hour" or win_bounds(kind_, ra)[1] <= oldest:
        continue
    p1, tk = else_fit(kind_, ra)
    for a_at, b_at, dp in tk:
        _caught.append((a_at, b_at, dp * p1))
        _count(a_at, b_at, dp * p1)


def _seen(a, b):
    """5H elsewhere units inside the 7D span (a, b].  A 5H tick that runs past
    either end counts by the share of it inside (when in it the use happened
    is unknown), so each is counted once across the 7D spans."""
    tot = 0.0
    for t0, t1, u in _caught:
        lo, hi = max(t0, a), min(t1, b)
        if hi > lo:
            tot += u * (hi - lo) / (t1 - t0) if t1 > t0 else u
    return tot


for (kind_, ra), lst in WIN.items():
    if kind_ != "seven_day" or win_bounds(kind_, ra)[1] <= oldest:
        continue
    p7 = else_fit(kind_, ra)[0]
    if p7 <= 0:
        continue
    st, _ = win_bounds(kind_, ra)
    if lst[0]["at"] > st:
        lst = [{"at": st, "pct": 0, "ts": 1}] + lst
    for a, b in zip(lst, lst[1:]):
        dp = b["pct"] - a["pct"]
        if dp < 2 or a["at"] < oldest:
            continue
        here = lu_between(cut(a), cut(b))
        if here - p7 >= 0.25 * p7 * dp:
            continue
        left = dp - (here + _seen(a["at"], b["at"])) / p7
        if left >= 2:
            _count(a["at"], b["at"], left * p7)
_hdays, _hfull = hist_merge(_fresh, replace_from=day_of(_cover)[0], early=_early)
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
            # Readings are kept 120 days, then dropped (the file is rewritten
            # once in a while; otherwise just appended to).  5H readings past
            # 29 days have no transcripts behind them: everything that counts
            # work (ledger, elsewhere, the fits) stops at `oldest`, so they only
            # draw the History pane's 5H windows chart and 5H pace's usual
            # range.  7D readings let 7D pace compare this week with past ones.
            # About 80 5H readings a day: the cap only stops a runaway file.
            keep5 = [s for s in log if s.get("kind") != "seven_day" and s.get("at", 0) >= now - FIVE_KEEP_DAYS * 86400][-20000:]
            keep7 = [s for s in log if s.get("kind") == "seven_day" and s.get("at", 0) >= now - SEVEN_KEEP_DAYS * 86400][-2000:]
            keep = sorted(keep5 + keep7, key=lambda s: s.get("at", 0))
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
    # A finished window's readings go out slimmed to time, percent and window:
    # the mod reads the heavy fields (work per model) only for the current
    # windows, and 120 days of full readings would be megabytes on every scan.
    out["_samples"] = [s if not s.get("resetsAt") or s.get("kind") not in SPAN or win_bounds(s["kind"], s["resetsAt"])[1] > now
                       else {"at": s["at"], "ts": s.get("ts", 2), "kind": s["kind"], "pct": s["pct"], "resetsAt": s["resetsAt"]}
                       for s in samples] if SAMPLES_FILE else samples

out["_unpriced"] = unpriced  # model id -> calls left out (not in the price table)
out["_history"] = {"full": _hfull, "days": {k: _hdays[k] for k in sorted(_hdays)[-HIST_SEND:]}}
# When the next backfill may start (0: now), so a session waits out a failed one.
out["_backfillNext"] = bf_state()[1] if BF_FILE and not _hfull else 0
out["_byTime"] = out_by_time
out["_ticks"] = len(samples)
print(json.dumps(out))
