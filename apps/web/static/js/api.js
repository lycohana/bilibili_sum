export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败：${response.status}`);
  }
  return await response.json();
}

export const api = {
  getHealth() {
    return fetchJson("/health");
  },
  getSystemInfo(options = {}) {
    const url = new URL("/api/v1/system/info", window.location.origin);
    if (options.runtimeChannel) {
      url.searchParams.set("runtime_channel", options.runtimeChannel);
    }
    if (options.refresh) {
      url.searchParams.set("refresh", "1");
    }
    return fetchJson(url);
  },
  getEnvironment(options = {}) {
    const url = new URL("/api/v1/environment", window.location.origin);
    if (options.runtimeChannel) {
      url.searchParams.set("runtime_channel", options.runtimeChannel);
    }
    if (options.refresh) {
      url.searchParams.set("refresh", "1");
    }
    return fetchJson(url);
  },
  getSystemLogs(lines = 200) {
    return fetchJson(`/api/v1/system/logs?lines=${lines}`);
  },
  shutdownService() {
    return fetchJson("/api/v1/system/shutdown", {
      method: "POST",
    });
  },
  getSettings() {
    return fetchJson("/api/v1/settings");
  },
  updateSettings(payload) {
    return fetchJson("/api/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  installCuda(payload) {
    return fetchJson("/api/v1/cuda/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  probeVideo(payload) {
    return fetchJson("/api/v1/videos/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  listVideos() {
    return fetchJson("/api/v1/videos");
  },
  getVideo(videoId) {
    return fetchJson(`/api/v1/videos/${videoId}`);
  },
  deleteVideo(videoId) {
    return fetchJson(`/api/v1/videos/${videoId}`, { method: "DELETE" });
  },
  refreshVideo(videoUrl) {
    return fetchJson("/api/v1/videos/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: videoUrl, force_refresh: true }),
    });
  },
  getVideoTasks(videoId) {
    return fetchJson(`/api/v1/videos/${videoId}/tasks`);
  },
  createVideoTask(videoId) {
    return fetchJson(`/api/v1/videos/${videoId}/tasks`, { method: "POST" });
  },
  listTasks() {
    return fetchJson("/api/v1/tasks");
  },
  getTaskResult(taskId) {
    return fetchJson(`/api/v1/tasks/${taskId}/result`);
  },
  getTaskEvents(taskId) {
    return fetchJson(`/api/v1/tasks/${taskId}/events`);
  },
  deleteTask(taskId) {
    return fetchJson(`/api/v1/tasks/${taskId}`, { method: "DELETE" });
  },
  streamTaskEvents(taskId, afterCreatedAt) {
    const url = new URL(`/api/v1/tasks/${taskId}/events/stream`, window.location.origin);
    if (afterCreatedAt) {
      url.searchParams.set("after", afterCreatedAt);
    }
    return new EventSource(url);
  },
};
