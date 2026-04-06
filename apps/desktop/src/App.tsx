import { FormEvent, SVGProps, useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";

import { TitleBar } from "./components/TitleBar";
import { UpdateDialog, type UpdateInfo } from "./components/UpdateDialog";
import { api } from "./api";
import type {
  EnvironmentInfo,
  ServiceSettings,
  SystemInfo,
  TaskDetail,
  TaskEvent,
  TaskStatus,
  TaskSummary,
  VideoAssetDetail,
  VideoAssetSummary,
} from "./types";
import { formatDateTime, formatDuration, formatTaskDuration, formatTokenCount, summarizeEvents, taskStatusLabel } from "./utils";

type Snapshot = {
  serviceOnline: boolean;
  systemInfo: SystemInfo | null;
  environment: EnvironmentInfo | null;
  settings: ServiceSettings | null;
  videos: VideoAssetSummary[];
  error: string;
};

type DesktopState = {
  version: string;
  backend: {
    running: boolean;
    ready: boolean;
    pid: number | null;
    url: string;
    lastError: string;
  } | null;
  logPath: string;
};

type UpdateState = {
  status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  version: string;
  releaseDate: string;
  releaseNotes: string | null;
  downloadProgress: number;
  errorMessage: string | null;
};

type LibraryFilter = "all" | "completed" | "running" | "with-result";
type MetricTone = "default" | "accent" | "success" | "info";

const emptySnapshot: Snapshot = { serviceOnline: false, systemInfo: null, environment: null, settings: null, videos: [], error: "" };

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [desktop, setDesktop] = useState<DesktopState>({ version: "", backend: null, logPath: "" });
  const [query, setQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [probeUrl, setProbeUrl] = useState("");
  const [submitStatus, setSubmitStatus] = useState("");
  const [probePreview, setProbePreview] = useState<VideoAssetSummary | null>(null);
  const [refreshSeed, setRefreshSeed] = useState(0);
  
  // 更新状态
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: "idle",
    version: "",
    releaseDate: "",
    releaseNotes: null,
    downloadProgress: 0,
    errorMessage: null,
  });

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    async function bootstrap() {
      if (!window.desktop) return;
      const [version, backend, logPath] = await Promise.all([
        window.desktop.app.getVersion(),
        window.desktop.backend.status(),
        window.desktop.logs.getServiceLogPath(),
      ]);
      setDesktop({ version, backend, logPath });
      cleanup = window.desktop.backend.onStatus((status) => setDesktop((current) => ({ ...current, backend: status })));
      
      // 监听更新状态
      const updateCleanup = window.desktop.update?.onStatus((status) => {
        setUpdateState({
          status: status.status,
          version: status.version,
          releaseDate: status.releaseDate,
          releaseNotes: status.releaseNotes,
          downloadProgress: status.downloadProgress,
          errorMessage: status.errorMessage,
        });
        
        // 当有可用更新时自动打开对话框
        if (status.status === "available" || status.status === "downloaded") {
          setUpdateDialogOpen(true);
        }
      });
      
      return () => {
        cleanup?.();
        updateCleanup?.();
      };
    }
    void bootstrap();
    return () => {};
  }, []);

  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try {
        const [health, systemInfo, settings, videos, environment] = await Promise.all([
          api.getHealth(),
          api.getSystemInfo(),
          api.getSettings(),
          api.listVideos(),
          api.getEnvironment(),
        ]);
        if (!disposed) {
          setSnapshot({ serviceOnline: health.status === "ok", systemInfo, settings, environment, videos, error: "" });
        }
      } catch (error) {
        if (!disposed) {
          setSnapshot((current) => ({ ...current, serviceOnline: false, error: error instanceof Error ? error.message : "服务暂不可用" }));
        }
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [refreshSeed]);

  const latestVideo = useMemo(() => {
    return [...snapshot.videos].sort(
      (left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime(),
    )[0] ?? null;
  }, [snapshot.videos]);

  const libraryCounts = useMemo(() => {
    const completed = snapshot.videos.filter((item) => item.latest_status === "completed").length;
    const running = snapshot.videos.filter((item) => item.latest_status === "running").length;
    const withResult = snapshot.videos.filter((item) => item.has_result).length;
    return {
      total: snapshot.videos.length,
      completed,
      running,
      withResult,
    };
  }, [snapshot.videos]);

  const filteredVideos = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return [...snapshot.videos]
      .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
      .filter((video) => {
        if (!keyword) return true;
        return video.title.toLowerCase().includes(keyword) || video.source_url.toLowerCase().includes(keyword);
      })
      .filter((video) => {
        if (libraryFilter === "completed") return video.latest_status === "completed";
        if (libraryFilter === "running") return video.latest_status === "running";
        if (libraryFilter === "with-result") return video.has_result;
        return true;
      });
  }, [libraryFilter, query, snapshot.videos]);

  // 首页最近视频列表：始终使用未过滤的视频列表，独立于视频库的搜索和状态过滤
  const recentVideos = useMemo(() => {
    return [...snapshot.videos]
      .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
      .slice(0, 6);
  }, [snapshot.videos]);

  const runtimeDeviceLabel = useMemo(() => {
    const rawDevice = (
      snapshot.environment?.recommendedDevice
      || snapshot.settings?.device_preference
      || ""
    ).toLowerCase();

    if (snapshot.environment?.cudaAvailable || rawDevice.includes("cuda") || rawDevice.includes("gpu")) {
      return "GPU";
    }
    return "CPU";
  }, [snapshot.environment, snapshot.settings]);

  async function handleProbe(event: FormEvent) {
    event.preventDefault();
    if (!probeUrl.trim()) {
      setSubmitStatus("请输入视频链接");
      return;
    }
    setSubmitStatus("正在抓取视频信息并准备开始总结...");
    try {
      const response = await api.probeVideo({ url: probeUrl.trim(), force_refresh: false });
      setProbePreview(response.video);
      await api.createVideoTask(response.video.video_id);
      setSubmitStatus(response.cached ? "已从视频库读取并开始总结" : "视频已加入本地库并开始总结");
      setProbeUrl("");
      setRefreshSeed((value) => value + 1);
      navigate(`/videos/${response.video.video_id}`);
    } catch (error) {
      setSubmitStatus(error instanceof Error ? error.message : "开始总结失败");
    }
  }

  const pageMeta = location.pathname.startsWith("/settings")
    ? {
      eyebrow: "设置中心",
      title: "运行配置、环境检测与日志",
      description: "围绕本地推理环境、模型配置与桌面端服务控制，统一管理 BriefVid 的运行能力。",
    }
    : location.pathname.startsWith("/videos/")
      ? {
        eyebrow: "视频详情",
        title: "本地摘要结果与任务记录",
        description: "围绕单个视频集中查看摘要、时间轴、转写全文与任务处理进度。",
      }
      : {
        eyebrow: "BriefVid Workspace",
        title: "懒得看视频？一键省流！",
        description: "把时间留给真正有质量的视频",
      };

  return (
    <div className="app-shell">
      <TitleBar />
      <aside className="sidebar">
        <div className="nav-group-label">主导航</div>
        <nav className="nav">
          <Link className={`nav-item ${location.pathname === "/" ? "active" : ""}`} to="/">
            <span className="nav-icon" aria-hidden="true"><HomeIcon /></span>
            <span className="nav-copy">
              <strong>首页</strong>
              <small>工作台总览</small>
            </span>
          </Link>
        </nav>

        <div className="nav-group-label">管理</div>
        <nav className="nav">
          <Link className={`nav-item ${location.pathname === "/library" ? "active" : ""}`} to="/library">
            <span className="nav-icon" aria-hidden="true"><LibraryIcon /></span>
            <span className="nav-copy">
              <strong>视频库</strong>
              <small>摘要与资产管理</small>
            </span>
          </Link>
          <Link className={`nav-item ${location.pathname.startsWith("/settings") ? "active" : ""}`} to="/settings">
            <span className="nav-icon" aria-hidden="true"><SettingsIcon /></span>
            <span className="nav-copy">
              <strong>设置</strong>
              <small>环境与运行控制</small>
            </span>
          </Link>
        </nav>

        <section className="live-panel">
          <div className="panel-header panel-header-subtle">
            <h2>运行状态</h2>
            <p></p>
          </div>
          <div className="status-stack">
            <SidebarStatusItem
              label="服务"
              tone={snapshot.serviceOnline ? "success" : "default"}
              value={snapshot.serviceOnline ? "在线" : desktop.backend?.running ? "启动中" : "离线"}
            />
            <SidebarStatusItem label="最近任务" value={latestVideo?.title ?? "暂无任务"} />
            <SidebarStatusItem label="版本" value={desktop.version} />
            <SidebarStatusItem label="运行设备" value={runtimeDeviceLabel} />
          </div>
        </section>
      </aside>

      <main className="content">
        <div className="content-frame">
          <header className="page-header">
            <div className="page-header-content">
              <p className="eyebrow">{pageMeta.eyebrow}</p>
              <h2>{pageMeta.title}</h2>
              <p className="page-description">{pageMeta.description}</p>
            </div>
          </header>

          {snapshot.error && !snapshot.serviceOnline ? (
            <section className="grid-card empty-state-card">
              <div className="spinner"></div>
              <h3>后端暂未就绪</h3>
              <p>{snapshot.error}</p>
              <div className="desktop-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={async () => {
                    await window.desktop?.backend.start();
                    setRefreshSeed((value) => value + 1);
                  }}
                >
                  重新拉起后端
                </button>
                <button className="secondary-button" type="button" onClick={() => setRefreshSeed((value) => value + 1)}>重新检测</button>
              </div>
            </section>
          ) : (
            <Routes>
              <Route
                path="/"
                element={(
                  <HomePage
                    latestVideo={latestVideo}
                    probePreview={probePreview}
                    probeUrl={probeUrl}
                    setProbeUrl={setProbeUrl}
                    submitStatus={submitStatus}
                    serviceOnline={snapshot.serviceOnline}
                    runtimeDeviceLabel={runtimeDeviceLabel}
                    onProbe={handleProbe}
                    recentVideos={recentVideos}
                  />
                )}
              />
              <Route
                path="/library"
                element={(
                  <LibraryPage
                    snapshot={snapshot}
                    filteredVideos={filteredVideos}
                    libraryCounts={libraryCounts}
                    latestVideo={latestVideo}
                    query={query}
                    setQuery={setQuery}
                    activeFilter={libraryFilter}
                    setLibraryFilter={setLibraryFilter}
                    serviceOnline={snapshot.serviceOnline}
                    runtimeDeviceLabel={runtimeDeviceLabel}
                  />
                )}
              />
              <Route path="/videos/:videoId" element={<VideoDetailPage onRefresh={() => setRefreshSeed((value) => value + 1)} />} />
              <Route path="/settings" element={<SettingsPage desktop={desktop} onRefresh={() => setRefreshSeed((value) => value + 1)} snapshot={snapshot} />} />
            </Routes>
          )}
        </div>
      </main>
      
      <UpdateDialog
        isOpen={updateDialogOpen}
        updateInfo={updateState as UpdateInfo}
        currentVersion={desktop.version}
        onClose={() => setUpdateDialogOpen(false)}
        onCheck={async () => {
          if (window.desktop?.update) {
            const result = await window.desktop.update.check();
            setUpdateState({
              status: result.status,
              version: result.version,
              releaseDate: result.releaseDate,
              releaseNotes: result.releaseNotes,
              downloadProgress: result.downloadProgress,
              errorMessage: result.errorMessage,
            });
          }
        }}
        onDownload={async () => {
          if (window.desktop?.update) {
            await window.desktop.update.download();
          }
        }}
        onInstall={async () => {
          if (window.desktop?.update) {
            await window.desktop.update.install();
          }
        }}
      />
    </div>
  );
}

