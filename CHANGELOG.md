# Changelog

All notable changes to Mana Pool. Versions follow `version` in `.claude-plugin/plugin.json`. To update an installed copy: `/plugin update manapool`.

## 0.5.1 (2026-11-09)

Correctness fixes from a review of 0.5.0.

- **Model weights no longer double-count token types.**  Each model's weight is now measured after the token-type fit is applied, so a model whose work is mostly cache reads is not adjusted twice for them.  `ticks.json` keeps each tick's work in three token groups (format 2); ticks in the old format are dropped and rebuilt from transcripts still on disk.
- **A deleted transcript no longer shrinks kept ticks.**  A tick rebuilt from fewer calls than its kept copy leaves the kept copy in place.
- **Ledger rule 4.**  Rows built before 5-minute cache writes were priced apart are rebuilt while their transcripts remain, and left out of the limit check and the History pane otherwise.
- **History pane:** the Limit size chart and the 7D scale leave out rows from older ledger rules.
- **Unpriced models stay unpriced.**  On Mythos (or any model without a list price), Next turn, the Cost pill, the cache re-cache cost and the hand-off costs read "unpriced" instead of using the previous model's price.
- **Rewritten transcripts are re-read.**  A transcript that changed without growing is read again in full.
- **Daylight-saving days.**  The daily history finds the next midnight by calendar date, so a 23- or 25-hour day is not cut short.
- **Privacy wording:** the README and manual now say `scan-cache.json` stores each transcript's full path and each session's working-folder path.

## 0.5.0 (2026-11-09)

- **Self-correcting model weights.**  Each model's weight comes from all its ticks added up, not a tick-by-tick check that fast models such as Fable always failed (one tick carries up to a reply of slop).  The weight in use starts at list price and moves toward the measured value as ticks build up, with no on/off threshold.  Recent ticks count more (30-day half-life), so a change in how a plan weighs a model shows up within weeks.
- **`ticks.json`** in the data folder keeps every tick's percent and work per model for 180 days, so the weights outlive transcripts Claude Code deletes.
- The manual's model table shows Measured, Ticks, Used in costs and a 90% range.

## 0.4.0 (2026-11-09)

- **History pane.**  The ▤ button on the band (or `/manapool history`) opens charts over 7, 30 or 90 days: daily work stacked by model, this 5H window's pace against the middle half of past windows, work per 1% of 5H per finished window, top projects, a weekday-by-hour heatmap, and the share spent re-reading the conversation.  Bars use the band's gradient; every chart has hover numbers and a text description.
- **Daily history file.**  The scanner keeps `history.json` in its data folder: one row per local day (work per model, per project folder name, per hour, cache-read share), kept 400 days.  Days the normal scan covers are rebuilt each scan; older days come from a one-time read of every transcript, run in the background the first time.
- One colour per model (Opus, Sonnet, Fable, Mythos, Haiku, plus grey for anything else), checked as a set for colour-blind separation.
- The scan cache records each transcript's folder, so it is rebuilt once after updating.
- Charts are drawn at the pane's own width, so they line up with the tiles.
- Mythos is no longer priced as Fable: like any model without a price row it is left out and listed in the manual until its price is added.
- README and manual: History charts, their assumptions, and the ▤ button.

## 0.3.7 (2026-11-09)

Suggested in a review that pointed to [Gnomonkit](https://github.com/joshualytle/Gnomonkit) for the same ideas. Built from the suggestions; no code copied.

- **Incremental scanning.** A per-transcript cache (`scan-cache.json`: size, modified time, byte offset, a fingerprint of the first 4 KB) means a refresh reads only newly appended lines. Rewritten or shrunk files are read again; a half-written last line waits for the next scan. About 17x faster on 1 GB of transcripts, with identical results.
- **Cache writes priced by lifetime.** 5-minute writes at 1.25x input, 1-hour writes at 2x (from `usage.cache_creation`). Subagent writes were overpriced before.
- **Fast mode** (`usage.speed` is `"fast"`) priced at 2x.
- **Unknown models are no longer priced as Sonnet.** They are left out and listed in the manual.
- **Windows and custom config folders.** Python is found as `python3`, `py -3` or `python`; `CLAUDE_CONFIG_DIR` is honoured; the Windows file lock gives up after 30 seconds instead of retrying forever.
- **Tests** on synthetic transcripts: `python3 tests/test_scan.py`.

## 0.3.6 (2026-11-09)

- CSV export times use the computer's own time zone.
- README: requirements, update and uninstall.

## 0.3.5 (2026-11-09)

- The version number shows after the title in the Full band.

## 0.3.4 (2026-11-09)

- New meter readings carry an exact-time mark; only older readings (saved to the whole second) are stretched to the end of their second.
- The warm forecast baseline covers a session's first turn too.
- Ledger rule 3: rows built under rule 2 are rebuilt.

## 0.3.3 (2026-11-09)

- Forecasts count the whole re-sent prompt as a cache read, so a cold cache's re-cache is added once.
- Reloads, model switches and hand-offs use the long-prompt price when the context is past its threshold (Haiku 5.5 over 100k).
- A finished ledger row is redone when a higher reading for its window arrives later.

## 0.3.2 (2026-11-09)

- The tick log moves to its own file, changed only under a file lock, so parallel sessions can't lose readings.
- Ledger rows from older rules are rebuilt while their transcripts exist, and left out of the limit check otherwise.
- Re-pricing uses the model version you are on now, within a family too; the prompt cache's owner records the version.
- Readings keep fractions of a second.
- Hand-off prices use the new session's own prompt length.
- A session with a stale meter uses the highest reading any session logged.
- The store is pruned before writing, and again if a write is refused.

## 0.3.1 (2026-11-09)

- Follows `/clear` (new session id, no new start event).
- Ledger and limit check count work only up to the last meter reading.
- Forked or resumed transcripts: a reply belongs to this session whatever order files are read in.
- Each call priced on its exact model version; Haiku 5.5 long prompts at 5x; Sonnet 5.5 cache reads at $0.10.
- After a model switch the cache shows as cold, and Next turn is re-priced on the new model.
- No auto-compact estimate when auto-compact is off.
- A failed first read shows its error instead of hiding the band.
- Old per-session entries are pruned (the store is capped at 4 MiB).

## 0.3.0 (2026-11-09)

First public release: limit bars with pace and runway, per-turn cost and hand-off advice, the turn strip, context and cache rows, the limit audit ledger with CSV export, alerts, and the manual pane. MIT licensed.
