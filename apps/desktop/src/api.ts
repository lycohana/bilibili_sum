import type {
  EnvironmentInfo,
  ServiceSettings,
  SystemLogResponse,
  SystemInfo,
  TaskDetail,
  TaskEvent,
  TaskMarkdownExportResponse,
  LlmTestResponse,
  TaskMindMapResponse,
  TaskSummary,
  VideoAssetDetail,
  VideoProbeResult,
  VideoAssetSummary,
  VideoTaskBatchRequest,
  VideoTaskBatchResponse,
} from "./types";

export type UpdateSettingsResponse = {
  saved: boolean;
  settings: ServiceSettings;
  message: string;
};

export type AppUpdateInfo = {
  status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "installing" | "error";
  version: string;
  releaseDate: string;
  releaseNotes: string | null;
  downloadProgress: number;
  errorMessage: string | null;
};

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    let detail = text || `Request failed: ${response.status}`;
    try {
      const payload = JSON.parse(text) as { detail?: string; message?: string };
      detail = payload.detail || payload.message || detail;
    } catch {
      detail = text || `Request failed: ${response.status}`;
    }
    throw new Error(detail);
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
  getAppUpdate() {
    return fetchJson<AppUpdateInfo>("/api/v1/app/update");
  },
  updateSettings(payload: Partial<ServiceSettings>) {
    return fetchJson<UpdateSettingsResponse>("/api/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  testLlmConnection(payload: Partial<ServiceSettings>) {
    return fetchJson<LlmTestResponse>("/api/v1/llm/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  testAsrConnection(payload: Partial<ServiceSettings>) {
    return fetchJson<LlmTestResponse>("/api/v1/asr/test", {
      method: "POST",
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
  setVideoFavorite(videoId: string, payload: { is_favorite: boolean }) {
    return fetchJson<VideoAssetDetail>(`/api/v1/videos/${videoId}/favorite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  deleteVideo(videoId: string) {
    return fetchJson<{ deleted: boolean }>(`/api/v1/videos/${videoId}`, { method: "DELETE" });
  },
  probeVideo(payload: { url: string; force_refresh: boolean }) {
    return fetchJson<VideoProbeResult>("/api/v1/videos/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  uploadLocalVideo(file: File) {
    const url = new URL("/api/v1/videos/upload", window.location.origin);
    url.searchParams.set("filename", file.name);
    return fetchJson<VideoProbeResult>(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    });
  },
  getVideoTasks(videoId: string) {
    return fetchJson<TaskSummary[]>(`/api/v1/videos/${videoId}/tasks`);
  },
  createVideoTask(videoId: string, payload?: { page_number?: number | null }) {
    return fetchJson<TaskDetail>(`/api/v1/videos/${videoId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
  },
  createVideoTasksBatch(videoId: string, payload: VideoTaskBatchRequest) {
    return fetchJson<VideoTaskBatchResponse>(`/api/v1/videos/${videoId}/tasks/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  resummarizeVideoTask(videoId: string, payload: { task_id?: string | null; page_number?: number | null }) {
    return fetchJson<TaskDetail>(`/api/v1/videos/${videoId}/tasks/resummary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  resummarizeVideoTasksBatch(videoId: string, payload: VideoTaskBatchRequest) {
    return fetchJson<VideoTaskBatchResponse>(`/api/v1/videos/${videoId}/tasks/resummary/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  createAggregateSummaryTask(videoId: string, payload?: { page_numbers?: number[] | null }) {
    return fetchJson<TaskDetail>(`/api/v1/videos/${videoId}/tasks/aggregate-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
  },
  getTaskResult(taskId: string) {
    return fetchJson<TaskDetail>(`/api/v1/tasks/${taskId}/result`);
  },
  getTaskEvents(taskId: string) {
    return fetchJson<TaskEvent[]>(`/api/v1/tasks/${taskId}/events`);
  },
  listTasks() {
    return fetchJson<TaskSummary[]>("/api/v1/tasks");
  },
  getTaskMindMap(taskId: string) {
    return fetchJson<TaskMindMapResponse>(`/api/v1/tasks/${taskId}/mindmap`);
  },
  exportTaskMarkdown(taskId: string, payload?: { target?: "markdown" | "obsidian" }) {
    return fetchJson<TaskMarkdownExportResponse>(`/api/v1/tasks/${taskId}/exports/markdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
  },
  generateTaskMindMap(taskId: string, options?: { force?: boolean }) {
    const url = new URL(`/api/v1/tasks/${taskId}/mindmap`, window.location.origin);
    if (options?.force) {
      url.searchParams.set("force", "1");
    }
    return fetchJson<TaskMindMapResponse>(url.toString(), { method: "POST" });
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
  installLocalAsr(payload?: { reinstall?: boolean }) {
    return fetchJson<{
      installed: boolean;
      runtimeChannel?: string;
      stdoutTail?: string;
      environment?: EnvironmentInfo;
    }>("/api/v1/asr/local/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
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
