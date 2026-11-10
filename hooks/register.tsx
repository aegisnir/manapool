import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Check, LedgerRow, Sample, Session, Turn, View, Win } from '../types'

// The slash command and the side pane's id.
const CMD = 'manapool'
const PANE = 'manapool'
const BUILD = '2026-11-09.9' // bump on each edit: the store's `loaded` key shows which build is running
const view = atom({ plugin: 'manapool', key: 'view' } as const, null, { shape: 'view-3' })
const mode = atom({ plugin: 'manapool', key: 'mode' } as const, 'full', { shape: 'mode-3' })
const lastReply = atom({ plugin: 'manapool', key: 'lastReply' } as const, null, { shape: 'last-3' })
const busyAtom = atom({ plugin: 'manapool', key: 'busy' } as const, false, { shape: 'busy-3' })
const rangeAtom = atom({ plugin: 'manapool', key: 'range' } as const, 30, { shape: 'range-1' })
// The History pane's id.
const HPANE = `${PANE}-history`

const SPAN: Record<string, number> = { five_hour: 5 * 3600, seven_day: 7 * 86400 }
// The prompt cache keeps the conversation for an hour after each reply
// (Claude Code asks for the 1-hour kind), then the next message pays to reload it.
const TTL_MS = 60 * 60 * 1000
const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
// Units per token at list prices (1 unit = one Sonnet 5.5 input token, $2 per
// million): input, output, cache write, cache read.  scan.py sends the weights
// in use (per model version, fitted from your own meter ticks once there are
// enough); this is only the fallback before the first scan.
const LISTW: Record<string, number[]> = {
  fable: [4, 20, 8, 0.1], opus: [2, 10, 4, 0.1], sonnet: [1, 5, 2, 0.05], haiku: [0.05, 0.25, 0.1, 0.005],
}
// Saved per-session entries (ses:<id>, alerts:<id>) are dropped after this
// long unused.  The whole store is capped at 4 MiB by Claude Code.
const KEEP_SESSION_MS = 7 * 86400e3
const MAX_SESSIONS = 40
const MAX_LEDGER = 3000
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
  return m.includes('fable') || m.includes('mythos') ? 'fable' : m.includes('opus') ? 'opus' : m.includes('haiku') ? 'haiku' : m.includes('sonnet') ? 'sonnet' : ''
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
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

