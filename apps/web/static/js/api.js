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
  listTasks() {
    return fetchJson("/api/v1/tasks");
  },
  createTask(payload) {
    return fetchJson("/api/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  getTaskResult(taskId) {
    return fetchJson(`/api/v1/tasks/${taskId}/result`);
  },
  getTaskEvents(taskId) {
    return fetchJson(`/api/v1/tasks/${taskId}/events`);
  },
};
