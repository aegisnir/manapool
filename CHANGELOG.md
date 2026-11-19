# Changelog

All notable changes to Mana Pool. Versions follow `version` in `.claude-plugin/plugin.json`. To update an installed copy: `claude plugin update manapool@manapool` from a shell; the new version loads in the next session.

## 0.7.13 (2026-11-18)

- **Limit by time uses the 5H windows rules.**  A cell needs 3+ days of data before it is coloured in, and its likely range is now measured between days, not ticks: ticks from one session share its models and way of working, so one busy Monday morning (77 ticks) had passed as a sure figure.  Colours follow 5H windows (faint at usual, full colour at 10% off, was 20%), and the header names a slot only at 15%+ off (was 5%).  Tooltips say "vs usual" (the figure is all ticks pooled, not a median) and how many days a cell pools.  With two weeks of ticks every cell is an outline for now; they fill in as more weeks come in.

## 0.7.12 (2026-11-18)

- **Projection in the last model's colour.**  On 5H pace and 7D pace, the projection and the "now" dot take the colour of the last model that did work here (Elsewhere is skipped), instead of 5H violet and 7D blue.  The tooltip's Projected key matches.

## 0.7.11 (2026-11-18)

- **Pace lines in model colours.**  5H pace and 7D pace draw this window's line in Daily's model colours (Opus violet, Fable gold, Haiku teal...).  Each rise takes the colour of the model that did most of the work behind it, read from the per-model figures every meter reading already carries, and the area under each flat stretch is filled in the colour of the rise before it, so the chart reads as bands of time.  A rise with no work here (use elsewhere, or 7D rounding overnight) is grey, **Elsewhere**.  Heights are still the meter's own readings.  The legend names the models used, and tooltips add the model ("This week 35% · Fable").  Readings without per-model figures keep the old single-colour line.

## 0.7.10 (2026-11-18)

- **Dates on every axis.**  Daily (7D), 7D pace and 5H windows (7D) label every day with its weekday and date; 5H pace puts the clock time under 0h to 5h.  All in the computer's own time zone.
- **7D is blue, 5H violet.**  7D pace's line, projection and dot are blue, so the two pace charts read apart at a glance.
- **5H pace has an even-pace line** (100% at reset), like 7D pace.  No tooltip line for it, to stay inside the pane's size budget.
- **5H windows shows 7D behind the climbs**, in blue on the same 0 to 100% scale, dropping to 0 where 7D resets.  Tooltips give the 7D reading at the end of each window (or day).
- **Limit by time says how many days each row pools** ("9 days"): a row is every matching weekday in the kept ticks, not one date.

## 0.7.9 (2026-11-18)

- **5H windows: no more red climbs.**  A window that reached 90%+ was drawn in the same red as "smaller limit".  Climbs now stay violet and get stronger from 50%, solid at 100%; the 30D and 90D bars do the same.  Red only means a smaller limit.
- **5H windows: $ on the right.**  The dot lane keeps work units on the left and shows the same figure in Opus dollars at list price on the right (1 unit is $2 per million tokens), and tooltips give both: "951k ($1.90) per 1%".  It is what that work would cost through the API on Opus, not what a subscription costs.
- **5H windows: model shares in tooltips.**  A window that mixed models says how much of the limit each used ("Opus 62% · Fable 38%", at the measured weights) instead of "Opus + Fable", so a Fable-heavy window is plain on hover.
- **Hover highlights show again** on Daily and two other charts: their `0.07` opacity was cut to `0.0` when the chart was written out.

## 0.7.8 (2026-11-18)

Limit size is replaced by a 5H windows chart, and the pace charts say what their grey band is.

