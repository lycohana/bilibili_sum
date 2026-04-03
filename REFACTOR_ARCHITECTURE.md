# 本地视频总结服务重构方案

## 1. 项目现状判断

当前 `vedio_sum` 已经验证了最小闭环：

- 浏览器扩展可以识别 B 站页面并提交任务
- Python Native Host 可以下载音频、转写、摘要、导出
- 已有基础缓存、进度回传、取消任务、设置项

但它目前更像“浏览器插件驱动的脚本工具”，还不是“可长期维护的本地产品”。核心问题：

- 核心流程和浏览器扩展强绑定，系统入口被扩展绑死
- Native Messaging 不适合作为长期主通信协议
- `pipeline.py` 过于单体，下载、探测、转写、摘要、导出、缓存耦合在一起
- 没有正式的后台服务层、数据库、任务队列、历史记录模型
- UI 主要依赖扩展侧边栏，缺少完整本地结果页和历史管理
- 打包与安装依赖 Python 环境、ffmpeg、手工脚本，交付成本高
- 当前数据模型更偏一次性消息，不利于断点恢复、失败重试和多入口复用

结论：建议整体重构，不建议在现有结构上继续“边补边长”。

## 2. 推荐技术栈

### 总体选型

- 核心语言：Python 3.12
- 包管理：`uv`
- 核心后端框架：FastAPI
- 服务运行：Uvicorn
- 任务执行：内置 Job Queue + Worker Thread/Process
- 数据库存储：SQLite
- ORM：SQLModel 或 SQLAlchemy 2.x
- 数据校验：Pydantic v2
- 桌面/本地 UI：Tauri + React + TypeScript + Vite
- Web UI 组件：React Router + TanStack Query + Zustand
- 样式方案：Tailwind CSS + Radix UI / shadcn/ui
- 浏览器扩展：Plasmo 或标准 MV3 + TypeScript + Vite
- 下载与站点适配：`yt-dlp`
- 音频处理：`ffmpeg`
- 转写：`faster-whisper`
- 本地总结：
  - 默认规则摘要
  - 可插拔本地 LLM 适配层，优先兼容 `llama.cpp` / `Ollama` / 本地 OpenAI-compatible 服务
- 日志：`structlog` + 标准 logging
- 打包：
  - 后端 Python 二进制：PyInstaller 或 Nuitka
  - 桌面应用：Tauri bundle
  - 扩展：浏览器商店包 / 本地开发包

### 为什么这样选

- Python 适合继续承接下载、音视频处理、Whisper 推理这类成熟生态能力
- FastAPI 很适合把 Native Host 升级为正式本地 HTTP 服务，扩展和本地 UI 都能共用
- SQLite 足够承接单机任务、历史、缓存、配置，部署最轻
- Tauri 比 Electron 更轻，适合“本地常驻服务 + 轻桌面壳”场景
- React 生态成熟，适合构建历史、长文本阅读、任务面板、设置页
- 扩展只调用本地 HTTP API 后，职责会非常清晰，后续适配更多网站也容易

## 3. 重构后的目录结构

```text
video-summarizer/
├─ apps/
│  ├─ service/                    # 本地后台服务入口
│  │  ├─ src/
│  │  │  ├─ api/
│  │  │  ├─ workers/
│  │  │  ├─ schedulers/
│  │  │  ├─ dependencies/
│  │  │  └─ main.py
│  │  └─ pyproject.toml
│  ├─ desktop/                    # Tauri + React 本地桌面 UI
│  │  ├─ src/
│  │  ├─ src-tauri/
│  │  └─ package.json
│  └─ extension/                  # 浏览器扩展
│     ├─ src/
│     │  ├─ background/
│     │  ├─ content/
│     │  ├─ popup/
│     │  ├─ sidepanel/
│     │  └─ shared/
│     └─ package.json
├─ packages/
│  ├─ core/                       # 纯核心处理逻辑，不依赖 FastAPI / UI / 浏览器
│  │  ├─ src/video_sum_core/
│  │  │  ├─ ingest/
│  │  │  ├─ subtitle/
│  │  │  ├─ media/
│  │  │  ├─ transcription/
│  │  │  ├─ summarization/
│  │  │  ├─ export/
│  │  │  ├─ cache/
│  │  │  ├─ models/
│  │  │  └─ pipeline/
│  │  └─ pyproject.toml
│  ├─ infra/
│  │  ├─ src/video_sum_infra/
│  │  │  ├─ config/
│  │  │  ├─ db/
│  │  │  ├─ logging/
│  │  │  ├─ model_registry/
│  │  │  ├─ paths/
│  │  │  └─ errors/
│  │  └─ pyproject.toml
│  ├─ sdk-python/                 # 内部 Python SDK，可供脚本或桌面壳调用
│  └─ sdk-ts/                     # UI / extension 共用 API client 和类型
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ e2e/
│  └─ fixtures/
├─ packaging/
│  ├─ pyinstaller/
│  ├─ tauri/
│  ├─ installers/
│  └─ extension/
├─ docs/
│  ├─ architecture/
│  ├─ api/
│  ├─ ui/
│  └─ operations/
├─ scripts/
├─ .github/
└─ pyproject.toml
```

