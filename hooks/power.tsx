import type { ClientModule } from 'claude-code'

/** What the band hands the power: which mode's light, the prompt's roll, and the palette to paint it in. */
export type PowerProps = {
  kind: PowerKind
  /** The prompt's roll: it picks the act this mode plays for the whole prompt. */
  roll: number
  palette: { deep: string; emerald: string; lantern: string; glow: string; neon: string; white: string }
}

/** The modes that show power; charging has none yet. */
export type PowerKind = 'focusing' | 'flowing' | 'surging'
export type ActName = 'beam' | 'pour' | 'ripple' | 'glints' | 'blade' | 'chain' | 'bolt' | 'inward' | 'surge'

/** How many cells the power takes beside the project in the badge row. */
export const POWER_CELLS = 16

/** The acts a prompt can roll for each mode. */
export const ACTS_OF: Record<PowerKind, readonly ActName[]> = {
  flowing: ['beam', 'pour', 'ripple', 'glints'],
  surging: ['blade', 'chain', 'bolt'],
  focusing: ['glints', 'inward', 'surge'],
}

/** How many frames a mode's act takes before it plays again: 4.8 s writing or thinking, 6.6 s for tools. */
export const SLOT_OF: Record<PowerKind, number> = { flowing: 44, surging: 60, focusing: 44 }

const STEP_MS = 110
const CELLS = POWER_CELLS
// The power is a 32×4 canvas of dots: sixteen braille characters, each a 2×4 grid.
const W = CELLS * 2
const H = 4
// Braille dot bits by [column][row].
const BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]
// Light levels, dimmest to brightest: deep, emerald, lantern, glow, neon, white.
type Level = 0 | 1 | 2 | 3 | 4 | 5
// Writing sloshes; tools boil.
const ENERGY: Record<PowerKind, number> = { flowing: 1, surging: 1.6, focusing: 1 }
// Each mode rolls on its own track, so the three don't land in step.
const TRACK: Record<PowerKind, number> = { flowing: 0, surging: 7919, focusing: 15838 }

/** A fixed hash to [0, 1): every particle's path, and every roll, follows from a number, so nothing keeps state. */
function hash(n: number): number {
  let x = Math.imul(n, 2654435761) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 2246822519) >>> 0
  x ^= x >>> 13
  return (x & 0xffffff) / 0x1000000
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** The act a prompt's roll gives a mode: plain random, each act as likely as the others every prompt. */
export function actOf(kind: PowerKind, roll: number): ActName {
  const acts = ACTS_OF[kind]
  return acts[Math.floor(hash(roll * 31 + TRACK[kind]) * acts.length)] ?? acts[0] ?? 'glints'
}

/** What one frame is drawn from: lit dots (by level) and whole-cell glyphs (by level, bold or not). */
type Canvas = {
  put: (x: number, y: number, level: Level) => void
  glyph: (cell: number, ch: string, level: Level, bold?: boolean) => void
  /** The surface's height at each dot column, before rounding. */
  lv: number[]
  kind: PowerKind
}

/** An act: drawn on its own clock `t` from the start of its slot, `s` (the slot) varying it from one showing to the next. */
type Act = {
  run: (t: number, s: number, k: Canvas) => void
  /** How far the act drains the pool into itself, 0 to 1. */
  drain?: (t: number) => number
  /** How far the act lifts the surface at each dot column. */
  lift?: (t: number) => ((x: number) => number) | null
}

// ── Bases: the light that always runs ──────────────────────────────────────────────────────────────────────

/** The sloshing surface on three waves of different speeds and directions, lowered by a drain, lifted by a ripple. */
function surfaceOf(f: number, energy: number, drain: number, lift: ((x: number) => number) | null): number[] {
  const out: number[] = []
  for (let x = 0; x < W; x++) {
    let waves =
      0.8 * energy * Math.sin(0.55 * x - 0.31 * f) +
      0.55 * energy * Math.sin(1.27 * x + 0.47 * f + 1) +
      0.3 * energy * Math.sin(2.3 * x - 0.83 * f + 2)
    let base = 2
    if (drain) {
      base *= 1 - 0.75 * drain
      waves *= 1 - 0.6 * drain
    }
    out.push(base + waves + (lift ? lift(x) : 0))
  }
  return out
}

