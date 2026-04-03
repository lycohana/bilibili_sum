# 重构子任务拆分

## Phase 0：基线整理

### T0-1 仓库初始化与规范

- 建立 monorepo 目录骨架：`apps/`、`packages/`、`tests/`、`docs/`、`packaging/`
- 统一代码风格工具：Python `ruff` / `pytest`，前端 `eslint` / `prettier`
- 增加基础 CI：lint、unit test、build smoke test

### T0-2 现有能力盘点

- 梳理当前可复用模块
- 标记必须重写模块
- 为现有核心行为补最小测试基线

### T0-3 领域模型定义

- 定义输入类型：`url`、`video_file`、`audio_file`、`transcript_text`
- 定义任务状态机：`queued`、`running`、`completed`、`failed`、`cancelled`
- 定义结果结构：全文转写、分段摘要、关键要点、时间轴总结、导出产物

## Phase 1：`core` 核心包落地

### T1-1 core 包初始化

- 创建 `packages/core`
- 建立基础领域模型与接口
- 拆出统一错误码和异常模型

### T1-2 输入层重构

- 实现输入标准化模块
- 抽象平台解析器接口
- 先完成 Bilibili URL 解析器
- 增加本地文件输入适配

### T1-3 媒体处理模块

- 封装 ffmpeg 探测与音频抽取
- 封装 `yt-dlp` 下载器
- 输出统一媒体中间产物模型

### T1-4 字幕模块

- 字幕发现接口
- 字幕拉取与解析
- 字幕优先策略与回退到 ASR 的策略

### T1-5 转写模块

- Whisper 模型管理器
- 转写执行器
- 分段结果标准化
- 转写进度事件输出

### T1-6 摘要模块

- 规则摘要器
- 本地 LLM 摘要器接口
- 时间轴总结生成器
- 关键要点生成器

### T1-7 导出模块

- Markdown 导出
- TXT 导出
- JSON 导出
- SRT 导出

### T1-8 缓存模块

- 输入指纹生成
- 参数指纹生成
- 缓存命中判定
- 缓存读写与清理接口

### T1-9 流水线编排

- 设计 pipeline steps
- 实现 URL 输入主链路
- 实现本地文件输入主链路
- 输出标准事件流

## Phase 2：infra 与 service 基础设施

### T2-1 infra 包初始化

- 创建 `packages/infra`
- 统一配置读取
- 统一日志组件
- 统一路径与应用目录管理

### T2-2 数据库设计与迁移

- 建立 `tasks`
- 建立 `task_results`
- 建立 `task_events`
- 建立 `settings`
- 建立 `cache_entries`
- 配置 Alembic 迁移

### T2-3 service 服务入口

- 创建 `apps/service`
- 接入 FastAPI
- 配置生命周期管理
- 实现健康检查

### T2-4 任务队列

- 设计单机任务队列
- 实现任务入队
- 实现 worker 执行
- 实现取消和重试
- 实现事件持久化

### T2-5 任务 API

- `POST /api/v1/tasks`
- `GET /api/v1/tasks`
- `GET /api/v1/tasks/{id}`
- `POST /api/v1/tasks/{id}/cancel`
- `POST /api/v1/tasks/{id}/retry`

### T2-6 结果与历史 API

- `GET /api/v1/tasks/{id}/result`
- `GET /api/v1/history`
- `DELETE /api/v1/tasks/{id}`
- `GET /api/v1/tasks/{id}/export`

### T2-7 缓存与设置 API

- `GET /api/v1/cache`
- `DELETE /api/v1/cache/{key}`
- `POST /api/v1/cache/cleanup`
- `GET /api/v1/settings`
- `PUT /api/v1/settings`

### T2-8 SSE 进度流

- `GET /api/v1/tasks/{id}/events`
- 前端可订阅的标准事件格式

## Phase 3：本地 UI

### T3-1 UI 工程初始化

- 创建 `apps/desktop`
- 初始化 `React + TypeScript + Vite + Tauri`
- 建立主题和设计 token

