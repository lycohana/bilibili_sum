import { ChildProcess, spawn, SpawnOptions } from "node:child_process";
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
import { autoUpdater, ProgressInfo, UpdateInfo as ElectronUpdateInfo } from "electron-updater";

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

type UpdateStatus = "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";

type UpdateInfo = {
  status: UpdateStatus;
  version: string;
  releaseDate: string;
  releaseNotes: string | null;
  downloadProgress: number;
  errorMessage: string | null;
};

const isDev = !app.isPackaged;
const repoRoot = path.resolve(__dirname, "../../..");
const rendererUrl = process.env.BRIEFVID_RENDERER_URL ?? "http://127.0.0.1:5173";
const backendUrl = "http://127.0.0.1:3838";
const updaterConfigPath = path.join(process.resourcesPath, "app-update.yml");
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

// 更新管理器状态
let updateStatus: UpdateInfo = {
  status: "idle",
  version: "",
  releaseDate: "",
  releaseNotes: null,
  downloadProgress: 0,
  errorMessage: null,
};
let pendingUpdateInfo: ElectronUpdateInfo | null = null;

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

function getSplashMarkup(message = "正在启动 BriefVid 服务...") {
  return `
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
          .splash-container {
            position: relative;
            width: min(520px, calc(100vw - 48px));
          }
          .close-button {
            position: absolute;
            top: 12px;
            right: 12px;
            width: 32px;
            height: 32px;
            border: none;
            background: rgba(255, 255, 255, 0.1);
            color: #94a3b8;
            border-radius: 8px;
            cursor: pointer;
            display: grid;
            place-items: center;
            transition: background-color 0.15s ease, color 0.15s ease;
          }
          .close-button:hover {
            background: rgba(239, 68, 68, 0.2);
            color: #ef4444;
          }
          main {
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
          #status-message {
            transition: opacity 0.2s ease;
          }
          .fade-out {
            opacity: 0;
          }
        </style>
      </head>
      <body>
        <div class="splash-container">
          <button class="close-button" onclick="window.close()" aria-label="关闭">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
          <main>
            <h1>BriefVid</h1>
            <p id="status-message">${message}</p>
          </main>
        </div>
      </body>
    </html>
  `;
}

