"""Tests for hooks/scan.py on synthetic transcripts.

Each test builds a throwaway ~/.claude/projects with hand-made transcript
lines, runs the scanner with HOME pointed at it, and checks the numbers.
Nothing outside a temporary folder is read or written.

Run from the repository root:  python3 tests/test_scan.py
(or pass the path to a scan.py to test another copy)."""
import json, os, re, subprocess, sys, tempfile, shutil
from datetime import datetime, timezone

SCAN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "scan.py")
# The scanner honours CLAUDE_CONFIG_DIR; the tests set HOME instead.
BASE_ENV = {k: v for k, v in os.environ.items() if k != "CLAUDE_CONFIG_DIR"}
NOW = 1_800_000_000  # fixed clock
fails = 0
# The ledger rule the scanner builds rows under now (rows below it are rebuilt).
RULE_NOW = int(re.search(r"^RULE = (\d+)", open(SCAN).read(), re.M).group(1))


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")


def asst(t, mid, model, i=0, o=0, w=0, r=0, side=False, w5=0, fast=False):
    """One assistant reply as Claude Code logs it.  w5 = how much of the cache
    write w was the 5-minute kind (the rest is the 1-hour kind)."""
    u = {"input_tokens": i, "output_tokens": o, "cache_creation_input_tokens": w, "cache_read_input_tokens": r,
         "cache_creation": {"ephemeral_5m_input_tokens": w5, "ephemeral_1h_input_tokens": w - w5}}
    if fast:
        u["speed"] = "fast"
    return {"type": "assistant", "timestamp": iso(t), "isSidechain": side,
            "message": {"id": mid, "model": model, "stop_reason": "end_turn", "usage": u}}


def user(t, text="hi"):
    return {"type": "user", "timestamp": iso(t), "message": {"role": "user", "content": text}}


def run(files, args, stdin=None, order=None):
    home = tempfile.mkdtemp()
    proj = os.path.join(home, ".claude", "projects", "p")
    os.makedirs(proj)
    for name in (order or files):
        with open(os.path.join(proj, name), "w") as f:
            for rec in files[name]:
                f.write(json.dumps(rec, separators=(",", ":")) + "\n")
        os.utime(os.path.join(proj, name), (NOW, NOW))
    env = dict(BASE_ENV, HOME=home)
    out = subprocess.run([sys.executable, "-I", SCAN, *map(str, args), f"--now={NOW}"],
                         input=json.dumps(stdin or {}), capture_output=True, text=True, env=env)
    shutil.rmtree(home)
    if out.returncode != 0:
        raise SystemExit(out.stderr)
    return json.loads(out.stdout)


def check(name, got, want, tol=0.5):
    global fails
    ok = abs(got - want) <= tol if isinstance(want, (int, float)) and got is not None else got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}: got {got}, want {want}")
    fails += 0 if ok else 1


# 1. Ledger: 1,000 units by a reading of 20%, then 1,000 more after it.
#    Units per 1% must come from the work up to the reading: 1000 / 20 = 50.
end = NOW - 600                      # window ended 10 minutes ago
st = end - 5 * 3600
reading = st + 3600
resets = iso(end)
files = {"s.jsonl": [user(st + 60), asst(st + 120, "m1", "claude-sonnet-5-5", i=1000),
                     asst(reading + 600, "m2", "claude-sonnet-5-5", i=1000)]}
samples = [{"at": st + 30, "kind": "five_hour", "pct": 0, "resetsAt": resets},
           {"at": reading, "kind": "five_hour", "pct": 20, "resetsAt": resets}]
d = run(files, [NOW - 3600], {"samples": samples, "ledger": []})
row = d["_ledgerNew"][0]
check("ledger units per 1% counts only work up to the last reading", row["per1"], 50)

# 2. Forked history: the same reply in a parent and a forked child transcript.
#    Each session must count its turn, whichever file is read first.
t0 = NOW - 1200
shared = [user(t0), asst(t0 + 5, "same-id", "claude-sonnet-5-5", i=10, o=100, w=5000)]
fork = {"aaaa.jsonl": shared, "bbbb.jsonl": shared}
for sid in ("aaaa", "bbbb"):
    for order in (["aaaa.jsonl", "bbbb.jsonl"], ["bbbb.jsonl", "aaaa.jsonl"]):
        d = run(fork, [NOW - 3600, f"--session-id={sid}", f"--since5h={NOW - 3600}"], order=order)
        check(f"fork: session {sid}, files written {order[0][:4]} first, turns", d["_session"]["turnCount"], 1)
check("fork: global total counts the reply once", d[str(NOW - 3600)]["messages"], 1)

