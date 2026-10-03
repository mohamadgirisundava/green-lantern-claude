import type { On, SessionRateLimit, Settings } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const NOW = Date.parse('2026-10-03T10:00:00Z')
const MIN = 60_000
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const
// A subscription within its limits: Claude Code's automatic cache TTL is 1h.
const SUBSCRIPTION: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 29, resetsAt: new Date(NOW + 10 * MIN).toISOString() },
  { kind: 'seven_day', percentUsed: 82, resetsAt: new Date(NOW + (16 * 60 + 10) * MIN).toISOString() },
]

/** Answers what the mod asks the engine for at session start, and one model step. */
function answerSession(
  on: On,
  {
    rateLimits = [],
    settings = {},
    env = {},
    model = 'claude-opus-5-5',
    turns = 1,
  }: { rateLimits?: SessionRateLimit[]; settings?: Settings; env?: Record<string, string>; model?: string; turns?: number } = {},
) {
  mock.env(on, env)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: 59_000, window: 1_000_000, percent: 6 }, rateLimits },
  }))
  on('session.model', () => ({ value: model }))
  on('session.turns', () => ({ value: turns }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.root', () => ({ value: '/Users/someone/coding/projects/cv' }))
  on('settings.read', () => ({ value: settings }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/Users/someone/coding/projects/cv', surface: 'terminal', isInteractive: true })

/** One main-thread model response, its stream read to the end. */
async function respond($: Engine, effort?: 'xhigh') {
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(effort ? { effort } : {}) })
  for await (const _ of step);
}

/** The text of the usage line. */
const hairline = async (ui: { find: (query: { type: string; text: RegExp }) => Promise<{ text: string } | undefined> }) =>
  (await ui.find({ type: 'Text', text: /^› / }))?.text

test('draws the model badge and the usage hairline, then counts a 1h cache down', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  answerSession(on, { rateLimits: SUBSCRIPTION, settings: { effortLevel: 'high' }, model: 'opus' })
  await start($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'green-lantern', surface, ...BAND })
    // Before the first turn: the settings' effort, the alias as /model shows it, no cache yet.
    expect(await ui.find({ type: 'Box', text: /^\[Opus high\] │ cv$/ })).toBeDefined()
    // Plenty left is lantern green; a quarter or less fades to a lighter glow.
    expect((await ui.find({ type: 'Text', text: /^ 71%$/ }))?.props.color).toBe('#3DDC84')
    expect((await ui.find({ type: 'Text', text: /^ 18%$/ }))?.props.color).toBe('#7DFFAF')
    // Battery logic: the bars show the charge left (29% used is 71% left; 82% used is 18% left).
    expect(await hairline(ui)).toBe('› 5h ▰▰▰▰▰▰▱▱ 71% ↻10m  › 7d ▰▱▱▱▱▱▱▱ 18% ↻16h10m  › 59k/1.0M')
    await ui.unmount()
  }

  // A main-thread turn names the resolved model and effort and starts the cache countdown.
  await respond($, 'xhigh')
  await clock.advance(61_000)
  const ui = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Box', text: /^\[Opus 5\.5 xhigh\] │ cv$/ })).toBeDefined()
  // Effort is a power ramp: xhigh glows.
  expect((await ui.find({ type: 'Text', text: /^xhigh$/ }))?.props.color).toBe('#7DFFAF')
  expect(await hairline(ui)).toMatch(/› cache 59m$/)

  // Seconds only in the last two minutes.
  await clock.advance(57 * MIN)
  expect(await hairline(ui)).toMatch(/› cache 1m59s$/)
  await clock.advance(2 * MIN)
  expect(await hairline(ui)).toMatch(/› cache expired$/)
})

test('the promptCacheTtl setting wins over the automatic TTL', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  answerSession(on, { rateLimits: SUBSCRIPTION, settings: { promptCacheTtl: '5m' } })
  await start($)
  await respond($)

  await clock.advance(61_000)
  const ui = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...BAND })
  expect(await hairline(ui)).toMatch(/› cache 4m$/)
  await clock.advance(2 * MIN)
  expect(await hairline(ui)).toMatch(/› cache 1m59s$/)
})

test('CLAUDE_CODE_PROMPT_CACHE_TTL wins over the setting', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  answerSession(on, { settings: { promptCacheTtl: '5m' }, env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } })
  await start($)
  await respond($)

  await clock.advance(61_000)
  const ui = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...BAND })
  expect(await hairline(ui)).toMatch(/› cache 59m$/)
})