- **5H windows replaces Limit size.**  Every 5H window on a real timeline, following the range buttons: on top, how far each window climbed (7D: its readings as steps; 30D and 90D: each day's highest climb); below, the work 1% bought in it at the measured model weights.  Green above usual (a bigger limit), red below (a smaller one), full colour at 10% off, a ±10% band for normal scatter, and a waveform through the dots filled to the usual line.  The scale runs from the lowest to the highest solid window on show, never narrower than usual ±15%.  Hollow dots (under 15% used) are rough: the line through them is dashed and the fill skips them.  Idle time is hatched; days before the first kept window say "No data".  30D and 90D show the middle of each day's windows with a line for their range.  The header keeps Limit size's "Steady" or "Down N% lately".
- **5H readings are kept 120 days** (was 30 days, 3,000 at most), like 7D readings, so 90D can draw climbs.  Readings past 29 days have no transcripts behind them and count for nothing but the charts: the ledger, elsewhere and the weight fits still stop at 29 days (a new test checks a 60-day-old window makes no ledger row and no elsewhere).  A finished window's readings go to the mod slimmed to time, percent and window, so the larger log does not grow every scan's output.
- **"Middle half" is now "Usual range"** in 5H pace and 7D pace, and every tooltip line has a colour key for the mark it names.
- **5H pace's usual follows the range buttons:** the past windows that started in the last 7, 30 or 90 days (was the last 30 windows).
- **Limit by time uses the same green and red** for a bigger and a smaller limit (was violet and coral).
- **Darker chart cards.**  The History charts sit on a near-black card (`#0b0a14`, was grey `#262626`); grey labels read a little better (APCA Lc 47.5, was 44.6).  The band keeps its own background.

## 0.7.7 (2026-11-18)

Limit size now measures what the limit buys, not which model you used.  From an independent review of two weeks of real data: the limit held within about 5 to 9%, while raw per-window figures swung 2.6x with the share of Fable.

- **Limit size is weighed by model.**  The History pane's dots used plain list prices, so a window run mostly on Fable (the meter weighs it about 2.2x Opus per list-price unit) read as a much smaller limit: about 500k work units per 1% against 950k for Opus windows.  The dots now use the measured model weights, as the Limit check already did.  On one user's windows the spread fell from 26% to 6%.  An injected 23% limit change still shows at 20 to 23% after weighing, so the weighing does not hide real changes (unless a change lines up exactly with Fable use).  The scanner sends each window's figure as `_limitSize`; the ledger and CSV keep the plain list-price figure.
- **Model weights are measured against Opus.**  Opus is 1.0x and every other model is measured against it, a fixed ruler.  Against the average of recent use, every weight moved when the mix moved (both Fable and Opus rose 11 to 14% between two weeks while Fable/Opus held).  Charts keep their shape and band costs are unchanged (a percent, re-measured each window); stored figures now stay comparable across weeks.  With under 15 Opus ticks the ruler stays the average tick.  A model with no measurement (Haiku, Mythos) now counts like Opus per list-price unit.
- **History's % of 7D is weighed by model.**  The 7D meter weighs Fable like 5H does, so at list prices a Fable day showed at about half its real share of 7D.  Daily, Projects, Hours and Re-reading now weigh each day's work by model.  `history.json` still stores list-price units.
- **8-point minimum.**  The meter shows whole points and reads about a quarter point above zero work, so windows of 1 to 2 points read about 40% low and 3 to 7 about 15% low.  Limit size and the cost rate now need 8 points (was 3); until then the band uses the last window's rate.  The rate is stored under a new key, so the first window after updating shows costs from 8%.
- **"Down N% lately" needs 15%** (was 10%): windows scatter 5 to 7%, and a run of Fable-heavy windows can sit about 9% low.
- **No false "elsewhere" from long calls.**  A reply is logged when it finishes, but the meter counts it while it runs.  A long call (a big cache rewrite after a network error, here 1.2M units) moved the meter 2 points about a minute before it finished, so that jump was counted as use elsewhere when nothing else was running.  A call already running at a reading (its first streamed copy before the reading, its last after) now counts towards that tick.  Ledger rows are recounted under the new rule (`orule` 3).
- **Unknown versions are listed, not guessed.**  A known model family on a version the price table lacks (or an old id with no version) was priced as the newest version; it is now left out and named in the manual, like Mythos Preview.
- **Manual:** the model table says what its ruler is; "How accurate" notes that Opus output may count about 1.5x list and cache reads about 0.7x (unproven, wide ranges), so a read-heavy window can look up to about 10% bigger.

## 0.7.5 (2026-11-18)

No number on the band changes.  The token-type fit is removed, and the README and manual now say how accurate the estimates are.

- **Token-type weights stay at list prices, on purpose.**  Up to 0.7.4 a fit tried to measure how a plan weighs output, cache writes and cache reads, from single meter ticks.  It never switched on: most ticks move exactly 1 point, so its check could never pass.  It also ignored the model weights, so had it switched on it would have priced cache reads near zero.  A replay on two weeks of real data (41 windows), checked by an independent review, found cache reads cannot yet be told apart from the model weights, and adding a read factor did not predict held-out windows better.  The fit is gone, and `_fit` no longer carries `r2`.
- **"How accurate" in the README and the manual.**  What is measured (the meter, in whole points; your transcripts), what is estimated, how well the model weights predict the meter on held-out windows (about 4 to 6% off, against about 28% for list prices alone, with about 2% from rounding), what is not measured (token types), and what the figures do not show (one user, one computer, two weeks).
- **Checked on real data:** every weight, cost, Limit check and turn the scanner reports is identical to 0.7.4.

## 0.7.4 (2026-11-18)

The rest of the 0.7.1 review: one runs-out alert across sessions, costs from the right rate, Mythos priced.

- **Costs no longer read low.**  The rate that turns work into % of 5H divided the meter by all the work so far, including work after the newest reading that had not shown on the meter yet.  It now counts work up to that reading, as the ledger does.  On one real window the old rate was 12% low, so every cost on the band read about 12% under.
- **One "runs out" alert across sessions.**  The once-per-window notification was claimed by reading the store and then writing it, so two sessions could both see "not sent yet" and both notify.  It is now claimed in one locked step (`claims.json` next to the tick log).
- **"Limit reached" at 100%.**  The band, the pace charts and the alert said "runs out in 0m"; they now say the limit is reached.
- **Mythos is priced.**  Mythos 5, 5.1 and 5.2 cost what Fable of the same version costs on Anthropic's pricing page (checked 2026-11-18), so their work now counts in the meters, the ledger and the History pane.  Mythos Preview has no listed price and stays out, named in the manual.
- **Fewer store writes.**  The saved snapshot the next session draws from (it holds the History days too) was rewritten on every refresh; now only when a meter moves or a window resets, else every 5 minutes at most.  The rate is written only when it changes.
- **`/manapool` always answers.**  An error in the command now gives a plain line instead of no answer.
- **Manual and README.**  The ledger keeps the newest 3,000 windows, not every one; the Limit check's "usual" is defined (halfway between the 25th and 75th percentile); refreshes start once the band is shown; Mythos pricing; the desktop install step (**+**, then **Add plugins**).

## 0.7.3 (2026-11-18)

A full store no longer stops the band, and the plugin passes the strict check.

- **A full store no longer fails every refresh.**  The mod's store is capped at 4 MiB.  The alert code wrote straight to it instead of through the write that clears out old sessions and tries again, so once the store was full every refresh failed and the band stopped updating.  Every write now goes through that path, and a write still refused after the clear-out is skipped instead of failing the refresh: the band shows this scan's numbers with the note "Mana Pool storage is full. Some numbers were not saved."  The ledger is rebuilt from transcripts and the rest is written again next time.  The once-per-window "runs out" alert is remembered in the session too, so a refused claim cannot re-send it on every refresh.
- **`claude plugin validate --strict` passes.**  It counted the 111 "possibly undefined" type warnings in `register.tsx` as errors.  Each lookup now states what it relies on (a list read at an index it has just checked, a window kind that is always there), and two lookups that could have come back empty now fall back: a model with no weights uses Sonnet's list weights, and an unknown window kind has a length of 0.
- **Band test** for a store that refuses every write.

## 0.7.2 (2026-11-18)

Fixes from the 0.7.1 review: elsewhere in every band size, one backfill at a time, no scans in sessions that never show the band, a steadier 7D pace, fast mode in forecasts.

- **Elsewhere shows whenever above 0.**  It only showed inside the Limit check in Full, and only once there were past windows to compare with.  Full now shows it on the Limit check row on its own too, Mini has an **Elsewhere** group (dropped after Cache when the line is short of room), and the `/manapool` summary has a line.  The terminal draws the same rows.
- **One backfill at a time.**  Every open session used to start its own one-time history backfill, and a failing one started again on every refresh.  `backfill.lock` now lets one run at a time across sessions (the others say "busy" and leave), and `backfill.json` makes a failed or killed run wait before the next try: 1 minute, doubling up to a day.  The normal scan reports when the next try may start, so no session starts a process just to hear "not yet".
- **No scans in sessions that never show the band.**  Headless runs (`claude -p`, agent and workflow sessions) load the mod too, and each ran its own scan and store writes every 30 seconds (the review found 26 such sessions written in one minute).  Scans now wait for the first draw of the band or a pane, or for `/manapool`.  The terminal starts at once; a desktop-app session starts with no surface, so it waits for its first draw too.
- **7D pace after time away.**  The 7D pace ran from the first reading of the last 24 hours, so a busy morning after a day or two away read as a whole day's pace packed into a few hours and showed a false red "runs out in 1d 8h".  It now runs from the meter's value 24 hours ago (the last reading at or before then) over the full 24 hours, and a 7D window under 3 hours old has no pace yet.  Replayed on one month of real readings, one evening read 40%/day before and 18%/day now.  The 5H pace is unchanged.
- **Fast mode in forecasts.**  Next turn, the re-cache after the prompt cache expires, the hand-off cost and the turns re-priced on your own model ignored fast mode, so they read half the real cost.  They now carry it while you stay on that model, judged by the newest reply, so switching fast mode on or off changes every forecast at once.  Other models in the Other models table stay at standard speed: fast mode belongs to the model it was turned on for.
- **Smaller fixes.**  A label such as "<0.01%" no longer breaks the bar or pill it is drawn in.  A window the scan returned no totals for draws as empty instead of stopping the band.  The Context pill counts auto-compacts only (a `/compact` you ran is a choice, not lost detail).  A pill that flickers at a threshold toasts once: a level re-arms after the pill has stayed better for 15 minutes.
- **Band tests.**  `tests/band.test.tsx` draws the band through Claude Code's own test kit (`claude plugin test .`) on terminal and desktop: elsewhere in Full and Mini, the 7D pace after time away, the Context pill after a manual `/compact`, an escaped label, and a headless session that runs no scan.

## 0.7.1 (2026-11-18)

Elsewhere catches use while no session is open here, leaves rounding out, and no longer shows one gap twice.

- **A window starts at 0%.**  Its start now counts as a reading, so a cloud session that ran a window up to 30% before a session here first read the meter shows as 30% elsewhere.  It used to be missed, because the first reading had nothing before it to compare with.  `resetsAt` sits on a 10-minute grid, so the start is at most 10 minutes early, and work in those minutes counts as work here.
- **7D jumps.**  A whole 5H window used elsewhere that reset before a session here read the meter shows only on 7D.  A 7D jump of 2+ points with under a quarter of its work here now counts, less whatever 5H ticks in the same span already counted, so nothing is counted twice.
- **Elsewhere means the computer was quiet.**  The meter lags the work and shows whole points: a reading can show 0% after work has started, and during heavy work the meter catches up in jumps of several points within a minute, often with little work in that tick.  Use elsewhere at the same time as work here can't be told apart from that anyway.  So the work of the 15 minutes before a tick now counts towards it, plus under a point of rounding carried from earlier (4.9 points of work reads 4% until a little more work makes it 5%).  Older work has shown already, so it can't hide a later jump.  An independent review found that most of what 0.7.0 called elsewhere was lag; on one month of real data every tick it flagged was under 5 minutes long with points of work here just before it, and the remaining elsewhere is one quiet 49-minute stretch.  The carry is judged against the usual figure of windows run mostly on the same model (list prices weigh Fable and Opus unlike the meter does).
- **Elsewhere ticks are left out of the model weights,** which credited the cloud's points to whichever model ran here.
- **Elsewhere is weighed by the work here.**  Each elsewhere point is worth the window's work here over the points that work moved, not over the window's top reading.  The top reading includes the elsewhere points, so the old figure shrank elsewhere by the share used elsewhere: a window run to 30% in the cloud and then to 35% here weighed at 0.14x.
- **One gap is no longer shown twice.**  Work per 1% now counts only the points the work here moved: in the band's costs (last turn, next turn, Other models, the Cost pill), the Limit check and its usual range, Limit size, the ledger table, and the 7D conversion of the History pane (which now adds the 7D window's elsewhere to the reading's work).  A window used partly in the cloud used to show as elsewhere and as a smaller limit at once, and the hatch could stack past the 7D meter.  A window with under 3 points of work here has no Limit size dot.  The usual range rises by the share that was used elsewhere.
- **Ledger rows are recounted.**  A row's elsewhere count made under the old rule is rebuilt while its readings and transcripts are on disk (about 30 days), with the same work per 1%.  Older rows keep their count and are not dropped.  Rows are marked with the rule they were counted under (`orule`).  The CSV keeps the plain per-1% figure.
- **"Not measured".**  Elsewhere only shows between two readings.  A day with none now says "Elsewhere not measured" in the tooltip instead of looking like zero, and a day that caught use from an earlier day says since when ("Elsewhere ~3% since Sat").  The first day of a scan, which is never rebuilt, gets its readings and elsewhere once.
- **The weighting settles.**  The elsewhere points and the work per 1% depend on each other; they are now worked out until neither changes, so elsewhere plus work here never adds up to more than the meter.  A new install with no ledger uses the median of its own windows as the usual figure, in the ledger and Limit check as well as the History pane.
- **7D jumps** allow one point of work here still on its way, instead of dropping a jump when any work came before it.  5H elsewhere already counted is taken off each 7D jump by how much of the 5H tick falls inside it, so each is counted once.
- **Faster, and fewer scans.**  Elsewhere is worked out once per window, from a running total of work, so a scan is no slower than 0.7.0 (0.32 s against 0.34 s on a month of data) despite the extra work.  A meter tick or context change during a turn now starts a scan at most once every 20 seconds (it was every 1.5 seconds plus the scan during agentic work), and the 30-second timer no longer starts a second scan while one is on its way.
- **history.json** gains `s` (readings that day) and `es` (when caught use started).

## 0.7.0 (2026-11-18)

Elsewhere: meter movement that Claude Code on this computer did not cause.

- **Elsewhere in the Daily chart.**  Cloud sessions, claude.ai chat, the phone app and other computers share the limit but write no transcripts here.  A 5H tick with under a quarter of a usual point of local work behind it (the rule the ledger already used for "outside use") is now drawn as a hatched grey segment on top of that day's bar, weighed at its window's work per 1%, and listed in the tooltip.
- **Only lumpy ticks count.**  Elsewhere use that runs at the same time as work here moves the meter the same way a smaller limit would, so it stays in the Limit check as 1% buying less.  Counting it here too would flatten the Limit size chart by construction.
- **A window with no local work at all** borrows the median work per 1% of the other windows, so it still shows.  It is only seen if a session here reads the meter before the window resets.
- **"Outside use" is now "elsewhere"** in the band, the manual, the ledger table and the CSV column (`outside_use_pct` is now `elsewhere_pct`).  The stored field keeps its name, so old ledger rows still read.
- **history.json** gains `e` per day (list units).  Days before this version have none.
- Checks: the hatch stroke on the card is APCA Lc 44.6, and its nearest model colour (Haiku) is OKLab ΔE 12.6 away.  The pattern and legend carry identity, so colour alone is never relied on.

## 0.6.2 (2026-11-17)

Manual wording, and README screenshots.

- **The manual reads plainly.**  It follows Runenir's content rules: no "your", no metaphors, no question-led lines.  "Your numbers right now" is now "Live numbers", "Model cost on your own meter" is "Model cost on this meter", "How accurate is it?" is "Accuracy", and "Blind spot" is "Not counted".  No numbers or rules changed.
- **README:** screenshots of the band in Mini and Full beside the History pane, the same wording rules, and a few jokes at the expense of a shrinking limit.

## 0.6.1 (2026-11-17)

Runenir colours, a shorter band, and History pane fixes.

- **Runenir colours.**  Mana Pool now uses the hues of Runenir, the -nir UI library, at exactly the lightness and saturation it had before, so nothing is brighter or louder.  Greys take a faint violet cast, and the accent, blue and red are Runenir's.  Backgrounds, green, amber, the cache orange and model colours are unchanged.
- **Pills follow Runenir's badge rule:** the level sits in the pill's tint and a 35% edge, and the words are main text.  Red pill words go from APCA Lc 43 to 89.  In Mini the dotted (amber) and dashed (red) edges stay.
- **Nothing is pushed off the band's edge.**  In Mini, a limit that would run out turns from a bar into a ring with its percent and "out in" beside it, so the warning takes about the bar's own room and Cache stays.  If the line is still too wide, Cache, then Last turn, then the 7D bar drop.  In Full the two meters share the band's width (stacked under 52 columns), and rows truncate instead of wrapping or pushing their pill out.
- **Full is two rows shorter, with nothing dropped.**  Each meter's line (percent, pace, reset, runway) sits inside its bar, as in Mini, and Next turn joins the Last turn line as "next".
- **Limit size in colour.**  Each window's dot is violet above the median (a bigger limit) and coral below (a smaller one), full colour at 20% off, as in Limit by time.  The median's value moved to the legend, where the dots no longer cover it.
- **History range buttons respond again.**  The desktop app can lose a redraw of the History pane (about 200k characters of charts) when a second redraw lands while it is still drawing, leaving the old drawing up with dead buttons; reopening the pane then drew nothing.  The pane read the band's live numbers, which change every 30 seconds and several times per refresh, so a range press often collided with a background redraw.  History now keeps its own copy, updated at most every 5 minutes (sooner on first draw and when older days finish loading), so it redraws almost only when pressed.  The refresh spinner also has its own value that only the band reads.
- **90D draws.**  Past roughly 250k characters of charts the desktop app stops redrawing the pane, and 90D was about 300k.  At 90 days, Daily and Re-reading now show one tooltip per week (a bar is about 4 px wide there), and the hover marks share one set of styles, so 90D is about 215k and stays under 235k with a full 90 days of data.
- **Terminal bars.**  The terminal now draws its block bars and the meters' text line; it had been handed a drawing element it cannot show, so the bars were blank there.

## 0.6.0 (2026-11-14)

More History charts, and hover everywhere.

- **7D pace.**  This week against an even pace to 100% at reset and last week, drawn like 5H pace, with the projection from the band's runway.  Once 3 past weeks are logged it shows their middle half as a band instead of last week.
- **7D readings are kept 120 days** in `samples.jsonl` (5H readings stay at 30), so 7D pace has past weeks to compare against.
- **Limit by time.**  Work per 1% of 5H by weekday and 4-hour block, against the median of all kept ticks: shows whether the limit is bigger at night or on weekends.  Built from single ticks, model-adjusted (a pricier model does not read as a smaller limit), leaving out ticks over 90 minutes or crossing a block and outside use.  A cell with too few ticks to trust is drawn as an outline.
- **Limit size is dated:** a date under the first window of each day, and each window's start and end times on hover.
- **Hover crosshairs and tooltips on every chart,** with the raw numbers (work units, calls, readings, ranges).  CSS only, as the pane allows no scripts in a chart.

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
