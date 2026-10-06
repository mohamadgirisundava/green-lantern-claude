import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

import type { HudRateLimit, HudUsage } from '../types'
import { ACTS_OF, POWER_CELLS, type ActName, type PowerKind, type PowerProps } from './power'
import type { RingProps } from './ring'

// Emerald Willpower: the palette of ~/.claude/themes/green-lantern.json. The HUD stays all green:
// the user found yellow and red too loud, so alarms are told by paler greens instead.
const GL = {
  lantern: '#3DDC84',
  glow: '#7DFFAF',
  neon: '#39FF14',
  emerald: '#2E9E5B',
  deep: '#1F5C38',
  muted: '#6E8F7B',
  white: '#E0FFEC',
}
// Effort as a power ramp, dimmest to brightest.
const EFFORT_COLOR: Record<string, string> = {
  low: GL.muted,
  medium: GL.emerald,
  high: GL.lantern,
  xhigh: GL.glow,
  max: GL.neon,
}
// The spinner: what the ring does for each thing Claude is doing, and the word beside it.
const RING: Record<string, { kind: RingProps['kind']; word: string }> = {
  requesting: { kind: 'charging', word: 'Charging' },
  thinking: { kind: 'focusing', word: 'Focusing' },
  responding: { kind: 'flowing', word: 'Forging' },
  'tool-input': { kind: 'shaping', word: 'Shaping' },
  'tool-use': { kind: 'surging', word: 'Constructing' },
}
// The ring and the power paint in the theme's greens, dimmest to brightest.
const PALETTE: RingProps['palette'] = {
  deep: GL.deep,
  emerald: GL.emerald,
  lantern: GL.lantern,
  glow: GL.glow,
  neon: GL.neon,
  white: GL.white,
}
// The power sits this many cells after the project in the badge row.
const POWER_GAP = 2
// /lantern-demo: a pane playing every act, each fixed, under the spinner word of its mode.
const DEMO = 'lantern-demo'
const DEMO_MODES: [PowerKind, string][] = [
  ['focusing', 'Focusing'],
  ['flowing', 'Forging'],
  ['shaping', 'Shaping'],
  ['surging', 'Constructing'],
]
const ACT_NAMES: Record<ActName, string> = {
  beam: 'Beam',
  pour: 'Pour',
  ripple: 'Ripple',
  glints: 'Glints',
  sketch: 'Sketch',
  weave: 'Weave',
  mold: 'Mold',
  blade: 'Blade',
  chain: 'Chain',
  bolt: 'Bolt',
  inward: 'Inward ripple',
  surge: 'Surge',
}
const DEMO_LABEL = 13
const DEMO_NAME = 15
// A fresh session's welcome: the emblem (a ring held between two bars), lit neon at the top down to
// emerald at the base, beside the oath. It needs WELCOME_ROWS rows above the usage line and room for the art.
const EMBLEM_ART: [string, string][] = [
  [' ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ', GL.neon],
  ['    ▄█▀▀▀▀▀█▄    ', GL.glow],
  ['   ██       ██   ', GL.lantern],
  ['   ██       ██   ', GL.lantern],
  ['    ▀█▄▄▄▄▄█▀    ', GL.lantern],
  [' ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ ', GL.emerald],
]
const WELCOME_ROWS = EMBLEM_ART.length + 1
const WELCOME_MIN_COLUMNS = 40
// The word that closes a turn, in place of the engine's `Baked for 3s`.
const TURN_WORDS = ['Forged', 'Charged', 'Constructed', 'Patrolled', 'Channeled', 'Recharged', 'Shone', 'Willed']
const BAR_WIDTH = 8
// The everyday panel: a rounded card with a header, a rule and one meter per row. It needs PANEL_MIN_COLUMNS
// and its own height in rows; otherwise the band falls back to the single compact line.
const PANEL_BAR_WIDTH = 14
const PANEL_MAX_COLUMNS = 64
const PANEL_MIN_COLUMNS = 54
const MIN = 60_000
// Under this the cache countdown shows seconds on a 1s clock; above it, minutes on the 30s clock.
const SECONDS_UNDER_MS = 2 * MIN
const FAST_FROM_MS = SECONDS_UNDER_MS + 30_000
const WINDOWS = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
] as const

