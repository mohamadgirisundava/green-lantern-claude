import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

import type { HudRateLimit, HudUsage } from '../types'
import { POWER_CELLS, type RingProps } from './ring'

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
  'tool-input': { kind: 'surging', word: 'Shaping' },
  'tool-use': { kind: 'surging', word: 'Constructing' },
}
// From this width the power rides the far end of the verb row. The engine's words there reach about 80 cells
// (`Constructing… (1h 2m 3s · ↓ 120.5k tokens · still thinking with xhigh effort)`) and their length never reaches
// the plugin, so narrower terminals keep the power on the row above.
const INLINE_FROM_COLUMNS = 100
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

/** Time until a window resets: `10m`, `16h10m`, `3d12h`; empty once past. */
export function untilReset(ms: number): string {
  if (ms <= 0) return ''
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`
  }
  return mins % 60 ? `${hours}h${mins % 60}m` : `${hours}h`
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

  // The first prompt folds the welcome away; /clear is a clean slate and brings it back.
  on('prompt.submit', async ($, e, next) => {
    if (await read($, welcome)) await update($, welcome, () => false)
    return next(e)
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
  // pushes its tip row too. Instead one layer is painted over it, taking no room: the ring in column 0 of the
  // verb row (over the glyph) and the power at the far end of that row on a wide terminal, else on the empty
  // spacer row above. Nothing of the engine's moves.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const ring = RING[e.props.mode]
    const drawn = await next(ring && e.props.message === null ? { ...e, props: { ...e.props, word: ring.word } } : e)
    const table = $.ui.resolve(e)
    const { Box } = table
    const Client = 'Client' in table ? table.Client : undefined
    if (!ring || Client === undefined || (await read($, reducedMotion))) return drawn
    const palette: RingProps['palette'] = {
      deep: GL.deep,
      emerald: GL.emerald,
      lantern: GL.lantern,
      glow: GL.glow,
      neon: GL.neon,
      white: GL.white,
    }
    const columns = e.viewport?.columns ?? 0
    if (e.surface === 'terminal' && columns >= INLINE_FROM_COLUMNS) {
      // A region repaints whole on every frame, so neither spans the engine's words: the ring keeps the glyph's
      // cell and the power the last cells of the row. Charging has no power yet.
      const power =
        ring.kind === 'charging'
          ? []
          : [
              <Box position="absolute" top={1} left={columns - POWER_CELLS}>
                <Client key={`power-${ring.kind}`} module="./ring.tsx" props={{ kind: ring.kind, part: 'power', palette } satisfies RingProps} />
              </Box>,
            ]
      return (
        <Box flexDirection="column">
          {drawn}
          <Box position="absolute" top={1} left={0}>
            <Client key={`ring-${ring.kind}`} module="./ring.tsx" props={{ kind: ring.kind, part: 'ring', palette } satisfies RingProps} />
          </Box>
          {...power}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {drawn}
        <Box position="absolute" top={0} left={0}>
          <Client key={`ring-${ring.kind}`} module="./ring.tsx" props={{ kind: ring.kind, part: 'both', palette } satisfies RingProps} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'TurnDuration' }, ($, e, next) =>
    next({ ...e, props: { ...e.props, word: turnWord(e.requestId) } }),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const [m, p, u, last, ttl, t, fresh] = await Promise.all([
      read($, model),
      read($, project),
      read($, usage),
      read($, lastResponseAt),
      read($, cacheTtl),
      read($, now),
      read($, welcome),
    ])
    if (m === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const label = (text: string) => <Text color={GL.muted}>{text}</Text>

    const segments = []
    for (const [kind, short] of WINDOWS) {
      const w = u?.rateLimits.find(r => r.kind === kind)
      if (!w) continue
      // Battery logic, like the ring's charge: the bar shows what's left of the window and drains as it's used.
      const left = Math.max(0, 100 - Math.round(w.percentUsed))
      const reset = w.resetsAt ? untilReset(Date.parse(w.resetsAt) - t) : ''
      if (left === 0) {
        segments.push(
          <Text>
            {label(`${short} `)}
            <Text color={GL.white}>{reset ? `⚠ ↻${reset}` : '⚠'}</Text>
          </Text>,
        )
        continue
      }
      const color = chargeColor(left)
      const filled = Math.round((left / 100) * BAR_WIDTH)
      segments.push(
        <Text>
          {label(`${short} `)}
          <Text color={color}>{'▰'.repeat(filled)}</Text>
          <Text color={GL.deep}>{'▱'.repeat(BAR_WIDTH - filled)}</Text>
          <Text color={color}> {left}%</Text>
          {reset ? label(` ↻${reset}`) : ''}
        </Text>,
      )
    }
    if (u && u.window > 0) {
      segments.push(
        <Text color={GL.lantern}>
          {formatTokens(u.tokens ?? 0)}/{formatTokens(u.window)}
        </Text>,
      )
    }
    if (last !== null) {
      segments.push(label(`cache ${cacheCountdown(last + (ttl ?? autoTtl(u)) - t)}`))
    }

    // The badge: the effort holds still in its level's color; the spinner above carries the animation.
    const badge = [
      <Text color={GL.lantern}>
        [{modelName(m.id)}
        {m.effort ? ' ' : ''}
      </Text>,
    ]
    if (m.effort) {
      badge.push(
        <Text bold color={EFFORT_COLOR[m.effort] ?? GL.lantern}>
          {m.effort}
        </Text>,
      )
    }
    badge.push(<Text color={GL.lantern}>]</Text>)
    if (p) {
      badge.push(
        label(' │ '),
        <Text color={GL.muted} underline>
          {p}
        </Text>,
      )
    }
    const rows = [<Box flexDirection="row">{...badge}</Box>]
    if (fresh && e.props.maxRows >= WELCOME_ROWS && e.props.bodyColumns >= WELCOME_MIN_COLUMNS) {
      // The welcome takes the badge row's place: the model line moves into the emblem's side panel.
      const side = [
        <Text>
          <Text bold color={GL.lantern}>
            GREEN LANTERN CORPS
          </Text>
          {label(' · Sector 2814')}
        </Text>,
        <Text>{''}</Text>,
        <Text color={GL.glow}>In brightest day, in blackest night,</Text>,
        <Text color={GL.glow}>no evil shall escape my sight.</Text>,
        <Text>{''}</Text>,
        <Text>
          <Text color={GL.lantern}>{modelName(m.id)}</Text>
          {m.effort ? label(' · ') : ''}
          {m.effort ? (
            <Text bold color={EFFORT_COLOR[m.effort] ?? GL.lantern}>
              {m.effort}
            </Text>
          ) : (
            ''
          )}
          {p ? label(` · ${p}`) : ''}
        </Text>,
      ]
      rows.splice(
        0,
        1,
        ...EMBLEM_ART.map(([art, color], i) => (
          <Box flexDirection="row">
            <Text bold color={color}>
              {art}
            </Text>
            <Text>{'   '}</Text>
            {side[i] ?? <Text>{''}</Text>}
          </Box>
        )),
      )
    }
    if (segments.length > 0) {
      rows.push(
        <Text wrap="truncate">
          {...segments.map((segment, i) => (
            <Text>
              {label(i === 0 ? '› ' : '  › ')}
              {segment}
            </Text>
          ))}
        </Text>,
      )
    }

    return <Box flexDirection="column">{...rows}</Box>
  })
}