test('steps back while a survey holds the band', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  // Stands for the engine's own drawing of the band (the survey).
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })
  await start($)

  const ui = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: 'survey' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Opus/ })).toBeUndefined()
})

test('wakes every second only for the countdown’s last stretch', async ($, on) => {
  // Every wake of either clock writes hud.now: count the writes.
  let wakes = 0
  on('state.set', ($, e, next) => {
    if (e.plugin === 'green-lantern' && e.key === 'now') wakes += 1
    return next(e)
  })
  const clock = mock.clock(on, { now: NOW })
  // No subscription windows: the automatic TTL is 5m.
  answerSession(on)
  await start($)

  // Idle before any response: the 30s clock alone, 10 wakes in 5 minutes.
  wakes = 0
  await clock.advance(5 * MIN)
  expect(wakes).toBe(10)

  // A response: 20 wakes of the 30s clock in 10 minutes, plus the 1s clock for the last 150s.
  await respond($)
  wakes = 0
  await clock.advance(10 * MIN)
  expect(wakes).toBeGreaterThanOrEqual(20 + 148)
  expect(wakes).toBeLessThanOrEqual(20 + 152)

  wakes = 0
  await clock.advance(10 * MIN)
  expect(wakes).toBe(20)
})

test('closes a turn with a Lantern word', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  // Stands for the engine's own drawing of the row, from the word it is handed.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'TurnDuration' ? `${e.props.word} for 1m 12s` : ''}</Text>
  })
  await start($)

  const words = new Set<string>()
  for (const requestId of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    const ui = await $.ui.mount({
      plugin: 'green-lantern',
      surface: 'terminal',
      component: 'TurnDuration',
      props: { word: 'Baked', durationMs: 72_000 },
      requestId,
    })
    const row = (await ui.find({ type: 'Text', text: / for 1m 12s$/ }))?.text ?? ''
    expect(row).toMatch(/^(Forged|Charged|Constructed|Patrolled|Channeled|Recharged|Shone|Willed) for 1m 12s$/)
    words.add(row)
    await ui.unmount()
    // The same row keeps its word on every redraw.
    const again = await $.ui.mount({
      plugin: 'green-lantern',
      surface: 'terminal',
      component: 'TurnDuration',
      props: { word: 'Cooked', durationMs: 72_000 },
      requestId,
    })
    expect((await again.find({ type: 'Text', text: / for 1m 12s$/ }))?.text).toBe(row)
    await again.unmount()
  }
  expect(words.size).toBeGreaterThan(1)
})

const WORKING = { ...BAND, props: { ...BAND.props, isWorking: true } }

test('the effort label holds still, colored by its level, even while Claude works', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on, { rateLimits: SUBSCRIPTION })
  await start($)

  for (const [effort, color] of [['xhigh', '#7DFFAF'], ['high', '#3DDC84']] as const) {
    const step = $.turn.step({ turnId: `t-${effort}`, index: 0, model: 'claude-opus-5-5', effort, messageCount: 1 })
    for await (const _ of step);
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'green-lantern', surface, ...WORKING })
      expect(await ui.find({ type: 'Client' })).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: new RegExp(`^${effort}$`) }))?.props.color).toBe(color)
      await ui.unmount()
    }
  }
})

type SpinnerMode = 'requesting' | 'thinking' | 'responding' | 'tool-input' | 'tool-use'
const spinner = (mode: SpinnerMode, message: string | null = null) =>
  ({ component: 'Spinner', props: { word: 'Sauteing', message, suffix: '…', mode } }) as const

/** Stands for the engine's own spinner row: its glyph, its word or message, its timer. */
function engineSpinner(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'Spinner' ? `✻ ${e.props.message ?? e.props.word}… (56s)` : ''}</Text>
  })
}

test('the spinner word follows what Claude is doing, and a state message keeps its words', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  const words: [SpinnerMode, string][] = [
    ['requesting', 'Charging'],
    ['thinking', 'Focusing'],
    ['responding', 'Forging'],
    ['tool-input', 'Shaping'],
    ['tool-use', 'Constructing'],
  ]
  for (const [mode, word] of words) {
    const ui = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...spinner(mode) })
    expect(await ui.find({ type: 'Text', text: `✻ ${word}… (56s)` })).toBeDefined()
    await ui.unmount()
  }
  const busy = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...spinner('thinking', 'Compacting conversation') })
  expect(await busy.find({ type: 'Text', text: '✻ Compacting conversation… (56s)' })).toBeDefined()
})

