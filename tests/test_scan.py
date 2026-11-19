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
ORULE_NOW = int(re.search(r"^ORULE = (\d+)", open(SCAN).read(), re.M).group(1))


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
       "models": ["Sonnet"], "outside": 0, "weights": "list", "at": end, "readings": 2, "rule": RULE_NOW, "orule": ORULE_NOW}
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
#     the project is the session's folder.  Mythos Preview has no price: it is
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
                          with_cwd(asst(new_t + 5, "n2", "claude-mythos-preview", i=10), "/x/beta"),
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
check("history: Mythos Preview not priced as Fable", ("mythos" in b["m"], "fable" in b["m"]), (False, False))
check("history: Mythos Preview listed as unpriced", d["_unpriced"].get("claude-mythos-preview"), 1)
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

# 24. (0.5.x to 0.7.4) Model weights were measured after a token-type fit.  The meter here counts a cache read 4x its list price and
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
# Since 0.8.0 token-type weights are not fitted (see scan.py: reads cannot
# be told apart from the model weights on real data).  So K stays at list
# even here, and the model weights carry the difference: the read-heavy
# model (Sonnet) measures as pricier.  This is the known limitation the
# manual's "How accurate" section states.
check("token-type weights stay at list prices", d["_fit"]["K"], [1, 1, 1, 1])
m = d["_fit"]["measured"]
check("known limitation: a read-heavy model carries the read factor", m["sonnet"]["x"] > m["opus"]["x"], True)
check("no R² is reported any more", "r2" in d["_fit"], False)

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

# ---------------- limit by time (the History pane) ----------------
# 30. Kept ticks only (no transcripts).  Monday 9 AM ticks hold 1,000 units per
#     1%, Saturday 9 AM ticks 2,000.  Left out: a tick crossing noon (two
#     4-hour blocks), a 2-hour tick, and an outside-use tick (5% moved with
#     almost no local work).  Local time in New York, so the weekday is fixed.
L = lambda *a: datetime(*a, tzinfo=ny).timestamp()
home = home_with({})
dd = os.path.join(home, "data")
os.makedirs(dd)
tk = []
for i in range(10):
    tk.append([L(2027, 1, 11, 9, i * 2), L(2027, 1, 11, 9, i * 2 + 1), 1, {"sonnet": [0, 1000, 0]}, 3])  # Mon
    tk.append([L(2027, 1, 9, 9, i * 2), L(2027, 1, 9, 9, i * 2 + 1), 1, {"sonnet": [0, 2000, 0]}, 3])   # Sat
tk.append([L(2027, 1, 11, 11, 50), L(2027, 1, 11, 12, 10), 1, {"sonnet": [0, 1000, 0]}, 3])  # crosses noon
tk.append([L(2027, 1, 12, 13, 0), L(2027, 1, 12, 15, 0), 1, {"sonnet": [0, 1000, 0]}, 3])    # 2 hours
tk.append([L(2027, 1, 11, 10, 0), L(2027, 1, 11, 10, 5), 5, {"sonnet": [0, 100, 0]}, 1])     # outside use
with open(os.path.join(dd, "ticks.json"), "w") as f:
    json.dump({"v": 2, "ticks": tk}, f)
env_ny = dict(BASE_ENV, HOME=home, TZ="America/New_York")
d = run_ny([NOW - 3600, f"--now={NOW}", f"--data-dir={dd}"])
bt = d.get("_byTime") or {}
g = bt.get("grid") or [[None] * 6] * 7
check("by time: 20 ticks kept (crossing, long and outside-use left out)", bt.get("ticks"), 20)
check("by time: median of all kept ticks", bt.get("per1"), 1500, tol=1)
check("by time: Monday 8 AM to noon", (g[0][2] or {}).get("per1"), 1000, tol=1)
check("by time: Saturday 8 AM to noon", (g[5][2] or {}).get("per1"), 2000, tol=1)
check("by time: Saturday tick count", (g[5][2] or {}).get("n"), 10)
check("by time: the noon-crossing tick fills no afternoon cell", g[0][3], None)
check("by time: a 90% range is reported", (g[0][2] or {}).get("err", 0) > 0, True)
shutil.rmtree(home)

# 31. 5H and 7D readings are kept 120 days in the tick log (0.7.8: 5H was 30).
#     A 60-day-old 5H window has no transcripts behind it: it is kept for the
#     History pane only, and must make no ledger row and no elsewhere.
home = home_with({})
dd = os.path.join(home, "data")
os.makedirs(dd)
ra60 = iso(NOW - 60 * 86400 + 3600)
old = [{"at": NOW - 60 * 86400, "kind": "seven_day", "pct": 50, "resetsAt": iso(NOW - 55 * 86400)},
       {"at": NOW - 60 * 86400 - 600, "kind": "five_hour", "pct": 40, "resetsAt": ra60, "lu": 0, "models": {}},
       {"at": NOW - 60 * 86400, "kind": "five_hour", "pct": 50, "resetsAt": ra60, "lu": 0, "models": {}},
       {"at": NOW - 200 * 86400, "kind": "five_hour", "pct": 30, "resetsAt": iso(NOW - 200 * 86400 + 3600)},
       {"at": NOW - 200 * 86400, "kind": "seven_day", "pct": 40, "resetsAt": iso(NOW - 195 * 86400)}]
with open(os.path.join(dd, "samples.jsonl"), "w") as f:
    for s in old:
        f.write(json.dumps(s) + "\n")
