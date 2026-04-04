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
  getSystemInfo() {
    return fetchJson("/api/v1/system/info");
  },
  getEnvironment() {
    return fetchJson("/api/v1/environment");
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
