#!/usr/bin/env python3
"""PROTOTYPE — derives hero-light.svg from hero-dark.svg.

The two heroes are the same drawing on different grounds, so only one is
authored by hand. Edit hero-dark.svg, then run this. It fails loudly if any
mapping stops matching, which is what stops the pair drifting apart.

    python3 docs/brand/_relight.py
"""
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
src = (HERE / "hero-dark.svg").read_text()

# --- plate: block-scoped, because fadeL/fadeR share one colour in the dark file
BLOCKS = [
    ('<stop offset="0%" stop-color="#0c1114"/>',  '<stop offset="0%" stop-color="#ffffff"/>'),
    ('<stop offset="45%" stop-color="#080c0f"/>', '<stop offset="45%" stop-color="#f7fafb"/>'),
    ('<stop offset="100%" stop-color="#05080a"/>\n    </linearGradient>\n    <radialGradient id="keylight"',
     '<stop offset="100%" stop-color="#eef2f5"/>\n    </linearGradient>\n    <radialGradient id="keylight"'),
    ('''    <linearGradient id="fadeL" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#05080a"/>
      <stop offset="100%" stop-color="#05080a" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fadeR" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#05080a" stop-opacity="0"/>
      <stop offset="100%" stop-color="#05080a"/>
    </linearGradient>''',
     '''    <linearGradient id="fadeL" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fadeR" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#eef2f5" stop-opacity="0"/>
      <stop offset="100%" stop-color="#eef2f5"/>
    </linearGradient>'''),
]

# --- everything else. Most-specific first: several colours do double duty.
PAIRS = [
    # lighting is gentler on white, and the vignette inverts to a soft grey
    ('stop-color="#1f9e7f" stop-opacity=".22"', 'stop-color="#1f9e7f" stop-opacity=".15"'),
    ('stop-color="#8a5f86" stop-opacity=".16"', 'stop-color="#8a5f86" stop-opacity=".11"'),
    ('<stop offset="100%" stop-color="#000" stop-opacity=".55"/>',
     '<stop offset="100%" stop-color="#8fa0ad" stop-opacity=".20"/>'),
    ('stroke="#7fd8c0" stroke-opacity=".05"', 'stroke="#1f9e7f" stroke-opacity=".08"'),
    ('filter="url(#grain)" opacity=".05"', 'filter="url(#grain)" opacity=".025"'),

    # type
    ('fill="#1f9e7f" opacity=".5" filter="url(#softbloom)"', 'fill="#1f9e7f" opacity=".22" filter="url(#softbloom)"'),
    ('fill="#eef3f6" letter-spacing', 'fill="#1f2328" letter-spacing'),
    ('<tspan fill="#2fb894">-</tspan>', '<tspan fill="#1f9e7f">-</tspan>'),
    ('fill="#9dabb5"', 'fill="#59636e"'),
    ('<tspan fill="#f2f6f8" font-weight="700">', '<tspan fill="#1f2328" font-weight="700">'),

    # arrival rings
    ('r="6" stroke="#7e8c96"', 'r="6" stroke="#8b98a3"'),
    ('r="6" stroke="#3ddcb0"', 'r="6" stroke="#0d9488"'),
    ('r="6" stroke="#c9a3c5"', 'r="6" stroke="#8a5f86"'),

    # connector highlights
    ('stroke="#8fa3ae" stroke-width="2"', 'stroke="#4a5560" stroke-width="2"'),
    ('fill="#8fa3ae"/>', 'fill="#4a5560"/>'),
    ('stroke="#3ddcb0" stroke-width="2.2"', 'stroke="#0b6b55" stroke-width="2.4"'),
    ('stroke="#c9a3c5" stroke-width="2"', 'stroke="#6b4568" stroke-width="2"'),
    ('fill="#c9a3c5"/>', 'fill="#6b4568"/>'),

    # neutral stages
    ('fill="#0d1417" stroke="#232d34"', 'fill="#ffffff" stroke="#d1d9e0"'),
    ('stroke="#232d34" stroke-width="1.5"', 'stroke="#d1d9e0" stroke-width="1.5"'),
    ('fill="#232d34"/>', 'fill="#c3ccd4"/>'),
    ('fill="#7e8c96"', 'fill="#59636e"'),

    # gates
    ('fill="#0b1f1b" stroke="#186851"', 'fill="#e9f7f2" stroke="#1f9e7f"'),
    ('stroke="#186851" stroke-width="1.5"', 'stroke="#1f9e7f" stroke-width="1.5"'),
    ('stroke="#3ddcb0" stroke-width="1.6"', 'stroke="#0d9488" stroke-width="1.9"'),
    ('fill="#4fd1ab"', 'fill="#0f766e"'),

    # PR
    ('fill="#1a1420" stroke="#6b4a68"', 'fill="#f7eef6" stroke="#8a5f86"'),
    ('stroke="#6b4a68" stroke-width="1.5"', 'stroke="#8a5f86" stroke-width="1.5"'),
    ('fill="#6b4a68"/>', 'fill="#8a5f86"/>'),
    ('stroke="#c9a3c5" stroke-width="1.6"', 'stroke="#6b4568" stroke-width="1.9"'),
    ('fill="#c9a3c5">PR to co-sign', 'fill="#6b4568">PR to co-sign'),

    # the pulse — a light ground needs a dark saturated core, not a white one
    ('r="9" fill="#3ddcb0" opacity=".28"', 'r="9" fill="#1f9e7f" opacity=".40"'),
    ('r="2.6" fill="#c9fff0"', 'r="2.8" fill="#0b6b55"'),

    # kill
    ('fill="#1a0e10" stroke="#7d3038"', 'fill="#fdeef0" stroke="#c74450"'),
    ('fill="#d97b83">killed', 'fill="#991b26">killed'),
]

out = src
missing = []
for old, new in BLOCKS + PAIRS:
    if old not in out:
        missing.append(old[:70])
        continue
    out = out.replace(old, new)

DARK_ONLY = ["#0d1417", "#232d34", "#0b1f1b", "#186851", "#1a1420", "#6b4a68",
             "#eef3f6", "#3ddcb0", "#c9fff0", "#7fd8c0", "#8fa3ae", "#7e8c96"]
leftover = sorted({c for c in DARK_ONLY if c in out})

if missing or leftover:
    print("relight FAILED — hero-dark.svg changed under the map", file=sys.stderr)
    for m in missing:
        print(f"  no longer matches: {m}", file=sys.stderr)
    for c in leftover:
        print(f"  dark colour survived: {c}", file=sys.stderr)
    raise SystemExit(1)

(HERE / "hero-light.svg").write_text(out)
print("hero-light.svg regenerated from hero-dark.svg")