# 3. Prices per exact version (units = dollars / $2 per million).
cases = [
    ("Haiku 5.5 over 100k prompt pays 5x", "claude-haiku-5-5", dict(i=150_000), 150_000 * 0.10 * 5 / 2),
    ("Haiku 5.5 under 100k", "claude-haiku-5-5", dict(i=90_000), 90_000 * 0.10 / 2),
    ("Haiku 5.5 long via cache read", "claude-haiku-5-5", dict(i=10, r=120_000), (10 * 0.10 + 120_000 * 0.01) * 5 / 2),
    ("Sonnet 5.5 cache read $0.10", "claude-sonnet-5-5", dict(r=1_000_000), 0.10 * 1_000_000 / 2),
    ("Sonnet 5 cache read $0.20", "claude-sonnet-5", dict(r=1_000_000), 0.20 * 1_000_000 / 2),
    ("Fable 5.2 output $40", "claude-fable-5-2", dict(o=1000), 40 * 1000 / 2),
    ("Fable 5.1 output $50", "claude-fable-5-1", dict(o=1000), 50 * 1000 / 2),
    ("Haiku 4.5 (dated id) input $1", "claude-haiku-4-5-20251001", dict(i=1000), 1 * 1000 / 2),
    ("Opus 4 (dated id) input $15", "claude-opus-4-20250514", dict(i=1000), 15 * 1000 / 2),
    ("1M-context id suffix", "claude-opus-5-5[1m]", dict(i=1000), 4 * 1000 / 2),
]
for name, model, tok, want in cases:
    d = run({"x.jsonl": [asst(NOW - 60, "c", model, **tok)]}, [NOW - 3600])
    check(name, d[str(NOW - 3600)]["listUnits"], want, tol=1)

# 4. Re-pricing "on Fable" follows the Fable version you used last.
d = run({"x.jsonl": [user(NOW - 300), asst(NOW - 290, "f", "claude-fable-5-1", o=1000)]},
        [NOW - 3600, "--session-id=x", f"--since5h={NOW - 3600}"])
check("what-if Fable uses the version you last used (5.1)", d["_weights"]["fable"][1], 25, tol=0.01)

# 5. Live limit check: work after the newest reading is left out.
st5 = NOW - 2 * 3600
res5 = iso(st5 + 5 * 3600)
files = {"x.jsonl": [asst(st5 + 60, "a", "claude-sonnet-5-5", i=1000),
                     asst(st5 + 3000, "b", "claude-sonnet-5-5", i=1000)]}
samples = [{"at": st5 + 10, "kind": "five_hour", "pct": 0, "resetsAt": res5},
           {"at": st5 + 600, "kind": "five_hour", "pct": 20, "resetsAt": res5}]
d = run(files, [st5, f"--since5h={st5}"], {"samples": samples, "ledger": []})
check("live check units per 1% stops at the newest reading", d["_check"]["per1"], 50)


# ---------------- round 2 ----------------
def home_with(files):
    home = tempfile.mkdtemp()
    proj = os.path.join(home, ".claude", "projects", "p")
    os.makedirs(proj)
    for name, recs in files.items():
        with open(os.path.join(proj, name), "w") as f:
            for rec in recs:
                f.write(json.dumps(rec, separators=(",", ":")) + "\n")
        os.utime(os.path.join(proj, name), (NOW, NOW))
    return home