/** Sparks rising a dot a frame off the surface: one every third frame, every frame when boiling. */
function sparks(f: number, energy: number, top: number[], k: Canvas) {
  const [every, life] = energy <= 1 ? [3, 4] : [1, 4]
  const streams = W / 16
  for (let s = 0; s < streams; s++) {
    const now = f - s // each stream a frame behind the last
    for (let j = Math.floor(now / every) - life; j <= Math.floor(now / every); j++) {
      const age = now - j * every
      if (j < 0 || age < 0 || age >= life) continue
      const x = Math.floor(hash(j * streams + s) * W)
      k.put(x, H - 1 - (top[x] ?? 0) - age, 5)
    }
  }
}

/** The pool: the wave drawn as a bright surface line over a sparse, twinkling body, so it never reads as a meter. */
function ribbon(f: number, energy: number, drained: boolean, k: Canvas) {
  const hot = energy > 1
  const top: number[] = []
  for (let x = 0; x < W; x++) {
    const t = clamp(Math.round(k.lv[x] ?? 0), drained ? 0 : 1, H)
    const ys = H - t
    top.push(t)
    if (t === 0) continue
    k.put(x, ys, t >= 4 ? 5 : t >= 3 ? 3 : 2)
    for (let y = ys + 1; y < H; y++) {
      const tick = Math.floor((f + Math.floor(hash(x * 31 + y) * 4)) / (hot ? 1 : 2))
      if (hash(x * 7919 + y * 104729 + tick * 31) < (hot ? 0.28 : 0.18)) k.put(x, y, y === H - 1 ? 1 : 0)
    }
  }
  sparks(f, energy, top, k)
}

/** Will gathering: motes appear in the far half and drift in toward the badge, wavering, brighter as they near. */
function motes(f: number, k: Canvas) {
  const near: Level[] = [3, 3, 2, 2, 1, 1, 0, 0]
  for (let j = Math.max(0, f - W); j <= f; j++) {
    const age = f - j
    if (hash(j * 3) >= 0.55) continue
    const x = W / 2 + Math.floor(hash(j) * (W / 2)) - age
    const y = (((Math.trunc(hash(j * 7 + 1) * H + 0.6 * Math.sin(age * 0.9 + j)) % H) + H) % H)
    if (x >= 0 && x < W) k.put(x, y, near[Math.floor((Math.floor(x / 2) * near.length) / CELLS)] ?? 0)
  }
}

// ── Acts ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The blade's stages: sketched in wireframe, forged solid by a sweep, held, then cracked to dust. */
function bladeStage(t: number) {
  if (t < 8) return { stage: 'sketch', a: t, drain: (t / 8) * 0.6 } as const
  if (t < 16) return { stage: 'forge', a: t - 8, drain: 0.6 + ((t - 8) / 8) * 0.4 } as const
  if (t < 34) return { stage: 'hold', a: t - 16, drain: 1 } as const
  if (t < 44) return { stage: 'shatter', a: t - 34, drain: 1 - (t - 34) / 10 } as const
  return null
}

/** The chain's links: a bar out of the badge, then ovals joined by bars. */
const CHAIN: [number, number][][] = (() => {
  const bar = (x0: number, x1: number) => {
    const d: [number, number][] = []
    for (let x = x0; x <= x1; x++) d.push([x, x % 2 ? 1 : 2])
    return d
  }
  const oval = (x0: number): [number, number][] => [
    [x0, 1], [x0, 2], [x0 + 1, 0], [x0 + 2, 0], [x0 + 3, 0], [x0 + 1, 3], [x0 + 2, 3], [x0 + 3, 3], [x0 + 4, 1], [x0 + 4, 2],
  ]
  const links = [bar(0, 2)]
  for (let k = 0; k < 5; k++) {
    if (k > 0) links.push(bar(6 * k - 1, 6 * k + 1))
    links.push(oval(6 * k + 2))
  }
  return links
})()

function chainStage(t: number) {
  if (t < 16) return { stage: 'build', a: t, drain: t / 16 } as const
  if (t < 28) return { stage: 'hold', a: t - 16, drain: 1 } as const
  if (t < 38) return { stage: 'shatter', a: t - 28, drain: 1 - (t - 28) / 10 } as const
  return null
}

// When the ripples leave, and the inward wavefronts start, within their act.
const RIPPLES = [0, 18]
const INWARD = [0, 12, 24]