d = run_ny([NOW - 3600, f"--now={NOW}", f"--data-dir={dd}"])
kinds = sorted((s["kind"], s["pct"]) for s in d.get("_samples", []))
check("tick log: 60-day-old readings stay, 200-day ones go", kinds, [("five_hour", 40), ("five_hour", 50), ("seven_day", 50)])
check("tick log: a finished window's readings go out slimmed", sorted(next(s for s in d["_samples"] if s["kind"] == "five_hour")), ["at", "kind", "pct", "resetsAt", "ts"])
check("old 5H window without transcripts: no ledger row", [r for r in d.get("_ledgerNew", []) if r.get("resetsAt") == ra60], [])
check("old 5H window without transcripts: no elsewhere", any(b.get("e") for b in d["_history"]["days"].values()), False)
check("old 5H window without transcripts: no limit size", ra60 in (d.get("_limitSize") or {}), False)
shutil.rmtree(home)

# 32. Elsewhere: the meter moves 0 -> 10% with 1,000 units here, then
#     10 -> 15% with nothing here (a cloud session, say).  The work here
#     moved 10 points, so the window buys 1000 / 10 units per 1% (not / 15:
#     the elsewhere points are in the top reading but not in the work), and
#     the second tick is 5 x 100 = 500 units elsewhere, on the day of the
#     reading that showed it.  The first tick has its work and is not counted.
end = NOW + 3600
st = end - 5 * 3600
resets = iso(end)
files = {"s.jsonl": [user(st + 300), asst(st + 600, "m1", "claude-sonnet-5-5", i=1000)]}
smp = [{"at": st + 60, "kind": "five_hour", "pct": 0, "resetsAt": resets},
       {"at": st + 3600, "kind": "five_hour", "pct": 10, "resetsAt": resets},
       {"at": st + 7200, "kind": "five_hour", "pct": 15, "resetsAt": resets}]
d = run(files, [NOW - 3 * 86400], {"samples": smp, "ledger": []})
day = datetime.fromtimestamp(st + 7200).strftime("%Y-%m-%d")
check("elsewhere: 5% with no local work, in list units", d["_history"]["days"].get(day, {}).get("e"), 500, tol=1)
first = datetime.fromtimestamp(st + 3600).strftime("%Y-%m-%d")
if first != day:
    check("elsewhere: the tick with local work adds nothing", d["_history"]["days"].get(first, {}).get("e"), None)

# 33. A window with no local work at all borrows the median units per 1% of
#     the others (here one window at 100 per 1%): 4% moved = 400 units.
end2 = NOW - 6 * 3600
st2 = end2 - 5 * 3600
r2 = iso(end2)
files = {"s.jsonl": [user(st2 + 300), asst(st2 + 600, "m1", "claude-sonnet-5-5", i=1000)]}
smp = [{"at": st2 + 60, "kind": "five_hour", "pct": 0, "resetsAt": r2},
       {"at": st2 + 3600, "kind": "five_hour", "pct": 10, "resetsAt": r2},
       {"at": st + 60, "kind": "five_hour", "pct": 0, "resetsAt": resets},
       {"at": st + 3600, "kind": "five_hour", "pct": 4, "resetsAt": resets}]
d = run(files, [NOW - 3 * 86400], {"samples": smp, "ledger": []})
day = datetime.fromtimestamp(st + 3600).strftime("%Y-%m-%d")
check("elsewhere: an all-elsewhere window uses the median per 1%", d["_history"]["days"].get(day, {}).get("e"), 400, tol=1)

# 34. Use before the first reading here: a window's first reading is 30%
#     with no work here (a cloud session ran while no session was open).
#     The window starts at 0%, so 0 -> 30% is a tick like any other.  The
#     window has no work of its own, so it borrows the ledger's usual
#     100 units per 1%: 3,000 units elsewhere.
end = NOW + 3600
st = end - 5 * 3600
led = [{"kind": "five_hour", "resetsAt": iso(NOW - 86400), "per1": 100, "pct": 20, "rule": RULE_NOW}]
smp = [{"at": st + 3 * 3600, "kind": "five_hour", "pct": 30, "resetsAt": iso(end)}]
d = run({"s.jsonl": [user(NOW - 2 * 86400)]}, [NOW - 3 * 86400], {"samples": smp, "ledger": led})
days = d["_history"]["days"]
day = datetime.fromtimestamp(st + 3 * 3600).strftime("%Y-%m-%d")
check("elsewhere: use before the first reading counts from the window start", days.get(day, {}).get("e"), 3000, tol=1)
check("elsewhere: the reading marks the day measured", days.get(day, {}).get("s"), 1)

# 35. A whole 5H window used elsewhere and reset before a session here read
#     the meter: only the 7D meter shows it.  7D goes 10 -> 14% over 30
#     hours with nothing here.  The work here moved 11 of the window's 15
#     points (the 1-point step after the jump is rounding, so it stays with
#     the work here): 1000 / 11 = 90.9 units per 1%, so 4 points = 364 units,
#     on the day of the later reading, marked "since" the earlier one.  The
#     1-point step adds nothing.
end7 = NOW + 3 * 86400
st7 = end7 - 7 * 86400
r7 = iso(end7)
t0, t1 = NOW - 40 * 3600, NOW - 10 * 3600
files = {"s.jsonl": [user(st7 + 600), asst(st7 + 900, "m1", "claude-sonnet-5-5", i=1000)]}
smp = [{"at": t0, "kind": "seven_day", "pct": 10, "resetsAt": r7},
       {"at": t1, "kind": "seven_day", "pct": 14, "resetsAt": r7},
       {"at": NOW - 60, "kind": "seven_day", "pct": 15, "resetsAt": r7}]
