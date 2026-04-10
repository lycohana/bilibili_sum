import type { UpdateInfo } from "./components/UpdateDialog";
import type { EnvironmentInfo, ServiceSettings, SystemInfo, TaskStatus, VideoAssetSummary } from "./types";

export type Snapshot = {
  serviceOnline: boolean;
  systemInfo: SystemInfo | null;
  environment: EnvironmentInfo | null;
  settings: ServiceSettings | null;
  videos: VideoAssetSummary[];
  error: string;
};

export type DesktopState = {
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

export type UpdateState = {
  status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "installing" | "error";
  version: string;
  releaseDate: string;
  releaseNotes: string | null;
  downloadProgress: number;
  errorMessage: string | null;
};

export type LibraryFilter = "all" | "completed" | "running" | "with-result";
export type MetricTone = "default" | "accent" | "success" | "info";
export type DevicePreference = "auto" | "cpu" | "cuda";
export type SelectOption = { value: string; label: string };

export const emptySnapshot: Snapshot = { serviceOnline: false, systemInfo: null, environment: null, settings: null, videos: [], error: "" };

export const devicePreferenceOptions: SelectOption[] = [
  { value: "auto", label: "自动选择" },
  { value: "cuda", label: "GPU (CUDA)" },
  { value: "cpu", label: "CPU" },
];

export function normalizeDevicePreference(value?: string | null): DevicePreference {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "gpu") {
    return "cuda";
  }
  if (normalized === "auto" || normalized === "cuda" || normalized === "cpu") {
    return normalized;
  }
  return "cpu";
}

export function devicePreferenceLabel(value?: string | null): string {
  const normalized = normalizeDevicePreference(value);
  if (normalized === "cuda") {
    return "GPU (CUDA)";
  }
  if (normalized === "auto") {
    return "自动选择";
  }
  return "CPU";
}

export function deriveRuntimeDeviceLabel({
  whisperDevice,
  cudaAvailable,
  hasSettings,
}: {
  whisperDevice?: string | null;
  cudaAvailable?: boolean;
  hasSettings: boolean;
}): "GPU" | "CPU" {
  const effectiveDevice = normalizeDevicePreference(whisperDevice);
  if (effectiveDevice === "cuda") {
    return "GPU";
  }
  if (!hasSettings && cudaAvailable) {
    return "GPU";
  }
  return "CPU";
}

export function toUpdateState(info: UpdateInfo): UpdateState {
  return {
    status: info.status,
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: info.releaseNotes,
    downloadProgress: info.downloadProgress,
    errorMessage: info.errorMessage,
  };
}

export function getUpdateDialogSignal(update: Pick<UpdateState, "status" | "version">): string | null {
  if (update.status !== "available" && update.status !== "downloaded") {
    return null;
  }
  return `${update.status}:${update.version || "unknown"}`;
}

export function isUpdateUnsupported(update: Pick<UpdateState, "status" | "errorMessage">): boolean {
  return update.status === "not-available" && Boolean(update.errorMessage);
}

export function getUpdateStatusLabel(update: Pick<UpdateState, "status" | "errorMessage">): string {
  if (isUpdateUnsupported(update)) {
    return "不可用";
  }
  switch (update.status) {
    case "checking":
      return "检查中";
    case "available":
      return "发现新版本";
    case "not-available":
      return "已是最新";
    case "downloading":
      return "下载中";
    case "downloaded":
      return "待安装";
    case "installing":
      return "安装中";
    case "error":
      return "检查失败";
    default:
      return "未检查";
  }
}

export function getUpdateStatusTone(update: Pick<UpdateState, "status" | "errorMessage">): "success" | "failed" | "running" | "pending" {
  if (isUpdateUnsupported(update)) {
    return "failed";
  }
  switch (update.status) {
    case "available":
    case "downloaded":
      return "success";
    case "checking":
    case "downloading":
    case "installing":
      return "running";
    case "error":
      return "failed";
    default:
      return "pending";
  }
}

export function getUpdateSummary(update: UpdateState, currentVersion: string): string {
  const installedVersion = currentVersion || "-";
  if (isUpdateUnsupported(update)) {
    return update.errorMessage || "当前环境不支持自动更新。";
  }
  switch (update.status) {
    case "checking":
      return `正在检查更新，当前版本 v${installedVersion}。`;
    case "available":
      return `发现新版本 v${update.version || "-"}，当前版本 v${installedVersion}。`;
    case "not-available":
      return `当前版本 v${installedVersion} 已是最新版本。`;
    case "downloading":
      return `正在下载 v${update.version || "-"}，进度 ${Math.round(update.downloadProgress)}%。`;
    case "downloaded":
      return `v${update.version || "-"} 已下载完成，可立即安装。`;
    case "installing":
      return `正在安装 v${update.version || "-"}。`;
    case "error":
      return update.errorMessage || "检查更新失败，请稍后重试。";
    default:
      return `当前版本 v${installedVersion}，尚未检查更新。`;
  }
}

export function formatShortDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

export function platformLabel(platform?: string | null) {
  const labels: Record<string, string> = {
    bilibili: "Bilibili",
    youtube: "YouTube",
    local: "Local",
  };
  return (platform && labels[platform.toLowerCase()]) || "Video";
}

export function stageLabel(stage?: string | null) {
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

export function taskStatusClass(status?: TaskStatus | null) {
  if (status === "completed") return "status-success";
  if (status === "running") return "status-running";
  if (status === "failed") return "status-failed";
  return "status-pending";
}

export function progressEventClass(stage?: string | null) {
  if (stage === "completed") return "completed";
  if (stage === "failed") return "error";
  if (stage === "summarizing" || stage === "transcribing" || stage === "downloading") return "active";
  return "";
}
