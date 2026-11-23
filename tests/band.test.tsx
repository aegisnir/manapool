// Band tests: run with `claude plugin test .` from the repository root.
// Each test seeds the mod's saved numbers (the `view` value) as a scan would
// leave them, draws the band above the prompt, and reads its words back.
// No scan runs: nothing here reads transcripts or starts Python.
import { expect, test } from 'claude-code/testing'

const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
const tok = { input: 0, output: 0, cache_write: 0, cache_read: 0, messages: 0, units: 0, listUnits: 0, models: {} }

const viewOf = (p5: number, p7: number, extra: Record<string, unknown> = {}) => ({
  wins: [
    { kind: 'five_hour', pct: p5, resetsAt: iso(NOW + 2 * 3600e3), tokens: tok },
    { kind: 'seven_day', pct: p7, resetsAt: iso(NOW + 3 * 86400e3), tokens: tok },
  ],
  samples: [], updatedAt: Math.floor(NOW / 1000), rate: 0.001,
  ...extra,
})

// A call on `$` is answered { value: <its result> }; state.get's result is
// itself { value, version }, and a shaped atom's value carries its tag.
const seed = (on: any, view: unknown, mode = 'full') =>
  on('state.get', (_: unknown, e: any) => {
    if (e.key === 'view') return { value: { value: { shape: 'view-3', value: view }, version: 1 } }
    if (e.key === 'mode') return { value: { value: { shape: 'mode-3', value: mode }, version: 1 } }
    return { value: { value: undefined, version: 0 } }
  })

const BAND = (surface: 'terminal' | 'desktop') =>
  ({ plugin: 'manapool', component: 'AbovePrompt', surface, props: { bodyColumns: 120, hasSurvey: false } }) as any

test('the band draws', async ($, on) => {
  seed(on, viewOf(12, 30))
  const ui = await $.ui.mount(BAND('terminal'))
  const row = await ui.find({ type: 'Text', text: /Mana Pool/ })
  expect(row?.text).toBe('Mana Pool')
  await ui.unmount()
})

