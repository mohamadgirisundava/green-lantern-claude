# Green Lantern for Claude Code

> *In brightest day, in blackest night, no evil shall escape my sight.*

A Green Lantern UI for [Claude Code](https://claude.com/claude-code), packaged as a plugin. Claude's spinner becomes a power ring, your usage limits become the ring's charge, and the theme goes emerald throughout.

## What you get

**Ring-power spinner.** The ring takes the place of the spinner glyph, and its power moves on the row above. It changes with what Claude is doing:

| Claude is… | Ring | Power |
|---|---|---|
| Sending the request | `◌ ○ ◎ ◉ ⊜`: charging | (none) |
| Thinking | `◉`: breathing | Motes of will drifting in toward the ring |
| Writing | `⊜` | Liquid light sloshing, sparks popping off the crests |
| Using a tool | `⊜` flickering white-hot | The liquid boiling |

The spinner words follow the same modes: *Charging, Focusing, Forging, Shaping, Constructing*. Nothing in Claude Code's own row moves: the timer, token count and tips stay where they are.

**Battery-style usage bars.** The 5-hour and 7-day limits show the charge *left*, full when unused and draining as you work. They pale from lantern green, to glow at 25% left, to almost white at 10%.

```
[Opus 5.5 xhigh] │ my-project
› 5h ▰▰▰▱▱▱▱▱ 40% ↻1h15m  › 7d ▰▱▱▱▱▱▱▱ 10% ↻12h15m  › 514k/1.0M  › cache 60m
```

**A fresh-session emblem.** A new session (or one just `/clear`ed) opens with the lantern emblem and the oath above the prompt. It folds away into the everyday HUD on your first prompt.

**Lantern turn words.** *Forged for 1m 12s*, *Charged for 9s*, …

**An emerald theme.** 57 of Claude Code's colors in layered greens: spinner, borders, permission prompts, diffs, the mascot. The ultrathink rainbow becomes the Emotional Spectrum of the seven Lantern Corps.

## Install

In Claude Code:

```
/plugin marketplace add vogiaan1904/green-lantern-claude
/plugin install green-lantern@green-lantern
```

Restart Claude Code, then choose the theme with `/theme`. A plugin can ship a theme but can't select it for you.

### Optional settings

In `~/.claude/settings.json`:

- **The oath as spinner tips:**
  ```json
  "spinnerTipsOverride": {
    "label": "⊜",
    "tips": [
      "In brightest day, in blackest night, no evil shall escape my sight.",
      "Let those who worship evil's might beware my power: Green Lantern's light!"
    ]
  }
  ```
- **A still ring**, if you prefer no animation: `"prefersReducedMotion": true`.

## Requirements and caveats

- **Claude Code with plugin mods (function hooks).** Tested on Claude Code 2.1.288. The mod API is early access and may change between releases. If something breaks after an upgrade, please open an issue.
- **Spinner layout.** The ring layer sits over Claude Code's own spinner row and relies on its current layout: an empty row above the verb, and the glyph in the first column.
- **Font.** Your terminal font needs braille characters (U+2800–U+28FF) and `⊜`. Most modern monospace fonts have them.
- **Surfaces.** The animations draw in the terminal and the desktop app. Elsewhere you get the still version.
- **Cost.** The animation only runs while Claude is working, on Claude Code's own frame clock. Idle cost is a 30-second timer.

## Development

```bash
claude --plugin-dir .            # run it from the checkout; this also lays the types tsc needs
claude plugin validate .
npx -y -p typescript@5 tsc -p .
claude plugin test .
python3 scripts/check-theme.py   # after each Claude Code upgrade: theme keys it doesn't know are dropped silently
```

| File | What it owns |
|---|---|
| `hooks/register.tsx` | The HUD band, battery bars, emblem, spinner hook, turn words |
| `hooks/ring.tsx` | The ring and its power: a 16×4 braille canvas on the terminal's frame clock |
| `themes/green-lantern.json` | The color overrides (base `dark`) |
| `tests/green-lantern.test.tsx` | The behaviour, run by `claude plugin test` |

## License and disclaimer

MIT. This is a fan project, not affiliated with or endorsed by DC Comics or Warner Bros. Green Lantern and related names are trademarks of DC Comics.
