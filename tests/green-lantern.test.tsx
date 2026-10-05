import type { On, SessionRateLimit, Settings } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ACTS_OF, actOf, powerFrame, SLOT_OF, type ActName, type PowerKind } from '../hooks/power'

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

type Finder = { find: (q: { type: string; text?: string | RegExp; in?: string }) => Promise<{ text: string } | undefined> }

/** The ring over the engine's spinner glyph: its one cell. */
const ringIn = async (ui: Finder, key: string) => (await ui.find({ type: 'Text', text: /^[◌○◎◉⊜]$/, in: key }))?.text

/** The power beside the project in the band's badge row: its sixteen cells. */
const powerIn = async (ui: Finder, key: string) => (await ui.find({ type: 'Text', in: key }))?.text

// Braille, or one of the power's single-width glyphs: never an emoji, which takes two cells.
const POWER_ROW = /^[⠀-⣿┿┄▷━═▶╳⁘·˙╱╲◆✦✧─ϟ]{16}$/u

/** Claude at work in a mode: the spinner's ring appears and tells the band, which draws the power. */
async function working(
  $: Engine,
  mode: SpinnerMode,
  { surface = 'terminal', bodyColumns = BAND.props.bodyColumns }: { surface?: 'terminal' | 'desktop'; bodyColumns?: number } = {},
) {
  const spin = await $.ui.mount({ plugin: 'green-lantern', surface, ...spinner(mode) })
  const hud = await $.ui.mount({ plugin: 'green-lantern', surface, ...WORKING, props: { ...WORKING.props, bodyColumns } })
  return { spin, hud }
}

/** Frames of a mode's power, one per step of its clock. */
async function frames($: Engine, mode: SpinnerMode, kind: string, count: number) {
  const { spin, hud } = await working($, mode)
  const rows: string[] = []
  for (let f = 0; f < count; f++) {
    rows.push((await powerIn(hud, `power-${kind}`)) ?? '')
    await hud.advance(110)
  }
  await spin.unmount()
  await hud.unmount()
  return rows
}

test('the ring takes the glyph’s cell on the verb row at every width: nothing of the engine’s moves', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  for (const surface of SURFACES) {
    for (const columns of [80, 160]) {
      const ui = await $.ui.mount({ plugin: 'green-lantern', surface, viewport: { columns, rows: 40 }, ...spinner('responding') })
      expect(await ui.find({ type: 'Text', text: '✻ Forging… (56s)' })).toBeDefined()
      const boxes = await ui.findAll({ type: 'Box' })
      // No spacer pushing the engine's rows right: the one layout box is the ring's layer, which takes no room.
      expect(boxes.some(b => typeof b.props.width === 'number')).toBe(false)
      expect(boxes.filter(b => b.props.position === 'absolute').map(b => b.props)).toEqual([{ position: 'absolute', top: 1, left: 0 }])
      // The power lives in the band now: the spinner holds the ring alone.
      expect((await ui.findAll({ type: 'Client' })).map(c => c.key)).toEqual(['ring-flowing'])
      expect(await ringIn(ui, 'ring-flowing')).toBe('⊜')
      await ui.unmount()
    }
  }
})

