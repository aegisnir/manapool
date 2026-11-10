# Mana Pool

A Claude Code mod that shows what your subscription limits are really made of.

Anthropic shows you a percent. Mana Pool adds up the real tokens behind the 5-hour and weekly limits, straight from the transcripts Claude Code already writes on your computer. **It never calls a model, so it costs you no tokens.**

It answers three questions, in this order:

1. **Will my limits last?** Pace and runway for the 5-hour and weekly meters.
2. **Is this session still the cheap place to work?** What each turn costs here, against handing off to a fresh session.
3. **Is the limit holding the usual amount of work?** A ledger of past windows that shows a shrinking limit.

And a History pane for the question after that: **where did the work go?**

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

A **History** pane (the ▤ button on the band, or `/manapool history`), over 7, 30 or 90 days:

| Chart | Shows |
|-------|-------|
| Tiles | 7D used, how much of 7D is left per day until it resets, and the share of the last 7 days spent re-reading. |
| Daily | Work per day, stacked by model, in % of 7D. |
| 5H pace | This window against the middle half of your past windows, with a projection to 100%. |
| Limit size | Work per 1% of 5H, one dot per finished window. A falling line is a shrinking limit. |
| Projects | Work by the folder each session ran in. |
| Hours | Work by weekday and hour of day. |
| Re-reading | Per day, the work spent re-reading the conversation against new work. |

Hover a bar, dot or cell for its numbers. Each model keeps one colour everywhere (Opus, Sonnet, Fable, Mythos, Haiku, grey for any other), chosen to stay distinct for colour-blind readers. Charts draw in the desktop app and VS Code; the terminal shows the key numbers as text.

Plus:

- A user manual in a side pane (the info icon) with every formula, assumption and your live numbers.
- `/manapool` opens the manual and prints the key numbers as plain text, for surfaces that cannot draw the band (a phone, for example).
- `/manapool export` writes the window ledger to `~/Documents/Mana Pool/manapool-ledger.csv`.
- `/manapool test-notify` sends a test notification.
- A toast when a warning gets worse, and a system notification when the 5-hour limit will run out within about 30 minutes (once per window). On macOS it falls back to a native notification when Claude Code's own cannot be shown.

## Requirements

- A Claude subscription, not an API key. The bars come from the subscription's limit data. Without it the band shows "No limit data yet".
- Claude Code 2.1.317 or newer (mods need a recent version).
- Python 3 (found as `python3`, `py -3` or `python`).
- Tested on macOS. It should run on Linux and Windows, but has not been tested there.

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

To update: `/plugin update manapool`. To remove: `/plugin uninstall manapool`, then delete `~/.claude/plugins/data/manapool/` if you also want its tick log and history gone.

## How the estimates work, and what is a guess

Anthropic does not publish how a subscription weighs different models and token types. Mana Pool starts from **one assumption: your plan weighs things like the API price list.** As real meter ticks build up, it measures how much each model moves your meter and moves the weights toward that, a little more with every tick: thin evidence stays near list price, plenty of it lands on the measured value. Recent ticks count more, so it follows changes to your plan. The manual shows each model's measured weight, the weight in use and its 90% range. Treat the numbers as a guide, not a bill.

- Measured: token counts, replies, cache timing, conversation size, whole-number percents.
- Estimated (marked `~`): the hundredths, every per-turn and per-model cost, the runway.
- The cache time-to-live is assumed to be 60 minutes. A cache belongs to one model, so switching models starts cold.
- Prices: each call at its exact model version, cache writes by lifetime (1-hour kind 2x input, 5-minute kind 1.25x), fast mode 2x, Haiku 5.5 prompts over 100k at its higher tier. A model the table does not know is left out and named in the manual, never guessed (Mythos too, until its price is added).
- History: work is weighed at plain list prices (the ledger's fixed yardstick), and turned into % of 7D with the current 7D window's work per 1%. Re-reading counts cache reads. Days and hours are local time. Over 30 or 90 days a project can pass 100%: that is more than one week's limit.
- It only sees Claude Code on the computer it runs on. Chat on claude.ai, other computers and the phone app also move the meter but are not counted (the Limit check can flag them, not measure them).

List prices live in the `PRICES` table near the top of `hooks/scan.py`, one row per model version (Haiku 5.5's long-prompt price is in `LONG`). Update them when prices change.

## Privacy

It reads `~/.claude/projects/**/*.jsonl` on your own computer and keeps token counts, times, model names and message ids (no conversation text) in the mod's own store and in `~/.claude/plugins/data/manapool/` (under `CLAUDE_CONFIG_DIR` if you set it): `samples.jsonl` (the tick log), `scan-cache.json` (what was already read from each transcript, so a refresh reads only new lines), `ticks.json` (each meter tick's percent and work per model, kept 180 days so the model weights outlive deleted transcripts) and `history.json` (one row per day for the History pane: work per model, per hour, and per project, where a project is the name of the folder a session ran in; kept for 400 days). Nothing is sent anywhere. The scanner imports only the Python standard library and has no network code. The only other programs it runs are Python 3 (the scanner) and, on macOS, `osascript` (the notification fallback).

## Files

- `hooks/register.tsx`: the mod (band, manual and History panes, estimates, alerts)
- `hooks/scan.py`: reads the transcripts, adds up tokens, fits weights, keeps the daily history, writes the CSV export
- `types/index.d.ts`: the mod's saved-state contract
- `tests/test_scan.py`: tests of the scanner on synthetic transcripts. Run `python3 tests/test_scan.py`.
- `CHANGELOG.md`: what changed in each version

## Thanks

Incremental scanning, cache-lifetime pricing and the Windows fixes came from a friend's review, which pointed to [Gnomonkit](https://github.com/joshualytle/Gnomonkit) for the same ideas.

## License

MIT. See `LICENSE`.