// Every Text the band drew, joined, so a test can look for words anywhere.
const words = async (ui: any) => ((await ui.findAll({ type: 'Text' })) as any[]).map(t => t.text).join(' | ')
const CHECK = { per1: null, pct: 4, herePct: 1, lo: null, hi: null, n: 0, weights: 'list', outside: 3 }
const SESSION = {
  since5h: { input: 0, output: 0, cache_write: 0, cache_read: 0, messages: 0, units: 0 }, allOn: {},
  base: 20000, grow: 0, turns: [], turnCount: 0, turnsIn5h: 0, share1h: null, hourUnits: 0,
  compactions: 0, compactionsAll: 1, lastCompact: null, lastSeen: null, subagentCalls: 0, lastModel: null,
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: Mini shows elsewhere when above 0`, async ($, on) => {
    seed(on, viewOf(12, 30, { check: CHECK }), 'mini')
    const ui = await $.ui.mount(BAND(surface))
    expect(await words(ui)).toMatch(/Elsewhere .*3%/)
    await ui.unmount()
  })
  test(`${surface}: Full shows elsewhere with no past windows to compare`, async ($, on) => {
    seed(on, viewOf(12, 30, { check: CHECK }))
    const ui = await $.ui.mount(BAND(surface))
    const w = await words(ui)
    expect(w).toMatch(/Limit check/)
    expect(w).toMatch(/3% elsewhere/)
    expect(w).not.toMatch(/buys/)
    await ui.unmount()
  })
}

test('Full without elsewhere or past windows has no Limit check row', async ($, on) => {
  seed(on, viewOf(12, 30, { check: { ...CHECK, outside: 0 } }))
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await words(ui)).not.toMatch(/Limit check/)
  await ui.unmount()
})

test('7D pace after time away: from the value 24 hours ago, not a false runs-out', async ($, on) => {
  const ra = iso(NOW + 3 * 86400e3), s = NOW / 1000
  // 20% three days ago, nothing since (away), then a busy 3 hours to 26%
  const samples = [
    { at: s - 3 * 86400, kind: 'seven_day', pct: 20, resetsAt: ra },
    { at: s - 3 * 3600, kind: 'seven_day', pct: 20, resetsAt: ra },
    { at: s - 60, kind: 'seven_day', pct: 26, resetsAt: ra },
  ]
  seed(on, viewOf(12, 26, { samples }))
  const ui = await $.ui.mount(BAND('terminal'))
  const w = await words(ui)
  // 6 points over 24 hours is 6%/day: lasts.  Measured from the first reading
  // of the last day it read 48%/day and "runs out in 1d 13h".
  expect(w).toMatch(/7D/)
  expect(w).not.toMatch(/runs out/)
  await ui.unmount()
})

test('a 7D window under 3 hours old has no pace yet', async ($, on) => {
  const ra = iso(NOW + 7 * 86400e3 - 3600e3), s = NOW / 1000
  // 0% half an hour ago, 1% now: one whole-point step, not 48%/day
  seed(on, viewOf(12, 1, { samples: [{ at: s - 1800, kind: 'seven_day', pct: 0, resetsAt: ra }, { at: s - 60, kind: 'seven_day', pct: 1, resetsAt: ra }],
    wins: [{ kind: 'seven_day', pct: 1, resetsAt: ra, tokens: tok }] }))
  const ui = await $.ui.mount(BAND('terminal'))
  const w = await words(ui)
  expect(w).not.toMatch(/pace/)
  expect(w).not.toMatch(/runs out/)
  await ui.unmount()
})

test('a /compact you ran does not turn the Context pill red', async ($, on) => {
  seed(on, viewOf(12, 30, { session: SESSION }))
  const ui = await $.ui.mount(BAND('terminal'))
  const w = await words(ui)
  expect(w).toMatch(/Fine/)
  expect(w).not.toMatch(/auto-compacted/)
  await ui.unmount()
})

test('desktop: a "<0.01%" label is escaped inside the pill drawing', async ($, on) => {
  const turn = { t: NOW / 1000 - 600, u: 1, h: 0, f: 1, n: 1, subs: 0, out: 10, ctx: 1000, k: 'sonnet', on: { sonnet: 1 }, onf: { sonnet: 1 } }
  seed(on, viewOf(12, 30, { session: { ...SESSION, compactionsAll: 0, turns: [turn], turnCount: 1 } }), 'mini')
  const ui = await $.ui.mount(BAND('desktop'))
  const svgs = (await ui.findAll({ type: 'Svg' })) as any[]
  const src = svgs.map(x => String(x.props?.source ?? x.source ?? '')).join('\n')
  expect(src).toMatch(/<svg/)
  expect(src).toMatch(/&lt;0\.01%/)
  expect(src).not.toMatch(/><0\.01%/)
  await ui.unmount()
})

// Real time (the test's own), for work the mod starts on its timers.
const wait = (ms: number) => new Promise(r => (globalThis as any).setTimeout(r, ms))

// S3: a session that never draws the band (claude -p, agent and workflow
// sessions) starts no timer and runs no scan; the first draw starts them.
test('headless: no scan until the band is drawn', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_: unknown, e: any) => { runs.push([...(e.argv ?? [])]); return { value: { exitCode: 1, stdout: '', stderr: 'test' } } as any })
  on('command.register', () => ({ value: { command: 'manapool' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: { rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: iso(NOW + 2 * 3600e3) }] } }) as any)
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('fs.read', () => ({ value: '{"version":"0.0.0"}' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [] }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('state.set', (_: unknown, e: any) => ({ value: { isSet: true, version: 2 } }))
  seed(on, viewOf(12, 30))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as any)
  await wait(200)
  expect(runs.length).toBe(0)
  const ui = await $.ui.mount(BAND('desktop'))
  await wait(300)
  expect(runs.length).toBeGreaterThan(0)
  await ui.unmount()
})

// A3: a store that refuses every write (full) must not fail the refresh.
// The band still gets this scan's numbers, with a note that some were not saved.
test('a full store does not stop the refresh', async ($, on) => {
  const views: any[] = []
  on('process.run', (_: unknown, e: any) => {
    const argv = [...(e.argv ?? [])] as string[]
    // the Python check, then the scan (which reports nothing much: no work yet)
    const out = argv.includes('-c') ? '3' : JSON.stringify({ _samples: [], _check: null })
    return { value: { exitCode: 0, stdout: out, stderr: '' } } as any
  })
  on('command.register', () => ({ value: { command: 'manapool' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: { rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: iso(NOW + 2 * 3600e3) }] } }) as any)
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('fs.read', () => ({ value: '{"version":"0.0.0"}' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ deny: 'store full' }) as any)  // refused, as a full store refuses
  on('store.keys', () => ({ value: [] }))
  on('store.delete', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('state.set', (_: unknown, e: any) => {
    if (e.key === 'view') views.push(e.value?.value)
    return { value: { isSet: true, version: 2 } }
  })
  seed(on, viewOf(12, 30))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  await wait(400)
  // (the seeded state.get keeps answering the seeded view, so each write is
  // looked at on its own: the scan's view, then the note)
  const written = views.filter(Boolean)
  expect(written.some(v => v.wins?.length === 1 && !v.error)).toBe(true)
  expect(written.some(v => /storage is full/.test(String(v.error)))).toBe(true)
  expect(written.some(v => /Error/.test(String(v.error)))).toBe(false)
})

// A4: at 100% the 5H limit is reached; it never says "runs out in 0m".
for (const mode of ['full', 'mini'] as const) {
  test(`${mode}: at 100% it says limit reached`, async ($, on) => {
    const ra = iso(NOW + 2 * 3600e3), s = NOW / 1000
    seed(on, viewOf(100, 30, { samples: [{ at: s - 1800, kind: 'five_hour', pct: 90, resetsAt: ra }, { at: s - 60, kind: 'five_hour', pct: 100, resetsAt: ra }] }), mode)
    const ui = await $.ui.mount(BAND('terminal'))
    const w = await words(ui)
    expect(w).toMatch(/limit reached/)
    expect(w).not.toMatch(/0m/)
    await ui.unmount()
  })
}

// Mythos 5.2 is priced: on it, the Cost pill is not "Unpriced".
test('Mythos 5.2 is priced on the band', async ($, on) => {
  seed(on, viewOf(12, 30, { model: 'claude-mythos-5-2' }))
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await words(ui)).not.toMatch(/Unpriced|unpriced/)
  await ui.unmount()
})

// B: History's % of 7D weighs each model.  The 7D reading says 100,000 list
// units bought 10% (so 10,000 per 1%, mix weight 1.0).  Today Fable did
// 100,000 list units, and the meter weighs Fable 2x: 20% of 7D, not 10%.
test('History: a Fable day shows at its weighed share of 7D', async ($, on) => {
  const d = new Date(), key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const ra = iso(NOW + 3 * 86400e3)
  const view = viewOf(12, 10, {
    wins: [{ kind: 'seven_day', pct: 10, resetsAt: ra, tokens: { ...tok, units: 100000, listUnits: 100000 } }],
    samples: [{ at: NOW / 1000 - 600, kind: 'seven_day', pct: 10, lu: 100000, resetsAt: ra }],
    fit: { source: 'fit-models', ticks: 0, K: [1, 1, 1, 1], MM: { fable: 2, opus: 1 }, model_ticks: {} },
    history: { full: true, days: { [key]: { m: { fable: 100000 }, p: { x: 100000 }, h: Array(24).fill(0), r: 0, n: 1 } } },
  })
  on('state.get', (_: unknown, e: any) => {
    if (e.key === 'hist') return { value: { value: { shape: 'hist-1', value: view }, version: 1 } }
    if (e.key === 'range') return { value: { value: { shape: 'range-1', value: 7 }, version: 1 } }
    return { value: { value: undefined, version: 0 } }
  })
  on('store.get', () => ({ value: [] }))
  const ui = await $.ui.mount({ plugin: 'manapool', component: 'Pane', requestId: 'manapool-history', surface: 'desktop',
    props: { title: 'Mana Pool History', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as any)
  // the Daily chart's peak label and tooltip carry the day's share
  const src = ((await ui.findAll({ type: 'Svg' })) as any[]).map(x => String(x.props?.source ?? x.source ?? '')).join('\n')
  expect(src).toMatch(/>20\.0%</)
  expect(src).not.toMatch(/>10\.0%</)
  await ui.unmount()
})

// 0.7.8: 5H windows replaces Limit size.  85 days of busy 5H windows (three a
// day, a reading every 2 minutes) must stay inside the pane's limits at every
// range: one Svg under 131,072 characters, all charts together under about
// 250k (past that the desktop app stops redrawing the pane).  The pace charts
// say "Usual range", not "Middle half".
const busyHistory = () => {
  const samples: any[] = [], ledger: any[] = [], limitSize: Record<string, number> = {}
  const day0 = Math.floor(NOW / 1000) - 85 * 86400
  for (let d = 0; d < 85; d++) for (const h of [8, 14, 19]) {
    const st = day0 + d * 86400 + h * 3600, ra = iso((st + 5 * 3600) * 1000)
    if (st + 5 * 3600 > NOW / 1000) continue
    for (let i = 1; i <= 150; i++) samples.push({ at: st + i * 120, kind: 'five_hour', pct: Math.min(100, Math.round(i * 0.4 + (d % 5))), resetsAt: ra })
    const pct = Math.min(100, Math.round(150 * 0.4 + (d % 5)))
    ledger.push({ kind: 'five_hour', resetsAt: ra, start: st, end: st + 5 * 3600, pct, seen: st + 18000, units: pct * 700000, per1: 700000,
      tokens: [0, 0, 0, 0], models: ['Opus'], outside: 0, weights: 'list', at: st + 18000, readings: 150, rule: 4, orule: 3 })
    limitSize[ra] = 700000 * (1 + ((d * 7 + h) % 13 - 6) / 100)
  }
  return { samples, ledger, limitSize }
}
for (const range of [7, 30, 90] as const) {
  test(`History ${range}D: 5H windows replaces Limit size, and stays inside the pane's size limits`, async ($, on) => {
    const { samples, ledger, limitSize } = busyHistory()
    const view = viewOf(40, 30, { samples, limitSize })
    on('state.get', (_: unknown, e: any) => {
      if (e.key === 'hist') return { value: { value: { shape: 'hist-1', value: view }, version: 1 } }
      if (e.key === 'range') return { value: { value: { shape: 'range-1', value: range }, version: 1 } }
      return { value: { value: undefined, version: 0 } }
    })
    on('store.get', (_: unknown, e: any) => ({ value: e?.key === 'ledger' ? ledger : [] }))
    const ui = await $.ui.mount({ plugin: 'manapool', component: 'Pane', requestId: 'manapool-history', surface: 'desktop',
      props: { title: 'Mana Pool History', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as any)
    const w = await words(ui)
    expect(w).toMatch(/5H windows/)
    expect(w).not.toMatch(/Limit size/)
    const svgs = ((await ui.findAll({ type: 'Svg' })) as any[]).map(x => String(x.props?.source ?? x.source ?? ''))
    const all = svgs.join('\n')
    expect(all).toMatch(/Climb of each window/)
    expect(all).toMatch(/Usual range/)
    expect(all).not.toMatch(/Middle half/)
    // trim() keeps one decimal, so an opacity written 0.07 became 0.0 and
    // the hover highlight vanished.  No drawing may carry a zero opacity.
    expect(all).not.toMatch(/opacity="0\.0"/)
    // A climb near the limit is a stronger violet, never red (red means a smaller limit).
    expect(all).not.toMatch(/stroke="#fe5166" stroke-width="1\.5" stroke-linejoin/)
    if (range === 7) expect(all).toMatch(/url\(#wClimb\)" fill-opacity="0\.6"/)
    // Work per 1% in units on the left and Opus dollars on the right (700k units = $1.40)
    expect(all).toMatch(/>\$1\.40</)
    expect(all).toMatch(/700k \(\$1\.40\) per 1%/)
    for (const s of svgs) expect(s.length).toBeLessThan(131072)
    expect(svgs.reduce((a, s) => a + s.length, 0)).toBeLessThan(250000)
    await ui.unmount()
  })
}

// 0.7.11: the pace lines take Daily's model colours.  Each rise is the model
// that did most of the work since the reading before (readings carry every
// model's tokens since the window started); a rise with no work here is
// Elsewhere.  A 5H window that switches model every few readings must still
// stay inside the per-Svg size limit (one path per run of a colour).
test('History: pace lines in model colours, with Elsewhere', async ($, on) => {
  const now = NOW / 1000, ra7 = iso(NOW + 3 * 86400e3), ra5 = iso(NOW + 2 * 3600e3)
  const M = (o: number, f: number) => ({ 'claude-opus-5-5': [0, o, 0, 0], 'claude-fable-5-2': [0, f, 0, 0] })
  const samples: any[] = [
    { at: now - 3.5 * 86400, kind: 'seven_day', pct: 5, resetsAt: ra7, models: M(1e6, 0) },
    { at: now - 2.5 * 86400, kind: 'seven_day', pct: 15, resetsAt: ra7, models: M(1e6, 1e6) },
    { at: now - 2 * 86400, kind: 'seven_day', pct: 16, resetsAt: ra7, models: M(1e6, 1e6) },
  ]
  // 5H: a reading every 2 minutes for 3 hours, the model switching every 3 readings
  let o = 0, f = 0
  for (let i = 1; i <= 90; i++) {
    if (Math.floor(i / 3) % 2) f += 5e4; else o += 5e4
    samples.push({ at: now - 3 * 3600 + i * 120, kind: 'five_hour', pct: Math.round(i / 3), resetsAt: ra5, models: M(o, f) })
  }
  const live = (a: number, b: number) => ({ 'claude-opus-5-5': { input: 0, output: a, cache_write: 0, cache_read: 0, units: 0 }, 'claude-fable-5-2': { input: 0, output: b, cache_write: 0, cache_read: 0, units: 0 } })
  const view = viewOf(30, 16, {
    wins: [{ kind: 'five_hour', pct: 30, resetsAt: ra5, tokens: { ...tok, models: live(o, f) } },
      { kind: 'seven_day', pct: 16, resetsAt: ra7, tokens: { ...tok, models: live(1e6, 1e6) } }],
    samples,
  })
  on('state.get', (_: unknown, e: any) => {
    if (e.key === 'hist') return { value: { value: { shape: 'hist-1', value: view }, version: 1 } }
    if (e.key === 'range') return { value: { value: { shape: 'range-1', value: 7 }, version: 1 } }
    return { value: { value: undefined, version: 0 } }
  })
  on('store.get', () => ({ value: [] }))
  const ui = await $.ui.mount({ plugin: 'manapool', component: 'Pane', requestId: 'manapool-history', surface: 'desktop',
    props: { title: 'Mana Pool History', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as any)
  const w = await words(ui)
  expect(w).toMatch(/Opus/)
  expect(w).toMatch(/Fable/)
  expect(w).toMatch(/Elsewhere/)
  expect(w).not.toMatch(/This week/)
  const svgs = ((await ui.findAll({ type: 'Svg' })) as any[]).map(x => String(x.props?.source ?? x.source ?? ''))
  const all = svgs.join('\n')
  expect(all).toMatch(/fill="#eac75e" fill-opacity="0\.3"/) // a Fable band
  expect(all).toMatch(/This week \d+% · Fable/)
  expect(all).toMatch(/This week \d+% · Elsewhere/)
  // 0.7.12: projection and dot take the last model that did work here.  7D:
  // Fable, not Elsewhere's grey (no 7D projection here: too few readings for a
  // runway).  5H: its last switch was to Opus.
  expect(all).toMatch(/r="4" fill="#eac75e"/)
  expect(all).toMatch(/stroke="#8d7cd5" stroke-width="2" stroke-dasharray="2 4"/)
  for (const s of svgs) expect(s.length).toBeLessThan(131072)
  await ui.unmount()
})

// 0.7.14: a model that helped but never led a rise still shows, as its share
// of a split band and as a legend entry with its share of the window.
test('History: a minority model gets a band slice and a legend share', async ($, on) => {
  const now = NOW / 1000, ra7 = iso(NOW + 3 * 86400e3), ra5 = iso(NOW + 2 * 3600e3)
  const M = (f: number, s: number) => ({ 'claude-fable-5-2': [0, f, 0, 0], 'claude-sonnet-5-5': [0, s, 0, 0] })
  // Fable leads every rise; Sonnet adds a third as much on one of them
  const samples: any[] = [
    { at: now - 3 * 3600, kind: 'five_hour', pct: 5, resetsAt: ra5, models: M(1e6, 0) },
    { at: now - 2 * 3600, kind: 'five_hour', pct: 10, resetsAt: ra5, models: M(2e6, 1.5e6) },
    { at: now - 1 * 3600, kind: 'five_hour', pct: 15, resetsAt: ra5, models: M(3e6, 1.5e6) },
  ]
  const live = { 'claude-fable-5-2': { input: 0, output: 3e6, cache_write: 0, cache_read: 0, units: 0 }, 'claude-sonnet-5-5': { input: 0, output: 1.5e6, cache_write: 0, cache_read: 0, units: 0 } }
  const view = viewOf(15, 10, { wins: [{ kind: 'five_hour', pct: 15, resetsAt: ra5, tokens: { ...tok, models: live } },
    { kind: 'seven_day', pct: 10, resetsAt: ra7, tokens: tok }], samples })
  on('state.get', (_: unknown, e: any) => {
    if (e.key === 'hist') return { value: { value: { shape: 'hist-1', value: view }, version: 1 } }
    if (e.key === 'range') return { value: { value: { shape: 'range-1', value: 7 }, version: 1 } }
    return { value: { value: undefined, version: 0 } }
  })
  on('store.get', () => ({ value: [] }))
  const ui = await $.ui.mount({ plugin: 'manapool', component: 'Pane', requestId: 'manapool-history', surface: 'desktop',
    props: { title: 'Mana Pool History', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as any)
  const w = await words(ui)
  // Fable output at 4x Sonnet's list price: 60M vs 7.5M units
  expect(w).toMatch(/Fable 89%/)
  expect(w).toMatch(/Sonnet 11%/)
  const all = ((await ui.findAll({ type: 'Svg' })) as any[]).map(x => String(x.props?.source ?? x.source ?? '')).join('\n')
  expect(all).toMatch(/fill="#a8ceff" fill-opacity="0\.3"/) // a Sonnet slice
  expect(all).not.toMatch(/stroke="#a8ceff"/) // but no Sonnet line: it never led
  await ui.unmount()
})

// 0.7.15: 5H windows splits each climb by model, as Daily does.
test('History 7D: 5H windows climbs in model colours', async ($, on) => {
  const now = NOW / 1000, ra7 = iso(NOW + 3 * 86400e3), raOld = iso(NOW - 20 * 3600e3)
  const M = (f: number, o: number) => ({ 'claude-fable-5-2': [0, f, 0, 0], 'claude-opus-5-5': [0, o, 0, 0] })
  // a past window: Opus first, then Fable
  const samples: any[] = [
    { at: now - 24 * 3600, kind: 'five_hour', pct: 10, resetsAt: raOld, models: M(0, 2e6) },
    { at: now - 23 * 3600, kind: 'five_hour', pct: 40, resetsAt: raOld, models: M(3e6, 2e6) },
  ]
  const view = viewOf(0, 10, { wins: [{ kind: 'five_hour', pct: 0, resetsAt: iso(NOW + 2 * 3600e3), tokens: tok },
    { kind: 'seven_day', pct: 10, resetsAt: ra7, tokens: tok }], samples })
  on('state.get', (_: unknown, e: any) => {
    if (e.key === 'hist') return { value: { value: { shape: 'hist-1', value: view }, version: 1 } }
    if (e.key === 'range') return { value: { value: { shape: 'range-1', value: 7 }, version: 1 } }
    return { value: { value: undefined, version: 0 } }
  })
  on('store.get', () => ({ value: [] }))
  const ui = await $.ui.mount({ plugin: 'manapool', component: 'Pane', requestId: 'manapool-history', surface: 'desktop',
    props: { title: 'Mana Pool History', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as any)
  const svgs = ((await ui.findAll({ type: 'Svg' })) as any[]).map(x => String(x.props?.source ?? x.source ?? ''))
  const win = svgs.find(s => s.includes('Climb of each window')) ?? ''
  expect(win).toMatch(/stroke="#eac75e"/) // a Fable rise
  expect(win).toMatch(/stroke="#8d7cd5"/) // an Opus rise
  expect(win).not.toMatch(/url\(#wClimb\)"/) // no single-colour climb left
  await ui.unmount()
})
