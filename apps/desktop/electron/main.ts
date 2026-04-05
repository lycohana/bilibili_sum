import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  shell,
  Tray,
} from "electron";

type CloseBehavior = "ask" | "tray" | "exit";

type DesktopPreferences = {
  closeBehavior: CloseBehavior;
  rememberCloseBehavior: boolean;
  autoLaunch: boolean;
};

type BackendStatus = {
  running: boolean;
  ready: boolean;
  pid: number | null;
  url: string;
  lastError: string;
};

const isDev = !app.isPackaged;
const repoRoot = path.resolve(__dirname, "../../..");
const rendererUrl = process.env.BRIEFVID_RENDERER_URL ?? "http://127.0.0.1:5173";
const backendUrl = "http://127.0.0.1:3838";
const iconPath = isDev
  ? path.resolve(repoRoot, "apps/web/static/favicon.ico")
  : path.join(process.resourcesPath, "icon.ico");
const preferencesPath = path.join(app.getPath("userData"), "desktop-preferences.json");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backendProcess: ChildProcess | null = null;
let forceQuit = false;
let preferences: DesktopPreferences = loadPreferences();
let backendStatus: BackendStatus = {
  running: false,
  ready: false,
  pid: null,
  url: backendUrl,
  lastError: "",
};

function getLocalAppDataDir() {
  return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || app.getPath("home"), "AppData", "Local");
}

function getServiceLogPath() {
  return path.join(getLocalAppDataDir(), "briefvid", "logs", "service.log");
}

const MAX_LOG_CHARS = 20_000;
const MAX_LOG_LINE_CHARS = 1_000;

function trimLogText(content: string) {
  const trimmed = content
    .split(/\r?\n/)
    .map((line) => line.length > MAX_LOG_LINE_CHARS ? `${line.slice(0, MAX_LOG_LINE_CHARS)}... [line truncated]` : line)
    .join("\n");

  if (trimmed.length <= MAX_LOG_CHARS) {
    return trimmed;
  }

  return `... [log truncated, showing last ${MAX_LOG_CHARS} chars]\n${trimmed.slice(-MAX_LOG_CHARS)}`;
}

function readServiceLogTail(lines = 200) {
  const logPath = getServiceLogPath();
  const lineCount = Math.max(20, Math.min(lines, 1000));
  if (!fs.existsSync(logPath)) {
    return { path: logPath, lines: lineCount, content: "" };
  }

  try {
    const content = fs.readFileSync(logPath, "utf-8");
    return {
      path: logPath,
      lines: lineCount,
      content: trimLogText(content.split(/\r?\n/).slice(-lineCount).join("\n")),
    };
  } catch (error) {
    return {
      path: logPath,
      lines: lineCount,
      content: error instanceof Error ? error.message : "读取日志失败",
    };
  }
}

function loadPreferences(): DesktopPreferences {
  try {
    const raw = fs.readFileSync(preferencesPath, "utf-8");
    return {
      closeBehavior: "ask",
      rememberCloseBehavior: false,
      autoLaunch: false,
      ...JSON.parse(raw),
    };
  } catch {
    return {
      closeBehavior: "ask",
      rememberCloseBehavior: false,
      autoLaunch: false,
    };
  }
}

function savePreferences() {
  fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
  fs.writeFileSync(preferencesPath, JSON.stringify(preferences, null, 2), "utf-8");
}

function getPreferences(): DesktopPreferences {
  return { ...preferences };
}

function setCloseBehavior(value: CloseBehavior, remember: boolean) {
  preferences = { ...preferences, closeBehavior: value, rememberCloseBehavior: remember };
  savePreferences();
}

function resetCloseBehavior(): CloseBehavior {
  preferences = { ...preferences, closeBehavior: "ask", rememberCloseBehavior: false };
  savePreferences();
  return "ask";
}

function getStartupHidden(): boolean {
  return process.argv.includes("--hidden");
}