test('the power rides the badge row beside the project while Claude works, and only then', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  // Idle: the badge row ends at the project.
  const idle = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...BAND })
  expect(await idle.find({ type: 'Client' })).toBeUndefined()
  await idle.unmount()

  for (const surface of SURFACES) {
    const { spin, hud } = await working($, 'responding', { surface })
    // Two cells after the project, the light flowing out of the badge into the free row.
    expect(await hud.find({ type: 'Box', text: /^\[Opus 5\.5\] │ cv {2}/ })).toBeDefined()
    expect((await hud.findAll({ type: 'Client' })).map(c => c.key)).toEqual(['power-flowing'])
    expect(await powerIn(hud, 'power-flowing')).toMatch(POWER_ROW)
    await hud.unmount()

    // The turn over, the power goes, though the last mode is still on record.
    const done = await $.ui.mount({ plugin: 'green-lantern', surface, ...BAND })
    expect(await done.find({ type: 'Client' })).toBeUndefined()
    await done.unmount()
    await spin.unmount()
  }

  // Charging has no power yet.
  const charging = await working($, 'requesting')
  expect(await charging.hud.find({ type: 'Client' })).toBeUndefined()
  await charging.spin.unmount()
  await charging.hud.unmount()

  // `[Opus 5.5] │ cv` is 15 cells: with two of space and sixteen of power it needs 33.
  for (const [bodyColumns, shown] of [[32, false], [33, true]] as const) {
    const { spin, hud } = await working($, 'thinking', { bodyColumns })
    expect((await hud.find({ type: 'Client' })) !== undefined).toBe(shown)
    await spin.unmount()
    await hud.unmount()
  }

  // A new prompt forgets the last mode: nothing shows until the spinner says what Claude is doing.
  await (await working($, 'tool-use')).spin.unmount()
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  const fresh = await $.ui.mount({ plugin: 'green-lantern', surface: 'terminal', ...WORKING })
  expect(await fresh.find({ type: 'Client' })).toBeUndefined()
})

test('each mode has its ring and its power, and both move', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  const cases: [SpinnerMode, string, RegExp][] = [
    ['requesting', 'charging', /^[◌○◎◉⊜]$/],
    ['thinking', 'focusing', /^◉$/],
    ['responding', 'flowing', /^⊜$/],
    ['tool-input', 'surging', /^⊜$/],
    ['tool-use', 'surging', /^⊜$/],
  ]
  for (const [mode, kind, ring] of cases) {
    const { spin, hud } = await working($, mode)
    // Charging has no power yet: only the ring moves.
    const charging = kind === 'charging'
    const shot = async () => ({ ring: await ringIn(spin, `ring-${kind}`), power: charging ? '' : await powerIn(hud, `power-${kind}`) })
    if (charging) expect(await hud.find({ type: 'Client' })).toBeUndefined()
    const before = await shot()
    expect(before.ring).toMatch(ring)
    if (!charging) expect(before.power).toMatch(POWER_ROW)
    await spin.advance(110 * 2)
    await hud.advance(110 * 2)
    const after = await shot()
    // Something visibly changed: the ring glyph, or the power row.
    expect(after.ring !== before.ring || after.power !== before.power).toBe(true)
    await spin.unmount()
    await hud.unmount()
  }
})

test('reduced motion leaves the engine’s row as it is, and the badge row without power', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on, { settings: { prefersReducedMotion: true } })
  engineSpinner(on)
  await start($)

  const { spin, hud } = await working($, 'responding')
  expect(await spin.find({ type: 'Text', text: '✻ Forging… (56s)' })).toBeDefined()
  expect(await spin.find({ type: 'Client' })).toBeUndefined()
  expect((await spin.findAll({ type: 'Box' })).some(b => b.props.position === 'absolute')).toBe(false)
  expect(await hud.find({ type: 'Client' })).toBeUndefined()
})

test('the power is a pool of light and particles, never a scroll', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  for (const [mode, kind] of [['responding', 'flowing'], ['tool-use', 'surging']] as const) {
    const rows = await frames($, mode, kind, 6)
    for (const row of rows) {
      expect(row).toMatch(POWER_ROW)
      expect([...row].some(ch => ch !== '⠀')).toBe(true) // there is light
    }
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1] ?? '', rows[i] ?? '']
      expect(b).not.toBe(a)
      // Not the previous frame slid one cell either way: the surface changes shape as it moves.
      expect(b.slice(1)).not.toBe(a.slice(0, -1))
      expect(b.slice(0, -1)).not.toBe(a.slice(1))
    }
  }
})

