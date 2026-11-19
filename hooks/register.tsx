import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ByTimeCell, Check, LedgerRow, Sample, Session, Turn, View, Win } from '../types'

// The slash command and the side pane's id.
const CMD = 'manapool'
const PANE = 'manapool'
const BUILD = '2026-11-18.15' // bump on each edit: the store's `loaded` key shows which build is running
const view = atom({ plugin: 'manapool', key: 'view' } as const, null, { shape: 'view-3' })
const mode = atom({ plugin: 'manapool', key: 'mode' } as const, 'full', { shape: 'mode-3' })
const lastReply = atom({ plugin: 'manapool', key: 'lastReply' } as const, null, { shape: 'last-3' })
const busyAtom = atom({ plugin: 'manapool', key: 'busy' } as const, false, { shape: 'busy-3' })
const rangeAtom = atom({ plugin: 'manapool', key: 'range' } as const, 30, { shape: 'range-1' })
// The spinner's frame, kept apart from `view`: it ticks about 6 times a second
// during a refresh, and only the band draws it.  Inside `view` it made the
// History pane (which reads `view`) redraw every chart on every tick.
const spinAtom = atom({ plugin: 'manapool', key: 'spin' } as const, 0, { shape: 'spin-1' })
// The History pane's own copy of the numbers.  The desktop app can lose a
// redraw of a pane this heavy (about 200k characters of charts) when another
// redraw lands while it is still drawing: the old drawing stays up with dead
// buttons.  `view` changes every 30 s and several times per refresh, so the
// pane reading it redrew constantly and a range press often collided.  This
// copy changes at most every 5 minutes (sooner for the first draw and when the
// older days finish loading), so the pane redraws almost only when pressed.
const histAtom = atom({ plugin: 'manapool', key: 'hist' } as const, null, { shape: 'hist-1' })
const HIST_EVERY_MS = 5 * 60 * 1000
// The History pane's id.
const HPANE = `${PANE}-history`

