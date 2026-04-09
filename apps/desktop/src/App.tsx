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
  status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "installing" | "error";
  version: string;
  releaseDate: string;
  releaseNotes: string | null;
  downloadProgress: number;
  errorMessage: string | null;
};

type LibraryFilter = "all" | "completed" | "running" | "with-result";
type MetricTone = "default" | "accent" | "success" | "info";
type DevicePreference = "auto" | "cpu" | "cuda";
type SelectOption = { value: string; label: string };

const emptySnapshot: Snapshot = { serviceOnline: false, systemInfo: null, environment: null, settings: null, videos: [], error: "" };
const devicePreferenceOptions: SelectOption[] = [
  { value: "auto", label: "自动选择" },
  { value: "cuda", label: "GPU (CUDA)" },
  { value: "cpu", label: "CPU" },
];

function normalizeDevicePreference(value?: string | null): DevicePreference {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "gpu") {
    return "cuda";
  }
  if (normalized === "auto" || normalized === "cuda" || normalized === "cpu") {
    return normalized;
  }
  return "cpu";
}

function devicePreferenceLabel(value?: string | null): string {
  const normalized = normalizeDevicePreference(value);
  if (normalized === "cuda") {
    return "GPU (CUDA)";
  }
  if (normalized === "auto") {
    return "自动选择";
  }
  return "CPU";
}

function toUpdateState(info: UpdateInfo): UpdateState {
  return {
    status: info.status,
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: info.releaseNotes,
    downloadProgress: info.downloadProgress,
    errorMessage: info.errorMessage,
  };
}

