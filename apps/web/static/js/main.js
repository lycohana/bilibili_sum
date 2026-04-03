import { api } from "./api.js";
import { state } from "./state.js";
import { routeMeta } from "./utils.js";
import { renderHomeView } from "./views/home.js";
import { renderTasksView } from "./views/tasks.js";
import { renderSettingsView } from "./views/settings.js";

const elements = {
  nav: document.getElementById("nav"),
  pageEyebrow: document.getElementById("page-eyebrow"),
  pageTitle: document.getElementById("page-title"),
  serviceBadge: document.getElementById("service-badge"),
  liveStatus: document.getElementById("live-status"),
  viewRoot: document.getElementById("view-root"),
};

bootstrap().catch((error) => {
  elements.viewRoot.innerHTML = `<div class="grid-card empty-state">${error.message || "页面初始化失败"}</div>`;
});

async function bootstrap() {
  bindNavigation();
  await refreshAllInternal({ forceRender: true });
  startPolling();
}

function bindNavigation() {
  elements.nav.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-route]");
    if (!target) {
      return;
    }
    state.route = target.dataset.route;
    render();
    bindCurrentViewEvents();
    if (state.route === "tasks" && state.selectedTaskId) {
      await loadTaskDetail(state.selectedTaskId);
    }
  });
}

async function refreshAll() {
  return refreshAllInternal({ forceRender: false });
}

async function refreshAllInternal({ forceRender = false } = {}) {
  try {
    const prevServiceOnline = state.serviceOnline;
    const prevSystemInfo = stableStringify(state.systemInfo);
    const prevSettings = stableStringify(state.settings);
    const prevTasks = stableStringify(state.tasks);
    const prevEnvironment = stableStringify(state.environment);
    const prevSelectedTaskId = state.selectedTaskId;
    const prevDetail = stableStringify(state.selectedTaskDetail);
    const prevEvents = stableStringify(state.selectedTaskEvents);

    const [health, systemInfo, settings, tasks, environment] = await Promise.all([
      api.getHealth(),
      api.getSystemInfo(),
      api.getSettings(),
      api.listTasks(),
      api.getEnvironment(),
    ]);
    state.serviceOnline = health.status === "ok";
    state.systemInfo = systemInfo;
    state.settings = settings;
    state.tasks = tasks;
    state.environment = environment;
    if (!state.selectedTaskId && tasks.length > 0) {
      state.selectedTaskId = tasks[0].task_id;
    }
    if (state.selectedTaskId) {
      const [detail, events] = await Promise.all([
        api.getTaskResult(state.selectedTaskId),
        api.getTaskEvents(state.selectedTaskId),
      ]);
      state.selectedTaskDetail = detail;
      state.selectedTaskEvents = events;
    } else {
      state.selectedTaskDetail = null;
      state.selectedTaskEvents = [];
    }

    const hasMeaningfulChange =
      forceRender ||
      prevServiceOnline !== state.serviceOnline ||
      prevSystemInfo !== stableStringify(state.systemInfo) ||
      prevSettings !== stableStringify(state.settings) ||
      prevTasks !== stableStringify(state.tasks) ||
      prevEnvironment !== stableStringify(state.environment) ||
      prevSelectedTaskId !== state.selectedTaskId ||
      prevDetail !== stableStringify(state.selectedTaskDetail) ||
      prevEvents !== stableStringify(state.selectedTaskEvents);

    if (hasMeaningfulChange) {
      render();
      bindCurrentViewEvents();
    }
  } catch (error) {
    state.serviceOnline = false;
    render(error.message || "服务不可用");
  }
}

async function loadTaskDetail(taskId) {
  const [detail, events] = await Promise.all([
    api.getTaskResult(taskId),
    api.getTaskEvents(taskId),
  ]);
  state.selectedTaskId = taskId;
  state.selectedTaskDetail = detail;
  state.selectedTaskEvents = events;
  render();
  bindCurrentViewEvents();
}

