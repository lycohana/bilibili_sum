import type {
  EnvironmentInfo,
  ServiceSettings,
  SystemLogResponse,
  SystemInfo,
  TaskDetail,
  TaskEvent,
  TaskSummary,
  VideoAssetDetail,
  VideoAssetSummary,
} from "./types";

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  getHealth() {
    return fetchJson<{ status: string }>("/health");
  },
  getSystemInfo(options?: { runtimeChannel?: string; refresh?: boolean }) {
    const url = new URL("/api/v1/system/info", window.location.origin);
    if (options?.runtimeChannel) {
      url.searchParams.set("runtime_channel", options.runtimeChannel);
    }
    if (options?.refresh) {
      url.searchParams.set("refresh", "1");
    }
    return fetchJson<SystemInfo>(url.toString());
  },
  getEnvironment(options?: { runtimeChannel?: string; refresh?: boolean }) {
    const url = new URL("/api/v1/environment", window.location.origin);
    if (options?.runtimeChannel) {
      url.searchParams.set("runtime_channel", options.runtimeChannel);
    }
    if (options?.refresh) {
      url.searchParams.set("refresh", "1");
    }
    return fetchJson<EnvironmentInfo>(url.toString());
  },
  getSettings() {
    return fetchJson<ServiceSettings>("/api/v1/settings");
  },
  updateSettings(payload: Partial<ServiceSettings>) {
    return fetchJson<ServiceSettings>("/api/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  getSystemLogs(lines = 200) {
    return fetchJson<SystemLogResponse>(`/api/v1/system/logs?lines=${lines}`);
  },
  shutdownService() {
    return fetchJson<{ ok: boolean }>("/api/v1/system/shutdown", { method: "POST" });
  },
  listVideos() {
    return fetchJson<VideoAssetSummary[]>("/api/v1/videos");
  },
  getVideo(videoId: string) {
    return fetchJson<VideoAssetDetail>(`/api/v1/videos/${videoId}`);
  },
  deleteVideo(videoId: string) {
    return fetchJson<{ deleted: boolean }>(`/api/v1/videos/${videoId}`, { method: "DELETE" });
  },
  probeVideo(payload: { url: string; force_refresh: boolean }) {
    return fetchJson<{ video: VideoAssetSummary; cached: boolean }>("/api/v1/videos/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  getVideoTasks(videoId: string) {
    return fetchJson<TaskSummary[]>(`/api/v1/videos/${videoId}/tasks`);
  },
  createVideoTask(videoId: string) {
    return fetchJson<TaskDetail>(`/api/v1/videos/${videoId}/tasks`, { method: "POST" });
  },
  getTaskResult(taskId: string) {
    return fetchJson<TaskDetail>(`/api/v1/tasks/${taskId}/result`);
  },
  getTaskEvents(taskId: string) {
    return fetchJson<TaskEvent[]>(`/api/v1/tasks/${taskId}/events`);
  },
  deleteTask(taskId: string) {
    return fetchJson<{ deleted: boolean }>(`/api/v1/tasks/${taskId}`, { method: "DELETE" });
  },
  installCuda(payload: { cuda_variant: string }) {
    return fetchJson<{
      installed: boolean;
      cudaVariant: string;
      runtimeChannel?: string;
      restartRequired?: boolean;
      stdoutTail?: string;
      environment?: EnvironmentInfo;
    }>("/api/v1/cuda/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  createTaskEventSource(taskId: string, after?: string | null) {
    const url = new URL(`/api/v1/tasks/${taskId}/events/stream`, window.location.origin);
    if (after) {
      url.searchParams.set("after", after);
    }
    return new EventSource(url.toString());
  },
};