d = run(files, [st7], {"samples": smp, "ledger": []})
days = d["_history"]["days"]
b1 = days.get(datetime.fromtimestamp(t1).strftime("%Y-%m-%d"), {})
check("elsewhere: a 4-point 7D jump with nothing here counts", b1.get("e"), 364, tol=1)
check("elsewhere: the jump is marked since its start", b1.get("es"), t0)
check("elsewhere: a 1-point 7D step adds nothing", sum(v.get("e", 0) for v in days.values()), 364, tol=1)

# 36. The same span seen by both meters is counted once.  A 5H window's only
#     reading (30% at 10 units per 1% = 300 units) lands with the 7D reading
#     that jumped 4 points (400 units at this window's 1000 / 10): the 5H tick already explains the
#     jump, so the day holds 300, not 700.
smp = [{"at": t0, "kind": "seven_day", "pct": 10, "resetsAt": r7},
       {"at": t1, "kind": "seven_day", "pct": 14, "resetsAt": r7},
       {"at": t1, "kind": "five_hour", "pct": 30, "resetsAt": iso(t1 + 3600)}]
led = [{"kind": "five_hour", "resetsAt": iso(NOW - 3 * 86400), "per1": 10, "pct": 20, "rule": RULE_NOW}]
d = run(files, [st7], {"samples": smp, "ledger": led})
days = d["_history"]["days"]
check("elsewhere: 5H and 7D seeing the same use count it once", sum(v.get("e", 0) for v in days.values()), 300, tol=1)

# 37. Mostly elsewhere: a cloud session runs the window to 30% before any
#     reading here, then 1,000 units here move it to 35%.  The work here
#     moved 5 points, so 200 units per 1%, and the 30 points are 6,000 units.
#     Dividing by the top reading (1000 / 35) would have shown 857.
end = NOW + 3600
st = end - 5 * 3600
files = {"s.jsonl": [user(st + 3 * 3600 + 60), asst(st + 3 * 3600 + 120, "m1", "claude-sonnet-5-5", i=1000)]}
smp = [{"at": st + 3 * 3600, "kind": "five_hour", "pct": 30, "resetsAt": iso(end)},
       {"at": st + 4 * 3600, "kind": "five_hour", "pct": 35, "resetsAt": iso(end)}]
d = run(files, [NOW - 3 * 86400], {"samples": smp, "ledger": []})
tot = sum(v.get("e", 0) for v in d["_history"]["days"].values())
check("elsewhere: a mostly-elsewhere window is weighed by the work here", tot, 6000, tol=1)

# 38. Limit check: work per 1% counts only the points the work here moved.
#     1,000 units take this window 0 -> 10%, then a cloud session takes it
#     to 15%.  1000 / 10 = 100 per 1% (dividing by 15 would read as a limit a
#     third smaller).  A past row of 40% with 20% elsewhere and 2,000 units
#     is likewise 2000 / 20 = 100, not 50.
end = NOW + 3600
st = end - 5 * 3600
files = {"s.jsonl": [user(st + 300), asst(st + 600, "m1", "claude-sonnet-5-5", i=1000)]}
smp = [{"at": st + 60, "kind": "five_hour", "pct": 0, "resetsAt": iso(end)},
       {"at": st + 3600, "kind": "five_hour", "pct": 10, "resetsAt": iso(end)},
       {"at": st + 7200, "kind": "five_hour", "pct": 15, "resetsAt": iso(end)}]
led = [{"kind": "five_hour", "resetsAt": iso(NOW - 86400), "start": NOW - 86400 - 18000, "end": NOW - 86400,
        "pct": 40, "outside": 20, "units": 2000, "per1": 50, "rule": RULE_NOW}]
d = run(files, [st, f"--since5h={st}"], {"samples": smp, "ledger": led})
check("limit check: elsewhere points left out of work per 1%", d["_check"]["per1"], 100)
check("limit check: points moved here", d["_check"]["herePct"], 10)
check("limit check: a past row is measured over its points here", d["_check"]["lo"], 100)

# 39. The first, partly covered day of a scan is never rebuilt, but it gets
#     its elsewhere fields once: readings counted, and 10% elsewhere at the
#     usual 100 per 1%.  A later scan that sees less of it does not
#     overwrite them.
noon = int(datetime(2027, 1, 13, 12).timestamp())
now2 = noon + 2 * 86400
home = home_with({"s.jsonl": [user(noon - 86400)]})
dd = os.path.join(home, "data")
r39 = iso(noon + 4 * 3600)
smp = [{"at": noon + 3600, "kind": "five_hour", "pct": 0, "resetsAt": r39},
       {"at": noon + 7200, "kind": "five_hour", "pct": 10, "resetsAt": r39}]
led = [{"kind": "five_hour", "resetsAt": iso(noon - 86400), "pct": 20, "outside": 0, "per1": 100, "rule": RULE_NOW}]
d = run_in(home, [noon, f"--now={now2}", f"--data-dir={dd}"], {"samples": smp, "ledger": led})
b = d["_history"]["days"].get("2027-01-13", {})
check("first day: readings counted", b.get("s"), 2)
check("first day: elsewhere filled in", b.get("e"), 1000, tol=1)
hp = os.path.join(dd, "history.json")
h = json.load(open(hp))
h["days"]["2027-01-13"]["e"] = 7
with open(hp, "w") as f:
    json.dump(h, f)