## 4. 各模块职责划分

### `packages/core`

负责纯处理能力，不关心 UI、HTTP、浏览器、数据库。

- `ingest`
  - 输入统一抽象
  - 支持 URL、本地视频、本地音频、纯文本稿
  - 平台适配器接口，当前先实现 Bilibili，再扩展 YouTube/本地文件
- `subtitle`
  - 页面字幕获取、已有字幕下载、字幕格式统一
- `media`
  - 音频抽取、媒体探测、ffmpeg 调用封装
- `transcription`
  - Whisper 模型加载、转写、分段、语言设置、进度事件
- `summarization`
  - 规则摘要
  - 本地 LLM 摘要适配器
  - 时间轴总结、关键要点、分段摘要
- `export`
  - Markdown / TXT / JSON / SRT 导出
- `cache`
  - 基于输入指纹 + 参数指纹的产物缓存
- `pipeline`
  - 编排流程，但只处理领域级步骤，不处理 HTTP 和数据库

### `apps/service`

系统核心。对外暴露统一 API。

- HTTP API
- 任务队列
- Worker 生命周期管理
- 任务状态机
- 历史记录读写
- 缓存命中判断
- 失败重试和恢复
- 健康检查
- 配置管理
- 为 UI 和扩展提供统一接口

### `apps/desktop`

本地产品主界面。

- 提交任务
- 查看处理中任务
- 查看历史与结果
- 设置模型、路径、缓存策略
- 启停后台服务
- 承载完整长文本阅读和导出入口

### `apps/extension`

浏览器薄层。

- 识别页面视频上下文
- 一键提交链接到本地服务
- 查询任务进度
- 展示短摘要
- 跳转本地完整结果页

### `packages/infra`

- 配置读取和默认值
- 跨平台路径规范
- SQLite 连接和迁移
- 日志与错误码
- 模型目录管理
- 系统资源检测

## 5. 本地后台 API 设计

推荐前缀：`/api/v1`

### 健康与系统

- `GET /health`
  - 返回服务状态、版本、数据库状态、worker 状态
- `GET /system/info`
  - OS、Python runtime、ffmpeg、模型目录、磁盘占用
- `GET /system/capabilities`
  - 支持的平台、输入类型、导出格式、已安装模型

### 任务

- `POST /tasks`
  - 创建任务
  - 输入体：
    - `inputType`: `url | video_file | audio_file | transcript_text`
    - `source`
    - `title`
    - `platformHint`
    - `options`
  - 返回：
    - `taskId`
    - `status`
    - `cacheHit`

- `GET /tasks`
  - 分页查询任务列表
  - 支持 `status`、`sourceType`、`keyword`

- `GET /tasks/{taskId}`
  - 查询任务详情

- `GET /tasks/{taskId}/events`
  - 查询进度事件流

- `POST /tasks/{taskId}/cancel`
  - 取消任务

- `POST /tasks/{taskId}/retry`
  - 失败任务重试

- `DELETE /tasks/{taskId}`
  - 删除任务记录

### 结果

- `GET /tasks/{taskId}/result`
  - 返回：
    - transcript
    - segment summaries
    - key points
    - timeline summary
    - artifacts

- `GET /tasks/{taskId}/export?format=md|txt|json|srt`
  - 下载导出结果

### 历史与缓存

- `GET /history`
  - 历史记录列表

- `GET /history/{taskId}`
  - 某条历史详情

- `GET /cache`
  - 缓存列表与大小

- `DELETE /cache/{cacheKey}`
  - 删除单条缓存

- `POST /cache/cleanup`
  - 按策略清理缓存

### 配置

- `GET /settings`
- `PUT /settings`
- `GET /models`
- `POST /models/pull`
- `POST /models/validate`

### 实时通信建议

- UI 和扩展都支持：
  - 轮询：简单稳定
  - SSE：用于任务进度流

