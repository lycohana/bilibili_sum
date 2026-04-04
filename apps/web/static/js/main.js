import { api } from "./api.js";
import { state } from "./state.js";
import { parseAppLocation, routeMeta } from "./utils.js";
import { buildTaskProgressView, renderHomeRegions, renderHomeView, renderTaskProgressEvents } from "./views/home.js";
import { renderSettingsView } from "./views/settings.js";

const elements = {
  nav: document.getElementById("nav"),
  pageEyebrow: document.getElementById("page-eyebrow"),
  pageTitle: document.getElementById("page-title"),
  serviceBadge: document.getElementById("service-badge"),
  liveStatus: document.getElementById("live-status"),
  viewRoot: document.getElementById("view-root"),
};
let renderedViewKey = "";

bootstrap().catch((error) => {
  elements.viewRoot.innerHTML = `<div class="grid-card empty-state">${error.message || "页面初始化失败"}</div>`;
});

async function bootstrap() {
  syncRouteFromLocation();
  bindNavigation();
  bindViewEvents();
  window.addEventListener("popstate", async () => {
    syncRouteFromLocation();
    await refreshApp({ fullView: true });
  });
  await refreshApp({ fullView: true });
  startPolling();
}

function syncRouteFromLocation() {
  const route = parseAppLocation(window.location.pathname);
  state.route = route.route;
  state.page = route.page;
  state.selectedVideoId = route.videoId || state.selectedVideoId;
}

function navigateTo(path) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  syncRouteFromLocation();
}

function bindNavigation() {
  elements.nav.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-route]");
    if (!target) return;
    if (target.dataset.route === "settings") {
      navigateTo("/settings");
      state.route = "settings";
      state.page = "settings";
    } else {
      navigateTo("/");
      state.route = "library";
      state.page = "library";
    }
    render({ fullView: true });
  });
}

function bindViewEvents() {
  elements.viewRoot.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === "probe-form") {
      await handleProbeSubmit(event);
      return;
    }
    if (form.id === "settings-form") {
      await handleSettingsSubmit(event);
    }
  });

  elements.viewRoot.addEventListener("input", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "library-search") {
      state.librarySearch = target.value;
      render({ regions: ["list"] });
    }
  });

  elements.viewRoot.addEventListener("click", async (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) return;

    const actionNode = target.closest("[data-action]");
    if (actionNode instanceof HTMLElement) {
      event.stopPropagation();
      await handleVideoAction(actionNode.dataset.action, actionNode.dataset);
      return;
    }

    if (target.closest("#refresh-env")) {
      await handleRefreshEnvironment();
      return;
    }

    if (target.closest("#install-cuda")) {
      await handleInstallCuda();
      return;
    }

    const videoCard = target.closest("[data-video-id]");
    if (videoCard instanceof HTMLElement) {
      await handleVideoAction("open-video", { videoId: videoCard.dataset.videoId });
    }
  });
}

async function refreshApp({ fullView = false } = {}) {
  const prevState = getRenderState();
  try {
    const [health, systemInfo, settings, videos, environment] = await Promise.all([
      api.getHealth(),
      api.getSystemInfo(),
      api.getSettings(),
      api.listVideos(),
      api.getEnvironment(),
    ]);
    state.serviceOnline = health.status === "ok";
    state.systemInfo = systemInfo;
    state.settings = settings;
    state.environment = environment;
    state.videos = videos;

    if (!state.selectedVideoId && videos.length) {
      state.selectedVideoId = videos[0].video_id;
    }
    if (state.selectedVideoId) {
      await loadSelectedVideo({ preserveRender: true });
    }

    const nextState = getRenderState();
    const changedRegions = getChangedRegions(prevState, nextState);
    if (fullView || hasShellChanges(prevState, nextState) || changedRegions.length) {
      render({ fullView, regions: changedRegions });
    }
  } catch (error) {
    state.serviceOnline = false;
    render({ errorMessage: error.message || "服务不可用" });
  }
}