d = run_in(home, [noon, f"--now={now2}", f"--data-dir={dd}"], {"samples": smp, "ledger": led})
check("first day: set once, never overwritten", d["_history"]["days"].get("2027-01-13", {}).get("e"), 7)
shutil.rmtree(home)

# 40. Rounding: 350 units take the meter 0 -> 4% (really about 4.9), and the
#     next reading ticks to 5% with nothing behind it.  The tick before
#     explains it, so it is not elsewhere.  A 1-point tick after a quiet
#     elsewhere tick still counts.
end = NOW + 3600
st = end - 5 * 3600
files = {"s.jsonl": [user(st + 300), asst(st + 600, "m1", "claude-sonnet-5-5", i=350)]}
smp = [{"at": st + 60, "kind": "five_hour", "pct": 0, "resetsAt": iso(end)},
       {"at": st + 3600, "kind": "five_hour", "pct": 4, "resetsAt": iso(end)},
       {"at": st + 3700, "kind": "five_hour", "pct": 5, "resetsAt": iso(end)}]
d = run(files, [NOW - 3 * 86400], {"samples": smp, "ledger": []})
check("rounding: a 1-point tick the tick before explains is not elsewhere",
      sum(v.get("e", 0) for v in d["_history"]["days"].values()), 0)
smp += [{"at": st + 7200, "kind": "five_hour", "pct": 9, "resetsAt": iso(end)},
        {"at": st + 7300, "kind": "five_hour", "pct": 10, "resetsAt": iso(end)}]
d = run(files, [NOW - 3 * 86400], {"samples": smp, "ledger": []})
check("rounding: a 1-point tick after a quiet elsewhere tick counts", d["_history"]["days"] and
      round(sum(v.get("e", 0) for v in d["_history"]["days"].values()) / 70), 5)

# 41. A row whose elsewhere count was made under an older rule is rebuilt
#     while its readings are on disk, with the same work per 1%.
end = NOW - 600
st = end - 5 * 3600
files = {"s.jsonl": [user(st + 60), asst(st + 120, "m1", "claude-sonnet-5-5", i=1000)]}
smp = [{"at": st + 30, "kind": "five_hour", "pct": 0, "resetsAt": iso(end)},
       {"at": st + 3600, "kind": "five_hour", "pct": 20, "resetsAt": iso(end)}]
old = [{"kind": "five_hour", "resetsAt": iso(end), "start": st, "end": end, "pct": 20, "seen": st + 3600, "units": 1000,
        "per1": 50, "tokens": [1000, 0, 0, 0], "models": ["Sonnet"], "outside": 4, "weights": "list", "at": end,
        "readings": 2, "rule": RULE_NOW}]
d = run(files, [NOW - 3600], {"samples": smp, "ledger": old})
row = (d["_ledgerNew"] or [{}])[0]
check("old elsewhere rule: row rebuilt", (row.get("outside"), row.get("orule"), row.get("per1")), (0, ORULE_NOW, 50))

# 42. Meter lag: 90 units of work here (0.9 of a point at 100 per 1%), then a
#     reading that still shows 0%, then 1% twenty seconds later with 5 more
#     units.  The meter was catching up on the work, not counting use
#     elsewhere.  (Found by review: the 0% tick used to drop its work.)
end = NOW + 3600
st = end - 5 * 3600
led = [{"kind": "five_hour", "resetsAt": iso(NOW - 86400), "per1": 100, "pct": 20, "outside": 0, "rule": RULE_NOW}]
files = {"s.jsonl": [user(st + 500), asst(st + 600, "m1", "claude-sonnet-5-5", i=90),
                     asst(st + 3610, "m2", "claude-sonnet-5-5", i=5)]}
smp = [{"at": st + 3600, "kind": "five_hour", "pct": 0, "resetsAt": iso(end)},
       {"at": st + 3620, "kind": "five_hour", "pct": 1, "resetsAt": iso(end)}]
d = run(files, [NOW - 3 * 86400], {"samples": smp, "ledger": led})
check("lag: a 0% reading after work is not followed by false elsewhere",
      sum(v.get("e", 0) for v in d["_history"]["days"].values()), 0)

# 43. Heavy work, meter catching up in jumps: 600 units in 3 minutes (6
#     points at 100 per 1%) with readings 0 -> 1 -> 6 a minute apart; the
#     jump of 5 has only 100 units in its own tick but the last few minutes'
#     work is still on its way.  Not elsewhere.
files = {"s.jsonl": [user(st + 500)] + [asst(st + 600 + 30 * i, f"h{i}", "claude-sonnet-5-5", i=100) for i in range(6)]}
smp = [{"at": st + 560, "kind": "five_hour", "pct": 0, "resetsAt": iso(end)},
       {"at": st + 700, "kind": "five_hour", "pct": 1, "resetsAt": iso(end)},
       {"at": st + 760, "kind": "five_hour", "pct": 6, "resetsAt": iso(end)}]
d = run(files, [NOW - 3 * 86400], {"samples": smp, "ledger": led})
check("lag: a catch-up jump during heavy work is not elsewhere",
      sum(v.get("e", 0) for v in d["_history"]["days"].values()), 0)