async function handleSubmit(event) {
  event.preventDefault();
  const url = document.getElementById("url-input").value.trim();
  const title = document.getElementById("title-input").value.trim();
  if (!url) {
    state.submitStatus = "请输入视频链接";
    render();
    bindCurrentViewEvents();
    return;
  }
  state.submitStatus = "正在提交任务...";
  render();
  bindCurrentViewEvents();

  try {
    const payload = { input_type: "url", source: url };
    if (title) {
      payload.title = title;
    }
    const created = await api.createTask(payload);
    state.submitStatus = `任务已创建：${created.task_id}`;
    state.selectedTaskId = created.task_id;
    await refreshAll();
  } catch (error) {
    state.submitStatus = error.message || "任务创建失败";
    render();
    bindCurrentViewEvents();
  }
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  const payload = {
    host: document.getElementById("host").value.trim(),
    port: Number(document.getElementById("port").value),
    data_dir: document.getElementById("data_dir").value.trim(),
    cache_dir: document.getElementById("cache_dir").value.trim(),
    tasks_dir: document.getElementById("tasks_dir").value.trim(),
    database_url: document.getElementById("database_url").value.trim(),
    whisper_model: document.getElementById("whisper_model").value.trim(),
    whisper_device: document.getElementById("whisper_device").value.trim(),
    whisper_compute_type: document.getElementById("whisper_compute_type").value.trim(),
    device_preference: document.getElementById("device_preference").value,
    compute_type: document.getElementById("compute_type").value,
    model_mode: document.getElementById("model_mode").value,
    fixed_model: document.getElementById("fixed_model").value,
    cuda_variant: document.getElementById("cuda_variant").value,
    output_dir: document.getElementById("output_dir").value.trim(),
    preserve_temp_audio: document.getElementById("preserve_temp_audio").checked,
    enable_cache: document.getElementById("enable_cache").checked,
    language: document.getElementById("language").value.trim(),
    summary_mode: document.getElementById("summary_mode").value,
    llm_enabled: document.getElementById("llm_enabled").checked,
    llm_provider: document.getElementById("llm_provider").value.trim(),
    llm_base_url: document.getElementById("llm_base_url").value.trim(),
    llm_model: document.getElementById("llm_model").value.trim(),
    llm_api_key: document.getElementById("llm_api_key").value,
    summary_system_prompt: document.getElementById("summary_system_prompt").value,
    summary_user_prompt_template: document.getElementById("summary_user_prompt_template").value,
  };
  state.settingsSaveStatus = "正在保存设置...";
  render();
  bindCurrentViewEvents();
  try {
    const response = await api.updateSettings(payload);
    state.settings = response.settings;
    state.settingsSaveStatus = response.message || "设置已保存";
    await refreshAll();
  } catch (error) {
    state.settingsSaveStatus = error.message || "设置保存失败";
    render();
    bindCurrentViewEvents();
  }
}

async function handleRefreshEnvironment() {
  state.cudaActionStatus = "正在检测本机环境...";
  render();
  bindCurrentViewEvents();
  try {
    state.environment = await api.getEnvironment();
    state.cudaActionStatus = "环境检测完成";
  } catch (error) {
    state.cudaActionStatus = error.message || "环境检测失败";
  }
  render();
  bindCurrentViewEvents();
}

async function handleInstallCuda() {
  state.cudaActionStatus = "正在安装 CUDA 支持，这可能需要几分钟...";
  render();
  bindCurrentViewEvents();
  try {
    const response = await api.installCuda({
      cudaVariant: document.getElementById("cuda_variant").value,
    });
    state.environment = response.environment;
    state.cudaActionStatus = "CUDA 安装完成，建议重新检测环境";
  } catch (error) {
    state.cudaActionStatus = error.message || "CUDA 安装失败";
  }
  render();
  bindCurrentViewEvents();
}

function render(errorMessage = "") {
  const meta = routeMeta(state.route);
  elements.pageEyebrow.textContent = meta.eyebrow;
  elements.pageTitle.textContent = meta.title;
  elements.serviceBadge.textContent = state.serviceOnline ? "服务在线" : "服务离线";
  elements.serviceBadge.className = `service-badge ${state.serviceOnline ? "service-online" : "service-offline"}`;
  elements.liveStatus.innerHTML = renderLiveStatus(errorMessage);
  highlightNav();

  if (state.route === "tasks") {
    elements.viewRoot.innerHTML = renderTasksView(state);
    return;
  }
  if (state.route === "settings") {
    elements.viewRoot.innerHTML = renderSettingsView(state);
    return;
  }
  elements.viewRoot.innerHTML = renderHomeView(state);
}

function renderLiveStatus(errorMessage) {
  const latest = state.tasks[0];
  const latestStatus = latest ? latest.status : "暂无任务";
  const activeLabel = state.selectedTaskDetail?.title || latest?.title || "暂无活动任务";
  return `
    <div class="status-card">
      <strong>服务状态</strong>
      <div class="status-caption">${state.serviceOnline ? "运行中" : "不可访问"}</div>
    </div>
    <div class="status-card">
      <strong>最新任务</strong>
      <div class="status-caption">${latestStatus}</div>
    </div>
    <div class="status-card">
      <strong>当前查看</strong>
      <div class="status-caption">${activeLabel}</div>
    </div>
    ${errorMessage ? `<div class="status-card"><strong>错误</strong><div class="status-caption">${errorMessage}</div></div>` : ""}
  `;
}

function highlightNav() {
  for (const item of elements.nav.querySelectorAll("[data-route]")) {
    item.classList.toggle("active", item.dataset.route === state.route);
  }
}

function bindCurrentViewEvents() {
  if (state.route === "tasks") {
    const form = document.getElementById("task-form");
    if (form) {
      form.addEventListener("submit", handleSubmit);
    }
    for (const node of document.querySelectorAll("[data-task-id]")) {
      node.addEventListener("click", async () => {
        await loadTaskDetail(node.dataset.taskId);
      });
    }
  }
  if (state.route === "settings") {
    const form = document.getElementById("settings-form");
    if (form) {
      form.addEventListener("submit", handleSettingsSubmit);
    }
    const refreshButton = document.getElementById("refresh-env");
    if (refreshButton) {
      refreshButton.addEventListener("click", handleRefreshEnvironment);
    }
    const installButton = document.getElementById("install-cuda");
    if (installButton) {
      installButton.addEventListener("click", handleInstallCuda);
    }
  }
}

function startPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
  state.pollTimer = setInterval(async () => {
    await refreshAllInternal({ forceRender: false });
  }, 4000);
}

function stableStringify(value) {
  return JSON.stringify(value ?? null);
}