const ACTS: Record<ActName, Act> = {
  // Bolts of light leave the badge, a white head over a fading tail, and burst into a star where they land.
  beam: {
    run(t, s, k) {
      const tail = ['━', '━', '─', '┄']
      const tailLevel: Level[] = [3, 3, 2, 1]
      for (let i = 0; i < 3; i++) {
        if (i > 0 && hash(s * 7 + i) < 0.25) continue
        const head = t - (i * 10 + Math.floor(hash(s * 11 + i) * 3))
        if (head < 0) continue
        const reach = 9 + Math.floor(hash(s * 13 + i) * 7)
        if (head <= reach) {
          k.glyph(head, '◆', 5, true)
          tail.forEach((ch, j) => k.glyph(head - 1 - j, ch, tailLevel[j] ?? 1))
        } else {
          const a = head - reach
          if (a <= 3) k.glyph(reach, ['✦', '✧', '·'][a - 1] ?? '·', ([5, 3, 1] as const)[a - 1] ?? 1, a === 1)
          for (let j = a; j < tail.length; j++) k.glyph(reach - 1 - (j - a), tail[j] ?? '┄', Math.max(0, (tailLevel[j] ?? 1) - 1) as Level)
        }
      }
    },
  },
  // Light leaves the badge in arcs, white-hot at first, and splashes into the pool at the far end.
  pour: {
    run(t, s, k) {
      for (let j = Math.max(0, t - 40); j <= Math.min(t, 11); j++) {
        const id = s * 1000 + j
        if (hash(id * 5 + 1) >= 0.6) continue
        const d = 12 + Math.floor(hash(id * 11 + 2) * (W - 13))
        const speed = hash(id * 13 + 3) < 0.5 ? 1 : 2
        const age = t - j
        const x = 1 + age * speed
        const land = clamp(H - Math.max(1, Math.round(k.lv[d] ?? 0)), 0, H - 1)
        if (x <= d) {
          const u = (x - 1) / (d - 1)
          const y = clamp(Math.round(1.5 * (1 - u) + land * u - 1.6 * Math.sin(Math.PI * u)), 0, H - 1)
          k.put(x, y, age <= 1 ? 5 : x < 10 ? 3 : 2)
          if (speed === 2) k.put(x - 1, y, 1) // fast motes streak
        } else {
          const landed = age - Math.ceil((d - 1) / speed)
          if (landed === 1 || landed === 2) {
            const level = landed === 1 ? 5 : 3
            k.put(d - 1, land - landed, level)
            k.put(d + 1, land - landed, level)
          }
        }
      }
    },
  },
  // A wavefront runs out across the pool, lifting the surface as it passes. Twice.
  ripple: {
    lift(t) {
      const fronts = RIPPLES.filter(t0 => t >= t0)
        .map(t0 => (t - t0) * 2.2 - 1)
        .filter(x => x > -2 && x < W + 9)
      return fronts.length ? x => Math.max(...fronts.map(c => 1.5 * Math.exp(-((x - c) ** 2) / 4))) : null
    },
    run(t, _s, k) {
      for (const t0 of RIPPLES) {
        const a = t - t0
        const x = a * 2.2 - 1
        if (a < 0 || x > W + 9) continue
        for (const [dx, level] of [[0, 5], [-4, 2], [-8, 1]] as const) {
          const c = Math.round(x) + dx
          k.put(c, 1, level)
          k.put(c, 2, level)
          k.put(c - 1, 0, level)
          k.put(c - 1, 3, level)
        }
      }
    },
  },
  // Stars twinkle up out of the light and go out; while focusing they spark near the badge, where the motes arrive.
  glints: {
    run(t, s, k) {
      const seq = ['·', '✧', '✦', '✧', '·']
      const levels: Level[] = [1, 3, 5, 3, 1]
      for (let j = Math.max(0, t - seq.length + 1); j <= Math.min(t, 30); j++) {
        const id = s * 1000 + j
        if (hash(id * 31 + 8) > 0.42) continue
        const a = t - j
        const h = hash(id * 37 + 9)
        k.glyph(Math.floor((k.kind === 'focusing' ? h * h : h) * CELLS), seq[a] ?? '·', levels[a] ?? 1, a === 2)
      }
    },
  },
  // A wireframe sketches out of the badge, a white-hot sweep forges it solid, a glint runs down it while it holds,
  // then it cracks from the tip back to dust. The pool drains into it while it stands.
  blade: {
    drain: t => bladeStage(t)?.drain ?? 0,
    run(t, s, k) {
      const p = bladeStage(t)
      if (!p) return
      const last = CELLS - 1
      const solid = (c: number) => (c === 0 ? '┿' : c === last ? '▶' : '━')
      const wire = (c: number) => (c === 0 ? '┿' : c === last ? '▷' : '┄')
      if (p.stage === 'sketch') {
        const reach = (p.a + 1) * 2
        for (let c = 0; c < Math.min(reach, CELLS); c++) k.glyph(c, wire(c), c >= reach - 2 ? 2 : 1)
      } else if (p.stage === 'forge') {
        const sweep = p.a * 2
        for (let c = 0; c < CELLS; c++) {
          if (c < sweep) k.glyph(c, solid(c), 3, true)
          else if (c < sweep + 2) k.glyph(c, c === last ? '▶' : '═', 5, true)
          else k.glyph(c, wire(c), 1)
        }
      } else if (p.stage === 'hold') {
        const glint = (p.a * 2) % (CELLS + 12)
        for (let c = 0; c < CELLS; c++) {
          const lit = c === glint || c === glint - 1
          k.glyph(c, lit && c !== 0 && c !== last ? '═' : solid(c), lit || c === last ? 5 : Math.floor(p.a / 4) % 2 ? 3 : 2, true)
        }
      } else {
        const crumble = ['╳', '⁘', '·', '˙']
        const fade: Level[] = [5, 2, 1, 0]
        for (let c = 0; c < CELLS; c++) {
          const a = p.a - Math.floor((last - c) / 4 + hash(c * 13 + s * 7) * 2)
          if (a < 0) k.glyph(c, solid(c), 3, true)
          else if (a < crumble.length) k.glyph(c, a === 0 ? (hash(c + s) < 0.5 ? '╱' : '╲') : (crumble[a] ?? '˙'), fade[a] ?? 0, a === 0)
        }
      }
    },
  },
  // The pool drains into a hard-light chain forged link by link out of the badge; it holds, then shatters into sparks.
  chain: {
    drain: t => chainStage(t)?.drain ?? 0,
    run(t, s, k) {
      const p = chainStage(t)
      if (!p) return
      if (p.stage === 'build') {
        const shown = Math.floor(p.a / (16 / CHAIN.length)) + 1
        CHAIN.slice(0, shown).forEach((link, i) => link.forEach(([x, y]) => k.put(x, y, i === shown - 1 ? 5 : 3)))
      } else if (p.stage === 'hold') {
        const surge = Math.floor(p.a * 1.2) % (CHAIN.length + 4)
        CHAIN.forEach((link, i) => link.forEach(([x, y]) => k.put(x, y, i === surge ? 5 : Math.floor(p.a / 3) % 2 ? 3 : 2)))
      } else {
        const fade: Level[] = [5, 3, 3, 2, 2, 1, 1, 0, 0, 0]
        let i = 0
        for (const link of CHAIN) {
          for (const [x, y] of link) {
            i++
            if (hash(i * 41 + s) < p.a / 9) continue
            const dx = Math.round((hash(i * 17 + s) - 0.5) * p.a * 1.2)
            const dy = Math.floor(p.a * p.a * 0.06 + hash(i * 29 + s) * p.a * 0.4)
            k.put(x + dx, y + dy, fade[p.a] ?? 0)
          }
        }
      }
    },
  },
  // Lightning in box-drawing strokes: it strikes, blinks off, strikes again and leaves embers. Up to three times.
  bolt: {
    run(t, s, k) {
      ;[2, 20, 38].forEach((t0, i) => {
        const a = t - t0
        const c0 = s * 3 + i
        if (a < 0 || a > 3 || a === 1 || (i > 0 && hash(c0 * 97 + 5) > 0.7)) return
        const length = 8 + Math.floor(hash(c0 * 3 + 7) * 8)
        let up = hash(c0 * 11) < 0.5
        for (let c = 0; c < length; c++) {
          const h = hash(c0 * 1009 + c * 13)
          if (a === 3) {
            if (c % 2 === 0) k.glyph(c, '·', 1)
            continue
          }
          if (h < 0.75) up = !up // mostly zigzag, sometimes a longer stroke
          k.glyph(c, c === length - 1 ? 'ϟ' : h > 0.92 ? '─' : up ? '╱' : '╲', 5, true)
        }
      })
    },
  },
  // Wavefronts roll in from the far end toward the badge, brightening as they near.
  inward: {
    run(t, _s, k) {
      for (const t0 of INWARD) {
        const a = t - t0
        const x = W + 1 - a * 2
        if (a < 0 || x < -1) continue
        for (const [dx, level] of [[0, x < 10 ? 3 : 2], [4, 1]] as const) {
          const c = x + dx
          k.put(c, 1, level)
          k.put(c, 2, level)
          k.put(c + 1, 0, level)
          k.put(c + 1, 3, level)
        }
      }
    },
  },
  // A rush of motes streams in all at once, faster and brighter than the drift.
  surge: {
    run(t, s, k) {
      for (let i = 0; i < 16; i++) {
        const a = t - Math.floor(i / 3)
        const x = 22 + Math.floor(hash(s * 50 + i) * 10) - a * 2
        if (a < 0 || x < 0) continue
        const y = (((Math.floor(hash(s * 60 + i) * H) + Math.round(0.7 * Math.sin(a * 0.8 + i))) % H) + H) % H
        k.put(x, y, x < 8 ? 5 : x < 18 ? 3 : 2)
        k.put(x + 1, y, 1)
      }
    },
  },
}