/** One layer over the engine's spinner: the power row (on its empty spacer row) and the ring cell (over its glyph). */
async function layer(ui: { find: (q: { type: string; text: string | RegExp; in?: string }) => Promise<{ text: string } | undefined> }, key: string) {
  const power = (await ui.find({ type: 'Text', text: /^ /, in: key }))?.text
  const ring = (await ui.find({ type: 'Text', text: /^[◌○◎◉⊜]$/, in: key }))?.text
  return { power, ring }
}

test('the ring takes the glyph’s cell and its power rides the row above: nothing of the engine’s moves', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'green-lantern', surface, ...spinner('responding') })
    expect(await ui.find({ type: 'Text', text: '✻ Forging… (56s)' })).toBeDefined()
    const boxes = await ui.findAll({ type: 'Box' })
    // No spacer pushing the engine's rows right: the only layout box is the layer, which takes no room.
    expect(boxes.some(b => typeof b.props.width === 'number')).toBe(false)
    expect(boxes.find(b => b.props.position === 'absolute')?.props).toMatchObject({ position: 'absolute', top: 0, left: 0 })
    expect((await ui.find({ type: 'Client' }))?.key).toBe('ring-flowing')
    const { power, ring } = await layer(ui, 'ring-flowing')
    expect(ring).toBe('⊜')
    expect(power).toMatch(/^ [\u2800-\u28FF]{8}$/)
    await ui.unmount()
  }
})

test('each mode has its ring and its power, and both move', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  const cases: [SpinnerMode, string, RegExp, RegExp][] = [
    ['requesting', 'ring-charging', /^[◌○◎◉⊜]$/, /^ $/],
    ['thinking', 'ring-focusing', /^◉$/, /^ [\u2800-\u28FF]{8}$/],
    ['responding', 'ring-flowing', /^⊜$/, /^ [\u2800-\u28FF]{8}$/],
    ['tool-use', 'ring-surging', /^⊜$/, /^ [\u2800-\u28FF]{8}$/],
  ]
  for (const [mode, key, ring, power] of cases) {
    const ui = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...spinner(mode) })
    const before = await layer(ui, key)
    expect(before.ring).toMatch(ring)
    expect(before.power).toMatch(power)
    await ui.advance(110 * 2)
    const after = await layer(ui, key)
    // Something visibly changed: the ring glyph, or the power row.
    expect(after.ring !== before.ring || after.power !== before.power).toBe(true)
    await ui.unmount()
  }
})

test('reduced motion leaves the engine’s row as it is', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on, { settings: { prefersReducedMotion: true } })
  engineSpinner(on)
  await start($)

  const ui = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...spinner('responding') })
  expect(await ui.find({ type: 'Text', text: '✻ Forging… (56s)' })).toBeDefined()
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Box' })).some(b => b.props.position === 'absolute')).toBe(false)
})

test('tools make the power surge: the same braid, faster and brighter, no extra shapes', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  for (const mode of ['tool-input', 'tool-use'] as const) {
    const ui = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...spinner(mode) })
    expect((await ui.find({ type: 'Client' }))?.key).toBe('ring-surging')
    // Only the ring and its braid: the ring in the glyph's cell, eight braille cells of power above.
    const before = await layer(ui, 'ring-surging')
    expect(before.ring).toBe('⊜')
    expect(before.power).toMatch(/^ [\u2800-\u28FF]{8}$/)
    await ui.advance(110)
    expect((await layer(ui, 'ring-surging')).power).not.toBe(before.power)
    await ui.unmount()
  }
})

const welcomeShown = async (ui: { find: (q: { type: string; text: string | RegExp }) => Promise<unknown> }) =>
  (await ui.find({ type: 'Text', text: /GREEN LANTERN CORPS/ })) !== undefined

test('a fresh session opens with the Lantern emblem and the oath, until the first prompt', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on, { rateLimits: SUBSCRIPTION, turns: 0, settings: { effortLevel: 'xhigh' } })
  await start($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'green-lantern', surface, ...BAND })
    expect(await welcomeShown(ui)).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^ ▀+ $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /In brightest day, in blackest night,/ })).toBeDefined()
    // The model line moves into the emblem's side panel; the usage line stays below.
    expect(await ui.find({ type: 'Text', text: /^Opus 5\.5 · xhigh · cv$/ })).toBeDefined()
    expect(await ui.find({ type: 'Box', text: /^\[Opus/ })).toBeUndefined()
    expect(await hairline(ui)).toMatch(/^› 5h/)
    await ui.unmount()
  }

  // The first prompt folds it back into the everyday HUD.
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  const after = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...BAND })
  expect(await welcomeShown(after)).toBe(false)
  expect(await after.find({ type: 'Box', text: /^\[Opus 5\.5 xhigh\] │ cv$/ })).toBeDefined()
  await after.unmount()

  // /clear is a clean slate: the emblem comes back.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  const cleared = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...BAND })
  expect(await welcomeShown(cleared)).toBe(true)
})

