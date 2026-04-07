# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata


ROOT = Path.cwd().resolve()
BUILD_ROOT = ROOT / "build" / "pyinstaller"
WEB_STATIC_DIR = ROOT / "apps" / "web" / "static"
ICON_PATH = ROOT / "apps" / "desktop" / "build" / "icon.ico"
BIN_DIR = BUILD_ROOT / "bin"

# ffmpeg / ffprobe 通过 datas 中的 bin 目录统一收集，避免重复打包。
binaries = []

datas = []
datas += [(str(WEB_STATIC_DIR), "web/static")]
if BIN_DIR.exists():
    datas += [(str(BIN_DIR), "bin")]

# 仅复制 faster_whisper 必要的配置和数据文件（不包含大型模型文件）
datas += collect_data_files("faster_whisper")

# 简化元数据复制，移除非必要的包元数据
datas += copy_metadata("faster-whisper")
datas += copy_metadata("pydantic")
datas += copy_metadata("pydantic-settings")

hiddenimports = []
hiddenimports += collect_submodules("video_sum_service")
hiddenimports += collect_submodules("video_sum_core")
hiddenimports += collect_submodules("video_sum_infra")
hiddenimports += collect_submodules("faster_whisper")
hiddenimports += collect_submodules("yt_dlp")
hiddenimports += collect_submodules("av")

service_analysis = Analysis(
    [str(ROOT / "apps" / "service" / "src" / "video_sum_service" / "__main__.py")],
    pathex=[
        str(ROOT / "apps" / "service" / "src"),
        str(ROOT / "packages" / "core" / "src"),
        str(ROOT / "packages" / "infra" / "src"),
    ],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
worker_analysis = Analysis(
    [str(ROOT / "apps" / "service" / "src" / "video_sum_service" / "transcribe_worker.py")],
    pathex=[
        str(ROOT / "apps" / "service" / "src"),
        str(ROOT / "packages" / "core" / "src"),
        str(ROOT / "packages" / "infra" / "src"),
    ],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
service_pyz = PYZ(service_analysis.pure)
worker_pyz = PYZ(worker_analysis.pure)

service_exe = EXE(
    service_pyz,
    service_analysis.scripts,
    [],
    exclude_binaries=True,
    name="BriefVid",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    icon=str(ICON_PATH) if ICON_PATH.exists() else None,
)
worker_exe = EXE(
    worker_pyz,
    worker_analysis.scripts,
    [],
    exclude_binaries=True,
    name="BriefVidTranscribeWorker",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    icon=str(ICON_PATH) if ICON_PATH.exists() else None,
)

coll = COLLECT(
    service_exe,
    worker_exe,
    service_analysis.binaries,
    service_analysis.datas,
    worker_analysis.binaries,
    worker_analysis.datas,
    strip=False,
    upx=False,
    name="BriefVid",
)