// Window lengths in seconds.  Named windows are always there; a kind read
// from data may not be, so a lookup by name can be undefined.
type ByKind = { readonly five_hour: number; readonly seven_day: number; readonly [kind: string]: number | undefined }
const SPAN: ByKind = { five_hour: 5 * 3600, seven_day: 7 * 86400 }
// A window's totals when the scan returned none for it: zero, so the band draws.
const NO_TOKENS = { input: 0, output: 0, cache_write: 0, cache_read: 0, messages: 0, units: 0, listUnits: 0, models: {} }
// The prompt cache keeps the conversation for an hour after each reply
// (Claude Code asks for the 1-hour kind), then the next message pays to reload it.
const TTL_MS = 60 * 60 * 1000
const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
// Units per token at list prices (1 unit = one Sonnet 5.5 input token, $2 per
// million): input, output, cache write, cache read.  scan.py sends the weights
// in use (per model version, moved toward your own meter ticks as they build
// up); this is only the fallback before the first scan.
const LISTW: Record<string, number[]> = {
  mythos: [4, 20, 8, 0.1], fable: [4, 20, 8, 0.1], opus: [2, 10, 4, 0.1], sonnet: [1, 5, 2, 0.05], haiku: [0.05, 0.25, 0.1, 0.005],
}
// Saved per-session entries (ses:<id>, alerts:<id>) are dropped after this
// long unused.  The whole store is capped at 4 MiB by Claude Code.
const KEEP_SESSION_MS = 7 * 86400e3
const MAX_SESSIONS = 40
const MAX_LEDGER = 3000
// Ledger rows built under an older accounting rule are kept for the record but
// left out of every chart and comparison: they priced work differently.  Must
// equal RULE in scan.py (a test checks).
const LEDGER_RULE = 4
const current = (r: LedgerRow) => (r.rule ?? 0) >= LEDGER_RULE
// Work per 1% counts only the points the work here moved (scan.py here_pts:
// keep equal).  The points moved elsewhere are in the meter but not in the
// work, so leaving them in would show a window used partly in the cloud as a
// smaller limit too.  Rows keep the plain figure, so old rows are corrected
// here as well.  Under 3 points of work here, a window has no figure.
const herePts = (r: LedgerRow) => r.pct - (r.outside ?? 0)
const herePer1 = (r: LedgerRow) => (herePts(r) >= 3 && (r.per1 ?? 0) > 0 ? ((r.per1 as number) * r.pct) / herePts(r) : 0)
// A runway shorter than this raises one system notification per 5H window.
const WALL_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const fmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`
const dur = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const day = (ms: number) =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const grp = (n: number) => Math.round(n).toLocaleString('en-US')
// A share of the 5H limit: two decimals under 0.1, one above.
const pctTxt = (x: number) => (x < 0.005 ? '<0.01%' : x < 0.1 ? `${x.toFixed(2)}%` : x >= 100 ? `${Math.round(x)}%` : `${x.toFixed(1)}%`)
const cap = (k: string) => k.charAt(0).toUpperCase() + k.slice(1)
const keyOf = (id: string) => {
  const m = (id || '').toLowerCase()
  // Mythos is priced per version (5, 5.1, 5.2, as Fable); one with no listed
  // price (Mythos Preview) stays unpriced like any unknown model (scan.py key_of).
  return m.includes('mythos') ? (['5', '5.1', '5.2'].includes(verOf(id)) ? 'mythos' : '') : m.includes('fable') ? 'fable' : m.includes('opus') ? 'opus' : m.includes('haiku') ? 'haiku' : m.includes('sonnet') ? 'sonnet' : ''
}
// "claude-haiku-4-5-20251001" -> "4.5" (same rule as scan.py's ver_of)
const verOf = (id: string) => {
  const m = /(?:fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec((id || '').toLowerCase())
  return m ? m[1] + (m[2] ? `.${m[2]}` : '') : ''
}
const median = (a: number[]) => {
  if (a.length === 0) return 0
  const s = [...a].sort((x, y) => x - y)
  const n = s.length
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}

// ---------------------------------------------------------------------------
// Colour.  Bars use a rating-ring spectrum: the tip
// colour runs red -> amber -> green by how much is LEFT.  Colours in OKLCH.
// ---------------------------------------------------------------------------
type Ok = [number, number, number]
const ERROR: Ok = [0.711, 0.166, 17.9] // Runenir's red hue
const WARNING: Ok = [0.837, 0.164, 84.4]
const SUCCESS: Ok = [0.773, 0.153, 163.2]
const mixOk = (a: Ok, b: Ok, t: number): Ok => {
  let h1 = a[2], h2 = b[2]
  const d = h2 - h1
  if (d > 180) h1 += 360
  else if (d < -180) h2 += 360
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, h1 + (h2 - h1) * t]
}
const hexOk = ([L, C, H]: Ok) => {
  // OKLCH -> sRGB hex (Bjorn Ottosson's published OKLab matrices)
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const enc = (x: number) => Math.round(255 * Math.max(0, Math.min(1, Math.abs(x) <= 0.0031308 ? 12.92 * x : 1.055 * Math.abs(x) ** (1 / 2.4) - 0.055)))
  const rgbv = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  return '#' + rgbv.map(v => enc(v).toString(16).padStart(2, '0')).join('')
}
const tipOk = (consumed: number): Ok => {
  const v = 100 - Math.max(0, Math.min(100, consumed))
  return v <= 50 ? mixOk(ERROR, WARNING, v / 50) : mixOk(WARNING, SUCCESS, (v - 50) / 50)
}
const shiftStart = (tip: Ok): Ok => [tip[0] - 0.12, tip[1] * 1.08, tip[2] - 18]
const shiftEnd = (tip: Ok): Ok => [tip[0] + 0.04, tip[1], tip[2]]
const tone = (consumed: number) => hexOk(tipOk(consumed))
const rgb = (x: string) => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16))
const mix = (a: string, b: string, t: number) => {
  const x = rgb(a), y = rgb(b)
  return '#' + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')
}
const SURFACE = '#262626'
// Colours: Runenir's hues (the shared -nir UI library) at the lightness and
// saturation Mana Pool always used, so nothing got brighter or louder.  Greys
// carry Runenir's faint violet cast; the accent, blue and red are Runenir's.
const RED = '#f8707a'
const ME = '#a38df8'      // your current model, and "new work" in the turn strip
const HIST = '#6c6a72'    // "re-reading history" in the turn strip
const DIM = '#9b99a1'     // caption grey
// Pill levels: 0 green, 1 blue (an opportunity), 2 amber, 3 red.  Pills follow
// Runenir's badge rule: the level sits in the pill's tint and edge, and the
// words are main text (APCA Lc 87 to 89, where coloured words were 43 to 66).
const LVL = ['#35d399', '#79b4fe', '#fbbf25', '#f8707a']
const COLD = '#79b4fe'    // the prompt cache has expired
const WARM = '#f6b26b'    // the prompt cache is active
const SEP = '#48464d'     // the hairline between band sections

// ---------------------------------------------------------------------------
// The numbers behind every row, worked out once from the saved view so the
// band, the /manapool text and the alerts always agree.  Pure: no `$`.
// ---------------------------------------------------------------------------
type Pill = { lvl: number; label: string; why: string }
type Runway = { r: number; text: string; bad: boolean; leftMs: number }

const derive = (v: View, last: number | null, now: number) => {
  const w5 = v.wins.find(w => w.kind === 'five_hour')
  const w7 = v.wins.find(w => w.kind === 'seven_day')
  const ses: Session | undefined = v.session
  const W = v.weights ?? LISTW
  // Weights for a call whose prompt is `prompt` tokens long: past a model's
  // long-prompt threshold (Haiku 5.5 over 100k) its higher tier applies.
  const wAt = (k: string, prompt: number) => {
    const lg = v.long?.[k]
    return lg && prompt > lg.over ? lg.w : (W[k] ?? LISTW[k] ?? LISTW.sonnet!)
  }
  const rate = v.rate ?? 0
  const ok = rate > 0
  const pc = (u: number) => u * rate // work units -> % of the 5H limit
  const turns: Turn[] = ses?.turns ?? []
  const done = turns.filter(t => !t.live)
  const lt = done[done.length - 1]
  // your model: the one Claude Code reports, else the one the last turn ran on.
  // A reported model with no list price (Mythos today) stays itself: `me` is
  // '' and every forecast priced on it reads "unpriced" instead of borrowing
  // the price of whatever model ran before.
  const curModel = v.model ?? ''
  const me = keyOf(curModel) || (curModel ? '' : lt?.k || 'sonnet')
  const curFam = me || (/claude-([a-z]+)/.exec(curModel.toLowerCase())?.[1] ?? curModel.toLowerCase())
  const meName = cap(curFam)

  // --- the meters: hundredths, pace, runway ---
  // The meter moves in whole points.  The hundredths estimate how far toward
  // the next point you are: list units since the last real tick over the size
  // of the last three real ticks (in the same units).
  const ticksOf = (w: Win) => v.samples.filter(x => x.kind === w.kind && x.resetsAt === w.resetsAt).sort((a, b) => a.at - b.at)
  const est = (w: Win) => {
    const L = ticksOf(w)
    const useLu = L.length > 0 && L.every(x => typeof x.lu === 'number') && typeof w.tokens.listUnits === 'number'
    const val = (x: Sample) => (useLu ? (x.lu as number) : (x.fresh ?? 0))
    const cur = useLu ? (w.tokens.listUnits as number) : w.tokens.input + w.tokens.output + w.tokens.cache_write
    const sizes: number[] = []
    for (let i = 1; i < L.length; i++) {
      const a = L[i - 1]!, b = L[i]!
      const dp = b.pct - a.pct
      if (dp > 0 && val(b) > val(a)) sizes.push((val(b) - val(a)) / dp)
    }
    const recent = sizes.slice(-3)
    const per = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : w.pct > 0 ? cur / w.pct : 0
    const lastS = L[L.length - 1]
    if (!per || !lastS) return w.pct
    return w.pct + Math.min(0.99, Math.max(0, (cur - val(lastS)) / per))
  }
  const HORIZON: ByKind = { five_hour: 3600, seven_day: 86400 }
  const pace = (w: Win) => { // % per hour over the last hour (5H) or day (7D) of real ticks
    const nowS = now / 1000
    const L = ticksOf(w)
    if (w.kind === 'seven_day') {
      // 7D: the meter's value 24 hours ago (the last reading at or before
      // then: a reading holds until the next one), over the full 24 hours.
      // Measuring from the first reading of the last 24 hours made a busy
      // morning after time away look like a day's pace packed into a few
      // hours (a false "runs out in 1d 8h").  A window under a day old is
      // measured from its start, at 0%.
      const start = w.resetsAt ? Date.parse(w.resetsAt) / 1000 - SPAN.seven_day : nowS - SPAN.seven_day
      const from = Math.max(start, nowS - HORIZON.seven_day)
      const before = L.filter(x => x.at <= from).pop()
      // No reading from before then (none was taken: no session was open):
      // the first one after stands in, which can only make the pace lower.
      const base = from <= start ? 0 : before ? before.pct : (L.find(x => x.at > from)?.pct ?? 0)
      const hours = (nowS - from) / 3600
      // Under 3 hours into a window, one whole-point step reads as a day's
      // pace (1 point in 26 minutes = 55%/day): no pace yet.  From 3 hours a
      // single step is at most 8%/day, too little to look like running out.
      if (hours < 3) return 0
      return Math.max(0, (est(w) - base) / hours)
    }
    let i = L.findIndex(x => x.at >= nowS - (HORIZON[w.kind] ?? 0))
    if (i < 0) i = L.length - 1
    if (i > 0 && nowS - L[i]!.at < 360) i -= 1 // the anchor must be a few minutes old
    const start = w.resetsAt ? Date.parse(w.resetsAt) / 1000 - (SPAN[w.kind] ?? 0) : nowS - (SPAN[w.kind] ?? 0)
    const anchor = i >= 0 ? L[i] : null
    const hours = (nowS - (anchor ? anchor.at : start)) / 3600
    if (hours < 0.1) return 0
    return Math.max(0, (est(w) - (anchor ? anchor.pct : 0)) / hours)
  }
  const runway = (w: Win): Runway => {
    const r = pace(w)
    const resetMs = w.resetsAt ? Date.parse(w.resetsAt) - now : (SPAN[w.kind] ?? 0) * 1000
    // At 100% the limit is already reached: "runs out in 0m" said it wrong.
    if (est(w) >= 100) return { r, text: 'limit reached', bad: true, leftMs: 0 }
    if (r <= 0) return { r, text: 'no pace yet', bad: false, leftMs: Infinity }
    const leftMs = ((100 - est(w)) / r) * 3600e3
    return leftMs >= resetMs ? { r, text: 'lasts until reset', bad: false, leftMs } : { r, text: `runs out in ${dur(leftMs)}`, bad: true, leftMs }
  }

  // --- cache ---
  // A prompt cache belongs to one model.  After a switch to another model the
  // conversation is not cached for it, however recent the last reply was.
  const idle = last ? now - last : null
  // Compared by family and version ("haiku-5.5"); by family alone when either
  // side names no version.
  const curId = curFam + (verOf(curModel) ? `-${verOf(curModel)}` : '')
  const cacheId = ses?.lastModel ?? curId
  const otherModel = idle !== null && (cacheId.includes('-') && curId.includes('-') ? cacheId !== curId : cacheId.split('-')[0] !== curFam)
  const warm = idle !== null && idle < TTL_MS && !otherModel
  const ctxTok = v.ctx?.tokens ?? lt?.ctx ?? 0
  // When the prompt cache is cold, the conversation is written to cache again instead of read.
  // null = the current model is unpriced.
  // Fast mode multiplies every price on the model it is on.  Staying on this
  // model (reload, hand-off note, the new session's start) costs that much
  // more; scan.py's per-turn figures already carry it.  Another model is
  // priced at standard speed.
  const fastX = ses?.fast && cacheId.split('-')[0] === me ? (ses.fastX ?? 2) : 1
  const wCtx0 = me ? wAt(me, ctxTok) : null
  const wCtx = wCtx0 ? wCtx0.map(x => x * fastX) : null
  const reloadU = wCtx ? ctxTok * (wCtx[2]! - wCtx[3]!) : null

  // --- Cost pill: token overhead, break-even and the cache clock ---
  const base = ses?.base ?? 0
  const ho = v.handoff ?? { extra: 15000, noteOut: 3000 }
  const recent = done.slice(-3)
  const ratio = lt && lt.f > 0 ? lt.u / lt.f : 0
  const rMed = recent.length ? median(recent.map(t => (t.f > 0 ? t.u / t.f : 1))) : 0
  const save = recent.length ? median(recent.map(t => t.u - t.f)) : 0
  // a hand-off costs once: writing the note here, then the new session storing
  // its starting context (system prompt, tools, note, a few files) in its cache
  // (the note is written on the current model: unknown when it is unpriced)
  const noteU = wCtx ? ho.noteOut * wCtx[1]! : null
  const oneTimeU = noteU !== null ? noteU + (base + ho.extra) * wAt(me, base + ho.extra)[2]! * fastX : null
  const payback = oneTimeU !== null && save > 0 ? oneTimeU / save : Infinity
  const histShare = lt && lt.u > 0 ? lt.h / lt.u : 0
  const turnsTxt = (n: number) => (!me ? 'unpriced' : n === Infinity ? 'no savings yet' : n < 1 ? 'pays back in under a turn' : `pays back in ~${Math.round(n)} turn${Math.round(n) === 1 ? '' : 's'}`)
  let cost: Pill
  const costWhy = `turns cost ${rMed.toFixed(1)}x a new session · hand-off ${turnsTxt(payback)}`
  if (!me) cost = { lvl: 0, label: 'Unpriced', why: `${meName} has no list price yet` }
  else if (!lt) cost = { lvl: 0, label: 'Keep going', why: 'no finished turn yet' }
  else if (payback <= 2 && rMed >= 2.5) cost = { lvl: 3, label: 'Hand off', why: costWhy }
  else if (payback <= 5 && rMed >= 1.5) cost = { lvl: 2, label: 'Consider handoff', why: costWhy }
  else if (idle !== null && !warm && rMed >= 1.3) cost = { lvl: 1, label: 'Good moment to switch', why: 'the prompt cache expired, so the next message here rewrites the whole conversation to cache anyway' }
  else cost = { lvl: 0, label: 'Keep going', why: costWhy }

  // --- Context pill (how long the session is getting): context fill, auto-compact, turn count ---
  const win = v.ctx?.window ?? 0
  const pctFull = v.ctx?.percent ?? (win > 0 ? (ctxTok / win) * 100 : 0)
  const compactAt = v.compactAt ?? 0
  const grow = ses?.grow ?? 0
  const turnsLeft = compactAt > 0 && grow > 0 ? Math.max(0, (compactAt - ctxTok) / grow) : null
  // Auto-compacts only: a /compact you ran yourself is a choice, not a warning.
  const comp = ses?.compactions ?? 0
  const sumTxt = comp > 0 ? `auto-compacted ${comp === 1 ? 'once' : `${comp} times`}`
    : turnsLeft !== null ? `auto-compact in ~${Math.max(0, Math.round(turnsLeft))} turns`
    : compactAt > 0 ? `auto-compact at ${fmt(compactAt)}` : ''
  const detailWhy = [`${fmt(ctxTok)}`, win > 0 ? `${Math.round(pctFull)}% used` : '', grow > 0 ? `grows ~${fmt(grow)} a turn` : '', sumTxt].filter(Boolean).join(' · ')
  let detail: Pill
  if (comp > 0 || (turnsLeft !== null && turnsLeft <= 2)) detail = { lvl: 3, label: 'Hand off', why: detailWhy }
  else if (pctFull >= 50 || (turnsLeft !== null && turnsLeft <= 5)) detail = { lvl: 2, label: 'Getting long', why: detailWhy }
  else detail = { lvl: 0, label: 'Fine', why: detailWhy }
  const worst = detail.lvl > cost.lvl ? detail : cost

  // --- switching models: here (reload this conversation on the other model)
  // or a new session with a hand-off note; both one-time costs ---
  // Next turn on your model: the median of your last 3 finished turns, each
  // re-priced on the model you are on NOW (they may have run on another), plus
  // re-caching the conversation once when the cache is cold (expired, or
  // made by another model).
  const fin = done.slice(-3)
  const nextU = !me ? null : fin.length ? median(fin.map(t => t.on?.[me] ?? t.u)) + (idle !== null && !warm ? (reloadU ?? 0) : 0) : 0
  // Per-turn cost on model k: your last 3 turns re-priced on k, either as they
  // ran here (old conversation re-read) or as they would run in a new session
  // after a hand-off (scan.py's `on` and `onf`).
  const perTurn = (k: string, fresh: boolean) =>
    fin.length ? pc(median(fin.map(t => ((fresh ? t.onf : t.on) ?? {})[k] ?? 0))) : 0
  // Two ways to another model, each a one-time cost plus a per-turn cost.
  // switch now: this session changes model, so the whole conversation is
  // cached on the new model once.  hand off: write a note here, start a new
  // session on that model, which caches only its small start.
  // The cheaper path is the one with the lower cost over the next 5 turns.
  const HORIZON_TURNS = 5
  const switchRows = MODELS.filter(k => k !== me).map(k => {
    const nowOnce = pc(ctxTok * wAt(k, ctxTok)[2]!)
    const nowTurn = perTurn(k, false)
    // null when the current model is unpriced (its note-writing cost is unknown)
    const hoOnce = noteU !== null ? pc(noteU + (base + ho.extra) * wAt(k, base + ho.extra)[2]!) : null
    const hoTurn = perTurn(k, true)
    const nowTotal = nowOnce + HORIZON_TURNS * nowTurn
    const hoTotal = hoOnce !== null ? hoOnce + HORIZON_TURNS * hoTurn : null
    // no pick when the two cannot be compared
    const pick = hoTotal === null ? '' : nowTotal < 0.05 && hoTotal < 0.05 ? 'tiny' : hoTotal < nowTotal ? 'handoff' : 'now'
    return { k, nowOnce, nowTurn, hoOnce, hoTurn, pick }
  })

  // --- this session ---
  const sesPct = ses ? pc(ses.since5h.units) : 0
  const allOn = MODELS.map(k => ({ k, pct: ses ? pc(ses.allOn[k] ?? 0) : 0 }))

  return {
    w5, w7, ses, me, meName, ok, pc, rate, turns, lt, est, pace, runway, idle, warm, otherModel, ctxTok, reloadU, base, ho,
    ratio, rMed, payback, histShare, turnsTxt, cost, detail, worst, pctFull, compactAt, grow, turnsLeft,
    switchRows, sesPct, allOn, oneTimeU, nextU, fin,
  }
}

// ---------------------------------------------------------------------------
// The plain-text summary (/manapool): runway and the pills first, so it reads
// well on a phone over Remote Control.
// ---------------------------------------------------------------------------
const summaryText = (v: View, last: number | null, now: number): string => {
  const d = derive(v, last, now)
  const L: string[] = []
  for (const w of [d.w5, d.w7]) {
    if (!w) continue
    const rw = d.runway(w)
    L.push(`${w.kind === 'five_hour' ? '5H' : '7D'}  ${d.est(w).toFixed(1)}%  ${rw.text}${w.resetsAt ? `  (resets ${w.kind === 'five_hour' ? clock(Date.parse(w.resetsAt)) : day(Date.parse(w.resetsAt))})` : ''}`)
  }
  // Points of 5H moved with no work here behind them (scan.py elsewhere_ticks).
  const else5 = v.check?.outside ?? 0
  if (else5 > 0) L.push(`Elsewhere  ${else5}% of 5H  (cloud, claude.ai, phone or another computer)`)
  L.push(`Cost: ${d.cost.label}  (${d.cost.why})`)
  L.push(`Context: ${d.detail.label}  (${d.detail.why})`)
  if (d.lt && d.ok) L.push(`Last turn ${pctTxt(d.pc(d.lt.u))} of 5H · in a new session ~${pctTxt(d.pc(d.lt.f))} (${d.ratio.toFixed(1)}x) · ${Math.round(d.histShare * 100)}% re-reading the conversation`)
  if (d.ses && d.ok) L.push(`This session used ${pctTxt(d.sesPct)} of 5H · ${d.ses.turnCount} turns${d.ses.share1h !== null ? ` · ${Math.round(d.ses.share1h * 100)}% of last hour's use` : ''}`)
  if (d.idle !== null) L.push(`Prompt cache ${d.warm ? `active, expires in ${dur(TTL_MS - d.idle)}` : d.otherModel ? 'cold (model changed)' : 'expired'}`)
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// History pane.  Charts from the daily history (scan.py keeps it in
// history.json), the tick log and the ledger.  Each chart is one SVG string,
// drawn on its own dark card so it reads the same in any app theme.
// Pure: no `$`.
// ---------------------------------------------------------------------------
type HistDay = { m: Record<string, number>; p: Record<string, number>; h: number[]; r: number; n: number; e?: number; s?: number; es?: number }
// One colour per model, fixed: a colour follows its model, never its rank.
// Checked as a set of six on every pair against the card (#262626) with the
// dataviz validator: colour-blind dE >= 10.8, normal vision dE >= 20.
const MODEL_COL: Record<string, string> = {
  opus: '#8d7cd5', sonnet: '#a8ceff', fable: '#eac75e', mythos: '#d17746', haiku: '#16b09b', other: '#5f5f5f',
}
const MODEL_ORDER = ['opus', 'sonnet', 'fable', 'mythos', 'haiku', 'other'] // bottom of a stack first
const GRID = '#3b3940'
const INK = '#edebf4'
const EMPTY = '#1b1928'   // a heatmap cell with no work, one step above the card
// Limit by time: a smaller limit than usual.  With ME (a bigger one) it is the
// diverging pair: OKLab dE 23 to 25 under normal, deutan and protan vision;
// 6.2:1 contrast on the card.
const CORAL = '#f08a5d'
// Bigger and smaller limit in the History pane (0.7.8): Runenir's success green
// and red text colour.  Colour-blind separation dE 9.1 (deutan), above the 8 floor.
const UP = '#35d399', DOWN = '#fe5166'
// The History charts' card: Runenir's ground, darker than the band's grey
// (0.7.8; grey labels APCA Lc 47.5, was 44.6).  The band keeps SURFACE.
const CARD = '#0b0a14'
const TILE = '#15131f'  // a tile inside the tiles card, one step up
const TIP_BG = '#36343b', TIP_LINE = '#4e4c53' // a tooltip box, one step above the card
// Chart width inside its card.  Set by historyView from the pane's width, so
// every chart is drawn at its real size (crisp labels, aligned edges).
let HW = 408
const FONT = `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const pad2 = (n: number) => String(n).padStart(2, '0')
const keyOfDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const dayOfKey = (k: string) => new Date(`${k}T12:00:00`)
const shortDay = (k: string) => dayOfKey(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const hourTxt = (h: number) => (h === 0 ? '12 AM' : h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`)
const quant = (a: number[], q: number) => {
  if (a.length === 0) return 0
  const s = [...a].sort((x, y) => x - y)
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i)
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo)
}
// A round axis top: 1, 2, 2.5 or 5 times a power of ten.
const niceMax = (x: number) => {
  if (!(x > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(x))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p
  return 10 * p
}
// hex -> OKLCH, the inverse of hexOk (same published matrices)
const okOf = (hex: string): Ok => {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r = 0, g = 0, b = 0] = rgb(hex).map(v => lin(v / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363329551 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI]
}
// The band's gradient on any colour: a deeper, slightly hue-turned base
// running to a lighter tip.  Vertical bars grow upward, so their base is the bottom.
const gradDef = (id: string, hex: string, vertical: boolean) => {
  const o = okOf(hex)
  const dir = vertical ? 'x1="0" x2="0" y1="1" y2="0"' : 'x1="0" x2="1" y1="0" y2="0"'
  return `<linearGradient id="${id}" ${dir}><stop offset="0" stop-color="${hexOk(shiftStart(o))}"/><stop offset="1" stop-color="${hexOk(shiftEnd(o))}"/></linearGradient>`
}
// Hover.  The pane draws each chart in a sandboxed frame that runs CSS but no
// scripts (Svg isInteractive), so the crosshair and tooltip are CSS :hover
// alone: each hover group is an invisible hit area plus marks and a tooltip
// that are hidden until the pointer is over that area.  The tooltip ignores
// the pointer, so it never steals the hover from the area under it.  Hover
// groups go after every visible mark, so a tooltip is drawn on top.
// The tooltip's colours and the hover marks' strokes live here once, as
// classes, instead of on every target: a chart with a hover target per cell
// repeats them hundreds of times, and the desktop app stops redrawing the
// History pane once all its charts together pass roughly 250k characters.
// Every class is used only inside a hover group, which is hidden by attribute
// too, so a surface that drops this block shows nothing wrong.
const HOVER_CSS = `<style>.h .hv{opacity:0}.h:hover .hv{opacity:1}.hv{pointer-events:none}.b{fill:${TIP_BG};stroke:${TIP_LINE}}.i{fill:${INK};font-weight:600}.d{fill:${DIM}}.x{stroke:${INK};stroke-opacity:.55;stroke-dasharray:2 2}.o{fill:none;stroke:${INK};stroke-width:1.5}</style>`
// Numbers are cut to one decimal (attribute values only, never text): a
// chart with a hover target per cell runs close to the 131,072-character
// limit an Svg may have, and a tenth of a pixel is finer than any screen.
const trim = (body: string) => body.replace(/="([^"]*)"/g, (_m, v: string) => `="${v.replace(/(\d\.\d)\d+/g, '$1')}"`)
const svgDoc = (h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${HW + 16} ${h + 16}" width="${HW + 16}" height="${h + 16}">${HOVER_CSS}` +
  `<rect width="${HW + 16}" height="${h + 16}" rx="10" fill="${CARD}"/><g transform="translate(8 8)" ${FONT} font-size="10">${trim(body)}</g></svg>`
// Work units as Opus dollars at list price: 1 unit is $2 per million tokens
// (scan.py), and the 5H windows figures are weighed to the Opus ruler.  Not
// what a subscription costs; what the same work would cost through the API.
const usd = (n: number) => `$${(n / 5e5).toFixed(2)}`
const label = (x: number, y: number, s: string, anchor = 'start', col = DIM) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${col}">${esc(s)}</text>`
// A tooltip beside the point (x, y): the first line in ink, the rest dim.  It
// flips to the left near the right edge and stays inside the chart's height h
// (the frame clips anything outside).  Width is estimated from the text, as
// SVG cannot measure it without a script.
// A line may carry a colour key: a small square (or dash, dot, ring) in the
// colour of the mark it names, so the tooltip says which line is which.
type TipKey = { col: string; kind?: 'sq' | 'dash' | 'dot' | 'ring' | 'band' }
type TipLine = string | { s: string; key: TipKey }
const tipText = (l: TipLine) => (typeof l === 'string' ? l : l.s)
const keyMark = (x: number, y: number, k: TipKey) =>
  k.kind === 'dash' ? `<line x1="${x}" x2="${x + 8}" y1="${y}" y2="${y}" stroke="${k.col}" stroke-width="2" stroke-dasharray="3 2"/>`
  : k.kind === 'dot' ? `<circle cx="${x + 4}" cy="${y}" r="3.5" fill="${k.col}"/>`
  : k.kind === 'ring' ? `<circle cx="${x + 4}" cy="${y}" r="3" fill="none" stroke="${k.col}" stroke-width="1.5"/>`
  : `<rect x="${x}" y="${y - 4}" width="8" height="8" rx="2" fill="${k.col}"${k.kind === 'band' ? ' fill-opacity=".45"' : ''}/>`
const tipBox = (x: number, y: number, h: number, lines: TipLine[]) => {
  const keyed = lines.some(l => typeof l !== 'string')
  const w = Math.max(...lines.map(l => tipText(l).length)) * 5.7 + 16 + (keyed ? 14 : 0), th = lines.length * 13 + 7
  let tx = x + 10
  if (tx + w > HW) tx = x - 10 - w
  tx = Math.max(-6, tx)
  const ty = Math.max(-6, Math.min(y, h - th + 6))
  // One text element, a line per tspan; colours come from the classes in HOVER_CSS.
  // A keyed line starts 14 px in, after its colour key.
  const ix = (l: TipLine) => tx + 8 + (typeof l === 'string' ? 0 : 14)
  return `<rect x="${tx}" y="${ty}" width="${w}" height="${th}" rx="5" class="b"/>` +
    lines.map((l, i) => (typeof l === 'string' ? '' : keyMark(tx + 8, ty + 11.5 + i * 13, l.key))).join('') +
    `<text x="${ix(lines[0]!)}" y="${ty + 15}">` +
    lines.map((l, i) => `<tspan${i ? ` x="${ix(l)}" dy="13"` : ''} class="${i ? 'd' : 'i'}">${esc(tipText(l))}</tspan>`).join('') + `</text>`
}
// One hover group: `hit` is the invisible area, `marks` (crosshair, ring,
// outline) and `tip` show while the pointer is over it.  The hidden state is
// also an attribute, so a surface that drops the <style> block (or draws the
// chart as a plain image) shows no stray tooltips; the CSS rule outranks it
// on hover.
const hover = (hit: string, marks: string, tip: string) => `<g class="h">${hit}<g class="hv" opacity="0">${marks}${tip}</g></g>`
const hitRect = (x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${Math.max(1, w)}" height="${Math.max(1, h)}" fill="transparent"/>`
const crossX = (x: number, y0: number, y1: number) =>
  `<line x1="${x}" x2="${x}" y1="${y0}" y2="${y1}" class="x"/>`
const ring = (x: number, y: number, col = INK) =>
  col === INK ? `<circle cx="${x}" cy="${y}" r="5.5" class="o"/>` : `<circle cx="${x}" cy="${y}" r="5.5" fill="none" stroke="${col}" stroke-width="1.5"/>`
// Hover targets for a run of n daily bars, as [first, last] index pairs:
// one per day, or one per week (counted back from today) past 45 days.  At
// 90 days a bar is about 4 px wide, too thin to aim at, and a tooltip per
// day doubles the chart's size (see HOVER_CSS).
const hoverSpans = (n: number) => {
  const size = n > 45 ? 7 : 1, out: [number, number][] = []
  for (let e = n - 1; e >= 0; e -= size) out.unshift([Math.max(0, e - size + 1), e])
  return out
}
// A moment for a tooltip: "Sat, Nov 14, 11:00 AM EST" (the computer's own time zone).
const stamp = (ms: number) =>
  new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const hm = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const longDay = (k: string) => dayOfKey(k).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
// A two-line axis label: the weekday (or hour) on top, its date (or clock
// time) under it.  y is the lower line.  Times are the computer's own zone.
const AXIS2 = 12 // the extra height a chart gives its second axis line
const tick2 = (x: number, y: number, a: string, b: string, anchor = 'middle') => label(x, y - AXIS2, a, anchor) + label(x, y, b, anchor)
const dayTick = (x: number, y: number, ms: number, anchor = 'middle') => {
  const d = new Date(ms)
  return tick2(x, y, d.toLocaleDateString('en-US', { weekday: 'short' }), d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), anchor)
}
const gridLine = (x0: number, y: number, s: string) =>
  `<line x1="${x0}" x2="${HW}" y1="${y}" y2="${y}" stroke="${GRID}"/>${label(x0 - 4, y + 3, s, 'end')}`
// A bar grown up from the baseline: top corners rounded, bottom flat.
const upBar = (x: number, y: number, w: number, h: number, fill: string, op = 1) => {
  const r = Math.min(3, w / 2, h)
  return `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z" fill="${fill}"${op < 1 ? ` fill-opacity="${op}"` : ''}/>`
}
// A bar grown right from the axis: only its data end rounded.
const rightBar = (x: number, y: number, w: number, h: number, fill: string) => {
  const r = Math.min(4, h / 2, w)
  return `<path d="M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z" fill="${fill}"/>`
}

type HistRange = 7 | 30 | 90
type Chart = { svg: string; alt: string; right?: string; rightBad?: boolean; legend?: { name: string; col: string; glyph?: string }[]; note?: string }
type HistView = {
  ok: boolean; full: boolean; unit: string
  tiles: { svg: string; alt: string } | null
  daily: Chart | null; pace: Chart | null; pace7: Chart | null; windows: Chart | null; byTime: Chart | null
  projects: Chart | null; hours: Chart | null; reread: Chart | null
  text: string[]  // the same, as plain lines, for a surface without Svg
}

const historyView = (v: View, ledger: LedgerRow[], range: HistRange, last: number | null, now: number, width = 424): HistView => {
  HW = Math.max(300, Math.min(1100, Math.floor(width))) - 16 // the card adds 8 px each side
  const hist = v.history
  const w7 = v.wins.find(w => w.kind === 'seven_day')
  const w5 = v.wins.find(w => w.kind === 'five_hour')
  // history.json keeps plain list-price units (a fixed yardstick).  The 7D
  // meter weighs models like 5H does (Fable ~2x Opus per list unit), so at
  // list prices a Fable day showed at about half its real share of 7D.  Each
  // day is weighed here at the measured model weights (the same as the band's
  // costs): model bars by their own weight, and the day's project, hour and
  // re-reading figures by the day's mix.  Elsewhere has no model; it takes
  // the current 7D window's mix (f7).
  const MMw = v.fit?.MM ?? {}
  const wOf = (name: string) => MMw[name] ?? 1
  const f7 = w7 && (w7.tokens.listUnits ?? 0) > 0 && w7.tokens.units > 0 ? w7.tokens.units / (w7.tokens.listUnits as number) : 1
  const D: Record<string, HistDay> = {}
  for (const [k, b] of Object.entries(hist?.days ?? {})) {
    const m: Record<string, number> = {}
    let lu = 0, wu = 0
    for (const [n, u] of Object.entries(b.m)) { m[n] = u * wOf(n); lu += u; wu += m[n]! }
    const rr = lu > 0 ? wu / lu : 1
    const p: Record<string, number> = {}
    for (const [n, u] of Object.entries(b.p)) p[n] = u * rr
    D[k] = { ...b, m, p, h: b.h.map(u => u * rr), r: b.r * rr, ...(b.e !== undefined ? { e: b.e * f7 } : {}) }
  }
  const today = new Date(now)
  const keys: string[] = []
  for (let i = range - 1; i >= 0; i--) keys.push(keyOfDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)))
  const dayTotal = (b?: HistDay) => (b ? Object.values(b.m).reduce((a, x) => a + x, 0) : 0)

  // Work units -> % of the 7D limit: the current 7D window's highest reading
  // (its units over its percent, weighed by the window's model mix f7), else
  // the ledger's finished 7D windows.
  const tick7 = v.samples.filter(s => s.kind === 'seven_day' && (s.lu ?? 0) > 0 && s.pct >= 3 && (!w7 || s.resetsAt === w7.resetsAt))
    .sort((a, b) => b.pct - a.pct)[0]
  const led7 = ledger.filter(r => r.kind === 'seven_day' && herePer1(r) > 0 && current(r)).map(herePer1)
  // The reading's units are work here only, but its percent also holds use
  // elsewhere.  Add this 7D window's elsewhere units (by day, from its start
  // day), or the bars here alone would fill the meter and the hatch would
  // stack past it: the same gap shown twice.
  const w7start = w7?.resetsAt ? Date.parse(w7.resetsAt) - 7 * 86400e3 : 0
  const e7 = w7start ? Object.entries(D).filter(([k]) => dayOfKey(k).getTime() >= new Date(w7start).setHours(0, 0, 0, 0)).reduce((a, [, b]) => a + (b.e ?? 0), 0) : 0
  const per7 = tick7 ? ((tick7.lu as number) * f7 + e7) / tick7.pct : led7.length ? median(led7) * f7 : 0
  const unit = per7 > 0 ? '% of 7D' : 'work units'
  const val = (u: number) => (per7 > 0 ? u / per7 : u)
  const valTxt = (u: number) => (per7 > 0 ? pctTxt(val(u)) : fmt(u))
  const tick = (x: number) => (per7 > 0 ? `${+x.toFixed(1)}%` : fmt(x))
  const d = derive(v, last, now)
  const text: string[] = []

  // --- tiles: 7D used (with the band's gradient meter), per day left, re-reading ---
  let tiles: HistView['tiles'] = null
  {
    const tw = (HW - 16) / 3, th = 72
    // One tile: caption, big value, footnote.  `extra` draws between value and footnote.
    const box = (i: number, k: string, val_: string, sub: string, extra = '') => {
      const x = i * (tw + 8)
      return `<rect x="${x}" y="0" width="${tw}" height="${th}" rx="8" fill="${TILE}"/>` +
        label(x + 10, 16, k) + `<text x="${x + 10}" y="37" fill="${INK}" font-size="18" font-weight="600">${esc(val_)}</text>` +
        extra + label(x + 10, 63, sub)
    }
    const pct7 = w7 ? d.est(w7) : 0
    const resetMs = w7?.resetsAt ? Date.parse(w7.resetsAt) - now : 0
    const daysLeft = resetMs / 86400e3
    const tip = tipOk(pct7)
    const mw = tw - 20, mx = 10, mf = Math.max(0, Math.min(1, pct7 / 100)) * mw
    const meter = `<defs><linearGradient id="t7" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${hexOk(shiftStart(tip))}"/><stop offset="1" stop-color="${hexOk(shiftEnd(tip))}"/></linearGradient></defs>` +
      `<rect x="${mx}" y="44" width="${mw}" height="4" rx="2" fill="${mix(CARD, hexOk(tip), 0.24)}"/>` +
      (mf > 0 ? `<rect x="${mx}" y="44" width="${Math.max(4, mf)}" height="4" rx="2" fill="url(#t7)"/>` : '')
    const resetTxt = w7?.resetsAt ? new Date(Date.parse(w7.resetsAt)).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''
    const leftPct = Math.max(0, 100 - pct7)
    const perDay = daysLeft >= 1 ? leftPct / daysLeft : leftPct
    const wk = keys.slice(-7).map(k => D[k]).filter(Boolean) as HistDay[]
    const wkTot = wk.reduce((a, b) => a + dayTotal(b), 0), wkR = wk.reduce((a, b) => a + b.r, 0)
    const rr = wkTot > 0 ? wkR / wkTot : 0
    if (w7) {
      const body = box(0, '7D used', `${Math.round(pct7)}%`, resetTxt ? `Resets ${resetTxt}` : '', meter) +
        box(1, 'Per day left', `~${perDay < 10 ? perDay.toFixed(1) : Math.round(perDay)}%`, daysLeft >= 1 ? `${daysLeft.toFixed(1)} days to reset` : 'until reset') +
        box(2, 'Re-reading', `${Math.round(rr * 100)}%`, 'of work, 7 days')
      tiles = { svg: svgDoc(th, body), alt: `7D used ${Math.round(pct7)}%, about ${perDay.toFixed(1)}% per day left, ${Math.round(rr * 100)}% re-reading` }
      text.push(`7D ${Math.round(pct7)}% · ~${perDay.toFixed(1)}% per day left · re-reading ${Math.round(rr * 100)}%`)
    }
  }

  // --- Daily: stacked bars by model ---
  let daily: Chart | null = null
  const present = MODEL_ORDER.filter(m => keys.some(k => (D[k]?.m[m] ?? 0) > 0))
  {
    // 7D: every day labelled with its weekday and date; 30D and 90D: a date every few days
    const two = keys.length <= 7
    const H = 132 + (two ? AXIS2 : 0), x0 = 34, top = 12, base = H - 16 - (two ? AXIS2 : 0)
    const totals = keys.map(k => dayTotal(D[k]))
    // Elsewhere (scan.py elsewhere_ticks): meter movement with no work on this
    // computer behind it.  Hatched on top of the day's bar, so it reads as not
    // a model, and its legend entry names it (identity never by colour alone).
    const elsew = keys.map(k => D[k]?.e ?? 0)
    const anyElse = elsew.some(e => e > 0)
    const tall = totals.map((t, i) => t + elsew[i]!)
    const max = niceMax(val(Math.max(...tall, 0)) * 1.08)
    const sy = (x: number) => base - (x / max) * (base - top)
    const sx = (HW - x0) / keys.length, gap = sx > 6 ? 2 : 1, bw = Math.max(1, sx - gap)
    let out = `<defs>${present.map(m => gradDef(`d${m}`, MODEL_COL[m]!, true)).join('')}` +
      `<pattern id="dElse" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<rect width="4" height="4" fill="${CARD}"/><line x1="0" y1="0" x2="0" y2="4" stroke="${DIM}" stroke-width="1.5"/></pattern></defs>`
    out += [0, max / 2, max].map(t => gridLine(x0, sy(t), tick(t))).join('')
    let peak = -1, hv = ''
    tall.forEach((t, i) => { if (t > 0 && (peak < 0 || t > tall[peak]!)) peak = i })
    keys.forEach((k, i) => {
      const b = D[k]
      const x = x0 + i * sx + gap / 2
      const parts = present.map(m => [m, b?.m[m] ?? 0] as const).filter(p => p[1] > 0)
      let y = base, segs = ''
      const e = elsew[i]!
      parts.forEach(([m, u], j) => {
        const h = (val(u) / max) * (base - top)
        y -= h
        const isTop = j === parts.length - 1 && !(e > 0)
        // a 1px surface gap between stacked segments
        segs += isTop ? upBar(x, y, bw, Math.max(0.5, h - (j > 0 ? 1 : 0)), `url(#d${m})`)
          : `<rect x="${x}" y="${y + 1}" width="${bw}" height="${Math.max(0.5, h - 1)}" fill="url(#d${m})"/>`
      })
      if (e > 0) {
        // at least 2.5 px tall, so a small amount still shows its hatching
        const h = Math.max(2.5, (val(e) / max) * (base - top))
        y -= h
        segs += upBar(x, y, bw, Math.max(0.5, h - (parts.length ? 1 : 0)), 'url(#dElse)')
      }
      out += segs
    })
    // hover: the whole column (or week, see hoverSpans), so a thin or empty
    // day is easy to point at
    for (const [a, z] of hoverSpans(keys.length)) {
      const cx = x0 + ((a + z + 1) / 2) * sx
      const name = a === z ? longDay(keys[a]!) : `${shortDay(keys[a]!)} to ${shortDay(keys[z]!)}`
      const sum = totals.slice(a, z + 1).reduce((p, q) => p + q, 0)
      const parts = present.map(m => [m, keys.slice(a, z + 1).reduce((p, k) => p + (D[k]?.m[m] ?? 0), 0)] as const).filter(q => q[1] > 0)
      const calls = keys.slice(a, z + 1).reduce((p, k) => p + (D[k]?.n ?? 0), 0)
      const es = elsew.slice(a, z + 1).reduce((p, q) => p + q, 0)
      // Elsewhere only shows between two meter readings, so a day with none
      // (no session open here, or before Mana Pool kept readings) is "not
      // measured", never a quiet zero.  A day that caught use from while no
      // session was open says since when (scan.py "es").
      const unmeasured = keys.slice(a, z + 1).filter(k => !((D[k]?.s ?? 0) > 0)).length
      const since = a === z && D[keys[a]!]?.es ? ` since ${new Date(D[keys[a]!]!.es! * 1000).toLocaleDateString('en-US', { weekday: 'short' })}` : ''
      const elseLine = [...(es > 0 ? [`Elsewhere ${valTxt(es)}${since}`] : []),
        ...(unmeasured === z - a + 1 ? ['Elsewhere not measured'] : unmeasured > 0 ? [`Elsewhere not measured on ${unmeasured} ${unmeasured === 1 ? 'day' : 'days'}`] : [])]
      hv += hover(hitRect(x0 + a * sx, top, (z - a + 1) * sx, base - top), a === z ? crossX(cx, top, base) : `<rect x="${x0 + a * sx}" y="${top}" width="${(z - a + 1) * sx}" height="${base - top}" fill="${INK}" fill-opacity=".07"/>`,
        tipBox(cx, top, H, sum + es > 0 ? [name, `${valTxt(sum + es)}${per7 > 0 && sum > 0 ? ` · ${fmt(sum)} units here` : ''}`,
          ...[...parts].reverse().map(([m, u]) => `${cap(m)} ${valTxt(u)}`), ...elseLine, `${calls} calls`] : [name, 'No work here', ...elseLine]))
    }
    if (peak >= 0) out += label(x0 + peak * sx + sx / 2, sy(val(tall[peak]!)) - 4, valTxt(tall[peak]!).replace('~', ''), 'middle', INK)
    const every = two ? 1 : Math.ceil(keys.length / 5)
    keys.forEach((k, i) => {
      if ((keys.length - 1 - i) % every) return
      const x = x0 + i * sx + sx / 2
      out += two ? dayTick(x, H - 2, dayOfKey(k).getTime()) : label(x, H - 2, shortDay(k), 'middle')
    })
    out += hv
    const sum = totals.reduce((a, b) => a + b, 0)
    const esum = elsew.reduce((a, b) => a + b, 0)
    daily = {
      svg: svgDoc(H, out), alt: `Daily work over ${range} days, ${valTxt(sum)} in all${esum > 0 ? `, plus ${valTxt(esum)} elsewhere` : ''}`,
      right: unit === '% of 7D' ? '% of 7D per day' : 'work units per day',
      legend: [...present.map(m => ({ name: cap(m), col: MODEL_COL[m]! })), ...(anyElse ? [{ name: 'Elsewhere', col: DIM, glyph: '▨' }] : [])],
    }
    text.push(`Daily (${range}D): ${keys.slice(-7).map(k => `${shortDay(k)} ${valTxt(dayTotal(D[k]))}`).join(' · ')}`)
    const e7 = elsew.slice(-7).reduce((a, b) => a + b, 0)
    if (e7 > 0) text.push(`Elsewhere (7 days): ${valTxt(e7)}`)
  }

  // --- Model colours for the pace lines (0.7.11) ---
  // Each reading of the current window carries every model's tokens since the
  // window started (scan.py sample_of).  The change from the reading before is
  // the work behind that tick; weighed at the weights in use, its biggest
  // share names the tick.  A tick with no work here (use elsewhere, or 7D's
  // rounding overnight) is 'else'.  The line keeps the meter's own heights:
  // the models only choose the colour.
  const WT = v.weights ?? LISTW
  const unitsOf = (ms: Record<string, number[]>) => {
    const o: Record<string, number> = {}
    for (const [id, t] of Object.entries(ms)) {
      const k = keyOf(id) || 'other', w = WT[k] ?? LISTW[k] ?? LISTW.sonnet!
      o[k] = (o[k] ?? 0) + t.reduce((a, x, i) => a + (x || 0) * w[i]!, 0)
    }
    return o
  }
  const leadOf = (a: Record<string, number>, b: Record<string, number>) => {
    let best = 'else', most = 0
    for (const [k, u] of Object.entries(b)) { const dd = u - (a[k] ?? 0); if (dd > most) { most = dd; best = k } }
    return best
  }
  const colOf = (k: string) => (k === 'else' ? DIM : MODEL_COL[k] ?? MODEL_COL.other!)
  const nameOf = (k: string) => (k === 'else' ? 'Elsewhere' : cap(k))
  // The model behind each point of a step line: pts[0] is the window's start,
  // the last point the live estimate (its work: the window's live totals).
  // null when a reading has no per-model figures (readings from before 0.7.1):
  // the chart then keeps its single colour.
  const modelsOf = (ss: Sample[], live: Record<string, { input: number; output: number; cache_write: number; cache_read: number }> | undefined) => {
    if (!ss.length || ss.some(s => !s.models) || !live) return null
    let prev: Record<string, number> = {}
    const ks = ss.map(s => { const u = unitsOf(s.models!); const k = leadOf(prev, u); prev = u; return k })
    const now = unitsOf(Object.fromEntries(Object.entries(live).map(([id, t]) => [id, [t.input, t.output, t.cache_write, t.cache_read]])))
    const kNow = leadOf(prev, now)
    // the live point only moves past the last reading when there was work since
    return [ks[0]!, ...ks, kNow === 'else' ? ks[ks.length - 1]! : kNow]
  }
  // A step line in model colours, with the area under each flat stretch
  // filled in the colour of the rise before it, down to 0%: bands of time.
  // A stretch is the model that last moved the meter (an idle night stays the
  // evening's model, never the next morning's).  Runs of one colour are one
  // line path and one fill path, so the chart stays inside the pane's size
  // limits however many readings there are.
  const modelSteps = (pts: [number, number][], ks: string[], sx: (n: number) => number, sy: (p: number) => number, base: number) => {
    type Piece = { k: string; d: string }
    const lines: Piece[] = [], fills: { k: string; xs: [number, number, number][] }[] = []
    const addLine = (k: string, x1: number, y1: number, x2: number, y2: number) => {
      const l = lines[lines.length - 1]
      if (l && l.k === k) l.d += ` L${x2},${y2}`
      else lines.push({ k, d: `M${x1},${y1} L${x2},${y2}` })
    }
    for (let i = 1; i < pts.length; i++) {
      const [xa, pa] = pts[i - 1]!, [xb, pb] = pts[i]!, kFlat = ks[i - 1]!, kRise = ks[i]!
      addLine(kFlat, sx(xa), sy(pa), sx(xb), sy(pa))
      if (pb !== pa) addLine(kRise, sx(xb), sy(pa), sx(xb), sy(pb))
      const f = fills[fills.length - 1]
      if (f && f.k === kFlat) f.xs.push([sx(xa), sx(xb), sy(pa)])
      else fills.push({ k: kFlat, xs: [[sx(xa), sx(xb), sy(pa)]] })
    }
    const area = fills.map(f => `<path d="M${f.xs[0]![0]},${base} ${f.xs.map(([a, b, y]) => `L${a},${y} L${b},${y}`).join(' ')} L${f.xs[f.xs.length - 1]![1]},${base} Z" fill="${colOf(f.k)}" fill-opacity="0.3"/>`).join('')
    return area + lines.map(l => `<path d="${l.d}" fill="none" stroke="${colOf(l.k)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('')
  }
  // The models a line used, in Daily's stacking order, for its legend
  const usedOf = (ks: string[]) => [...MODEL_ORDER, 'else'].filter(k => ks.includes(k))
  // The projection and the "now" dot take the last model that did work here
  // (0.7.12): the pace ahead is that model's.  Elsewhere is skipped; a window
  // with no work here at all stays grey.
  const lastModel = (ks: string[]) => [...ks].reverse().find(k => k !== 'else') ?? 'else'

  // --- 5H pace: this window against the usual range of past windows ---
  // "Usual" follows the range buttons: the past windows that started in the
  // last 7, 30 or 90 days (5H readings are kept 120 days).
  let pace: Chart | null = null
  if (w5?.resetsAt) {
    const H = 124 + AXIS2, x0 = 34, top = 8, base = H - 16 - AXIS2
    const sx = (m: number) => x0 + (m / 300) * (HW - x0 - 4), sy = (p: number) => base - (Math.min(100, p) / 100) * (base - top)
    const byWin = new Map<string, Sample[]>()
    for (const s of v.samples) if (s.kind === 'five_hour' && s.resetsAt) byWin.set(s.resetsAt, [...(byWin.get(s.resetsAt) ?? []), s])
    const startOf = (ra: string) => Date.parse(ra) / 1000 - SPAN.five_hour
    const at = (ss: Sample[], st: number, m: number) => ss.reduce((p, s) => (s.at <= st + m * 60 ? Math.max(p, s.pct) : p), 0)
    const past = [...byWin.entries()].filter(([ra, ss]) => ra !== w5.resetsAt && Date.parse(ra) <= now && ss.length >= 2 && Math.max(...ss.map(s => s.pct)) >= 2
        && startOf(ra) * 1000 >= now - range * 86400e3)
      .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))
    const grid = Array.from({ length: 31 }, (_, i) => i * 10)
    let out = [0, 50, 100].map(t => gridLine(x0, sy(t), `${t}%`)).join('')
    const nowMin = Math.max(0, Math.min(300, (now / 1000 - startOf(w5.resetsAt)) / 60))
    const pctNow = d.est(w5)
    let p25: number[] = [], p50: number[] = [], p75: number[] = []
    if (past.length >= 3) {
      const cols = grid.map(m => past.map(([ra, ss]) => at(ss, startOf(ra), m)))
      p25 = cols.map(c => quant(c, 0.25)); p50 = cols.map(c => quant(c, 0.5)); p75 = cols.map(c => quant(c, 0.75))
      out += `<path d="M${grid.map((m, i) => `${sx(m)},${sy(p75[i]!)}`).join(' L')} L${[...grid].reverse().map((m, i) => `${sx(m)},${sy(p25[grid.length - 1 - i]!)}`).join(' L')} Z" fill="${HIST}" opacity="0.35"/>`
      out += `<path d="M${grid.map((m, i) => `${sx(m)},${sy(p50[i]!)}`).join(' L')}" fill="none" stroke="${HIST}" stroke-width="2"/>`
    }
    // even pace: 100% at reset, the same reference line 7D pace has.  No
    // tooltip line for it (31 of them cost ~5k of the pane's size budget).
    out += `<line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(300)}" y2="${sy(100)}" stroke="${DIM}" stroke-dasharray="4 4"/>`
    const curS = (byWin.get(w5.resetsAt) ?? []).filter(s => { const m = (s.at - startOf(w5.resetsAt!)) / 60; return m >= 0 && m <= nowMin }).sort((a, b) => a.at - b.at)
    const cur = curS.map(s => [(s.at - startOf(w5.resetsAt!)) / 60, s.pct] as [number, number])
    const pts: [number, number][] = [[0, 0], ...cur, [nowMin, pctNow]]
    // each reading holds until the next one: a step line, in model colours
    // when the readings say which model moved the meter (else one violet line)
    const ks5 = modelsOf(curS, w5.tokens.models)
    if (ks5) out += modelSteps(pts, ks5, sx, sy, base)
    else {
      let path = `M${sx(0)},${sy(0)}`
      for (let i = 1; i < pts.length; i++) path += ` L${sx(pts[i]![0])},${sy(pts[i - 1]![1])} L${sx(pts[i]![0])},${sy(pts[i]![1])}`
      out += `<defs>${gradDef('pl', ME, false)}</defs><path d="${path}" fill="none" stroke="url(#pl)" stroke-width="2" stroke-linejoin="round"/>`
    }
    // the model behind the line at minute m: the last point at or before it
    const kAt5 = (m: number) => { if (!ks5) return ''; let k = ks5[0]!; pts.forEach((p, i) => { if (p[0] <= m) k = ks5[i]! }); return k }
    const pc5 = ks5 ? colOf(lastModel(ks5)) : ME
    const rw = d.runway(w5)
    if (rw.r > 0 && nowMin < 300) {
      const endM = rw.bad ? Math.min(300, nowMin + rw.leftMs / 60000) : 300
      const endP = Math.min(100, pctNow + (rw.r * (endM - nowMin)) / 60)
      out += `<path d="M${sx(nowMin)},${sy(pctNow)} L${sx(endM)},${sy(endP)}" fill="none" stroke="${pc5}" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>`
      if (rw.bad) out += `<line x1="${sx(endM)}" x2="${sx(endM)}" y1="${sy(100)}" y2="${base}" stroke="${RED}" stroke-dasharray="2 3"/>`
    }
    out += `<circle cx="${sx(nowMin)}" cy="${sy(pctNow)}" r="4" fill="${pc5}" stroke="${CARD}" stroke-width="2"><title>${esc(`Now · ${pctTxt(pctNow)}`)}</title></circle>`
    out += label(sx(nowMin) + (nowMin > 200 ? -8 : 8), sy(pctNow) - 8, `${Math.round(pctNow)}% now`, nowMin > 200 ? 'end' : 'start', INK)
    // hours into the window, and the clock time each one falls on
    {
      const st5 = startOf(w5.resetsAt)
      for (let h = 0; h <= 5; h++) out += tick2(sx(h * 60), H - 2, `${h}h`, new Date((st5 + h * 3600) * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), h === 5 ? 'end' : 'middle')
    }
    // hover: one column per 10 minutes
    {
      const ss = byWin.get(w5.resetsAt) ?? [], st = startOf(w5.resetsAt), cw = sx(10) - sx(0)
      grid.forEach((m, i) => {
        const x = sx(m), lines: TipLine[] = [`${Math.floor(m / 60)}h ${pad2(m % 60)}m · ${hm((st + m * 60) * 1000)}`]
        let mk = crossX(x, top, base)
        if (m <= nowMin) {
          const p = m >= nowMin - 5 ? pctNow : at(ss, st, m)
          const k = kAt5(m)
          lines.push({ s: `This window ${Math.round(p)}%${k ? ` · ${nameOf(k)}` : ''}`, key: { col: k ? colOf(k) : ME } })
          mk += ring(x, sy(p), ME)
        } else if (rw.r > 0) lines.push({ s: `Projected ${Math.round(Math.min(100, pctNow + (rw.r * (m - nowMin)) / 60))}%`, key: { col: pc5, kind: 'dash' } })
        if (p50.length) lines.push({ s: `Usual ${Math.round(p50[i]!)}%`, key: { col: HIST } }, { s: `Usual range ${Math.round(p25[i]!)} to ${Math.round(p75[i]!)}%`, key: { col: HIST, kind: 'band' } })
        out += hover(hitRect(x - cw / 2, top, cw, base - top), mk, tipBox(x, top, H, lines))
      })
    }
    const usual = past.length >= 3 ? quant(past.map(([ra, ss]) => at(ss, startOf(ra), nowMin)), 0.5) : null
    pace = {
      svg: svgDoc(H, out), alt: `5H window at ${Math.round(pctNow)}%${usual !== null ? `, usual ${Math.round(usual)}% by now` : ''}`,
      right: rw.bad ? (rw.leftMs <= 0 ? 'Limit reached' : `Runs out in ${dur(rw.leftMs)}`) : usual !== null ? `Usual ${Math.round(usual)}% by now` : `${past.length} past windows`,
      rightBad: rw.bad,
      legend: [...(ks5 ? usedOf(ks5).map(k => ({ name: nameOf(k), col: colOf(k) })) : [{ name: 'This window', col: ME }]), ...(past.length >= 3 ? [{ name: 'Usual', col: HIST }, { name: `Usual range: middle half of ${past.length} windows, ${range}D`, col: mix(CARD, HIST, 0.45) }] : []),
        { name: 'Dashed: even pace', col: DIM }],
    }
    text.push(`5H ${Math.round(pctNow)}% · ${pace.right}`)
  }

  // --- 7D pace: this week against even pace and past weeks ---
  // Drawn like 5H pace.  With 3+ past weeks it shows their middle half as a
  // band; until then last week as a grey line.  The even-pace line (100% at
  // reset) is always there: it is what "Per day left" in the tiles spreads out.
  let pace7: Chart | null = null
  if (w7?.resetsAt) {
    const H = 124 + AXIS2, x0 = 34, top = 8, base = H - 16 - AXIS2, DAY = 86400
    // 7D is blue everywhere (5H violet), here and behind the 5H windows
    const C7 = COLD
    const sx = (dd: number) => x0 + (dd / 7) * (HW - x0 - 4), sy = (p: number) => base - (Math.min(100, p) / 100) * (base - top)
    const byWin = new Map<string, Sample[]>()
    for (const s of v.samples) if (s.kind === 'seven_day' && s.resetsAt) byWin.set(s.resetsAt, [...(byWin.get(s.resetsAt) ?? []), s])
    const startOf = (ra: string) => Date.parse(ra) / 1000 - SPAN.seven_day
    const at = (ss: Sample[], st: number, dd: number) => ss.reduce((p, s) => (s.at <= st + dd * DAY ? Math.max(p, s.pct) : p), 0)
    // a past week counts only if its readings start within its first 12 hours:
    // one picked up mid-week would read 0% for the days before
    const past = [...byWin.entries()].filter(([ra, ss]) => ra !== w7.resetsAt && Date.parse(ra) <= now && ss.length >= 2)
      .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0])).slice(-12)
    const full = past.filter(([ra, ss]) => Math.min(...ss.map(s => s.at)) - startOf(ra) <= DAY / 2)
    const grid = Array.from({ length: 29 }, (_, i) => i / 4) // every 6 hours
    let out = [0, 50, 100].map(t => gridLine(x0, sy(t), `${t}%`)).join('')
    const st = startOf(w7.resetsAt)
    const nowD = Math.max(0, Math.min(7, (now / 1000 - st) / DAY))
    const pctNow = d.est(w7)
    let p25: number[] = [], p50: number[] = [], p75: number[] = []
    if (full.length >= 3) {
      const cols = grid.map(dd => full.map(([ra, ss]) => at(ss, startOf(ra), dd)))
      p25 = cols.map(c => quant(c, 0.25)); p50 = cols.map(c => quant(c, 0.5)); p75 = cols.map(c => quant(c, 0.75))
      out += `<path d="M${grid.map((dd, i) => `${sx(dd)},${sy(p75[i]!)}`).join(' L')} L${[...grid].reverse().map((dd, i) => `${sx(dd)},${sy(p25[grid.length - 1 - i]!)}`).join(' L')} Z" fill="${HIST}" opacity="0.35"/>`
      out += `<path d="M${grid.map((dd, i) => `${sx(dd)},${sy(p50[i]!)}`).join(' L')}" fill="none" stroke="${HIST}" stroke-width="2"/>`
    }
    out += `<line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(7)}" y2="${sy(100)}" stroke="${DIM}" stroke-dasharray="4 4"/>`
    // each reading holds until the next one: a step line
    const steps = (pts: [number, number][]) => {
      let path = `M${sx(pts[0]![0])},${sy(pts[0]![1])}`
      for (let i = 1; i < pts.length; i++) path += ` L${sx(pts[i]![0])},${sy(pts[i - 1]![1])} L${sx(pts[i]![0])},${sy(pts[i]![1])}`
      return path
    }
    const lastWk = past[past.length - 1]
    const lastPts = lastWk ? lastWk[1].map(s => [(s.at - startOf(lastWk[0])) / DAY, s.pct] as [number, number]).filter(([dd]) => dd >= 0 && dd <= 7).sort((a, b) => a[0] - b[0]) : []
    const showLast = !p50.length && lastPts.length >= 2
    if (showLast) out += `<path d="${steps([...lastPts, [7, lastPts[lastPts.length - 1]![1]]])}" fill="none" stroke="${HIST}" stroke-width="2" stroke-linejoin="round"/>`
    const ss7 = byWin.get(w7.resetsAt) ?? []
    const curS7 = ss7.filter(s => { const dd = (s.at - st) / DAY; return dd >= 0 && dd <= nowD }).sort((a, b) => a.at - b.at)
    const cur = curS7.map(s => [(s.at - st) / DAY, s.pct] as [number, number])
    const pts7: [number, number][] = [[0, 0], ...cur, [nowD, pctNow]]
    // in model colours like 5H pace; the projection and dot stay blue
    const ks7 = modelsOf(curS7, w7.tokens.models)
    out += ks7 ? modelSteps(pts7, ks7, sx, sy, base)
      : `<defs>${gradDef('p7', C7, false)}</defs><path d="${steps(pts7)}" fill="none" stroke="url(#p7)" stroke-width="2" stroke-linejoin="round"/>`
    const kAt7 = (dd: number) => { if (!ks7) return ''; let k = ks7[0]!; pts7.forEach((p, i) => { if (p[0] <= dd) k = ks7[i]! }); return k }
    const pc7 = ks7 ? colOf(lastModel(ks7)) : C7
    const rw = d.runway(w7)
    if (rw.r > 0 && nowD < 7) {
      const endD = rw.bad ? Math.min(7, nowD + rw.leftMs / 1000 / DAY) : 7
      const endP = Math.min(100, pctNow + rw.r * (endD - nowD) * 24)
      out += `<path d="M${sx(nowD)},${sy(pctNow)} L${sx(endD)},${sy(endP)}" fill="none" stroke="${pc7}" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>`
      if (rw.bad) out += `<line x1="${sx(endD)}" x2="${sx(endD)}" y1="${sy(100)}" y2="${base}" stroke="${RED}" stroke-dasharray="2 3"/>`
    }
    out += `<circle cx="${sx(nowD)}" cy="${sy(pctNow)}" r="4" fill="${pc7}" stroke="${CARD}" stroke-width="2"/>`
    out += label(sx(nowD) + (nowD > 4.7 ? -8 : 8), sy(pctNow) - 8, `${Math.round(pctNow)}% now`, nowD > 4.7 ? 'end' : 'start', INK)
    for (let i = 0; i <= 7; i++) out += dayTick(sx(i), H - 2, (st + i * DAY) * 1000, i === 7 ? 'end' : 'middle')
    // hover: one column per 6 hours
    const cw = sx(0.25) - sx(0)
    grid.forEach((dd, i) => {
      const x = sx(dd), lines: TipLine[] = [stamp((st + dd * DAY) * 1000)]
      let mk = crossX(x, top, base)
      if (dd <= nowD) {
        const p = dd >= nowD - 0.1 ? pctNow : at(ss7, st, dd)
        const k = kAt7(dd)
        lines.push({ s: `This week ${Math.round(p)}%${k ? ` · ${nameOf(k)}` : ''}`, key: { col: k ? colOf(k) : C7 } })
        mk += ring(x, sy(p), C7)
      } else if (rw.r > 0) lines.push({ s: `Projected ${Math.round(Math.min(100, pctNow + rw.r * (dd - nowD) * 24))}%`, key: { col: pc7, kind: 'dash' } })
      lines.push({ s: `Even pace ${Math.round((dd / 7) * 100)}%`, key: { col: DIM, kind: 'dash' } })
      if (p50.length) lines.push({ s: `Usual ${Math.round(p50[i]!)}%`, key: { col: HIST } }, { s: `Usual range ${Math.round(p25[i]!)} to ${Math.round(p75[i]!)}%`, key: { col: HIST, kind: 'band' } })
      else if (showLast) {
        const lp = lastPts.filter(q => q[0] <= dd)
        lines.push({ s: lp.length ? `Last week ${Math.round(lp[lp.length - 1]![1])}%` : 'Last week: no reading yet', key: { col: HIST } })
      }
      out += hover(hitRect(x - cw / 2, top, cw, base - top), mk, tipBox(x, top, H, lines))
    })
    const even = (nowD / 7) * 100
    const usual = p50.length ? quant(full.map(([ra, ss]) => at(ss, startOf(ra), nowD)), 0.5) : null
    pace7 = {
      svg: svgDoc(H, out), alt: `7D window at ${Math.round(pctNow)}%, even pace ${Math.round(even)}% by now${usual !== null ? `, usual ${Math.round(usual)}%` : ''}`,
      right: rw.bad ? (rw.leftMs <= 0 ? 'Limit reached' : `Runs out in ${dur(rw.leftMs)}`) : usual !== null ? `Usual ${Math.round(usual)}% by now` : `Even pace ${Math.round(even)}% by now`,
      rightBad: rw.bad,
      legend: [...(ks7 ? usedOf(ks7).map(k => ({ name: nameOf(k), col: colOf(k) })) : [{ name: 'This week', col: C7 }]),
        ...(p50.length ? [{ name: 'Usual', col: HIST }, { name: `Usual range: middle half of ${full.length} weeks`, col: mix(CARD, HIST, 0.45) }] : showLast ? [{ name: 'Last week', col: HIST }] : []),
        { name: 'Dashed: even pace', col: DIM }],
    }
    text.push(`7D ${Math.round(pctNow)}% · ${pace7.right}`)
  }

  // --- 5H windows: each window's climb, and how much work 1% bought in it ---
  // Replaces Limit size (0.7.8).  Two lanes on one real timeline:
  //   top:    how far each 5H window climbed (7D: its readings as steps;
  //           30D and 90D: each day's highest climb as a bar)
  //   bottom: work per 1% in each window at the measured model weights
  //           (scan.py _limitSize), against the usual figure (the median of
  //           every solid window).  A waveform joins the dots, filled to the
  //           usual line: green above (a bigger limit), red below (a smaller one).
  // Hollow dots used under 15% here: a rough figure, so the line through them
  // is dashed and the fill skips them.  Windows under 8 points have no figure.
  let windows: Chart | null = null
  {
    const SAT = 0.1                          // full colour 10% from usual
    const adj = v.limitSize
    const DAY = 86400
    // Every 5H window known: its readings (kept 120 days) and its ledger row.
    type W5 = { ra: string; st: number; end: number; pts: [number, number][]; peak: number; per1: number; sure: boolean; models: string[]; outside: number }
    const rows5 = new Map<string, LedgerRow>()
    for (const r of ledger) if (r.kind === 'five_hour' && current(r)) rows5.set(r.resetsAt, r)
    const reads = new Map<string, Sample[]>()
    for (const s of v.samples) if (s.kind === 'five_hour' && s.resetsAt) reads.set(s.resetsAt, [...(reads.get(s.resetsAt) ?? []), s])
    const all: W5[] = []
    for (const ra of new Set([...rows5.keys(), ...reads.keys()])) {
      const end = Date.parse(ra) / 1000, st = end - SPAN.five_hour, r = rows5.get(ra)
      // the climb, thinned to one point per 5 minutes (the last, so the highest):
      // every reading as a step would make the 7D drawing too big for the pane
      const thin = new Map<number, [number, number]>()
      for (const x of (reads.get(ra) ?? []).sort((a, b) => a.at - b.at)) thin.set(Math.floor((x.at - st) / 300), [x.at, x.pct])
      const pts = [...thin.values()]
      const peak = Math.max(r?.pct ?? 0, ...pts.map(q => q[1]))
      if (peak <= 0) continue
      const per1 = r ? (adj ? (adj[ra] ?? 0) : herePer1(r)) : 0
      all.push({ ra, st, end, pts, peak, per1, sure: !!r && herePts(r) >= 15, models: r?.models ?? [], outside: r?.outside ?? 0 })
    }
    all.sort((a, b) => a.st - b.st)
    if (all.length) {
      // Room on the right for the $ scale: the chart draws 34 px narrower and
      // HW is put back before the card is written (svgDoc uses the full width).
      const HW_FULL = HW
      HW -= 34
      const nowS = now / 1000
      const t1 = nowS, t0 = range === 7 ? nowS - 7 * DAY : dayOfKey(keys[0]!).setHours(0, 0, 0, 0) / 1000
      const inR = all.filter(w => w.end > t0 && w.st < t1)
      const solid = all.filter(w => w.sure && w.per1 > 0)
      const med = solid.length ? median(solid.map(w => w.per1)) : 0
      const first = all[0]!.st
      // Scale: from the lowest to the highest solid dot on show, never narrower
      // than usual ±15% (so a calm week's small wobble isn't blown up).  A
      // hollow dot outside it sits on the edge; its tooltip has the number.
      const shown = inR.filter(w => w.sure && w.per1 > 0).map(w => w.per1)
      const lo = med ? Math.min(med * 0.85, ...shown) : 0, hi = med ? Math.max(med * 1.15, ...shown) : 1
      const two = range === 7 // weekday and date under every day
      const x0 = 38, top = 8, laneH = 120, gap = 26, dotTop = top + laneH + gap, dotH = 112, base = dotTop + dotH, H = base + 18 + (two ? AXIS2 : 0), pad = 5
      const sx = (t: number) => x0 + ((t - t0) / (t1 - t0)) * (HW - x0)
      const syP = (p: number) => top + laneH - (Math.min(100, p) / 100) * laneH
      const syV = (x: number) => base - pad - ((Math.min(hi, Math.max(lo, x)) - lo) / (hi - lo || 1)) * (dotH - 2 * pad)
      const colOf = (x: number) => (med ? mix(DIM, x >= med ? UP : DOWN, Math.min(1, Math.abs(x - med) / med / SAT)) : DIM)
      const vsTxt = (x: number) => { const p = Math.round((x / med - 1) * 100); return `${p >= 0 ? '+' : '−'}${Math.abs(p)}% vs usual` }
      // A climb's strength: as today up to 50%, then stronger until solid at
      // 100%, so a window near the limit stands out without a second colour
      // (red is kept for "smaller limit").  One decimal, as trim() keeps.
      const climbOp = (pk: number) => (0.5 + 0.5 * Math.min(1, Math.max(0, (pk - 50) / 50))).toFixed(1)
      // Gradient stops as percentages and one-decimal opacities: trim() cuts
      // every number in an attribute to one decimal, so 0.064 would become 0.0.
      const off = (y: number) => `${(Math.min(1, Math.max(0, (y - dotTop) / dotH)) * 100).toFixed(1)}%`
      const wave = (id: string, a: number) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${dotTop}" y2="${base}">` +
        `<stop offset="${off(syV(med * (1 + SAT)))}" stop-color="${UP}" stop-opacity="${a}"/><stop offset="${off(syV(med))}" stop-color="${UP}" stop-opacity="0.1"/>` +
        `<stop offset="${off(syV(med))}" stop-color="${DOWN}" stop-opacity="0.1"/><stop offset="${off(syV(med * (1 - SAT)))}" stop-color="${DOWN}" stop-opacity="${a}"/></linearGradient>`
      let out = `<defs><pattern id="wIdle" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="${GRID}" stroke-width="1.5"/></pattern>` +
        `<pattern id="wNone" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="${HIST}" stroke-width="1" stroke-opacity="0.6"/></pattern>` +
        `<linearGradient id="wClimb" x1="0" x2="0" y1="1" y2="0"><stop offset="0" stop-color="${ME}" stop-opacity="0.2"/><stop offset="1" stop-color="${ME}" stop-opacity="1"/></linearGradient>` +
        (med ? wave('wFill', 0.8) + wave('wLine', 1) : '') + `</defs>`
      // lanes: grid and labels
      out += [0, 50, 100].map(t => gridLine(x0, syP(t), `${t}%`)).join('')
      if (med) {
        // normal scatter: ±10% around usual, shaded
        const yA = syV(med * 1.1), yB = syV(med * 0.9)
        out += `<rect x="${x0}" y="${yA}" width="${HW - x0}" height="${yB - yA}" fill="${HIST}" fill-opacity="0.2"/>`
        // units on the left; on the right the same figure in Opus dollars
        out += [lo, med, hi].map(t => (t === med || Math.abs(syV(t) - syV(med)) >= 11 ? gridLine(x0, syV(t), fmt(t)) + label(HW + 4, syV(t) + 3, usd(t))
          : `<line x1="${x0}" x2="${HW}" y1="${syV(t)}" y2="${syV(t)}" stroke="${GRID}"/>`)).join('')
        out += `<line x1="${x0}" x2="${HW}" y1="${syV(med)}" y2="${syV(med)}" stroke="${DIM}" stroke-dasharray="4 4"/>`
      }
      out += label(x0, top + laneH + 17, '▲ Climb of each window') + label(HW, top + laneH + 17, 'Work per 1% ▼', 'end')
      // before the first known window: nothing kept
      if (first > t0) {
        const xa = sx(Math.min(first, t1))
        out += `<rect x="${x0}" y="${top}" width="${xa - x0}" height="${base - top}" fill="url(#wNone)"/>`
        if (xa - x0 > 70) out += label((x0 + xa) / 2, top + laneH / 2, 'No data', 'middle')
      }
      // 7D behind the climbs, in blue on the same 0-100% scale: its readings as
      // steps, dropping to 0 where a 7D window resets.  Thinned to one reading
      // per 30 minutes (7D) or 6 hours (30D, 90D): the History pane stops
      // redrawing past ~250k characters in all (see HOVER_CSS).
      const s7 = v.samples.filter(q => q.kind === 'seven_day' && q.resetsAt).sort((a, b) => a.at - b.at)
      const p7: [number, number][] = []
      {
        const bucket = range === 7 ? 1800 : 21600, th = new Map<number, Sample>()
        let pre: Sample | undefined
        for (const q of s7) { if (q.at < t0) { pre = q; continue } if (q.at > t1) break; th.set(Math.floor(q.at / bucket), q) }
        let ra = ''
        for (const q of [...(pre ? [pre] : []), ...th.values()]) {
          const st7 = Date.parse(q.resetsAt!) / 1000 - SPAN.seven_day
          if (ra && q.resetsAt !== ra && st7 > t0) p7.push([st7, p7[p7.length - 1]![1]], [st7, 0])
          ra = q.resetsAt!
          p7.push([Math.max(t0, q.at), q.pct])
        }
      }
      // the 7D reading at a moment, for tooltips
      const at7 = (t: number) => { let p: number | null = null; for (const [a, b] of p7) { if (a > t) break; p = b } return p }
      let back7 = ''
      if (p7.length) {
        let d7 = `M${sx(p7[0]![0])},${syP(p7[0]![1])}`
        for (const [t, p] of p7.slice(1)) d7 += ` H${sx(t)} V${syP(p)}`
        d7 += ` H${sx(t1)}`
        back7 = `<path d="${d7} V${syP(0)} H${sx(p7[0]![0])} Z" fill="${COLD}" fill-opacity="0.14"/><path d="${d7}" fill="none" stroke="${COLD}" stroke-width="1.5" stroke-opacity="0.8" stroke-linejoin="round"/>`
      }
      const tip7 = (t: number): TipLine[] => { const p = at7(t); return p === null ? [] : [{ s: `7D ${Math.round(p)}%`, key: { col: COLD } }] }
      // the waveform's points, in time order: [x, y, solid]
      const pts: [number, number, boolean][] = []
      let dots = '', hv = ''
      const dot = (cx: number, x: number, sure: boolean, r = 4) => {
        const c = colOf(x), cy = syV(x)
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${sure ? c : CARD}" stroke="${sure ? CARD : c}" stroke-width="${sure ? 2 : 1.5}"/>`
      }
      if (range === 7) {
        // idle stretches between windows (over an hour): hatched in the climb lane
        let prev = Math.max(t0, first)
        for (const w of inR) { if (w.st - prev > 3600) out += `<rect x="${sx(prev)}" y="${top}" width="${sx(w.st) - sx(prev)}" height="${laneH}" fill="url(#wIdle)"/>`; prev = Math.max(prev, Math.min(t1, w.end)) }
        if (t1 - prev > 3600) out += `<rect x="${sx(prev)}" y="${top}" width="${sx(t1) - sx(prev)}" height="${laneH}" fill="url(#wIdle)"/>`
        out += back7
        for (const w of inR) {
          // a step climb from 0, held until the window resets, then back to 0
          const a = Math.max(t0, w.st), endT = Math.min(t1, w.end)
          let d = `M${sx(a)},${syP(0)}`
          for (const [t, p] of w.pts) d += ` H${sx(Math.max(t0, t))} V${syP(p)}`
          if (!w.pts.length) d += ` V${syP(w.peak)}` // readings gone: the ledger's top reading
          d += ` H${sx(endT)}`
          out += `<path d="${d} V${syP(0)} Z" fill="url(#wClimb)" fill-opacity="${climbOp(w.peak)}"/><path d="${d}${endT < t1 ? ` V${syP(0)}` : ''}" fill="none" stroke="${ME}" stroke-width="1.5" stroke-linejoin="round"/>`
          const cx = sx((a + endT) / 2)
          if (w.per1 > 0 && med) { pts.push([cx, syV(w.per1), w.sure]); dots += dot(cx, w.per1, w.sure) }
          const lines: TipLine[] = [`${stamp(w.st * 1000).replace(/ [A-Z]{2,5}$/, '')} to ${hm(w.end * 1000)}`,
            { s: `Climbed to ${w.peak}%${w.peak >= 100 ? ' · limit reached' : ''}`, key: { col: ME } },
            ...tip7(endT),
            w.per1 > 0 && med ? { s: `${fmt(w.per1)} (${usd(w.per1)}) per 1% · ${vsTxt(w.per1)}${w.sure ? '' : ' · low confidence'}`, key: { col: colOf(w.per1), kind: w.sure ? 'dot' : 'ring' } }
              : { s: w.end > nowS ? 'Window still open' : 'Too little work to size', key: { col: DIM, kind: 'ring' } },
            // Mixed windows: each model's share of the limit used (scan.py
            // _limitMix), so a Fable-heavy window is plain on hover.
            ...(v.limitMix?.[w.ra] ? [Object.entries(v.limitMix[w.ra]!).map(([m, p]) => `${m} ${p}%`).join(' · ')]
              : w.models.length ? [w.models.join(' + ')] : []),
            ...(w.outside > 0 ? [`${w.outside}% elsewhere`] : [])]
          const xa = sx(a), xb = sx(endT)
          hv += hover(hitRect(xa, top, Math.max(3, xb - xa), base - top), `<rect x="${xa}" y="${top}" width="${Math.max(3, xb - xa)}" height="${base - top}" fill="${INK}" fill-opacity="0.1"/>`, tipBox((xa + xb) / 2, top, H, lines))
        }
        // a tick at each midnight; each day's weekday and date centred on its
        // part of the timeline (left out when too little of the day is on show)
        for (let t = new Date(t0 * 1000).setHours(0, 0, 0, 0) / 1000; t < t1; t = new Date((t + DAY * 1.5) * 1000).setHours(0, 0, 0, 0) / 1000) {
          const a = Math.max(t0, t), z = Math.min(t1, new Date((t + DAY * 1.5) * 1000).setHours(0, 0, 0, 0) / 1000)
          if (t >= t0) out += `<line x1="${sx(t)}" x2="${sx(t)}" y1="${base}" y2="${base + 3}" stroke="${DIM}"/>`
          if (sx(z) - sx(a) >= 34) out += dayTick((sx(a) + sx(z)) / 2, H - 2, t * 1000)
        }
      } else {
        // 30D and 90D: a column per day; the day's highest climb as a bar, the
        // middle of its windows' work per 1% as a dot, a line for their range
        const cw = (HW - x0) / keys.length, bw = Math.max(1.5, cw - (cw > 6 ? 2 : 1))
        const dayWins = keys.map(k => { const a = dayOfKey(k).setHours(0, 0, 0, 0) / 1000; return all.filter(w => w.st >= a && w.st < a + DAY) })
        out += back7
        keys.forEach((k, i) => {
          const a = dayOfKey(k).setHours(0, 0, 0, 0) / 1000, x = x0 + i * cw, ws = dayWins[i]!
          if (a + DAY <= first) return
          if (!ws.length) { out += `<rect x="${x}" y="${top}" width="${cw}" height="${laneH}" fill="url(#wIdle)"/>`; return }
          const pk = Math.max(...ws.map(w => w.peak))
          out += upBar(x + (cw - bw) / 2, syP(pk), bw, Math.max(2, (pk / 100) * laneH), ME, +climbOp(pk))
          const vals = ws.filter(w => w.per1 > 0).map(w => w.per1)
          if (vals.length && med) {
            const m = median(vals), cx = x + cw / 2, sure = ws.some(w => w.sure && w.per1 > 0)
            if (vals.length > 1) out += `<line x1="${cx}" x2="${cx}" y1="${syV(Math.max(...vals))}" y2="${syV(Math.min(...vals))}" stroke="${colOf(m)}" stroke-width="1.5" stroke-opacity="0.6"/>`
            pts.push([cx, syV(m), sure]); dots += dot(cx, m, sure, cw > 8 ? 3.5 : 2.5)
          }
        })
        for (const [a, z] of hoverSpans(keys.length)) {
          const ws = dayWins.slice(a, z + 1).flat(), name = a === z ? longDay(keys[a]!) : `${shortDay(keys[a]!)} to ${shortDay(keys[z]!)}`
          const vals = ws.filter(w => w.per1 > 0).map(w => w.per1), pk = ws.length ? Math.max(...ws.map(w => w.peak)) : 0
          const before = dayOfKey(keys[z]!).setHours(24, 0, 0, 0) / 1000 <= first
          const lines: TipLine[] = before ? [name, 'No data'] : !ws.length ? [name, 'No use'] : [name, `${ws.length} ${ws.length === 1 ? 'window' : 'windows'}`,
            { s: `Highest climb ${pk}%`, key: { col: ME } },
            ...tip7(Math.min(t1, dayOfKey(keys[z]!).setHours(24, 0, 0, 0) / 1000 - 1)),
            ...(vals.length && med ? [{ s: `${fmt(median(vals))} (${usd(median(vals))}) per 1% (middle) · ${vsTxt(median(vals))}`, key: { col: colOf(median(vals)), kind: 'dot' as const } },
              ...(vals.length > 1 ? [{ s: `Range ${fmt(Math.min(...vals))} to ${fmt(Math.max(...vals))}`, key: { col: DIM } }] : [])] : [])]
          const xa = x0 + a * cw, wd = (z - a + 1) * cw
          hv += hover(hitRect(xa, top, wd, base - top), `<rect x="${xa}" y="${top}" width="${wd}" height="${base - top}" fill="${INK}" fill-opacity="0.1"/>`, tipBox(xa + wd / 2, top, H, lines))
        }
        const every = Math.ceil(keys.length / 6)
        // the last label ends at the edge instead of running off it
        keys.forEach((k, i) => { if ((keys.length - 1 - i) % every === 0) { const x = x0 + i * cw + cw / 2; out += x > HW - 16 ? label(HW, H - 2, shortDay(k), 'end') : label(x, H - 2, shortDay(k), 'middle') } })
      }
      // The waveform: a smooth line through every dot (each step eases across,
      // so it never overshoots one), dashed and faint where it touches a hollow
      // dot; the fill, down to the usual line, follows the solid dots only.
      if (med && pts.length > 1) {
        const step = (p: [number, number, boolean], q: [number, number, boolean]) => { const xm = (p[0] + q[0]) / 2; return ` C${xm},${p[1]} ${xm},${q[1]} ${q[0]},${q[1]}` }
        const sol = pts.filter(p => p[2]), yM = syV(med)
        if (sol.length > 1) {
          let f = `M${sol[0]![0]},${sol[0]![1]}`
          for (let i = 1; i < sol.length; i++) f += step(sol[i - 1]!, sol[i]!)
          out += `<path d="${f} L${sol[sol.length - 1]![0]},${yM} L${sol[0]![0]},${yM} Z" fill="url(#wFill)"/>`
        }
        let line = '', guess = ''
        for (let i = 1; i < pts.length; i++) {
          const seg = `M${pts[i - 1]![0]},${pts[i - 1]![1]}` + step(pts[i - 1]!, pts[i]!)
          if (pts[i - 1]![2] && pts[i]![2]) line += seg; else guess += seg
        }
        if (line) out += `<path d="${line}" fill="none" stroke="url(#wLine)" stroke-width="2" stroke-linecap="round"/>`
        if (guess) out += `<path d="${guess}" fill="none" stroke="url(#wLine)" stroke-width="1.2" stroke-opacity="0.5" stroke-dasharray="3 3"/>`
      }
      out += dots + hv
      // Header: the trend, as Limit size had it (15% or more counts as a change)
      const conf = solid.map(w => w.per1)
      let right = `${inR.length} windows`
      if (conf.length >= 8) {
        const recent = median(conf.slice(-3)), chg = med > 0 ? (recent - med) / med : 0
        right = Math.abs(chg) < 0.15 ? `Steady · usual ${fmt(med)} per 1%` : `${chg < 0 ? 'Down' : 'Up'} ${Math.round(Math.abs(chg) * 100)}% lately`
      } else if (med) right += ` · usual ${fmt(med)} per 1%`
      const hot = inR.filter(w => w.peak >= 90).length
      HW = HW_FULL
      windows = {
        svg: svgDoc(H, out), alt: `${inR.length} 5H windows over ${range} days${hot ? `, ${hot} reached 90%` : ''}${med ? `, usual ${fmt(med)} work units per 1%` : ''}`,
        right, rightBad: right.startsWith('Down'),
        legend: [{ name: range === 7 ? 'Window climb' : 'Highest climb that day', col: ME }, ...(p7.length ? [{ name: '7D', col: COLD }] : []),
          { name: 'Bigger limit', col: UP, glyph: '●' }, { name: 'Smaller limit', col: DOWN, glyph: '●' }, { name: 'Under 15% used', col: DIM, glyph: '○' },
          ...(range === 7 ? [] : [{ name: 'Range that day', col: DIM, glyph: '│' }]),
          ...(med ? [{ name: `Usual ${fmt(med)}`, col: DIM, glyph: '┄' }, { name: 'Normal ±10%', col: mix(CARD, HIST, 0.5) }] : []),
          { name: 'No use', col: DIM, glyph: '▨' }],
      }
      text.push(`5H windows: ${right}`)
    }
  }

  // --- Limit by time: work per 1% of 5H by weekday and 4-hour block ---
  // From scan.py's by_time(): every kept tick (180 days, so the range buttons
  // do not change it), model-adjusted.  Each cell against the usual figure
  // (all kept ticks pooled).  Same rules as 5H windows (0.7.13): green a
  // bigger limit, red a smaller one, faint at usual and full colour at 10%
  // off; the header names a slot only at 15%+ off.  A cell is an outline only,
  // too little data to trust its colour, when it pools under BT_MIN_DAYS days
  // or its 90% range is wider than 15%.  The range is measured between days
  // (scan.py), since ticks from one session are not separate evidence.
  let byTime: Chart | null = null
  {
    const bt = v.byTime
    const SAT = 0.1, TREND = 0.15, BT_MIN_DAYS = 3  // as 5H windows: full colour 10% off, header from 15%
    // older scans have no per-cell days: judge those by their range alone
    const weak = (c: ByTimeCell) => (c.days ?? BT_MIN_DAYS) < BT_MIN_DAYS || c.err / c.per1 > 0.15
    if (bt && bt.per1 > 0 && bt.grid?.some(r => r.some(Boolean))) {
      const blocks = bt.grid[0]!.length, bh = 24 / blocks
      // Each row pools every matching weekday in the kept ticks, so its right
      // edge says how many days went in (scan.py by_time "days"), not a date.
      const days = bt.days, dw = days ? 40 : 0
      const x0 = 32, cell = (HW - x0 - dw) / blocks, ch = 13, H = 7 * (ch + 2) + 14
      let out = '', hv = ''
      bt.grid.forEach((row, r) => {
        const y = r * (ch + 2)
        out += label(x0 - 6, y + 10, WEEK[r]!, 'end')
        if (days) out += label(HW, y + 10, `${days[r] ?? 0} ${days[r] === 1 ? 'day' : 'days'}`, 'end')
        row.forEach((c, b) => {
          const x = x0 + b * cell + 1, w = cell - 2
          if (!c) { out += `<rect x="${x}" y="${y}" width="${w}" height="${ch}" rx="2" fill="${EMPTY}"/>`; return }
          const diff = c.per1 / bt.per1 - 1, thin = weak(c)
          const col = mix(EMPTY, diff >= 0 ? UP : DOWN, 0.1 + 0.9 * Math.min(1, Math.abs(diff) / SAT))
          out += thin
            ? `<rect x="${x + 0.75}" y="${y + 0.75}" width="${w - 1.5}" height="${ch - 1.5}" rx="2" fill="none" stroke="${col}" stroke-width="1.5"/>`
            : `<rect x="${x}" y="${y}" width="${w}" height="${ch}" rx="2" fill="${col}"/>`
          const sign = diff >= 0.005 ? '+' : diff <= -0.005 ? '−' : ''
          hv += hover(hitRect(x, y, w, ch), `<rect x="${x - 1}" y="${y - 1}" width="${w + 2}" height="${ch + 2}" rx="3" class="o"/>`,
            tipBox(x + w / 2, y + ch + 4, H, [`${WEEK[r]} ${hourTxt(b * bh)} to ${hourTxt(((b + 1) * bh) % 24)}`,
              `${sign}${Math.abs(Math.round(diff * 100))}% vs usual`, `${fmt(c.per1)} work units per 1%`,
              `${c.n} ticks${c.days ? ` over ${c.days} ${c.days === 1 ? 'day' : 'days'}` : ''}, ${c.pct}% moved`,
              `Likely range ±${Math.round((c.err / c.per1) * 100)}%${thin ? ', too little data to judge' : ''}`]))
        })
      })
      for (let b = 0; b < blocks; b += blocks > 6 ? 2 : 1) out += label(x0 + b * cell + 1, H - 1, hourTxt(b * bh).replace(' ', '').toLowerCase())
      // the strongest trustworthy cell, for the header
      let best: { d: number; name: string } | null = null
      bt.grid.forEach((row, r) => row.forEach((c, b) => {
        if (!c || weak(c)) return
        const d_ = c.per1 / bt.per1 - 1
        if (!best || Math.abs(d_) > Math.abs(best.d)) best = { d: d_, name: `${WEEK[r]} ${hourTxt(b * bh).replace(' ', '').toLowerCase()}` }
      }))
      const b_ = best as { d: number; name: string } | null
      const right = (b_ && Math.abs(b_.d) >= TREND ? `${b_.name} ${b_.d > 0 ? '+' : '−'}${Math.round(Math.abs(b_.d) * 100)}%` : `${bt.ticks} ticks · no clear pattern yet`)
      byTime = {
        svg: svgDoc(H, out + hv), alt: `Work per 1% of 5H by weekday and ${bh}-hour block against the usual figure of ${bt.ticks} ticks`, right,
        legend: [{ name: 'Smaller limit', col: DOWN }, { name: 'Bigger limit', col: UP }, { name: 'Outline: too little data', col: DIM }],
      }
      text.push(`Limit by time: ${right}`)
    }
  }

  // --- Projects: where the work went ---
  let projects: Chart | null = null
  {
    const P: Record<string, number> = {}
    for (const k of keys) for (const [p, u] of Object.entries(D[k]?.p ?? {})) P[p] = (P[p] ?? 0) + u
    const all = Object.entries(P).sort((a, b) => b[1] - a[1])
    if (all.length) {
      const topN = all.slice(0, 5), rest = all.slice(5).reduce((a, b) => a + b[1], 0)
      const rows = rest > 0 ? [...topN, ['Other', rest] as [string, number]] : topN
      const rowH = 22, H = rows.length * rowH, lx = 126
      const max = Math.max(...rows.map(r => r[1]))
      let out = `<defs>${gradDef('pj', ME, false)}${gradDef('po', MODEL_COL.other!, false)}</defs>`, hv = ''
      const sum = all.reduce((a, b) => a + b[1], 0)
      rows.forEach(([name, u], i) => {
        const y = i * rowH + 4, w = Math.max(2, (u / max) * (HW - lx - 52))
        const nm = name.length > 20 ? name.slice(0, 19) + '…' : name
        out += `<text x="0" y="${y + 11}" fill="${INK}" font-size="11">${esc(nm)}</text>` +
          rightBar(lx, y, w, 14, name === 'Other' && i === rows.length - 1 && rest > 0 ? 'url(#po)' : 'url(#pj)') +
          `<text x="${lx + w + 6}" y="${y + 11}" fill="${DIM}" font-size="11">${esc(valTxt(u))}</text>`
        const isRest = name === 'Other' && i === rows.length - 1 && rest > 0
        hv += hover(hitRect(-4, y - 3, HW + 4, rowH), `<rect x="-4" y="${y - 3}" width="${HW + 4}" height="${rowH}" rx="4" fill="${INK}" fill-opacity=".07"/>`,
          tipBox(lx + w + 40, y - 3, Math.max(H, 48), [isRest ? `Other (${all.length - 5} folders)` : name, `${valTxt(u)} · ${Math.round((u / sum) * 100)}% of work`, `${fmt(u)} work units`]))
      })
      out += hv
      projects = { svg: svgDoc(Math.max(H, 48), out), alt: `Top projects: ${rows.map(r => `${r[0]} ${valTxt(r[1])}`).join(', ')}`, right: `${unit}, ${range} days` }
      text.push(`Projects: ${rows.slice(0, 3).map(r => `${r[0]} ${valTxt(r[1])}`).join(' · ')}`)
    }
  }

  // --- Hours: weekday x hour, one hue by strength ---
  let hours: Chart | null = null
  {
    const M = WEEK.map(() => Array(24).fill(0) as number[])
    for (const k of keys) {
      const b = D[k]
      if (!b) continue
      const wd = (dayOfKey(k).getDay() + 6) % 7 // Monday first
      b.h.forEach((u, h) => { M[wd]![h] = M[wd]![h]! + u })
    }
    const max = Math.max(...M.flat())
    if (max > 0) {
      const x0 = 32, cell = (HW - x0) / 24, ch = 13, H = 7 * (ch + 2) + 14
      let out = '', hv = ''
      const all = M.flat().reduce((a, b) => a + b, 0)
      M.forEach((row, r) => {
        out += label(x0 - 6, r * (ch + 2) + 10, WEEK[r]!, 'end')
        row.forEach((u, h) => {
          const t = u / max, x = x0 + h * cell + 1, y = r * (ch + 2)
          out += `<rect x="${x}" y="${y}" width="${cell - 2}" height="${ch}" rx="2" fill="${t < 0.02 ? EMPTY : ME}" fill-opacity="${t < 0.02 ? 1 : (0.18 + t * 0.82).toFixed(2)}"/>`
          hv += hover(hitRect(x - 1, y - 1, cell, ch + 2), `<rect x="${x - 1}" y="${y - 1}" width="${cell}" height="${ch + 2}" rx="3" class="o"/>`,
            tipBox(x + cell / 2, y + ch + 4, H, [`${WEEK[r]} ${hourTxt(h)} to ${hourTxt((h + 1) % 24)}`, u > 0 ? valTxt(u) : 'No work',
              ...(u > 0 ? [`${fmt(u)} work units · ${Math.round((u / all) * 100)}% of ${range} days`] : [])]))
        })
      })
      out += hv
      for (const h of [0, 6, 12, 18]) out += label(x0 + h * cell + 1, H - 1, hourTxt(h).replace(' ', '').toLowerCase())
      hours = { svg: svgDoc(H, out), alt: 'Work by weekday and hour of day', right: 'by hour, local time', legend: [{ name: 'Less', col: mix(CARD, ME, 0.3) }, { name: 'More', col: ME }] }
    }
  }

  // --- Re-reading: per day, re-reading (grey) under new work (accent) ---
  let reread: Chart | null = null
  {
    const H = 100, x0 = 34, top = 8, base = H - 16
    const totals = keys.map(k => dayTotal(D[k]))
    const max = niceMax(val(Math.max(...totals, 0)) * 1.05)
    const sy = (x: number) => (x / max) * (base - top)
    const sx = (HW - x0) / keys.length, gap = sx > 6 ? 2 : 1, bw = Math.max(1, sx - gap)
    let out = `<defs>${gradDef('rn', ME, true)}</defs>` + [0, max / 2, max].map(t => gridLine(x0, base - sy(t), tick(t))).join(''), hv = ''
    for (const [a, z] of hoverSpans(keys.length)) {
      const cx = x0 + ((a + z + 1) / 2) * sx
      const name = a === z ? longDay(keys[a]!) : `${shortDay(keys[a]!)} to ${shortDay(keys[z]!)}`
      const t = totals.slice(a, z + 1).reduce((p, q) => p + q, 0)
      const r = keys.slice(a, z + 1).reduce((p, k) => p + (D[k]?.r ?? 0), 0)
      hv += hover(hitRect(x0 + a * sx, top, (z - a + 1) * sx, base - top), a === z ? crossX(cx, top, base) : `<rect x="${x0 + a * sx}" y="${top}" width="${(z - a + 1) * sx}" height="${base - top}" fill="${INK}" fill-opacity=".07"/>`,
        tipBox(cx, top, H, t > 0
          ? [name, `Re-reading ${Math.round((r / t) * 100)}% · ${valTxt(r)}`, `New work ${valTxt(t - r)}`, `Total ${valTxt(t)}`]
          : [name, 'No work']))
    }
    keys.forEach((k, i) => {
      const b = D[k], t = totals[i]!
      if (!b || t <= 0) return
      const hh = sy(val(b.r)), nh = sy(val(t - b.r)), x = x0 + i * sx + gap / 2
      out += `<rect x="${x}" y="${base - hh}" width="${bw}" height="${hh}" fill="${HIST}"/>` + upBar(x, base - hh - nh, bw, Math.max(0.5, nh - 1), 'url(#rn)')
    })
    out += label(x0 + 2, H - 2, shortDay(keys[0]!)) + label(HW, H - 2, 'Today', 'end') + hv
    const R = keys.reduce((a, k) => a + (D[k]?.r ?? 0), 0), T = totals.reduce((a, b) => a + b, 0)
    if (T > 0) {
      reread = {
        svg: svgDoc(H, out), alt: `${Math.round((R / T) * 100)}% of work re-reading the conversation over ${range} days`, right: `${Math.round((R / T) * 100)}% of work`,
        legend: [{ name: 'Re-reading the conversation', col: HIST }, { name: 'New work', col: ME }],
      }
    }
  }

  return { ok: Object.keys(D).length > 0, full: !!hist?.full, unit, tiles, daily, pace, pace7, windows, byTime, projects, hours, reread, text }
}