test('a resumed session, or a band too small, gets the everyday HUD', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on, { rateLimits: SUBSCRIPTION, turns: 3 })
  await start($)
  const resumed = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...BAND })
  expect(await welcomeShown(resumed)).toBe(false)
})

test('the emblem steps aside when the band cannot fit it', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on, { rateLimits: SUBSCRIPTION, turns: 0 })
  await start($)
  const short = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...BAND, props: { ...BAND.props, maxRows: 5 } })
  expect(await welcomeShown(short)).toBe(false)
  expect(await short.find({ type: 'Box', text: /^\[Opus/ })).toBeDefined()
  await short.unmount()
  const narrow = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 30 } })
  expect(await welcomeShown(narrow)).toBe(false)
})

test('the power is liquid and particles, not a scroll', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  for (const [mode, key] of [['responding', 'ring-flowing'], ['tool-use', 'ring-surging']] as const) {
    const ui = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...spinner(mode) })
    const rows: string[] = []
    for (let f = 0; f < 6; f++) {
      rows.push(((await layer(ui, key)).power ?? '').slice(1))
      await ui.advance(110)
    }
    for (const row of rows) expect([...row].some(ch => ch !== '\u2800')).toBe(true) // there is liquid
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1] ?? '', rows[i] ?? '']
      expect(b).not.toBe(a)
      // Not the previous frame slid one cell either way: the surface changes shape as it moves.
      expect(b.slice(1)).not.toBe(a.slice(0, -1))
      expect(b.slice(0, -1)).not.toBe(a.slice(1))
    }
    await ui.unmount()
  }
})

/** How many dots a braille row lights: its density. */
const lit = (row: string) => [...row].reduce((n, ch) => {
  let bits = (ch.codePointAt(0) ?? 0x2800) - 0x2800
  for (; bits > 0; bits >>= 1) n += bits & 1
  return n
}, 0)

test('the power looks the same at every effort', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  // A dozen frames of a mode's power row, at one effort.
  const frames = async (effort: 'low' | 'xhigh' | 'max', mode: SpinnerMode, key: string) => {
    const step = $.turn.step({ turnId: `t-${effort}-${mode}`, index: 0, model: 'claude-opus-5-5', effort, messageCount: 1 })
    for await (const _ of step);
    const ui = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...spinner(mode) })
    const rows: string[] = []
    for (let f = 0; f < 12; f++) {
      rows.push((await layer(ui, key)).power ?? '')
      await ui.advance(110)
    }
    await ui.unmount()
    return rows
  }

  for (const [mode, key] of [['thinking', 'ring-focusing'], ['responding', 'ring-flowing'], ['tool-use', 'ring-surging']] as const) {
    const low = await frames('low', mode, key)
    expect(await frames('xhigh', mode, key)).toEqual(low)
    expect(await frames('max', mode, key)).toEqual(low)
  }
})

test('the limits read as charge left, fading from lantern green to pale as they drain; empty warns', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await start($)

  const cases: [number, string, string][] = [
    [0, '› 5h ▰▰▰▰▰▰▰▰ 100% ↻10m', '#3DDC84'],
    [75, '› 5h ▰▰▱▱▱▱▱▱ 25% ↻10m', '#7DFFAF'],
    [90, '› 5h ▰▱▱▱▱▱▱▱ 10% ↻10m', '#E0FFEC'],
    [100, '› 5h ⚠ ↻10m', '#E0FFEC'],
  ]
  for (const [used, line, color] of cases) {
    await $.session.measure({
      context: { tokens: 59_000, window: 1_000_000, percent: 6 },
      rateLimits: [{ kind: 'five_hour', percentUsed: used, resetsAt: new Date(NOW + 10 * MIN).toISOString() }],
      changed: ['rateLimits'],
    })
    const ui = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...BAND })
    expect(await hairline(ui)).toMatch(new RegExp(`^${line.replace(/[[\]()]/g, '\\$&')}`))
    const charge = used >= 100 ? /^⚠/ : new RegExp(`^ ${100 - used}%$`)
    expect((await ui.find({ type: 'Text', text: charge }))?.props.color).toBe(color)
    await ui.unmount()
  }
})