function loadSplash(message = "正在启动 BriefVid 服务...") {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const markup = `
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <title>BriefVid</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background:
              radial-gradient(circle at top right, rgba(251, 114, 153, 0.18), transparent 26%),
              linear-gradient(180deg, #0b1120 0%, #0f172a 100%);
            color: #f8fafc;
            font-family: "Segoe UI", "PingFang SC", sans-serif;
          }
          main {
            width: min(520px, calc(100vw - 48px));
            padding: 32px;
            border-radius: 24px;
            background: rgba(15, 23, 42, 0.82);
            border: 1px solid rgba(255, 255, 255, 0.08);
            box-shadow: 0 24px 48px rgba(2, 6, 23, 0.38);
          }
          h1 {
            margin: 0 0 12px;
            font-size: 28px;
          }
          p {
            margin: 0;
            color: #cbd5e1;
            line-height: 1.7;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>BriefVid</h1>
          <p>${message}</p>
        </main>
      </body>
    </html>
  `;
  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(markup)}`);
}

function sendBackendStatus() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("desktop:backend:status-changed", backendStatus);
}

function updateBackendStatus(patch: Partial<BackendStatus>) {
  backendStatus = { ...backendStatus, ...patch };
  rebuildTrayMenu();
  sendBackendStatus();
}

async function waitForBackendReady(timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${backendUrl}/health`);
      if (response.ok) {
        updateBackendStatus({ ready: true, lastError: "" });
        return true;
      }
    } catch {
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  updateBackendStatus({ ready: false, lastError: "Backend health check timed out." });
  return false;
}

function resolveDevPython(): { command: string; args: string[]; cwd: string } {
  if (process.env.BRIEFVID_DEV_PYTHON) {
    return {
      command: process.env.BRIEFVID_DEV_PYTHON,
      args: ["-m", "video_sum_service"],
      cwd: repoRoot,
    };
  }
  const venvPython = path.resolve(repoRoot, ".venv/Scripts/python.exe");
  if (process.platform === "win32" && fs.existsSync(venvPython)) {
    return { command: venvPython, args: ["-m", "video_sum_service"], cwd: repoRoot };
  }
  return { command: "python", args: ["-m", "video_sum_service"], cwd: repoRoot };
}

function resolvePackagedBackend(): { command: string; args: string[]; cwd: string } {
  const backendRoot = path.join(process.resourcesPath, "backend", "BriefVid");
  return {
    command: path.join(backendRoot, "BriefVid.exe"),
    args: [],
    cwd: backendRoot,
  };
}

async function startBackend(): Promise<BackendStatus> {
  if (backendProcess && !backendProcess.killed) {
    const ready = await waitForBackendReady(15_000);
    return { ...backendStatus, ready };
  }

  const target = isDev ? resolveDevPython() : resolvePackagedBackend();
  backendProcess = spawn(target.command, target.args, {
    cwd: target.cwd,
    env: {
      ...process.env,
      VIDEO_SUM_HOST: "127.0.0.1",
      VIDEO_SUM_PORT: "3838",
    },
    stdio: "ignore",
    detached: false,
    windowsHide: true,
  });

  backendProcess.once("exit", (_code, signal) => {
    backendProcess = null;
    updateBackendStatus({
      running: false,
      ready: false,
      pid: null,
      lastError: signal ? `Backend exited with signal ${signal}.` : "Backend exited.",
    });
    if (!forceQuit && !isDev) {
      loadSplash("BriefVid 服务已停止，正在等待重新启动。");
    }
  });

  updateBackendStatus({
    running: true,
    ready: false,
    pid: backendProcess.pid ?? null,
    lastError: "",
  });

  const ready = await waitForBackendReady();
  if (!ready) {
    loadSplash("后端启动超时，请检查日志后重试。");
  }
  return { ...backendStatus, ready };
}

async function stopBackend(): Promise<BackendStatus> {
  if (!backendProcess) {
    updateBackendStatus({ running: false, ready: false, pid: null });
    return backendStatus;
  }
  const current = backendProcess;
  backendProcess = null;
  current.kill();
  updateBackendStatus({
    running: false,
    ready: false,
    pid: null,
    lastError: "",
  });
  if (!isDev) {
    loadSplash("BriefVid 服务已停止。");
  }
  return backendStatus;
}

async function loadApplication() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (isDev) {
    await mainWindow.loadURL(rendererUrl);
  } else if (backendStatus.ready) {
    await mainWindow.loadURL(backendUrl);
  } else {
    loadSplash();
    return;
  }

  if (!getStartupHidden()) {
    mainWindow.show();
  }
}

function getTrayImage() {
  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? nativeImage.createFromPath(iconPath) : image;
}

