# PyInstaller `onedir` Packaging

Windows 打包主路线已经切到 `PyInstaller onedir`。

## 产物形态

- `dist/BriefVid/BriefVid.exe`
- `dist/BriefVid/_internal/...`
- `dist/BriefVid/web/static/...`
- `dist/BriefVid/runtime/base/...`
- `dist/BriefVid/bin/ffmpeg.exe`

## 构建前提

- 使用 Python `3.12`
- 当前环境可安装本仓库的三个本地包
- 如果要随包分发 `ffmpeg`，请保证本机 `PATH` 里已有 `ffmpeg.exe` / `ffprobe.exe`
  - 或设置 `VIDEO_SUM_FFMPEG_DIR`

## 一键构建

```powershell
python .\packaging\pyinstaller\build_onedir.py
```

脚本会自动执行这些步骤：

1. 安装构建期依赖和本地包
2. 生成 sidecar managed runtime：`build/pyinstaller/runtime/base`
3. 尝试收集 `ffmpeg.exe` 与 `ffprobe.exe`
4. 执行 `PyInstaller`

## CUDA 运行时策略

- `onedir` 基础包默认只保证 CPU 路径可运行
- 设置页的一键安装会把 CUDA 版 `torch` 装到用户目录下的 managed runtime
- 安装路径默认在 `%LOCALAPPDATA%/briefvid/runtime/gpu-cu12x`
- 安装完成后需要重启应用生效

## 运行时目录

- 用户数据目录：`%LOCALAPPDATA%/briefvid/data`
- managed runtime：`%LOCALAPPDATA%/briefvid/runtime`
- 打包内置 seed runtime：`dist/BriefVid/runtime/base`
