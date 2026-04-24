import { contextBridge, ipcRenderer } from "electron";

// 禁用鼠标中键导航（防止打开新窗口）
// 在 DOM 加载完成后注册事件监听
document.addEventListener(
  "DOMContentLoaded",
  () => {
    window.addEventListener(
      "auxclick",
      (event) => {
        if (event.button === 1) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true },
    );

    // 同时阻止 click 事件中的中键
    window.addEventListener(
      "click",
      (event) => {
        if (event.button === 1) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
  },
  { once: true },
);

type CloseBehavior = "ask" | "tray" | "exit";

export type DesktopBackendStatus = {
  running: boolean;
  ready: boolean;
  pid: number | null;
  url: string;
  lastError: string;
};

export type UpdateStatus = "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "installing" | "error";

export type UpdateInfo = {
  status: UpdateStatus;
  version: string;
  releaseDate: string;
  releaseNotes: string | null;
  downloadProgress: number;
  errorMessage: string | null;
};

export type StorageLocationKind = "data" | "cache" | "tasks" | "logs" | "runtime";

export type StorageDirectoryStat = {
  key: StorageLocationKind;
  label: string;
  path: string;
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
};

export type StorageOverview = {
  generatedAt: string;
  totals: {
    managedBytes: number;
    managedFiles: number;
    managedDirectories: number;
  };
  directories: StorageDirectoryStat[];
  cleanup: {
    serviceAvailable: boolean;
    orphanTaskCount: number;
    orphanTaskBytes: number;
    cacheCandidateCount: number;
    cacheCandidateBytes: number;
  };
};

export type StorageCleanupResult = {
  deletedPaths: string[];
  deletedCount: number;
  removedTaskDirs: number;
  removedCacheEntries: number;
  reclaimedBytes: number;
};

export type BilibiliCookieExportResult = {
  cookiesFile: string;
  cookieCount: number;
};

const desktop = {
  app: {
    getVersion: () => ipcRenderer.invoke("desktop:app:get-version") as Promise<string>,
    getAutoLaunch: () => ipcRenderer.invoke("desktop:app:get-auto-launch") as Promise<boolean>,
    setAutoLaunch: (enabled: boolean) =>
      ipcRenderer.invoke("desktop:app:set-auto-launch", enabled) as Promise<boolean>,
  },
  window: {
    show: () => ipcRenderer.invoke("desktop:window:show") as Promise<void>,
    minimize: () => ipcRenderer.invoke("desktop:window:minimize") as Promise<void>,
    maximize: () => ipcRenderer.invoke("desktop:window:maximize") as Promise<void>,
    close: () => ipcRenderer.invoke("desktop:window:close") as Promise<void>,
    isMaximized: () => ipcRenderer.invoke("desktop:window:isMaximized") as Promise<boolean>,
  },
  backend: {
    start: () => ipcRenderer.invoke("desktop:backend:start") as Promise<DesktopBackendStatus>,
    stop: () => ipcRenderer.invoke("desktop:backend:stop") as Promise<DesktopBackendStatus>,
    status: () => ipcRenderer.invoke("desktop:backend:status") as Promise<DesktopBackendStatus>,
    onStatus: (listener: (status: DesktopBackendStatus) => void) => {
      const wrapped = (_event: unknown, payload: DesktopBackendStatus) => listener(payload);
      ipcRenderer.on("desktop:backend:status-changed", wrapped);
      return () => {
        ipcRenderer.removeListener("desktop:backend:status-changed", wrapped);
      };
    },
  },
  clipboard: {
    writeImage: (dataUrl: string) => ipcRenderer.invoke("desktop:clipboard:write-image", dataUrl) as Promise<void>,
  },
  media: {
    pickVideoFile: () => ipcRenderer.invoke("desktop:media:pick-video-file") as Promise<string | null>,
  },
  bilibili: {
    captureLoginCookies: () =>
      ipcRenderer.invoke("desktop:bilibili:capture-login-cookies") as Promise<BilibiliCookieExportResult>,
  },
  shell: {
    openPath: (targetPath: string) => ipcRenderer.invoke("desktop:shell:open-path", targetPath) as Promise<string>,
  },
  logs: {
    getServiceLogPath: () => ipcRenderer.invoke("desktop:logs:get-service-log-path") as Promise<string>,
    readServiceLogTail: (lines = 200) =>
      ipcRenderer.invoke("desktop:logs:read-service-log-tail", lines) as Promise<{ path: string; lines: number; content: string }>,
  },
  preferences: {
    getCloseBehavior: () => ipcRenderer.invoke("desktop:preferences:get-close-behavior") as Promise<CloseBehavior>,
    setCloseBehavior: (value: CloseBehavior) =>
      ipcRenderer.invoke("desktop:preferences:set-close-behavior", value) as Promise<CloseBehavior>,
    resetCloseBehavior: () => ipcRenderer.invoke("desktop:preferences:reset-close-behavior") as Promise<CloseBehavior>,
  },
  update: {
    check: () => ipcRenderer.invoke("desktop:update:check") as Promise<UpdateInfo>,
    download: () => ipcRenderer.invoke("desktop:update:download") as Promise<UpdateInfo>,
    install: () => ipcRenderer.invoke("desktop:update:install") as Promise<void>,
    getStatus: () => ipcRenderer.invoke("desktop:update:get-status") as Promise<UpdateInfo>,
    onStatus: (listener: (status: UpdateInfo) => void) => {
      const wrapped = (_event: unknown, payload: UpdateInfo) => listener(payload);
      ipcRenderer.on("desktop:update:status-changed", wrapped);
      return () => {
        ipcRenderer.removeListener("desktop:update:status-changed", wrapped);
      };
    },
  },
  fileManager: {
    getStorageOverview: (input: { dataDir: string; cacheDir: string; tasksDir: string; taskIds?: string[] }) =>
      ipcRenderer.invoke("desktop:file-manager:get-storage-overview", input) as Promise<StorageOverview>,
    cleanupOrphans: (input: { cacheDir: string; tasksDir: string; taskIds: string[] }) =>
      ipcRenderer.invoke("desktop:file-manager:cleanup-orphans", input) as Promise<StorageCleanupResult>,
    openDirectory: (kind: StorageLocationKind, input: { dataDir: string; cacheDir: string; tasksDir: string }) =>
      ipcRenderer.invoke("desktop:file-manager:open-directory", kind, input) as Promise<string>,
  },
};

contextBridge.exposeInMainWorld("desktop", desktop);