// ---------------------------------------------------------------------------
// The manual (side pane).  Pure: no `$`.
// ---------------------------------------------------------------------------
const manualText = (v: View | null, last: number | null, now: number, ledger: LedgerRow[]): string => {
  const L: string[] = []
  L.push('# Mana Pool: user manual', '')
  L.push('Mana Pool reads the token counts Claude Code writes on this computer and shows three things: **runway** on the 5H and 7D limits, **session cost** against a new session, and **limit size**, the work 1% buys. It never calls a model, so it uses no tokens.', '')

  L.push('## The band, row by row', '')
  L.push('- **7D / 5H bars**: how much of the weekly and 5-hour limits is used. The colour runs green (plenty left) to red (nearly full). `~` marks an estimated hundredth: the meter itself moves in whole points.')
  L.push('- **Inside each bar** (above it in a terminal): the **pace** over the last hour of real ticks (5H), or since the meter\'s value 24 hours ago, over the full 24 hours (7D: a busy morning after time away is not a day\'s pace; none in a 7D window\'s first 3 hours), and when the limit **resets**. If at that pace it would hit 100% first it says **runs out in N · resets in M**. Short of room, the pace goes first, then the reset time shortens. In Mini, a limit that would run out turns into a ring with its percent and **out in N** beside it, so the line keeps its other parts.')
  L.push('- **Last turn**: what the last message and its full reply cost (every model call in it, subagents included), in % of the 5H limit; what the same turn would cost **in a new session** that took over through a hand-off note, with the ratio in brackets; and how many turns a **hand-off** takes to pay for itself (writing the note plus the new session caching its start). The **Cost pill** on the right states the result (rules below).')
  L.push('- **Next turn** ("next" on the Last turn line): what the next turn here should cost, in % of 5H: the middle of the last 3 finished turns, re-priced on the model you are on now, plus the one-time re-cache when the cache is cold. A forecast; Last turn is the measured one.')
  L.push('- **Turns**: one small bar per turn of this whole session: grey is the part spent **re-reading** the old conversation, violet the **new work**. Dim bars were before the current 5H window started (a thin line marks its start). Then the turn count, how much of the 5H limit this session has **used** since the window began, and its share of **last hour\'s use** (everything Claude Code used on this computer in the last hour, subagents included). Open the band in each session to see which one uses the most.')
  L.push('- **Context**: context size, how much of the window is used, how much it grows per turn, and how close auto-compact is, with the **Context pill**: a warning that the session is getting long enough for the model to lose track of earlier detail.')
  L.push('- **Cache**: the prompt cache clock. **Active** means the conversation is still in the prompt cache, so the next message reads it cheaply (a *cache read*). An hour after the last reply the cache **expires**, and the next message here costs extra to re-cache the whole conversation (a *cache write*), once. A cache belongs to one model: after switching models it shows **Model changed**, and the next message pays that re-cache too.')
  L.push('- **Limit check** (once past windows are recorded): how much work 1% of the 5H limit buys in this window, against the usual amount: halfway between the 25th and 75th percentile of finished 5H windows that reached 20% (with under 4 such windows, halfway between the lowest and highest). **Normal** within 15% of usual; red when it buys 15%+ less (a shrinking limit), or when the meter moved with no Claude Code use on this computer (**elsewhere**: see below). "Work" is usage weighted by token type and model; see "Limit audit". Points moved elsewhere are left out: work per 1% is the work here over the points it moved, so a window used partly in the cloud does not also read as a smaller limit. The **elsewhere** points of this window show on this row (and in Mini and the `/manapool` summary) whenever above 0, before there are past windows to compare with too.')
  L.push('- **Other models**: one column for each model you are not on, and two ways to move to it, each shown as a one-time cost, then the cost per turn after it. **Switch now**: this session changes model, so the whole conversation is cached on the new model once, and every later turn still re-reads it. **Hand off**: write a hand-off note here and start a new session on that model; it caches only its small start, and its turns carry no old conversation. Per-turn costs are the last 3 turns re-priced on that model (assuming it would use the same tokens: Fable tends to think more, Haiku to write less). Green marks the cheaper path over the next 5 turns. As a session grows, switching now costs more and handing off costs less.')
  L.push('- **▤ / ⓘ / ⊖ / ⊕**: the History pane / this manual / Mini (one line) / back to Full. Mini shows the bars with their percent inside, **elsewhere** when above 0, the last turn as a pill coloured by whichever of Cost and Context is worse (a dotted border for amber, dashed for red), and the cache clock.', '')

  L.push('## The pills', '')
  L.push('| Pill | Green | Blue | Amber | Red |', '|---|---|---|---|---|')
  L.push('| **Cost** | Keep going | Good moment to switch: the prompt cache expired and turns here cost 1.3x+ a new session, so switching now costs little extra | Consider handoff: turns cost 1.5x+ a new session and a hand-off pays back within 5 turns | Hand off: 2.5x+ and it pays back within 2 turns |')
  L.push('| **Context** | Fine | | Getting long: context 50%+ used, or auto-compact is about 5 turns away | Hand off: auto-compact is about 2 turns away, or it already ran (a `/compact` you ran yourself does not count) |')
  L.push('', 'The Cost pill uses the median of the last 3 finished turns, so one odd turn does not flip it. Lost detail cannot be measured directly (nobody can measure model quality), so it uses stand-ins: how full the context is, how near **auto-compact** is (when the context fills up, Claude Code compacts the old conversation into a summary on its own, and detail is lost), and how fast the context grows. A written hand-off note keeps more detail than an automatic compaction.', '')
  L.push('## Alerts', '')
  L.push('- **In-app toast** (8 seconds, no sound) when a pill gets *worse* (to amber or red). Once per state per session; it shows again only after the pill has stayed better for 15 minutes, so a pill that flickers at a threshold toasts once. Toasts also show over Remote Control.')
  L.push('- **System notification** when the 5H limit will run out within about 30 minutes at the current pace. Once per 5H window, across all sessions. It tries Claude Code\'s own notification first and falls back to a macOS notification (Mac only).', '')

  if (v && v.wins.length > 0) {
    const d = derive(v, last, now)
    L.push('## Live numbers', '')
    L.push('| Window | Used | Resets | Pace | Runway | Work units | Raw tokens | Calls |', '|---|---|---|---|---|---|---|---|')
    for (const w of [d.w5, d.w7]) {
      if (!w) continue
      const rw = d.runway(w)
      const t = w.tokens
      L.push(`| ${w.kind === 'five_hour' ? '5 hour' : '7 day'} | ${d.est(w).toFixed(2)}% | ${w.resetsAt ? day(Date.parse(w.resetsAt)) : '?'} | ${rw.r > 0 ? (w.kind === 'five_hour' ? `${rw.r.toFixed(1)}%/h` : `${(rw.r * 24).toFixed(1)}%/day`) : '-'} | ${rw.text} | ${grp(t.units)} | ${grp(t.input + t.output + t.cache_write + t.cache_read)} | ${grp(t.messages)} |`)
    }
    L.push('')
    if (d.ses) {
      const s = d.ses
      L.push(`**This session:** ${s.turnCount} turns, ${s.subagentCalls} subagent calls, started from a ${fmt(s.base)} context; grows about ${fmt(s.grow)} a turn; ${s.compactions} auto-compacts so far. Since the 5H window began: ${grp(s.since5h.units)} work units = ${d.ok ? pctTxt(d.sesPct) : '?'} of 5H.`, '')
      const rows = s.turns.slice(-12)
      if (rows.length) {
        L.push('| Turn started | Model | Calls (subagent) | Context at start | Cost | Re-reading | New session | Ratio |', '|---|---|---|---|---|---|---|---|')
        for (const t of rows) {
          L.push(`| ${day(t.t * 1000)}${t.live ? ' (running)' : ''} | ${cap(t.k)} | ${t.n} (${t.subs}) | ${fmt(t.ctx)} | ${d.ok ? pctTxt(d.pc(t.u)) : grp(t.u)} | ${t.u > 0 ? Math.round((t.h / t.u) * 100) : 0}% | ${d.ok ? pctTxt(d.pc(t.f)) : grp(t.f)} | ${t.f > 0 ? (t.u / t.f).toFixed(1) : '-'}x |`)
        }
        L.push('')
      }
    }
  }

  L.push('## Limit audit', '')
  L.push('Anthropic does not say how much work a 5H or 7D window holds. The **ledger** keeps one row per finished window, the newest 3,000 (well over a year of heavy use), so a shrinking limit shows up as a drop in **work units per 1%**. `/manapool export` writes it as a CSV (`~/Documents/Mana Pool/manapool-ledger.csv`).', '')
  L.push('- **Work units** weigh each token by type and model at API list prices for the exact model version, 1 unit = one Sonnet 5.5 input token. Raw token counts mislead: a cache-read token costs 1/50 to 1/200 of an output token, so light work in a long session looks huge in raw tokens. The ledger always uses plain list weights, so rows stay comparable even when the cost weights below are re-fitted.')
  L.push('- **Elsewhere**: points the meter moved with almost no work on this computer behind them (under a quarter of a usual point). Cloud sessions, claude.ai chat, the phone app and other computers share the limit but write nothing here. Only such ticks count: elsewhere use that runs alongside work here moves the meter the same way a smaller limit would, so it shows in the limit check as buying less, not here. A window starts at 0%, so use before the first reading here (a cloud session while no session was open) counts too. A whole 5H window used elsewhere that resets before a session here reads the meter shows only on 7D: a 7D jump of 2+ points with almost no work here, less what 5H ticks already counted, counts as well. A call still running at a reading counts towards it (a reply is logged when it finishes, but the meter counts it while it runs). A tick only counts when this computer was quiet around it: the meter lags the work and shows whole points, so the work of the 15 minutes before a tick counts towards it, plus under a point of rounding from earlier. Use elsewhere at the same time as work here can\'t be told from that lag. On 7D, where every quiet night ticks 1 point, it takes 2. Elsewhere ticks are left out of the model weights. Each point is weighed at the window\'s work here over the points that work moved; a window with under 3 such points borrows the usual figure. Remote Control sessions run on this computer and are counted as work here.')
  L.push('- **Meter** is the last reading seen in that window. If no session was open near its end, the true final figure may be a little higher.', '')
  if (ledger.length === 0) {
    L.push('_No finished window recorded yet._', '')
  } else {
    L.push('| Window | Started | Models | Meter | Work units | Per 1% | Raw tokens | Elsewhere |', '|---|---|---|---|---|---|---|---|')
    for (const r of [...ledger].sort((a, b) => b.start - a.start).slice(0, 40)) {
      L.push(`| ${r.kind === 'five_hour' ? '5H' : '7D'} | ${day(r.start * 1000)} | ${r.models.join(' + ') || '-'} | ${r.pct}% | ${fmt(r.units)} | ${herePer1(r) ? fmt(herePer1(r)) : '-'} | ${fmt(r.tokens.reduce((a, b) => a + b, 0))} | ${r.outside ? `${r.outside}%?` : 'none'} |`)
    }
    L.push('')
  }
  const fit = v?.fit
  L.push('## History pane', '')
  L.push('The ▤ button (or `/manapool history`) opens charts of past use over 7, 30 or 90 days. Hover a bar, dot or cell for its numbers. Each model keeps one colour everywhere: Opus violet, Sonnet blue, Fable gold, Mythos orange, Haiku teal, grey for any other.')
  L.push('- **Tiles**: **7D used**; **Per day left**, what is left of 7D spread evenly over the days until it resets; **Re-reading**, the share of the last 7 days spent re-reading the conversation.')
  L.push('- **Daily**: work per day, one colour per model, in **% of 7D** (work units over the current 7D window\'s units per 1%; plain work units until there is a 7D reading). Hatched on top: **elsewhere**, each elsewhere point times its window\'s work per 1%, on the day of the reading that showed it (the tooltip says "since" when it started on an earlier day). Elsewhere only shows between two readings, so a day with none says **not measured**.')
  L.push('- **5H pace**: this window\'s readings against past windows, with the projection to 100% and an even pace (dashed: 100% at reset). Clock times sit under the hours. Usual is the middle past window at each minute; the usual range is the middle half of them. Both follow the range buttons: the windows that started in the last 7, 30 or 90 days. The line is in model colours, as in Daily: each rise takes the colour of the model that did most of the work behind it (weighed at the weights in use), and the band below each flat stretch takes the colour of the rise before it. A rise with no work here is grey, **Elsewhere**. The projection and the dot take the colour of the last model that did work here. Sonnet is blue, Mythos orange, and a model with no list price grey, **Other**.')
  L.push('- **7D pace** (in model colours, as in 5H pace): this week against an even pace (100% at reset) and last week; once 3 past weeks are logged, against their middle half, like 5H pace. 7D readings are kept 120 days for this.')
  L.push('- **5H windows**: every 5H window on a real timeline. Top: how far each window climbed (7D: its readings as steps, thinned to one point per 5 minutes; 30D and 90D: each day\'s highest climb), with the 7D meter behind it in blue on the same scale (it drops to 0 where 7D resets). A climb gets stronger from 50% and is solid violet at 100%. Bottom: work per 1% in each window, weighed at the measured model weights (as in the Limit check), so a window run on a pricier model, such as Fable, does not look like a smaller limit. The left scale is work units, the right the same figure in Opus dollars at list price (1 unit is $2 per million tokens): what that work would cost through the API on Opus, not what a subscription costs. Usual is the median of every solid window; the shaded band is ±10% around it (windows normally scatter 5 to 7%). Green above usual (a bigger limit), red below (a smaller one), full colour at 10% off. The scale runs from the lowest to the highest solid window on show, never narrower than usual ±15%. A waveform joins the dots, filled to the usual line. Hollow dots used under 15% (elsewhere points not counted) and are rough: the line through them is dashed and the fill skips them. A window with under 8 points of work here has no figure (the meter shows whole points, so smaller windows read 15 to 40% low). 30D and 90D show the middle of each day\'s windows, with a line for their range. The header calls a trend only from 8 solid windows, and only at 15% or more: a run of Fable-heavy windows can sit about 9% low.')
  L.push('- **Limit by time**: work per 1% of 5H by weekday and 4-hour block, against the usual figure (kept 180 days, so the range buttons do not change it). Green is a bigger limit, red a smaller one, as in 5H windows. Built from single ticks, not windows, since a window can span a morning and an afternoon. Work is model-adjusted, so a slot where you used a pricier model does not look like a smaller limit. Left out: ticks over 90 minutes or crossing a block, and elsewhere ticks. Usual is all kept ticks pooled. Same colour rules as 5H windows: faint at usual, full colour at 10% off, and the header names a slot only at 15% or more. A cell is an outline, too little data to trust, when it pools under 3 days or its 90% range is wider than 15%. The range is measured between days, not ticks: ticks from one session share its models and way of working, so a single busy morning is one sample however many ticks it has. This measures how much the limit holds at that time, not how much you got done. A row pools every matching weekday, so the right edge says how many days went in, not a date.')
  L.push('- **Hover** any chart for a crosshair and the raw numbers.')
  L.push('- **Projects**: work by the folder a session ran in (a worktree counts as its repository). Over 30 or 90 days a project can pass 100%: more than one week\'s limit. **Hours**: work by weekday and hour, local time.')
  L.push('- **Re-reading**: the share of work spent on cache reads, the old conversation sent again on every call. (The turn strip on the band counts a turn\'s re-reading more exactly.)')
  L.push('- Work here is weighed at plain list prices, like the ledger, so days stay comparable when the fitted weights change.')
  L.push('- Older days come from a one-time read of every transcript the first time the pane has data; Claude Code deletes old transcripts, so `history.json` keeps them.', '')
  L.push('## Model cost on this meter', '')
  if (fit) {
    const ms = fit.measured ?? {}
    L.push('How much each model moves the 5H meter per unit of list-price work, against Opus (Opus = 1.0x), a fixed ruler, so the figures stay comparable when your mix of models changes. With under 15 Opus ticks the ruler is the average tick instead. 1.0x = the same as Opus per unit of list price. **Measured** adds up every tick done 85%+ on one model (one tick alone is too noisy). **Used in costs** starts at 1.0x and moves toward the measured value as ticks build up, so it corrects itself with use. Recent ticks count more (a tick 30 days old counts half), and ticks are kept 180 days, so a change in how the plan weighs a model shows up within weeks.', '')
    L.push('| Model | Measured | Ticks | Used in costs | 90% range |', '|---|---|---|---|---|')
    for (const k of MODELS) {
      const m = ms[k]
      L.push(`| ${cap(k)} | ${m ? `${m.x.toFixed(2)}x` : '-'} | ${fit.model_ticks[k] ?? 0} | ${(fit.MM[k] ?? 1).toFixed(2)}x | ${m?.lo != null && m.hi != null ? `${m.lo.toFixed(2)}x to ${m.hi.toFixed(2)}x` : m ? '-' : 'needs 3 ticks'} |`)
    }
    L.push('', `Token-type weights: list prices, not measured (see **How accurate**). ${fit.ticks} ticks this scan. Fewer turns on a stronger model can still make it the cheaper pick for a task; this table cannot see that.`, '')
  }

  L.push('## How accurate', '')
  L.push('Anthropic publishes none of this: how a plan weighs models and token types is not public. Every cost here is an estimate, built from two things that are measured (your transcripts and the meter) and one assumption (list prices as the starting point).')
  L.push('- **The meter shows whole points only.** Most ticks move exactly 1 point, so a single tick can be off by up to a point. Only many ticks together say anything.')
  L.push('- **Model weights are measured.** On one user\'s two weeks (41 windows, checked in November 2026 by a replay and an independent review), predicting each window\'s points from its work missed by about 28% at list prices and about 4 to 6% with the model weights, held out window by window. Rounding alone accounts for about 2%.')
  L.push('- **Token-type weights are not.** Whether cache reads cost more or less than the price list says could not be told apart from the model weights: Fable work is mostly output, Opus work mostly re-reading, so "reads are cheap" and "Fable costs more" fit the meter equally well. Adding a read factor did not predict held-out windows better, so all token types stay at list prices. If reads really cost less than listed, the weight of a re-reading-heavy model (Opus) carries that, and long-session costs on another model are off by the same amount. An independent check on Opus-only windows hints that Opus output may count about 1.5x list and cache reads about 0.7x (wide ranges, 26 windows): if so, a read-heavy window looks up to about 10% bigger than it is.')
  L.push('- **Your numbers are your own.** The figures above are one person\'s; the table above shows yours, with each weight\'s 90% range. A model you rarely use (under a few ticks of work) stays at its list price.')
  L.push('- **What it cannot see:** use elsewhere at the same moment as work here (it reads as a smaller limit), changes Anthropic makes to the plan between ticks, and anything about answer quality.', '')

  L.push('## How the costs are worked out', '')
  L.push('1. Every model call in the transcripts is priced in work units at the current weights.')
  L.push('2. **Rate**: the 5H meter\'s percent over this window\'s work units (carried over from the last window until this one reaches 8%).')
  L.push('3. A turn = one prompt to the next: every call between them, subagents included. **Re-reading** is the old conversation (context at the turn\'s start minus the context the session started from) read on each main call; from the prompt cache it is a cheap cache read; after the cache expired it is a full cache write.')
  L.push(`4. **New session** = the same turn minus the re-reading, plus reading a hand-off allowance of ${grp(v?.handoff?.extra ?? 15000)} tokens per call (the note and a few re-read files). An assumption; real hand-offs vary.`)
  L.push(`5. **Pays back in N turns** = the one-time cost of a hand-off (about ${grp(v?.handoff?.noteOut ?? 3000)} output tokens to write the note, plus the new session storing its starting context) over the saving per turn (median of the last 3 turns).`)
  L.push('6. **Other models**: switch now = caching the whole conversation on that model once, then the recent turns re-priced on it; hand off = the note on the current model plus that model caching the new session\'s start, then the recent turns as a new session would run them (history gone, hand-off allowance read), re-priced on it. Cheaper = lower total over the next 5 turns.', '')

  L.push('## Accuracy', '')
  L.push('- **Measured:** token counts, calls, turns, subagents, context size, cache timing, auto-compacts, the whole-number percents.')
  L.push('- **Estimated:** the hundredths, the pace and runway, every % of a turn or a switch (they rest on the rate and the weights), the new-session price (it assumes the hand-off allowance).')
  L.push('- **Prices:** each call at its exact model version (Mythos 5, 5.1 and 5.2 at the price of Fable of the same version; Mythos Preview has no listed price and is left out); cache writes by lifetime (1-hour kind 2x input, 5-minute kind 1.25x input); fast mode 2x (forecasts on a model in fast mode are priced fast too: next turn, re-cache, hand-off; other models at standard speed); Haiku 5.5 prompts over 100k at its higher tier.')
  const unp = Object.entries(v?.unpriced ?? {})
  if (unp.length) L.push(`- **Not priced:** ${unp.map(([m, n]) => `${m} (${n} calls)`).join(', ')}. Not in the price table, so left out of every figure.`)
  L.push('- **Not counted:** claude.ai chat and the phone app\'s own chats move the meter but write nothing on this computer.', '')

  L.push('## Where things live', '')
  L.push('- **Reads:** `~/.claude/projects/**/*.jsonl` (Claude Code\'s transcripts, subagents included). Nothing is sent anywhere.')
  L.push('- **Keeps**: in `~/.claude/plugins/data/<plugin>/` (or under `CLAUDE_CONFIG_DIR`) the tick log `samples.jsonl` (one shared file, written under a lock; 5H and 7D readings kept 120 days), `scan-cache.json` (what was already read from each transcript, so a refresh reads only new lines; it lists each transcript\'s full path and the full path of the folder each session ran in), `ticks.json` (each meter tick\'s percent and work per model, kept 180 days) `history.json` (one row per day for the History pane: work per model, per project folder name and per hour; kept 400 days), and while the one-time history backfill is unfinished `backfill.lock` (one backfill at a time across sessions) and `backfill.json` (failures so far and when the next try may start: the wait doubles from 1 minute to a day), and `claims.json` (which 5H window the runs-out alert was last sent for, so only one session sends it); in the mod\'s store the ledger, the last numbers for an instant start, and each session\'s turns and alert state (removed after a week unused). Token counts, times, model names and file paths; no conversation text.')
  L.push('- **Refreshes:** only once the band or a pane has been shown, or after `/manapool` (sessions that never show it, such as `claude -p` runs, read nothing); then about 1.5 seconds after each turn; after a meter tick or a context change too, but at most once every 20 seconds (otherwise within 30 seconds); every 2 minutes when nothing happens. The cache clock redraws every 30 seconds.')
  L.push(`- **Commands:** \`/${CMD}\` opens this pane and prints a short summary (runway and pills first, for a phone). \`/${CMD} history\` opens the History pane (also the ▤ button on the band). \`/${CMD} export\` writes the ledger CSV. \`/${CMD} test-notify\` sends a test system notification.`, '')
  return L.join('\n')
}

