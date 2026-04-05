# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata


ROOT = Path.cwd().resolve()
BUILD_ROOT = ROOT / "build" / "pyinstaller"
WEB_STATIC_DIR = ROOT / "apps" / "web" / "static"
ICON_PATH = WEB_STATIC_DIR / "favicon.ico"
RUNTIME_SEED_DIR = BUILD_ROOT / "runtime" / "base"
BIN_DIR = BUILD_ROOT / "bin"

datas = []
datas += [(str(WEB_STATIC_DIR), "web/static")]
if RUNTIME_SEED_DIR.exists():
    datas += [(str(RUNTIME_SEED_DIR), "runtime/base")]
if BIN_DIR.exists():
    datas += [(str(BIN_DIR), "bin")]

datas += collect_data_files("faster_whisper")
datas += copy_metadata("yt-dlp")
datas += copy_metadata("faster-whisper")
datas += copy_metadata("pydantic")
datas += copy_metadata("pydantic-settings")
datas += copy_metadata("uvicorn")
datas += copy_metadata("fastapi")

hiddenimports = []
hiddenimports += collect_submodules("video_sum_service")
hiddenimports += collect_submodules("video_sum_core")
hiddenimports += collect_submodules("video_sum_infra")
hiddenimports += collect_submodules("faster_whisper")
hiddenimports += collect_submodules("yt_dlp")
hiddenimports += collect_submodules("av")

a = Analysis(
    [str(ROOT / "apps" / "service" / "src" / "video_sum_service" / "__main__.py")],
    pathex=[
        str(ROOT / "apps" / "service" / "src"),
        str(ROOT / "packages" / "core" / "src"),
        str(ROOT / "packages" / "infra" / "src"),
    ],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="BriefVid",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    icon=str(ICON_PATH) if ICON_PATH.exists() else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="BriefVid",
)
