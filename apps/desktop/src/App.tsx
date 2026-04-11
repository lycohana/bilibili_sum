import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { deriveRuntimeDeviceLabel, emptySnapshot, getUpdateDialogSignal, isUpdateUnsupported, toUpdateState, type DesktopState, type LibraryFilter, type Snapshot, type UpdateState } from "./appModel";
import { api } from "./api";
import { HomeIcon, LibraryIcon, SettingsIcon } from "./components/AppIcons";
import { SidebarStatusItem } from "./components/AppPrimitives";
import { TitleBar } from "./components/TitleBar";
import { UpdateDialog, type UpdateInfo } from "./components/UpdateDialog";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { VideoDetailPage } from "./pages/VideoDetailPage";
import type { VideoAssetSummary } from "./types";

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

  async function handleCheckForUpdates() {
    if (!window.desktop?.update) {
      throw new Error("当前环境不支持桌面自动更新。");
    }
    const result = await window.desktop.update.check();
    setUpdateState(toUpdateState(result));
    return result;
  }

  async function handleDownloadUpdate() {
    if (!window.desktop?.update) {
      throw new Error("当前环境不支持桌面自动更新。");
    }
    const result = await window.desktop.update.download();
    setUpdateState(toUpdateState(result));
    return result;
  }

  async function handleInstallUpdate() {
    if (!window.desktop?.update) {
      throw new Error("当前环境不支持桌面自动更新。");
    }
    await window.desktop.update.install();
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

  const recentVideos = useMemo(() => {
    return [...snapshot.videos]
      .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
      .slice(0, 6);
  }, [snapshot.videos]);

  const runtimeDeviceLabel = useMemo(() => {
    return deriveRuntimeDeviceLabel({
      whisperDevice: snapshot.settings?.whisper_device,
      cudaAvailable: snapshot.environment?.cudaAvailable,
      hasSettings: Boolean(snapshot.settings),
    });
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
    ? { eyebrow: "设置中心", title: "运行配置、环境检测与日志", description: "围绕本地推理环境、模型配置与桌面端服务控制，统一管理 BriefVid 的运行能力。" }
    : location.pathname.startsWith("/library")
      ? { eyebrow: "视频库", title: "视频资产与摘要结果", description: "集中管理已抓取的视频、摘要结果与当前处理状态。" }
      : location.pathname.startsWith("/videos/")
        ? { eyebrow: "视频详情", title: "本地摘要结果与任务记录", description: "围绕单个视频集中查看摘要、时间轴、转写全文与任务处理进度。" }
        : { eyebrow: "BriefVid Workspace", title: "懒得看视频？一键省流！", description: "把时间留给真正有质量的视频" };

  const isSettingsRoute = location.pathname.startsWith("/settings");
  const isLibraryRoute = location.pathname.startsWith("/library");
  const updateSupported = Boolean(window.desktop?.update) && !isUpdateUnsupported(updateState);

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
                    probePreview={probePreview}
                    probeUrl={probeUrl}
                    setProbeUrl={setProbeUrl}
                    submitStatus={submitStatus}
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
                    onCheckUpdate={handleCheckForUpdates}
                    onDownloadUpdate={handleDownloadUpdate}
                    onInstallUpdate={handleInstallUpdate}
                    onRefresh={() => setRefreshSeed((value) => value + 1)}
                    snapshot={snapshot}
                    updateInfo={updateState}
                    updateSupported={updateSupported}
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
        onCheck={handleCheckForUpdates}
        onDownload={handleDownloadUpdate}
        onInstall={handleInstallUpdate}
      />
    </div>
  );
}