const usage = atom({ plugin: 'green-lantern', key: 'usage' } as const, null)
const model = atom({ plugin: 'green-lantern', key: 'model' } as const, null)
const project = atom({ plugin: 'green-lantern', key: 'project' } as const, null)
const lastResponseAt = atom({ plugin: 'green-lantern', key: 'lastResponseAt' } as const, null)
const cacheTtl = atom({ plugin: 'green-lantern', key: 'cacheTtl' } as const, null)
const reducedMotion = atom({ plugin: 'green-lantern', key: 'reducedMotion' } as const, false)
const welcome = atom({ plugin: 'green-lantern', key: 'welcome' } as const, false)
const now = atom({ plugin: 'green-lantern', key: 'now' } as const, 0)
const power = atom({ plugin: 'green-lantern', key: 'power' } as const, { kind: null, roll: 0 })

/** Whether a write would change anything, so an unchanged figure redraws nothing. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function toUsage(context: SessionContextUsage, rateLimits: readonly SessionRateLimit[]): HudUsage {
  return {
    ...(context.tokens === undefined ? {} : { tokens: context.tokens }),
    window: context.window,
    rateLimits: rateLimits.map(
      (r): HudRateLimit => ({
        kind: r.kind,
        percentUsed: r.percentUsed,
        ...(r.resetsAt === undefined ? {} : { resetsAt: r.resetsAt }),
      }),
    ),
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** `claude-opus-5-5` → `Opus 5.5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`, `opus` → `Opus`. */
export function modelName(id: string): string {
  const bare = id.replace(/\[[^\]]*\]$/, '').trim()
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bare)
  if (m?.[1] && m[2]) return `${capitalize(m[1])} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`
  return /^[a-z]+$/.test(bare) ? capitalize(bare) : bare
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`
  return String(n)
}

/** Time until a window resets: `10m`, `16h 10m`, `3d 12h`; empty once past. */
export function untilReset(ms: number): string {
  if (ms <= 0) return ''
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
  }
  return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`
}

/** `47m` while minutes are what matter, `1m42s` near the end, `expired` after. */
export function cacheCountdown(ms: number): string {
  if (ms <= 0) return 'expired'
  if (ms >= SECONDS_UNDER_MS) return `${Math.ceil(ms / MIN)}m`
  const total = Math.ceil(ms / 1000)
  return `${Math.floor(total / 60)}m${total % 60}s`
}

/** The two values CLAUDE_CODE_PROMPT_CACHE_TTL and the promptCacheTtl setting take. */
export function parseTtl(value: unknown): number | null {
  if (value === '5m') return 5 * MIN
  if (value === '1h') return 60 * MIN
  return null
}

/** Claude Code's automatic TTL: 1h on a subscription within its usage limits, 5m otherwise. */
export function autoTtl(u: HudUsage | null): number {
  const windows = (u?.rateLimits ?? []).filter(r => r.kind === 'five_hour' || r.kind === 'seven_day')
  return windows.length > 0 && windows.every(r => r.percentUsed < 100) ? 60 * MIN : 5 * MIN
}

/** A window's charge color, by the share left: lantern green, paling as the ring's charge drains. */
function chargeColor(left: number): string {
  if (left <= 10) return GL.white
  if (left <= 25) return GL.glow
  return GL.lantern
}

/** One row's word, picked from its id so every redraw of the row keeps it. */
export function turnWord(requestId: string): string {
  let hash = 0
  for (const c of requestId) hash = (hash * 31 + c.charCodeAt(0)) >>> 0
  return TURN_WORDS[hash % TURN_WORDS.length] ?? 'Forged'
}

type EffortSettings = {
  effortLevel?: string
  modelSettings?: Record<string, { effortLevel?: string } | undefined>
}