# 44. But old work does not hide a jump: 1,000 units, the meter shows 10%
#     23 minutes later (the computer quiet since), then +5% an hour on with
#     nothing here.  Still elsewhere.  (Work in the 15 minutes before a tick
#     does count towards it: then lag and use elsewhere at the same time
#     can't be told apart, and it is not called elsewhere.)
files = {"s.jsonl": [user(st + 500), asst(st + 600, "m1", "claude-sonnet-5-5", i=1000)]}
smp = [{"at": st + 2000, "kind": "five_hour", "pct": 10, "resetsAt": iso(end)},
       {"at": st + 5600, "kind": "five_hour", "pct": 15, "resetsAt": iso(end)}]
d = run(files, [NOW - 3 * 86400], {"samples": smp, "ledger": led})
check("lag: old work does not hide later use elsewhere",
      sum(v.get("e", 0) for v in d["_history"]["days"].values()), 500, tol=1)

# 45. A new install (no ledger) with a window used only elsewhere: the ledger
#     row and the limit check count it too (they used to say 0, and the row
#     was then never rebuilt).  The other window, 1,000 units over 10%, gives
#     the usual 100 per 1%.
end2 = NOW - 6 * 3600
st2 = end2 - 5 * 3600
end3 = NOW - 600
st3 = end3 - 5 * 3600
files = {"s.jsonl": [user(st2 + 300), asst(st2 + 600, "m1", "claude-sonnet-5-5", i=1000)]}
smp = [{"at": st2 + 60, "kind": "five_hour", "pct": 0, "resetsAt": iso(end2)},
       {"at": st2 + 3600, "kind": "five_hour", "pct": 10, "resetsAt": iso(end2)},
       {"at": st3 + 3600, "kind": "five_hour", "pct": 30, "resetsAt": iso(end3)}]
d = run(files, [NOW - 3 * 86400], {"samples": smp, "ledger": []})
rows = {r["resetsAt"]: r for r in d["_ledgerNew"]}
check("no ledger: an all-elsewhere window's row counts it", rows.get(iso(end3), {}).get("outside"), 30)

# 46. The weighting settles: elsewhere plus work here never adds up to more
#     than the meter.  Work 1,072 units early, cloud jumps later.
files = {"s.jsonl": [user(st + 300), asst(st + 600, "m1", "claude-sonnet-5-5", i=1072)]}
smp = [{"at": st + 60, "kind": "five_hour", "pct": 0, "resetsAt": iso(end)},
       {"at": st + 900, "kind": "five_hour", "pct": 10, "resetsAt": iso(end)},
       {"at": st + 4500, "kind": "five_hour", "pct": 14, "resetsAt": iso(end)},
       {"at": st + 8100, "kind": "five_hour", "pct": 17, "resetsAt": iso(end)},
       {"at": st + 11700, "kind": "five_hour", "pct": 24, "resetsAt": iso(end)}]
d = run(files, [st, f"--since5h={st}"], {"samples": smp, "ledger": []})
c_ = d["_check"]
check("settled: elsewhere + here points = the meter", c_["outside"] + c_["herePct"], 24)
check("settled: work per 1% is the work over the points here", c_["per1"], round(1072 / c_["herePct"]), tol=1)

# 47. 7D: one point of work still on its way does not hide a 4-point jump.
#     900 units moved 7D to 9% (and 0.9 of a point is left unshown), then the
#     meter jumps to 13% with nothing here: 3 points at least are elsewhere.
end7 = NOW + 3 * 86400
st7 = end7 - 7 * 86400
files = {"s.jsonl": [user(st7 + 600), asst(st7 + 900, "m1", "claude-sonnet-5-5", i=990)]}
smp = [{"at": st7 + 1200, "kind": "seven_day", "pct": 9, "resetsAt": iso(end7)},
       {"at": NOW - 10 * 3600, "kind": "seven_day", "pct": 13, "resetsAt": iso(end7)}]
d = run(files, [st7], {"samples": smp, "ledger": []})
e7 = sum(v.get("e", 0) for v in d["_history"]["days"].values())
check("7D: a jump is not hidden by a point of work still on its way", e7 >= 300, True)

# 48. The carry's "usual" is for windows on the same model.  Opus windows buy
#     far more list units per 1% than Fable ones (list prices weigh models
#     unlike the meter).  A Fable catch-up jump, as in 43, must not be called
#     elsewhere just because the all-model usual is Opus-sized.
end = NOW + 3600
st = end - 5 * 3600
led = ([{"kind": "five_hour", "resetsAt": iso(NOW - (10 + i) * 86400), "per1": 10 ** 7, "pct": 20, "outside": 0,
         "models": ["Opus"], "rule": RULE_NOW} for i in range(4)] +
       [{"kind": "five_hour", "resetsAt": iso(NOW - (20 + i) * 86400), "per1": 1, "pct": 20, "outside": 0,
         "models": ["Fable"], "rule": RULE_NOW} for i in range(3)])
files = {"s.jsonl": [user(st + 500)] + [asst(st + 600 + 30 * i, f"f{i}", "claude-fable-5-2", i=100) for i in range(5)]}
smp = [{"at": st + 560, "kind": "five_hour", "pct": 0, "resetsAt": iso(end)},
       {"at": st + 700, "kind": "five_hour", "pct": 1, "resetsAt": iso(end)},
       {"at": st + 725, "kind": "five_hour", "pct": 6, "resetsAt": iso(end)}]
d = run(files, [NOW - 3 * 86400], {"samples": smp, "ledger": led})
check("carry: a Fable window is judged against Fable windows",
      sum(v.get("e", 0) for v in d["_history"]["days"].values()), 0)