// ---------------------------------------------------------------------------
// Colour.  Bars use a rating-ring spectrum: the tip
// colour runs red -> amber -> green by how much is LEFT.  Colours in OKLCH.
// ---------------------------------------------------------------------------
type Ok = [number, number, number]
const ERROR: Ok = [0.711, 0.166, 22.2]
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
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')
}
const SURFACE = '#262626'
const RED = '#f87171'
const ME = '#a98bf5'      // your current model, and "new work" in the turn strip
const HIST = '#6b6b6b'    // "re-reading history" in the turn strip
const DIM = '#9a9a9a'     // caption grey (5.4:1 contrast on the band)
// Pill levels: 0 green, 1 blue (an opportunity), 2 amber, 3 red.
const LVL = ['#35d399', '#7fb2ff', '#fbbf25', '#f87171']

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
    return lg && prompt > lg.over ? lg.w : (W[k] ?? LISTW[k])
  }
  const rate = v.rate ?? 0
  const ok = rate > 0
  const pc = (u: number) => u * rate // work units -> % of the 5H limit
  const turns: Turn[] = ses?.turns ?? []
  const done = turns.filter(t => !t.live)
  const lt = done[done.length - 1]
  // your model: the one Claude Code reports, else the one the last turn ran on
  const me = keyOf(v.model ?? '') || lt?.k || 'sonnet'

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
      const dp = L[i].pct - L[i - 1].pct
      if (dp > 0 && val(L[i]) > val(L[i - 1])) sizes.push((val(L[i]) - val(L[i - 1])) / dp)
    }
    const recent = sizes.slice(-3)
    const per = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : w.pct > 0 ? cur / w.pct : 0
    const lastS = L[L.length - 1]
    if (!per || !lastS) return w.pct
    return w.pct + Math.min(0.99, Math.max(0, (cur - val(lastS)) / per))
  }
  const HORIZON: Record<string, number> = { five_hour: 3600, seven_day: 86400 }
  const pace = (w: Win) => { // % per hour over the last hour (5H) or day (7D) of real ticks
    const nowS = now / 1000
    const L = ticksOf(w)
    let i = L.findIndex(x => x.at >= nowS - HORIZON[w.kind])
    if (i < 0) i = L.length - 1
    if (i > 0 && nowS - L[i].at < 360) i -= 1 // the anchor must be a few minutes old
    const start = w.resetsAt ? Date.parse(w.resetsAt) / 1000 - SPAN[w.kind] : nowS - SPAN[w.kind]
    const anchor = i >= 0 ? L[i] : null
    const hours = (nowS - (anchor ? anchor.at : start)) / 3600
    if (hours < 0.1) return 0
    return Math.max(0, (est(w) - (anchor ? anchor.pct : 0)) / hours)
  }
  const runway = (w: Win): Runway => {
    const r = pace(w)
    const resetMs = w.resetsAt ? Date.parse(w.resetsAt) - now : SPAN[w.kind] * 1000
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
  const curId = me + (verOf(v.model ?? '') ? `-${verOf(v.model ?? '')}` : '')
  const cacheId = ses?.lastModel ?? curId
  const otherModel = idle !== null && (cacheId.includes('-') && curId.includes('-') ? cacheId !== curId : cacheId.split('-')[0] !== me)
  const warm = idle !== null && idle < TTL_MS && !otherModel
  const ctxTok = v.ctx?.tokens ?? lt?.ctx ?? 0
  // When the prompt cache is cold, the conversation is written to cache again instead of read.
  const wCtx = wAt(me, ctxTok)
  const reloadU = ctxTok * (wCtx[2] - wCtx[3])

  // --- Cost pill: token overhead, break-even and the cache clock ---
  const base = ses?.base ?? 0
  const ho = v.handoff ?? { extra: 15000, noteOut: 3000 }
  const recent = done.slice(-3)
  const ratio = lt && lt.f > 0 ? lt.u / lt.f : 0
  const rMed = recent.length ? median(recent.map(t => (t.f > 0 ? t.u / t.f : 1))) : 0
  const save = recent.length ? median(recent.map(t => t.u - t.f)) : 0
  // a hand-off costs once: writing the note here, then the new session storing
  // its starting context (system prompt, tools, note, a few files) in its cache
  const oneTimeU = ho.noteOut * wCtx[1] + (base + ho.extra) * wAt(me, base + ho.extra)[2]
  const payback = save > 0 ? oneTimeU / save : Infinity
  const histShare = lt && lt.u > 0 ? lt.h / lt.u : 0
  const turnsTxt = (n: number) => (n === Infinity ? 'no savings yet' : n < 1 ? 'pays back in under a turn' : `pays back in ~${Math.round(n)} turn${Math.round(n) === 1 ? '' : 's'}`)
  let cost: Pill
  const costWhy = `turns cost ${rMed.toFixed(1)}x a new session · hand-off ${turnsTxt(payback)}`
  if (!lt) cost = { lvl: 0, label: 'Keep going', why: 'no finished turn yet' }
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
  const comp = ses?.compactionsAll ?? 0
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
  const nextU = fin.length ? median(fin.map(t => t.on?.[me] ?? t.u)) + (idle !== null && !warm ? reloadU : 0) : 0
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
    const nowOnce = pc(ctxTok * wAt(k, ctxTok)[2])
    const nowTurn = perTurn(k, false)
    const hoOnce = pc(ho.noteOut * wCtx[1] + (base + ho.extra) * wAt(k, base + ho.extra)[2])
    const hoTurn = perTurn(k, true)
    const nowTotal = nowOnce + HORIZON_TURNS * nowTurn
    const hoTotal = hoOnce + HORIZON_TURNS * hoTurn
    const pick = nowTotal < 0.05 && hoTotal < 0.05 ? 'tiny' : hoTotal < nowTotal ? 'handoff' : 'now'
    return { k, nowOnce, nowTurn, hoOnce, hoTurn, pick }
  })

  // --- this session ---
  const sesPct = ses ? pc(ses.since5h.units) : 0
  const allOn = MODELS.map(k => ({ k, pct: ses ? pc(ses.allOn[k] ?? 0) : 0 }))

  return {
    w5, w7, ses, me, ok, pc, rate, turns, lt, est, pace, runway, idle, warm, otherModel, ctxTok, reloadU, base, ho,
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
type HistDay = { m: Record<string, number>; p: Record<string, number>; h: number[]; r: number; n: number }
// One colour per model, fixed: a colour follows its model, never its rank.
// Checked as a set of six on every pair against the card (#262626) with the
// dataviz validator: colour-blind dE >= 10.8, normal vision dE >= 20.
const MODEL_COL: Record<string, string> = {
  opus: '#8d7cd5', sonnet: '#a8ceff', fable: '#eac75e', mythos: '#d17746', haiku: '#16b09b', other: '#5f5f5f',
}
const MODEL_ORDER = ['opus', 'sonnet', 'fable', 'mythos', 'haiku', 'other'] // bottom of a stack first
const GRID = '#3a3a3a'
const INK = '#ececec'
const EMPTY = '#2f2f2f'   // a heatmap cell with no work
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
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
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
  const [r, g, b] = rgb(hex).map(v => lin(v / 255))
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
const svgDoc = (h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${HW + 16} ${h + 16}" width="${HW + 16}" height="${h + 16}">` +
  `<rect width="${HW + 16}" height="${h + 16}" rx="10" fill="${SURFACE}"/><g transform="translate(8 8)" ${FONT} font-size="10">${body}</g></svg>`
const label = (x: number, y: number, s: string, anchor = 'start', col = DIM) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${col}">${esc(s)}</text>`
const gridLine = (x0: number, y: number, s: string) =>
  `<line x1="${x0}" x2="${HW}" y1="${y}" y2="${y}" stroke="${GRID}"/>${label(x0 - 4, y + 3, s, 'end')}`
// A bar grown up from the baseline: top corners rounded, bottom flat.
const upBar = (x: number, y: number, w: number, h: number, fill: string) => {
  const r = Math.min(3, w / 2, h)
  return `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z" fill="${fill}"/>`
}
// A bar grown right from the axis: only its data end rounded.
const rightBar = (x: number, y: number, w: number, h: number, fill: string) => {
  const r = Math.min(4, h / 2, w)
  return `<path d="M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z" fill="${fill}"/>`
}

type HistRange = 7 | 30 | 90
type Chart = { svg: string; alt: string; right?: string; rightBad?: boolean; legend?: { name: string; col: string }[]; note?: string }
type HistView = {
  ok: boolean; full: boolean; unit: string
  tiles: { svg: string; alt: string } | null
  daily: Chart | null; pace: Chart | null; limit: Chart | null; projects: Chart | null; hours: Chart | null; reread: Chart | null
  text: string[]  // the same, as plain lines, for a surface without Svg
}

const historyView = (v: View, ledger: LedgerRow[], range: HistRange, last: number | null, now: number, width = 424): HistView => {
  HW = Math.max(300, Math.min(1100, Math.floor(width))) - 16 // the card adds 8 px each side
  const hist = v.history
  const D = hist?.days ?? {}
  const today = new Date(now)
  const keys: string[] = []
  for (let i = range - 1; i >= 0; i--) keys.push(keyOfDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)))
  const dayTotal = (b?: HistDay) => (b ? Object.values(b.m).reduce((a, x) => a + x, 0) : 0)

  // Work units -> % of the 7D limit: the current 7D window's highest reading
  // (its list units over its percent), else the ledger's finished 7D windows.
  const w7 = v.wins.find(w => w.kind === 'seven_day')
  const w5 = v.wins.find(w => w.kind === 'five_hour')
  const tick7 = v.samples.filter(s => s.kind === 'seven_day' && (s.lu ?? 0) > 0 && s.pct >= 3 && (!w7 || s.resetsAt === w7.resetsAt))
    .sort((a, b) => b.pct - a.pct)[0]
  const led7 = ledger.filter(r => r.kind === 'seven_day' && (r.per1 ?? 0) > 0).map(r => r.per1 as number)
  const per7 = tick7 ? (tick7.lu as number) / tick7.pct : led7.length ? median(led7) : 0
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
      return `<rect x="${x}" y="0" width="${tw}" height="${th}" rx="8" fill="#1f1f1f"/>` +
        label(x + 10, 16, k) + `<text x="${x + 10}" y="37" fill="${INK}" font-size="18" font-weight="600">${esc(val_)}</text>` +
        extra + label(x + 10, 63, sub)
    }
    const pct7 = w7 ? d.est(w7) : 0
    const resetMs = w7?.resetsAt ? Date.parse(w7.resetsAt) - now : 0
    const daysLeft = resetMs / 86400e3
    const tip = tipOk(pct7)
    const mw = tw - 20, mx = 10, mf = Math.max(0, Math.min(1, pct7 / 100)) * mw
    const meter = `<defs><linearGradient id="t7" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${hexOk(shiftStart(tip))}"/><stop offset="1" stop-color="${hexOk(shiftEnd(tip))}"/></linearGradient></defs>` +
      `<rect x="${mx}" y="44" width="${mw}" height="4" rx="2" fill="${mix(SURFACE, hexOk(tip), 0.24)}"/>` +
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
    const H = 132, x0 = 34, top = 12, base = H - 16
    const totals = keys.map(k => dayTotal(D[k]))
    const max = niceMax(val(Math.max(...totals, 0)) * 1.08)
    const sy = (x: number) => base - (x / max) * (base - top)
    const sx = (HW - x0) / keys.length, gap = sx > 6 ? 2 : 1, bw = Math.max(1, sx - gap)
    let out = `<defs>${present.map(m => gradDef(`d${m}`, MODEL_COL[m], true)).join('')}</defs>`
    out += [0, max / 2, max].map(t => gridLine(x0, sy(t), tick(t))).join('')
    let peak = -1
    totals.forEach((t, i) => { if (t > 0 && (peak < 0 || t > totals[peak])) peak = i })
    keys.forEach((k, i) => {
      const b = D[k]
      const x = x0 + i * sx + gap / 2
      const parts = present.map(m => [m, b?.m[m] ?? 0] as const).filter(p => p[1] > 0)
      const tip = `${shortDay(k)} · ${valTxt(totals[i])}${parts.length ? ' · ' + parts.map(([m, u]) => `${cap(m)} ${valTxt(u)}`).join(', ') : ''}`
      let y = base, segs = ''
      parts.forEach(([m, u], j) => {
        const h = (val(u) / max) * (base - top)
        y -= h
        const isTop = j === parts.length - 1
        // a 1px surface gap between stacked segments
        segs += isTop ? upBar(x, y, bw, Math.max(0.5, h - (j > 0 ? 1 : 0)), `url(#d${m})`)
          : `<rect x="${x}" y="${y + 1}" width="${bw}" height="${Math.max(0.5, h - 1)}" fill="url(#d${m})"/>`
      })
      // a full-height hover target, bigger than the bar
      out += `<g><title>${esc(tip)}</title><rect x="${x0 + i * sx}" y="${top}" width="${sx}" height="${base - top}" fill="transparent"/>${segs}</g>`
    })
    if (peak >= 0) out += label(x0 + peak * sx + sx / 2, sy(val(totals[peak])) - 4, valTxt(totals[peak]).replace('~', ''), 'middle', INK)
    const every = Math.ceil(keys.length / 5)
    keys.forEach((k, i) => { if ((keys.length - 1 - i) % every === 0) out += label(x0 + i * sx + sx / 2, H - 2, shortDay(k), 'middle') })
    const sum = totals.reduce((a, b) => a + b, 0)
    daily = {
      svg: svgDoc(H, out), alt: `Daily work over ${range} days, ${valTxt(sum)} in all`,
      right: unit === '% of 7D' ? '% of 7D per day' : 'work units per day',
      legend: present.map(m => ({ name: cap(m), col: MODEL_COL[m] })),
    }
    text.push(`Daily (${range}D): ${keys.slice(-7).map(k => `${shortDay(k)} ${valTxt(dayTotal(D[k]))}`).join(' · ')}`)
  }

  // --- 5H pace: this window against the middle half of past windows ---
  let pace: Chart | null = null
  if (w5?.resetsAt) {
    const H = 124, x0 = 34, top = 8, base = H - 16
    const sx = (m: number) => x0 + (m / 300) * (HW - x0 - 4), sy = (p: number) => base - (Math.min(100, p) / 100) * (base - top)
    const byWin = new Map<string, Sample[]>()
    for (const s of v.samples) if (s.kind === 'five_hour' && s.resetsAt) byWin.set(s.resetsAt, [...(byWin.get(s.resetsAt) ?? []), s])
    const startOf = (ra: string) => Date.parse(ra) / 1000 - SPAN.five_hour
    const at = (ss: Sample[], st: number, m: number) => ss.reduce((p, s) => (s.at <= st + m * 60 ? Math.max(p, s.pct) : p), 0)
    const past = [...byWin.entries()].filter(([ra, ss]) => ra !== w5.resetsAt && Date.parse(ra) <= now && ss.length >= 2 && Math.max(...ss.map(s => s.pct)) >= 2)
      .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0])).slice(-30)
    const grid = Array.from({ length: 31 }, (_, i) => i * 10)
    let out = [0, 50, 100].map(t => gridLine(x0, sy(t), `${t}%`)).join('')
    const nowMin = Math.max(0, Math.min(300, (now / 1000 - startOf(w5.resetsAt)) / 60))
    const pctNow = d.est(w5)
    if (past.length >= 3) {
      const cols = grid.map(m => past.map(([ra, ss]) => at(ss, startOf(ra), m)))
      const p25 = cols.map(c => quant(c, 0.25)), p50 = cols.map(c => quant(c, 0.5)), p75 = cols.map(c => quant(c, 0.75))
      out += `<path d="M${grid.map((m, i) => `${sx(m)},${sy(p75[i])}`).join(' L')} L${[...grid].reverse().map((m, i) => `${sx(m)},${sy(p25[grid.length - 1 - i])}`).join(' L')} Z" fill="${HIST}" opacity="0.35"/>`
      out += `<path d="M${grid.map((m, i) => `${sx(m)},${sy(p50[i])}`).join(' L')}" fill="none" stroke="${HIST}" stroke-width="2"/>`
    }
    const cur = (byWin.get(w5.resetsAt) ?? []).map(s => [(s.at - startOf(w5.resetsAt)) / 60, s.pct] as [number, number])
      .filter(([m]) => m >= 0 && m <= nowMin).sort((a, b) => a[0] - b[0])
    const pts: [number, number][] = [[0, 0], ...cur, [nowMin, pctNow]]
    // each reading holds until the next one: a step line
    let path = `M${sx(0)},${sy(0)}`
    for (let i = 1; i < pts.length; i++) path += ` L${sx(pts[i][0])},${sy(pts[i - 1][1])} L${sx(pts[i][0])},${sy(pts[i][1])}`
    out += `<defs>${gradDef('pl', ME, false)}</defs><path d="${path}" fill="none" stroke="url(#pl)" stroke-width="2" stroke-linejoin="round"/>`
    const rw = d.runway(w5)
    if (rw.r > 0 && nowMin < 300) {
      const endM = rw.bad ? Math.min(300, nowMin + rw.leftMs / 60000) : 300
      const endP = Math.min(100, pctNow + (rw.r * (endM - nowMin)) / 60)
      out += `<path d="M${sx(nowMin)},${sy(pctNow)} L${sx(endM)},${sy(endP)}" fill="none" stroke="${ME}" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>`
      if (rw.bad) out += `<line x1="${sx(endM)}" x2="${sx(endM)}" y1="${sy(100)}" y2="${base}" stroke="${RED}" stroke-dasharray="2 3"/>`
    }
    out += `<circle cx="${sx(nowMin)}" cy="${sy(pctNow)}" r="4" fill="${ME}" stroke="${SURFACE}" stroke-width="2"><title>${esc(`Now · ${pctTxt(pctNow)}`)}</title></circle>`
    out += label(sx(nowMin) + (nowMin > 200 ? -8 : 8), sy(pctNow) - 8, `${Math.round(pctNow)}% now`, nowMin > 200 ? 'end' : 'start', INK)
    for (let h = 0; h <= 5; h++) out += label(sx(h * 60), H - 2, `${h}h`, 'middle')
    const usual = past.length >= 3 ? quant(past.map(([ra, ss]) => at(ss, startOf(ra), nowMin)), 0.5) : null
    pace = {
      svg: svgDoc(H, out), alt: `5H window at ${Math.round(pctNow)}%${usual !== null ? `, usual ${Math.round(usual)}% by now` : ''}`,
      right: rw.bad ? `Runs out in ${dur(rw.leftMs)}` : usual !== null ? `Usual ${Math.round(usual)}% by now` : `${past.length} past windows`,
      rightBad: rw.bad,
      legend: [{ name: 'This window', col: ME }, ...(past.length >= 3 ? [{ name: `Usual (middle half of ${past.length} windows)`, col: HIST }] : [])],
    }
    text.push(`5H ${Math.round(pctNow)}% · ${pace.right}`)
  }

  // --- Limit size: work per 1% of 5H, one dot per finished window ---
  let limit: Chart | null = null
  {
    const rows = ledger.filter(r => r.kind === 'five_hour' && (r.per1 ?? 0) > 0).sort((a, b) => a.start - b.start).slice(-40)
    if (rows.length >= 2) {
      const H = 112, x0 = 38, top = 10, base = H - 16
      const max = niceMax(Math.max(...rows.map(r => r.per1 as number)) * 1.1)
      const sx = (i: number) => x0 + 8 + i * ((HW - x0 - 16) / (rows.length - 1)), sy = (x: number) => base - (x / max) * (base - top)
      const sure = (r: LedgerRow) => r.pct >= 15
      const conf = rows.filter(sure).map(r => r.per1 as number)
      const med = conf.length ? median(conf) : 0
      let out = [0, max / 2, max].map(t => gridLine(x0, sy(t), t ? fmt(t) : '0')).join('')
      if (med) out += `<line x1="${x0}" x2="${HW}" y1="${sy(med)}" y2="${sy(med)}" stroke="${DIM}" stroke-dasharray="4 4"/>` + label(HW, sy(med) - 4, `median ${fmt(med)}`, 'end')
      out += `<path d="M${rows.map((r, i) => `${sx(i)},${sy(r.per1 as number)}`).join(' L')}" fill="none" stroke="${GRID}" stroke-width="2"/>`
      rows.forEach((r, i) => {
        const s = sure(r)
        const tip = `${day(r.start * 1000)} · ${r.pct}% used · ${fmt(r.per1 as number)} per 1%${s ? '' : ' · low confidence'}`
        out += `<g><title>${esc(tip)}</title><circle cx="${sx(i)}" cy="${sy(r.per1 as number)}" r="10" fill="transparent"/>` +
          `<circle cx="${sx(i)}" cy="${sy(r.per1 as number)}" r="4" fill="${s ? INK : SURFACE}" stroke="${s ? SURFACE : DIM}" stroke-width="${s ? 2 : 1.5}"/></g>`
      })
      out += label(sx(0), H - 2, shortDay(keyOfDay(new Date(rows[0].start * 1000)))) + label(sx(rows.length - 1), H - 2, shortDay(keyOfDay(new Date(rows[rows.length - 1].start * 1000))), 'end')
      let right = `${rows.length} windows · too few to judge`
      if (conf.length >= 8) { // fewer reliable windows than this is noise
        const recent = median(conf.slice(-3)), chg = med > 0 ? (recent - med) / med : 0
        right = Math.abs(chg) < 0.1 ? `Steady · ${conf.length} windows` : `${chg < 0 ? 'Down' : 'Up'} ${Math.round(Math.abs(chg) * 100)}% lately`
      }
      limit = {
        svg: svgDoc(H, out), alt: `Work per 1% of 5H over ${rows.length} finished windows${med ? `, median ${fmt(med)}` : ''}`,
        right, rightBad: right.startsWith('Down'),
        legend: [{ name: 'Work per 1% of 5H', col: INK }, { name: 'Hollow: under 15% used', col: DIM }],
      }
      text.push(`Limit size: ${right}`)
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
      let out = `<defs>${gradDef('pj', ME, false)}${gradDef('po', MODEL_COL.other, false)}</defs>`
      rows.forEach(([name, u], i) => {
        const y = i * rowH + 4, w = Math.max(2, (u / max) * (HW - lx - 52))
        const nm = name.length > 20 ? name.slice(0, 19) + '…' : name
        out += `<g><title>${esc(`${name} · ${valTxt(u)}`)}</title>` + `<text x="0" y="${y + 11}" fill="${INK}" font-size="11">${esc(nm)}</text>` +
          rightBar(lx, y, w, 14, name === 'Other' && i === rows.length - 1 && rest > 0 ? 'url(#po)' : 'url(#pj)') +
          `<text x="${lx + w + 6}" y="${y + 11}" fill="${DIM}" font-size="11">${esc(valTxt(u))}</text></g>`
      })
      projects = { svg: svgDoc(H, out), alt: `Top projects: ${rows.map(r => `${r[0]} ${valTxt(r[1])}`).join(', ')}`, right: `${unit}, ${range} days` }
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
      b.h.forEach((u, h) => { M[wd][h] += u })
    }
    const max = Math.max(...M.flat())
    if (max > 0) {
      const x0 = 32, cell = (HW - x0) / 24, ch = 13, H = 7 * (ch + 2) + 14
      let out = ''
      M.forEach((row, r) => {
        out += label(x0 - 6, r * (ch + 2) + 10, WEEK[r], 'end')
        row.forEach((u, h) => {
          const t = u / max
          out += `<rect x="${x0 + h * cell + 1}" y="${r * (ch + 2)}" width="${cell - 2}" height="${ch}" rx="2" fill="${t < 0.02 ? EMPTY : ME}" fill-opacity="${t < 0.02 ? 1 : (0.18 + t * 0.82).toFixed(2)}"><title>${esc(`${WEEK[r]} ${hourTxt(h)} · ${valTxt(u)}`)}</title></rect>`
        })
      })
      for (const h of [0, 6, 12, 18]) out += label(x0 + h * cell + 1, H - 1, hourTxt(h).replace(' ', '').toLowerCase())
      hours = { svg: svgDoc(H, out), alt: 'Work by weekday and hour of day', right: 'by hour, local time', legend: [{ name: 'Less', col: mix(SURFACE, ME, 0.3) }, { name: 'More', col: ME }] }
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
    let out = `<defs>${gradDef('rn', ME, true)}</defs>` + [0, max / 2, max].map(t => gridLine(x0, base - sy(t), tick(t))).join('')
    keys.forEach((k, i) => {
      const b = D[k], t = totals[i]
      if (!b || t <= 0) return
      const hh = sy(val(b.r)), nh = sy(val(t - b.r)), x = x0 + i * sx + gap / 2
      out += `<g><title>${esc(`${shortDay(k)} · ${Math.round((b.r / t) * 100)}% re-reading`)}</title><rect x="${x0 + i * sx}" y="${top}" width="${sx}" height="${base - top}" fill="transparent"/>` +
        `<rect x="${x}" y="${base - hh}" width="${bw}" height="${hh}" fill="${HIST}"/>` + upBar(x, base - hh - nh, bw, Math.max(0.5, nh - 1), 'url(#rn)') + '</g>'
    })
    out += label(x0 + 2, H - 2, shortDay(keys[0])) + label(HW, H - 2, 'Today', 'end')
    const R = keys.reduce((a, k) => a + (D[k]?.r ?? 0), 0), T = totals.reduce((a, b) => a + b, 0)
    if (T > 0) {
      reread = {
        svg: svgDoc(H, out), alt: `${Math.round((R / T) * 100)}% of work re-reading the conversation over ${range} days`, right: `${Math.round((R / T) * 100)}% of work`,
        legend: [{ name: 'Re-reading the conversation', col: HIST }, { name: 'New work', col: ME }],
      }
    }
  }

  return { ok: Object.keys(D).length > 0, full: !!hist?.full, unit, tiles, daily, pace, limit, projects, hours, reread, text }
}