function getUpdateDialogSignal(update: Pick<UpdateState, "status" | "version">): string | null {
  if (update.status !== "available" && update.status !== "downloaded") {
    return null;
  }
  return `${update.status}:${update.version || "unknown"}`;
}

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
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const savedTheme = localStorage.getItem("theme");
    if (savedTheme === "dark") {
      return true;
    }
    if (savedTheme === "light") {
      return false;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

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
  const dismissedUpdateDialogSignalRef = useRef<string | null>(null);
  const lastAutoOpenedUpdateDialogSignalRef = useRef<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
    localStorage.setItem("theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    let backendCleanup: (() => void) | undefined;
    let updateCleanup: (() => void) | undefined;
    let disposed = false;
    async function bootstrap() {
      if (!window.desktop) return;
      const [version, backend, logPath, currentUpdateStatus] = await Promise.all([
        window.desktop.app.getVersion(),
        window.desktop.backend.status(),
        window.desktop.logs.getServiceLogPath(),
        window.desktop.update?.getStatus?.() ?? Promise.resolve(null),
      ]);
      if (disposed) return;
      setDesktop({ version, backend, logPath });
      if (currentUpdateStatus) {
        setUpdateState(toUpdateState(currentUpdateStatus));
      }
      backendCleanup = window.desktop.backend.onStatus((status) => setDesktop((current) => ({ ...current, backend: status })));
      
      // 监听更新状态
      updateCleanup = window.desktop.update?.onStatus((status) => {
        setUpdateState(toUpdateState(status));
      });
    }
    void bootstrap();
    return () => {
      disposed = true;
      backendCleanup?.();
      updateCleanup?.();
    };
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

  useEffect(() => {
    const signal = getUpdateDialogSignal(updateState);
    if (!signal) {
      lastAutoOpenedUpdateDialogSignalRef.current = null;
      return;
    }
    if (updateDialogOpen) {
      lastAutoOpenedUpdateDialogSignalRef.current = signal;
      return;
    }
    if (dismissedUpdateDialogSignalRef.current === signal) {
      return;
    }
    if (lastAutoOpenedUpdateDialogSignalRef.current === signal) {
      return;
    }
    lastAutoOpenedUpdateDialogSignalRef.current = signal;
    setUpdateDialogOpen(true);
  }, [updateDialogOpen, updateState.status, updateState.version]);

  function openUpdateDialog() {
    const signal = getUpdateDialogSignal(updateState);
    if (signal) {
      dismissedUpdateDialogSignalRef.current = null;
      lastAutoOpenedUpdateDialogSignalRef.current = signal;
    }
    setUpdateDialogOpen(true);
  }

  function closeUpdateDialog() {
    dismissedUpdateDialogSignalRef.current = getUpdateDialogSignal(updateState);
    setUpdateDialogOpen(false);
  }

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
    const effectiveDevice = normalizeDevicePreference(snapshot.settings?.whisper_device);

    if (effectiveDevice === "cuda") {
      return "GPU";
    }
    if (!snapshot.settings && snapshot.environment?.cudaAvailable) {
      return "GPU";
    }
    return "CPU";
  }, [snapshot.environment?.cudaAvailable, snapshot.settings]);

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
    : location.pathname.startsWith("/library")
      ? {
        eyebrow: "视频库",
        title: "视频资产与摘要结果",
        description: "集中管理已抓取的视频、摘要结果与当前处理状态。",
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
  const isSettingsRoute = location.pathname.startsWith("/settings");
  const isLibraryRoute = location.pathname.startsWith("/library");

  return (
    <div className="app-shell">
      <TitleBar darkMode={darkMode} onToggleTheme={() => setDarkMode((current) => !current)} />
      <aside className="sidebar">
        <nav className="nav">
          <Link className={`nav-item ${location.pathname === "/" ? "active" : ""}`} to="/">
            <span className="nav-icon" aria-hidden="true"><HomeIcon /></span>
            <span className="nav-copy">
              <strong>首页</strong>
              <small>工作台总览</small>
            </span>
          </Link>
          <Link className={`nav-item ${location.pathname === "/library" ? "active" : ""}`} to="/library">
            <span className="nav-icon" aria-hidden="true"><LibraryIcon /></span>
            <span className="nav-copy">
              <strong>视频库</strong>
              <small>资产管理</small>
            </span>
          </Link>
          <Link className={`nav-item ${location.pathname.startsWith("/settings") ? "active" : ""}`} to="/settings">
            <span className="nav-icon" aria-hidden="true"><SettingsIcon /></span>
            <span className="nav-copy">
              <strong>设置</strong>
              <small>运行配置</small>
            </span>
          </Link>
        </nav>

        <div className="nav-section-divider"></div>

        <section className="live-panel">
          <div className="panel-header panel-header-subtle">
            <h2>运行状态</h2>
          </div>
          <div className="status-stack">
            <SidebarStatusItem
              label="服务"
              tone={snapshot.serviceOnline ? "success" : "default"}
              value={snapshot.serviceOnline ? "在线" : desktop.backend?.running ? "启动中" : "离线"}
            />
            <SidebarStatusItem label="设备" value={runtimeDeviceLabel} />
            <SidebarStatusItem label="版本" value={desktop.version} />
          </div>
        </section>

      </aside>

      <main className="content">
        <div className={`content-frame ${isSettingsRoute ? "content-frame-settings" : ""}`}>
          {!isLibraryRoute ? (
            <header className="page-header">
              <div className="page-header-content">
                <p className="eyebrow">{pageMeta.eyebrow}</p>
                <h2>{pageMeta.title}</h2>
                <p className="page-description">{pageMeta.description}</p>
              </div>
            </header>
          ) : null}

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
              <Route
                path="/settings"
                element={(
                  <SettingsPage
                    desktop={desktop}
                    onOpenUpdateDialog={openUpdateDialog}
                    onRefresh={() => setRefreshSeed((value) => value + 1)}
                    snapshot={snapshot}
                    updateInfo={updateState}
                  />
                )}
              />
            </Routes>
          )}
        </div>
      </main>
      
      <UpdateDialog
        isOpen={updateDialogOpen}
        updateInfo={updateState as UpdateInfo}
        currentVersion={desktop.version}
        onClose={closeUpdateDialog}
        onCheck={async () => {
          if (window.desktop?.update) {
            const result = await window.desktop.update.check();
            setUpdateState(toUpdateState(result));
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
      {/* 欢迎区域 - 简洁布局 */}
      <div className="section">
        <h2 className="section-title">开始总结</h2>
        <form className="task-form" onSubmit={onProbe}>
          <div className="task-form-row">
            <label className="input-row input-row-hero" style={{ flex: 1 }}>
              <div className="input-with-icon" style={{ flex: 1 }}>
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
          {submitStatus && <div className="submit-status">{submitStatus}</div>}
        </form>

        {probePreview && (
          <article className="probe-preview">
            <img src={probePreview.cover_url} alt={probePreview.title} />
            <div className="probe-preview-copy">
              <span className="section-kicker">即将加入视频库</span>
              <strong>{probePreview.title}</strong>
              <small>{formatDuration(probePreview.duration)} · {platformLabel(probePreview.platform)}</small>
            </div>
          </article>
        )}
      </div>

      {/* 最近视频 */}
      <div className="section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h2 className="section-title" style={{ margin: 0 }}>最近视频</h2>
          <span className="helper-chip">{recentVideos.length} 个视频</span>
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
      </div>
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
  const activeFilterLabel = filters.find((filter) => filter.id === activeFilter)?.label || "全部";
  const summaryText = latestVideo
    ? `最近更新：${latestVideo.title}`
    : "输入链接后，视频会自动进入这里统一管理。";

  return (
    <section className="library-page">
      <section className="library-hero">
        <div className="library-hero-copy">
          <span className="library-kicker">Library</span>
          <h2>视频资产与摘要结果</h2>
          <p>{summaryText}</p>
        </div>
        <div className="library-hero-status">
          <span className={`helper-chip ${serviceOnline ? "status-success" : "status-pending"}`}>
            {serviceOnline ? "服务在线" : "服务离线"}
          </span>
          <span className="helper-chip">{runtimeDeviceLabel}</span>
          <span className="helper-chip">筛选：{activeFilterLabel}</span>
        </div>
      </section>

      <section className="library-summary-panel">
        <div className="library-summary-grid">
          <Metric label="视频总数" value={String(libraryCounts.total)} detail="本地已收录资产" tone="accent" />
          <Metric label="已完成" value={String(libraryCounts.completed)} detail="可查看完整摘要" tone="success" />
          <Metric label="处理中" value={String(libraryCounts.running)} detail="正在进行转写或总结" tone="info" />
          <Metric label="有结果" value={String(libraryCounts.withResult)} detail="摘要结果已沉淀" />
        </div>
      </section>

      <section className="library-collection">
        <div className="library-toolbar">
          <div className="library-toolbar-copy">
            <h3>视频库</h3>
            <p>{filteredVideos.length} / {snapshot.videos.length} 个视频资产</p>
          </div>
          <label className="search-field library-search-field">
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

        <div className="filter-pill-row library-filter-row">
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

        {filteredVideos.length ? (
          <div className="video-grid">
            {filteredVideos.map((video) => <VideoCard key={video.video_id} video={video} />)}
          </div>
        ) : (
          <div className="library-empty-state">
            <div className="library-empty-visual" aria-hidden="true">
              <SearchIcon width={34} height={34} />
            </div>
            <div className="library-empty-copy">
              <h4>当前筛选条件下还没有视频</h4>
              <p>可以调整筛选条件，或者回到首页输入一个视频链接开始生成摘要。</p>
            </div>
          </div>
        )}
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
        <div className="video-card-meta">
          <span>{formatDateTime(video.updated_at)}</span>
          <span>{video.latest_result ? "摘要已生成" : "等待结果"}</span>
        </div>
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
              <div className="detail-result-sections">
                <section className="result-section">
                  <h3 className="result-section-title">摘要概览</h3>
                  <p className="result-section-content">{video.latest_result.overview}</p>
                </section>
                <section className="result-section">
                  <h3 className="result-section-title">关键要点 <span className="result-count">{video.latest_result.key_points.length} 条</span></h3>
                  <ul className="key-points-list">
                    {video.latest_result.key_points.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </section>
                <section className="result-section">
                  <h3 className="result-section-title">时间轴</h3>
                  <div className="timeline-list">
                    {video.latest_result.timeline.map((item, index) => (
                      <article className="timeline-item-simple" key={`${item.title}-${index}`}>
                        <div className="timeline-time-badge">{formatDuration(item.start ?? 0)}</div>
                        <div className="timeline-content-simple">
                          <h4>{item.title || "章节"}</h4>
                          <p>{item.summary || ""}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
                <section className="result-section transcript-section">
                  <h3 className="result-section-title">转写全文</h3>
                  <pre className="transcript-full">{video.latest_result.transcript_text}</pre>
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
            ) : <div className="empty-placeholder">点击"开始总结"后，这里会展示处理进度。</div>}
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

type SettingsCategory = "overview" | "general" | "directories" | "model" | "llm" | "summary" | "advanced" | "environment" | "logs";
type SettingsCategoryGroup = "workspace" | "system";

const settingsCategories: Array<{
  id: SettingsCategory;
  label: string;
  description: string;
  group: SettingsCategoryGroup;
  icon: JSX.Element;
}> = [
  { id: "overview", label: "概览", description: "集中查看服务状态、运行时与关键配置。", group: "workspace", icon: <OverviewIcon /> },
  { id: "general", label: "基础设置", description: "管理服务监听地址、端口和基本接入信息。", group: "workspace", icon: <SettingsIcon /> },
  { id: "directories", label: "目录设置", description: "统一整理数据、缓存和任务文件的落盘位置。", group: "workspace", icon: <FolderIcon /> },
  { id: "model", label: "模型设置", description: "调整 Whisper 模型、推理设备和模型选择方式。", group: "workspace", icon: <CpuIcon /> },
  { id: "llm", label: "LLM 设置", description: "配置云端大模型摘要能力与 API 接入参数。", group: "workspace", icon: <RobotIcon /> },
  { id: "summary", label: "摘要参数", description: "微调摘要模式、语言和切块策略。", group: "workspace", icon: <FileTextIcon /> },
  { id: "advanced", label: "高级设置", description: "切换 CUDA 变体、运行时通道和缓存行为。", group: "system", icon: <SlidersIcon /> },
  { id: "environment", label: "运行环境", description: "检查 Python、Torch、GPU 与 CUDA 就绪状态。", group: "system", icon: <MonitorIcon /> },
  { id: "logs", label: "日志与控制", description: "查看服务日志并控制内置后端进程。", group: "system", icon: <TerminalIcon /> },
];

// SVG Icons
function OverviewIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CpuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  );
}

function RobotIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
      <line x1="8" y1="16" x2="8" y2="16" />
      <line x1="16" y1="16" x2="16" y2="16" />
    </svg>
  );
}

function FileTextIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function SettingsPage({
  snapshot,
  desktop,
  onRefresh,
  updateInfo,
  onOpenUpdateDialog,
}: {
  snapshot: Snapshot;
  desktop: DesktopState;
  onRefresh(): void;
  updateInfo: UpdateState;
  onOpenUpdateDialog(): void;
}) {
  const [form, setForm] = useState<ServiceSettings | null>(snapshot.settings);
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(snapshot.environment);
  const [saveStatus, setSaveStatus] = useState("");
  const [cudaStatus, setCudaStatus] = useState("");
  const [cudaOutput, setCudaOutput] = useState("");
  const [cudaInstalling, setCudaInstalling] = useState(false);
  const [cudaProgress, setCudaProgress] = useState(0);
  const [cudaStage, setCudaStage] = useState("");
  const [cudaStartedAt, setCudaStartedAt] = useState<number | null>(null);
  const [cudaDetail, setCudaDetail] = useState("");
  const [logOutput, setLogOutput] = useState("");
  const [logPath, setLogPath] = useState(snapshot.systemInfo?.service?.log_file || desktop.logPath || "");
  const [serviceStatus, setServiceStatus] = useState("");
  const [updateStatus, setUpdateStatus] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("overview");

  useEffect(() => {
    setForm(snapshot.settings);
  }, [snapshot.settings]);

  useEffect(() => {
    setEnvironment(snapshot.environment);
  }, [snapshot.environment]);

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
  const targetRuntimeChannel = `gpu-${form?.cuda_variant || "cu128"}`;
  const activeCategoryMeta = settingsCategories.find((category) => category.id === activeCategory) || settingsCategories[0];
  const workspaceCategories = settingsCategories.filter((category) => category.group === "workspace");
  const systemCategories = settingsCategories.filter((category) => category.group === "system");
  const llmReady = Boolean(form?.llm_enabled && form?.llm_api_key_configured);
  const cudaPhasePlan = [
    { threshold: 10, label: "准备 GPU 运行时目录" },
    { threshold: 26, label: "引导 pip 和基础安装能力" },
    { threshold: 48, label: "同步 BriefVid 工作区依赖" },
    { threshold: 78, label: "安装 PyTorch CUDA 依赖" },
    { threshold: 92, label: "刷新环境探测与运行时信息" },
    { threshold: 100, label: "完成安装并切换推荐配置" },
  ];

  useEffect(() => {
    if (!cudaInstalling) {
      return;
    }

    const timer = window.setInterval(() => {
      const elapsedMs = cudaStartedAt ? Date.now() - cudaStartedAt : 0;
      const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
      const expectedProgress = Math.min(94, 8 + Math.floor(elapsedSeconds * 1.6));
      setCudaProgress((current) => {
        const next = Math.max(current, expectedProgress);
        const activePhase = cudaPhasePlan.find((phase) => next <= phase.threshold) || cudaPhasePlan[cudaPhasePlan.length - 1];
        setCudaStage(`${activePhase.label} · 已等待 ${elapsedSeconds} 秒`);
        return next;
      });
    }, 1200);

    return () => window.clearInterval(timer);
  }, [cudaInstalling, cudaStartedAt]);

  if (!form) return <section className="grid-card empty-state-card">正在加载设置...</section>;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    try {
      const response = await api.updateSettings({
        ...form,
        device_preference: normalizeDevicePreference(form.device_preference),
      });
      const nextSettings = response.settings;
      setForm(nextSettings);
      setSaveStatus(response.message || "设置已保存");
      setEnvironment(await api.getEnvironment({ runtimeChannel: nextSettings.runtime_channel, refresh: true }));
      onRefresh();
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "保存设置失败");
    }
  }

  const cudaPhaseItems = cudaPhasePlan.map((phase, index) => {
    const previousThreshold = index === 0 ? 0 : cudaPhasePlan[index - 1].threshold;
    const isComplete = cudaProgress >= phase.threshold;
    const isActive = !isComplete && cudaProgress > previousThreshold;
    return {
      ...phase,
      state: isComplete ? "done" : isActive ? "active" : "pending",
    };
  });

  return (
    <div className="settings-page-wrapper">
      {/* 左侧设置分类导航 */}
      <aside className="settings-nav">
        <div className="settings-nav-header">
          <span className="settings-nav-label-small">BriefVid</span>
          <div className="settings-nav-brand-card">
            <div className="settings-nav-brand-copy">
              <span className="settings-nav-brand-kicker">设置</span>
              <strong>管理应用与运行配置</strong>
              <p>统一调整目录、模型、服务与环境状态，让常用设置保持清晰可读。</p>
            </div>
            <div className="settings-nav-brand-metrics">
              <div className="settings-nav-metric">
                <span>服务</span>
                <strong>{serviceOnline ? "在线" : "离线"}</strong>
              </div>
              <div className="settings-nav-metric">
                <span>设备</span>
                <strong>{devicePreferenceLabel(form.whisper_device)}</strong>
              </div>
            </div>
          </div>
        </div>
        <div className="settings-nav-list">
          <div className="settings-nav-group">
            <span className="settings-nav-group-label">工作区</span>
            <nav className="settings-nav-links">
              {workspaceCategories.map((category) => (
                <button
                  key={category.id}
                  className={`settings-nav-item ${activeCategory === category.id ? "active" : ""}`}
                  type="button"
                  onClick={() => setActiveCategory(category.id)}
                >
                  <span className="settings-nav-icon">{category.icon}</span>
                  <span className="settings-nav-copy">
                    <span className="settings-nav-label">{category.label}</span>
                    <span className="settings-nav-description">{category.description}</span>
                  </span>
                </button>
              ))}
            </nav>
          </div>
          <div className="settings-nav-group">
            <span className="settings-nav-group-label">系统</span>
            <nav className="settings-nav-links">
              {systemCategories.map((category) => (
                <button
                  key={category.id}
                  className={`settings-nav-item ${activeCategory === category.id ? "active" : ""}`}
                  type="button"
                  onClick={() => setActiveCategory(category.id)}
                >
                  <span className="settings-nav-icon">{category.icon}</span>
                  <span className="settings-nav-copy">
                    <span className="settings-nav-label">{category.label}</span>
                    <span className="settings-nav-description">{category.description}</span>
                  </span>
                </button>
              ))}
            </nav>
          </div>
        </div>
        <div className="settings-nav-actions">
          <button className="primary-button settings-save-btn" type="button" onClick={async (e) => { e.preventDefault(); await save(e as FormEvent); }}>
            保存设置
          </button>
          <div className="settings-nav-summary">
            <div className="settings-nav-summary-row">
              <span>运行时</span>
              <strong>{environment?.runtimeChannel || form.runtime_channel || "base"}</strong>
            </div>
            <div className="settings-nav-summary-row">
              <span>LLM</span>
              <strong>{llmReady ? "已配置" : form.llm_enabled ? "待补全" : "关闭"}</strong>
            </div>
          </div>
          {saveStatus && <span className="settings-save-status">{saveStatus}</span>}
        </div>
      </aside>

      {/* 右侧设置内容区域 */}
      <main className="settings-content">
        <div className="settings-content-scroll">
          <header className="settings-page-hero">
            <div className="settings-page-hero-copy">
              <span className="settings-page-kicker">Settings</span>
              <h1>{activeCategoryMeta.label}</h1>
              <p>{activeCategoryMeta.description}</p>
            </div>
            <div className="settings-page-hero-meta">
              <span className={`settings-hero-chip ${serviceOnline ? "is-success" : "is-danger"}`}>
                {serviceOnline ? "服务在线" : "服务离线"}
              </span>
              <span className="settings-hero-chip">
                {environment?.runtimeChannel || form.runtime_channel || "base"}
              </span>
              <span className={`settings-hero-chip ${environment?.cudaAvailable ? "is-success" : ""}`}>
                {environment?.cudaAvailable ? "CUDA Ready" : "CPU Only"}
              </span>
              <span className={`settings-hero-chip ${llmReady ? "is-success" : ""}`}>
                {llmReady ? "LLM 已配置" : form.llm_enabled ? "LLM 待补全" : "LLM 关闭"}
              </span>
            </div>
          </header>

          {/* 概览 */}
          {activeCategory === "overview" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>设置总览</h2>
                <p>集中查看当前配置、运行状态和常用操作。</p>
              </header>

              <div className="settings-story-card">
                <div className="settings-story-copy">
                  <span className="settings-story-kicker">概览</span>
                  <h3>当前配置与运行状态</h3>
                  <p>
                    这里优先展示运行时、模型、摘要模式和服务状态。需要排障时，可以直接切到环境检测或日志与控制。
                  </p>
                </div>
                <div className="settings-story-stats">
                  <div className="settings-story-stat">
                    <span>服务端口</span>
                    <strong>{form.host}:{form.port}</strong>
                  </div>
                  <div className="settings-story-stat">
                    <span>Whisper</span>
                    <strong>{form.fixed_model}</strong>
                  </div>
                  <div className="settings-story-stat">
                    <span>摘要模式</span>
                    <strong>{form.summary_mode === "llm" ? "LLM 智能摘要" : "抽取式摘要"}</strong>
                  </div>
                </div>
              </div>

              {/* 服务状态卡片 */}
              <div className="overview-status-grid">
                <div className="overview-status-card">
                  <div className="overview-status-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 6v6l4 2" />
                    </svg>
                  </div>
                  <div className="overview-status-info">
                    <span className="overview-status-label">服务状态</span>
                    <strong className={`overview-status-value ${serviceOnline ? "text-success" : "text-danger"}`}>
                      {serviceOnline ? "运行中" : "已停止"}
                    </strong>
                  </div>
                </div>
                <div className="overview-status-card">
                  <div className="overview-status-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="2" y="3" width="20" height="14" rx="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                    </svg>
                  </div>
                  <div className="overview-status-info">
                    <span className="overview-status-label">运行时</span>
                    <strong className="overview-status-value">{environment?.runtimeChannel || form.runtime_channel || "base"}</strong>
                  </div>
                </div>
                <div className="overview-status-card">
                  <div className="overview-status-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                    </svg>
                  </div>
                  <div className="overview-status-info">
                    <span className="overview-status-label">推理设备</span>
                    <strong className="overview-status-value">{devicePreferenceLabel(form.whisper_device)}</strong>
                  </div>
                </div>
                <div className="overview-status-card">
                  <div className="overview-status-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20.2 7.8l-7.7 7.7a4 4 0 0 1-5.7 0l-3-3a1 1 0 0 1 1.4-1.4l3 3a2 2 0 0 0 2.8 0l7.7-7.7a1 1 0 0 1 1.4 1.4z" />
                    </svg>
                  </div>
                  <div className="overview-status-info">
                    <span className="overview-status-label">LLM 摘要</span>
                    <strong className={`overview-status-value ${form.llm_enabled ? "text-success" : ""}`}>
                      {form.llm_enabled ? "已启用" : "已关闭"}
                    </strong>
                  </div>
                </div>
              </div>

              {/* 环境信息 */}
              <div className="overview-section">
                <h3 className="overview-section-title">环境信息</h3>
                <div className="overview-info-grid">
                  <div className="overview-info-item">
                    <span className="overview-info-label">Python</span>
                    <span className="overview-info-value">{environment?.pythonVersion || "-"}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">Torch</span>
                    <span className={`overview-info-value ${environment?.torchInstalled ? "text-success" : ""}`}>
                      {environment?.torchInstalled ? environment?.torchVersion || "已安装" : "未安装"}
                    </span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">GPU</span>
                    <span className={`overview-info-value ${environment?.cudaAvailable ? "text-success" : ""}`}>
                      {environment?.cudaAvailable ? environment?.gpuName || "已就绪" : "未检测到"}
                    </span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">yt-dlp</span>
                    <span className="overview-info-value">{environment?.ytDlpVersion || "-"}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">faster-whisper</span>
                    <span className="overview-info-value">{environment?.fasterWhisperVersion || "-"}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">FFmpeg</span>
                    <span className={`overview-info-value ${environment?.ffmpegLocation ? "text-success" : ""}`}>
                      {environment?.ffmpegLocation ? "已安装" : "未安装"}
                    </span>
                  </div>
                </div>
              </div>

              {/* 版本信息 */}
              <div className="overview-section">
                <h3 className="overview-section-title">版本信息</h3>
                <div className="overview-info-grid">
                  <div className="overview-info-item">
                    <span className="overview-info-label">应用版本</span>
                    <span className="overview-info-value">v{desktop.version}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">监听地址</span>
                    <span className="overview-info-value">{form.host}:{form.port}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">语言</span>
                    <span className="overview-info-value">{form.language === "zh" ? "中文" : form.language === "en" ? "English" : "日本語"}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">Whisper 模型</span>
                    <span className="overview-info-value">{form.fixed_model}</span>
                  </div>
                </div>
              </div>

              {/* 快速操作 */}
              <div className="overview-section">
                <h3 className="overview-section-title">快速操作</h3>
                <div className="overview-actions">
                  <button
                    className="tertiary-button"
                    type="button"
                    onClick={() => setActiveCategory("environment")}
                  >
                    环境设置
                  </button>
                  <button
                    className="tertiary-button"
                    type="button"
                    onClick={() => setActiveCategory("logs")}
                  >
                    查看日志
                  </button>
                  <button
                    className="tertiary-button"
                    type="button"
                    onClick={() => setActiveCategory("model")}
                  >
                    模型配置
                  </button>
                  <button
                    className="tertiary-button"
                    type="button"
                    onClick={() => setActiveCategory("llm")}
                  >
                    LLM 设置
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* 基础设置 */}
          {activeCategory === "general" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>基础设置</h2>
                <p>服务监听地址和端口配置</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">监听地址</span>
                  <input className="settings-input-field" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
                  <span className="settings-input-caption">服务绑定的 IP 地址，通常为 127.0.0.1</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">监听端口</span>
                  <input className="settings-input-field" type="number" value={form.port} onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) || 3838 })} />
                  <span className="settings-input-caption">服务端口号，默认 3838</span>
                </label>
              </div>
            </section>
          )}

          {/* 目录设置 */}
          {activeCategory === "directories" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>目录设置</h2>
                <p>数据存储和缓存目录配置</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">数据目录</span>
                  <input className="settings-input-field" value={String(form.data_dir)} onChange={(e) => setForm({ ...form, data_dir: e.target.value })} />
                  <span className="settings-input-caption">存储视频摘要和元数据的目录</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">缓存目录</span>
                  <input className="settings-input-field" value={String(form.cache_dir)} onChange={(e) => setForm({ ...form, cache_dir: e.target.value })} />
                  <span className="settings-input-caption">临时缓存文件存储位置</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">任务目录</span>
                  <input className="settings-input-field" value={String(form.tasks_dir)} onChange={(e) => setForm({ ...form, tasks_dir: e.target.value })} />
                  <span className="settings-input-caption">任务历史记录存储目录</span>
                </label>
              </div>
            </section>
          )}

          {/* 模型设置 */}
          {activeCategory === "model" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>模型设置</h2>
                <p>Whisper 模型和推理设备配置</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">推理设备</span>
                  <select className="settings-select-field" value={normalizeDevicePreference(form.device_preference)} onChange={(e) => setForm({ ...form, device_preference: e.target.value })}>
                    <option value="auto">自动选择</option>
                    <option value="cuda">GPU (CUDA)</option>
                    <option value="cpu">CPU</option>
                  </select>
                  <span className="settings-input-caption">选择模型推理使用的设备，GPU 需要 CUDA 支持</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">模型模式</span>
                  <select className="settings-select-field" value={form.model_mode} onChange={(e) => setForm({ ...form, model_mode: e.target.value })}>
                    <option value="fixed">固定模型</option>
                    <option value="auto">自动选择</option>
                  </select>
                  <span className="settings-input-caption">自动模式会根据设备选择最优模型</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">固定模型</span>
                  <input className="settings-input-field" value={form.fixed_model} onChange={(e) => setForm({ ...form, fixed_model: e.target.value })} placeholder="tiny / base / small / medium / large-v3" />
                  <span className="settings-input-caption">Whisper 模型名称，较小模型速度快但精度低</span>
                </label>
              </div>
            </section>
          )}

          {/* LLM 设置 */}
          {activeCategory === "llm" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>LLM 设置</h2>
                <p>大语言模型摘要配置</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">启用 LLM 摘要</span>
                  <select className="settings-select-field" value={form.llm_enabled ? "true" : "false"} onChange={(e) => setForm({ ...form, llm_enabled: e.target.value === "true" })}>
                    <option value="false">关闭</option>
                    <option value="true">开启</option>
                  </select>
                  <span className="settings-input-caption">使用大语言模型生成更高质量的视频摘要</span>
                </label>
                {form.llm_enabled && (
                  <>
                    <label className="settings-input-group">
                      <span className="settings-input-label">LLM 提供商</span>
                      <select className="settings-select-field" value={form.llm_provider} onChange={(e) => setForm({ ...form, llm_provider: e.target.value })}>
                        <option value="openai-compatible">OpenAI Compatible</option>
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="custom">自定义</option>
                      </select>
                    </label>
                    <label className="settings-input-group">
                      <span className="settings-input-label">API Base URL</span>
                      <input className="settings-input-field" value={form.llm_base_url} onChange={(e) => setForm({ ...form, llm_base_url: e.target.value })} placeholder="https://api.openai.com/v1" />
                      <span className="settings-input-caption">LLM API 的基础 URL 地址</span>
                    </label>
                    <label className="settings-input-group">
                      <span className="settings-input-label">API Key</span>
                      <input className="settings-input-field" type="password" value={form.llm_api_key} onChange={(e) => setForm({ ...form, llm_api_key: e.target.value })} placeholder="sk-..." />
                      <span className="settings-input-caption">LLM 服务的 API 密钥</span>
                    </label>
                    <label className="settings-input-group">
                      <span className="settings-input-label">模型名称</span>
                      <input className="settings-input-field" value={form.llm_model} onChange={(e) => setForm({ ...form, llm_model: e.target.value })} placeholder="gpt-4o-mini / claude-3-haiku" />
                      <span className="settings-input-caption">要使用的 LLM 模型名称</span>
                    </label>
                  </>
                )}
              </div>
            </section>
          )}

          {/* 摘要参数 */}
          {activeCategory === "summary" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>摘要参数</h2>
                <p>摘要生成算法参数配置</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">摘要模式</span>
                  <select className="settings-select-field" value={form.summary_mode} onChange={(e) => setForm({ ...form, summary_mode: e.target.value })}>
                    <option value="llm">LLM 智能摘要</option>
                    <option value="extract">抽取式摘要</option>
                  </select>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">语言</span>
                  <select className="settings-select-field" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                    <option value="ja">日本語</option>
                  </select>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">分块目标字符数</span>
                  <input className="settings-input-field" type="number" value={form.summary_chunk_target_chars} onChange={(e) => setForm({ ...form, summary_chunk_target_chars: parseInt(e.target.value) || 2200 })} />
                  <span className="settings-input-caption">LLM 处理时分块的目标字符数</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">分块重叠段数</span>
                  <input className="settings-input-field" type="number" value={form.summary_chunk_overlap_segments} onChange={(e) => setForm({ ...form, summary_chunk_overlap_segments: parseInt(e.target.value) || 2 })} />
                  <span className="settings-input-caption">分块之间的重叠段数，保证连续性</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">并发数</span>
                  <input className="settings-input-field" type="number" value={form.summary_chunk_concurrency} onChange={(e) => setForm({ ...form, summary_chunk_concurrency: parseInt(e.target.value) || 2 })} />
                  <span className="settings-input-caption">同时处理的分块数量</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">重试次数</span>
                  <input className="settings-input-field" type="number" value={form.summary_chunk_retry_count} onChange={(e) => setForm({ ...form, summary_chunk_retry_count: parseInt(e.target.value) || 2 })} />
                  <span className="settings-input-caption">API 调用失败时的重试次数</span>
                </label>
              </div>
            </section>
          )}

          {/* 高级设置 */}
          {activeCategory === "advanced" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>高级设置</h2>
                <p>CUDA 变体和运行时配置</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">CUDA 变体</span>
                  <select className="settings-select-field" value={form.cuda_variant} onChange={(e) => setForm({ ...form, cuda_variant: e.target.value })}>
                    <option value="cu128">CUDA 12.8</option>
                    <option value="cu126">CUDA 12.6</option>
                    <option value="cu124">CUDA 12.4</option>
                  </select>
                  <span className="settings-input-caption">PyTorch CUDA 版本</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">运行时通道</span>
                  <select className="settings-select-field" value={form.runtime_channel} onChange={(e) => setForm({ ...form, runtime_channel: e.target.value })}>
                    <option value="base">基础版</option>
                    <option value="gpu-cu128">GPU CUDA12.8</option>
                    <option value="gpu-cu126">GPU CUDA12.6</option>
                    <option value="gpu-cu124">GPU CUDA12.4</option>
                  </select>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">保留临时音频</span>
                  <select className="settings-select-field" value={form.preserve_temp_audio ? "true" : "false"} onChange={(e) => setForm({ ...form, preserve_temp_audio: e.target.value === "true" })}>
                    <option value="false">不保留</option>
                    <option value="true">保留</option>
                  </select>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">启用缓存</span>
                  <select className="settings-select-field" value={form.enable_cache ? "true" : "false"} onChange={(e) => setForm({ ...form, enable_cache: e.target.value === "true" })}>
                    <option value="true">开启</option>
                    <option value="false">关闭</option>
                  </select>
                </label>
              </div>
            </section>
          )}

          {/* 运行环境 */}
          {activeCategory === "environment" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>运行环境</h2>
                <p>环境检测信息和 CUDA 配置</p>
              </header>
              <div className="env-summary-grid settings-env-grid">
                <div className="metric-card">
                  <span className="metric-label">推荐设备</span>
                  <strong className="metric-value">{environment?.recommendedDevice || "-"}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">请求设备</span>
                  <strong className="metric-value">{devicePreferenceLabel(form.device_preference)}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">生效设备</span>
                  <strong className={`metric-value ${normalizeDevicePreference(form.whisper_device) === "cuda" ? "text-success" : ""}`}>{devicePreferenceLabel(form.whisper_device)}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">推荐模型</span>
                  <strong className="metric-value">{environment?.recommendedModel || "-"}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">GPU 状态</span>
                  <strong className={`metric-value ${environment?.cudaAvailable ? "text-success" : ""}`}>{environment?.cudaAvailable ? "已启用" : "未启用"}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">GPU 名称</span>
                  <strong className="metric-value">{environment?.gpuName || "未检测到"}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">Torch</span>
                  <strong className={`metric-value ${environment?.torchInstalled ? "text-success" : ""}`}>{environment?.torchInstalled ? environment?.torchVersion || "已安装" : "未安装"}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">Python</span>
                  <strong className="metric-value">{environment?.pythonVersion || "-"}</strong>
                </div>
              </div>
              <div className="settings-cuda-section">
                <h3 className="settings-cuda-title">CUDA 目标版本</h3>
                <div className="cuda-insight-grid">
                  <div className="setting-row">
                    <span className="setting-label">目标运行时</span>
                    <span className="setting-value">{targetRuntimeChannel}</span>
                  </div>
                  <div className="setting-row">
                    <span className="setting-label">当前运行时</span>
                    <span className="setting-value">{environment?.runtimeChannel || form.runtime_channel || "base"}</span>
                  </div>
                  <div className="setting-row">
                    <span className="setting-label">运行时状态</span>
                    <span className="setting-value">{environment?.runtimeReady === false ? "未就绪" : "已就绪"}</span>
                  </div>
                </div>
                <div className="settings-actions cuda-button-row">
                  <label className="input-row cuda-picker">
                    <span className="input-label">CUDA 目标版本</span>
                    <select
                      className="select-field"
                      value={form.cuda_variant}
                      disabled={cudaInstalling}
                      onChange={(event) => setForm({ ...form, cuda_variant: event.target.value })}
                    >
                      <option value="cu128">CUDA 12.8</option>
                      <option value="cu126">CUDA 12.6</option>
                      <option value="cu124">CUDA 12.4</option>
                    </select>
                  </label>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={cudaInstalling}
                    onClick={async () => {
                      try {
                        setCudaStatus("正在重新检测环境...");
                        const nextEnvironment = await api.getEnvironment({ runtimeChannel: form.runtime_channel, refresh: true });
                        setEnvironment(nextEnvironment);
                        setCudaStatus("环境检测完成");
                        onRefresh();
                      } catch (error) {
                        setCudaStatus(error instanceof Error ? error.message : "环境检测失败");
                      }
                    }}
                  >
                    重新检测
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={cudaInstalling}
                    onClick={async () => {
                      try {
                        setCudaInstalling(true);
                        setCudaStartedAt(Date.now());
                        setCudaProgress(8);
                        setCudaStage("准备 GPU 运行时目录");
                        setCudaStatus("CUDA 安装已开始，正在准备运行时...");
                        setCudaOutput("");
                        setCudaDetail(
                          `将为 ${targetRuntimeChannel} 安装 PyTorch CUDA 依赖，并把运行时切换到该通道。`
                        );
                        const result = await api.installCuda({ cuda_variant: form.cuda_variant });
                        const nextRuntimeChannel = result.runtimeChannel || form.runtime_channel;
                        setCudaInstalling(false);
                        setCudaProgress(100);
                        setCudaStage(result.restartRequired ? "CUDA 安装完成，等待重启切换运行时" : "CUDA 安装完成");
                        setCudaStatus(
                          result.restartRequired
                            ? "CUDA 安装完成，请重启应用后切换到新的 GPU 运行时"
                            : "CUDA 安装命令已执行"
                        );
                        setCudaOutput(result.stdoutTail || "");
                        setCudaDetail(
                          `安装目标：${result.cudaVariant || form.cuda_variant}，运行时通道：${nextRuntimeChannel}。`
                        );
                        setForm({ ...form, runtime_channel: nextRuntimeChannel, cuda_variant: result.cudaVariant || form.cuda_variant });
                        setEnvironment(await api.getEnvironment({ runtimeChannel: nextRuntimeChannel, refresh: true }));
                        onRefresh();
                      } catch (error) {
                        setCudaInstalling(false);
                        setCudaStage("CUDA 安装失败");
                        setCudaProgress((current) => (current > 0 ? current : 12));
                        setCudaStatus(error instanceof Error ? error.message : "CUDA 安装失败");
                        setCudaDetail(
                          "安装在运行时依赖准备或 PyTorch CUDA 依赖下载阶段失败。请查看下方输出和服务日志。"
                        );
                      }
                    }}
                  >
                    {cudaInstalling ? "安装中..." : "安装 CUDA 支持"}
                  </button>
                </div>
              </div>
              {(cudaInstalling || cudaProgress > 0 || cudaStatus) ? (
                <div className="cuda-progress-card">
                  <div className="progress-bar-wrapper">
                    <div className="progress-bar-simple">
                      <div
                        className={`progress-fill-simple ${cudaStatus.includes("失败") ? "error" : cudaProgress >= 100 ? "success" : ""}`}
                        style={{ width: `${Math.min(cudaProgress, 100)}%` }}
                      />
                    </div>
                    <div className="progress-info-simple">
                      <span className="progress-percent-simple">{Math.round(Math.min(cudaProgress, 100))}%</span>
                      <span className="progress-status-simple">{cudaStage || "等待开始"}</span>
                    </div>
                  </div>
                  <div className="cuda-stage-list">
                    {cudaPhaseItems.map((phase) => (
                      <div key={phase.label} className={`cuda-stage-item ${phase.state}`}>
                        <span>{phase.label}</span>
                        <strong>
                          {phase.state === "done" ? "已完成" : phase.state === "active" ? "进行中" : "待执行"}
                        </strong>
                      </div>
                    ))}
                  </div>
                  <p className="cuda-helper-text">
                    当前后端仍是同步安装接口，所以阶段进度是基于安装流程的可视化估计；最终结果以下方安装输出和重新检测结果为准。
                  </p>
                </div>
              ) : null}
              {cudaStatus ? <div className="action-status">{cudaStatus}</div> : null}
              {cudaDetail ? <div className="cuda-helper-text">{cudaDetail}</div> : null}
              {cudaOutput ? (
                <label className="input-row">
                  <span className="input-label">CUDA 安装输出</span>
                  <textarea className="textarea-field log-viewer" rows={12} readOnly value={cudaOutput}></textarea>
                </label>
              ) : null}
              {environment?.runtimeError ? (
                <label className="input-row">
                  <span className="input-label">运行时错误详情</span>
                  <textarea className="textarea-field log-viewer" rows={8} readOnly value={environment.runtimeError}></textarea>
                </label>
              ) : null}
              {(cudaStatus.includes("完成") || cudaProgress >= 100) ? (
                <div className="cuda-next-steps">
                  <strong>下一步建议</strong>
                  <span>1. 点击"重新检测"确认当前 GPU runtime 已就绪。</span>
                  <span>2. 确认"运行时通道"已经切到目标 GPU 通道。</span>
                  <span>3. 若提示需要重启，请重启桌面应用后再开始转写任务。</span>
                </div>
              ) : null}
            </section>
          )}

          {/* 日志与控制 */}
          {activeCategory === "logs" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>日志与控制</h2>
                <p>查看后端日志并控制服务</p>
              </header>
              <div className="control-status-row">
                <span className={`helper-chip ${serviceOnline ? "status-success" : "status-failed"}`}>{serviceOnline ? "服务在线" : "服务离线"}</span>
                <span className={`helper-chip ${backendRunning ? (backendReady ? "status-success" : "status-running") : "status-pending"}`}>
                  {backendRunning ? (backendReady ? "内置后端运行中" : "内置后端启动中") : "内置后端未运行"}
                </span>
                {desktop.backend?.pid ? <span className="helper-chip">PID {desktop.backend.pid}</span> : null}
              </div>
              <div className="setting-list">
                <div className="setting-row"><span className="setting-label">服务名</span><span className="setting-value">{snapshot.systemInfo?.application?.name || "-"}</span></div>
                <div className="setting-row"><span className="setting-label">版本</span><span className="setting-value">{snapshot.systemInfo?.application?.version || "-"}</span></div>
                <div className="setting-row"><span className="setting-label">日志文件</span><span className="setting-value">{effectiveLogPath}</span></div>
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
                <span className="input-label">最近日志</span>
                <textarea className="textarea-field log-viewer" rows={20} readOnly value={logOutput}></textarea>
              </label>
            </section>
          )}
        </div>
      </main>
    </div>
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

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange(value: string): void;
}) {
  return (
    <label className="input-row">
      <span className="input-label">{label}</span>
      <select className="select-field" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
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
