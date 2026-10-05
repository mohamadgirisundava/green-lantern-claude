export type HudRateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type HudUsage = { tokens?: number; window: number; rateLimits: HudRateLimit[] }

export type HudModel = { id: string; effort?: string }

declare module 'claude-code' {
  interface PluginState {
    'green-lantern': {
      usage: HudUsage | null
      model: HudModel | null
      project: string | null
      lastResponseAt: number | null
      /** CLAUDE_CODE_PROMPT_CACHE_TTL or promptCacheTtl, in ms; null when Claude Code picks it. */
      cacheTtl: number | null
      /** The prefersReducedMotion setting: no glow when true. */
      reducedMotion: boolean
      /** A fresh session (no prompts yet, or just /clear-ed): the band shows the Lantern welcome. */
      welcome: boolean
      now: number
      /** The spinner's mode as its ring last reported it (null since the prompt began), and the prompt's roll. */
      power: { kind: 'charging' | 'focusing' | 'flowing' | 'shaping' | 'surging' | null; roll: number }
    }
  }
}