不建议一开始上 WebSocket。SSE 足够支撑“单向进度广播”。

## 6. 数据模型建议

### `tasks`

- `id`
- `status`
- `source_type`
- `source_value`
- `platform`
- `title`
- `duration`
- `fingerprint`
- `cache_key`
- `error_code`
- `error_message`
- `created_at`
- `started_at`
- `finished_at`

### `task_options`

- `task_id`
- `language`
- `transcription_model`
- `summary_mode`
- `summary_model`
- `export_formats`

### `task_results`

- `task_id`
- `transcript_text`
- `segments_json`
- `summary_json`
- `key_points_json`
- `timeline_json`
- `artifacts_json`

### `task_events`

- `id`
- `task_id`
- `stage`
- `progress`
- `message`
- `payload_json`
- `created_at`

### `settings`

- `key`
- `value_json`

### `cache_entries`

- `cache_key`
- `fingerprint`
- `input_type`
- `artifact_paths_json`
- `size_bytes`
- `last_accessed_at`

## 7. 本地 UI 页面结构

推荐信息架构如下：

### 1. 仪表盘 `/`

- 顶部快速提交框
- 最近任务状态卡片
- 模型/服务健康状态
- 最近历史摘要卡片

### 2. 新建任务 `/new`

- 输入方式切换
  - 视频链接
  - 本地视频
  - 本地音频
  - 文本稿
- 参数配置区
  - 语言
  - 字幕优先 / 语音转写优先
  - 摘要模式
  - 输出格式
- 提交按钮

### 3. 任务详情 `/tasks/:id`

- 顶部状态条
- 左侧：阶段进度、处理参数、源信息
- 右侧：运行日志/事件流
- 底部：失败重试、取消、重新导出

### 4. 结果页 `/results/:id`

- 头部摘要卡片
- 关键要点区
- 时间轴总结区
- 分段摘要区
- 全文转写区
- 导出按钮组

### 5. 历史页 `/history`

- 列表 + 搜索 + 过滤
- 支持按平台、状态、时间筛选
- 支持删除、重新处理、打开结果

### 6. 缓存管理 `/cache`

- 缓存占用统计
- 单条缓存查看
- 清理策略设置

### 7. 设置页 `/settings`

- 基础路径
- ffmpeg / 模型路径
- 转写模型
- 本地 LLM 提供者配置
- 默认导出格式
- 主题设置

### UI 风格建议

- 桌面端采用卡片 + 双栏阅读布局
- 结果页偏 Notion/Linear 风格，不要像管理后台
- 字体、间距、层次更偏内容产品
- 支持暗色/浅色主题
- 历史和结果页优先阅读体验，而不是表格堆满

## 8. 浏览器扩展结构

```text
apps/extension/src/
├─ background/
│  ├─ service-bridge.ts          # 调本地 HTTP API
│  ├─ task-store.ts
│  └─ index.ts
├─ content/
│  ├─ bilibili-detector.ts
│  ├─ page-context.ts
│  └─ inject-entry.ts
├─ sidepanel/
│  ├─ page.tsx
│  ├─ components/
│  └─ hooks/
├─ popup/
│  └─ page.tsx
└─ shared/
   ├─ api-client.ts
   ├─ types.ts
   └─ constants.ts
```

### 扩展职责约束

扩展只做这些事：

- 识别视频页面和标题
- 获取当前 URL
- 提交任务给 `http://127.0.0.1:<port>`
- 轮询或订阅任务进度
- 显示简短摘要
- 打开本地 UI 的完整结果页

扩展不做这些事：

- 下载视频/音频
- 调 ffmpeg
- 调 Whisper
- 调模型推理
- 存储完整历史和缓存

### 扩展与本地服务通信

- 开发期可先使用固定端口，例如 `127.0.0.1:3838`
- 生产期建议支持端口发现或固定配置
- 本地服务增加 token 或 origin 白名单，避免被任意网页调用

## 9. 跨平台打包方案

## 推荐交付形态

最终交付为“两件套”：

- 桌面应用安装包
- 浏览器扩展安装包

其中桌面应用内置：

- 后台服务二进制
- 核心 Python 运行时
- 默认配置和目录结构

### Windows

- 桌面应用：Tauri MSI
- 后端：PyInstaller 单目录打包
- ffmpeg：
  - 优先随安装包分发
  - 或首次启动引导下载到应用数据目录

### macOS

- 桌面应用：`.dmg`
- 后端：PyInstaller / Nuitka
- Apple Silicon 与 Intel 分别构建或做 Universal

