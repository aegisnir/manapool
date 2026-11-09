# Mana Pool

A Claude Code mod that shows what your subscription limits are really made of.

Anthropic shows you a percent. Mana Pool adds up the real tokens behind the 5-hour and weekly limits, straight from the transcripts Claude Code already writes on your computer. **It never calls a model, so it costs you no tokens.**

It answers three questions, in this order:

1. **Will my limits last?** Pace and runway for the 5-hour and weekly meters.
2. **Is this session still the cheap place to work?** What each turn costs here, against handing off to a fresh session.
3. **Is the limit holding the usual amount of work?** A ledger of past windows that shows a shrinking limit.

## What you get

A band above the prompt, in two sizes (Full and Mini):

| Row | Shows |
|-----|-------|
| 7D / 5H | Share of each limit used, pace, and when it resets. Turns red with **runs out in** when it would hit 100% first. |
| Last turn | Your last message and its full reply (subagents included) in % of 5H, what it would cost in a new session, and when a hand-off pays back. |
| Next turn | What the next turn here should cost on your current model. |
| Turns | One bar per turn: grey for re-reading the conversation, violet for new work. |
| Context | Context size, growth per turn, and turns until auto-compact. |
| Cache | Prompt cache active (and when it expires) or expired, with the cost to re-cache. |
| Limit check | Whether 1% of 5H buys the usual amount of work. Flags meter movement with no Claude Code use behind it. |
| Other models | One-time and per-turn cost of switching model now, or handing off to a new session on that model. |

Plus:

- A user manual in a side pane (the info icon) with every formula, assumption and your live numbers.
- `/manapool` opens the manual and prints the key numbers as plain text, for surfaces that cannot draw the band (a phone, for example).
- `/manapool export` writes the window ledger to `~/Documents/Mana Pool/manapool-ledger.csv`.
- `/manapool test-notify` sends a test notification.
- A toast when a warning gets worse, and a system notification when the 5-hour limit will run out within about 30 minutes (once per window). On macOS it falls back to a native notification when Claude Code's own cannot be shown.

## Install

At the prompt of a terminal session:

```
/plugin install manapool --marketplace aegisnir/manapool
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell:

```
claude plugin install manapool --marketplace aegisnir/manapool
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `aegisnir/manapool`, then **Add plugin**.

Needs Python 3 on your computer (the transcript scanner is a small local script).

## How the estimates work, and what is a guess

Anthropic does not publish how a subscription weighs different models and token types. Mana Pool starts from **one assumption: your plan weighs things like the API price list.** As real meter ticks build up, it fits the weights from your own usage and uses those instead. Treat the numbers as a guide, not a bill.

- Measured: token counts, replies, cache timing, conversation size, whole-number percents.
- Estimated (marked `~`): the hundredths, every per-turn and per-model cost, the runway.
- The cache time-to-live is assumed to be 60 minutes. A cache belongs to one model, so switching models starts cold.
- It only sees Claude Code on the computer it runs on. Chat on claude.ai, other computers and the phone app also move the meter but are not counted (the Limit check can flag them, not measure them).

List prices live in the `PRICES` table near the top of `hooks/scan.py`, one row per model version (Haiku 5.5's long-prompt price is in `LONG`). Update them when prices change.

## Privacy

It reads `~/.claude/projects/**/*.jsonl` on your own computer and keeps token counts (no conversation text) in the mod's own store and in one tick-log file, `~/.claude/plugins/data/manapool/samples.jsonl`. Nothing is sent anywhere. The scanner imports only the Python standard library and has no network code. The only other programs it runs are `python3` (the scanner) and, on macOS, `osascript` (the notification fallback).

## Files

- `hooks/register.tsx`: the mod (band, pane, estimates, alerts)
- `hooks/scan.py`: reads the transcripts, adds up tokens, fits weights, writes the CSV export
- `types/index.d.ts`: the mod's saved-state contract

## License

MIT. See `LICENSE`.
