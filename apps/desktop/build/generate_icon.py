#!/usr/bin/env python3
"""Generate multi-resolution ICO file for Windows executable."""

from pathlib import Path
from PIL import Image


def generate_ico(png_path: Path, output_path: Path) -> None:
    """Generate ICO file from PNG.

    PIL's ICO encoder saves PNG-compressed icons which include all necessary
    resolutions internally. The 256x256 PNG will be stored as PNG format
    inside the ICO, which Windows can read.

    Args:
        png_path: Path to source PNG file (should be at least 256x256)
        output_path: Path for output ICO file
    """
    # Open the source PNG
    img = Image.open(png_path)

    # Convert to RGBA if needed
    if img.mode != 'RGBA':
        img = img.convert('RGBA')

    # Embed common Windows icon sizes so Explorer/taskbar/install output
    # all resolve from the same source asset instead of falling back.
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save(output_path, format='ICO', sizes=sizes)

    print(f"Generated ICO file: {output_path}")
    print("  Sizes: " + ", ".join(f"{w}x{h}" for w, h in sizes))


def main():
    repo_root = Path(__file__).parent.parent.parent.parent
    # Use the 512x512 PNG icon
    png_path = repo_root / "apps" / "web" / "static" / "assets" / "icons" / "icon-512.png"
    output_path = repo_root / "apps" / "desktop" / "build" / "icon.ico"

    if not png_path.exists():
        print(f"Error: PNG file not found: {png_path}")
        exit(1)

    generate_ico(png_path, output_path)


if __name__ == "__main__":
    main()
