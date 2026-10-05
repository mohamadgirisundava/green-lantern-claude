import type { ClientModule } from 'claude-code'

/** What the spinner hands the ring: which animation, and the palette to paint it in. */
export type RingProps = {
  kind: 'charging' | 'focusing' | 'flowing' | 'shaping' | 'surging'
  palette: { deep: string; emerald: string; lantern: string; glow: string; neon: string; white: string }
}

type Cell = { ch: string; color: string; bold?: boolean }

const STEP_MS = 110

/** One frame of the ring cell, over the engine's glyph. */
function ringOf({ kind, palette: p }: RingProps, f: number): Cell {
  switch (kind) {
    case 'charging': {
      // The ring powers up, flares, and settles; no power is flowing yet.
      const ring = ['◌', '○', '◎', '◉', '⊜', '⊜', '◉', '◎', '○']
      const color = [p.deep, p.emerald, p.lantern, p.glow, p.neon, p.glow, p.lantern, p.emerald, p.deep]
      const i = f % ring.length
      return { ch: ring[i] ?? '⊜', color: color[i] ?? p.lantern, bold: true }
    }
    case 'focusing': {
      // The ring breathes while will gathers in the badge row.
      const breath = [p.emerald, p.lantern, p.glow, p.lantern]
      return { ch: '◉', color: breath[Math.floor(f / 3) % breath.length] ?? p.lantern, bold: true }
    }
    case 'flowing':
      return { ch: '⊜', color: p.glow, bold: true }
    case 'shaping':
      // A slow pulse while the construct takes shape.
      return { ch: '⊜', color: Math.floor(f / 3) % 2 ? p.lantern : p.glow, bold: true }
    case 'surging':
      return { ch: '⊜', color: f % 2 ? p.neon : p.white, bold: true }
  }
}

/**
 * The ring on the surface's own frame clock, one cell over the engine's spinner glyph. It also tells the hooks
 * which mode it shows, once as it appears: render hooks cannot write state, so this is how the band above the
 * prompt learns which power to draw. The hooks read the mode off this instance's key, not the post.
 */
const Ring: ClientModule<RingProps, number> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    let frame = 0
    surface.setState(frame)
    surface.every(STEP_MS, () => surface.setState(++frame))
    surface.post(null)
  }
  const ring = ringOf(props, surface.state ?? 0)
  return (
    <Text bold={ring.bold} color={ring.color}>
      {ring.ch}
    </Text>
  )
}

export default Ring
