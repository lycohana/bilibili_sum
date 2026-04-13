import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { deriveRuntimeDeviceLabel, emptySnapshot, getUpdateDialogSignal, isUpdateUnsupported, toUpdateState, type DesktopState, type LibraryFilter, type Snapshot, type UpdateState } from "./appModel";
import { api } from "./api";
import { HomeIcon, LibraryIcon, SettingsIcon } from "./components/AppIcons";
import { MultiPageSelectDialog } from "./components/MultiPageSelectDialog";
import { TitleBar } from "./components/TitleBar";
import { UpdateDialog, type UpdateInfo } from "./components/UpdateDialog";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { VideoDetailPage } from "./pages/VideoDetailPage";
import type { VideoAssetSummary, VideoPageOption } from "./types";

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
  const [multiPageDialogOpen, setMultiPageDialogOpen] = useState(false);
  const [multiPageProbeVideo, setMultiPageProbeVideo] = useState<VideoAssetSummary | null>(null);
  const [multiPageOptions, setMultiPageOptions] = useState<VideoPageOption[]>([]);
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return localStorage.getItem("sidebar-collapsed") === "true";
  });
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
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
    localStorage.setItem("sidebar-collapsed", sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);

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
      transcriptionProvider: snapshot.settings?.transcription_provider,
      whisperDevice: snapshot.settings?.whisper_device,
      cudaAvailable: snapshot.environment?.cudaAvailable,
      hasSettings: Boolean(snapshot.settings),
    });
  }, [snapshot.environment?.cudaAvailable, snapshot.settings]);

  const runtimeVersionLabel = desktop.version || snapshot.systemInfo?.application?.version || "";

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
      if (response.requires_selection && response.pages.length > 0) {
        setMultiPageProbeVideo(response.video);
        setMultiPageOptions(response.pages);
        setMultiPageDialogOpen(true);
        setSubmitStatus(`检测到 ${response.pages.length} 个分 P，请先选择要解析的内容`);
        return;
      }
      await api.createVideoTask(response.video.video_id);
      setSubmitStatus(response.cached ? "已从视频库读取并开始总结" : "视频已加入本地库并开始总结");
      setProbeUrl("");
      setRefreshSeed((value) => value + 1);
      navigate(`/videos/${response.video.video_id}`);
    } catch (error) {
      setSubmitStatus(error instanceof Error ? error.message : "开始总结失败");
    }
  }

  async function handleConfirmMultiPage(page: VideoPageOption) {
    setSubmitStatus(`已选择 P${page.page}，正在创建任务...`);
    if (!multiPageProbeVideo) {
      throw new Error("当前视频信息已失效，请重新探测。");
    }
    setProbePreview(multiPageProbeVideo);
    await api.createVideoTask(multiPageProbeVideo.video_id, { page_number: page.page });
    setMultiPageDialogOpen(false);
    setMultiPageProbeVideo(null);
    setMultiPageOptions([]);
    setProbeUrl("");
    setSubmitStatus(`P${page.page} 已开始生成摘要`);
    setRefreshSeed((value) => value + 1);
    navigate(`/videos/${multiPageProbeVideo.video_id}`);
  }

  function handleCloseMultiPageDialog() {
    setMultiPageDialogOpen(false);
    setMultiPageProbeVideo(null);
    setMultiPageOptions([]);
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
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${mobileSidebarOpen ? "mobile-sidebar-open" : ""}`}>
      <TitleBar
        darkMode={darkMode}
        onToggleTheme={() => setDarkMode((current) => !current)}
        serviceOnline={snapshot.serviceOnline}
        backendRunning={desktop.backend?.running}
        runtimeDeviceLabel={runtimeDeviceLabel}
        version={runtimeVersionLabel}
      />
      <aside className="sidebar">
        <nav className="nav">
          <Link className={`nav-item ${location.pathname === "/" ? "active" : ""}`} to="/" aria-label="首页" title="首页" onClick={() => setMobileSidebarOpen(false)}>
            <span className="nav-icon" aria-hidden="true"><HomeIcon /></span>
            <span className="nav-copy">
              <strong>首页</strong>
              <small>工作台总览</small>
            </span>
          </Link>
          <Link className={`nav-item ${location.pathname === "/library" ? "active" : ""}`} to="/library" aria-label="视频库" title="视频库" onClick={() => setMobileSidebarOpen(false)}>
            <span className="nav-icon" aria-hidden="true"><LibraryIcon /></span>
            <span className="nav-copy">
              <strong>视频库</strong>
              <small>资产管理</small>
            </span>
          </Link>
          <Link className={`nav-item ${location.pathname.startsWith("/settings") ? "active" : ""}`} to="/settings" aria-label="设置" title="设置" onClick={() => setMobileSidebarOpen(false)}>
            <span className="nav-icon" aria-hidden="true"><SettingsIcon /></span>
            <span className="nav-copy">
              <strong>设置</strong>
              <small>运行配置</small>
            </span>
          </Link>
        </nav>

        <div className="nav-section-divider"></div>
        <button
          className="sidebar-corner-toggle"
          type="button"
          onClick={() => setSidebarCollapsed((current) => !current)}
          aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-pressed={sidebarCollapsed}
          title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          <IconSidebarToggle collapsed={sidebarCollapsed} />
        </button>
      </aside>

      {/* 移动端菜单按钮 - 仅在竖屏显示 */}
      <button
        className="mobile-menu-toggle"
        type="button"
        onClick={() => setMobileSidebarOpen(true)}
        aria-label="打开菜单"
        title="打开菜单"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* 移动端遮罩层 - 点击关闭 sidebar */}
      {mobileSidebarOpen && (
        <div
          className="mobile-sidebar-overlay"
          onClick={() => setMobileSidebarOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setMobileSidebarOpen(false);
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="关闭菜单"
        />
      )}

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
                    onSettingsSaved={(settings, environment) => {
                      setSnapshot((current) => ({
                        ...current,
                        settings,
                        environment: environment ?? current.environment,
                        systemInfo: current.systemInfo
                          ? {
                              ...current.systemInfo,
                              settings,
                              environment: environment ?? current.systemInfo.environment,
                            }
                          : current.systemInfo,
                      }));
                    }}
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
      <MultiPageSelectDialog
        isOpen={multiPageDialogOpen}
        video={multiPageProbeVideo}
        pages={multiPageOptions}
        onClose={handleCloseMultiPageDialog}
        onConfirm={handleConfirmMultiPage}
      />
    </div>
  );
}

function IconSidebarToggle({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9 4.5v15" />
      {collapsed ? <path d="m13.5 12 3-3m-3 3 3 3" /> : <path d="m15.5 12-3-3m3 3-3 3" />}
    </svg>
  );
}
