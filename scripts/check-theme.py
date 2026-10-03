#!/usr/bin/env python3
"""Check the plugin's themes/green-lantern.json against the installed Claude Code's dark theme.

Claude Code silently drops override keys its base theme doesn't have, so run this after
every upgrade. Prints unknown keys (dropped), bad color values, and keys the theme
doesn't override yet (new ones may still be orange).
"""
import json
import os
import re
import shutil
import sys

THEME = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'themes', 'green-lantern.json')
COLOR = re.compile(r'^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|rgb\(\s?\d{1,3},\s?\d{1,3},\s?\d{1,3}\s?\)|ansi256\(\d{1,3}\)|ansi:\w+)$')


def dark_theme(binary: str) -> dict:
    data = open(binary, 'rb').read()
    for m in re.finditer(rb'\{autoAccept:"', data):
        depth, end = 0, m.start()
        for end in range(m.start(), min(len(data), m.start() + 20000)):
            c = data[end:end + 1]
            if c == b'{':
                depth += 1
            elif c == b'}':
                depth -= 1
                if depth == 0:
                    break
        body = data[m.start():end + 1].decode('utf-8', 'replace')
        pairs = dict(re.findall(r'(\w+):"([^"]*)"', body))
        # The dark base: Claude orange on white text.
        if pairs.get('claude') == 'rgb(215,119,87)' and pairs.get('text') == 'rgb(255,255,255)':
            return pairs
    sys.exit('could not find the dark theme in ' + binary)


def main() -> None:
    claude = shutil.which('claude')
    if not claude:
        sys.exit('claude is not on PATH')
    binary = os.path.realpath(claude)
    base = dark_theme(binary)
    overrides = json.load(open(THEME))['overrides']

    unknown = sorted(k for k in overrides if k not in base)
    bad = sorted(k for k, v in overrides.items() if not COLOR.match(str(v)))
    missing = sorted(k for k in base if k not in overrides)

    print(f'{os.path.basename(binary)}: dark theme has {len(base)} keys; green-lantern overrides {len(overrides)}')
    print('unknown keys (silently dropped):', unknown or 'none')
    print('bad color values:', bad or 'none')
    print('not overridden (default dark colors):', ', '.join(missing) or 'none')
    sys.exit(1 if unknown or bad else 0)


if __name__ == '__main__':
    main()
