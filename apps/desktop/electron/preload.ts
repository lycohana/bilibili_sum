import { contextBridge, ipcRenderer } from "electron";

type CloseBehavior = "ask" | "tray" | "exit";

export type DesktopBackendStatus = {
  running: boolean;
  ready: boolean;
  pid: number | null;
  url: string;
  lastError: string;
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
};

contextBridge.exposeInMainWorld("desktop", desktop);