/** A painted cell: its character and its light level. */
export type Cell = { ch: string; level: Level; bold: boolean }

/** One frame of a mode's power: its base, with the act (if any) playing on its slot's clock. Glyphs take whole cells. */
export function powerFrame(kind: PowerKind, act: ActName | null, f: number): Cell[] {
  const energy = ENERGY[kind]
  const slot = SLOT_OF[kind]
  const t = f % slot
  const s = Math.floor(f / slot)
  const playing = act ? ACTS[act] : null
  const drain = playing?.drain?.(t) ?? 0
  const lit = new Map<number, Level>()
  const glyphs = new Map<number, { ch: string; level: Level; bold: boolean }>()
  const k: Canvas = {
    put(x, y, level) {
      if (x < 0 || x >= W || y < 0 || y >= H) return
      const at = x * H + y
      if (level > (lit.get(at) ?? -1)) lit.set(at, level)
    },
    glyph(cell, ch, level, bold = false) {
      if (cell < 0 || cell >= CELLS) return
      if (level >= (glyphs.get(cell)?.level ?? -1)) glyphs.set(cell, { ch, level, bold })
    },
    lv: surfaceOf(f, energy, drain, playing?.lift?.(t) ?? null),
    kind,
  }
  if (kind === 'focusing') motes(f, k)
  else ribbon(f, energy, drain > 0.3, k)
  playing?.run(t, s, k)

  const cells: Cell[] = []
  for (let c = 0; c < CELLS; c++) {
    const g = glyphs.get(c)
    if (g) {
      cells.push(g)
      continue
    }
    let bits = 0
    let level = -1
    for (const half of [0, 1]) {
      for (let y = 0; y < H; y++) {
        const l = lit.get((2 * c + half) * H + y)
        if (l === undefined) continue
        bits |= BITS[half]?.[y] ?? 0
        level = Math.max(level, l)
      }
    }
    // A cell takes one color: its brightest dot's.
    cells.push({ ch: String.fromCharCode(0x2800 + bits), level: Math.max(0, level) as Level, bold: level >= 3 })
  }
  return cells
}

/**
 * The power beside the project in the badge row, on the surface's own frame clock. The act is rolled once from
 * the prompt's roll, so it holds for the whole prompt and plays again every slot over the mode's base.
 */
const Power: ClientModule<PowerProps, number> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    let frame = 0
    surface.setState(frame)
    surface.every(STEP_MS, () => surface.setState(++frame))
  }
  const p = props.palette
  const ink = [p.deep, p.emerald, p.lantern, p.glow, p.neon, p.white]
  const cells = powerFrame(props.kind, actOf(props.kind, props.roll), surface.state ?? 0)
  return (
    <Text>
      {...cells.map(cell => (
        <Text bold={cell.bold} color={ink[cell.level] ?? p.lantern}>
          {cell.ch}
        </Text>
      ))}
    </Text>
  )
}

export default Power