async function loadSelectedVideo({ preserveRender = false } = {}) {
  if (!state.selectedVideoId) return;
  const [video, tasks] = await Promise.all([
    api.getVideo(state.selectedVideoId),
    api.getVideoTasks(state.selectedVideoId),
  ]);
  state.selectedVideoDetail = video;
  state.selectedVideoTasks = tasks;
  const nextTaskId =
    state.selectedTaskId && tasks.some((task) => task.task_id === state.selectedTaskId)
      ? state.selectedTaskId
      : tasks[0]?.task_id ?? null;
  state.selectedTaskId = nextTaskId;
  if (nextTaskId) {
    const [detail, events] = await Promise.all([
      api.getTaskResult(nextTaskId),
      api.getTaskEvents(nextTaskId),
    ]);
    state.selectedTaskDetail = detail;
    state.selectedTaskEvents = events;
    state.eventSourceAfter = events.length ? events[events.length - 1].created_at : null;
    syncTaskEventStream();
  } else {
    state.selectedTaskDetail = null;
    state.selectedTaskEvents = [];
    closeTaskEventStream();
  }
  if (!preserveRender) {
    render({ fullView: true });
  }
}

async function handleProbeSubmit(event) {
  event.preventDefault();
  const url = document.getElementById("probe-url-input")?.value.trim();
  if (!url) {
    state.submitStatus = "请输入视频链接";
    render({ regions: ["intake"] });
    return;
  }
  state.submitStatus = "正在抓取视频信息并准备开始总结...";
  render({ regions: ["intake"] });
  try {
    const response = await api.probeVideo({ url, force_refresh: false });
    state.probePreview = response.video;
    state.selectedVideoId = response.video.video_id;
    navigateTo(`/videos/${response.video.video_id}`);
    const created = await api.createVideoTask(response.video.video_id);
    state.selectedTaskId = created.task_id;
    state.submitStatus = response.cached ? "已从视频库读取并开始总结" : "视频已加入本地库并开始总结";
    await refreshApp({ fullView: true });
  } catch (error) {
    state.submitStatus = error.message || "开始总结失败";
    render({ regions: ["intake"] });
  }
}