# 49. Busy computer: a 1-point tick with almost no work of its own, but with
#     work here a few minutes before it, is not elsewhere (lag, or use
#     elsewhere alongside work here, which can't be told apart).
files = {"s.jsonl": [user(st + 500), asst(st + 600, "m1", "claude-sonnet-5-5", i=300),
                     asst(st + 900, "m2", "claude-sonnet-5-5", i=300)]}
smp = [{"at": st + 60, "kind": "five_hour", "pct": 0, "resetsAt": iso(end)},
       {"at": st + 950, "kind": "five_hour", "pct": 6, "resetsAt": iso(end)},
       {"at": st + 1000, "kind": "five_hour", "pct": 7, "resetsAt": iso(end)}]
d = run(files, [NOW - 3 * 86400], {"samples": smp, "ledger": led})
check("busy: a tick right after work here is not elsewhere",
      sum(v.get("e", 0) for v in d["_history"]["days"].values()), 0)

# ---------------- v0.7.2 ----------------
# 50. S2: one backfill at a time.  While another session holds backfill.lock,
#     a second one says "busy" at once and writes nothing.
import fcntl
home = home_with({"x.jsonl": [asst(NOW - 60, "a", "claude-sonnet-5-5", i=10)]})
dd = os.path.join(home, "data")
os.makedirs(dd)
held = open(os.path.join(dd, "backfill.lock"), "a+")
fcntl.flock(held, fcntl.LOCK_EX)
d = run_in(home, ["--backfill", f"--data-dir={dd}", f"--now={NOW}"])
check("backfill: a second one at the same time says busy", d.get("backfill"), "busy")
check("backfill: the busy one writes no history", os.path.exists(os.path.join(dd, "history.json")), False)
fcntl.flock(held, fcntl.LOCK_UN); held.close()

# 51. S2: a run that succeeds leaves no back-off and marks the history full.
d = run_in(home, ["--backfill", f"--data-dir={dd}", f"--now={NOW}"])
check("backfill: a free lock runs it", d.get("backfill"), 1)
check("backfill: success leaves no back-off file", os.path.exists(os.path.join(dd, "backfill.json")), False)
d = run_in(home, [NOW - 3600, f"--data-dir={dd}", f"--now={NOW}"])
check("backfill: after success the scan reports no wait", d["_backfillNext"], 0)

# 52. S2: a run that died (its state file left behind, as written before the
#     run) makes the next wait 2 minutes after a second failure, and the
#     normal scan reports when; a backfill asked for before then waits.
os.remove(os.path.join(dd, "history.json"))
with open(os.path.join(dd, "backfill.json"), "w") as f:
    json.dump({"fails": 1, "next": NOW + 60}, f)
d = run_in(home, [NOW - 3600, f"--data-dir={dd}", f"--now={NOW}"])
check("backfill: the scan reports the wait after a failure", d["_backfillNext"], NOW + 60)
d = run_in(home, ["--backfill", f"--data-dir={dd}", f"--now={NOW + 30}"])
check("backfill: asked for during the wait, it waits", d.get("backfill"), "wait")
st_ = json.load(open(os.path.join(dd, "backfill.json")))
check("backfill: the wait is untouched by a refused run", st_["fails"], 1)
# a run after the wait that crashes (here: history.json can't be written)
# leaves the doubled wait behind, so it is not retried on every refresh
os.remove(os.path.join(dd, "history.json"))
os.makedirs(os.path.join(dd, "history.json"))
env = dict(BASE_ENV, HOME=home)
pr = subprocess.run([sys.executable, "-I", SCAN, "--backfill", f"--data-dir={dd}", f"--now={NOW + 61}"],
                    input="{}", capture_output=True, text=True, env=env)
st_ = json.load(open(os.path.join(dd, "backfill.json")))
check("backfill: a crashed run exits with an error", pr.returncode != 0, True)
check("backfill: a crashed run counts as a failure", st_["fails"], 2)
check("backfill: the wait doubles after it", st_["next"], NOW + 61 + 120)
shutil.rmtree(home)

# 53. C1: fast mode in the forecasts.  The same turn, once fast and once at
#     standard speed: re-priced on its own model the fast one costs FAST
#     times as much (the next turn runs fast too), on another model the
#     same (fast mode stays with its model); the session says it is fast.
def one_turn(fast):
    sid = "fff"
    files = {f"{sid}.jsonl": [user(NOW - 300), asst(NOW - 290, "q1", "claude-opus-5-5", i=100, o=1000, fast=fast)]}
    return run(files, [NOW - 3600, f"--session-id={sid}", f"--since5h={NOW - 3600}"])["_session"]
fs, ss = one_turn(True), one_turn(False)
check("fast: re-priced on its own model it stays fast", fs["turns"][0]["on"]["opus"], 2 * ss["turns"][0]["on"]["opus"], tol=1)
check("fast: re-priced on another model it is standard", fs["turns"][0]["on"]["sonnet"], ss["turns"][0]["on"]["sonnet"], tol=1)
check("fast: the session reports fast mode", (fs["fast"], ss["fast"], fs["fastX"]), (True, False, 2.0))
# one source: after fast mode is switched off, the earlier fast turn is
# forecast at standard speed (it would run at standard speed now)
sid = "ggg"
files = {f"{sid}.jsonl": [user(NOW - 300), asst(NOW - 290, "g1", "claude-opus-5-5", i=100, o=1000, fast=True),
                          user(NOW - 200), asst(NOW - 190, "g2", "claude-opus-5-5", i=100, o=1000)]}