function loadSplash(message = "正在启动 BriefVid 服务...") {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getSplashMarkup(message))}`);
  
  // 注入 IPC 监听脚本
  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      return;
    }
    const script = `
      (function() {
        var messageElement = document.getElementById('status-message');
        window.updateStatusMessage = function(msg) {
          if (messageElement) {
            messageElement.classList.add('fade-out');
            setTimeout(function() {
              messageElement.textContent = msg;
              messageElement.classList.remove('fade-out');
            }, 200);
          }
        };
      })();
    `;
    mainWindow.webContents.executeJavaScript(script);
  });
}

function updateSplashMessage(message: string) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  // 转义消息中的特殊字符
  const escapedMessage = message.replace(/'/g, "\\'").replace(/"/g, '\\"');
  void mainWindow.webContents.executeJavaScript(`window.updateStatusMessage('${escapedMessage}')`);
}

function sendBackendStatus() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("desktop:backend:status-changed", backendStatus);
}

function updateBackendStatus(patch: Partial<BackendStatus>) {
  const previousReady = backendStatus.ready;
  backendStatus = { ...backendStatus, ...patch };
  rebuildTrayMenu();
  sendBackendStatus();
  
  // 更新启动画面消息
  if (!previousReady && backendStatus.ready) {
    updateSplashMessage("后端已就绪，正在加载应用...");
    setTimeout(() => loadApplication(), 300);
  } else if (!backendStatus.running && backendStatus.lastError) {
    updateSplashMessage(backendStatus.lastError);
  } else if (!backendStatus.running && !backendStatus.ready) {
    updateSplashMessage("BriefVid 服务已停止，正在等待重新启动。");
  }
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

function resolveDevPython(): { command: string; args: string[]; cwd: string; forceHidden?: boolean } {
  // 1. 优先使用环境变量指定的 Python
  if (process.env.BRIEFVID_DEV_PYTHON) {
    return {
      command: process.env.BRIEFVID_DEV_PYTHON,
      args: ["-m", "video_sum_service"],
      cwd: repoRoot,
      forceHidden: true,
    };
  }

  if (process.platform === "win32") {
    // 2. 检查 GPU runtime 的 pythonw.exe（优先使用 GPU 版本）
    const localAppData = getLocalAppDataDir();
    const gpuRuntimePythonw = path.join(localAppData, "briefvid", "runtime", "gpu-cu128", "Scripts", "pythonw.exe");
    if (fs.existsSync(gpuRuntimePythonw)) {
      return { command: gpuRuntimePythonw, args: ["-m", "video_sum_service"], cwd: repoRoot };
    }

    // 3. 检查 .venv 的 pythonw.exe
    const venvPythonw = path.resolve(repoRoot, ".venv/Scripts/pythonw.exe");
    if (fs.existsSync(venvPythonw)) {
      return { command: venvPythonw, args: ["-m", "video_sum_service"], cwd: repoRoot };
    }

    // 4. 回退到 GPU runtime 的 python.exe
    const gpuRuntimePython = path.join(localAppData, "briefvid", "runtime", "gpu-cu128", "Scripts", "python.exe");
    if (fs.existsSync(gpuRuntimePython)) {
      return { command: gpuRuntimePython, args: ["-m", "video_sum_service"], cwd: repoRoot, forceHidden: true };
    }

    // 5. 回退到 .venv 的 python.exe
    const venvPython = path.resolve(repoRoot, ".venv/Scripts/python.exe");
    if (fs.existsSync(venvPython)) {
      return { command: venvPython, args: ["-m", "video_sum_service"], cwd: repoRoot, forceHidden: true };
    }
  }

  // 6. 最后回退到系统 python
  return { command: "python", args: ["-m", "video_sum_service"], cwd: repoRoot, forceHidden: true };
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

  console.log("[Backend] Starting backend with:", {
    command: target.command,
    args: target.args,
    cwd: target.cwd,
    isDev,
  });

  // Windows 上隐藏控制台窗口
  const spawnOptions: SpawnOptions = {
    cwd: target.cwd,
    env: {
      ...process.env,
      VIDEO_SUM_HOST: "127.0.0.1",
      VIDEO_SUM_PORT: "3838",
    },
    stdio: ["ignore", "ignore", "ignore"],  // 完全忽略子进程的 stdio，避免窗口弹出和管道阻塞
    detached: false,
    windowsHide: true,
    shell: false,
  };

  // 在 Windows 上，使用 CREATE_NO_WINDOW 标志隐藏控制台窗口
  // CREATE_NO_WINDOW = 0x08000000
  if (process.platform === "win32") {
    const CREATE_NO_WINDOW = 0x08000000;
    (spawnOptions as any).windowsVerbatimArguments = true;
    (spawnOptions as any).creationFlags = CREATE_NO_WINDOW;
    console.log("[Backend] Windows: setting creationFlags = CREATE_NO_WINDOW (0x08000000)");
  }

  backendProcess = spawn(target.command, target.args, spawnOptions);

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
    frame: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 禁用鼠标中键导航（防止打开新窗口），但允许外部链接通过 shell.openExternal 打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 尝试使用 shell.openExternal 打开外部 URL
    shell.openExternal(url);
    // 阻止在 Electron 中创建新窗口
    return { action: "deny" };
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

// 更新管理器函数
function sendUpdateStatus() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("desktop:update:status-changed", updateStatus);
}

function updateUpdateStatus(patch: Partial<UpdateInfo>) {
  updateStatus = { ...updateStatus, ...patch };
  sendUpdateStatus();
}

function getUpdaterUnavailableMessage() {
  return `当前安装包未包含自动更新配置：${updaterConfigPath}`;
}

function canUseAutoUpdater() {
  return !isDev && fs.existsSync(updaterConfigPath);
}

function initializeUpdater() {
  // 开发环境下完全禁用 autoUpdater，避免读取 app-update.yml 文件
  if (isDev) {
    updateUpdateStatus({ status: "not-available", errorMessage: null });
    return;
  }

  if (!canUseAutoUpdater()) {
    updateUpdateStatus({
      status: "not-available",
      errorMessage: getUpdaterUnavailableMessage(),
    });
    return;
  }

  try {
    // 配置 autoUpdater
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = true;
    autoUpdater.allowPrerelease = false;

    // 监听更新事件
    autoUpdater.on("checking-for-update", () => {
      updateUpdateStatus({ status: "checking" });
    });

    autoUpdater.on("update-available", (info: ElectronUpdateInfo) => {
      pendingUpdateInfo = info;
      updateUpdateStatus({
        status: "available",
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes as string | null,
        errorMessage: null,
      });
    });

    autoUpdater.on("update-not-available", () => {
      updateUpdateStatus({ status: "not-available" });
    });

    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      updateUpdateStatus({
        status: "downloading",
        downloadProgress: progress.percent,
      });
    });

    autoUpdater.on("update-downloaded", (info: ElectronUpdateInfo) => {
      pendingUpdateInfo = info;
      updateUpdateStatus({
        status: "downloaded",
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes as string | null,
        downloadProgress: 100,
      });
    });

    autoUpdater.on("error", (error: Error) => {
      updateUpdateStatus({
        status: "error",
        errorMessage: error.message,
      });
    });

    // 启动时静默检查更新（延迟 5 秒）
    setTimeout(() => {
      if (!updateStatus.status || updateStatus.status === "idle") {
        checkForUpdates();
      }
    }, 5000);
  } catch (error) {
    // 如果初始化失败（例如缺少 app-update.yml），禁用更新功能
    console.error("Failed to initialize autoUpdater:", error);
    updateStatus.status = "error";
    updateStatus.errorMessage = error instanceof Error ? error.message : "更新系统初始化失败";
  }
}

function checkForUpdates(): Promise<UpdateInfo> {
  return new Promise((resolve) => {
    if (isDev) {
      // 开发环境下模拟检查更新
      updateUpdateStatus({ status: "not-available", errorMessage: null });
      resolve(updateStatus);
      return;
    }

    if (!canUseAutoUpdater()) {
      updateUpdateStatus({
        status: "not-available",
        errorMessage: getUpdaterUnavailableMessage(),
      });
      resolve(updateStatus);
      return;
    }

    const check = async () => {
      try {
        await autoUpdater.checkForUpdates();
        resolve(updateStatus);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "检查更新失败";
        updateUpdateStatus({ status: "error", errorMessage });
        resolve(updateStatus);
      }
    };
    check();
  });
}

function downloadUpdate(): Promise<UpdateInfo> {
  return new Promise((resolve, reject) => {
    if (isDev) {
      updateUpdateStatus({ status: "downloaded", version: "dev-build" });
      resolve(updateStatus);
      return;
    }

    if (!canUseAutoUpdater()) {
      const error = new Error(getUpdaterUnavailableMessage());
      updateUpdateStatus({ status: "not-available", errorMessage: error.message });
      reject(error);
      return;
    }

    if (updateStatus.status !== "available") {
      reject(new Error("没有可用的更新"));
      return;
    }

    autoUpdater.downloadUpdate().catch((error: Error) => {
      updateUpdateStatus({
        status: "error",
        errorMessage: error.message || "下载更新失败",
      });
      reject(error);
    });
  });
}

function installAndRestart(): void {
  if (isDev || !canUseAutoUpdater()) {
    return;
  }
  if (updateStatus.status !== "downloaded") {
    console.warn("Cannot install: update not downloaded");
    return;
  }
  autoUpdater.quitAndInstall();
}

function registerIpcHandlers() {
  ipcMain.handle("desktop:app:get-version", () => app.getVersion());
  ipcMain.handle("desktop:app:get-auto-launch", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("desktop:app:set-auto-launch", (_event, enabled: boolean) => setAutoLaunch(Boolean(enabled)));
  ipcMain.handle("desktop:window:show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  ipcMain.handle("desktop:window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("desktop:window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle("desktop:window:close", () => mainWindow?.close());
  ipcMain.handle("desktop:window:isMaximized", () => mainWindow?.isMaximized() ?? false);
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
  
  // 更新相关 IPC
  ipcMain.handle("desktop:update:check", async () => checkForUpdates());
  ipcMain.handle("desktop:update:download", async () => downloadUpdate());
  ipcMain.handle("desktop:update:install", () => installAndRestart());
  ipcMain.handle("desktop:update:get-status", () => updateStatus);
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
  initializeUpdater();
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
  // 清理 autoUpdater 监听器，防止在应用退出后仍触发
  autoUpdater.removeAllListeners();
});

app.on("window-all-closed", () => {
  if (forceQuit) {
    app.quit();
  }
});