def run_in(home, args, stdin=None, wait=True):
    env = dict(BASE_ENV, HOME=home)
    pr = subprocess.Popen([sys.executable, "-I", SCAN, *map(str, args)], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    if not wait:
        pr.stdin.write(json.dumps(stdin or {})); pr.stdin.close()
        return pr
    o, e = pr.communicate(json.dumps(stdin or {}))
    if pr.returncode != 0:
        raise SystemExit(e)
    return json.loads(o)


# 6. Race: 12 sessions save readings 1%..12% for the same window at once.
#    The shared log must end at 12% and never lose the highest reading.
res = iso(NOW + 3600)
home = home_with({"x.jsonl": [asst(NOW - 60, "a", "claude-sonnet-5-5", i=10)]})
dd = os.path.join(home, "data")
run_in(home, [NOW - 3600, f"--data-dir={dd}", f"--reading=five_hour|{res}|0", f"--now={NOW}"])
procs = [run_in(home, [NOW - 3600, f"--data-dir={dd}", f"--reading=five_hour|{res}|{p}", f"--now={NOW + p}"], wait=False)
         for p in range(1, 13)]
for pr in procs:
    pr.wait()
log = [json.loads(l) for l in open(os.path.join(dd, "samples.jsonl"))]
check("race: highest of 12 parallel readings kept", max(s["pct"] for s in log), 12)
check("race: every line of the shared log is whole JSON", len(log) >= 2, True)
shutil.rmtree(home)

# 7. A ledger row from the old rule (100 per 1%) is rebuilt to 50 and the
#    old figure no longer feeds the limit check.
end = NOW - 600; st = end - 5 * 3600; reading = st + 3600; resets = iso(end)
files = {"s.jsonl": [user(st + 60), asst(st + 120, "m1", "claude-sonnet-5-5", i=1000),
                     asst(reading + 600, "m2", "claude-sonnet-5-5", i=1000)]}
samples = [{"at": st + 30, "kind": "five_hour", "pct": 0, "resetsAt": resets},
           {"at": reading, "kind": "five_hour", "pct": 20, "resetsAt": resets}]
old_row = {"kind": "five_hour", "resetsAt": resets, "start": st, "end": end, "pct": 20, "seen": reading,
           "units": 2000, "per1": 100, "tokens": [2000, 0, 0, 0], "byModel": {"sonnet": [2000, 0, 0, 0]},
           "models": ["Sonnet"], "outside": 0, "weights": "list", "at": end, "readings": 2}
d = run(files, [NOW - 3600], {"samples": samples, "ledger": [old_row]})
check("old ledger row rebuilt: units per 1%", d["_ledgerNew"][0]["per1"] if d["_ledgerNew"] else None, 50)

# 8. Fractional reading time: a reply at .250 is inside a reading taken at .900.
end = NOW - 600; st = end - 5 * 3600; rt = st + 3600 + 0.9; resets = iso(end)
rep_ = asst(0, "m1", "claude-sonnet-5-5", i=1000); rep_["timestamp"] = iso(st + 3600)[:-1] + ".250Z" if "." not in iso(st + 3600) else iso(st + 3600)
files = {"s.jsonl": [rep_]}
samples = [{"at": st + 30, "kind": "five_hour", "pct": 0, "resetsAt": resets}, {"at": rt, "kind": "five_hour", "pct": 10, "resetsAt": resets}]
d = run(files, [NOW - 3600], {"samples": samples, "ledger": []})
check("reply at .250 counted for a reading at .900", d["_ledgerNew"][0]["units"], 1000)

# 9. Version switch in one family: two Haiku 4.5 turns, now on Haiku 5.5.
#    Next-turn re-pricing must use Haiku 5.5 prices (10x cheaper input).
t0 = NOW - 600
files = {"h.jsonl": [user(t0), asst(t0 + 5, "a", "claude-haiku-4-5-20251001", i=10_000),
                     user(t0 + 60), asst(t0 + 65, "b", "claude-haiku-4-5-20251001", i=10_000)]}
d = run(files, [NOW - 3600, "--session-id=h", f"--since5h={NOW - 3600}", "--model=claude-haiku-5-5"])
check("Haiku 4.5 turn re-priced on Haiku 5.5 (warm: prompt read at 5.5 read price; 4.5 would be 500)", d["_session"]["turns"][-1]["on"]["haiku"], 10_000 * 0.01 / 2)
check("cache owner names the version", d["_session"]["lastModel"], "haiku-4.5")

# 10. Cold turn: history re-written instead of read.  The warm baseline
#     ("on") moves that history to cache reads, so the mod's one-time
#     re-cache is not counted twice.
t0 = NOW - 7200
files = {"c.jsonl": [user(t0), asst(t0 + 5, "a", "claude-sonnet-5-5", w=10_000),
                     user(NOW - 300), asst(NOW - 295, "b", "claude-sonnet-5-5", w=100_000 + 10_000 - 10_000 + 0, r=0)]}
# turn 2: context 100k, base 10k: history 90k was written (cold), not read
files["c.jsonl"][3]["message"]["usage"]["cache_creation_input_tokens"] = 100_000
d = run(files, [NOW - 3600 * 3, "--session-id=c", f"--since5h={NOW - 3600 * 3}"])
t2 = d["_session"]["turns"][-1]
check("cold turn: as it ran (writes 100k)", t2["u"], 100_000 * 4 / 2)
check("cold turn: warm baseline reads the whole 100k prompt (start included)", t2["on"]["sonnet"], 100_000 * 0.10 / 2)

# 11. Haiku 5.5 hand-off: a 150k prompt is long-priced here, but the fresh
#     session's prompt (base + 15k allowance) is under 100k: normal price.
t0 = NOW - 600
files = {"k.jsonl": [user(t0), asst(t0 + 5, "a", "claude-haiku-5-5", w=5_000),
                     user(t0 + 60), asst(t0 + 65, "b", "claude-haiku-5-5", r=150_000)]}
d = run(files, [NOW - 3600, "--session-id=k", f"--since5h={NOW - 3600}"])
t2 = d["_session"]["turns"][-1]
check("Haiku fresh-session price below the long threshold", t2["f"], t2["onf"]["haiku"], tol=1)
check("Haiku fresh-session = 5k start + 15k allowance read, normal price", t2["f"], (5_000 + 15_000) * 0.01 / 2, tol=1)


# ---------------- round 3 ----------------
# 12. Legacy reading saved as a whole second: a reply 0.25 s into that second
#     belongs to it, so a rebuilt row counts both replies (2,000 units).
end = NOW - 600; st = end - 5 * 3600; rt = st + 3600; resets = iso(end)
r1 = asst(0, "m1", "claude-sonnet-5-5", i=1000); r1["timestamp"] = iso(st + 600)
r2 = asst(0, "m2", "claude-sonnet-5-5", i=1000); r2["timestamp"] = iso(rt)[:-1] + ".250Z"
samples = [{"at": st + 30, "kind": "five_hour", "pct": 0, "resetsAt": resets}, {"at": rt, "kind": "five_hour", "pct": 20, "resetsAt": resets}]
d = run({"s.jsonl": [r1, r2]}, [NOW - 3600], {"samples": samples, "ledger": []})
check("legacy whole-second reading keeps a same-second reply", d["_ledgerNew"][0]["units"], 2000)

# 13. A late, higher reading after the row was closed redoes the row.
r3 = asst(0, "m3", "claude-sonnet-5-5", i=1000); r3["timestamp"] = iso(rt + 600)
row = {"kind": "five_hour", "resetsAt": resets, "start": st, "end": end, "pct": 20, "seen": rt + 0.5,
       "units": 2000, "per1": 100, "tokens": [2000, 0, 0, 0], "byModel": {"claude-sonnet-5-5": [2000, 0, 0, 0]},
       "models": ["Sonnet"], "outside": 0, "weights": "list", "at": end, "readings": 2, "rule": RULE_NOW}
late = samples + [{"at": rt + 700.5, "kind": "five_hour", "pct": 40, "resetsAt": resets}]
d = run({"s.jsonl": [r1, r2, r3]}, [NOW - 3600], {"samples": late, "ledger": [row]})
new = d["_ledgerNew"][0] if d["_ledgerNew"] else {}
check("late 40% reading redoes a closed 20% row: pct", new.get("pct"), 40)
check("late 40% reading redoes a closed 20% row: units", new.get("units"), 3000)
d = run({"s.jsonl": [r1, r2, r3]}, [NOW - 3600], {"samples": samples, "ledger": [row]})
check("a row with no newer reading is left alone", len(d["_ledgerNew"]), 0)

# 14. Long-prompt tier exported for the mod (Haiku 5.5 past 100k).
d = run({"x.jsonl": [asst(NOW - 60, "c", "claude-haiku-5-5", i=10)]}, [NOW - 3600])
check("Haiku long tier threshold", d["_long"]["haiku"]["over"], 100_000)
check("Haiku long tier cache write = 5x", d["_long"]["haiku"]["w"][2], 0.20 * 5 / 2, tol=1e-6)


# ---------------- round 4 ----------------
# 15. First turn of a session, written cold: its forecast baseline is warm too.
t0 = NOW - 600
d = run({"f.jsonl": [user(t0), asst(t0 + 5, "a", "claude-sonnet-5-5", w=100_000)]},
        [NOW - 3600, "--session-id=f", f"--since5h={NOW - 3600}"])
t1 = d["_session"]["turns"][-1]
check("first turn: measured cost unchanged (100k written)", t1["u"], 100_000 * 4 / 2)
check("first turn: forecast baseline reads the 100k", t1["on"]["sonnet"], 100_000 * 0.10 / 2)

# 16. An exact new reading that happens to land on .000 is not stretched.
end = NOW - 600; st = end - 5 * 3600; rt = st + 3600; resets = iso(end)
q1 = asst(0, "m1", "claude-sonnet-5-5", i=1000); q1["timestamp"] = iso(st + 600)
q2 = asst(0, "m2", "claude-sonnet-5-5", i=1000); q2["timestamp"] = iso(rt)[:-1] + ".250Z"
exact = [{"at": st + 30, "ts": 2, "kind": "five_hour", "pct": 0, "resetsAt": resets},
         {"at": float(rt), "ts": 2, "kind": "five_hour", "pct": 20, "resetsAt": resets}]
d = run({"s.jsonl": [q1, q2]}, [NOW - 3600], {"samples": exact, "ledger": []})
check("exact .000 reading leaves out a reply 0.25 s later", d["_ledgerNew"][0]["units"], 1000)

# 17. A row built under rule 2 is rebuilt under the current rule.
row2 = {"kind": "five_hour", "resetsAt": resets, "start": st, "end": end, "pct": 20, "seen": rt,
        "units": 1000, "per1": 50, "tokens": [1000, 0, 0, 0], "byModel": {"claude-sonnet-5-5": [1000, 0, 0, 0]},
        "models": ["Sonnet"], "outside": 0, "weights": "list", "at": end, "readings": 2, "rule": 2}
legacy = [{"at": st + 30, "kind": "five_hour", "pct": 0, "resetsAt": resets},
          {"at": rt, "kind": "five_hour", "pct": 20, "resetsAt": resets}]
d = run({"s.jsonl": [q1, q2]}, [NOW - 3600], {"samples": legacy, "ledger": [row2]})
nr = d["_ledgerNew"][0] if d["_ledgerNew"] else {}
check("rule-2 row rebuilt under the current rule", nr.get("rule"), RULE_NOW)
check("rule-2 row rebuilt: legacy whole-second reading keeps the same-second reply", nr.get("per1"), 100)


# ---------------- cache lifetimes, fast mode, unknown models ----------------
# 18. A 5-minute cache write costs 1.25x input, a 1-hour one 2x.
d = run({"x.jsonl": [asst(NOW - 60, "a", "claude-sonnet-5-5", w=1000, w5=1000)]}, [NOW - 3600])
check("5-minute cache write at 1.25x input", d[str(NOW - 3600)]["listUnits"], 1000 * 2 * 1.25 / 2, tol=1)
d = run({"x.jsonl": [asst(NOW - 60, "a", "claude-sonnet-5-5", w=1000, w5=0)]}, [NOW - 3600])
check("1-hour cache write at 2x input", d[str(NOW - 3600)]["listUnits"], 1000 * 4 / 2, tol=1)

# 19. Fast mode doubles every price.
d = run({"x.jsonl": [asst(NOW - 60, "a", "claude-opus-5-5", o=1000, fast=True)]}, [NOW - 3600])
check("fast mode Opus 5.5 output at 2x", d[str(NOW - 3600)]["listUnits"], 1000 * 20 * 2 / 2, tol=1)

# 20. A model the price table does not know is left out and listed, not priced as Sonnet.
d = run({"x.jsonl": [asst(NOW - 60, "a", "claude-nova-1", o=1000), asst(NOW - 50, "b", "claude-sonnet-5-5", o=10)]}, [NOW - 3600])
check("unknown model left out of the totals", d[str(NOW - 3600)]["listUnits"], 10 * 10 / 2, tol=1)
check("unknown model listed as unpriced", d["_unpriced"].get("claude-nova-1"), 1)

# ---------------- incremental reading ----------------
# 21. With a data folder the scanner keeps what it read.  After a transcript
#     grows, shrinks or is rewritten, the cached result must equal a fresh
#     full read.
def scan_home(home, dd=None):
    args = [NOW - 3600, f"--now={NOW}"] + ([f"--data-dir={dd}"] if dd else [])
    return run_in(home, args)[str(NOW - 3600)]


def write(home, name, recs, mtime, mode="w", tail_=""):
    pth = os.path.join(home, ".claude", "projects", "p", name)
    with open(pth, mode) as f:
        for rec in recs:
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")
        f.write(tail_)
    os.utime(pth, (mtime, mtime))


home = home_with({})
dd = os.path.join(home, "data")
write(home, "g.jsonl", [asst(NOW - 300, "a", "claude-sonnet-5-5", i=100)], NOW - 200)
scan_home(home, dd)
write(home, "g.jsonl", [asst(NOW - 100, "b", "claude-sonnet-5-5", i=200)], NOW - 90, mode="a")
check("grown file: cached read = full read", scan_home(home, dd)["listUnits"], scan_home(home)["listUnits"])
check("grown file: both replies counted", scan_home(home, dd)["listUnits"], 300)
# a reply cut off mid-line is not counted until its line is complete
line = json.dumps(asst(NOW - 80, "c", "claude-sonnet-5-5", i=400), separators=(",", ":"))
write(home, "g.jsonl", [], NOW - 70, mode="a", tail_=line[:40])
check("half-written line not counted yet", scan_home(home, dd)["listUnits"], 300)
write(home, "g.jsonl", [], NOW - 60, mode="a", tail_=line[40:] + "\n")
check("completed line counted once", scan_home(home, dd)["listUnits"], 700)
# rewritten (shorter, different start): read again from the beginning
write(home, "g.jsonl", [asst(NOW - 50, "z", "claude-sonnet-5-5", i=5)], NOW - 40)
check("rewritten file: cached read = full read", scan_home(home, dd)["listUnits"], scan_home(home)["listUnits"])
check("rewritten file: only the new content", scan_home(home, dd)["listUnits"], 5)
os.remove(os.path.join(home, ".claude", "projects", "p", "g.jsonl"))
check("deleted file: nothing left from the cache", scan_home(home, dd)["listUnits"], 0)
shutil.rmtree(home)

# 22. CLAUDE_CONFIG_DIR moves Claude Code's folder; the scanner follows it.
home = tempfile.mkdtemp()
cfg = os.path.join(home, "elsewhere")
os.makedirs(os.path.join(cfg, "projects", "p"))
with open(os.path.join(cfg, "projects", "p", "x.jsonl"), "w") as f:
    f.write(json.dumps(asst(NOW - 60, "a", "claude-sonnet-5-5", i=123)) + "\n")
os.utime(os.path.join(cfg, "projects", "p", "x.jsonl"), (NOW, NOW))
out = subprocess.run([sys.executable, "-I", SCAN, str(NOW - 3600), f"--now={NOW}", "--plugin=manapool"],
                     input="{}", capture_output=True, text=True, env=dict(BASE_ENV, HOME=home, CLAUDE_CONFIG_DIR=cfg))
d = json.loads(out.stdout)
check("CLAUDE_CONFIG_DIR: transcripts found there", d[str(NOW - 3600)]["listUnits"], 123)
check("CLAUDE_CONFIG_DIR: data folder created there", os.path.exists(os.path.join(cfg, "plugins", "data", "manapool", "scan-cache.json")), True)
shutil.rmtree(home)

# ---------------- daily history (the History pane) ----------------
# 23. Days the scan covers are rebuilt each scan; older days come only from
#     the backfill and survive later scans.  A reply logged twice counts once,
#     the project is the session's folder.  Mythos has no price yet: it is
#     left out and listed as unpriced, never priced as Fable.
def with_cwd(rec, cwd):
    return dict(rec, cwd=cwd)


def local_day(t):
    return datetime.fromtimestamp(t).strftime("%Y-%m-%d")


home = home_with({})
dd = os.path.join(home, "data")
old_t = NOW - 20 * 86400               # out of the normal scan's reach
new_t = NOW - 600
write(home, "old.jsonl", [with_cwd(asst(old_t, "o1", "claude-sonnet-5-5", i=1000), "/x/alpha")], old_t + 10)
write(home, "new.jsonl", [with_cwd(asst(new_t, "n1", "claude-opus-5-5", i=100, r=1000), "/x/beta"),
                          with_cwd(asst(new_t + 1, "n1", "claude-opus-5-5", i=100, r=1000), "/x/beta"),  # streamed copy
                          with_cwd(asst(new_t + 5, "n2", "claude-mythos-5", i=10), "/x/beta"),
                          with_cwd(asst(new_t + 6, "n3", "claude-opus-5-5", i=10), "/x/beta/.claude/worktrees/wt1")],
      new_t + 10)
d = run_in(home, [NOW - 3 * 86400, f"--now={NOW}", f"--data-dir={dd}"])
h = d["_history"]
check("history: not complete before the backfill", h["full"], False)
check("history: old day not reached by a normal scan", local_day(old_t) in h["days"], False)
b = h["days"].get(local_day(new_t), {"m": {}, "p": {}, "r": 0, "n": 0})
# opus 5.5: input 4/2 = 2 units, cache read 0.2/2 = 0.1 unit per token
check("history: streamed reply counted once", b["m"].get("opus"), 100 * 2 + 1000 * 0.1 + 10 * 2)
check("history: re-reading = cache reads", b["r"], 100)
check("history: Mythos not priced as Fable", ("mythos" in b["m"], "fable" in b["m"]), (False, False))
check("history: Mythos listed as unpriced", d["_unpriced"].get("claude-mythos-5"), 1)
check("history: worktree counts as its repository", sorted(b["p"]), ["beta"])
check("history: calls", b["n"], 2)
run_in(home, ["--backfill", f"--data-dir={dd}"])
d = run_in(home, [NOW - 3 * 86400, f"--now={NOW}", f"--data-dir={dd}"])
h = d["_history"]
check("history: complete after the backfill", h["full"], True)
check("history: backfilled day kept by later scans", h["days"].get(local_day(old_t), {}).get("p"), {"alpha": 1000})  # sonnet 5.5 input = 1 unit
check("history: covered day unchanged by backfill", h["days"][local_day(new_t)]["n"], 2)
shutil.rmtree(home)

# ---------------- model weights: pooled, blended, kept ----------------
# Opus and Fable ticks in one 5H window.  Each tick is 1% of the meter; Opus
# does 2,000 units per 1%, Fable only 1,000 (so Fable moves the meter 2x per
# unit).  The work per tick scatters (one reply of slop), the totals do not.
def weight_case(n_opus, n_fable, start):
    res_ = iso(start + 5 * 3600)
    recs, smp, t, pct = [], [{"at": start, "kind": "five_hour", "pct": 0, "resetsAt": res_}], start, 0
    jitter = [0.5, 1.5, 0.8, 1.2]
    for i, (model, per1) in enumerate([("claude-opus-5-5", 2000)] * n_opus + [("claude-fable-5-1", 1000)] * n_fable):
        t += 60
        # opus 5.5 output = 10 units/token, fable 5.1 output = 25 units/token (list, 1 unit = Sonnet input)
        per_tok = 10 if "opus" in model else 25
        recs.append(asst(t, f"w{start}-{i}", model, o=round(per1 * jitter[i % 4] / per_tok)))
        t += 10
        pct += 1
        smp.append({"at": t, "kind": "five_hour", "pct": pct, "resetsAt": res_})
    return recs, smp

start = NOW - 4 * 3600
recs, smp = weight_case(20, 12, start)
home = home_with({"w.jsonl": recs})
dd = os.path.join(home, "data")
d = run_in(home, [start, f"--data-dir={dd}", f"--now={NOW}"], {"samples": smp, "ledger": []})
m = d["_fit"]["measured"]
check("weights: Fable/Opus measured from pooled ticks", m["fable"]["x"] / m["opus"]["x"], 2.0, tol=0.05)
check("weights: scattered ticks still trusted (12 ticks)", m["fable"]["trust"] > 0.8, True)
check("weights: used in costs follows the measurement", d["_fit"]["MM"]["fable"] / d["_fit"]["MM"]["opus"], 2.0, tol=0.15)
check("weights: range brackets the value used", m["fable"]["lo"] < d["_fit"]["MM"]["fable"] < m["fable"]["hi"], True)
check("weights: ticks kept in ticks.json", len(json.load(open(os.path.join(dd, "ticks.json")))["ticks"]), 32)
# Transcripts deleted (Claude Code removes old ones): the kept ticks still count.
os.remove(os.path.join(home, ".claude", "projects", "p", "w.jsonl"))
d2 = run_in(home, [start, f"--data-dir={dd}", f"--now={NOW}"], {"samples": smp, "ledger": []})
check("weights: kept ticks survive deleted transcripts", d2["_fit"]["measured"].get("fable", {}).get("x"), m["fable"]["x"], tol=0.001)
shutil.rmtree(home)

# Few ticks: the value used stays near list price; a model with under 3 ticks is left at 1.0x.
recs, smp = weight_case(20, 3, start)
home = home_with({"w.jsonl": recs})
d = run_in(home, [start, f"--now={NOW}"], {"samples": smp, "ledger": []})
f3 = d["_fit"]["measured"]["fable"]
check("weights: 3 ticks are blended toward list (used below measured)", d["_fit"]["MM"]["fable"] < f3["x"], True)
check("weights: Haiku with no ticks stays at list", d["_fit"]["MM"]["haiku"], 1.0, tol=0)
shutil.rmtree(home)

# ---------------- review fixes (v0.5.1) ----------------
def tick_case(spec, start):
    """Transcripts and readings for a run of 1% ticks.  spec: one list per
    tick of (file, model, token counts) for the calls in it."""
    res_ = iso(start + 5 * 3600)
    files_, smp, t, pct = {}, [{"at": start, "kind": "five_hour", "pct": 0, "resetsAt": res_}], start, 0
    for i, calls_ in enumerate(spec):
        t += 60
        for j, (fname, model, tok) in enumerate(calls_):
            files_.setdefault(fname, []).append(asst(t + j, f"k{start}-{i}-{j}", model, **tok))
        t += 10
        pct += 1
        smp.append({"at": t, "kind": "five_hour", "pct": pct, "resetsAt": res_})
    return files_, smp

# 24. Model weights are measured after the token-type fit, not on list prices
#     beside it.  The meter here counts a cache read 4x its list price and
#     treats Opus and Sonnet alike; each tick is 1,000 meter units.  Sonnet's
#     ticks are read-heavy, Opus's are not.  Measured on list units, Sonnet
#     would look ~1.6x Opus and pay the read factor twice.
#     (list units per token: Opus 5.5 in 2, out 10, read 0.1; Sonnet 5.5 in 1, out 5, read 0.05)
opus_t = [dict(o=80, i=100), dict(o=60, i=100, r=500), dict(o=70, i=50, r=500), dict(o=90, i=50)]
son_t = [dict(o=60, i=100, r=3000), dict(o=40, i=200, r=3000), dict(o=80, r=3000), dict(o=20, i=100, r=4000)]
spec = []
for i in range(8):
    spec += [[("a.jsonl", "claude-opus-5-5", opus_t[i % 4])], [("a.jsonl", "claude-sonnet-5-5", son_t[i % 4])]]
fl, smp = tick_case(spec, start)
d = run(fl, [start], {"samples": smp, "ledger": []})
check("token-type fit finds the 4x cache read", d["_fit"]["K"][3], 4.0, tol=0.01)
m = d["_fit"]["measured"]
check("model fit: no premium where there is none (Sonnet/Opus measured)", m["sonnet"]["x"] / m["opus"]["x"], 1.0, tol=0.02)
check("model fit: Sonnet used at 1.0x", d["_fit"]["MM"]["sonnet"], 1.0, tol=0.02)

# 25. Deleting one of two transcripts behind a tick keeps the complete copy.
#     Opus ticks are split across a.jsonl and b.jsonl; Fable ticks are all in
#     a.jsonl.  After b.jsonl is deleted, the Opus ticks must not shrink.
jit = [0.5, 1.5, 0.8, 1.2]
spec = [[("a.jsonl", "claude-opus-5-5", dict(o=round(100 * jit[i % 4]))),
         ("b.jsonl", "claude-opus-5-5", dict(o=round(100 * jit[i % 4])))] for i in range(20)]
spec += [[("a.jsonl", "claude-fable-5-1", dict(o=round(40 * jit[i % 4])))] for i in range(12)]
fl, smp = tick_case(spec, start)
home = home_with(fl)
dd = os.path.join(home, "data")
d = run_in(home, [start, f"--data-dir={dd}", f"--now={NOW}"], {"samples": smp, "ledger": []})
before = d["_fit"]["measured"]["fable"]["x"] / d["_fit"]["measured"]["opus"]["x"]
check("partial deletion: Fable/Opus before", before, 2.0, tol=0.05)
os.remove(os.path.join(home, ".claude", "projects", "p", "b.jsonl"))
d = run_in(home, [start, f"--data-dir={dd}", f"--now={NOW}"], {"samples": smp, "ledger": []})
check("partial deletion: Fable/Opus unchanged", d["_fit"]["measured"]["fable"]["x"] / d["_fit"]["measured"]["opus"]["x"], before, tol=0.001)
kept_t = json.load(open(os.path.join(dd, "ticks.json")))["ticks"]
check("partial deletion: kept Opus ticks still have both calls", min((t[4] if len(t) > 4 else 0) for t in kept_t if "opus" in t[3]), 2)
shutil.rmtree(home)

# 26. Rule-3 rows priced every cache write as the 1-hour kind.  One whose
#     transcripts remain is rebuilt; one that cannot be rebuilt stays out of
#     the limit check.
d = run({"s.jsonl": [q1, q2]}, [NOW - 3600], {"samples": legacy, "ledger": [dict(row2, rule=3)]})
nr = d["_ledgerNew"][0] if d["_ledgerNew"] else {}
check("rule-3 row rebuilt under the current rule", nr.get("rule"), RULE_NOW)
check("rule-3 row rebuilt: 5-minute writes kept apart", {len(v) for v in nr.get("byModel", {}).values()}, {5})
gone = dict(row2, resetsAt=iso(NOW - 3 * 86400), pct=30)
for rule, n in ((3, 0), (RULE_NOW, 1)):
    d = run({"x.jsonl": [asst(NOW - 60, "a", "claude-sonnet-5-5", i=10)]}, [NOW - 3600, f"--since5h={NOW - 3600}"],
            {"samples": [], "ledger": [dict(gone, rule=rule)]})
    check(f"limit check counts a rule-{rule} row it cannot rebuild", d["_check"]["n"], n)

# 27. The History pane's limit chart uses the same rule (register.tsx).
reg = open(os.path.join(os.path.dirname(os.path.abspath(SCAN)), "register.tsx")).read()
m_ = re.search(r"LEDGER_RULE = (\d+)", reg)
check("register.tsx LEDGER_RULE equals scan.py RULE", int(m_.group(1)) if m_ else None, RULE_NOW)

# 28. A transcript rewritten in place at the same size, past the first 4 KB,
#     is read again (1,000 -> 2,000 input tokens).
home = home_with({})
dd = os.path.join(home, "data")
pad = [user(NOW - 500, "x" * 60) for _ in range(60)]
write(home, "s.jsonl", pad + [asst(NOW - 100, "a", "claude-sonnet-5-5", i=1000)], NOW - 90)
scan_home(home, dd)
write(home, "s.jsonl", pad + [asst(NOW - 100, "a", "claude-sonnet-5-5", i=2000)], NOW - 80)
check("same-size rewrite past 4 KB: read again", scan_home(home, dd)["listUnits"], 2000)
shutil.rmtree(home)

# 29. Daylight-saving change (New York, 1 Nov 2026 is 25 hours long).  A scan
#     reaching back to 5 AM on 1 Nov covers from 2 Nov's midnight on, so the
#     backfilled 1 Nov stays whole.
from zoneinfo import ZoneInfo
ny = ZoneInfo("America/New_York")
E = lambda *a: datetime(*a, tzinfo=ny).timestamp()
home = home_with({})
dd = os.path.join(home, "data")
write(home, "d.jsonl", [asst(E(2026, 11, 1, 10), "d1", "claude-sonnet-5-5", i=100),
                        asst(E(2026, 11, 1, 23, 30), "d2", "claude-sonnet-5-5", i=100),
                        asst(E(2026, 11, 2, 10), "d3", "claude-sonnet-5-5", i=100)], E(2026, 11, 2, 10, 5))
env_ny = dict(BASE_ENV, HOME=home, TZ="America/New_York")
def run_ny(args):
    o = subprocess.run([sys.executable, "-I", SCAN, *map(str, args)], input="{}", capture_output=True, text=True, env=env_ny)
    if o.returncode != 0:
        raise SystemExit(o.stderr)
    return json.loads(o.stdout)
run_ny(["--backfill", f"--data-dir={dd}"])
d = run_ny([E(2026, 11, 1, 5), f"--now={E(2026, 11, 2, 12)}", f"--data-dir={dd}"])
check("DST: the 25-hour day keeps both calls", d["_history"]["days"].get("2026-11-01", {}).get("n"), 2)
check("DST: the next day is covered", d["_history"]["days"].get("2026-11-02", {}).get("n"), 1)
shutil.rmtree(home)

print("\nFAILURES:", fails)
sys.exit(1 if fails else 0)