gs = run(files, [NOW - 3600, f"--session-id={sid}", f"--since5h={NOW - 3600}"])["_session"]
check("fast: after switching it off, an earlier fast turn forecasts at standard speed",
      gs["turns"][0]["on"]["opus"], ss["turns"][0]["on"]["opus"], tol=1)
check("fast: the turn as it ran still counts its fast price", gs["turns"][0]["u"], 2 * gs["turns"][1]["u"], tol=1)

# ---------------- v0.7.4 ----------------
# 54. Mythos is priced per version, at its Fable twin's price; a Mythos with
#     no listed price (Preview) stays unpriced and listed.
files = {"s.jsonl": [asst(NOW - 600, "y1", "claude-mythos-5-2", i=1000),
                     asst(NOW - 590, "y2", "claude-fable-5-2", i=1000),
                     asst(NOW - 580, "y3", "claude-mythos-preview", i=1000)]}
d = run(files, [NOW - 3600])
mo = d[str(NOW - 3600)]["models"]
check("mythos: 5.2 is priced", mo.get("claude-mythos-5-2", {}).get("units"), mo.get("claude-fable-5-2", {}).get("units"))
check("mythos: Preview stays unpriced", d["_unpriced"], {"claude-mythos-preview": 1})
check("mythos: weights sent for the band", "mythos" in d["_weights"], True)

# 55. R5: the 5H rate counts work only up to the newest reading.  10% after
#     1,000 units; 1,000 more units after the reading have not shown yet.
st = NOW - 3600
ra = iso(st + 5 * 3600)
files = {"s.jsonl": [user(st + 60), asst(st + 120, "r1", "claude-sonnet-5-5", i=1000),
                     asst(st + 900, "r2", "claude-sonnet-5-5", i=1000)]}
smp = [{"at": st + 30, "kind": "five_hour", "pct": 0, "resetsAt": ra, "ts": 1},
       {"at": st + 600, "kind": "five_hour", "pct": 10, "resetsAt": ra, "ts": 1}]
d = run(files, [st, f"--since5h={st}"], {"samples": smp, "ledger": []})
check("rate: % per unit uses work up to the reading", d["_rate5"], 10 / 1000, tol=1e-6)

# 56. A2: 12 sessions claim the same once-per-window alert at once; exactly
#     one wins, and a later claim for the same window loses too.
home = home_with({"x.jsonl": [asst(NOW - 60, "a", "claude-sonnet-5-5", i=10)]})
dd = os.path.join(home, "data")
procs = [run_in(home, [f"--data-dir={dd}", f"--claim=wall5h|{ra}"], wait=False) for _ in range(12)]
wins_ = sum(json.loads(pr.communicate()[0])["claimed"] for pr in procs)
check("claim: one of 12 parallel claims wins", wins_, 1)
check("claim: a later claim for the same window loses", run_in(home, [f"--data-dir={dd}", f"--claim=wall5h|{ra}"])["claimed"], False)
check("claim: the next window can be claimed", run_in(home, [f"--data-dir={dd}", f"--claim=wall5h|next"])["claimed"], True)
shutil.rmtree(home)

# 57. Limit size is weighed by model.  The meter here counts Fable at 2x
#     Opus (weight_case).  A Fable window and an Opus window that each moved
#     10 points for the same meter work: at list prices the Fable one buys
#     half the units (a "smaller limit"); at the measured weights, the same.
recs, smp = weight_case(20, 12, start)
home = home_with({"w.jsonl": recs})
dd = os.path.join(home, "data")
led = [{"kind": "five_hour", "resetsAt": iso(NOW - 3 * 86400), "start": NOW - 3 * 86400 - 18000, "pct": 10, "outside": 0,
        "per1": 500_000, "units": 5_000_000, "byModel": {"claude-fable-5-2": [0, 250_000, 0, 0, 0]}, "rule": RULE_NOW},
       {"kind": "five_hour", "resetsAt": iso(NOW - 2 * 86400), "start": NOW - 2 * 86400 - 18000, "pct": 10, "outside": 0,
        "per1": 1_000_000, "units": 10_000_000, "byModel": {"claude-opus-5-5": [0, 1_000_000, 0, 0, 0]}, "rule": RULE_NOW}]
d = run_in(home, [start, f"--data-dir={dd}", f"--now={NOW}"], {"samples": smp, "ledger": led})
ls = d["_limitSize"]
check("limit size: a Fable window is not a smaller limit", ls[iso(NOW - 3 * 86400)] / ls[iso(NOW - 2 * 86400)], 1.0, tol=0.15)
check("limit size: at list prices it would have looked half", led[0]["per1"] / led[1]["per1"], 0.5)
# Model mix in the 5H windows tooltip: each model's share at the measured
# weights.  Fable output is 2x Opus at list, and the meter weighs Fable 2x
# Opus per list unit, so 250k Fable + 1M Opus output is 50/50 of the limit
# (33% Fable at list).  One-model windows get no mix.
led.append({"kind": "five_hour", "resetsAt": iso(NOW - 86400), "start": NOW - 86400 - 18000, "pct": 10, "outside": 0,
            "per1": 1_000_000, "units": 10_000_000, "byModel": {"claude-opus-5-5": [0, 1_000_000, 0, 0, 0], "claude-fable-5-2": [0, 250_000, 0, 0, 0]}, "rule": RULE_NOW})
