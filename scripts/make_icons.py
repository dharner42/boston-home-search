#!/usr/bin/env python3
"""Home-screen icons for Boston Home Search. Dark field, gold school, three drive bands."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BG = (11, 14, 19)
GOLD = (255, 200, 87)
CORAL = (255, 107, 61)
BLUE = (126, 182, 255)
INK = (11, 14, 19)


def icon(size: int, maskable: bool) -> Image.Image:
    image = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(image)
    cx = cy = size / 2
    # Maskable icons are cropped to a circle of about 80% of the canvas.
    reach = size * (0.30 if maskable else 0.36)
    width = max(2, int(size * 0.035))
    for angle, color, span in ((-70, GOLD, 0.72), (18, CORAL, 0.95), (132, BLUE, 0.84)):
        rad = math.radians(angle)
        x2 = cx + math.cos(rad) * reach * span
        y2 = cy + math.sin(rad) * reach * span
        draw.line((cx, cy, x2, y2), fill=color, width=width)
    radius = size * (0.075 if maskable else 0.085)
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=GOLD, outline=INK, width=max(1, size // 128))
    return image


def main() -> None:
    icons = ROOT / "public" / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    icon(192, False).save(icons / "icon-192.png", optimize=True)
    icon(512, False).save(icons / "icon-512.png", optimize=True)
    icon(192, True).save(icons / "icon-maskable-192.png", optimize=True)
    icon(512, True).save(icons / "icon-maskable-512.png", optimize=True)
    icon(180, False).save(ROOT / "public" / "apple-touch-icon.png", optimize=True)


if __name__ == "__main__":
    main()
