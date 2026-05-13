type CloseBehavior = "ask" | "tray" | "exit";
type ThemePreference = "light" | "dark";

type DesktopBackendStatus = {
  running: boolean;
  ready: boolean;
  pid: number | null;
  url: string;
  lastError: string;
};

type UpdateStatus = "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "installing" | "error";

type UpdateInfo = {
  status: UpdateStatus;
  version: string;
  releaseDate: string;
  releaseNotes: string | null;
  downloadProgress: number;
  errorMessage: string | null;
};

type StartupAnnouncement = {
  version: string;
  title: string;
  content: string;
};

type StorageLocationKind = "data" | "cache" | "tasks" | "logs" | "runtime";

type StorageDirectoryStat = {
  key: StorageLocationKind;
  label: string;
  path: string;
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
};

type StorageCleanupSummary = {
  serviceAvailable: boolean;
  orphanTaskCount: number;
  orphanTaskBytes: number;
  cacheCandidateCount: number;
  cacheCandidateBytes: number;
};

type StorageOverview = {
  generatedAt: string;
  totals: {
    managedBytes: number;
    managedFiles: number;
    managedDirectories: number;
  };
  directories: StorageDirectoryStat[];
  cleanup: StorageCleanupSummary;
};

type StorageCleanupResult = {
  deletedPaths: string[];
  deletedCount: number;
  removedTaskDirs: number;
  removedCacheEntries: number;
  reclaimedBytes: number;
};

type BilibiliCookieExportResult = {
  cookiesFile: string;
  cookieCount: number;
};

type DesktopBridge = {
  app: {
    getVersion(): Promise<string>;
    getAutoLaunch(): Promise<boolean>;
    setAutoLaunch(enabled: boolean): Promise<boolean>;
    getStartupAnnouncement(): Promise<StartupAnnouncement | null>;
    markStartupAnnouncementSeen(version: string): Promise<void>;
  };
  window: {
    show(): Promise<void>;
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
  backend: {
    start(): Promise<DesktopBackendStatus>;
    stop(): Promise<DesktopBackendStatus>;
    status(): Promise<DesktopBackendStatus>;
    onStatus(listener: (status: DesktopBackendStatus) => void): () => void;
  };
  clipboard: {
    writeImage(dataUrl: string): Promise<void>;
  };
  media: {
    pickVideoFile(): Promise<string | null>;
  };
  bilibili: {
    captureLoginCookies(): Promise<BilibiliCookieExportResult>;
  };
  shell: {
    openPath(targetPath: string): Promise<string>;
  };
  dialog: {
    pickDirectory(defaultPath?: string): Promise<string | null>;
  };
  logs: {
    getServiceLogPath(): Promise<string>;
    readServiceLogTail(lines?: number): Promise<{ path: string; lines: number; content: string }>;
  };
  preferences: {
    getCloseBehavior(): Promise<CloseBehavior>;
    setCloseBehavior(value: CloseBehavior): Promise<CloseBehavior>;
    resetCloseBehavior(): Promise<CloseBehavior>;
    setTheme(value: ThemePreference): Promise<ThemePreference>;
  };
  update: {
    check(): Promise<UpdateInfo>;
    download(): Promise<UpdateInfo>;
    install(): Promise<void>;
    getStatus(): Promise<UpdateInfo>;
    onStatus(listener: (status: UpdateInfo) => void): () => void;
  };
  fileManager: {
    getStorageOverview(input: { taskIds?: string[] }): Promise<StorageOverview>;
    cleanupOrphans(input: { taskIds: string[] }): Promise<StorageCleanupResult>;
    openDirectory(kind: StorageLocationKind): Promise<string>;
  };
};

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export {};