async function handleVideoAction(action, dataset) {
  if (action === "open-video" && dataset.videoId) {
    state.selectedVideoId = dataset.videoId;
    navigateTo(`/videos/${dataset.videoId}`);
    await loadSelectedVideo({ preserveRender: false });
    return;
  }

  if (action === "back-library") {
    navigateTo("/");
    state.page = "library";
    render({ fullView: true });
    return;
  }

  if (action === "start-task" && dataset.videoId) {
    state.submitStatus = "正在创建处理任务...";
    render({ regions: state.page === "video-detail" ? ["hero", "progress"] : ["intake"] });
    try {
      const created = await api.createVideoTask(dataset.videoId);
      state.selectedTaskId = created.task_id;
      await refreshApp({ fullView: true });
    } catch (error) {
      state.submitStatus = error.message || "创建任务失败";
      render({ regions: state.page === "video-detail" ? ["hero", "progress"] : ["intake"] });
    }
    return;
  }

  if (action === "refresh-video" && dataset.videoUrl) {
    state.submitStatus = "正在重新获取视频信息...";
    render({ regions: state.page === "video-detail" ? ["hero"] : ["intake"] });
    try {
      const response = await api.refreshVideo(dataset.videoUrl);
      if (response?.video?.video_id) {
        state.selectedVideoId = response.video.video_id;
      }
      state.submitStatus = "视频信息已更新";
      await refreshApp({ fullView: state.page === "video-detail" });
    } catch (error) {
      state.submitStatus = error.message || "重新获取视频信息失败";
      render({ regions: state.page === "video-detail" ? ["hero"] : ["intake"] });
    }
    return;
  }

  if (action === "delete-video" && dataset.videoId) {
    try {
      await api.deleteVideo(dataset.videoId);
      if (state.selectedVideoId === dataset.videoId) {
        state.selectedVideoId = null;
        state.selectedTaskId = null;
        state.selectedTaskDetail = null;
        state.selectedTaskEvents = [];
        state.selectedVideoDetail = null;
        state.selectedVideoTasks = [];
      }
      if (state.page === "video-detail" && dataset.videoId) {
        navigateTo("/");
        state.page = "library";
      }
      state.submitStatus = "视频已删除";
      await refreshApp({ fullView: true });
    } catch (error) {
      state.submitStatus = error.message || "删除视频失败";
      render({ regions: state.page === "video-detail" ? ["hero", "history"] : ["intake", "list"] });
    }
    return;
  }

  if (action === "delete-task" && dataset.taskId) {
    try {
      await api.deleteTask(dataset.taskId);
      if (state.selectedTaskId === dataset.taskId) {
        state.selectedTaskId = null;
      }
      await refreshApp({ fullView: true });
    } catch (error) {
      state.submitStatus = error.message || "删除任务失败";
      render({ regions: state.page === "video-detail" ? ["history", "progress"] : ["intake"] });
    }
    return;
  }

  if (action === "select-task" && dataset.taskId) {
    state.selectedTaskId = dataset.taskId;
    await loadSelectedVideo({ preserveRender: false });
  }
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  const readValue = (id, fallback = "") => {
    const element = document.getElementById(id);
    if (!element) return fallback;
    return "value" in element ? element.value : fallback;
  };
  const readTrimmedValue = (id, fallback = "") => String(readValue(id, fallback)).trim();
  const readNumberValue = (id, fallback = 0) => {
    const parsed = Number(readValue(id, fallback));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const readChecked = (id, fallback = false) => {
    const element = document.getElementById(id);
    if (!element) return fallback;
    return "checked" in element ? element.checked : fallback;
  };
  const current = state.settings || {};
  const payload = {
    host: readTrimmedValue("host", current.host || ""),
    port: readNumberValue("port", current.port || 3838),
    data_dir: readTrimmedValue("data_dir", current.data_dir || ""),
    cache_dir: readTrimmedValue("cache_dir", current.cache_dir || ""),
    tasks_dir: readTrimmedValue("tasks_dir", current.tasks_dir || ""),
    database_url: readTrimmedValue("database_url", current.database_url || ""),
    whisper_model: readTrimmedValue("whisper_model", current.whisper_model || ""),
    whisper_device: readTrimmedValue("whisper_device", current.whisper_device || ""),
    whisper_compute_type: readTrimmedValue("whisper_compute_type", current.whisper_compute_type || ""),
    device_preference: readValue("device_preference", current.device_preference || "cpu"),
    compute_type: readValue("compute_type", current.compute_type || "int8"),
    model_mode: readValue("model_mode", current.model_mode || "fixed"),
    fixed_model: readValue("fixed_model", current.fixed_model || "tiny"),
    cuda_variant: readValue("cuda_variant", current.cuda_variant || "cu128"),
    output_dir: readTrimmedValue("output_dir", current.output_dir || ""),
    preserve_temp_audio: readChecked("preserve_temp_audio", Boolean(current.preserve_temp_audio)),
    enable_cache: readChecked("enable_cache", Boolean(current.enable_cache)),
    language: readTrimmedValue("language", current.language || "zh"),
    summary_mode: readValue("summary_mode", current.summary_mode || "llm"),
    llm_enabled: readChecked("llm_enabled", Boolean(current.llm_enabled)),
    llm_provider: readTrimmedValue("llm_provider", current.llm_provider || ""),
    llm_base_url: readTrimmedValue("llm_base_url", current.llm_base_url || ""),
    llm_model: readTrimmedValue("llm_model", current.llm_model || ""),
    llm_api_key: readValue("llm_api_key", current.llm_api_key || ""),
    summary_system_prompt: readValue("summary_system_prompt", current.summary_system_prompt || ""),
    summary_user_prompt_template: readValue(
      "summary_user_prompt_template",
      current.summary_user_prompt_template || "",
    ),
    summary_chunk_target_chars: Number(readValue("summary_chunk_target_chars", current.summary_chunk_target_chars || 2200)),
    summary_chunk_overlap_segments: Number(readValue("summary_chunk_overlap_segments", current.summary_chunk_overlap_segments || 2)),
    summary_chunk_concurrency: Number(readValue("summary_chunk_concurrency", current.summary_chunk_concurrency || 3)),
    summary_chunk_retry_count: Number(readValue("summary_chunk_retry_count", current.summary_chunk_retry_count || 2)),
  };
  state.settingsSaveStatus = "正在保存设置...";
  render({ fullView: true });
  try {
    const response = await api.updateSettings(payload);
    state.settings = response.settings;
    state.settingsSaveStatus = response.message || "设置已保存";
    await refreshApp({ fullView: true });
  } catch (error) {
    state.settingsSaveStatus = error.message || "设置保存失败";
    render({ fullView: true });
  }
}

async function handleRefreshEnvironment() {
  state.cudaActionStatus = "正在检测本机环境...";
  render({ fullView: true });
  try {
    state.environment = await api.getEnvironment();
    state.cudaActionStatus = "环境检测完成";
  } catch (error) {
    state.cudaActionStatus = error.message || "环境检测失败";
  }
  render({ fullView: true });
}

async function handleInstallCuda() {
  state.cudaActionStatus = "正在安装 CUDA 支持，这可能需要几分钟...";
  render({ fullView: true });
  try {
    const response = await api.installCuda({
      cudaVariant: document.getElementById("cuda_variant")?.value || "cu128",
    });
    state.environment = response.environment;
    state.cudaActionStatus = "CUDA 安装完成，建议重新检测环境";
  } catch (error) {
    state.cudaActionStatus = error.message || "CUDA 安装失败";
  }
  render({ fullView: true });
}

function render({ errorMessage = "", fullView = false, regions = [] } = {}) {
  const meta = routeMeta(state.route);
  elements.pageEyebrow.textContent = meta.eyebrow;
  elements.pageTitle.textContent =
    state.page === "video-detail" && state.selectedVideoDetail
      ? state.selectedVideoDetail.title
      : meta.title;
  elements.serviceBadge.textContent = state.serviceOnline ? "服务在线" : "服务离线";
  elements.serviceBadge.className = `service-badge ${state.serviceOnline ? "service-online" : "service-offline"}`;
  elements.liveStatus.innerHTML = renderLiveStatus(errorMessage);
  highlightNav();

  const nextViewKey = getViewKey();
  if (fullView || renderedViewKey !== nextViewKey || state.route === "settings") {
    if (state.route === "settings") {
      elements.viewRoot.innerHTML = renderSettingsView(state);
    } else {
      elements.viewRoot.innerHTML = renderHomeView(state);
    }
    renderedViewKey = nextViewKey;
    return;
  }

  if (state.route !== "library") return;

  const regionHtml = renderHomeRegions(state);
  for (const region of regions) {
    if (region === "progress" && patchTaskProgressNodes()) {
      continue;
    }
    const targetId = getRegionTargetId(region);
    const html = regionHtml[region];
    if (!targetId || html == null) continue;
    const node = document.getElementById(targetId);
    if (node) {
      node.innerHTML = html;
    }
  }
}

function patchTaskProgressNodes() {
  if (state.route !== "library" || state.page !== "video-detail" || !state.selectedTaskDetail) {
    return false;
  }

  const bar = document.getElementById("task-progress-bar");
  const fill = document.getElementById("task-progress-fill");
  const percent = document.getElementById("task-progress-percent");
  const status = document.getElementById("task-progress-status");
  const title = document.getElementById("task-progress-title");
  const subtitle = document.getElementById("task-progress-subtitle");
  const events = document.getElementById("task-progress-events");

  if (!bar || !fill || !percent || !status || !title || !subtitle || !events) {
    return false;
  }

  const view = buildTaskProgressView(state.selectedTaskEvents || []);
  const fillClass = view.hasError ? "error" : view.isCompleted ? "success" : "";

  bar.setAttribute("aria-valuenow", String(Math.round(view.progress)));
  fill.className = `progress-fill-simple ${fillClass}`.trim();
  fill.style.width = `${view.progress}%`;
  percent.textContent = `${Math.round(view.progress)}%`;
  status.textContent = view.headlineEvent?.message || "等待开始...";
  title.textContent = view.title;
  subtitle.textContent = view.subtitle;
  events.innerHTML = renderTaskProgressEvents(state.selectedTaskEvents || []);
  return true;
}

function getViewKey() {
  return state.route === "library" && state.page === "video-detail"
    ? `${state.route}:${state.page}:${state.selectedVideoId || ""}`
    : `${state.route}:${state.page}`;
}

function getRegionTargetId(region) {
  const map = {
    intake: "library-intake-region",
    summary: "library-summary-region",
    grid: "library-grid-region",
    list: "library-list-region",
    hero: "video-detail-hero-region",
    result: "video-detail-result-region",
    progress: "video-detail-progress-region",
    history: "video-detail-history-region",
  };
  return map[region] || "";
}

function getRenderState() {
  return {
    route: state.route,
    page: state.page,
    serviceOnline: state.serviceOnline,
    videos: state.videos,
    librarySearch: state.librarySearch,
    selectedVideoId: state.selectedVideoId,
    selectedVideoDetail: state.selectedVideoDetail,
    selectedVideoTasks: state.selectedVideoTasks,
    selectedTaskId: state.selectedTaskId,
    selectedTaskDetail: state.selectedTaskDetail,
    selectedTaskEvents: state.selectedTaskEvents,
    settings: state.settings,
    environment: state.environment,
    submitStatus: state.submitStatus,
    settingsSaveStatus: state.settingsSaveStatus,
    probePreview: state.probePreview,
    cudaActionStatus: state.cudaActionStatus,
  };
}

function isEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasShellChanges(prevState, nextState) {
  return !isEqual(
    {
      route: prevState.route,
      page: prevState.page,
      serviceOnline: prevState.serviceOnline,
      videos: prevState.videos,
      selectedVideoDetail: prevState.selectedVideoDetail,
    },
    {
      route: nextState.route,
      page: nextState.page,
      serviceOnline: nextState.serviceOnline,
      videos: nextState.videos,
      selectedVideoDetail: nextState.selectedVideoDetail,
    },
  );
}

function getChangedRegions(prevState, nextState) {
  if (prevState.route !== nextState.route || prevState.page !== nextState.page) {
    return [];
  }

  if (nextState.route !== "library") {
    return [];
  }

  if (nextState.page === "library") {
    const changed = [];
    if (!isEqual(
      { submitStatus: prevState.submitStatus, probePreview: prevState.probePreview },
      { submitStatus: nextState.submitStatus, probePreview: nextState.probePreview },
    )) {
      changed.push("intake");
    }
    if (!isEqual(prevState.videos, nextState.videos)) {
      changed.push("summary", "list");
    }
    if (prevState.librarySearch !== nextState.librarySearch) {
      changed.push("list");
    }
    return [...new Set(changed)];
  }

  const changed = [];
  if (!isEqual(
    { selectedVideoDetail: prevState.selectedVideoDetail, selectedTaskDetail: prevState.selectedTaskDetail },
    { selectedVideoDetail: nextState.selectedVideoDetail, selectedTaskDetail: nextState.selectedTaskDetail },
  )) {
    changed.push("hero");
  }
  if (!isEqual(prevState.selectedVideoDetail?.latest_result, nextState.selectedVideoDetail?.latest_result)) {
    changed.push("result");
  }
  if (!isEqual(
    { selectedTaskDetail: prevState.selectedTaskDetail, selectedTaskEvents: prevState.selectedTaskEvents },
    { selectedTaskDetail: nextState.selectedTaskDetail, selectedTaskEvents: nextState.selectedTaskEvents },
  )) {
    changed.push("progress");
  }
  if (!isEqual(
    { selectedVideoTasks: prevState.selectedVideoTasks, selectedTaskId: prevState.selectedTaskId },
    { selectedVideoTasks: nextState.selectedVideoTasks, selectedTaskId: nextState.selectedTaskId },
  )) {
    changed.push("history");
  }
  return [...new Set(changed)];
}

function renderLiveStatus(errorMessage) {
  const latest = state.videos[0];
  const latestTitle = latest ? latest.title : "暂无视频";
  const latestStatus = latest?.latest_status || "未开始";
  return `
    <div class="status-card"><strong>服务状态</strong><div class="status-caption">${state.serviceOnline ? "运行中" : "不可访问"}</div></div>
    <div class="status-card"><strong>视频数量</strong><div class="status-caption">${state.videos.length}</div></div>
    <div class="status-card"><strong>最近视频</strong><div class="status-caption">${latestTitle}</div></div>
    <div class="status-card"><strong>最近状态</strong><div class="status-caption">${latestStatus}</div></div>
    ${errorMessage ? `<div class="status-card"><strong>错误</strong><div class="status-caption">${errorMessage}</div></div>` : ""}
  `;
}

function highlightNav() {
  for (const item of elements.nav.querySelectorAll("[data-route]")) {
    item.classList.toggle("active", item.dataset.route === state.route);
  }
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    await refreshApp({ fullView: false });
  }, 5000);
}

