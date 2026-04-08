type CloseBehavior = "ask" | "tray" | "exit";

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

type DesktopBridge = {
  app: {
    getVersion(): Promise<string>;
    getAutoLaunch(): Promise<boolean>;
    setAutoLaunch(enabled: boolean): Promise<boolean>;
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
  shell: {
    openPath(targetPath: string): Promise<string>;
  };
  logs: {
    getServiceLogPath(): Promise<string>;
    readServiceLogTail(lines?: number): Promise<{ path: string; lines: number; content: string }>;
  };
  preferences: {
    getCloseBehavior(): Promise<CloseBehavior>;
    setCloseBehavior(value: CloseBehavior): Promise<CloseBehavior>;
    resetCloseBehavior(): Promise<CloseBehavior>;
  };
  update: {
    check(): Promise<UpdateInfo>;
    download(): Promise<UpdateInfo>;
    install(): Promise<void>;
    getStatus(): Promise<UpdateInfo>;
    onStatus(listener: (status: UpdateInfo) => void): () => void;
  };
};

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export {};
