// Mana Pool: the shapes the mod keeps.  Numbers, model names and project names, never conversation text.

// Raw token counts of one span of calls.
export type Tokens = {
  input: number; output: number; cache_write: number; cache_read: number; messages: number
  units: number       // work units at the current weights (see the manual)
  listUnits?: number  // the same at plain list weights: the ledger's fixed yardstick
  turns?: number
  models?: Record<string, { input: number; output: number; cache_write: number; cache_read: number; units: number }>
}
// One limit window as last read.
export type Win = { kind: string; pct: number; resetsAt?: string; tokens: Tokens }
// One real tick of a meter: the window's totals at the moment its percent moved.
// lu = list units of the window so far (for the hundredths and the audit).
export type Sample = { at: number; kind: string; pct: number; fresh?: number; lu?: number; resetsAt?: string; mix?: number[]; models?: Record<string, number[]> }
// One turn of this session (your message plus the full reply, subagents included).
// u = its work units, h = the part spent re-reading the old conversation,
// f = the same turn in a fresh session after a hand-off, n = model calls.
// on / onf = the same turn priced on each model: as it ran here, and in a new
// session after a hand-off (work units, current weights).
export type Turn = { t: number; u: number; h: number; f: number; n: number; subs: number; out: number; ctx: number; k: string; live?: boolean; on?: Record<string, number>; onf?: Record<string, number> }
// This session, from scan.py.
export type Session = {
  since5h: { input: number; output: number; cache_write: number; cache_read: number; messages: number; units: number }
  allOn: Record<string, number>
  base: number; grow: number
  turns: Turn[]; turnCount: number; turnsIn5h: number
  share1h: number | null; hourUnits: number
  compactions: number; compactionsAll: number; lastCompact: number | null
  lastSeen: number | null; subagentCalls: number
  lastModel?: string | null  // family of the newest main-thread reply: whose prompt cache it is
}
// One finished window, kept forever (the limit audit).
export type LedgerRow = {
  kind: string; resetsAt: string; start: number; end: number; pct: number; seen: number
  units: number; per1: number | null; tokens: number[]; byModel?: Record<string, number[]>
  models: string[]; outside: number; weights: string; at: number; readings: number
  rule?: number  // the accounting rule it was built under (scan.py RULE)
}
export type Fit = {
  source: string; ticks: number; r2: number | null; K: number[]; MM: Record<string, number>
  model_ticks: Record<string, number>; kept?: number
  measured?: Record<string, { x: number; ticks: number; used: number; trust: number; lo: number; hi: number }>
}
// One local calendar day of work (scan.py's history.json): work units at list
// prices per model (m), per project folder (p) and per hour of the day (h),
// the part spent re-reading the conversation (r), and model calls (n).
export type HistDay = { m: Record<string, number>; p: Record<string, number>; h: number[]; r: number; n: number }
// full = older days were filled in from every transcript (the one-time backfill).
export type History = { full: boolean; days: Record<string, HistDay> }
export type Check = { per1: number | null; pct: number; lo: number | null; hi: number | null; n: number; outside: number }
export type View = {
  wins: Win[]
  samples: Sample[]
  updatedAt: number
  ctx?: { tokens: number; window: number; percent?: number }
  compactAt?: number      // tokens at which Claude Code auto-summarizes
  model?: string
  rate?: number           // % of the 5H limit per work unit
  session?: Session
  weights?: Record<string, number[]>  // units per token: input, output, cache write, cache read
  long?: Record<string, { over: number; w: number[] }>  // long-prompt tier: past `over` tokens, weights `w`
  handoff?: { extra: number; noteOut: number }
  fit?: Fit
  check?: Check | null
  ledgerCount?: number
  unpriced?: Record<string, number>  // model id -> calls left out: not in the price table
  history?: History                  // the last 92 days, for the History pane
  refreshing?: boolean
  frame?: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'manapool': {
      view: Shaped<View | null>
      // 'full' = the detailed band, 'mini' = one line.
      mode: Shaped<'full' | 'mini'>
      // When the last reply landed (ms): the prompt cache's clock.
      lastReply: Shaped<number | null>
      // True while one of your turns is running.
      busy: Shaped<boolean>
      // The History pane's range in days.
      range: Shaped<7 | 30 | 90>
    }
  }
}