### Linux

- `AppImage` 优先
- 可补充 `.deb`

### 模型与大文件策略

- 应用首次启动只安装最小运行时
- Whisper 模型按需下载到统一模型目录
- ffmpeg 如未内置，首次检测缺失时引导安装
- 未来可加入“资源准备向导”

## 10. 分阶段重构计划

### Phase 0：冻结旧结构，抽取现状资产

- 停止继续往 Native Messaging 架构加新功能
- 梳理现有可复用代码
- 补齐现有行为基线测试

### Phase 1：先立本地服务核心

- 新建 `packages/core`
- 新建 `apps/service`
- 把现有 `pipeline.py` 拆成独立模块
- 建立 SQLite 数据模型
- 先完成 URL 输入链路
- 用 FastAPI 暴露任务 API

目标：不依赖扩展，也能通过本地 UI 或 curl 完成任务。

### Phase 2：重做本地 UI

- 先上本地 Web UI
- 再用 Tauri 包装为桌面应用
- 接入任务列表、结果页、历史页、设置页

目标：让本地产品成为真正主入口。

### Phase 3：扩展降级为薄入口

- 扩展改为只识别页面并调本地 API
- 删除 Native Messaging 依赖
- 只保留页面上下文识别、快捷提交、查看摘要、打开结果页

目标：扩展从“主系统”变成“遥控器”。

### Phase 4：缓存、恢复、可观测性

- 引入任务事件表
- 引入失败重试
- 完成缓存管理页
- 增加结构化日志和诊断导出

### Phase 5：多平台与可扩展平台支持

- 抽象平台适配器接口
- 增加 YouTube / 通用网页视频支持
- 完成 Windows / macOS / Linux 打包流水线

## 11. 旧代码保留与重写建议

### 建议保留并迁移

- `native_host/utils.py`
  - URL 规范化、文件名清洗、时间格式化这类工具函数可迁移
- `native_host/cache_store.py`
  - 缓存 key 设计思路可以保留，但实现要升级成带元数据的缓存仓库
- `native_host/errors.py`
  - 错误码体系值得保留并扩展
- `native_host/summarizer.py`
  - 规则摘要逻辑可作为最小 fallback 保留，但需重构为独立策略
- `tests/` 中围绕 URL 规范化、模型选择、缓存 key 的基础测试
  - 这些可以迁移为 `packages/core` 单元测试
- 扩展里对页面上下文探测的逻辑
  - 可以保留思路，但代码组织需要重做

### 建议部分重写

- `native_host/llm_client.py`
  - 保留接口目标，不保留当前实现细节
- `extension/background.js`
  - 逻辑价值在，但通信方式应改成本地 HTTP API，基本需要重写
- `extension/sidepanel.js`
  - 可以保留状态展示需求和交互点，但建议用 React 重做
- `extension/options.*`
  - 设置项应拆分为“扩展设置”和“本地服务设置”，整体建议重做

### 建议直接重写

- `native_host/host.py`
  - Native Messaging 主架构不再适合作为核心服务入口
- `native_host/protocol.py`
  - 属于旧通信协议，后续应由 HTTP + SSE 替代
- `native_host/pipeline.py`
  - 过于单体，建议按模块职责彻底拆分重写
- `scripts/install_windows.ps1`
  - 安装方式应升级为正式打包安装，不再依赖手工 Python 环境脚本
- `native_host/manifests/*.json`
  - 这是 Native Messaging 时代遗留物，后续可以废弃

## 12. 最终推荐工程方案

### 最推荐的落地组合

- 后端核心：Python + FastAPI + SQLite
- 核心处理：独立 `core` 包
- 本地 UI：Tauri + React
- 浏览器扩展：MV3 + TypeScript，作为本地服务遥控器
- 打包：Tauri 安装包 + PyInstaller 后端

### 这是最适合这个项目的原因

- 保住现有 Python 音视频与转写生态，不需要高风险换栈
- 真正把“核心能力”从浏览器扩展里抽出来，符合本地产品定位
- 本地 UI 和扩展共享同一 API，后续维护成本明显下降
- SQLite + 本地服务足以支撑任务队列、历史、缓存、恢复，不会过度设计
- Tauri 可以把“后台服务常驻 + 桌面入口 + 跨平台打包”串起来
- 未来扩展平台支持时，只需新增适配器，不需要重做整套系统

## 13. 一句话判断

这个项目最合适的演进路径不是“继续增强插件”，而是“把插件降级成入口，把本地服务升级成产品核心，把桌面 UI 升级成主界面”。