test('the power spans its whole width: motes drift in from the far end to the badge', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  const seen = new Set<number>()
  for (const row of await frames($, 'thinking', 'focusing', 40)) [...row].forEach((ch, c) => ch !== '⠀' && seen.add(c))
  expect(seen.has(0)).toBe(true)
  expect([...seen].some(c => c >= 12)).toBe(true)
})

test('the power looks the same at every effort', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  const at = async (effort: 'low' | 'xhigh' | 'max', mode: SpinnerMode, kind: string) => {
    const step = $.turn.step({ turnId: `t-${effort}-${mode}`, index: 0, model: 'claude-opus-5-5', effort, messageCount: 1 })
    for await (const _ of step);
    return frames($, mode, kind, 12)
  }
  for (const [mode, kind] of [['thinking', 'focusing'], ['responding', 'flowing'], ['tool-use', 'surging']] as const) {
    const low = await at('low', mode, kind)
    expect(await at('xhigh', mode, kind)).toEqual(low)
    expect(await at('max', mode, kind)).toEqual(low)
  }
})

test('a prompt rolls the power once and keeps it through every mode; the next prompt rolls again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  answerSession(on)
  engineSpinner(on)
  await start($)

  const rollIn = async (mode: SpinnerMode) => {
    const { spin, hud } = await working($, mode)
    // The Client's own props carry what the band handed the power.
    const client = (await hud.find({ type: 'Client' }))?.props as { props?: { roll?: number } } | undefined
    await spin.unmount()
    await hud.unmount()
    return client?.props?.roll
  }
  await $.prompt.submit({ text: 'one', wait: true, origin: { kind: 'composer' } })
  const first = await rollIn('thinking')
  expect(typeof first).toBe('number')
  // Thinking, writing, a tool, writing again: one prompt, one roll.
  expect(await rollIn('responding')).toBe(first)
  expect(await rollIn('tool-use')).toBe(first)
  expect(await rollIn('responding')).toBe(first)

  await clock.advance(4_321)
  await $.prompt.submit({ text: 'two', wait: true, origin: { kind: 'composer' } })
  expect(await rollIn('responding')).not.toBe(first)
})

test('every act a mode can roll comes up, each about as often, whatever came before', () => {
  for (const [kind, acts] of Object.entries(ACTS_OF) as [PowerKind, readonly string[]][]) {
    const counts = new Map<string, number>()
    let repeats = 0
    let last = ''
    const rolls = 3000
    for (let r = 0; r < rolls; r++) {
      const act = actOf(kind, NOW + r * 977)
      counts.set(act, (counts.get(act) ?? 0) + 1)
      if (act === last) repeats++
      last = act
    }
    expect([...counts.keys()].sort()).toEqual([...acts].sort())
    for (const n of counts.values()) {
      expect(n / rolls).toBeGreaterThan(0.8 / acts.length)
      expect(n / rolls).toBeLessThan(1.2 / acts.length)
    }
    // Plain random: the same act can come up twice running, as often as any other.
    expect(repeats / rolls).toBeGreaterThan(0.6 / acts.length)
  }
})

test('every act draws its own light over the base, in single-width cells', () => {
  // The glyph acts show their mark; the dot acts change the base's dots.
  const marks: Record<string, string> = { beam: '◆', glints: '✦', blade: '▶', bolt: 'ϟ' }
  for (const [kind, acts] of Object.entries(ACTS_OF) as [PowerKind, readonly ActName[]][]) {
    for (const act of acts) {
      let own = false
      const chars = new Set<string>()
      for (let f = 0; f < SLOT_OF[kind]; f++) {
        const row = powerFrame(kind, act, f).map(c => c.ch).join('')
        expect(row).toMatch(POWER_ROW)
        for (const ch of row) chars.add(ch)
        own ||= row !== powerFrame(kind, null, f).map(c => c.ch).join('')
      }
      expect(own).toBe(true)
      if (marks[act]) expect(chars.has(marks[act] ?? '')).toBe(true)
    }
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

