# BriefVid

[![Python 3.12](https://img.shields.io/badge/python-3.12-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Code style: Ruff](https://img.shields.io/badge/code%20style-ruff-000000.svg)](https://github.com/astral-sh/ruff)

**本地优先的视频总结工具** —— 输入视频链接，自动获取结构化摘要、转写文本和任务记录。

![Features](https://img.shields.io/badge/features-B站支持|转写|摘要|WebUI-green)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

---

## 📖 目录

- [简介](#简介)
- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
  - [环境要求](#环境要求)
  - [安装依赖](#安装依赖)
  - [配置环境变量](#配置环境变量)
  - [启动服务](#启动服务)
- [API 概览](#api 概览)
- [命令行工具](#命令行工具)
- [Windows 打包分发](#windows 打包分发)
- [GPU/CUDA 支持](#gpucuda 支持)
- [数据存储](#数据存储)
- [项目结构](#项目结构)
- [开发指南](#开发指南)
- [限制与已知问题](#限制与已知问题)
- [路线图](#路线图)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 简介

BriefVid 是一个本地优先的视频总结工具，面向 B 站视频链接，提供下载、转写、结构化摘要、任务记录和本地 Web UI。

这个仓库已经可以作为一个可运行的开源项目使用，而不只是原型代码。

---

## 功能特性

- 🎯 **视频链接解析** - 输入 B 站视频链接并自动探测视频信息
- 🖼️ **封面缓存** - 自动缓存封面并维护本地视频库
- ⚙️ **后台任务处理** - 后台执行下载、转写、摘要任务
- 📡 **实时进度流** - 支持 REST API 和 SSE 任务进度流
- 📄 **结果导出** - 结果落盘为 `transcript.txt` 和 `summary.json`
- 🔧 **设置管理** - 设置页支持查看后端日志、关闭服务、安装 CUDA 支持
- 📦 **独立分发** - Windows 分发包不依赖用户本机 Python

---

## 技术栈

| 组件 | 技术 |
|------|------|
| **Backend** | FastAPI |
| **Frontend** | Vanilla JavaScript + Static Assets |
| **Persistence** | SQLite |
| **Download** | `yt-dlp` |
| **Transcription** | `faster-whisper` |
| **LLM** | OpenAI-compatible API |
| **Packaging** | PyInstaller onedir |

---

## 快速开始

### 环境要求

- Python `3.12`
- Windows 开发和打包环境最佳
- 开发态建议本机可用 `ffmpeg`
- 如果开启 LLM 摘要，需要可用的 OpenAI-compatible 接口

### 安装依赖

```powershell
python -m pip install -e .\packages\infra -e .\packages\core -e .\apps\service
```

### 配置环境变量

```powershell
Copy-Item .env.example .env
```

默认示例配置如下：

```env
VIDEO_SUM_HOST=127.0.0.1
VIDEO_SUM_PORT=3838
VIDEO_SUM_WHISPER_MODEL=tiny
VIDEO_SUM_WHISPER_DEVICE=cpu
VIDEO_SUM_WHISPER_COMPUTE_TYPE=int8
VIDEO_SUM_LLM_ENABLED=true
VIDEO_SUM_LLM_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
VIDEO_SUM_LLM_MODEL=qwen3.5-plus
VIDEO_SUM_LLM_API_KEY=replace-with-your-api-key
```

> 💡 **提示**: 如果暂时不想接 LLM，把 `VIDEO_SUM_LLM_ENABLED=false` 即可，服务会退回本地规则摘要。

如果你使用 DashScope 兼容接口，常见排障点如下：

- `VIDEO_SUM_LLM_BASE_URL` 保持为 `https://coding.dashscope.aliyuncs.com/v1`
- `VIDEO_SUM_LLM_API_KEY` 需要填写有效的 DashScope AccessKey，而不是其他平台的 Key
- 如果日志出现 `401 invalid_api_key` 或 `token expired`，现在服务会自动降级到本地规则摘要，但仍建议去设置页更新 Key

### 启动服务

```powershell
python -m video_sum_service
```

或使用脚本：

```powershell
.\scripts\run_service.ps1
```

### 访问应用

| 页面 | URL |
|------|-----|
| **首页** | `http://127.0.0.1:3838/` |
| **设置** | `http://127.0.0.1:3838/settings` |
| **健康检查** | `http://127.0.0.1:3838/health` |
| **系统信息** | `http://127.0.0.1:3838/api/v1/system/info` |

---

## API 概览

### 系统接口

| 方法 | 路径 | 描述 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/v1/system/info` | 系统信息 |
| `GET` | `/api/v1/system/logs` | 系统日志 |
| `POST` | `/api/v1/system/shutdown` | 关闭服务 |
| `GET` | `/api/v1/environment` | 环境信息 |

### 设置接口

| 方法 | 路径 | 描述 |
|------|------|------|
| `GET` | `/api/v1/settings` | 获取设置 |
| `PUT` | `/api/v1/settings` | 更新设置 |
| `POST` | `/api/v1/cuda/install` | 安装 CUDA 支持 |

### 视频接口

| 方法 | 路径 | 描述 |
|------|------|------|
| `POST` | `/api/v1/videos/probe` | 探测视频信息 |
| `GET` | `/api/v1/videos` | 获取视频列表 |
| `GET` | `/api/v1/videos/{video_id}` | 获取视频详情 |
| `DELETE` | `/api/v1/videos/{video_id}` | 删除视频 |
| `GET` | `/api/v1/videos/{video_id}/tasks` | 获取视频任务列表 |
| `POST` | `/api/v1/videos/{video_id}/tasks` | 创建视频任务 |

### 任务接口

| 方法 | 路径 | 描述 |
|------|------|------|
| `POST` | `/api/v1/tasks` | 创建任务 |
| `GET` | `/api/v1/tasks` | 获取任务列表 |
| `GET` | `/api/v1/tasks/{task_id}` | 获取任务详情 |
| `GET` | `/api/v1/tasks/{task_id}/result` | 获取任务结果 |
| `GET` | `/api/v1/tasks/{task_id}/progress` | 获取任务进度 |
| `GET` | `/api/v1/tasks/{task_id}/events` | 获取任务事件 |
| `GET` | `/api/v1/tasks/{task_id}/events/stream` | SSE 事件流 |
| `DELETE` | `/api/v1/tasks/{task_id}` | 删除任务 |

---

## 命令行工具

使用 PowerShell 脚本提交任务：

```powershell
.\scripts\submit_task.ps1 -Url "https://www.bilibili.com/video/BV1R6NFzXE1H/"
```

带标题提交：

```powershell
.\scripts\submit_task.ps1 `
  -Url "https://www.bilibili.com/video/BV1R6NFzXE1H/" `
  -Title "我被手表的睡眠评分，骗焦虑了好几年？【差评君】"
```

---

## Windows 打包分发

Windows 分发主路线已经切到 `PyInstaller onedir`。

### 构建要求

- 构建 Python 固定为 `3.12`
- 建议当前机器可用真实的 `ffmpeg.exe` 和 `ffprobe.exe`
- 如 `ffmpeg` 不在 `PATH`，可设置 `VIDEO_SUM_FFMPEG_DIR`

### 构建命令

```powershell
python .\packaging\pyinstaller\build_onedir.py
```

产物位于：

- `dist/BriefVid/BriefVid.exe`
- `dist/BriefVid/_internal/...`

更详细的打包说明见 [`packaging/pyinstaller/README.md`](packaging/pyinstaller/README.md)。

---

## GPU/CUDA 支持

这个项目没有把完整 CUDA 依赖直接塞进基础包，而是采用"基础运行时 + 受控 GPU 运行时"的方式：

- ✅ 基础包默认保证 CPU 可用
- ✅ 设置页可一键安装 CUDA 支持
- ✅ CUDA 依赖安装到 `%LOCALAPPDATA%/briefvid/runtime/`
- ✅ 安装完成后需要重启应用
- ✅ 环境检测、日志和运行时切换都在设置页可见

这套方案的目标是让 `onedir` 分发更稳定，同时保留 GPU 能力。

---

## 数据存储

### 数据目录

默认数据目录位于 `%LOCALAPPDATA%/briefvid/data/`：

| 文件/目录 | 描述 |
|-----------|------|
| `video_sum.db` | SQLite 数据库 |
| `cache/` | 封面和缓存资源 |
| `tasks/<task_id>/transcript.txt` | 转写文本 |
| `tasks/<task_id>/summary.json` | 结构化摘要结果 |

### 日志目录

日志目录位于 `%LOCALAPPDATA%/briefvid/logs/`。

---

## 项目结构

```
BriefVid/
├── apps/
│   ├── service/          # FastAPI 后端服务
│   └── web/              # 本地 Web UI 静态资源
├── packages/
│   ├── core/             # 下载、转写、摘要等核心能力
│   └── infra/            # 配置、路径、日志等基础设施
├── scripts/
│   ├── run_service.ps1   # 本地启动服务
│   └── submit_task.ps1   # 命令行提交任务
├── tests/
│   └── unit/             # 单元测试
├── docs/
│   └── architecture/     # 架构说明与启动笔记
├── packaging/
│   └── pyinstaller/      # Windows onedir 打包脚本和说明
├── .env.example          # 环境变量示例
├── .gitignore
├── pyproject.toml        # 项目配置
└── README.md
```

---

## 开发指南

### 运行测试

```powershell
python -m pytest
```

### 架构文档

本仓库当前使用 workspace 结构：

- `apps/service`
- `packages/core`
- `packages/infra`

如果你准备继续开发，建议优先阅读：

- [`REFACTOR_ARCHITECTURE.md`](REFACTOR_ARCHITECTURE.md)
- [`REFACTOR_TASK_BREAKDOWN.md`](REFACTOR_TASK_BREAKDOWN.md)
- [`docs/architecture/bootstrap.md`](docs/architecture/bootstrap.md)
- [`PACKAGING_INSTALL_PLAN.md`](PACKAGING_INSTALL_PLAN.md)

---

## 限制与已知问题

- ⚠️ 当前真实执行链路主要支持 B 站视频 URL
- ⚠️ 任务执行仍是轻量线程 worker，不是正式队列系统
- ⚠️ 暂未实现成熟的取消、重试和并发调度策略
- ⚠️ 首次模型下载和首次 GPU 运行会比较慢
- ⚠️ 当前 Web UI 以可用性为主，不是最终桌面端交互形态

---

## 路线图

- [ ] 更完整的视频平台支持（YouTube、抖音等）
- [ ] 更稳定的任务调度与恢复机制
- [ ] 更成熟的桌面端封装（Electron/Tauri）
- [ ] 更清晰的模型、缓存和运行时管理
- [ ] 支持更多 LLM 提供商
- [ ] 添加任务队列系统（Celery/RQ）

---

## 贡献

欢迎贡献代码、报告问题或提出建议！

1. Fork 本仓库
2. 创建你的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交你的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启一个 Pull Request

---

## 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

---

<div align="center">

**BriefVid** - 让视频总结更高效

Made with ❤️ by the community

</div>