async function refresh($: EngineInterface) {
  const [u, id, root, settings, envTtl] = await Promise.all([
    $.session.usage(),
    $.session.model(),
    $.session.root(),
    $.settings.read(),
    $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
  ])
  // The variable wins over the setting, as in Claude Code.
  const ttl = parseTtl(envTtl) ?? parseTtl((settings as { promptCacheTtl?: unknown }).promptCacheTtl)
  if ((await read($, cacheTtl)) !== ttl) await update($, cacheTtl, () => ttl)
  const still = (settings as { prefersReducedMotion?: unknown }).prefersReducedMotion === true
  if ((await read($, reducedMotion)) !== still) await update($, reducedMotion, () => still)
  const fresh = toUsage(u.context, u.rateLimits)
  if (!same(await read($, usage), fresh)) await update($, usage, () => fresh)
  const name = root.split('/').filter(Boolean).pop() ?? root
  if ((await read($, project)) !== name) await update($, project, () => name)
  // A turn's own model and effort (turn.step) win over the settings' guess.
  if ((await read($, model)) === null) {
    const s = settings as EffortSettings
    const effort = s.modelSettings?.[id]?.effortLevel ?? s.effortLevel
    await update($, model, () => ({ id, ...(effort ? { effort } : {}) }))
  }
  const t = await $.clock.now()
  await update($, now, () => t)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: DEMO, description: 'Play every ring-power act in a pane, to look at or record' })
    await refresh($)
    // A reload re-runs this: only a session with no prompts yet gets the welcome.
    const fresh = (await $.session.turns()) === 0
    if ((await read($, welcome)) !== fresh) await update($, welcome, () => fresh)
    const tick = async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
      return t
    }
    const cacheLeft = async (t: number) => {
      const last = await read($, lastResponseAt)
      if (last === null) return 0
      const ttl = (await read($, cacheTtl)) ?? autoTtl(await read($, usage))
      return last + ttl - t
    }

    // The 1s clock runs only for the cache countdown's last seconds-long stretch.
    let fast: Timer | undefined
    const startFast = () => {
      fast ??= $.clock.every(1000, async () => {
        const left = await cacheLeft(await tick())
        // Expired, or a new response put the cache back to minutes.
        if (left <= 0 || left > FAST_FROM_MS) {
          fast?.cancel()
          fast = undefined
        }
      })
    }

    // Reset countdowns and the cache's minutes: every 30s; it hands over to the 1s clock near the end.
    const slowTick = async () => {
      const left = await cacheLeft(await tick())
      if (left > 0 && left <= FAST_FROM_MS) startFast()
    }
    $.clock.every(30_000, () => void slowTick())
    // A reload keeps lastResponseAt: pick the countdown back up where it stands.
    await slowTick()

    return next(e)
  })

  // The first prompt folds the welcome away; /clear is a clean slate and brings it back. Every prompt rolls the
  // power afresh (its act for each mode, held all prompt) and forgets the last prompt's mode.
  on('prompt.submit', async ($, e, next) => {
    if (await read($, welcome)) await update($, welcome, () => false)
    const roll = await $.clock.now()
    await update($, power, () => ({ kind: null, roll }))
    return next(e)
  })

  // The spinner's ring says which mode it shows as it appears: the band draws that mode's power. The mode is read
  // off the ring's key, which the engine reports, never off what the ring posted.
  on('ui.message', async ($, e, next) => {
    const kind = e.component === 'Spinner' ? Object.values(RING).find(r => e.element === `ring-${r.kind}`)?.kind : undefined
    if (kind && (await read($, power)).kind !== kind) await update($, power, p => ({ ...p, kind }))
    return next(e)
  })

  // The demo toggles: random rolls make an act hard to catch on screen, so this plays each one on demand.
  on('command.run', { command: DEMO }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === DEMO)) {
      await $.ui.close({ id: DEMO })
      return { text: 'Closed the Lantern power demo.' }
    }
    // Every act's row, with a blank row between each two.
    const rows = 2 * Object.values(ACTS_OF).reduce((n, acts) => n + acts.length, 0) - 1
    await $.ui.open({ id: DEMO, title: 'Lantern power', rows, columns: DEMO_LABEL + 3 + DEMO_NAME + POWER_CELLS })
    return { text: 'Opened the Lantern power demo: every act the ring can roll, playing on a loop. Run /lantern-demo again to close it.' }
  })

  // Every act on its own row, a blank row between each two so the rows of light don't touch: the mode's spinner
  // word and ring, the act's name, and its power playing on a loop. The real ring and power Clients draw it;
  // their timers run only while the pane is open.
  on('ui.render', { component: 'Pane', requestId: DEMO }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text } = table
    const Client = 'Client' in table ? table.Client : undefined
    if (Client === undefined) return <Text color={GL.muted}>The demo plays in the terminal and the desktop app.</Text>
    if (await read($, reducedMotion)) return <Text color={GL.muted}>The demo is still: prefersReducedMotion is on.</Text>
    const rows = DEMO_MODES.flatMap(([kind, word]) =>
      ACTS_OF[kind].map((act, i) => (
        <Box flexDirection="row">
          <Text color={GL.lantern}>{(i === 0 ? word : '').padEnd(DEMO_LABEL)}</Text>
          {i === 0 ? (
            <Client key={`demo-ring-${kind}`} module="./ring.tsx" props={{ kind, palette: PALETTE } satisfies RingProps} />
          ) : (
            <Text>{' '}</Text>
          )}
          <Text color={GL.muted}>{`  ${ACT_NAMES[act].padEnd(DEMO_NAME)}`}</Text>
          <Client key={`demo-power-${kind}-${act}`} module="./power.tsx" props={{ kind, roll: 0, act, palette: PALETTE } satisfies PowerProps} />
        </Box>
      )),
    )
    const spaced = rows.flatMap((row, i) => (i === 0 ? [row] : [<Text>{''}</Text>, row]))
    return <Box flexDirection="column">{...spaced}</Box>
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, welcome, () => true)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const fresh = toUsage(e.context, e.rateLimits)
    if (!same(await read($, usage), fresh)) await update($, usage, () => fresh)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const current = { id: e.model, ...(e.effort === undefined ? {} : { effort: String(e.effort) }) }
    if (!same(await read($, model), current)) await update($, model, () => current)
    const result = yield* next(e)
    const t = await $.clock.now()
    await update($, lastResponseAt, () => t)
    await update($, now, () => t)
    return result
  })

  // The spinner: the engine's row is sealed (an opaque handle), so nothing can go inside it, and shifting it
  // pushes its tip row too. Instead one cell is painted over it, taking no room: the ring in column 0 of the verb
  // row, over the glyph. The power it drives rides the badge row of the band below.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const ring = RING[e.props.mode]
    const drawn = await next(ring && e.props.message === null ? { ...e, props: { ...e.props, word: ring.word } } : e)
    const table = $.ui.resolve(e)
    const { Box } = table
    const Client = 'Client' in table ? table.Client : undefined
    if (!ring || Client === undefined || (await read($, reducedMotion))) return drawn
    return (
      <Box flexDirection="column">
        {drawn}
        <Box position="absolute" top={1} left={0}>
          <Client key={`ring-${ring.kind}`} module="./ring.tsx" props={{ kind: ring.kind, palette: PALETTE } satisfies RingProps} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'TurnDuration' }, ($, e, next) =>
    next({ ...e, props: { ...e.props, word: turnWord(e.requestId) } }),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const [m, p, u, last, ttl, t, fresh, pw, still] = await Promise.all([
      read($, model),
      read($, project),
      read($, usage),
      read($, lastResponseAt),
      read($, cacheTtl),
      read($, now),
      read($, welcome),
      read($, power),
      read($, reducedMotion),
    ])
    if (m === null) return next(e)

    const table = $.ui.resolve(e)
    const { Box, Text } = table
    const Client = 'Client' in table ? table.Client : undefined
    const label = (text: string) => <Text color={GL.muted}>{text}</Text>
    const blank = () => <Text>{''}</Text>
    const effortText = (effort: string) => (
      <Text bold color={EFFORT_COLOR[effort] ?? GL.lantern}>
        {effort}
      </Text>
    )

    // What every layout shows, read once: each window's charge left and reset, the context, the cache.
    const windows = WINDOWS.flatMap(([kind, short]) => {
      const w = u?.rateLimits.find(r => r.kind === kind)
      if (!w) return []
      // Battery logic, like the ring's charge: the bar shows what's left of the window and drains as it's used.
      const left = Math.max(0, 100 - Math.round(w.percentUsed))
      const reset = w.resetsAt ? untilReset(Date.parse(w.resetsAt) - t) : ''
      return [{ short, left, reset, color: left === 0 ? GL.white : chargeColor(left) }]
    })
    const context = u && u.window > 0 ? { tokens: u.tokens ?? 0, window: u.window } : null
    const cache = last !== null ? cacheCountdown(last + (ttl ?? autoTtl(u)) - t) : null

    const bar = (fill: number, width: number, color: string) => {
      const filled = Math.max(0, Math.min(width, Math.round(fill * width)))
      return (
        <Text>
          <Text color={color}>{'▰'.repeat(filled)}</Text>
          <Text color={GL.deep}>{'▱'.repeat(width - filled)}</Text>
        </Text>
      )
    }

    // The panel: one aligned meter per row, with air between the columns.
    const meter = (name: string, gauge: unknown, value: unknown, note: unknown) => (
      <Box flexDirection="row" columnGap={2}>
        <Box width={3}>{label(name)}</Box>
        {gauge}
        <Box width={11}>{value}</Box>
        {note}
      </Box>
    )
    const meters = windows.map(w =>
      meter(
        w.short,
        bar(w.left / 100, PANEL_BAR_WIDTH, w.color),
        <Text bold color={w.color}>
          {w.left === 0 ? '⚠ empty' : `${w.left}%`}
        </Text>,
        w.reset ? (
          <Text>
            <Text color={GL.emerald}>→ </Text>
            {label('resets in ')}
            <Text color={GL.white}>{w.reset}</Text>
          </Text>
        ) : (
          blank()
        ),
      ),
    )
    if (context) {
      const share = context.tokens / context.window
      // The context fills as the session goes on: it pales toward white as it nears the window.
      const color = share >= 0.9 ? GL.white : share >= 0.75 ? GL.glow : GL.lantern
      meters.push(
        meter(
          'ctx',
          bar(share, PANEL_BAR_WIDTH, color),
          <Text>
            <Text bold color={color}>
              {formatTokens(context.tokens)}
            </Text>
            {label(` / ${formatTokens(context.window)}`)}
          </Text>,
          cache ? (
            <Text>
              <Text color={GL.emerald}>○ </Text>
              {label('cache ')}
              <Text color={cache === 'expired' ? GL.muted : GL.white}>{cache}</Text>
            </Text>
          ) : (
            blank()
          ),
        ),
      )
    }

    const columns = e.props.bodyColumns
    const panelWidth = Math.min(columns, PANEL_MAX_COLUMNS)
    // While Claude works, the ring's power flows out of the model line into the header's free cells, if the row
    // has room for it beside the project: the panel's inside for the panel, the whole band for the compact form.
    const headerCells = `⊜ ${modelName(m.id)}${m.effort ? `  ·  ${m.effort}` : ''}`.length + (p ? p.length + 1 : 0)
    const kind = pw.kind === 'charging' ? null : pw.kind
    const powerFits = (room: number) =>
      e.props.isWorking && kind !== null && Client !== undefined && !still && headerCells + POWER_GAP + POWER_CELLS <= room
    const header = (room: number) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text>
            <Text color={GL.neon}>⊜ </Text>
            <Text bold color={GL.lantern}>
              {modelName(m.id)}
            </Text>
            {m.effort ? label('  ·  ') : ''}
            {m.effort ? effortText(m.effort) : ''}
          </Text>
          {...(powerFits(room) && Client && kind
            ? [
                <Text>{' '.repeat(POWER_GAP)}</Text>,
                <Client key={`power-${kind}`} module="./power.tsx" props={{ kind, roll: pw.roll, palette: PALETTE } satisfies PowerProps} />,
              ]
            : [])}
        </Box>
        {p ? <Text color={GL.muted}>{p}</Text> : blank()}
      </Box>
    )
    const panel = (withHeader: boolean) => {
      const body = withHeader ? [header(panelWidth - 4), <Text color={GL.deep}>{'─'.repeat(panelWidth - 4)}</Text>, ...meters] : meters
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={GL.deep} paddingX={1} width={panelWidth}>
          {...body}
        </Box>
      )
    }
    // Two border rows, the meters, and the header with its rule.
    const panelFits = (withHeader: boolean, rowsAbove = 0) =>
      meters.length > 0 &&
      columns >= PANEL_MIN_COLUMNS &&
      e.props.maxRows >= rowsAbove + 2 + meters.length + (withHeader ? 2 : 0)

    // The compact line, for a band too short or narrow for the panel: the same figures, spaced and divided.
    const compactSegments = windows.map(w => (
      <Text>
        {label(`${w.short} `)}
        {w.left === 0 ? (
          <Text color={GL.white}>⚠</Text>
        ) : (
          <Text>
            {bar(w.left / 100, BAR_WIDTH, w.color)}
            <Text color={w.color}> {w.left}%</Text>
          </Text>
        )}
        {w.reset ? label(`  → ${w.reset}`) : ''}
      </Text>
    ))
    if (context) {
      compactSegments.push(
        <Text color={GL.lantern}>
          {formatTokens(context.tokens)} / {formatTokens(context.window)}
        </Text>,
      )
    }
    if (cache) compactSegments.push(label(`○ cache ${cache}`))
    const compact = (
      <Text wrap="truncate">
        {...compactSegments.map((segment, i) => (
          <Text>
            {i === 0 ? '' : label('   │   ')}
            {segment}
          </Text>
        ))}
      </Text>
    )

    if (fresh && e.props.maxRows >= WELCOME_ROWS && columns >= WELCOME_MIN_COLUMNS) {
      // The welcome takes the header's place: the model line moves into the emblem's side panel.
      const side = [
        <Text>
          <Text bold color={GL.lantern}>
            GREEN LANTERN CORPS
          </Text>
          {label('  ·  Sector 2814')}
        </Text>,
        blank(),
        <Text italic color={GL.glow}>
          In brightest day, in blackest night,
        </Text>,
        <Text italic color={GL.glow}>
          no evil shall escape my sight.
        </Text>,
        blank(),
        <Text>
          <Text color={GL.lantern}>{modelName(m.id)}</Text>
          {m.effort ? label('  ·  ') : ''}
          {m.effort ? effortText(m.effort) : ''}
          {p ? label(`  ·  ${p}`) : ''}
        </Text>,
      ]
      const emblem = EMBLEM_ART.map(([art, color], i) => (
        <Box flexDirection="row">
          <Text bold color={color}>
            {art}
          </Text>
          <Text>{'    '}</Text>
          {side[i] ?? blank()}
        </Box>
      ))
      const below = panelFits(false, WELCOME_ROWS) ? panel(false) : compactSegments.length > 0 ? compact : null
      return (
        <Box flexDirection="column">
          {...emblem}
          {/* A space, not blank(): an empty Text on its own collapses to no row at all. */}
          <Text>{' '}</Text>
          {...(below ? [below] : [])}
        </Box>
      )
    }

    if (panelFits(true)) return panel(true)
    const rows = [header(columns)]
    if (compactSegments.length > 0) rows.push(compact)
    return <Box flexDirection="column">{...rows}</Box>
  })
}