function setAutoLaunch(enabled: boolean): boolean {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: ["--hidden"],
  });
  preferences = { ...preferences, autoLaunch: enabled };
  savePreferences();
  rebuildTrayMenu();
  return app.getLoginItemSettings().openAtLogin;
}

function rebuildTrayMenu() {
  if (!tray) {
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: "显示主窗口",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: backendStatus.running ? "停止后端" : "启动后端",
      click: () => {
        void (backendStatus.running ? stopBackend() : startBackend());
      },
    },
    {
      label: "打开日志目录",
      click: () => {
        void shell.openPath(path.dirname(getServiceLogPath()));
      },
    },
    {
      label: "开机自启动",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        setAutoLaunch(Boolean(menuItem.checked));
      },
    },
    { type: "separator" },
    {
      label: "退出应用",
      click: () => {
        forceQuit = true;
        void stopBackend().finally(() => app.quit());
      },
    },
  ];
  tray.setToolTip("BriefVid");
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

async function handleCloseAction(): Promise<"hide" | "exit" | "cancel"> {
  const preferences = getPreferences();
  if (preferences.rememberCloseBehavior) {
    return preferences.closeBehavior === "exit" ? "exit" : "hide";
  }

  const result = await dialog.showMessageBox(mainWindow!, {
    type: "question",
    buttons: ["隐藏到托盘", "直接退出", "取消"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    checkboxLabel: "记住我的选择",
    title: "关闭 BriefVid",
    message: "关闭窗口时，你希望 BriefVid 如何处理？",
    detail: "隐藏到托盘后，后台任务会继续运行；直接退出会关闭桌面端并停止内置后端。",
  });

  if (result.response === 2) {
    return "cancel";
  }

  const behavior: CloseBehavior = result.response === 1 ? "exit" : "tray";
  if (result.checkboxChecked) {
    setCloseBehavior(behavior, true);
  }
  return behavior === "exit" ? "exit" : "hide";
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    title: "BriefVid",
    icon: getTrayImage(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("close", async (event) => {
    if (forceQuit) {
      return;
    }
    event.preventDefault();
    const action = await handleCloseAction();
    if (action === "cancel") {
      return;
    }
    if (action === "hide") {
      mainWindow?.hide();
      return;
    }
    forceQuit = true;
    await stopBackend();
    app.quit();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  loadSplash();
}

function createTray() {
  if (tray) {
    return;
  }
  tray = new Tray(getTrayImage());
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  rebuildTrayMenu();
}

function registerIpcHandlers() {
  ipcMain.handle("desktop:app:get-version", () => app.getVersion());
  ipcMain.handle("desktop:app:get-auto-launch", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("desktop:app:set-auto-launch", (_event, enabled: boolean) => setAutoLaunch(Boolean(enabled)));
  ipcMain.handle("desktop:window:show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  ipcMain.handle("desktop:backend:start", async () => startBackend());
  ipcMain.handle("desktop:backend:stop", async () => stopBackend());
  ipcMain.handle("desktop:backend:status", () => backendStatus);
  ipcMain.handle("desktop:shell:open-path", (_event, targetPath: string) => shell.openPath(targetPath));
  ipcMain.handle("desktop:logs:get-service-log-path", () => getServiceLogPath());
  ipcMain.handle("desktop:logs:read-service-log-tail", (_event, lines = 200) => readServiceLogTail(lines));
  ipcMain.handle("desktop:preferences:get-close-behavior", () => getPreferences().closeBehavior);
  ipcMain.handle("desktop:preferences:set-close-behavior", (_event, value: CloseBehavior) => {
    setCloseBehavior(value, true);
    return value;
  });
  ipcMain.handle("desktop:preferences:reset-close-behavior", () => resetCloseBehavior());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  createWindow();
  createTray();

  if (preferences.autoLaunch && !app.getLoginItemSettings().openAtLogin) {
    setAutoLaunch(true);
  }

  void startBackend().then(() => loadApplication());

  app.on("activate", async () => {
    if (!mainWindow) {
      createWindow();
    }
    await loadApplication();
    mainWindow?.show();
  });
});

app.on("before-quit", () => {
  forceQuit = true;
});

app.on("window-all-closed", () => {
  if (forceQuit) {
    app.quit();
  }
});