function syncTaskEventStream() {
  const shouldStream =
    state.route === "library" &&
    state.selectedTaskDetail &&
    !["completed", "failed", "cancelled"].includes(state.selectedTaskDetail.status);
  if (!shouldStream) {
    closeTaskEventStream();
    return;
  }
  if (state.eventSource && state.eventSourceTaskId === state.selectedTaskId) return;
  closeTaskEventStream();
  const source = api.streamTaskEvents(state.selectedTaskId, state.eventSourceAfter);
  state.eventSource = source;
  state.eventSourceTaskId = state.selectedTaskId;
  source.addEventListener("progress", (event) => {
    const payload = JSON.parse(event.data);
    const nextEvent = payload.event;
    if (!state.selectedTaskEvents.some((item) => item.event_id === nextEvent.event_id)) {
      state.selectedTaskEvents = [...state.selectedTaskEvents, nextEvent];
      state.eventSourceAfter = nextEvent.created_at;
      if (state.selectedTaskDetail) {
        state.selectedTaskDetail = {
          ...state.selectedTaskDetail,
          status: payload.status,
          updated_at: payload.updated_at,
        };
      }
      state.videos = state.videos.map((video) =>
        video.video_id === state.selectedVideoId
          ? { ...video, latest_status: payload.status, latest_stage: nextEvent.stage, latest_task_id: state.selectedTaskId }
          : video,
      );
      render({ regions: state.page === "video-detail" ? ["hero", "progress", "list", "summary"] : ["list", "summary"] });
    }
    if (["completed", "failed", "cancelled"].includes(payload.status)) {
      closeTaskEventStream();
      refreshApp({ fullView: false }).catch(() => {});
    }
  });
  source.addEventListener("error", () => {
    closeTaskEventStream();
  });
}

function closeTaskEventStream() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = null;
  state.eventSourceTaskId = null;
}

function snapshot() {
  return JSON.stringify(getRenderState());
}
