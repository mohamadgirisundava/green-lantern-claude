import type { ClientModule } from 'claude-code'

/** What the band hands the ring: which animation, which part of it this region draws, and the palette to paint it in. */
export type RingProps = {
  kind: 'charging' | 'focusing' | 'flowing' | 'surging'
  /** `both`: the power row above the ring. `ring` or `power` alone: the two regions of the verb row's far ends. */
  part: 'both' | 'ring' | 'power'
  palette: { deep: string; emerald: string; lantern: string; glow: string; neon: string; white: string }
}

/** How many cells the power takes: where the band places its region at the verb row's far end. */
export const POWER_CELLS = 8

type Cell = { ch: string; color: string; bold?: boolean }

const STEP_MS = 110
const CELLS = POWER_CELLS
// The power row is a 16×4 canvas of dots: eight braille characters, each a 2×4 grid.
const W = CELLS * 2
const H = 4
// Braille dot bits by [column][row].
const BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

type Dot = `${number},${number}`
const dot = (x: number, y: number): Dot => `${x},${y}`

/** A fixed hash to [0, 1): every particle's path follows from its number, so the module keeps no particle state. */
function hash(n: number): number {
  let x = Math.imul(n, 2654435761) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 2246822519) >>> 0
  x ^= x >>> 13
  return (x & 0xffffff) / 0x1000000
}

/** Liquid light: a surface sloshing on three waves of different speeds and directions, sparks popping off it.
 * More energy boils it: higher, rougher, a spark every frame. */
function liquid(f: number, energy: number): { dots: Set<Dot>; sparks: Set<Dot> } {
  const dots = new Set<Dot>()
  const surface: number[] = []
  for (let x = 0; x < W; x++) {
    const level =
      1.5 +
      0.8 * energy * Math.sin(0.55 * x - 0.31 * f) +
      0.55 * energy * Math.sin(1.27 * x + 0.47 * f + 1) +
      0.3 * energy * Math.sin(2.3 * x - 0.83 * f + 2)
    const top = Math.max(0, Math.min(H, Math.round(level)))
    surface.push(top)
    for (let k = 0; k < top; k++) dots.add(dot(x, H - 1 - k))
  }
  const sparks = new Set<Dot>()
  const [every, life] = energy <= 1 ? [3, 4] : [1, 4]
  for (let j = Math.floor(f / every) - life; j <= Math.floor(f / every); j++) {
    const age = f - j * every
    if (j < 0 || age < 0 || age >= life) continue
    const x = Math.floor(hash(j) * W)
    const y = H - 1 - (surface[x] ?? 0) - age // rises a dot a frame off the surface
    if (y >= 0 && y < H) sparks.add(dot(x, y))
  }
  for (const d of sparks) dots.add(d)
  return { dots, sparks }
}

/** Will gathering: motes appear in the far half and drift in toward the ring, wavering, absorbed on arrival. */
function gather(f: number): Set<Dot> {
  const dots = new Set<Dot>()
  for (let j = Math.max(0, f - 16); j <= f; j++) {
    const age = f - j
    if (hash(j * 3) >= 0.55) continue
    const x = 8 + Math.floor(hash(j) * 8) - age
    const y = (((Math.trunc(hash(j * 7 + 1) * H + 0.6 * Math.sin(age * 0.9 + j)) % H) + H) % H)
    if (x >= 0 && x < W) dots.add(dot(x, y))
  }
  return dots
}

/** The canvas as eight cells, each colored by what it holds. */
type Ink = { color: string; bold?: boolean }

function paint(dots: Set<Dot>, ink: (cell: number, filled: number, spark: boolean) => Ink, sparks = new Set<Dot>()): Cell[] {
  const cells: Cell[] = []
  for (let c = 0; c < CELLS; c++) {
    let bits = 0
    let filled = 0
    let spark = false
    for (const half of [0, 1]) {
      for (let y = 0; y < H; y++) {
        const d = dot(2 * c + half, y)
        if (!dots.has(d)) continue
        bits |= BITS[half]?.[y] ?? 0
        filled += 1
        spark ||= sparks.has(d)
      }
    }
    cells.push({ ch: String.fromCharCode(0x2800 + bits), ...ink(c, filled, spark) })
  }
  return cells
}

/** One frame: the ring cell (over the engine's glyph) and the power row (on the empty row above it). */
function frameOf({ kind, palette: p }: RingProps, f: number): { ring: Cell; power: Cell[] } {
  switch (kind) {
    case 'charging': {
      // The ring powers up, flares, and settles; no power is flowing yet.
      const ring = ['◌', '○', '◎', '◉', '⊜', '⊜', '◉', '◎', '○']
      const color = [p.deep, p.emerald, p.lantern, p.glow, p.neon, p.glow, p.lantern, p.emerald, p.deep]
      const i = f % ring.length
      return { ring: { ch: ring[i] ?? '⊜', color: color[i] ?? p.lantern, bold: true }, power: [] }
    }
    case 'focusing': {
      // The ring breathes while motes of will drift in toward it, brighter as they near.
      const breath = [p.emerald, p.lantern, p.glow, p.lantern]
      const near = [p.glow, p.glow, p.lantern, p.lantern, p.emerald, p.emerald, p.deep, p.deep]
      return {
        ring: { ch: '◉', color: breath[Math.floor(f / 3) % breath.length] ?? p.lantern, bold: true },
        power: paint(gather(f), c => ({ color: near[c] ?? p.deep })),
      }
    }
    case 'flowing':
    case 'surging': {
      // Liquid light while writing; boiling for tools. Deeper liquid glows brighter; sparks burn white.
      const hot = kind === 'surging'
      const { dots, sparks } = liquid(f, hot ? 1.6 : 1)
      const depth = [p.deep, p.emerald, p.emerald, p.lantern, p.lantern, p.glow, p.glow, hot ? p.neon : p.glow, p.neon]
      return {
        ring: { ch: '⊜', color: hot ? (f % 2 ? p.neon : p.white) : p.glow, bold: true },
        power: paint(
          dots,
          (_, filled, spark) => (spark ? { color: p.white, bold: true } : { color: depth[filled] ?? p.glow, bold: filled >= 6 }),
          sparks,
        ),
      }
    }
  }
}

/**
 * The ring's animation on the surface's own frame clock, drawn over the engine's spinner. Both: two rows,
 * the power row on its empty spacer row (from column 1), the ring in column 0 of the verb row, over the glyph.
 * The region repaints whole on every frame, so it never spans the engine's words: on a wide terminal the
 * ring and the power are two regions of their own at the verb row's two ends.
 */
const Ring: ClientModule<RingProps, number> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    let frame = 0
    surface.setState(frame)
    surface.every(STEP_MS, () => surface.setState(++frame))
  }
  const { ring, power } = frameOf(props, surface.state ?? 0)
  const cells = power.map(cell => (
    <Text bold={cell.bold} color={cell.color}>
      {cell.ch}
    </Text>
  ))
  const glyph = (
    <Text bold={ring.bold} color={ring.color}>
      {ring.ch}
    </Text>
  )
  if (props.part === 'ring') return glyph
  if (props.part === 'power') return <Text>{...cells}</Text>
  return (
    <Box flexDirection="column">
      <Text>
        {' '}
        {...cells}
      </Text>
      {glyph}
    </Box>
  )
}

export default Ring