d = run_in(home, [start, f"--data-dir={dd}", f"--now={NOW}"], {"samples": smp, "ledger": led})
mx = d.get("_limitMix") or {}
check("model mix: a mixed window has both models", sorted(mx.get(iso(NOW - 86400), {})), ["Fable", "Opus"])
check("model mix: Fable's share is weighed, not list", mx.get(iso(NOW - 86400), {}).get("Fable", 0), 50, tol=0.15)
check("model mix: a one-model window has none", iso(NOW - 2 * 86400) in mx, False)
shutil.rmtree(home)

# ---------------- v0.7.7 ----------------
# 58. A: model weights are measured against Opus (Opus = 1.0x), a fixed
#     ruler.  The meter here counts Fable 2x Opus (weight_case, 20 Opus ticks).
recs, smp = weight_case(20, 12, start)
d = run({"w.jsonl": recs}, [start], {"samples": smp, "ledger": []})
check("anchor: the ruler is Opus", d["_fit"].get("anchor"), "opus")
check("anchor: Opus is 1.0x", d["_fit"]["MM"]["opus"], 1.0, tol=0)
check("anchor: Fable is 2x Opus", d["_fit"]["MM"]["fable"], 2.0, tol=0.15)
# Few Opus ticks: the ruler stays the average tick.
recs, smp = weight_case(5, 12, start)
d = run({"w.jsonl": recs}, [start], {"samples": smp, "ledger": []})
check("anchor: under 15 Opus ticks the ruler is the average", d["_fit"].get("anchor"), "average")

# 59. C: windows with under 8 points of work here have no Limit size figure
#     and give no rate (the meter's rounding makes them read low).
led = [{"kind": "five_hour", "resetsAt": iso(NOW - 3 * 86400), "start": NOW - 3 * 86400 - 18000, "pct": 5, "outside": 0,
        "per1": 100_000, "units": 500_000, "byModel": {"claude-opus-5-5": [0, 50_000, 0, 0, 0]}, "rule": RULE_NOW},
       {"kind": "five_hour", "resetsAt": iso(NOW - 2 * 86400), "start": NOW - 2 * 86400 - 18000, "pct": 8, "outside": 0,
        "per1": 100_000, "units": 800_000, "byModel": {"claude-opus-5-5": [0, 80_000, 0, 0, 0]}, "rule": RULE_NOW}]
d = run({"x.jsonl": [asst(NOW - 60, "a", "claude-sonnet-5-5", i=10)]}, [NOW - 3600], {"samples": [], "ledger": led})
check("8-point minimum: a 5-point window has no limit size", iso(NOW - 3 * 86400) in d["_limitSize"], False)
check("8-point minimum: an 8-point window has one", iso(NOW - 2 * 86400) in d["_limitSize"], True)
st = NOW - 3600; ra = iso(st + 5 * 3600)
files = {"s.jsonl": [user(st + 60), asst(st + 120, "r1", "claude-sonnet-5-5", i=1000)]}
smp = [{"at": st + 30, "kind": "five_hour", "pct": 0, "resetsAt": ra, "ts": 1},
       {"at": st + 600, "kind": "five_hour", "pct": 5, "resetsAt": ra, "ts": 1}]
d = run(files, [st, f"--since5h={st}"], {"samples": smp, "ledger": []})
check("8-point minimum: no rate from 5 points", d["_rate5"], None)

# 60. F2: a known family on a version the price table does not list is left
#     out and listed, not priced as the newest version.
d = run({"s.jsonl": [asst(NOW - 600, "v1", "claude-opus-9-9", i=1000), asst(NOW - 590, "v2", "claude-3-5-sonnet-20241022", i=1000)]}, [NOW - 3600])
check("unknown version: listed as unpriced", d["_unpriced"], {"claude-opus-9-9": 1, "claude-3-5-sonnet-20241022": 1})

# 61. A call already running at a reading is not elsewhere.  Quiet computer,
#     then a 10-point jump at T.  The reply that caused it is logged twice
#     while it streams: first at T-60 (a partial copy), last at T+100 (when
#     it finished, with the full count).  Counted at its finish only, the
#     jump looked like use elsewhere (seen on real data 2026-11-18).
end = NOW + 3600
st = end - 5 * 3600
T = st + 3 * 3600
big = dict(o=20_000)          # Sonnet output: 100k list units
part = asst(T - 60, "long1", "claude-sonnet-5-5", o=10)
full = asst(T + 100, "long1", "claude-sonnet-5-5", **big)
# 10 points of work in the first hour, read at 1 hour; then quiet until T
smp = [{"at": st + 3600, "kind": "five_hour", "pct": 10, "resetsAt": iso(end), "ts": 1},
       {"at": T, "kind": "five_hour", "pct": 20, "resetsAt": iso(end), "ts": 1}]
before = [user(st + 300), asst(st + 400, "w1", "claude-sonnet-5-5", o=20_000)]   # 100k list units
d = run({"s.jsonl": before + [user(T - 70), part, full]}, [NOW - 3 * 86400], {"samples": smp, "ledger": []})
check("running call: a jump while a long call runs is not elsewhere", sum(v.get("e", 0) for v in d["_history"]["days"].values()), 0)
# The same reply sent only after the reading (first copy after T): still elsewhere.
late = asst(T + 30, "long1", "claude-sonnet-5-5", o=10)
d = run({"s.jsonl": before + [user(T + 20), late, full]}, [NOW - 3 * 86400], {"samples": smp, "ledger": []})
check("running call: a call started after the jump does not explain it", sum(v.get("e", 0) for v in d["_history"]["days"].values()) > 0, True)

print("\nFAILURES:", fails)
sys.exit(1 if fails else 0)
