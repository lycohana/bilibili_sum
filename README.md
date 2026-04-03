# 本地视频总结服务

这是一个正在重构中的本地优先视频总结项目。

目标不是继续维护“浏览器插件驱动的脚本工具”，而是重建成一个可以长期维护的本地产品：

- 核心能力全部本地运行
- 后台服务是系统核心
- 浏览器扩展只是快捷入口
- 本地 UI 和扩展共用同一套 API
- 后续支持 Windows / macOS / Linux

## 当前进度

当前仓库已经完成第一批基础骨架：

- `packages/core`
  - 放核心领域模型和 pipeline 抽象
- `packages/infra`
  - 放配置、路径、日志、应用元信息
- `apps/service`
  - 放本地 FastAPI 后台服务

目前已经具备：

- 健康检查接口
- 系统信息接口
- 最小任务创建接口
- 最小任务查询接口
- SQLite 持久化任务仓库雏形
- 最小任务事件记录
- 最小后台 worker 占位执行

## 当前目录

```text
apps/
  service/          本地后台服务
packages/
  core/             核心处理能力
  infra/            配置、日志、路径等基础设施
tests/
  unit/             当前基础单元测试
docs/
  architecture/     架构与启动说明
```

## 本地启动

### 1. 准备 Python 环境

建议使用 Python 3.12。

### 2. 安装本地包

```powershell
python -m pip install -e .\packages\infra -e .\packages\core -e .\apps\service
```

建议同时准备 `.env`：

```powershell
Copy-Item .env.example .env
```

然后把 `.env` 里的 LLM 配置改成你自己的值。

### 3. 启动服务

```powershell
python -m video_sum_service
```

也可以直接运行：

```powershell
.\scripts\run_service.ps1
```

### 4. 访问接口

- `http://127.0.0.1:3838/`
- `http://127.0.0.1:3838/health`
- `http://127.0.0.1:3838/api/v1/system/info`
- `http://127.0.0.1:3838/api/v1/tasks`

其中：

- `/` 是当前本地 Web UI 入口
- `/api/v1/*` 是后端 API

## 当前 API

### `GET /health`

返回服务存活状态。

### `GET /api/v1/system/info`

返回应用版本、服务配置、任务状态枚举等基础信息。

### `POST /api/v1/tasks`

创建一个最小任务。

请求体示例：

```json
{
  "input_type": "url",
  "source": "https://www.bilibili.com/video/BV1xx411c7mD",
  "title": "示例视频"
}
```

### `GET /api/v1/tasks`

返回当前任务列表。

### `GET /api/v1/tasks/{task_id}`

返回单个任务详情。

### `GET /api/v1/tasks/{task_id}/result`

返回当前任务详情和结果占位。

### `GET /api/v1/tasks/{task_id}/events`

返回当前任务的事件流记录。

## 示例用法

启动服务后，可以直接提交一个 B 站链接：

```powershell
.\scripts\submit_task.ps1 -Url "https://www.bilibili.com/video/BV1R6NFzXE1H/"
```

如果你想带标题：

```powershell
.\scripts\submit_task.ps1 `
  -Url "https://www.bilibili.com/video/BV1R6NFzXE1H/" `
  -Title "我被手表的睡眠评分，骗焦虑了好几年？【差评君】"
```

## 已验证状态

下面这些已经在当前机器上实际验证通过：

- `python -m pytest`
- `python -m video_sum_service`
- `GET /health`
- `POST /api/v1/tasks`
- `GET /api/v1/tasks`
- `GET /api/v1/tasks/{task_id}/result`
- `GET /api/v1/tasks/{task_id}/events`

当前任务执行链路已经可运行，但还是 placeholder pipeline：

仓库当前已经接入真实处理链路雏形：

- `yt_dlp` 下载 B 站音频
- `faster-whisper` 执行转写
- 可选 LLM 摘要
- SQLite 持久化任务、结果和事件
- 导出 `transcript.txt` 和 `summary.json`

但它仍然属于第一版可用链路，还没有做：

- 缓存复用
- 取消/重试
- 字幕优先策略
- 更完整的错误恢复
- 正式前端界面

## 当前限制

当前还只是架构起步阶段，下面这些能力还没接入：

- 正式任务队列
- 实际下载、转写、摘要处理
- 历史记录和缓存
- 本地桌面 UI
- 浏览器扩展改造

说明：

- 当前任务已经落到 SQLite
- 已接入最小 `task_results` 和 `task_events` 表
- 已有最小后台线程 worker
- 但还没有正式队列、取消、重试、SSE

## 相关文档

- [`REFACTOR_ARCHITECTURE.md`](./REFACTOR_ARCHITECTURE.md)
- [`REFACTOR_TASK_BREAKDOWN.md`](./REFACTOR_TASK_BREAKDOWN.md)
- [`docs/architecture/bootstrap.md`](./docs/architecture/bootstrap.md)
- [`PACKAGING_INSTALL_PLAN.md`](./PACKAGING_INSTALL_PLAN.md)

## 下一步

接下来优先推进：

1. SQLite 数据模型
2. 任务仓库与事件流
3. `POST /api/v1/tasks` 到 pipeline 的执行链路
4. 历史记录与结果查询

## 安装版目标

当前仓库已经达到开发态可用，但最终目标是可安装版。

后续实现会以这条交付线为准：

- 后端打包为独立可执行文件
- 桌面 UI 负责托管服务
- 最终交付 MSI / DMG / AppImage