function SidebarStatusItem({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "success" }) {
  return (
    <div className={`sidebar-status-item ${tone === "success" ? "is-success" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: MetricTone;
}) {
  return (
    <div className={`summary-metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function HomePage({
  latestVideo,
  probePreview,
  probeUrl,
  setProbeUrl,
  submitStatus,
  serviceOnline,
  runtimeDeviceLabel,
  onProbe,
  recentVideos,
}: {
  latestVideo: VideoAssetSummary | null;
  probePreview: VideoAssetSummary | null;
  probeUrl: string;
  setProbeUrl(value: string): void;
  submitStatus: string;
  serviceOnline: boolean;
  runtimeDeviceLabel: string;
  onProbe(event: FormEvent): Promise<void>;
  recentVideos: VideoAssetSummary[];
}) {
  return (
    <section className="home-page">
      {/* 欢迎区域 */}
      <article className="grid-card welcome-card">
        <div className="panel-header">
          <p className="section-kicker">欢迎使用</p>
          <h2>BriefVid 工作台</h2>
          <p>输入视频链接，开始本地智能总结。</p>
        </div>

        <form className="task-form refined-task-form" onSubmit={onProbe}>
          <div className="task-form-row">
            <label className="input-row input-row-hero">
              <span className="input-label">输入视频链接</span>
              <div className="input-with-icon">
                <span className="input-icon" aria-hidden="true"><LinkIcon /></span>
                <input
                  className="input-field input-field-hero"
                  type="url"
                  value={probeUrl}
                  onChange={(event) => setProbeUrl(event.target.value)}
                  placeholder="粘贴视频链接，例如 https://www.bilibili.com/video/..."
                  required
                />
              </div>
            </label>
            <button className="primary-button primary-button-hero" type="submit">开始总结</button>
          </div>

          {submitStatus ? <div className="submit-status">{submitStatus}</div> : null}
        </form>

        {probePreview ? (
          <article className="probe-preview">
            <img src={probePreview.cover_url} alt={probePreview.title} />
            <div className="probe-preview-copy">
              <span className="section-kicker">即将加入视频库</span>
              <strong>{probePreview.title}</strong>
              <small>{formatDuration(probePreview.duration)} · {platformLabel(probePreview.platform)}</small>
            </div>
          </article>
        ) : null}
      </article>

      {/* 最近视频 */}
      <article className="grid-card recent-videos-card">
        <div className="panel-header">
          <p className="section-kicker">Recent Videos</p>
          <h2>最近视频</h2>
          <p>最新处理的 {recentVideos.length} 个视频</p>
        </div>

        {recentVideos.length > 0 ? (
          <div className="video-grid">
            {recentVideos.map((video) => <VideoCard key={video.video_id} video={video} />)}
          </div>
        ) : (
          <div className="empty-placeholder">
            还没有视频，先输入一个链接开始总结吧。
          </div>
        )}
      </article>
    </section>
  );
}

function LibraryPage({
  snapshot,
  filteredVideos,
  libraryCounts,
  latestVideo,
  query,
  setQuery,
  activeFilter,
  setLibraryFilter,
  serviceOnline,
  runtimeDeviceLabel,
}: {
  snapshot: Snapshot;
  filteredVideos: VideoAssetSummary[];
  libraryCounts: { total: number; completed: number; running: number; withResult: number };
  latestVideo: VideoAssetSummary | null;
  query: string;
  setQuery(value: string): void;
  activeFilter: LibraryFilter;
  setLibraryFilter(value: LibraryFilter): void;
  serviceOnline: boolean;
  runtimeDeviceLabel: string;
}) {
  const filters: Array<{ id: LibraryFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: libraryCounts.total },
    { id: "completed", label: "已完成", count: libraryCounts.completed },
    { id: "running", label: "处理中", count: libraryCounts.running },
    { id: "with-result", label: "有结果", count: libraryCounts.withResult },
  ];

  return (
    <section className="library-page">
      {/* 视频库概览 */}
      <article className="grid-card library-summary-card">
        <div className="panel-header">
          <p className="section-kicker">Overview</p>
          <h2>视频库概览</h2>
          <p>数据层级保持在第二优先级，用更轻的卡片承接状态概览。</p>
        </div>

        <div className="library-summary-grid">
          <Metric label="视频总数" value={String(libraryCounts.total)} detail="本地已收录资产" tone="accent" />
          <Metric label="已完成" value={String(libraryCounts.completed)} detail="可查看完整摘要" tone="success" />
          <Metric label="处理中" value={String(libraryCounts.running)} detail="正在进行转写或总结" tone="info" />
          <Metric label="有结果" value={String(libraryCounts.withResult)} detail="摘要结果已沉淀" />
        </div>

        <div className="summary-insight">
          <div className="summary-insight-copy">
            <span>最近更新</span>
            <strong>{latestVideo?.title ?? "等待首个视频进入视频库"}</strong>
            <small>{latestVideo ? `${formatShortDate(latestVideo.updated_at)} · ${platformLabel(latestVideo.platform)}` : "输入链接后自动抓取并入库"}</small>
          </div>
          <span className={`summary-insight-pill ${serviceOnline ? "is-online" : ""}`}>
            {serviceOnline ? `服务在线 · ${runtimeDeviceLabel}` : "服务离线"}
          </span>
        </div>
      </article>

      <section className="grid-card library-grid-card">
        <div className="library-section-head">
          <div className="panel-header">
            <p className="section-kicker">Video Library</p>
            <h2>视频库</h2>
            <p>{snapshot.videos.length} 个视频资产，支持搜索、状态筛选与详情跳转。</p>
          </div>

          <label className="search-field">
            <span className="search-icon" aria-hidden="true"><SearchIcon /></span>
            <input
              className="input-field input-field-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题或来源链接..."
            />
          </label>
        </div>

        <div className="filter-pill-row">
          {filters.map((filter) => (
            <button
              key={filter.id}
              className={`filter-pill ${activeFilter === filter.id ? "active" : ""}`}
              type="button"
              onClick={() => setLibraryFilter(filter.id)}
            >
              <span>{filter.label}</span>
              <strong>{filter.count}</strong>
            </button>
          ))}
        </div>

        <div className="video-grid">
          {filteredVideos.length ? filteredVideos.map((video) => <VideoCard key={video.video_id} video={video} />) : (
            <div className="empty-placeholder">当前筛选条件下还没有视频，先输入一个链接开始总结。</div>
          )}
        </div>
      </section>
    </section>
  );
}

function VideoCard({ video }: { video: VideoAssetSummary }) {
  const badgeClass = taskStatusClass(video.latest_status);

  return (
    <Link className="video-card" to={`/videos/${video.video_id}`}>
      <div className="video-card-cover">
        {video.cover_url ? <img src={video.cover_url} alt={video.title} loading="lazy" /> : <div className="video-card-placeholder">VIDEO</div>}
        <span className="video-duration">{formatDuration(video.duration)}</span>
      </div>
      <div className="video-card-body">
        <div className="video-card-topline">
          <span className="video-platform-badge">{platformLabel(video.platform)}</span>
          <span className={`task-status ${badgeClass}`}>{taskStatusLabel(video.latest_status)}</span>
        </div>
        <h3>{video.title}</h3>
      </div>
    </Link>
  );
}

function VideoDetailPage({ onRefresh }: { onRefresh(): void }) {
  const { videoId = "" } = useParams();
  const navigate = useNavigate();
  const [video, setVideo] = useState<VideoAssetDetail | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [status, setStatus] = useState("");
  const lastAutoRefreshEventRef = useRef<string | null>(null);

  async function refreshDetail(taskId?: string | null) {
    const [videoDetail, videoTasks] = await Promise.all([api.getVideo(videoId), api.getVideoTasks(videoId)]);
    setVideo(videoDetail);
    setTasks(videoTasks);
    const targetTaskId = taskId && videoTasks.some((item) => item.task_id === taskId) ? taskId : videoTasks[0]?.task_id;
    if (targetTaskId) {
      const [detail, taskEvents] = await Promise.all([api.getTaskResult(targetTaskId), api.getTaskEvents(targetTaskId)]);
      setSelectedTask(detail);
      setEvents(taskEvents);
    } else {
      setSelectedTask(null);
      setEvents([]);
    }
    onRefresh();
  }

  useEffect(() => {
    void refreshDetail();
  }, [videoId]);

  useEffect(() => {
    if (!selectedTask?.task_id) return;
    const source = api.createTaskEventSource(selectedTask.task_id, events.at(-1)?.created_at);
    source.addEventListener("progress", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { event: TaskEvent };
      setEvents((current) => current.some((item) => item.event_id === payload.event.event_id) ? current : [...current, payload.event]);
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [selectedTask?.task_id]);

  useEffect(() => {
    lastAutoRefreshEventRef.current = null;
  }, [selectedTask?.task_id]);

  useEffect(() => {
    if (!selectedTask?.task_id || !events.length) return;
    const terminalEvent = [...events].reverse().find((event) => (
      event.stage === "completed" || event.stage === "failed" || event.stage === "cancelled"
    ));
    if (!terminalEvent) return;
    const refreshKey = `${selectedTask.task_id}:${terminalEvent.event_id}`;
    if (lastAutoRefreshEventRef.current === refreshKey) return;
    lastAutoRefreshEventRef.current = refreshKey;

    const timer = window.setTimeout(() => {
      void refreshDetail(selectedTask.task_id);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [events, selectedTask?.task_id]);

  if (!video) return <section className="grid-card empty-state-card">正在加载视频详情...</section>;
  const progress = summarizeEvents(events);

  return (
    <section className="video-detail-page">
      <div className="detail-page-toolbar"><Link className="secondary-button" to="/">返回视频库</Link></div>

      <article className="video-detail-hero">
        <a className="video-detail-cover" href={video.source_url} target="_blank" rel="noreferrer">
          {video.cover_url ? <img src={video.cover_url} alt={video.title} loading="lazy" /> : <div className="video-card-placeholder">VIDEO</div>}
        </a>
        <div className="video-detail-copy">
          <div className="hero-chip-row">
            <span className={`mini-chip ${taskStatusClass(video.latest_status)}`}>{taskStatusLabel(video.latest_status)}</span>
            <span className="mini-chip">{formatDuration(video.duration)}</span>
            <span className="mini-chip">{formatDateTime(video.updated_at)}</span>
          </div>
          <h1 className="video-detail-title">{video.title}</h1>
          <div className="detail-hero-actions">
            <button
              className="primary-button"
              type="button"
              onClick={async () => {
                setStatus("正在创建处理任务...");
                const task = await api.createVideoTask(video.video_id);
                await refreshDetail(task.task_id);
                setStatus("已开始新的摘要任务");
              }}
            >
              重新生成摘要
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={async () => {
                setStatus("正在刷新视频信息...");
                await api.probeVideo({ url: video.source_url, force_refresh: true });
                await refreshDetail(selectedTask?.task_id);
                setStatus("视频信息已刷新");
              }}
            >
              刷新视频信息
            </button>
            <button
              className="secondary-button danger-outline"
              type="button"
              onClick={async () => {
                if (!window.confirm("确定要从视频库删除这个视频吗？")) return;
                await api.deleteVideo(video.video_id);
                onRefresh();
                navigate("/");
              }}
            >
              从视频库删除
            </button>
          </div>
          {status ? <div className="submit-status">{status}</div> : null}
        </div>
      </article>

      <section className="video-detail-main">
        <section className="video-detail-primary">
          <article className="grid-card detail-section-card">
            <div className="panel-header">
              <p className="section-kicker">Summary Result</p>
              <h2>摘要结果</h2>
              <p>当前视频的最新摘要、关键要点、时间轴和全文转写。</p>
            </div>
            {video.latest_result ? (
              <div className="detail-result-stack">
                <section className="grid-card result-card">
                  <div className="card-header"><h3>摘要概览</h3></div>
                  <div className="timeline"><p>{video.latest_result.overview}</p></div>
                </section>
                <section className="grid-card result-card">
                  <div className="card-header"><h3>关键要点</h3><span className="result-count">{video.latest_result.key_points.length} 条</span></div>
                  <ul className="bullet-list">{video.latest_result.key_points.map((item) => <li key={item}>{item}</li>)}</ul>
                </section>
                <section className="grid-card result-card">
                  <div className="card-header"><h3>时间轴</h3></div>
                  <div className="timeline">
                    {video.latest_result.timeline.map((item, index) => (
                      <article className="timeline-item" key={`${item.title}-${index}`}>
                        <div className="timeline-marker">{index + 1}</div>
                        <div className="timeline-content">
                          <h4>{item.title || "章节"}</h4>
                          <div className="timeline-meta"><span className="timeline-time">{formatDuration(item.start ?? 0)}</span></div>
                          <p>{item.summary || ""}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
                <section className="grid-card transcript-card">
                  <div className="card-header"><h3>转写全文</h3></div>
                  <pre className="transcript">{video.latest_result.transcript_text}</pre>
                </section>
              </div>
            ) : <div className="empty-placeholder">当前还没有可展示的摘要结果。</div>}
          </article>
        </section>

        <aside className="video-detail-sidebar">
          <article className="grid-card detail-side-card">
            <div className="panel-header">
              <p className="section-kicker">Progress</p>
              <h2>处理进度</h2>
              <p>{selectedTask ? `当前任务 ${selectedTask.task_id.slice(0, 8)}` : "尚未开始处理"}</p>
            </div>
            {selectedTask ? (
              <div className="task-progress-simple">
                <div className="progress-bar-wrapper">
                  <div className="progress-bar-simple">
                    <div
                      className={`progress-fill-simple ${progress.hasError ? "error" : progress.isCompleted ? "success" : ""}`}
                      style={{ width: `${progress.progress}%` }}
                    />
                  </div>
                  <div className="progress-info-simple">
                    <span className="progress-percent-simple">{Math.round(progress.progress)}%</span>
                    <span className="progress-status-simple">{progress.currentEvent?.message ?? "等待开始..."}</span>
                  </div>
                </div>
                <details className="progress-stage-card">
                  <summary>
                    <div>
                      <strong>{stageLabel(progress.currentEvent?.stage) || "阶段详情"}</strong>
                      <span>{progress.filtered.length} 条进度记录</span>
                    </div>
                    <span className="progress-stage-toggle">展开详细</span>
                  </summary>
                  <div className="progress-stage-list">
                    {progress.filtered.map((event) => (
                      <article className={`progress-event-card ${progressEventClass(event.stage)}`} key={event.event_id}>
                        <div className="progress-event-index">{stageLabel(event.stage)}</div>
                        <div className="progress-event-copy">
                          <div className="progress-event-topline">
                            <strong>{event.message}</strong>
                            <span>{formatDateTime(event.created_at)}</span>
                          </div>
                          <div className="progress-event-meta">阶段进度 {event.progress}%</div>
                        </div>
                      </article>
                    ))}
                  </div>
                </details>
              </div>
            ) : <div className="empty-placeholder">点击“开始总结”后，这里会展示处理进度。</div>}
          </article>

          <article className="grid-card detail-side-card">
            <div className="panel-header">
              <p className="section-kicker">History</p>
              <h2>任务历史</h2>
              <p>{tasks.length} 条任务记录</p>
            </div>
            <div className="task-history-list">
              {tasks.length ? tasks.map((task) => (
                <details className={`task-history-item ${task.task_id === selectedTask?.task_id ? "active" : ""}`} key={task.task_id} open={task.task_id === selectedTask?.task_id}>
                  <summary
                    className="task-history-summary"
                    onClick={async (event) => {
                      event.preventDefault();
                      const [detail, taskEvents] = await Promise.all([api.getTaskResult(task.task_id), api.getTaskEvents(task.task_id)]);
                      setSelectedTask(detail);
                      setEvents(taskEvents);
                    }}
                  >
                    <div className="task-history-main">
                      <span className={`task-history-status ${taskStatusClass(task.status)}`}>{taskStatusLabel(task.status)}</span>
                      <span className="task-history-time">{formatDateTime(task.created_at)}</span>
                    </div>
                    <div className="task-history-meta"><span className="task-history-id">{task.task_id.slice(0, 8)}</span></div>
                  </summary>
                  <div className="task-history-details">
                    <div className="task-history-info">
                      <div className="info-row"><span className="info-label">LLM Token</span><span className="info-value">{formatTokenCount(task.llm_total_tokens)}</span></div>
                      <div className="info-row"><span className="info-label">任务耗时</span><span className="info-value">{formatTaskDuration(task.task_duration_seconds)}</span></div>
                    </div>
                    <div className="task-history-actions">
                      <button
                        className="tertiary-button danger"
                        type="button"
                        onClick={async () => {
                          await api.deleteTask(task.task_id);
                          await refreshDetail(selectedTask?.task_id);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </details>
              )) : <div className="empty-placeholder">暂无历史任务</div>}
            </div>
          </article>
        </aside>
      </section>
    </section>
  );
}

function SettingsPage({ snapshot, desktop, onRefresh }: { snapshot: Snapshot; desktop: DesktopState; onRefresh(): void }) {
  const [form, setForm] = useState<ServiceSettings | null>(snapshot.settings);
  const [saveStatus, setSaveStatus] = useState("");
  const [cudaStatus, setCudaStatus] = useState("");
  const [cudaOutput, setCudaOutput] = useState("");
  const [logOutput, setLogOutput] = useState("");
  const [logPath, setLogPath] = useState(snapshot.systemInfo?.service?.log_file || desktop.logPath || "");
  const [serviceStatus, setServiceStatus] = useState("");
  const [updateStatus, setUpdateStatus] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  useEffect(() => {
    setForm(snapshot.settings);
  }, [snapshot.settings]);

  useEffect(() => {
    setLogPath(snapshot.systemInfo?.service?.log_file || desktop.logPath || "");
  }, [desktop.logPath, snapshot.systemInfo?.service?.log_file]);

  useEffect(() => {
    void refreshLogs();
  }, []);

  async function refreshLogs() {
    try {
      const response = await api.getSystemLogs();
      setLogOutput(response.content || "日志文件存在，但当前还没有内容。");
      setLogPath(response.path || snapshot.systemInfo?.service?.log_file || desktop.logPath || "");
    } catch (error) {
      try {
        const fallback = await window.desktop?.logs.readServiceLogTail(200);
        if (fallback) {
          setLogOutput(fallback.content || "本地日志文件存在，但当前还没有内容。");
          setLogPath(fallback.path || snapshot.systemInfo?.service?.log_file || desktop.logPath || "");
          setServiceStatus("服务接口不可用，已切换为本地日志读取。");
          return;
        }
      } catch {
        // Ignore local fallback errors and surface the original request error below.
      }
      setLogOutput(error instanceof Error ? error.message : "读取日志失败");
    }
  }

  const backendRunning = Boolean(desktop.backend?.running);
  const backendReady = Boolean(desktop.backend?.ready);
  const serviceOnline = snapshot.serviceOnline;
  const effectiveLogPath = logPath || snapshot.systemInfo?.service?.log_file || desktop.logPath || "-";

  if (!form) return <section className="grid-card empty-state-card">正在加载设置...</section>;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    try {
      await api.updateSettings(form);
      setSaveStatus("设置已保存");
      onRefresh();
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "保存设置失败");
    }
  }

  return (
    <section className="settings-grid">
      <article className="grid-card settings-wide env-card">
        <div className="panel-header">
          <p className="section-kicker">Environment</p>
          <h2>运行环境与 CUDA</h2>
          <p>环境检测、推荐设备和 CUDA 配置保持在统一的浅色卡片体系中。</p>
        </div>
        <section className="env-panel">
          <div className="env-panel-head">
            <span className="env-panel-kicker">Environment Snapshot</span>
            <p>当前硬件、依赖版本和运行时建议一览。</p>
          </div>
          <div className="env-summary-grid">
            <Metric label="推荐设备" value={snapshot.environment?.recommendedDevice || "-"} tone="accent" />
            <Metric label="推荐模型" value={snapshot.environment?.recommendedModel || "-"} />
            <Metric label="GPU 状态" value={snapshot.environment?.cudaAvailable ? "已启用" : "未启用"} tone={snapshot.environment?.cudaAvailable ? "success" : "default"} />
            <Metric label="运行时通道" value={snapshot.environment?.runtimeChannel || form.runtime_channel || "base"} tone="info" />
          </div>
        </section>

        <section className="cuda-control-panel">
          <div className="cuda-control-copy">
            <span className="env-panel-kicker">CUDA Control</span>
            <h3>CUDA 目标版本</h3>
            <p>选择目标运行时后，可重新检测环境或安装对应 CUDA 支持。</p>
          </div>
          <div className="cuda-actions">
            <label className="input-row cuda-picker">
              <span className="input-label">CUDA 目标版本</span>
              <select className="select-field" value={form.cuda_variant} onChange={(event) => setForm({ ...form, cuda_variant: event.target.value })}>
                <option value="cu128">CUDA 12.8</option>
                <option value="cu126">CUDA 12.6</option>
                <option value="cu124">CUDA 12.4</option>
              </select>
            </label>
            <div className="settings-actions cuda-button-row">
              <button className="secondary-button" type="button" onClick={() => onRefresh()}>重新检测</button>
              <button
                className="primary-button"
                type="button"
                onClick={async () => {
                  try {
                    const result = await api.installCuda({ cuda_variant: form.cuda_variant });
                    setCudaStatus(result.message || "CUDA 安装命令已执行");
                    setCudaOutput(result.output || "");
                    onRefresh();
                  } catch (error) {
                    setCudaStatus(error instanceof Error ? error.message : "CUDA 安装失败");
                  }
                }}
              >
                安装 CUDA 支持
              </button>
            </div>
          </div>
          {cudaStatus ? <div className="action-status">{cudaStatus}</div> : null}
          {cudaOutput ? (
            <label className="input-row">
              <span className="input-label">CUDA 安装输出</span>
              <textarea className="textarea-field log-viewer" rows={8} readOnly value={cudaOutput}></textarea>
            </label>
          ) : null}
        </section>
      </article>

      <article className="grid-card settings-form-card">
        <div className="panel-header">
          <p className="section-kicker">Configuration</p>
          <h2>运行配置</h2>
          <p>编辑并保存后端配置，保持字段分组清晰、对齐统一。</p>
        </div>
        <form className="setting-form settings-sections" onSubmit={save}>
          <section className="settings-subsection">
            <h3>基础运行</h3>
            <Field label="监听地址" value={form.host} onChange={(value) => setForm({ ...form, host: value })} />
            <Field label="监听端口" value={String(form.port)} type="number" onChange={(value) => setForm({ ...form, port: Number(value) })} />
            <Field label="数据目录" value={form.data_dir} onChange={(value) => setForm({ ...form, data_dir: value })} />
            <Field label="缓存目录" value={form.cache_dir} onChange={(value) => setForm({ ...form, cache_dir: value })} />
            <Field label="任务目录" value={form.tasks_dir} onChange={(value) => setForm({ ...form, tasks_dir: value })} />
          </section>

          <section className="settings-subsection">
            <h3>模型与摘要</h3>
            <Field label="推理设备" value={form.device_preference} onChange={(value) => setForm({ ...form, device_preference: value })} />
            <Field label="固定模型" value={form.fixed_model} onChange={(value) => setForm({ ...form, fixed_model: value })} />
            <Field label="LLM Base URL" value={form.llm_base_url} onChange={(value) => setForm({ ...form, llm_base_url: value })} />
            <Field label="LLM 模型" value={form.llm_model} onChange={(value) => setForm({ ...form, llm_model: value })} />
            <Field label="LLM API Key" value={form.llm_api_key} type="password" onChange={(value) => setForm({ ...form, llm_api_key: value })} />
          </section>

          <section className="settings-subsection settings-actions-section">
            <div className="settings-actions">
              <button className="primary-button" type="submit">保存设置</button>
              {saveStatus ? <div className="action-status">{saveStatus}</div> : null}
            </div>
          </section>
        </form>
      </article>

      <article className="grid-card">
        <div className="panel-header">
          <p className="section-kicker">Service Info</p>
          <h2>服务信息</h2>
          <p>系统运行详情与日志路径。</p>
        </div>
        <div className="setting-list">
          <div className="setting-row"><span className="setting-label">服务名</span><span className="setting-value">{snapshot.systemInfo?.application?.name || "-"}</span></div>
          <div className="setting-row"><span className="setting-label">版本</span><span className="setting-value">{snapshot.systemInfo?.application?.version || "-"}</span></div>
          <div className="setting-row"><span className="setting-label">服务状态</span><span className="setting-value">{snapshot.serviceOnline ? "在线" : "离线"}</span></div>
          <div className="setting-row"><span className="setting-label">日志文件</span><span className="setting-value">{snapshot.systemInfo?.service?.log_file || desktop.logPath || "-"}</span></div>
        </div>
      </article>

      <article className="grid-card settings-wide">
        <div className="panel-header">
          <p className="section-kicker">Logs & Control</p>
          <h2>日志与控制</h2>
          <p>查看后端日志，并直接控制当前内置后端。</p>
        </div>
        <div className="control-status-row">
          <span className={`helper-chip ${serviceOnline ? "status-success" : "status-failed"}`}>{serviceOnline ? "服务在线" : "服务离线"}</span>
          <span className={`helper-chip ${backendRunning ? (backendReady ? "status-success" : "status-running") : "status-pending"}`}>
            {backendRunning ? (backendReady ? "内置后端运行中" : "内置后端启动中") : "内置后端未运行"}
          </span>
          {desktop.backend?.pid ? <span className="helper-chip">PID {desktop.backend.pid}</span> : null}
        </div>
        <div className="desktop-actions">
          <button className="secondary-button" type="button" onClick={() => void refreshLogs()}>刷新日志</button>
          <button
            className={backendRunning ? "secondary-button danger-button" : "primary-button"}
            type="button"
            onClick={async () => {
              if (backendRunning) {
                await window.desktop?.backend.stop();
                setServiceStatus("内置后端已停止");
              } else {
                await window.desktop?.backend.start();
                setServiceStatus("已请求启动内置后端");
              }
              onRefresh();
              await refreshLogs();
            }}
          >
            {backendRunning ? "停止内置后端" : "启动内置后端"}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={async () => {
              await window.desktop?.shell.openPath(effectiveLogPath);
            }}
          >
            打开日志文件
          </button>
          <button
            className="secondary-button danger-button"
            type="button"
            disabled={!serviceOnline}
            onClick={async () => {
              await api.shutdownService();
              setServiceStatus("已向服务发送关闭请求");
              onRefresh();
              await refreshLogs();
            }}
          >
            强制关闭服务
          </button>
        </div>
        {desktop.backend?.lastError ? <div className="action-status">{desktop.backend.lastError}</div> : null}
        {serviceStatus ? <div className="action-status">{serviceStatus}</div> : null}
        <label className="input-row">
          <span className="input-label">当前日志文件</span>
          <input className="input-field" value={effectiveLogPath} readOnly />
        </label>
        <label className="input-row">
          <span className="input-label">最近日志</span>
          <textarea className="textarea-field log-viewer" rows={16} readOnly value={logOutput}></textarea>
        </label>
      </article>

      <article className="grid-card settings-wide">
        <div className="panel-header">
          <p className="section-kicker">About & Updates</p>
          <h2>关于与更新</h2>
          <p>检查新版本并查看更新日志。</p>
        </div>
        <div className="setting-list">
          <div className="setting-row">
            <span className="setting-label">当前版本</span>
            <span className="setting-value">
              <code>v{desktop.version}</code>
            </span>
          </div>
          <div className="setting-row">
            <span className="setting-label">更新状态</span>
            <span className="setting-value">{updateStatus || "未检查"}</span>
          </div>
        </div>
        <div className="desktop-actions">
          <button
            className="primary-button"
            type="button"
            disabled={checkingUpdate}
            onClick={async () => {
              setCheckingUpdate(true);
              setUpdateStatus("正在检查更新...");
              try {
                const result = await window.desktop?.update?.check();
                if (result) {
                  if (result.status === "available") {
                    setUpdateStatus(`发现新版本：v${result.version}`);
                  } else if (result.status === "not-available") {
                    setUpdateStatus("已是最新版本");
                  } else if (result.status === "error") {
                    setUpdateStatus(`检查失败：${result.errorMessage}`);
                  } else {
                    setUpdateStatus(`状态：${result.status}`);
                  }
                }
              } catch (error) {
                setUpdateStatus(error instanceof Error ? error.message : "检查更新失败");
              } finally {
                setCheckingUpdate(false);
              }
            }}
          >
            {checkingUpdate ? "检查中..." : "检查更新"}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setUpdateStatus("");
            }}
          >
            清除状态
          </button>
        </div>
        {updateStatus ? <div className="action-status">{updateStatus}</div> : null}
      </article>
    </section>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange(value: string): void; type?: string }) {
  return (
    <label className="input-row">
      <span className="input-label">{label}</span>
      <input className="input-field" type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function formatShortDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function platformLabel(platform?: string | null) {
  const labels: Record<string, string> = {
    bilibili: "Bilibili",
    youtube: "YouTube",
    local: "Local",
  };
  return (platform && labels[platform.toLowerCase()]) || "Video";
}

function stageLabel(stage?: string | null) {
  const labels: Record<string, string> = {
    queued: "排队中",
    downloading: "下载中",
    transcribing: "转写中",
    summarizing: "总结中",
    completed: "已完成",
    failed: "失败",
  };
  return (stage && labels[stage]) || "待开始";
}

function taskStatusClass(status?: TaskStatus | null) {
  if (status === "completed") return "status-success";
  if (status === "running") return "status-running";
  if (status === "failed") return "status-failed";
  return "status-pending";
}

function progressEventClass(stage?: string | null) {
  if (stage === "completed") return "completed";
  if (stage === "failed") return "error";
  if (stage === "summarizing" || stage === "transcribing" || stage === "downloading") return "active";
  return "";
}

function LibraryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z" />
      <path d="M7.5 9h9" />
      <path d="M7.5 13h6" />
      <path d="M7.5 16h4" />
    </svg>
  );
}

function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 8.25A3.75 3.75 0 1 0 12 15.75A3.75 3.75 0 1 0 12 8.25Z" />
      <path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 0 1-4 0v-.1a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1A1 1 0 0 0 6 15.3a1 1 0 0 0-.9-.6H5a2 2 0 0 1 0-4h.1a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V4a2 2 0 0 1 4 0v.1a1 1 0 0 0 .6.9h.1a1 1 0 0 0 1.1-.2l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6h.1a2 2 0 0 1 0 4h-.1a1 1 0 0 0-.9.6V15Z" />
    </svg>
  );
}

function HomeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 10.5L12 3l9 7.5V20a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 20V10.5Z" />
      <path d="M9 21.5V12.5h6v9" />
    </svg>
  );
}

function LinkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10 13.5L14 9.5" />
      <path d="M8.25 16.25L6.5 18a3 3 0 1 1-4.24-4.24L4 12" />
      <path d="M15.75 7.75L17.5 6a3 3 0 1 1 4.24 4.24L20 12" />
      <path d="M8 12L6.75 13.25a3.5 3.5 0 0 0 4.95 4.95L13 17" />
      <path d="M16 12L17.25 10.75a3.5 3.5 0 0 0-4.95-4.95L11 7" />
    </svg>
  );
}

function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16L20 20" />
    </svg>
  );
}