// ---------------------------------------------------------------------------
// The manual (side pane).  Pure: no `$`.
// ---------------------------------------------------------------------------
const manualText = (v: View | null, last: number | null, now: number, ledger: LedgerRow[]): string => {
  const L: string[] = []
  L.push('# Mana Pool: user manual', '')
  L.push('Mana Pool reads the token counts Claude Code writes on this computer and turns them into three answers: **will my limits last**, **is this session still the cheap place to keep working**, and **is Anthropic giving me the same amount of work per percent as usual**. It never calls a model, so looking at it costs nothing.', '')

  L.push('## The band, row by row', '')
  L.push('- **7D / 5H bars**: how much of the weekly and 5-hour limits is used. The colour runs green (plenty left) to red (nearly full). `~` marks an estimated hundredth: the meter itself moves in whole points.')
  L.push('- **Above each bar**: the **pace** over the last hour (5H) or day (7D) of real ticks, and when the limit **resets**. If at that pace it would hit 100% first, the right side turns red: **runs out in N · resets in M**.')
  L.push('- **Last turn**: what your last message and the full reply cost (every model call in it, subagents included), in % of the 5H limit; what the same turn would cost **in a new session** that took over through a hand-off note, with the ratio in brackets; and how many turns a **hand-off** takes to pay for itself (writing the note plus the new session caching its start). The **Cost pill** on the right turns that into a call (rules below).')
  L.push('- **Next turn**: what your next turn here should cost, in % of 5H: the middle of your last 3 finished turns, re-priced on the model you are on now, plus the one-time re-cache when the cache is cold. A forecast; Last turn is the measured one.')
  L.push('- **Turns**: one small bar per turn of this whole session: grey is the part spent **re-reading** the old conversation, violet the **new work**. Dim bars were before the current 5H window started (a thin line marks its start). Then the turn count, how much of the 5H limit this session has **used** since the window began, and its share of **last hour\'s use** (everything Claude Code used on this computer in the last hour, subagents included). Open the band in each session to see which one is eating the limit.')
  L.push('- **Context**: context size, how much of the window is used, how much it grows per turn, and how close auto-compact is, with the **Context pill**: a warning that the session is getting long enough for the model to lose track of earlier detail.')
  L.push('- **Cache**: the prompt cache clock. **Active** means the conversation is still in the prompt cache, so the next message reads it cheaply (a *cache read*). An hour after the last reply the cache **expires**, and the next message here costs extra to re-cache the whole conversation (a *cache write*), once. A cache belongs to one model: after switching models it shows **Model changed**, and the next message pays that re-cache too.')
  L.push('- **Limit check** (once past windows are recorded): how much work 1% of your 5H limit buys in this window compared with your usual. **Normal** within 15% of usual; red when it buys 15%+ less (a shrinking limit), or when the meter moved with no Claude Code use on this computer (**used outside Claude Code**: claude.ai chat or the phone app). "Work" is your usage weighted by token type and model; see "Limit audit".')
  L.push('- **Other models**: one column for each model you are not on, and two ways to move to it, each shown as a one-time cost, then the cost per turn after it. **Switch now**: this session changes model, so the whole conversation is cached on the new model once, and every later turn still re-reads it. **Hand off**: write a hand-off note here and start a new session on that model; it caches only its small start, and its turns carry no old conversation. Per-turn costs are your last 3 turns re-priced on that model (assuming it would use the same tokens: Fable tends to think more, Haiku to write less). Green marks the cheaper path over the next 5 turns. As a session grows, switch now gets dearer and hand off wins.')
  L.push('- **ⓘ / ⊖ / ⊕**: this manual / Mini (one line) / back to Full. Mini shows the bars with their percent inside, the last turn as a pill coloured by whichever of Cost and Context is worse (a dotted border for amber, dashed for red), and the cache clock.', '')

  L.push('## The pills', '')
  L.push('| Pill | Green | Blue | Amber | Red |', '|---|---|---|---|---|')
  L.push('| **Cost** | Keep going | Good moment to switch: the prompt cache expired and turns here cost 1.3x+ a new session, so switching now costs little extra | Consider handoff: turns cost 1.5x+ a new session and a hand-off pays back within 5 turns | Hand off: 2.5x+ and it pays back within 2 turns |')
  L.push('| **Context** | Fine | | Getting long: context 50%+ used, or auto-compact is about 5 turns away | Hand off: auto-compact is about 2 turns away, or it already happened |')
  L.push('', 'The Cost pill uses the median of your last 3 finished turns, so one odd turn does not flip it. Lost detail cannot be measured directly (nobody can measure model quality), so it uses stand-ins: how full the context is, how near **auto-compact** is (when the context fills up, Claude Code compacts the old conversation into a summary on its own, and detail is lost), and how fast the context grows. A hand-off note you write beats a compaction you did not choose.', '')
  L.push('## Alerts', '')
  L.push('- **In-app toast** (8 seconds, no sound) when a pill gets *worse* (to amber or red). Once per state per session; it re-arms only after the pill improves. Toasts also show over Remote Control.')
  L.push('- **System notification** when the 5H limit will run out within about 30 minutes at the current pace. Once per 5H window, across all sessions. It tries Claude Code\'s own notification first and falls back to a macOS notification (Mac only).', '')

  if (v && v.wins.length > 0) {
    const d = derive(v, last, now)
    L.push('## Your numbers right now', '')
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
      L.push(`**This session:** ${s.turnCount} turns, ${s.subagentCalls} subagent calls, started from a ${fmt(s.base)} context; grows about ${fmt(s.grow)} a turn; ${s.compactionsAll} auto-compacts so far. Since the 5H window began: ${grp(s.since5h.units)} work units = ${d.ok ? pctTxt(d.sesPct) : '?'} of 5H.`, '')
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
  L.push('Anthropic does not say how much work a 5H or 7D window holds. The **ledger** keeps one row per finished window, forever, so a shrinking limit shows up as a drop in **work units per 1%**. `/manapool export` writes it as a CSV (`~/Documents/Mana Pool/manapool-ledger.csv`).', '')
  L.push('- **Work units** weigh each token by type and model at API list prices for the exact model version, 1 unit = one Sonnet 5.5 input token. Raw token counts mislead: a cache-read token costs 1/50 to 1/200 of an output token, so light work in a long session looks huge in raw tokens. The ledger always uses plain list weights, so rows stay comparable even when the cost weights below are re-fitted.')
  L.push('- **Outside use**: points the meter moved with almost no work on this computer behind them (under a quarter of a usual point). Claude.ai chat and the phone app\'s own chats share the limit but write nothing here, so this flags them; it cannot measure them. Remote Control sessions run on this computer and are counted.')
  L.push('- **Meter** is the last reading seen in that window. If no session was open near its end, the true final figure may be a little higher.', '')
  if (ledger.length === 0) {
    L.push('_No finished window recorded yet._', '')
  } else {
    L.push('| Window | Started | Models | Meter | Work units | Per 1% | Raw tokens | Outside use |', '|---|---|---|---|---|---|---|---|')
    for (const r of [...ledger].sort((a, b) => b.start - a.start).slice(0, 40)) {
      L.push(`| ${r.kind === 'five_hour' ? '5H' : '7D'} | ${day(r.start * 1000)} | ${r.models.join(' + ') || '-'} | ${r.pct}% | ${fmt(r.units)} | ${r.per1 ? fmt(r.per1) : '-'} | ${fmt(r.tokens.reduce((a, b) => a + b, 0))} | ${r.outside ? `${r.outside}%?` : 'none'} |`)
    }
    L.push('')
  }
  const fit = v?.fit
  L.push('## History pane', '')
  L.push('The ▤ button (or `/manapool history`) opens charts of past use over 7, 30 or 90 days. Hover a bar or cell for its numbers.')
  L.push('- **Daily**: work per day, one colour per model, in **% of 7D** (work units over the current 7D window\'s units per 1%; plain work units until there is a 7D reading).')
  L.push('- **5H pace**: this window\'s readings against the middle half of your past windows, with the projection to 100%.')
  L.push('- **Limit size**: work per 1% of 5H, one dot per finished window. Hollow dots used under 15% and are noisy; it calls a trend only from 8 solid windows.')
  L.push('- **Projects**: work by the folder a session ran in. **Hours**: work by weekday and hour, local time.')
  L.push('- **Re-reading**: the share of work spent on cache reads, the old conversation sent again on every call. (The turn strip on the band counts a turn\'s re-reading more exactly.)')
  L.push('- Older days come from a one-time read of every transcript the first time the pane has data; Claude Code deletes old transcripts, so `history.json` is where they survive.', '')
  L.push('## Model cost on your own meter', '')
  if (fit) {
    const ms = fit.measured ?? {}
    L.push('How much each model moves your 5H meter per list-price unit, relative to the median tick. 1.0x = exactly what its API list price says. Measured from ticks done 85%+ on one model; used for the cost figures only with 8+ ticks and a tight spread.', '')
    L.push('| Model | Measured | Ticks | Spread | Used in costs |', '|---|---|---|---|---|')
    for (const k of MODELS) {
      const m = ms[k]
      L.push(`| ${cap(k)} | ${m ? `${m.x.toFixed(2)}x` : '-'} | ${fit.model_ticks[k] ?? 0} | ${m ? `±${Math.round(m.spread * 50)}%` : '-'} | ${(fit.MM[k] ?? 1).toFixed(2)}x |`)
    }
    L.push('', `Token-type weights: ${fit.source === 'fit' ? `fitted from ${fit.ticks} ticks (R² ${fit.r2})` : `list prices (a type fit needs 15+ clean ticks with R² 0.5 or better; now ${fit.ticks} ticks${fit.r2 !== null ? `, R² ${fit.r2}` : ''})`}. Fewer turns on a stronger model can still make it the cheaper pick for a task; this table cannot see that.`, '')
  }

  L.push('## How the costs are worked out', '')
  L.push('1. Every model call in the transcripts is priced in work units at the current weights.')
  L.push('2. **Rate**: the 5H meter\'s percent over this window\'s work units (carried over from the last window until this one reaches 3%).')
  L.push('3. A turn = your message to your next message: every call between them, subagents included. **Re-reading** is the old conversation (context at the turn\'s start minus the context the session started from) read on each main call; from the prompt cache it is a cheap cache read; after the cache expired it is a full cache write.')
  L.push(`4. **New session** = the same turn minus the re-reading, plus reading a hand-off allowance of ${grp(v?.handoff?.extra ?? 15000)} tokens per call (the note and a few re-read files). An assumption; real hand-offs vary.`)
  L.push(`5. **Pays back in N turns** = the one-time cost of a hand-off (about ${grp(v?.handoff?.noteOut ?? 3000)} output tokens to write the note, plus the new session storing its starting context) over the saving per turn (median of the last 3 turns).`)
  L.push('6. **Other models**: switch now = caching the whole conversation on that model once, then your recent turns re-priced on it; hand off = the note on your model plus that model caching the new session\'s start, then your recent turns as a new session would run them (history gone, hand-off allowance read), re-priced on it. Cheaper = lower total over the next 5 turns.', '')

  L.push('## How accurate is it?', '')
  L.push('- **Measured:** token counts, calls, turns, subagents, context size, cache timing, auto-compacts, the whole-number percents.')
  L.push('- **Estimated:** the hundredths, the pace and runway, every % of a turn or a switch (they rest on the rate and the weights), the new-session price (it assumes the hand-off allowance).')
  L.push('- **Prices:** each call at its exact model version; cache writes by lifetime (1-hour kind 2x input, 5-minute kind 1.25x input); fast mode 2x; Haiku 5.5 prompts over 100k at its higher tier.')
  const unp = Object.entries(v?.unpriced ?? {})
  if (unp.length) L.push(`- **Not priced:** ${unp.map(([m, n]) => `${m} (${n} calls)`).join(', ')}. Not in the price table, so left out of every figure.`)
  L.push('- **Blind spot:** claude.ai chat and the phone app\'s own chats move the meter but are invisible here.', '')

  L.push('## Where things live', '')
  L.push('- **Reads:** `~/.claude/projects/**/*.jsonl` (Claude Code\'s transcripts, subagents included). Nothing is sent anywhere.')
  L.push('- **Keeps**: in `~/.claude/plugins/data/<plugin>/` (or under `CLAUDE_CONFIG_DIR`) the tick log `samples.jsonl` (one shared file, written under a lock), `scan-cache.json` (what was already read from each transcript, so a refresh reads only new lines) and `history.json` (one row per day for the History pane: work per model, per project folder name and per hour; kept 400 days); in the mod\'s store the ledger, the last numbers for an instant start, and each session\'s turns and alert state (removed after a week unused). Token counts only, no conversation text.')
  L.push('- **Refreshes:** about 1.5 seconds after each of your turns and each meter tick, every 2 minutes otherwise; the cache clock redraws every 30 seconds.')
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

type AlertState = { prev: { cost: number; detail: number }; fired: { cost: number[]; detail: number[] } }
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
  let compactAtRead = 0
  let pruned = 0          // when old per-session entries were last cleared out
  let version = ''        // from plugin.json, shown after the title
  // The Python 3 command that works here, found once.  On Windows `python3`
  // is often missing or the Microsoft Store stub, so `py -3` and `python`
  // are tried next; each must print "3" for Python's major version.
  let py: string[] | undefined
  let alerts: AlertState | undefined
  let backfilling = false  // the one-time history backfill is running

  // Refresh soon after an event, once the transcript is on disk (it lags a
  // moment).  A reply fires two events; `pending` folds them into one refresh.
  let pending = false
  const soon = (sleep: (ms: number) => Promise<void>, now: () => Promise<number>) => {
    if (pending) return
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
    for (const [name, p] of [['cost', d.cost], ['detail', d.detail]] as const) {
      const fired = alerts.fired[name]
      const kept = fired.filter(x => p.lvl >= x) // improving below a level re-arms it
      if (kept.length !== fired.length) { alerts.fired[name] = kept; changed = true }
      if (p.lvl >= 2 && p.lvl > alerts.prev[name] && !alerts.fired[name].includes(p.lvl)) {
        io.toast(`${name === 'cost' ? 'Cost' : 'Context'}: ${p.label}. ${p.why.charAt(0).toUpperCase()}${p.why.slice(1)}.`)
        alerts.fired[name].push(p.lvl)
        changed = true
      }
      if (alerts.prev[name] !== p.lvl) { alerts.prev[name] = p.lvl; changed = true }
    }
    if (changed) await io.set(`alerts:${sid}`, alerts)

    const w5 = d.w5
    if (w5 && w5.resetsAt) {
      const rw = d.runway(w5)
      if (rw.bad && rw.leftMs <= WALL_MS) {
        const done = await io.get('wall5h').catch(() => null)
        if (done !== w5.resetsAt) {
          await io.set('wall5h', w5.resetsAt) // claim it first, so other sessions stay quiet
          const text = `5H runs out in ~${dur(rw.leftMs)} at this pace (resets ${clock(Date.parse(w5.resetsAt))}).`
          io.toast(text)
          const how = await wallNotify(io, text)
          await io.set('wall5hHow', { at: now, how })
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
        if (m && !keep.has(m[2])) await io.del(k)
      }
    } catch { /* pruning is best effort */ }
  }
  // A store write that is refused (store full) prunes and tries once more.
  const save = async (io: IO, k: string, val: unknown, nowMs: number) => {
    try { await io.set(k, val) } catch { await prune(io, nowMs); await io.set(k, val) }
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
      const starts = limits.map(r => (r.resetsAt ? Math.floor(Date.parse(r.resetsAt) / 1000) - SPAN[r.kind] : now - SPAN[r.kind]))
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
        return { kind: r.kind, pct: Math.max(r.percentUsed, seen), resetsAt: r.resetsAt, tokens: sums[String(starts[i])] }
      })
      // % of the 5H limit per work unit: trusted from 3% into the window,
      // carried over from the last window before that.
      const w5 = wins.find(w => w.kind === 'five_hour')
      const saved = (await io.get('rate').catch(() => undefined)) as number | undefined
      const fresh5 = w5 && w5.pct >= 3 && w5.tokens.units > 0 ? w5.pct / w5.tokens.units : undefined
      const rate = fresh5 ?? saved
      if (fresh5) await save(io, 'rate', fresh5, nowMs)
      const nv: View = {
        wins, samples, updatedAt: now, ctx, model, rate,
        // auto-compact switched off: no trigger point, so no "auto-compact in N turns"
        compactAt: compactOff ? undefined : compactAt || sums._compactAt || undefined,
        session: sums._session ?? undefined, weights: sums._weights, long: sums._long, handoff: sums._handoff,
        fit: sums._fit, check: sums._check as Check | null, ledgerCount: ledger.length,
        unpriced: sums._unpriced, history: sums._history,
      }
      await io.show(() => nv)
      // So the next session (and this one after a reload) can draw at once.
      const curSamples = samples.filter(s => wins.some(w => w.kind === s.kind && w.resetsAt === s.resetsAt))
      await save(io, 'last', { ...nv, samples: curSamples, session: undefined }, nowMs)
      if (sid) await save(io, `ses:${sid}`, { session: nv.session, at: now }, nowMs)
      await runAlerts(io, nv, nowMs)
      // Older days of the History pane: read every transcript once, in the
      // background (a few seconds), then refresh to show them.
      if (nv.history && !nv.history.full && !backfilling) {
        backfilling = true
        void io.scan(['--backfill'], '{}', 600000)
          .then(r => { if (r.exitCode === 0) dirty = true; else backfilling = false })
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
      show: fn => update($, view, fn as any),
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
      const t = await $.clock.now()
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
      if (!spinning) return
      await update($, view, v => (v ? { ...v, refreshing: true, frame: ((v.frame ?? 0) + 1) % 10 } : v) as any)
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
    } catch { /* nothing saved yet */ }
    dirty = false
    lastFull = await $.clock.now()
    void refresh(io)
    return next(e)
  })

  on('command.run', { command: CMD }, async ($, e) => {
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
  })

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

  // A limit moved a whole point, or the context changed: refresh soon.
  on('session.measure', async ($, e, next) => {
    dirty = true
    soon(ms => $.clock.sleep(ms), () => $.clock.now())
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
    const v = await read($, view)
    if (e.props.hasSurvey || !v) return next(e)
    const { Box, Text, Button, Svg } = $.ui.resolve(e) as any
    const FR = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
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
          <Text size="caption" dimColor>  {FR[(v.frame ?? 0) % 10]}  reading your transcripts…</Text>
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
    const spin = () => (v.refreshing ? <Text {...note}>  {FR[(v.frame ?? 0) % 10]}</Text> : null)
    const icon = (glyph: string, name: string, onPress: () => void) => <Button key={name} label={glyph} plain dimColor onPress={onPress} />
    const openManual = () => $.ui.open({ id: PANE, title: 'Mana Pool' })
    const openHistory = () => $.ui.open({ id: HPANE, title: 'Mana Pool History' })
    const P = (u: number) => (d.ok ? pctTxt(d.pc(u)) : '—')

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
        `<text x="${W / 2}" y="${ty}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" font-size="12" font-weight="500" fill="${fill}" clip-path="url(#${clip})">${label}</text>`
      const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
        `<defs><linearGradient id="${uid}g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>` +
        `<clipPath id="${uid}r"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath>` +
        `<clipPath id="${uid}f"><rect width="${px}" height="${H}"/></clipPath><clipPath id="${uid}e"><rect x="${px}" width="${Math.max(0, W - px)}" height="${H}"/></clipPath></defs>` +
        `<g clip-path="url(#${uid}r)"><rect width="${W}" height="${H}" fill="${track}"/>${px > 0 ? `<rect width="${px}" height="${H}" fill="url(#${uid}g)"/>` : ''}</g>` +
        txt('#1d1d1d', `${uid}f`) + txt('#ececec', `${uid}e`) + `</svg>`
      return <Box width={Math.ceil(W / 8.8)} flexShrink={0}><Svg source={src} alt={label} width={W} height={H} /></Box>
    }

    // A verdict pill: tinted capsule with coloured text (12% of the colour over the band: 4.5:1+ for every level).
    // outline: Mini's pill also carries the level in its border, only when
    // something needs attention: dotted for amber, dashed for red.  Green and
    // blue stay a plain tinted pill so a calm state stays quiet.
    // W: a fixed width (Mini's pill matches its bars); otherwise sized to the label.
    // right: the pill ends at its box's right edge (its box is rounded up to
    // whole cells, so a left-aligned pill would stop a few pixels short).
    const pill = (p: Pill, uid: string, outline = false, H = 20, W = 0, right = false) => {
      const col = LVL[p.lvl]
      if (Svg) {
        const wpx = W || Math.round(p.label.length * 6.9 + 22)
        const ty = Math.round(H / 2 + 4) // text baseline, centred for 12 px type
        const dash = p.lvl === 2 ? ' stroke-dasharray="0.1 3.2" stroke-linecap="round"' : p.lvl === 3 ? ' stroke-dasharray="5 3"' : ''
        const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wpx} ${H}" width="${wpx}" height="${H}">` +
          `<rect width="${wpx}" height="${H}" rx="${H / 2}" fill="${mix(SURFACE, col, 0.12)}"/>` +
          (outline && p.lvl >= 2 ? `<rect x="0.75" y="0.75" width="${wpx - 1.5}" height="${H - 1.5}" rx="${(H - 1.5) / 2}" fill="none" stroke="${col}" stroke-width="1.5"${dash}/>` : '') +
          `<text x="${wpx / 2}" y="${ty}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" font-size="12" fill="${col}">${p.label}</text></svg>`
        return <Box key={uid} width={Math.ceil(wpx / 8.8)} flexShrink={0} justifyContent={right ? 'flex-end' : 'flex-start'}><Svg source={src} alt={p.label} width={wpx} height={H} /></Box>
      }
      return <Text key={uid} color={col}>[{p.label}]</Text>
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
      return (
        <Box paddingX={1} justifyContent="space-between" alignItems="center">
          <Box alignItems="center">
            <Box flexShrink={0}><Text size="footnote" weight="semibold" wrap="truncate">Mana Pool</Text>{spin()}</Box>
            {wins.map(w => (
              <Box key={w.kind} marginLeft={2} flexShrink={0} alignItems="center">
                <Text {...lab} wrap="truncate">{tag(w)} </Text>
                {barIn(d.est(w) / 100, `${d.est(w).toFixed(1)}%`, MINI_W, 16, `m${w.kind}`)}
                {w.kind === 'five_hour' && rw5?.bad ? <Text {...ft} color={RED}> runs out in {dur(rw5.leftMs)}</Text> : null}
              </Box>
            ))}
            {/* The last turn: grey label, then a pill coloured by the worse of
                Cost and Context; a dotted (amber) or dashed (red) border marks a warning. */}
            {d.lt ? (
              <Box marginLeft={2} flexShrink={0} alignItems="center">
                <Text {...lab} wrap="truncate">Last turn </Text>
                {pill({ ...d.worst, label: `${P(d.lt.u)} · ${d.ratio.toFixed(1)}x` }, 'mini', true, 16, MINI_W)}
              </Box>
            ) : null}
            {/* Prompt cache clock: minutes until it expires (after that the next
                message pays a one-time cache write), or Expired. */}
            {d.idle !== null ? (
              <Box marginLeft={2} flexShrink={0} alignItems="center">
                <Text {...lab} wrap="truncate">Cache </Text>
                <Text {...ft} color={d.warm ? '#f6b26b' : '#7fb2ff'}>{d.warm ? dur(TTL_MS - d.idle) : d.otherModel ? 'Cold' : 'Expired'}</Text>
              </Box>
            ) : null}
          </Box>
          <Box alignItems="center">
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
    const showChk = !!chk && chk.lo !== null && chk.hi !== null && chk.per1 !== null && chk.pct >= 5
    // Limit check in words: how much work 1% of 5H buys now against your usual
    // (the middle of your past windows).  Unit counts stay in the ledger.
    const chkMid = showChk ? ((chk!.lo as number) + (chk!.hi as number)) / 2 : 0
    const chkDelta = showChk && chkMid > 0 ? (chk!.per1 as number) / chkMid - 1 : 0
    const chkLow = showChk && chkDelta <= -0.15
    const chkPct = Math.round(Math.abs(chkDelta) * 100)
    const chkCmp = chkPct === 0 ? 'about the same work as usual' : `${chkPct}% ${chkDelta < 0 ? 'less' : 'more'} work than usual`
    const COLW = 23 // one model column in the Other models table, in cells (14 + 3 x 23 = 83)
    // A hairline between sections, the band's full width.  Sections are spaced
    // the same way everywhere: one small step above and below each line, and
    // no extra space between the rows inside a section.
    const cols = (e.props.bodyColumns as number) || 90
    // Every Full row shares one right edge: the bars' (two 40-cell columns
    // and a 3-cell gap).  Rows below used to stretch to the band's own edge.
    const CW = Math.min(83, cols - 2)
    const sep = (k: string) => {
      // A 9 px strip with a 1 px line through its middle: the strip is the
      // spacing, so no margins (a full text row per line made Full scroll).
      const W = Math.round(CW * 8.8)
      return (
        <Box key={k} flexShrink={0}>
          {Svg
            ? <Svg source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 9" width="${W}" height="9"><rect y="4" width="${W}" height="1" fill="#474747"/></svg>`} alt="divider" width={W} height={9} />
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
        <Box marginTop="sm">
          {wins.map((w, wi) => {
            const rw = d.runway(w)
            const est = d.est(w)
            return (
              <Box key={w.kind} flexDirection="column" flexShrink={0} width={40} marginRight={wi === 0 ? 3 : 0}>
                {/* One line above the bar: percent and pace; reset time on the right.
                    Only when it would run out first does the right side turn red
                    and say so (pace is dropped then, to make room). */}
                <Box justifyContent="space-between">
                  <Text>
                    <Text {...lab}>{tag(w)}  </Text>
                    <Text size="footnote" weight="medium" tabular dimColor={!!v.refreshing} color={tone(w.pct)}>{est === w.pct ? '' : '~'}{est.toFixed(2)}%</Text>{spin()}
                    {!rw.bad && rw.r > 0 ? <Text {...fn}>{' · '}{paceTxt(w, rw.r)}</Text> : null}
                  </Text>
                  {rw.bad
                    ? <Text size="footnote" color={RED}>{rw.text} · resets in {w.resetsAt ? dur(Date.parse(w.resetsAt) - now) : '?'}</Text>
                    : <Text {...fn}>resets in {w.resetsAt ? dur(Date.parse(w.resetsAt) - now) : '?'}</Text>}
                </Box>
                {bar(est / 100, 352, 12, `g${w.kind}`)}
              </Box>
            )
          })}
        </Box>

        {/* Last turn: cost, the same turn fresh, the ratio, the hand-off pay-back, the Cost pill. */}
        <Box marginTop="sm" justifyContent="space-between">
          <Box>
            {Lab('Last turn')}
            {d.lt ? (
              <Text>
                <Text size="footnote" tabular>{P(d.lt.u)}</Text>
                <Text {...fn}> of 5H · in a new session ~{P(d.lt.f)} (</Text>
                <Text size="footnote" tabular>{d.ratio.toFixed(1)}x</Text>
                <Text {...fn}>) · hand-off: {d.turnsTxt(d.payback)}</Text>
              </Text>
            ) : <Text {...fn}>no finished turn yet</Text>}
          </Box>
          {pill(d.cost, 'cost', false, 16, 0, true)}
        </Box>

        {/* Next turn: what your next turn here should cost, from your last 3 turns. */}
        {d.lt ? (
          <Box>
            {Lab('Next turn')}
            <Text>
              <Text size="footnote" tabular>~{P(d.nextU)}</Text>
              <Text {...fn}> of 5H on {cap(d.me)} (current), from your last {d.fin.length === 1 ? 'turn' : `${d.fin.length} turns`}</Text>
            </Text>
          </Box>
        ) : null}

        {/* Turns: the strip, then this session's turns and its share of 5H since the window began. */}
        <Box justifyContent="space-between">
          <Box>
            {Lab('Turns')}
            {strip()}
            <Text {...fn}>{d.ses ? `${d.ses.turnCount} turn${d.ses.turnCount === 1 ? '' : 's'} · used ${P(d.ses.since5h.units)} of 5H${share !== null && share !== undefined ? ` · ${Math.round(share * 100)}% of last hour's use` : ''}` : 'no turns yet'}</Text>
          </Box>
          <Text size="footnote"><Text color={HIST}>■</Text><Text {...fn}> re-reading  </Text><Text color={ME}>■</Text><Text {...fn}> new work</Text></Text>
        </Box>

        {/* Context: size, % used, growth and auto-compact, with the Context pill. */}
        <Box justifyContent="space-between">
          <Box>
            {Lab('Context')}
            <Text {...fn}>{d.detail.why}</Text>
          </Box>
          {pill(d.detail, 'detail', false, 16, 0, true)}
        </Box>

        {/* Prompt cache clock and what its expiry costs. */}
        <Box>
          {Lab('Cache')}
          <Text>
            <Text size="footnote" color={d.idle === null ? DIM : d.warm ? '#f6b26b' : '#7fb2ff'}>{d.idle === null ? 'No reply yet' : d.warm ? 'Active' : d.otherModel ? 'Model changed' : 'Expired'}</Text>
            <Text {...fn}>
              {d.idle === null ? '' : d.warm
                ? ` · expires in ${dur(TTL_MS - d.idle)} · after that, next message costs +${P(d.reloadU)} to re-cache`
                : ` · next message costs +${P(d.reloadU)} to re-cache ${fmt(d.ctxTok)} · a new session caches ${fmt(d.base + d.ho.extra)}`}
            </Text>
          </Text>
        </Box>

        {/* Limit check: how much work 1% of 5H buys now against your usual. */}
        {showChk ? (
          <Box>
            {Lab('Limit check')}
            <Text>
              {chkLow
                ? <Text size="footnote" color={RED}>1% of 5H buys {chkCmp}</Text>
                : <Text><Text size="footnote">normal</Text><Text {...fn}> · 1% of 5H buys {chkCmp}</Text></Text>}
              {chk!.outside > 0 ? <Text size="footnote" color={RED}> · {chk!.outside}% used outside Claude Code</Text> : null}
            </Text>
          </Box>
        ) : null}

        {/* Other models: two ways to move to each, a one-time cost then a per-turn
            cost; the cheaper path over the next 5 turns in green. */}
        {sep('sep2')}
        <Box flexDirection="column">
          <Box>
            {Lab('Other models')}
            {d.switchRows.map(r => <Box key={r.k} width={COLW} flexShrink={0}><Text size="footnote">{cap(r.k)}</Text></Box>)}
          </Box>
          {([['now', 'switch now'], ['handoff', 'hand off']] as const).map(([path, name]) => (
            <Box key={path}>
              {Lab(name)}
              {d.switchRows.map(r => {
                const once = path === 'now' ? r.nowOnce : r.hoOnce
                const turn = path === 'now' ? r.nowTurn : r.hoTurn
                const best = r.pick === path
                return (
                  <Box key={r.k} width={COLW} flexShrink={0}>
                    <Text size="footnote" tabular color={best ? LVL[0] : undefined} dimColor={!best}>
                      {d.ok ? `+${pctTxt(once)}, then ${pctTxt(turn)}/turn` : '—'}
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
    const { Box, Text, Button, Svg } = $.ui.resolve(e) as any
    const v = await read($, view)
    if (!v) return <Text dimColor>Reading transcripts…</Text>
    const range = ((await read($, rangeAtom)) ?? 30) as HistRange
    const last = (await read($, lastReply)) ?? (v.session?.lastSeen ? v.session.lastSeen * 1000 : null)
    const ledger = ((await $.store.get('ledger').catch(() => [])) ?? []) as LedgerRow[]
    // The pane's width: its columns over the code font's advance (8.8 px, the
    // same figure the band sizes its boxes by), less a little slack.
    const cols = Number(e.props?.bodyColumns) || 0
    const hv = historyView(v, ledger, range, last, Date.now(), cols > 0 ? cols * 8.8 - 12 : 424)
    // Each chart is given its exact size, so none is centred or rescaled.
    const dims = (svg: string) => {
      const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
      return m ? { width: +m[1], height: +m[2] } : {}
    }
    const pick = (r: HistRange) => (
      <Button key={`range${r}`} label={`${r}D`} {...(r === range ? { variant: 'primary' } : { plain: true, dimColor: true })}
        onPress={() => update($, rangeAtom, () => r)} />
    )
    // A legend: a coloured square, then the name in text colour (identity never by colour alone).
    const legend = (items?: { name: string; col: string }[]) => items?.length ? (
      <Box flexWrap="wrap" columnGap={2}>
        {items.map(it => <Text key={it.name} size="footnote"><Text color={it.col}>■</Text><Text dimColor> {it.name}</Text></Text>)}
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
        {section('Limit size', hv.limit)}
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