// A window's percent only ever goes up: a lower reading is stale (an older
// copy of the mod in another session), so the log is cleaned on every read.
const clean = (list: Sample[]): Sample[] => {
  const top = new Map<string, number>()
  return [...list].sort((a, b) => a.at - b.at).filter(s => {
    const k = `${s.kind}|${s.resetsAt ?? ''}`
    const t = top.get(k) ?? -1
    if (s.pct <= t) return false
    top.set(k, s.pct)
    return true
  })
}

// below: per pill, when it first dropped under each level it has toasted (ms).
// Saved before 0.7.2 without it.
type AlertState = { prev: { cost: number; detail: number }; fired: { cost: number[]; detail: number[] }; below?: { cost: Record<number, number>; detail: Record<number, number> } }
// A toasted level re-arms only after the pill has stayed under it this long,
// so a pill that flickers across a threshold toasts once, not on every crossing.
const REARM_MS = 15 * 60 * 1000
type RunResult = { exitCode: number; stdout: string; stderr: string }
type IO = {
  usage: () => Promise<any>
  usageBreak: () => Promise<any>
  model: () => Promise<string>
  now: () => Promise<number>
  scan: (args: string[], stdin: string, timeoutMs?: number) => Promise<RunResult>
  id: () => Promise<string>
  get: (k: string) => Promise<unknown>
  set: (k: string, val: unknown) => Promise<void>
  keys: () => Promise<string[]>
  del: (k: string) => Promise<void>
  show: (fn: (v: View | null) => View | null) => Promise<void>
  hist: (fn: (v: View | null) => View | null) => Promise<void>
  toast: (text: string) => void
  notify: (text: string) => Promise<any>
  osa: (text: string) => Promise<RunResult>
  lastReply: () => Promise<number | null>
}