### T3-2 API SDK

- 创建 `packages/sdk-ts`
- 定义共享类型
- 封装 API client
- 封装 SSE client

### T3-3 页面骨架

- 仪表盘页
- 新建任务页
- 任务详情页
- 结果页
- 历史页
- 设置页

### T3-4 新建任务流程

- 链接输入
- 本地文件选择
- 文本稿输入
- 参数设置面板
- 提交任务

### T3-5 任务与结果展示

- 实时进度可视化
- 结果阅读布局
- 关键要点与时间轴区块
- 导出按钮与下载

### T3-6 历史与缓存管理

- 历史筛选
- 历史详情
- 重新处理
- 删除任务
- 清理缓存

### T3-7 设置与服务状态

- 模型配置
- 路径配置
- 服务健康状态
- 主题切换

## Phase 4：浏览器扩展薄层化

### T4-1 扩展工程重建

- 创建 `apps/extension`
- 迁移到 TypeScript 架构
- 重建 background / content / sidepanel / popup

### T4-2 页面识别

- Bilibili 页面探测
- 标题、链接、时长采集
- 视频跳转能力保留

### T4-3 本地服务桥接

- 调用本地 HTTP API
- 处理服务未启动状态
- 处理版本不兼容提示

### T4-4 扩展侧边栏

- 一键提交当前链接
- 展示任务进度
- 展示简短摘要
- 打开本地结果页

### T4-5 扩展设置页

- 本地服务地址配置
- 连接测试
- 错误诊断入口

## Phase 5：打包与安装

### T5-1 Python 后端打包

- 选择 PyInstaller 或 Nuitka
- 打包 service 可执行文件
- 验证模型目录与配置目录映射

### T5-2 桌面端打包

- Windows MSI
- macOS DMG
- Linux AppImage

### T5-3 资源准备

- ffmpeg 内置或引导下载方案
- 模型按需下载方案
- 首次启动初始化流程

### T5-4 安装体验

- 安装后自动启动服务
- 桌面端可控制服务状态
- 输出诊断信息与日志导出

## Phase 6：质量与扩展性

### T6-1 测试完善

- core 单元测试
- service 集成测试
- UI 关键流程测试
- 扩展 E2E 测试

### T6-2 可观测性

- 结构化日志
- 错误码字典
- 失败诊断页面

### T6-3 失败恢复

- 任务重试
- 中断后状态恢复
- 缓存重建与清理策略

### T6-4 多平台适配器扩展

- 平台适配器接口稳定化
- YouTube 适配器
- 通用网页视频适配器预留

## 推荐执行顺序

1. `T0-1` 到 `T0-3`
2. `T1-1` 到 `T1-9`
3. `T2-1` 到 `T2-8`
4. `T3-1` 到 `T3-7`
5. `T4-1` 到 `T4-5`
6. `T5-1` 到 `T5-4`
7. `T6-1` 到 `T6-4`

## 第一批最值得立刻开工的任务

- `T0-1` 仓库初始化与规范
- `T0-3` 领域模型定义
- `T1-1` core 包初始化
- `T1-9` 流水线编排框架
- `T2-2` 数据库设计与迁移
- `T2-3` service 服务入口
- `T2-5` 任务 API

## 当前阶段优先级调整

由于最终目标是“可安装版”，后续优先级应调整为：

1. 先把后端服务做成稳定可分发产物
2. 再补本地 UI，避免最终仍依赖脚本
3. 再做浏览器扩展薄层接入
4. 最后完善多平台安装包

当前最关键的新增 Epic：

- Epic G：后端服务二进制打包
- Epic H：桌面端安装壳与服务托管

## 适合直接建 issue 的 Epic

- Epic A：核心处理层重构
- Epic B：本地后台服务化
- Epic C：本地桌面 UI 产品化
- Epic D：浏览器扩展薄层化
- Epic E：跨平台打包与安装
- Epic F：测试、恢复与可观测性
