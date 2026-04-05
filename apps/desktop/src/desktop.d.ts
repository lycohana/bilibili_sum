type CloseBehavior = "ask" | "tray" | "exit";

type DesktopBackendStatus = {
  running: boolean;
  ready: boolean;
  pid: number | null;
  url: string;
  lastError: string;
};

type DesktopBridge = {
  app: {
    getVersion(): Promise<string>;
    getAutoLaunch(): Promise<boolean>;
    setAutoLaunch(enabled: boolean): Promise<boolean>;
  };
  window: {
    show(): Promise<void>;
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
};

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export {};
