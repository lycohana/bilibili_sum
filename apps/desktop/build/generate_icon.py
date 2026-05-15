#!/usr/bin/env python3
"""Generate Electron desktop icons from the canonical icon.svg design."""

from __future__ import annotations

from pathlib import Path
import platform
import shutil
import subprocess

from PIL import Image, ImageColor, ImageDraw


CANVAS_SIZE = 512
GRADIENT_START = ImageColor.getrgb("#FF9ABA")
GRADIENT_END = ImageColor.getrgb("#F85D8E")
ACCENT = ImageColor.getrgb("#FB7299")
ACCENT_LIGHT = ImageColor.getrgb("#FFE6EE")
WHITE = ImageColor.getrgb("#FFFFFF")


def scale(value: float, size: int) -> int:
    return round(value / CANVAS_SIZE * size)


def lerp_color(start: tuple[int, int, int], end: tuple[int, int, int], t: float) -> tuple[int, int, int, int]:
    return (
        round(start[0] + (end[0] - start[0]) * t),
        round(start[1] + (end[1] - start[1]) * t),
        round(start[2] + (end[2] - start[2]) * t),
        255,
    )


def draw_linear_gradient(draw: ImageDraw.ImageDraw, size: int) -> None:
    inner_start = scale(56, size)
    inner_end = scale(456, size)
    usable_span = max(1, inner_end - inner_start)
    for y in range(inner_start, inner_end):
        t = (y - inner_start) / usable_span
        color = lerp_color(GRADIENT_START, GRADIENT_END, t)
        draw.line([(inner_start, y), (inner_end, y)], fill=color)


def draw_icon(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    outer = (scale(56, size), scale(56, size), scale(456, size), scale(456, size))
    outer_radius = scale(96, size)
    inner = (scale(132, size), scale(112, size), scale(380, size), scale(400, size))
    inner_radius = scale(42, size)
    top_card = (scale(314, size), scale(112, size), scale(380, size), scale(178, size))
    top_card_radius = scale(40, size)
    circle_bounds = (
        scale(286, size),
        scale(140, size),
        scale(350, size),
        scale(204, size),
    )
    line_radius = scale(10, size)

    mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(outer, radius=outer_radius, fill=255)

    gradient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_linear_gradient(ImageDraw.Draw(gradient), size)
    image.paste(gradient, (0, 0), mask)

    draw.rounded_rectangle(inner, radius=inner_radius, fill=WHITE)
    draw.rounded_rectangle(top_card, radius=top_card_radius, fill=ACCENT_LIGHT)
    draw.ellipse(circle_bounds, fill=ACCENT)

    draw.polygon(
        [
            (scale(307, size), scale(157, size)),
            (scale(329, size), scale(172, size)),
            (scale(307, size), scale(187, size)),
        ],
        fill=WHITE,
    )

    line_specs = [
        (172, 172, 268, 1.0),
        (172, 222, 332, 0.9),
        (172, 272, 310, 0.72),
        (172, 322, 284, 0.5),
    ]
    for x1, y, x2, opacity in line_specs:
        fill = (*ACCENT, round(255 * opacity))
        draw.rounded_rectangle(
            (scale(x1, size), scale(y, size), scale(x2, size), scale(y + 20, size)),
            radius=line_radius,
            fill=fill,
        )

    return image


def generate_ico(output_path: Path) -> None:
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    largest = draw_icon(256)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    largest.save(output_path, format="ICO", sizes=sizes)
    print(f"Generated ICO file from icon.svg design: {output_path}")
    print("  Sizes: " + ", ".join(f"{w}x{h}" for w, h in sizes))


def generate_icns(output_path: Path) -> None:
    if platform.system() != "Darwin":
        print("Skipping ICNS generation: iconutil is only available on macOS.")
        return

    iconutil = shutil.which("iconutil")
    if not iconutil:
        raise SystemExit("Error: iconutil was not found; cannot generate icon.icns on macOS.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    iconset_dir = output_path.with_suffix(".iconset")
    if iconset_dir.exists():
        shutil.rmtree(iconset_dir)
    iconset_dir.mkdir(parents=True)

    icon_specs = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for size, file_name in icon_specs:
        draw_icon(size).save(iconset_dir / file_name, format="PNG")

    subprocess.run([iconutil, "-c", "icns", str(iconset_dir), "-o", str(output_path)], check=True)
    shutil.rmtree(iconset_dir)
    print(f"Generated ICNS file from icon.svg design: {output_path}")


def main() -> None:
    repo_root = Path(__file__).parent.parent.parent.parent
    svg_path = repo_root / "apps" / "web" / "static" / "assets" / "icons" / "icon.svg"
    output_ico_path = repo_root / "apps" / "desktop" / "build" / "icon.ico"
    output_icns_path = repo_root / "apps" / "desktop" / "build" / "icon.icns"

    if not svg_path.exists():
        raise SystemExit(f"Error: SVG file not found: {svg_path}")

    generate_ico(output_ico_path)
    generate_icns(output_icns_path)


if __name__ == "__main__":
    main()