export const register: Register = on => {
  let busy = false        // a refresh is running
  let again = false       // another refresh was asked for while one ran
  let spinning = false
  let dirty = true
  let lastFull = 0
  let ioRef: IO | undefined
  let sid = ''
  let turnRunning = false // one of your turns is running (not a subagent's)
  let compactAt: number | undefined
  let compactOff = false  // auto-compact is switched off: no auto-compact estimates at all
  let histAt = 0          // when the History pane's copy (histAtom) was last written
  let histFull = false    // whether that copy already had the older days
  let compactAtRead = 0
  let pruned = 0          // when old per-session entries were last cleared out
  let version = ''        // from plugin.json, shown after the title
  // The Python 3 command that works here, found once.  On Windows `python3`
  // is often missing or the Microsoft Store stub, so `py -3` and `python`
  // are tried next; each must print "3" for Python's major version.
  let py: string[] | undefined
  let alerts: AlertState | undefined
  let backfilling = false  // the one-time history backfill is running
  let storeFull = false    // a store write was refused even after pruning
  let lastSavedKey = ''    // the meters as of the last 'last' write (see refresh)
  let lastSavedAt = 0
  let wallSent = ''        // the 5H window this session already sent the runs-out alert for
  let bfRetryAt = 0        // ms: another session was on it (busy); look again after this
  // Scans and store writes wait for the first draw of the band or a pane, or
  // for /manapool: headless runs (claude -p, agent and workflow sessions)
  // load the mod too but never draw it, and each used to run its own scans
  // and store writes every 30 s.  A desktop-app session also starts with no
  // surface (isInteractive false), so that flag can't tell them apart; the
  // first draw can.  The terminal REPL starts at once.  A draw only sets
  // this flag: work started from inside a draw counts as part of it, and a
  // draw may not write state, so the timers (started at session start) pick
  // it up.
  let started = false
  let kicked = false       // the first refresh after `started` has run

  // Refresh soon after an event, once the transcript is on disk (it lags a
  // moment).  A reply fires two events; `pending` folds them into one refresh.
  let pending = false
  const MIN_GAP_MS = 20000  // fewest ms between full scans asked for by session.measure
  const soon = (sleep: (ms: number) => Promise<void>, now: () => Promise<number>) => {
    if (pending || !started) return
    pending = true
    void (async () => {
      try {
        spinning = true
        if (ioRef) await ioRef.show(v => (v ? { ...v, refreshing: true } : v))
        await sleep(1500)
        if (!ioRef) return
        dirty = false
        lastFull = await now()
        await refresh(ioRef)
      } finally {
        pending = false
      }
    })()
  }

  // System notification: Claude Code's own channel first; a desktop-app
  // session has no terminal, so it may say no-surface: then macOS's own.
  const wallNotify = async (io: IO, text: string) => {
    let how = 'none'
    try {
      const r = await io.notify(text)
      if (r?.isSent) how = `notify:${r.channel}`
    } catch { /* fall through to macOS */ }
    if (how === 'none') {
      try {
        const r = await io.osa(text)
        how = r.exitCode === 0 ? 'osascript' : `osascript failed: ${r.stderr.slice(0, 120)}`
      } catch (err) { how = `osascript failed: ${String(err).slice(0, 120)}` }
    }
    return how
  }

  // Quiet alerts.  Toast when a pill gets worse (amber or red), once per state
  // per session, re-armed after it improves.  System notification when the 5H
  // runway drops under 30 minutes, once per window across all sessions.
  const runAlerts = async (io: IO, v: View, now: number) => {
    if (!sid) return
    const d = derive(v, await io.lastReply(), now)
    if (!alerts) {
      alerts = ((await io.get(`alerts:${sid}`).catch(() => null)) as AlertState | null) ?? { prev: { cost: 0, detail: 0 }, fired: { cost: [], detail: [] } }
    }
    let changed = false
    if (!alerts.below) alerts.below = { cost: {}, detail: {} }
    for (const [name, p] of [['cost', d.cost], ['detail', d.detail]] as const) {
      const fired = alerts.fired[name]
      const below = alerts.below[name]
      // When the pill first went under each toasted level; back at or over it clears that.
      for (const x of fired) {
        if (p.lvl >= x) { if (below[x] !== undefined) { delete below[x]; changed = true } }
        else if (below[x] === undefined) { below[x] = now; changed = true }
      }
      // a level re-arms once the pill has stayed under it for REARM_MS
      const kept = fired.filter(x => below[x] === undefined || now - below[x]! < REARM_MS)
      for (const x of fired) if (!kept.includes(x)) delete below[x]
      if (kept.length !== fired.length) { alerts.fired[name] = kept; changed = true }
      if (p.lvl >= 2 && p.lvl > alerts.prev[name] && !alerts.fired[name].includes(p.lvl)) {
        io.toast(`${name === 'cost' ? 'Cost' : 'Context'}: ${p.label}. ${p.why.charAt(0).toUpperCase()}${p.why.slice(1)}.`)
        alerts.fired[name].push(p.lvl)
        changed = true
      }
      if (alerts.prev[name] !== p.lvl) { alerts.prev[name] = p.lvl; changed = true }
    }
    if (changed) await save(io, `alerts:${sid}`, alerts, now)

    const w5 = d.w5
    if (w5 && w5.resetsAt) {
      const rw = d.runway(w5)
      if (rw.bad && rw.leftMs <= WALL_MS) {
        // Claimed across sessions in one locked step (scan.py --claim), so two
        // sessions can't both see "not sent yet" and both notify.  wallSent
        // keeps this session from asking again for the same window.
        if (wallSent !== w5.resetsAt) {
          wallSent = w5.resetsAt
          const won = await io.scan([`--claim=wall5h|${w5.resetsAt}`], '{}', 15000)
            .then(r => r.exitCode === 0 && JSON.parse(r.stdout).claimed === true).catch(() => false)
          if (!won) return
          const resets = clock(Date.parse(w5.resetsAt))
          const text = rw.leftMs <= 0 ? `5H limit reached (resets ${resets}).` : `5H runs out in ~${dur(rw.leftMs)} at this pace (resets ${resets}).`
          io.toast(text)
          const how = await wallNotify(io, text)
          await save(io, 'wall5hHow', { at: now, how }, now)
        }
      }
    }
  }

  // Drop saved entries of sessions not seen for a week (and all but the
  // newest 40), so the store stays well under its 4 MiB cap.  Runs BEFORE a
  // refresh writes anything (a nearly full store would otherwise refuse the
  // write and never get here), and again whenever a write is refused.
  const prune = async (io: IO, nowMs: number) => {
    try {
      const keys = await io.keys()
      const ses: { id: string; at: number }[] = []
      for (const k of keys.filter(k => k.startsWith('ses:'))) {
        const e = (await io.get(k)) as { at?: number } | undefined
        ses.push({ id: k.slice(4), at: e?.at ?? 0 })
      }
      ses.sort((a, b) => b.at - a.at)
      const keep = new Set(ses.filter((e, i) => i < MAX_SESSIONS && e.at * 1000 >= nowMs - KEEP_SESSION_MS).map(e => e.id))
      if (sid) keep.add(sid)
      for (const k of keys) {
        const m = /^(ses|alerts):(.+)$/.exec(k)
        if (m && !keep.has(m[2]!)) await io.del(k)
      }
    } catch { /* pruning is best effort */ }
  }
  // A store write that is refused (store full) prunes and tries once more.
  // Refused again, it gives up quietly and says so (false), so a full store
  // never fails the whole refresh: the band still draws from this scan, and
  // what was not kept comes back (the ledger is rebuilt from transcripts,
  // the rest is rewritten on the next refresh).  `storeFull` puts a note on
  // the band until a write goes through again.
  const save = async (io: IO, k: string, val: unknown, nowMs: number): Promise<boolean> => {
    try { await io.set(k, val); return true } catch { /* full: prune, then once more */ }
    await prune(io, nowMs)
    try { await io.set(k, val); storeFull = false; return true } catch { storeFull = true; return false }
  }

  // Reads local files and runs a script: zero tokens, no model call.
  const refresh = async (io: IO) => {
    // One at a time.  A request that arrives mid-scan (a reply landing while
    // the timer's scan runs) re-runs straight after it, so the band never
    // waits for the next 30 s tick to show the finished turn.
    if (busy) { again = true; return }
    busy = true
    spinning = true
    await io.show(v => (v ? { ...v, refreshing: true } : v))
    try {
      // `/clear` starts a new conversation under a new session id without a
      // new session.start, so the id is read again on every refresh.
      const cur = await io.id().catch(() => sid)
      if (cur && cur !== sid) { sid = cur; alerts = undefined }
      const usage = await io.usage()
      const model = await io.model().catch(() => '')
      const ctx = usage.context?.tokens ? { tokens: usage.context.tokens as number, window: (usage.context.window as number) || 0, percent: usage.context.percent as number | undefined } : undefined
      const nowMs = await io.now()
      const now = Math.floor(nowMs / 1000)
      if (nowMs - pruned > 3600e3) { pruned = nowMs; await prune(io, nowMs) }
      // Claude Code's own auto-compact trigger, re-read every 10 minutes
      // (a local estimate: it sends nothing).
      if (nowMs - compactAtRead > 600000) {
        compactAtRead = nowMs
        try {
          const b = (await io.usageBreak())?.context?.breakdown
          if (b && b.isAutoCompactEnabled === false) { compactOff = true; compactAt = undefined }
          else if (b) { compactOff = false; if (b.autoCompactThreshold) compactAt = b.autoCompactThreshold }
        } catch { /* keep the last figure */ }
      }
      const limits = ((usage.rateLimits ?? []) as { kind: string; percentUsed: number; resetsAt?: string }[]).filter(r => SPAN[r.kind])
      if (limits.length === 0) {
        await io.show(v => ({ ...(v ?? { samples: [], updatedAt: now }), wins: [], updatedAt: now, ctx, model, refreshing: false, error: 'No limit data yet (needs a subscription session with a reply sent).' } as View))
        return
      }
      const starts = limits.map(r => (r.resetsAt ? Math.floor(Date.parse(r.resetsAt) / 1000) - (SPAN[r.kind] ?? 0) : now - (SPAN[r.kind] ?? 0)))
      const i5 = limits.findIndex(r => r.kind === 'five_hour')
      // The tick log ("at X% the window held Y units", shared by every open
      // session) lives in a file that scan.py changes only under a file lock,
      // so parallel sessions never overwrite each other's readings.  The
      // store's old copy only seeds that file once, then is removed.
      const oldSamples = ((await io.get('samples').catch(() => undefined)) ?? []) as Sample[]
      let ledger = ((await io.get('ledger')) ?? []) as LedgerRow[]
      const args = [
        ...starts.map(String),
        ...(i5 >= 0 ? [`--since5h=${starts[i5]}`] : []),
        ...(sid ? [`--session-id=${sid}`] : []),
        ...(model ? [`--model=${model}`] : []),
        ...limits.map(r => `--reading=${r.kind}|${r.resetsAt ?? ''}|${r.percentUsed}`),
        `--now=${nowMs / 1000}`, // to the fraction of a second: see scan.py
        `--busy=${turnRunning ? 1 : 0}`,
      ]
      const run = await io.scan(args, JSON.stringify({ samples: oldSamples, ledger }))
      if (run.exitCode !== 0) throw new Error(run.stderr.slice(-300))
      const sums = JSON.parse(run.stdout)
      const samples = clean((sums._samples ?? oldSamples) as Sample[])
      if (sums._samplesFile && oldSamples.length) await io.del('samples').catch(() => undefined)
      // The ledger stays in the store.  Its rows are rebuilt from transcripts,
      // so a row lost to a parallel write comes back on the next scan.
      // Rebuilt rows (made with an older rule) replace the old ones.
      if (Array.isArray(sums._ledgerNew) && sums._ledgerNew.length) {
        ledger = ((await io.get('ledger')) ?? []) as LedgerRow[]
        const fresh = new Map((sums._ledgerNew as LedgerRow[]).map(r => [`${r.kind}|${r.resetsAt}`, r]))
        ledger = [...ledger.filter(r => !fresh.has(`${r.kind}|${r.resetsAt}`)), ...fresh.values()].slice(-MAX_LEDGER)
        await save(io, 'ledger', ledger, nowMs)
      }
      // A session can report a stale percent (the meter moved in another
      // session it has not heard of yet).  Use the highest reading any session
      // has logged for the same window.
      const wins: Win[] = limits.map((r, i) => {
        const seen = samples.filter(s => s.kind === r.kind && s.resetsAt === r.resetsAt).reduce((m, s) => Math.max(m, s.pct), -1)
        return { kind: r.kind, pct: Math.max(r.percentUsed, seen), resetsAt: r.resetsAt, tokens: sums[String(starts[i])] ?? NO_TOKENS }
      })
      // % of the 5H limit per work unit: trusted from 3% into the window,
      // carried over from the last window before that.
      const w5 = wins.find(w => w.kind === 'five_hour')
      // 'rate-opus': the rate in work units measured against Opus (0.7.7).
      // A rate saved under the old ruler ('rate') is left unused, or costs
      // would read about 27% high until this window reached 8%.
      const saved = (await io.get('rate-opus').catch(() => undefined)) as number | undefined
      // Only the points the work here moved: points moved elsewhere (cloud,
      // chat, phone) are in the meter but not in the work, and would make
      // every cost on the band read high (a window run to 30% in the cloud
      // and 35% in all would price each turn here 7x).
      // scan.py's _rate5 counts the work only up to the newest reading (work
      // after it has not shown on the meter yet, and made costs read low).
      const fresh5 = typeof sums._rate5 === 'number' && sums._rate5 > 0 ? (sums._rate5 as number) : undefined
      const rate = fresh5 ?? saved
      if (fresh5 && fresh5 !== saved) await save(io, 'rate-opus', fresh5, nowMs)
      const nv: View = {
        wins, samples, updatedAt: now, ctx, model, rate,
        // auto-compact switched off: no trigger point, so no "auto-compact in N turns"
        compactAt: compactOff ? undefined : compactAt || sums._compactAt || undefined,
        session: sums._session ?? undefined, weights: sums._weights, long: sums._long, handoff: sums._handoff,
        fit: sums._fit, check: sums._check as Check | null, ledgerCount: ledger.length,
        unpriced: sums._unpriced, history: sums._history, byTime: sums._byTime ?? undefined, limitSize: sums._limitSize ?? undefined, limitMix: sums._limitMix ?? undefined,
      }
      await io.show(() => nv)
      // The History pane's copy: first time, when the older days arrive, or
      // every 5 minutes at most (see histAtom).
      const full = !!nv.history?.full
      if (!histAt || (full && !histFull) || nowMs - histAt >= HIST_EVERY_MS) {
        histAt = nowMs
        histFull = full
        await io.hist(() => nv)
      }
      // So the next session (and this one after a reload) can draw at once.
      // Written when a meter moves or a window resets, else every 5 minutes at
      // most: it holds the History days too, and was rewritten on every refresh.
      const lastKey = wins.map(w => `${w.kind}|${w.resetsAt}|${w.pct}`).join(',')
      if (lastKey !== lastSavedKey || nowMs - lastSavedAt >= HIST_EVERY_MS) {
        const curSamples = samples.filter(s => wins.some(w => w.kind === s.kind && w.resetsAt === s.resetsAt))
        if (await save(io, 'last', { ...nv, samples: curSamples, session: undefined }, nowMs)) { lastSavedKey = lastKey; lastSavedAt = nowMs }
      }
      if (sid) await save(io, `ses:${sid}`, { session: nv.session, at: now }, nowMs)
      await runAlerts(io, nv, nowMs)
      // The band is up to date, but not everything was kept (see save).
      if (storeFull) await io.show(v => (v ? { ...v, error: 'Mana Pool storage is full. Some numbers were not saved.' } : v))
      // Older days of the History pane: read every transcript once, in the
      // background (a few seconds), then refresh to show them.
      // One at a time across sessions, with a growing wait after a failure:
      // scan.py keeps both (backfill.lock, backfill.json) and reports when the
      // next try may start, so no process is started just to hear "not yet".
      const bfNext = Number(sums._backfillNext) || 0
      if (nv.history && !nv.history.full && !backfilling && bfNext <= now && nowMs >= bfRetryAt) {
        backfilling = true
        void io.scan(['--backfill'], '{}', 600000)
          .then(r => {
            backfilling = false
            let said: unknown
            try { said = JSON.parse(r.stdout).backfill } catch { /* failed: no answer */ }
            // A count: done (the next scan sees the history full).  "busy":
            // another session holds the lock; look again in 2 minutes, in
            // case that session closes before it finishes.  "wait" or a
            // failure: scan.py's back-off (_backfillNext) holds it off.
            if (typeof said === 'number') dirty = true
            else if (said === 'busy') bfRetryAt = nowMs + 120000
          })
          .catch(() => { backfilling = false })
      }
    } catch (err) {
      await io.show(v => ({ ...(v ?? { wins: [], samples: [], updatedAt: 0 }), refreshing: false, error: String(err) } as View))
    } finally {
      busy = false
      spinning = false
      if (again) { again = false; void refresh(io) }
    }
  }

  on('session.start', async ($, e, next) => {
    // A failure here must not stop the band loading.
    await $.command.register({ name: CMD, description: 'Mana Pool: limit runway, turn cost, hand-off advice and the limit audit' }).catch(() => undefined)
    sid = await $.session.id().catch(() => '')
    alerts = undefined
    // The version shown next to the title comes from plugin.json, so it can't drift.
    try { version = String(JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))).version ?? '') } catch { /* no label */ }
    // Load stamp: which build is running, so a reload can be confirmed from the store.
    await $.store.set('loaded', { build: BUILD, at: await $.clock.now() } as any).catch(() => undefined)
    const io: IO = {
      usage: () => $.session.usage(),
      usageBreak: () => $.session.usage({ breakdown: 'summary' }),
      model: () => $.session.model(),
      now: () => $.clock.now(),
      scan: async (args, stdin, timeoutMs = 120000) => {
        if (!py) {
          for (const cand of [['python3'], ['py', '-3'], ['python']]) {
            try {
              const r = await $.process.run([...cand, '-c', 'import sys; print(sys.version_info[0])'], { timeoutMs: 15000 })
              if (r.exitCode === 0 && r.stdout.trim() === '3') { py = cand; break }
            } catch { /* not installed: try the next */ }
          }
          if (!py) throw new Error('Python 3 not found (tried python3, py -3, python).')
        }
        // --plugin: scan.py keeps its files in <Claude config>/plugins/data/<name>
        return $.process.run([...py, `${$.plugin.root}/hooks/scan.py`, `--plugin=${$.plugin.name}`, ...args], { stdin, timeoutMs })
      },
      get: k => $.store.get(k),
      set: (k, val) => $.store.set(k, val as any),
      keys: () => $.store.keys(),
      del: k => $.store.delete(k),
      id: () => $.session.id(),
      show: fn => update($, view, fn as any).then(() => undefined),
      hist: fn => update($, histAtom, fn as any).then(() => undefined),
      toast: text => $.ui.toast(`Mana Pool · ${text}`, { timeoutMs: 8000 }),
      notify: text => $.ui.notify(text, { title: 'Mana Pool' }),
      // macOS's own notification; the text is ours (numbers and fixed words), quotes stripped anyway
      osa: text => $.process.run(['osascript', '-e', `display notification "${text.replace(/["\\]/g, '')}" with title "Mana Pool"`], { timeoutMs: 10000 }),
      lastReply: () => read($, lastReply),
    }
    ioRef = io

    // One timer drives it all: events only raise `dirty`; every 30 s it does a
    // full refresh (when dirty or 2 minutes old) or just redraws the clocks.
    $.clock.every(30000, async () => {
      if (!started) return // never drawn: a headless run
      const t = await $.clock.now()
      // a refresh is already on its way (soon): don't start a second one
      if (pending) return
      if (dirty || t - lastFull > 120000) {
        dirty = false
        lastFull = t
        await refresh(io)
      } else {
        await update($, view, v => (v ? { ...v, updatedAt: Math.floor(t / 1000) } : v) as any)
      }
    })
    // turns the spinner while a refresh is pending
    $.clock.every(160, async () => {
      // The first refresh, a moment after the first draw (see `started`).
      if (started && !kicked) {
        kicked = true
        dirty = false
        lastFull = await $.clock.now()
        void refresh(io)
      }
      if (!spinning) return
      await update($, spinAtom, f => ((f ?? 0) + 1) % 10)
    })
    // Draw at once from the last saved numbers (this session's own turns when
    // it has run before), then the first real refresh replaces them.
    spinning = true
    try {
      const last = (await $.store.get('last')) as View | undefined
      const mine = sid ? ((await $.store.get(`ses:${sid}`)) as { session?: Session } | undefined) : undefined
      const samples = clean((last?.samples?.length ? last.samples : ((await $.store.get('samples')) ?? [])) as Sample[])
      await update($, view, () => (last && last.wins?.length
        ? { ...last, samples, session: mine?.session, refreshing: true }
        : { wins: [], samples, updatedAt: 0, refreshing: true }) as any)
      // The History pane draws from the saved numbers too until the first refresh.
      if (last && last.wins?.length) await update($, histAtom, () => ({ ...last, samples, session: mine?.session }) as any)
    } catch { /* nothing saved yet */ }
    if (e.isInteractive) started = true
    return next(e)
  })

  on('command.run', { command: CMD }, async ($, e) => {
    started = true
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'export') {
      const ledger = ((await $.store.get('ledger')) ?? []) as LedgerRow[]
      // scan.py expands the ~ and writes the file (local only)
      if (!ioRef) return { text: 'Not ready yet. Send a message first.' }
      const r = await ioRef.scan(['--export=~/Documents/Mana Pool/manapool-ledger.csv'], JSON.stringify({ ledger }))
      if (r.exitCode !== 0) return { text: `Export failed: ${r.stderr.slice(-300)}` }
      let path = '~/Documents/Mana Pool/manapool-ledger.csv'
      try { path = JSON.parse(r.stdout).exported ?? path } catch { /* keep the short form */ }
      return { text: `Ledger written: ${path} (${ledger.length} windows).` }
    }
    if (arg === 'history') {
      await $.ui.open({ id: HPANE, title: 'Mana Pool History' })
      return { text: 'History opened.' }
    }
    if (arg === 'test-notify') {
      const how = ioRef ? await wallNotify(ioRef, 'Test from Mana Pool.') : 'not ready'
      return { text: `Test notification sent through: ${how}.` }
    }
    await $.ui.open({ id: PANE, title: 'Mana Pool' })
    dirty = true
    const v = await read($, view)
    const last = (await read($, lastReply)) ?? (v?.session?.lastSeen ? v.session.lastSeen * 1000 : null)
    if (!v || v.wins.length === 0) return { text: 'No limit data yet. Send a message first.' }
    return { text: summaryText(v, last, await $.clock.now()) }
  // A thrown error here would leave the command unanswered (the validator
  // flags a command hook with no handler): answer with a plain line instead.
  }).catch(() => ({ text: 'Mana Pool could not answer. Try again in a moment.' }))

  // `/clear` ends this conversation and the process goes on under a new
  // session id (no new session.start).  The old reply time and turn history
  // belong to the old conversation, so forget them and re-read at once; the
  // refresh picks up the new id.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      turnRunning = false
      alerts = undefined
      await update($, lastReply, () => null).catch(() => undefined)
      await update($, busyAtom, () => false).catch(() => undefined)
      await update($, view, v => (v ? { ...v, session: undefined } : v) as any).catch(() => undefined)
      dirty = true
      soon(ms => $.clock.sleep(ms), () => $.clock.now())
    }
    return next(e)
  })

  // A limit moved a whole point, or the context changed: refresh soon, but
  // not more than once every MIN_GAP_MS.  During a long agentic turn this
  // event fires every few seconds, and each scan reads every transcript;
  // within the gap it only marks the numbers stale, and the 30 s timer (or
  // the end of the turn) picks them up.
  on('session.measure', async ($, e, next) => {
    dirty = true
    if ((await $.clock.now()) - lastFull >= MIN_GAP_MS) soon(ms => $.clock.sleep(ms), () => $.clock.now())
    return next(e)
  })

  // Your turn started (not a subagent's): the newest turn is running.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnRunning = true
      await update($, busyAtom, () => true)
    }
    return next(e)
  })

  // Your turn ended: the prompt cache clock restarts here.  A subagent's end
  // is not your reply, so it does not touch the clock.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnRunning = false
      const t = await $.clock.now()
      await update($, lastReply, () => t)
      await update($, busyAtom, () => false)
      dirty = true
      soon(ms => $.clock.sleep(ms), () => $.clock.now())
    }
    return next(e)
  })

  // The band above the prompt: Full (detail) or Mini (one line).
  // Keep this hook inline: a named hook function taking `$` stopped the
  // module loading (2026-11-06), the same trap as passing `$` to a helper.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    started = true
    const v = await read($, view)
    if (e.props.hasSurvey || !v) return next(e)
    const { Box, Text, Button, Svg: SvgEl } = $.ui.resolve(e) as any
    // The terminal's table has an Svg that draws nothing there, so treat the
    // terminal as having none: it gets the block bars and text lines instead.
    const Svg = e.surface === 'terminal' ? undefined : SvgEl
    const FR = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    const frame = (await read($, spinAtom)) ?? 0
    if (v.wins.length === 0) {
      // A failed first read used to leave the band hidden: show why instead.
      if (!v.refreshing && v.error) return (
        <Box paddingX={1}>
          <Text size="body" weight="semibold">Mana Pool</Text>
          <Text size="caption" color={v.error.startsWith('No limit data') ? DIM : RED} wrap="truncate">  {v.error.slice(0, 160)}</Text>
        </Box>
      )
      if (!v.refreshing) return next(e)
      return (
        <Box paddingX={1}>
          <Text size="body" weight="semibold">Mana Pool</Text>
          <Text size="caption" dimColor>  {FR[frame % 10]}  reading your transcripts…</Text>
        </Box>
      )
    }
    const m = await read($, mode)
    const last = (await read($, lastReply)) ?? (v.session?.lastSeen ? v.session.lastSeen * 1000 : null)
    const now = Date.now()
    const d = derive(v, last, now)
    const wins = [d.w7, d.w5].filter(Boolean) as Win[]
    const tag = (w: Win) => (w.kind === 'five_hour' ? '5H' : '7D')
    const lab = { size: 'footnote', dimColor: true } as any
    const note = { size: 'footnote', dimColor: true } as any
    const spin = () => (v.refreshing ? <Text {...note}>  {FR[frame % 10]}</Text> : null)
    const icon = (glyph: string, name: string, onPress: () => void) => <Button key={name} label={glyph} plain dimColor onPress={onPress} />
    const openManual = () => $.ui.open({ id: PANE, title: 'Mana Pool' })
    const openHistory = () => $.ui.open({ id: HPANE, title: 'Mana Pool History' })
    const P = (u: number) => (d.ok ? pctTxt(d.pc(u)) : '—')
    // The band's width in cells, and a rough width for a run of footnote text:
    // one cell per character in a terminal; the desktop's proportional type
    // is narrower (about 0.75 of a cell).  Used to drop or shorten parts that
    // would otherwise push the buttons off the right edge or wrap a row.
    const cols = (e.props.bodyColumns as number) || 90
    const tw = (s: string) => s.length * (Svg ? 0.72 : 1) // measured: 6.3 px a character at footnote size on the desktop
    const ICONS_W = 9 // the three icon buttons (about 80 px on the desktop)

    // A usage bar: rounded gradient on graphical surfaces, flat blocks in a terminal.
    const bar = (frac: number, W: number, H: number, uid: string) => {
      const f = Math.max(0, Math.min(1, frac))
      const tip = tipOk(f * 100)
      const from = hexOk(shiftStart(tip)), to = hexOk(shiftEnd(tip))
      const track = mix(SURFACE, hexOk(tip), 0.24)
      if (Svg) {
        const px = f <= 0 ? 0 : Math.max(H, f * W)
        const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
          `<defs><linearGradient id="${uid}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
          `<rect width="${W}" height="${H}" rx="${H / 2}" fill="${track}"/>` +
          (px > 0 ? `<rect width="${px}" height="${H}" rx="${H / 2}" fill="url(#${uid})"/>` : '') + `</svg>`
        return <Svg source={src} alt={`${Math.round(f * 100)}%`} width={W} height={H} />
      }
      const K = 20, pct = Math.round(f * 100), slices = []
      for (let i = 0; i < K; i++) {
        const width = Math.round((pct * (i + 1)) / K) - Math.round((pct * i) / K)
        if (width > 0) slices.push(<Box key={i} width={`${width}%`} height={1} backgroundColor={mix(from, to, i / (K - 1))} />)
      }
      return (
        <Box width="100%" height={1}>
          {slices}
          {pct < 100 && <Box width={`${100 - pct}%`} height={1} backgroundColor={track} />}
        </Box>
      )
    }
    // Mini's bar: the percent drawn inside it, split where the fill ends (dark
    // text over the fill, light over the empty track: 5.5:1 or better in every
    // colour).  The terminal has no Svg: there it is the flat bar plus the number.
    const barIn = (frac: number, label: string, W: number, H: number, uid: string) => {
      const f = Math.max(0, Math.min(1, frac))
      const tip = tipOk(f * 100)
      const from = hexOk(shiftStart(tip)), to = hexOk(shiftEnd(tip))
      const track = mix(SURFACE, hexOk(tip), 0.24)
      if (!Svg) return <Box flexShrink={0}><Box width={8}>{bar(f, W, H, uid)}</Box><Text size="footnote" tabular color={tone(f * 100)}> {label}</Text></Box>
      const px = f <= 0 ? 0 : Math.max(H / 2, f * W)
      const ty = Math.round(H / 2 + 4)
      const txt = (fill: string, clip: string) =>
        `<text x="${W / 2}" y="${ty}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" font-size="12" font-weight="500" fill="${fill}" clip-path="url(#${clip})">${esc(label)}</text>`
      const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
        `<defs><linearGradient id="${uid}g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>` +
        `<clipPath id="${uid}r"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath>` +
        `<clipPath id="${uid}f"><rect width="${px}" height="${H}"/></clipPath><clipPath id="${uid}e"><rect x="${px}" width="${Math.max(0, W - px)}" height="${H}"/></clipPath></defs>` +
        `<g clip-path="url(#${uid}r)"><rect width="${W}" height="${H}" fill="${track}"/>${px > 0 ? `<rect width="${px}" height="${H}" fill="url(#${uid}g)"/>` : ''}</g>` +
        txt('#1d1d1d', `${uid}f`) + txt(INK, `${uid}e`) + `</svg>`
      return <Box width={Math.ceil(W / 8.8)} flexShrink={0}><Svg source={src} alt={label} width={W} height={H} /></Box>
    }

    // The 5H ring: the meter as a 16 px donut.  Mini draws it in place of the
    // bar while the limit would run out, so the percent and "out in" fit
    // beside it in about the space the bar alone took.
    const ring = (frac: number, uid: string, S = 16) => {
      const f = Math.max(0, Math.min(1, frac)), tip = tipOk(f * 100)
      const r = (S - 3) / 2, c = 2 * Math.PI * r, m = S / 2
      const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">` +
        `<circle cx="${m}" cy="${m}" r="${r}" fill="none" stroke="${mix(SURFACE, hexOk(tip), 0.24)}" stroke-width="3"/>` +
        (f > 0 ? `<circle cx="${m}" cy="${m}" r="${r}" fill="none" stroke="${hexOk(shiftEnd(tip))}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${m} ${m})"/>` : '') +
        `</svg>`
      return <Box key={uid} width={Math.ceil(S / 8.8)} flexShrink={0}><Svg source={src} alt={`${Math.round(f * 100)}%`} width={S} height={S} /></Box>
    }

    // A verdict pill, Runenir's badge: a 14% tint of the level colour, a 1 px
    // edge at 35%, and the words in main text (APCA Lc 87+ at every level).
    // outline: Mini's pill also carries the level in its border, only when
    // something needs attention: dotted for amber, dashed for red.  Green and
    // blue keep the faint badge edge so a calm state stays quiet.
    // W: a fixed width (Mini's pill matches its bars); otherwise sized to the label.
    // right: the pill ends at its box's right edge (its box is rounded up to
    // whole cells, so a left-aligned pill would stop a few pixels short).
    const pill = (p: Pill, uid: string, outline = false, H = 20, W = 0, right = false) => {
      const col = LVL[p.lvl] ?? LVL[0]! // a level is always 0 to 3
      if (Svg) {
        const wpx = W || Math.round(p.label.length * 6.9 + 22)
        const ty = Math.round(H / 2 + 4) // text baseline, centred for 12 px type
        const dash = p.lvl === 2 ? ' stroke-dasharray="0.1 3.2" stroke-linecap="round"' : p.lvl === 3 ? ' stroke-dasharray="5 3"' : ''
        const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wpx} ${H}" width="${wpx}" height="${H}">` +
          `<rect width="${wpx}" height="${H}" rx="${H / 2}" fill="${mix(SURFACE, col, 0.14)}"/>` +
          (outline && p.lvl >= 2 ? `<rect x="0.75" y="0.75" width="${wpx - 1.5}" height="${H - 1.5}" rx="${(H - 1.5) / 2}" fill="none" stroke="${col}" stroke-width="1.5"${dash}/>`
            // Runenir badge: a 1 px edge at 35% of the level colour.
            : `<rect x="0.5" y="0.5" width="${wpx - 1}" height="${H - 1}" rx="${(H - 1) / 2}" fill="none" stroke="${mix(SURFACE, col, 0.35)}"/>`) +
          `<text x="${wpx / 2}" y="${ty}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" font-size="12" fill="${INK}">${esc(p.label)}</text></svg>`
        return <Box key={uid} width={Math.ceil(wpx / 8.8)} flexShrink={0} justifyContent={right ? 'flex-end' : 'flex-start'}><Svg source={src} alt={p.label} width={wpx} height={H} /></Box>
      }
      return <Text key={uid}><Text color={col}>[</Text>{p.label}<Text color={col}>]</Text></Text>
    }

    // MINI: one line.  Bars, the 5H runway when it runs out, the last turn, the worst pill.
    if (m === 'mini') {
      // One scale for the whole line: every label and value is footnote size
      // (labels grey, values coloured), each group is "label value" with one
      // space, two cells between groups; the bars and the pill are sized to
      // one text line: bars (percent inside) and the pill share one size.
      const MINI_W = 92
      const rw5 = d.w5 ? d.runway(d.w5) : null
      const ft = { size: 'footnote', tabular: true, wrap: 'truncate' } as any
      // While 5H would run out, its bar turns into a ring with the percent and
      // "out in" beside it (desktop and phone; the terminal has no Svg and
      // keeps the bar).  That warning then costs about the bar's own width.
      // Fit the line to the band.  Each group's width is estimated in cells;
      // if the line would still push the buttons off the right edge, groups
      // drop in order of least use: Cache, then Last turn, then the 7D bar,
      // and last "runs out in" shortens to "out in".  The 5H meter always stays.
      const barCells = Svg ? MINI_W / 8.8 : Math.ceil(MINI_W / 8.8)
      const ringMode = !!Svg && !!rw5?.bad
      const runTxt = (short: boolean) => (!rw5?.bad ? '' : rw5.leftMs <= 0 ? ' limit reached' : `${short ? ' out in' : ' runs out in'} ${dur(rw5.leftMs)}`)
      const ringTxt = (w: Win) => `${d.est(w).toFixed(1)}%`
      const cacheTxt = d.idle === null ? '' : d.warm ? dur(TTL_MS - d.idle) : d.otherModel ? 'Cold' : 'Expired'
      // Points of 5H moved elsewhere (cloud, chat, phone): shown whenever above 0.
      const elseN = v.check?.outside ?? 0
      const elseTxt = `${elseN}%`
      const winCells = (w: Win, short: boolean) => 2 + tw(`${tag(w)} `) + (
        w.kind !== 'five_hour' ? barCells
          : ringMode ? 2 + tw(`${ringTxt(w)} ·${runTxt(true)}`)
            : barCells + tw(runTxt(short)))
      const fit = { cache: d.idle !== null, away: elseN > 0, last: !!d.lt, w7: true, short: false }
      const need = () =>
        tw('Mana Pool') + (v.refreshing ? 3 : 0) +
        wins.reduce((n, w) => n + (w.kind === 'seven_day' && !fit.w7 ? 0 : winCells(w, fit.short)), 0) +
        (fit.away ? 2 + tw(`Elsewhere ${elseTxt}`) : 0) +
        (fit.last ? 2 + tw('Last turn ') + barCells : 0) +
        (fit.cache ? 2 + tw(`Cache ${cacheTxt}`) : 0)
      const room = cols - 2 - ICONS_W - 1 // one cell spare: the estimate is close, not exact
      for (const k of ['cache', 'away', 'last', 'w7'] as const) if (need() > room) fit[k] = false
      if (need() > room) fit.short = true
      return (
        <Box paddingX={1} justifyContent="space-between" alignItems="center">
          <Box alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
            <Box flexShrink={0}><Text size="footnote" weight="semibold" wrap="truncate">Mana Pool</Text>{spin()}</Box>
            {wins.filter(w => w.kind !== 'seven_day' || fit.w7).map(w => (
              <Box key={w.kind} marginLeft={2} flexShrink={0} alignItems="center">
                <Text {...lab} wrap="truncate">{tag(w)} </Text>
                {w.kind === 'five_hour' && ringMode
                  ? <Box alignItems="center" flexShrink={0}>
                      {ring(d.est(w) / 100, `r${w.kind}`)}
                      <Text {...ft} weight="medium" color={tone(d.est(w))}> {ringTxt(w)}</Text>
                      <Text {...ft} color={RED}> ·{runTxt(true)}</Text>
                    </Box>
                  : barIn(d.est(w) / 100, `${d.est(w).toFixed(1)}%`, MINI_W, 16, `m${w.kind}`)}
                {w.kind === 'five_hour' && rw5?.bad && !ringMode ? <Text {...ft} color={RED}>{runTxt(fit.short)}</Text> : null}
              </Box>
            ))}
            {/* Elsewhere: points of 5H moved with no work on this computer. */}
            {fit.away ? (
              <Box marginLeft={2} flexShrink={0} alignItems="center">
                <Text {...lab} wrap="truncate">Elsewhere </Text>
                <Text {...ft} color={RED}>{elseTxt}</Text>
              </Box>
            ) : null}
            {/* The last turn: grey label, then a pill coloured by the worse of
                Cost and Context; a dotted (amber) or dashed (red) border marks a warning. */}
            {d.lt && fit.last ? (
              <Box marginLeft={2} flexShrink={0} alignItems="center">
                <Text {...lab} wrap="truncate">Last turn </Text>
                {pill({ ...d.worst, label: `${P(d.lt.u)} · ${d.ratio.toFixed(1)}x` }, 'mini', true, 16, MINI_W)}
              </Box>
            ) : null}
            {/* Prompt cache clock: minutes until it expires (after that the next
                message pays a one-time cache write), or Expired. */}
            {d.idle !== null && fit.cache ? (
              <Box marginLeft={2} flexShrink={0} alignItems="center">
                <Text {...lab} wrap="truncate">Cache </Text>
                <Text {...ft} color={d.warm ? WARM : COLD}>{cacheTxt}</Text>
              </Box>
            ) : null}
          </Box>
          <Box alignItems="center" flexShrink={0}>
            {icon('▤', 'History', openHistory)}
            {icon('ⓘ', 'Manual', openManual)}
            <Box>{icon('⊕', 'Expand', () => update($, mode, () => 'full'))}</Box>
          </Box>
        </Box>
      )
    }

    // FULL
    // One text size for every row (footnote, as in Mini): labels grey, values
    // plain or coloured.  Mixed sizes made each row a different height.
    const fn = { size: 'footnote', dimColor: true } as any
    const LABW = 14 // label column, in cells
    const Lab = (t: string) => <Box width={LABW} flexShrink={0}><Text {...lab}>{t}</Text></Box>
    const share = d.ses?.share1h
    const paceTxt = (w: Win, r: number) => (r <= 0 ? '' : w.kind === 'five_hour' ? `pace ~${r.toFixed(1)}%/h` : `pace ~${(r * 24).toFixed(1)}%/day`)

    // The turn strip, one text row high: whole session, the 5H window start
    // marked, older turns dimmed.  Grey = re-reading history, violet = new work.
    const strip = () => {
      const all = d.turns.slice(-60)
      if (all.length === 0) return null
      const since = d.w5?.resetsAt ? Date.parse(d.w5.resetsAt) / 1000 - SPAN.five_hour : 0
      const top = Math.max(...all.map(t => t.u), 1)
      const BW = 6, GAP = 2, HT = 16
      const markAt = all.findIndex(t => t.t >= since)
      const hasMark = markAt > 0
      const wpx = all.length * (BW + GAP) + (hasMark ? 5 : 0)
      if (Svg) {
        let x = 0, body = ''
        all.forEach((t, i) => {
          if (hasMark && i === markAt) { body += `<rect x="${x + 1}" y="0" width="1" height="${HT}" fill="${DIM}"/>`; x += 5 }
          const tot = Math.max(2, (t.u / top) * HT)
          const hist = Math.min(tot, (t.h / top) * HT)
          const op = t.live ? 0.55 : t.t < since ? 0.4 : 1
          body += `<clipPath id="c${i}"><rect x="${x}" y="${HT - tot}" width="${BW}" height="${tot}" rx="2"/></clipPath>` +
            `<g clip-path="url(#c${i})" opacity="${op}"><rect x="${x}" y="${HT - tot}" width="${BW}" height="${tot}" fill="${ME}"/>` +
            (hist > 0 ? `<rect x="${x}" y="${HT - hist}" width="${BW}" height="${hist}" fill="${HIST}"/>` : '') + `</g>`
          x += BW + GAP
        })
        const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wpx} ${HT}" width="${wpx}" height="${HT}">${body}</svg>`
        return <Box width={Math.ceil(wpx / 8.8) + 1} flexShrink={0}><Svg source={src} alt={`${all.length} turns, newest on the right`} width={wpx} height={HT} /></Box>
      }
      const BL = '▁▂▃▄▅▆▇█'
      return <Text>{all.map((t, i) => <Text key={i} color={t.h > t.u / 2 ? HIST : ME} dimColor={t.t < since}>{BL[Math.min(7, Math.floor((t.u / top) * 7.99))]}</Text>)}<Text> </Text></Text>
    }

    const chk = v.check
    const showChk = !!chk && chk.lo !== null && chk.hi !== null && chk.per1 !== null && (chk.herePct ?? chk.pct) >= 5
    // Limit check in words: how much work 1% of 5H buys now against your usual
    // (the middle of your past windows).  Unit counts stay in the ledger.
    const chkMid = showChk ? ((chk!.lo as number) + (chk!.hi as number)) / 2 : 0
    const chkDelta = showChk && chkMid > 0 ? (chk!.per1 as number) / chkMid - 1 : 0
    const chkLow = showChk && chkDelta <= -0.15
    const chkPct = Math.round(Math.abs(chkDelta) * 100)
    const chkCmp = chkPct === 0 ? 'about the same work as usual' : `${chkPct}% ${chkDelta < 0 ? 'less' : 'more'} work than usual`
    // A hairline between sections, the band's full width.  Sections are spaced
    // the same way everywhere: one small step above and below each line, and
    // no extra space between the rows inside a section.
    // Every Full row shares one right edge: the bars' (two 40-cell columns
    // and a 3-cell gap).  Rows below used to stretch to the band's own edge.
    const CW = Math.min(83, cols - 2)
    // The two meter columns share CW with a 3-cell gap, so a narrow band
    // shrinks the bars instead of pushing the 5H column off the edge.
    // Too narrow for two meters side by side (under 52 cells): stack them,
    // each the band's full width.
    const stack = CW < 52
    const MW = stack ? CW : Math.floor((CW - 3) / 2)
    // One model column in the Other models table (14 + 3 x 23 = 83 at full width).
    const COLW = Math.max(10, Math.min(23, Math.floor((CW - LABW) / Math.max(1, d.switchRows.length))))
    const sep = (k: string) => {
      // A 9 px strip with a 1 px line through its middle: the strip is the
      // spacing, so no margins (a full text row per line made Full scroll).
      const W = Math.round(CW * 8.8)
      return (
        <Box key={k} flexShrink={0}>
          {Svg
            ? <Svg source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 9" width="${W}" height="9"><rect y="4" width="${W}" height="1" fill="${SEP}"/></svg>`} alt="divider" width={W} height={9} />
            : <Text dimColor>{'─'.repeat(Math.max(10, CW))}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1} width={CW + 2}>
        <Box justifyContent="space-between">
          <Box><Text size="footnote" weight="semibold">Mana Pool</Text>{version ? <Text size="footnote" dimColor>  v{version}</Text> : null}{spin()}</Box>
          <Box>
            {icon('▤', 'History', openHistory)}
            {icon('ⓘ', 'Manual', openManual)}
            <Box>{icon('⊖', 'Collapse', () => update($, mode, () => 'mini'))}</Box>
          </Box>
        </Box>

        {/* The two meters: how full, when they reset, and whether they last. */}
        <Box marginTop="sm" flexDirection={stack ? 'column' : 'row'}>
          {wins.map((w, wi) => {
            const rw = d.runway(w)
            const est = d.est(w)
            // The line above the bar must fit MW cells on one line.  Drop the
            // pace first, then shorten "resets in" (or, when it would run
            // out, drop the reset time and keep "runs out in").
            const resetTxt = w.resetsAt ? dur(Date.parse(w.resetsAt) - now) : '?'
            const leftW = tw(`${tag(w)}  ~${est.toFixed(2)}%`) + (v.refreshing ? 3 : 0)
            const paceS = !rw.bad && rw.r > 0 ? ` · ${paceTxt(w, rw.r)}` : ''
            const rightOpts = rw.bad
              ? [`${rw.text} · resets in ${resetTxt}`, `${rw.text} · resets ${resetTxt}`, rw.text]
              : [`resets in ${resetTxt}`, `resets ${resetTxt}`]
            const showPace = !!paceS && leftW + tw(paceS) + 1 + tw(rightOpts[0]!) <= MW
            const rightTxt = rightOpts.find(t => leftW + 1 + tw(t) <= MW) ?? rightOpts[rightOpts.length - 1]
            // Desktop and phone: the whole line sits inside the bar (as in Mini),
            // which saves a row.  It shortens to fit: pace goes first, then
            // "resets in" becomes "resets", then the reset time goes.
            if (Svg) {
              const tagW = tw(`${tag(w)} `) + 1
              const Wpx = Math.round((MW - tagW) * 8.8)
              const fits = (t: string) => t.length * 6.6 + 16 <= Wpx // 12 px medium type
              const pct = `${est === w.pct ? '' : '~'}${est.toFixed(2)}%`
              const opts = rw.bad
                ? [`${pct} · ${rw.text} · resets in ${resetTxt}`, `${pct} · ${rw.text} · resets ${resetTxt}`, `${pct} · ${rw.text}`]
                : [`${pct}${paceS} · resets in ${resetTxt}`, `${pct} · resets in ${resetTxt}`, `${pct} · resets ${resetTxt}`, pct]
              const label = opts.find(fits) ?? opts[opts.length - 1]!
              return (
                <Box key={w.kind} flexShrink={0} width={MW} marginRight={wi === 0 && !stack ? 3 : 0} alignItems="center">
                  <Box width={tagW} flexShrink={0}><Text {...lab}>{tag(w)}</Text></Box>
                  {barIn(est / 100, label, Wpx, 18, `g${w.kind}`)}
                </Box>
              )
            }
            return (
              <Box key={w.kind} flexDirection="column" flexShrink={0} width={MW} marginRight={wi === 0 && !stack ? 3 : 0}>
                {/* One line above the bar: percent and pace; reset time on the right.
                    Only when it would run out first does the right side turn red
                    and say so (pace is dropped then, to make room). */}
                <Box justifyContent="space-between">
                  {/* The percent never shrinks or wraps; the reset text on the right gives way. */}
                  <Box flexShrink={0}><Text>
                    <Text {...lab}>{tag(w)}  </Text>
                    <Text size="footnote" weight="medium" tabular dimColor={!!v.refreshing} color={tone(w.pct)}>{est === w.pct ? '' : '~'}{est.toFixed(2)}%</Text>{spin()}
                    {showPace ? <Text {...fn}>{paceS}</Text> : null}
                  </Text></Box>
                  <Box flexShrink={1} minWidth={0} justifyContent="flex-end">
                    {rw.bad
                      ? <Text size="footnote" color={RED} wrap="truncate">{rightTxt}</Text>
                      : <Text {...fn} wrap="truncate">{rightTxt}</Text>}
                  </Box>
                </Box>
                {bar(est / 100, Math.round(MW * 8.8), 12, `g${w.kind}`)}
              </Box>
            )
          })}
        </Box>

        {/* Last turn: cost, the same turn fresh, the ratio, the hand-off pay-back, the Cost pill. */}
        <Box marginTop="sm" justifyContent="space-between">
          <Box flexShrink={1} minWidth={0}>
            {Lab('Last turn')}
            {d.lt ? (
              <Text wrap="truncate">
                <Text size="footnote" tabular>{P(d.lt.u)}</Text>
                {/* Next turn: what the next turn here should cost (last 3 turns). */}
                <Text {...fn}> of 5H · next {d.nextU === null ? 'unpriced' : `~${P(d.nextU)}`} · new session ~{P(d.lt.f)} (</Text>
                <Text size="footnote" tabular>{d.ratio.toFixed(1)}x</Text>
                <Text {...fn}>) · hand-off: {d.turnsTxt(d.payback)}</Text>
              </Text>
            ) : <Text {...fn}>no finished turn yet</Text>}
          </Box>
          <Box flexShrink={0} marginLeft={1}>{pill(d.cost, 'cost', false, 16, 0, true)}</Box>
        </Box>

        {/* Turns: the strip, then this session's turns and its share of 5H since the window began. */}
        <Box justifyContent="space-between">
          <Box flexShrink={1} minWidth={0}>
            {Lab('Turns')}
            {strip()}
            <Text {...fn} wrap="truncate">{d.ses ? `${d.ses.turnCount} turn${d.ses.turnCount === 1 ? '' : 's'} · used ${P(d.ses.since5h.units)} of 5H${share !== null && share !== undefined ? ` · ${Math.round(share * 100)}% of last hour's use` : ''}` : 'no turns yet'}</Text>
          </Box>
          {/* The legend keeps its size; the turn count on the left shortens instead. */}
          <Box flexShrink={0} marginLeft={1}><Text size="footnote"><Text color={HIST}>■</Text><Text {...fn}> re-reading  </Text><Text color={ME}>■</Text><Text {...fn}> new work</Text></Text></Box>
        </Box>

        {/* Context: size, % used, growth and auto-compact, with the Context pill. */}
        <Box justifyContent="space-between">
          <Box flexShrink={1} minWidth={0}>
            {Lab('Context')}
            <Text {...fn} wrap="truncate">{d.detail.why}</Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>{pill(d.detail, 'detail', false, 16, 0, true)}</Box>
        </Box>

        {/* Prompt cache clock and what its expiry costs. */}
        <Box>
          {Lab('Cache')}
          <Text wrap="truncate">
            <Text size="footnote" color={d.idle === null ? DIM : d.warm ? WARM : COLD}>{d.idle === null ? 'No reply yet' : d.warm ? 'Active' : d.otherModel ? 'Model changed' : 'Expired'}</Text>
            <Text {...fn}>
              {d.idle === null ? '' : d.warm
                ? ` · expires in ${dur(TTL_MS - d.idle)} · after that, ${d.reloadU === null ? 're-cache unpriced' : `next message costs +${P(d.reloadU)} to re-cache`}`
                : ` · next message ${d.reloadU === null ? `re-caches ${fmt(d.ctxTok)} (unpriced)` : `costs +${P(d.reloadU)} to re-cache ${fmt(d.ctxTok)}`} · a new session caches ${fmt(d.base + d.ho.extra)}`}
            </Text>
          </Text>
        </Box>

        {/* Limit check: how much work 1% of 5H buys now against your usual. */}
        {/* Elsewhere shows whenever above 0: here, after the comparison, or
            alone while there are too few past windows to compare with. */}
        {showChk || (chk?.outside ?? 0) > 0 ? (
          <Box>
            {Lab('Limit check')}
            <Text wrap="truncate">
              {!showChk ? null : chkLow
                ? <Text size="footnote" color={RED}>1% of 5H buys {chkCmp}</Text>
                : <Text><Text size="footnote">normal</Text><Text {...fn}> · 1% of 5H buys {chkCmp}</Text></Text>}
              {(chk?.outside ?? 0) > 0 ? <Text size="footnote" color={RED}>{showChk ? ' · ' : ''}{chk!.outside}% elsewhere</Text> : null}
            </Text>
          </Box>
        ) : null}

        {/* Other models: two ways to move to each, a one-time cost then a per-turn
            cost; the cheaper path over the next 5 turns in green. */}
        {sep('sep2')}
        <Box flexDirection="column">
          <Box>
            {Lab('Other models')}
            {d.switchRows.map(r => <Box key={r.k} width={COLW} flexShrink={0} paddingRight={1}><Text size="footnote">{cap(r.k)}</Text></Box>)}
          </Box>
          {([['now', 'switch now'], ['handoff', 'hand off']] as const).map(([path, name]) => (
            <Box key={path}>
              {Lab(name)}
              {d.switchRows.map(r => {
                const once = path === 'now' ? r.nowOnce : r.hoOnce
                const turn = path === 'now' ? r.nowTurn : r.hoTurn
                const best = r.pick === path
                return (
                  <Box key={r.k} width={COLW} flexShrink={0} paddingRight={1}>
                    <Text size="footnote" tabular color={best ? LVL[0] : undefined} dimColor={!best} wrap="truncate">
                      {d.ok ? `${once === null ? 'unpriced' : `+${pctTxt(once)}`}, then ${pctTxt(turn)}/turn` : '—'}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          ))}
        </Box>
        {v.error ? <Text size="footnote" color={RED}>{v.error.slice(0, 160)}</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    started = true
    const { Box, Text, Markdown } = $.ui.resolve(e) as any
    const v = await read($, view)
    const last = (await read($, lastReply)) ?? (v?.session?.lastSeen ? v.session.lastSeen * 1000 : null)
    const ledger = ((await $.store.get('ledger').catch(() => [])) ?? []) as LedgerRow[]
    if (!v) return <Text dimColor>Reading transcripts...</Text>
    return (
      <Box flexDirection="column">
        {v.error && <Text color="red">{v.error}</Text>}
        <Markdown text={manualText(v, last, Date.now(), ledger)} />
      </Box>
    )
  })

  // The History pane: charts of past use (see historyView).
  on('ui.render', { component: 'Pane', requestId: HPANE }, async ($, e) => {
    started = true
    const { Box, Text, Button, Svg } = $.ui.resolve(e) as any
    // Reads histAtom, not `view` or `lastReply`: see histAtom for why.
    const v = await read($, histAtom)
    if (!v) return <Text dimColor>Reading transcripts…</Text>
    const range = ((await read($, rangeAtom)) ?? 30) as HistRange
    const last = v.session?.lastSeen ? v.session.lastSeen * 1000 : null
    const ledger = ((await $.store.get('ledger').catch(() => [])) ?? []) as LedgerRow[]
    // The pane's width: its columns over the code font's advance (8.8 px, the
    // same figure the band sizes its boxes by), less a little slack.
    const cols = Number(e.props?.bodyColumns) || 0
    const hv = historyView(v, ledger, range, last, Date.now(), cols > 0 ? cols * 8.8 - 12 : 424)
    // Each chart is given its exact size, so none is centred or rescaled.
    const dims = (svg: string) => {
      const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
      return m ? { width: +m[1]!, height: +m[2]! } : {}
    }
    const pick = (r: HistRange) => (
      <Button key={`range${r}`} label={`${r}D`} {...(r === range ? { variant: 'primary' } : { plain: true, dimColor: true })}
        onPress={() => update($, rangeAtom, () => r)} />
    )
    // A legend: a coloured square, then the name in text colour (identity never by colour alone).
    const legend = (items?: { name: string; col: string; glyph?: string }[]) => items?.length ? (
      <Box flexWrap="wrap" columnGap={2}>
        {items.map(it => <Text key={it.name} size="footnote"><Text color={it.col}>{it.glyph ?? '■'}</Text><Text dimColor> {it.name}</Text></Text>)}
      </Box>
    ) : null
    const section = (title: string, c: Chart | null) => c ? (
      <Box key={title} flexDirection="column" marginTop={1}>
        <Box justifyContent="space-between">
          <Text size="footnote" weight="semibold">{title}</Text>
          {c.right ? <Text size="footnote" color={c.rightBad ? RED : undefined} dimColor={!c.rightBad}>{c.right}</Text> : null}
        </Box>
        <Svg source={c.svg} alt={c.alt} isInteractive {...dims(c.svg)} />
        {legend(c.legend)}
      </Box>
    ) : null
    if (!Svg) {
      // A surface without vector drawing (the terminal): the key numbers as text.
      return (
        <Box flexDirection="column">
          <Text weight="semibold">History · {range}D</Text>
          {hv.text.map((l, i) => <Text key={i} size="footnote">{l}</Text>)}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between" alignItems="center">
          <Text weight="semibold">History</Text>
          <Box columnGap={1}>{([7, 30, 90] as HistRange[]).map(pick)}</Box>
        </Box>
        {hv.tiles ? <Box marginTop={1}><Svg source={hv.tiles.svg} alt={hv.tiles.alt} {...dims(hv.tiles.svg)} /></Box> : null}
        {!hv.ok ? <Text size="footnote" dimColor>No history yet.</Text> : null}
        {section('Daily', hv.daily)}
        {section('5H pace', hv.pace)}
        {section('7D pace', hv.pace7)}
        {section('5H windows', hv.windows)}
        {section('Limit by time', hv.byTime)}
        {section('Projects', hv.projects)}
        {section('Hours', hv.hours)}
        {section('Re-reading', hv.reread)}
        <Box marginTop={1}>
          <Text size="footnote" dimColor>{hv.full ? 'Estimates.' : 'Filling in older days…'}  Claude Code on this computer only.</Text>
        </Box>
      </Box>
    )
  })
}
