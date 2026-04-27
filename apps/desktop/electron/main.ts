import { ChildProcess, spawn, SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  OpenDialogOptions,
  shell,
  Tray,
} from "electron";
import { autoUpdater, ProgressInfo, UpdateInfo as ElectronUpdateInfo } from "electron-updater";
import desktopPackage from "../package.json";

type CloseBehavior = "ask" | "tray" | "exit";

type DesktopPreferences = {
  closeBehavior: CloseBehavior;
  rememberCloseBehavior: boolean;
  autoLaunch: boolean;
  lastOpenedVersion?: string;
  lastSeenAnnouncementVersion?: string;
};

type BackendStatus = {
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

type StorageOverview = {
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

type StorageOverviewInput = {
  dataDir: string;
  cacheDir: string;
  tasksDir: string;
  taskIds?: string[];
};

type StorageCleanupInput = {
  cacheDir: string;
  tasksDir: string;
  taskIds: string[];
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

const isDev = !app.isPackaged;
const APP_SLUG = "bilisum";
const LEGACY_APP_SLUG = "briefvid";
const LEGACY_PRODUCT_NAME = "BriefVid";
const desktopAppVersion = String(desktopPackage.version || "");
const repoRoot = path.resolve(__dirname, "../../..");
const rendererUrl = process.env.BILISUM_RENDERER_URL ?? process.env.BRIEFVID_RENDERER_URL ?? "http://127.0.0.1:5173";
const backendUrl = "http://127.0.0.1:3838";
const updaterConfigPath = path.join(process.resourcesPath, "app-update.yml");
const iconPath = isDev
  ? path.resolve(repoRoot, "apps/desktop/build/icon.ico")
  : path.join(process.resourcesPath, "icon.ico");
const preferencesPath = path.join(app.getPath("userData"), "desktop-preferences.json");
const legacyUserDataPath = path.join(app.getPath("appData"), LEGACY_PRODUCT_NAME);
const legacyPreferencesPath = path.join(legacyUserDataPath, "desktop-preferences.json");
const preferencesFileExistedAtLaunch = fs.existsSync(preferencesPath) || fs.existsSync(legacyPreferencesPath);

migrateLegacyDesktopFiles();

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
let checkForUpdatesPromise: Promise<UpdateInfo> | null = null;
let downloadUpdatePromise: Promise<UpdateInfo> | null = null;
let downloadedUpdateVersion: string | null = null;
let installRequestedAfterDownload = false;

function getLocalAppDataDir() {
  return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || app.getPath("home"), "AppData", "Local");
}

function currentLocalDataRoot() {
  return path.join(getLocalAppDataDir(), APP_SLUG);
}

function legacyLocalDataRoot() {
  return path.join(getLocalAppDataDir(), LEGACY_APP_SLUG);
}

function copyMissingTree(source: string, destination: string) {
  if (!fs.existsSync(source)) {
    return;
  }
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyMissingTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (stats.isFile() && !fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function migrateLegacyDesktopFiles() {
  try {
    copyMissingTree(legacyUserDataPath, app.getPath("userData"));
    copyMissingTree(legacyPreferencesPath, preferencesPath);
    copyMissingTree(legacyLocalDataRoot(), currentLocalDataRoot());
  } catch (error) {
    console.warn("[Migration] Failed to migrate legacy BriefVid files:", error);
  }
}

function getServiceLogPath() {
  return path.join(currentLocalDataRoot(), "logs", "service.log");
}

function getLogDirPath() {
  return path.dirname(getServiceLogPath());
}

function getRuntimeRootPath() {
  return path.join(currentLocalDataRoot(), "runtime");
}

function getBilibiliCookieExportPath() {
  return path.join(currentLocalDataRoot(), "data", "cookies", "bilibili.txt");
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

function formatCookieForNetscape(cookie: Electron.Cookie) {
  const domain = String(cookie.domain || "").trim();
  const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
  const cookiePath = String(cookie.path || "/").replace(/[\t\r\n]/g, "");
  const secure = cookie.secure ? "TRUE" : "FALSE";
  const expires = Math.max(0, Math.floor(Number(cookie.expirationDate || 0)));
  const name = String(cookie.name || "").replace(/[\t\r\n]/g, "");
  const value = String(cookie.value || "").replace(/[\t\r\n]/g, "");
  return [domain, includeSubdomains, cookiePath, secure, String(expires), name, value].join("\t");
}

async function collectBilibiliCookies(loginWindow: BrowserWindow) {
  const cookieStore = loginWindow.webContents.session.cookies;
  const urls = [
    "https://www.bilibili.com",
    "https://passport.bilibili.com",
    "https://api.bilibili.com",
    "https://space.bilibili.com",
  ];
  const cookieMap = new Map<string, Electron.Cookie>();
  for (const url of urls) {
    const cookies = await cookieStore.get({ url });
    for (const cookie of cookies) {
      if (!String(cookie.domain || "").includes("bilibili.com")) {
        continue;
      }
      cookieMap.set(`${cookie.domain}\t${cookie.path}\t${cookie.name}`, cookie);
    }
  }
  return [...cookieMap.values()];
}

async function exportBilibiliCookies(cookies: Electron.Cookie[]): Promise<BilibiliCookieExportResult> {
  const exportableCookies = cookies.filter((cookie) => cookie.name && cookie.domain && String(cookie.domain).includes("bilibili.com"));
  const cookiesFile = getBilibiliCookieExportPath();
  fs.mkdirSync(path.dirname(cookiesFile), { recursive: true });
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Generated by BiliSum from the in-app Bilibili login window.",
    ...exportableCookies
      .sort((left, right) => `${left.domain}${left.path}${left.name}`.localeCompare(`${right.domain}${right.path}${right.name}`))
      .map(formatCookieForNetscape),
    "",
  ];
  fs.writeFileSync(cookiesFile, lines.join("\n"), "utf-8");
  return { cookiesFile, cookieCount: exportableCookies.length };
}

async function openBilibiliLoginAndCaptureCookies(): Promise<BilibiliCookieExportResult> {
  return new Promise((resolve, reject) => {
    const loginWindow = new BrowserWindow({
      width: 1120,
      height: 760,
      title: "登录 Bilibili - BiliSum",
      parent: mainWindow ?? undefined,
      modal: false,
      show: true,
      webPreferences: {
        partition: "persist:briefvid-bilibili-login",
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const tryCapture = async () => {
      try {
        const cookies = await collectBilibiliCookies(loginWindow);
        const hasLoginCookie = cookies.some((cookie) => cookie.name === "SESSDATA" && cookie.value);
        if (!hasLoginCookie) {
          return;
        }
        const result = await exportBilibiliCookies(cookies);
        settle(() => {
          if (!loginWindow.isDestroyed()) {
            loginWindow.close();
          }
          resolve(result);
        });
      } catch (error) {
        settle(() => reject(error));
      }
    };

    loginWindow.on("closed", () => {
      settle(() => reject(new Error("B 站登录窗口已关闭，尚未捕获到登录态。")));
    });
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      loginWindow.loadURL(url).catch(() => undefined);
      return { action: "deny" };
    });
    loginWindow.webContents.on("did-navigate", () => {
      void tryCapture();
    });
    loginWindow.webContents.on("did-navigate-in-page", () => {
      void tryCapture();
    });

    pollTimer = setInterval(() => {
      void tryCapture();
    }, 1500);

    loginWindow.loadURL("https://passport.bilibili.com/login").catch((error) => {
      settle(() => reject(error));
    });
  });
}

function sanitizeTaskIds(taskIds?: string[]) {
  const valid = new Set<string>();
  for (const taskId of taskIds || []) {
    if (/^[0-9a-f]{32}$/i.test(String(taskId || "").trim())) {
      valid.add(String(taskId).trim().toLowerCase());
    }
  }
  return valid;
}

function resolveManagedPath(targetPath: string) {
  return path.resolve(String(targetPath || ""));
}

function isPathWithin(parentPath: string, candidatePath: string) {
  const relative = path.relative(resolveManagedPath(parentPath), resolveManagedPath(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 异步收集路径统计信息（避免阻塞主进程）
 */
async function collectPathStats(targetPath: string): Promise<{ exists: boolean; sizeBytes: number; fileCount: number; directoryCount: number }> {
  const resolvedTarget = resolveManagedPath(targetPath);
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(resolvedTarget);
  } catch {
    return { exists: false, sizeBytes: 0, fileCount: 0, directoryCount: 0 };
  }

  if (stats.isFile()) {
    return { exists: true, sizeBytes: stats.size, fileCount: 1, directoryCount: 0 };
  }

  let sizeBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;
  const stack = [resolvedTarget];

  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    // 分批处理，避免单次事件循环处理过多文件
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          directoryCount += 1;
          stack.push(entryPath);
          continue;
        }
        if (entry.isFile()) {
          const entryStats = await fs.promises.stat(entryPath);
          sizeBytes += entryStats.size;
          fileCount += 1;
        }
      } catch {
        continue;
      }
    }

    // 每处理一批条目后让出事件循环，避免阻塞 UI
    if (stack.length > 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  return { exists: true, sizeBytes, fileCount, directoryCount };
}

async function buildDirectoryStat(key: StorageLocationKind, label: string, targetPath: string): Promise<StorageDirectoryStat> {
  const stats = await collectPathStats(targetPath);
  return {
    key,
    label,
    path: resolveManagedPath(targetPath),
    exists: stats.exists,
    sizeBytes: stats.sizeBytes,
    fileCount: stats.fileCount,
    directoryCount: stats.directoryCount,
  };
}

function listImmediateEntries(targetPath: string) {
  try {
    return fs.readdirSync(targetPath, { withFileTypes: true }).map((entry) => path.join(targetPath, entry.name));
  } catch {
    return [];
  }
}

/**
 * 获取缓存清理候选项列表
 *
 * 清理策略：
 * 1. uploads 目录：所有文件视为可清理的缓存（用户上传的临时文件）
 * 2. covers 目录：不清理，封面图需要保留
 * 3. 已知任务目录中的 mp3 文件：视为可重新生成的缓存，清理以释放空间
 *
 * @param cacheDir - 缓存目录路径
 * @param tasksDir - 任务目录路径（可选）
 * @param taskIds - 已知任务 ID 列表（用于识别哪些 mp3 属于已知任务）
 * @returns 可清理的文件路径列表
 */
function getCacheCleanupCandidates(cacheDir: string, tasksDir?: string, taskIds?: string[]) {
  const resolvedCacheDir = resolveManagedPath(cacheDir);
  const candidates: string[] = [];
  // 只清理 uploads 目录下的孤儿文件，不清理 covers 目录（封面图需要保留）
  const targetDir = path.join(resolvedCacheDir, "uploads");
  if (fs.existsSync(targetDir) && isPathWithin(resolvedCacheDir, targetDir)) {
    for (const entryPath of listImmediateEntries(targetDir)) {
      if (isPathWithin(targetDir, entryPath)) {
        candidates.push(entryPath);
      }
    }
  }
  // 清理已完成任务的 mp3 文件（保留 jsonl、json 等文本结果）
  // 只清理已知任务（非孤儿）目录中的 mp3 文件
  if (tasksDir && Array.isArray(taskIds)) {
    const resolvedTasksDir = resolveManagedPath(tasksDir);
    if (fs.existsSync(resolvedTasksDir)) {
      try {
        const entries = fs.readdirSync(resolvedTasksDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && /^[0-9a-f]{32}$/i.test(entry.name)) {
            const taskPath = path.join(resolvedTasksDir, entry.name);
            const taskId = entry.name.toLowerCase();
            // 只清理已知任务（非孤儿）目录中的 mp3 文件
            if (isPathWithin(resolvedTasksDir, taskPath) && taskIds.includes(taskId)) {
              // 查找任务目录中的所有 mp3 文件
              try {
                const taskFiles = fs.readdirSync(taskPath);
                for (const file of taskFiles) {
                  if (file.toLowerCase().endsWith(".mp3")) {
                    candidates.push(path.join(taskPath, file));
                  }
                }
              } catch {
                // 忽略无法读取的任务目录
              }
            }
          }
        }
      } catch {
        // 忽略无法读取的任务目录
      }
    }
  }
  return candidates;
}

function getOrphanTaskDirectories(tasksDir: string, taskIds?: string[]) {
  const resolvedTasksDir = resolveManagedPath(tasksDir);
  const knownTaskIds = sanitizeTaskIds(taskIds);
  if (!fs.existsSync(resolvedTasksDir)) {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolvedTasksDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{32}$/i.test(entry.name))
    .map((entry) => path.join(resolvedTasksDir, entry.name))
    .filter((entryPath) => !knownTaskIds.has(path.basename(entryPath).toLowerCase()) && isPathWithin(resolvedTasksDir, entryPath));
}

async function getStorageOverview(input: StorageOverviewInput): Promise<StorageOverview> {
  const dataDir = resolveManagedPath(input.dataDir);
  const cacheDir = resolveManagedPath(input.cacheDir);
  const tasksDir = resolveManagedPath(input.tasksDir);
  const logsDir = resolveManagedPath(getLogDirPath());
  const runtimeDir = resolveManagedPath(getRuntimeRootPath());

  // 并行统计所有目录
  const directories = await Promise.all([
    buildDirectoryStat("data", "数据目录", dataDir),
    buildDirectoryStat("cache", "缓存目录", cacheDir),
    buildDirectoryStat("tasks", "任务结果", tasksDir),
    buildDirectoryStat("logs", "日志目录", logsDir),
    buildDirectoryStat("runtime", "运行时目录", runtimeDir),
  ]);
  const dataStats = directories.find((item) => item.key === "data") || directories[0];
  const logsStats = directories.find((item) => item.key === "logs");
  const runtimeStats = directories.find((item) => item.key === "runtime");
  const orphanTaskDirs = getOrphanTaskDirectories(tasksDir, input.taskIds);
  
  // 异步计算孤儿目录大小
  let orphanTaskBytes = 0;
  for (const entryPath of orphanTaskDirs) {
    const stats = await collectPathStats(entryPath);
    orphanTaskBytes += stats.sizeBytes;
  }
  
  const cacheCandidates = getCacheCleanupCandidates(cacheDir, tasksDir, input.taskIds);
  
  // 异步计算缓存候选项大小
  let cacheCandidateBytes = 0;
  for (const entryPath of cacheCandidates) {
    const stats = await collectPathStats(entryPath);
    cacheCandidateBytes += stats.sizeBytes;
  }

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      managedBytes: dataStats.sizeBytes + (logsStats?.sizeBytes || 0) + (runtimeStats?.sizeBytes || 0),
      managedFiles: dataStats.fileCount + (logsStats?.fileCount || 0) + (runtimeStats?.fileCount || 0),
      managedDirectories: dataStats.directoryCount + (logsStats?.directoryCount || 0) + (runtimeStats?.directoryCount || 0),
    },
    directories,
    cleanup: {
      serviceAvailable: Array.isArray(input.taskIds),
      orphanTaskCount: orphanTaskDirs.length,
      orphanTaskBytes,
      cacheCandidateCount: cacheCandidates.length,
      cacheCandidateBytes,
    },
  };
}

async function removePathIfPresent(targetPath: string): Promise<number> {
  const resolvedTarget = resolveManagedPath(targetPath);
  try {
    const stats = await fs.promises.stat(resolvedTarget);
    const sizeBytes = (await collectPathStats(resolvedTarget)).sizeBytes;
    if (stats.isDirectory()) {
      await fs.promises.rm(resolvedTarget, { recursive: true, force: true });
    } else {
      await fs.promises.rm(resolvedTarget, { force: true });
    }
    return sizeBytes;
  } catch {
    return 0;
  }
}

async function cleanupOrphans(input: StorageCleanupInput): Promise<StorageCleanupResult> {
  const cacheDir = resolveManagedPath(input.cacheDir);
  const tasksDir = resolveManagedPath(input.tasksDir);
  const orphanTaskDirs = getOrphanTaskDirectories(tasksDir, input.taskIds);
  const cacheCandidates = getCacheCleanupCandidates(cacheDir, tasksDir, input.taskIds);
  const deletedPaths: string[] = [];
  let reclaimedBytes = 0;
  let removedTaskDirs = 0;
  let removedCacheEntries = 0;

  // 删除孤儿任务目录
  for (const targetPath of orphanTaskDirs) {
    reclaimedBytes += await removePathIfPresent(targetPath);
    deletedPaths.push(targetPath);
    removedTaskDirs += 1;
  }

  // 删除 uploads 目录中的孤儿文件和任务目录中的 mp3 文件
  for (const targetPath of cacheCandidates) {
    reclaimedBytes += await removePathIfPresent(targetPath);
    deletedPaths.push(targetPath);
    removedCacheEntries += 1;
  }

  return {
    deletedPaths,
    deletedCount: deletedPaths.length,
    removedTaskDirs,
    removedCacheEntries,
    reclaimedBytes,
  };
}

function resolveDirectoryByKind(kind: StorageLocationKind, input: { dataDir: string; cacheDir: string; tasksDir: string }) {
  if (kind === "logs") {
    return getLogDirPath();
  }
  if (kind === "runtime") {
    return getRuntimeRootPath();
  }
  if (kind === "cache") {
    return input.cacheDir;
  }
  if (kind === "tasks") {
    return input.tasksDir;
  }
  return input.dataDir;
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

function getAnnouncementPath() {
  return path.join(app.getAppPath(), "announcement.md");
}

function readStartupAnnouncementContent() {
  try {
    return fs.readFileSync(getAnnouncementPath(), "utf-8").trim();
  } catch {
    return "";
  }
}

function shouldShowStartupAnnouncement() {
  const currentVersion = desktopAppVersion || app.getVersion();
  if (!currentVersion) {
    return false;
  }
  if (preferences.lastSeenAnnouncementVersion === currentVersion) {
    return false;
  }
  if (preferences.lastOpenedVersion && preferences.lastOpenedVersion !== currentVersion) {
    return true;
  }
  return preferencesFileExistedAtLaunch && !preferences.lastOpenedVersion;
}

function getStartupAnnouncement(): StartupAnnouncement | null {
  const content = readStartupAnnouncementContent();
  if (!content || !shouldShowStartupAnnouncement()) {
    return null;
  }
  return {
    version: desktopAppVersion || app.getVersion(),
    title: "更新公告",
    content,
  };
}

function markStartupAnnouncementSeen(version: string) {
  const currentVersion = desktopAppVersion || app.getVersion();
  preferences = {
    ...preferences,
    lastOpenedVersion: currentVersion,
    lastSeenAnnouncementVersion: version || currentVersion,
  };
  savePreferences();
}

function recordOpenedVersionIfNoAnnouncement() {
  if (getStartupAnnouncement()) {
    return;
  }
  const currentVersion = desktopAppVersion || app.getVersion();
  if (preferences.lastOpenedVersion !== currentVersion) {
    preferences = { ...preferences, lastOpenedVersion: currentVersion };
    savePreferences();
  }
}

function getStartupHidden(): boolean {
  return process.argv.includes("--hidden");
}

function getSplashMarkup(message = "正在启动 BiliSum 服务...") {
  return `
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <title>BiliSum</title>
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
            <h1>BiliSum</h1>
            <p id="status-message">${message}</p>
          </main>
        </div>
      </body>
    </html>
  `;
}

function loadSplash(message = "正在启动 BiliSum 服务...") {
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
    updateSplashMessage("BiliSum 服务已停止，正在等待重新启动。");
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
  const devPython = process.env.BILISUM_DEV_PYTHON ?? process.env.BRIEFVID_DEV_PYTHON;
  if (devPython) {
    return {
      command: devPython,
      args: ["-m", "video_sum_service"],
      cwd: repoRoot,
      forceHidden: true,
    };
  }

  if (process.platform === "win32") {
    // 2. 检查 GPU runtime 根目录的 pythonw.exe（portable runtime）
    const runtimeRoot = getRuntimeRootPath();
    const gpuRuntimePythonw = path.join(runtimeRoot, "gpu-cu128", "pythonw.exe");
    if (fs.existsSync(gpuRuntimePythonw)) {
      return { command: gpuRuntimePythonw, args: ["-m", "video_sum_service"], cwd: repoRoot };
    }

    // 3. 兼容旧 runtime：回退到 Scripts 目录的 pythonw.exe
    const legacyGpuRuntimePythonw = path.join(runtimeRoot, "gpu-cu128", "Scripts", "pythonw.exe");
    if (fs.existsSync(legacyGpuRuntimePythonw)) {
      return { command: legacyGpuRuntimePythonw, args: ["-m", "video_sum_service"], cwd: repoRoot };
    }

    // 4. 检查 .venv 的 pythonw.exe
    const venvPythonw = path.resolve(repoRoot, ".venv/Scripts/pythonw.exe");
    if (fs.existsSync(venvPythonw)) {
      return { command: venvPythonw, args: ["-m", "video_sum_service"], cwd: repoRoot };
    }

    // 5. 回退到 GPU runtime 根目录的 python.exe（portable runtime）
    const gpuRuntimePython = path.join(runtimeRoot, "gpu-cu128", "python.exe");
    if (fs.existsSync(gpuRuntimePython)) {
      return { command: gpuRuntimePython, args: ["-m", "video_sum_service"], cwd: repoRoot, forceHidden: true };
    }

    // 6. 兼容旧 runtime：回退到 Scripts 目录的 python.exe
    const legacyGpuRuntimePython = path.join(runtimeRoot, "gpu-cu128", "Scripts", "python.exe");
    if (fs.existsSync(legacyGpuRuntimePython)) {
      return { command: legacyGpuRuntimePython, args: ["-m", "video_sum_service"], cwd: repoRoot, forceHidden: true };
    }

    // 7. 回退到 .venv 的 python.exe
    const venvPython = path.resolve(repoRoot, ".venv/Scripts/python.exe");
    if (fs.existsSync(venvPython)) {
      return { command: venvPython, args: ["-m", "video_sum_service"], cwd: repoRoot, forceHidden: true };
    }
  }

  // 8. 最后回退到系统 python
  return { command: "python", args: ["-m", "video_sum_service"], cwd: repoRoot, forceHidden: true };
}

function getDevPythonPathEntries() {
  return [
    path.resolve(repoRoot, "packages/core/src"),
    path.resolve(repoRoot, "packages/infra/src"),
    path.resolve(repoRoot, "apps/service/src"),
  ];
}

function resolvePackagedBackend(): { command: string; args: string[]; cwd: string } {
  const candidateRoots = [
    path.join(process.resourcesPath, "backend", "BiliSum"),
    path.join(path.dirname(process.execPath), "resources", "backend", "BiliSum"),
    path.join(path.dirname(app.getAppPath()), "backend", "BiliSum"),
  ];

  for (const backendRoot of candidateRoots) {
    const command = path.join(backendRoot, "BiliSum.exe");
    if (fs.existsSync(command) && fs.existsSync(backendRoot)) {
      return {
        command,
        args: [],
        cwd: backendRoot,
      };
    }
  }

  throw new Error(
    [
      "未找到内置后端文件 BiliSum.exe。",
      "请确认安装目录下存在 resources\\backend\\BiliSum\\BiliSum.exe。",
      `当前 resourcesPath: ${process.resourcesPath}`,
    ].join(" "),
  );
}

async function startBackend(): Promise<BackendStatus> {
  if (backendProcess && !backendProcess.killed) {
    const ready = await waitForBackendReady(15_000);
    return { ...backendStatus, ready };
  }

  const existingReady = await waitForBackendReady(1_500);
  if (existingReady) {
    updateBackendStatus({
      running: true,
      ready: true,
      pid: null,
      lastError: "",
    });
    return { ...backendStatus, running: true, ready: true, pid: null, lastError: "" };
  }

  let target: { command: string; args: string[]; cwd: string; forceHidden?: boolean };
  try {
    target = isDev ? resolveDevPython() : resolvePackagedBackend();
  } catch (error) {
    const message = error instanceof Error ? error.message : "后端启动目标解析失败。";
    console.error("[Backend] Failed to resolve backend target:", error);
    updateBackendStatus({
      running: false,
      ready: false,
      pid: null,
      lastError: message,
    });
    if (!isDev) {
      loadSplash(message);
    }
    return backendStatus;
  }

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
      ...(isDev
        ? {
            PYTHONPATH: [
              ...getDevPythonPathEntries(),
              process.env.PYTHONPATH || "",
            ].filter(Boolean).join(path.delimiter),
          }
        : {}),
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

  try {
    backendProcess = spawn(target.command, target.args, spawnOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : "后端进程创建失败。";
    console.error("[Backend] Failed to spawn backend:", error);
    updateBackendStatus({
      running: false,
      ready: false,
      pid: null,
      lastError: message,
    });
    if (!isDev) {
      loadSplash(message);
    }
    return backendStatus;
  }

  backendProcess.once("error", (error) => {
    backendProcess = null;
    const message = error instanceof Error ? error.message : "后端进程启动失败。";
    console.error("[Backend] Child process error:", error);
    updateBackendStatus({
      running: false,
      ready: false,
      pid: null,
      lastError: message,
    });
    if (!forceQuit && !isDev) {
      loadSplash(message);
    }
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
      loadSplash("BiliSum 服务已停止，正在等待重新启动。");
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
    loadSplash("BiliSum 服务已停止。");
  }
  return backendStatus;
}

async function loadApplication() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  await mainWindow.webContents.session.clearCache();
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
  tray.setToolTip("BiliSum");
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
    title: "关闭 BiliSum",
    message: "关闭窗口时，你希望 BiliSum 如何处理？",
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
    title: "BiliSum",
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

  // 拦截页面内导航，外部链接在系统浏览器中打开
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!mainWindow) {
      return;
    }
    const parsedUrl = new URL(url);
    const currentUrl = new URL(mainWindow.webContents.getURL());
    
    // 如果是跨域导航（外链），在系统浏览器中打开
    if (parsedUrl.origin !== currentUrl.origin) {
      event.preventDefault();
      shell.openExternal(url);
    }
    // 同域导航允许正常进行
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

function getUpdateSnapshot(info?: Partial<ElectronUpdateInfo> | null): UpdateInfo {
  return {
    status: updateStatus.status,
    version: info?.version ?? updateStatus.version,
    releaseDate: info?.releaseDate ?? updateStatus.releaseDate,
    releaseNotes: (info?.releaseNotes as string | null | undefined) ?? updateStatus.releaseNotes,
    downloadProgress: updateStatus.downloadProgress,
    errorMessage: updateStatus.errorMessage,
  };
}

function getUpdaterUnavailableMessage() {
  return `当前安装包未包含自动更新配置：${updaterConfigPath}`;
}

function getAutoUpdaterDisabledMessage() {
  return "开发环境不支持桌面自动更新，请使用打包后的安装包进行验证。";
}

function canUseAutoUpdater() {
  return !isDev && fs.existsSync(updaterConfigPath);
}

function initializeUpdater() {
  // 开发环境下完全禁用 autoUpdater，避免读取 app-update.yml 文件
  if (isDev) {
    updateUpdateStatus({ status: "not-available", errorMessage: getAutoUpdaterDisabledMessage() });
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
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;

    // 监听更新事件
    autoUpdater.on("checking-for-update", () => {
      if (updateStatus.status === "downloaded" || updateStatus.status === "installing") {
        return;
      }
      updateUpdateStatus({ status: "checking", errorMessage: null });
    });

    autoUpdater.on("update-available", (info: ElectronUpdateInfo) => {
      pendingUpdateInfo = info;
      const alreadyDownloaded = downloadedUpdateVersion === info.version
        || (updateStatus.status === "downloaded" && updateStatus.version === info.version)
        || (updateStatus.status === "installing" && updateStatus.version === info.version);
      
      // 处理 releaseNotes：electron-updater 可能返回数组或字符串
      let releaseNotes: string | null = null;
      if (info.releaseNotes) {
        if (Array.isArray(info.releaseNotes)) {
          // 如果是数组，提取所有 note 内容并合并
          releaseNotes = info.releaseNotes
            .map((note) => (typeof note === "string" ? note : note.note || ""))
            .filter(Boolean)
            .join("\n\n");
        } else if (typeof info.releaseNotes === "string") {
          releaseNotes = info.releaseNotes;
        } else if (typeof info.releaseNotes === "object" && info.releaseNotes !== null) {
          // 如果是对象，尝试获取 note 属性
          releaseNotes = (info.releaseNotes as { note?: string }).note || null;
        }
      }
      
      updateUpdateStatus({
        ...getUpdateSnapshot(info),
        releaseNotes,
        status: alreadyDownloaded ? updateStatus.status : "available",
        downloadProgress: alreadyDownloaded ? 100 : 0,
        errorMessage: null,
      });
    });

    autoUpdater.on("update-not-available", (info: ElectronUpdateInfo) => {
      if (updateStatus.status === "downloaded" || updateStatus.status === "installing") {
        return;
      }
      // 当已是最新版本时，获取当前版本的更新日志
      let releaseNotes: string | null = null;
      if (info.releaseNotes) {
        if (Array.isArray(info.releaseNotes)) {
          releaseNotes = info.releaseNotes
            .map((note) => (typeof note === "string" ? note : note.note || ""))
            .filter(Boolean)
            .join("\n\n");
        } else if (typeof info.releaseNotes === "string") {
          releaseNotes = info.releaseNotes;
        } else if (typeof info.releaseNotes === "object" && info.releaseNotes !== null) {
          releaseNotes = (info.releaseNotes as { note?: string }).note || null;
        }
      }
      updateUpdateStatus({
        ...getUpdateSnapshot(info),
        status: "not-available",
        releaseNotes,
        errorMessage: null,
      });
    });

    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      updateUpdateStatus({
        status: "downloading",
        downloadProgress: progress.percent,
      });
    });

    autoUpdater.on("update-downloaded", (info: ElectronUpdateInfo) => {
      pendingUpdateInfo = info;
      downloadedUpdateVersion = info.version;
      updateUpdateStatus({
        ...getUpdateSnapshot(info),
        status: "downloaded",
        downloadProgress: 100,
      });
      if (installRequestedAfterDownload) {
        setTimeout(() => installAndRestart(), 250);
      }
    });

    autoUpdater.on("error", (error: Error) => {
      installRequestedAfterDownload = false;
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
  if (isDev) {
    updateUpdateStatus({
      status: "not-available",
      errorMessage: getAutoUpdaterDisabledMessage(),
      releaseNotes: null,
    });
    return Promise.resolve(updateStatus);
  }

  if (!canUseAutoUpdater()) {
    updateUpdateStatus({
      status: "not-available",
      errorMessage: getUpdaterUnavailableMessage(),
      releaseNotes: null,
    });
    return Promise.resolve(updateStatus);
  }

  if (updateStatus.status === "downloading" || updateStatus.status === "downloaded" || updateStatus.status === "installing") {
    return Promise.resolve(updateStatus);
  }

  if (checkForUpdatesPromise) {
    return checkForUpdatesPromise;
  }

  checkForUpdatesPromise = (async () => {
    try {
      await autoUpdater.checkForUpdates();
      return updateStatus;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "检查更新失败";
      updateUpdateStatus({ status: "error", errorMessage });
      return updateStatus;
    } finally {
      checkForUpdatesPromise = null;
    }
  })();

  return checkForUpdatesPromise;
}

function downloadUpdate(): Promise<UpdateInfo> {
  if (isDev) {
    const error = new Error(getAutoUpdaterDisabledMessage());
    updateUpdateStatus({ status: "not-available", errorMessage: error.message });
    return Promise.reject(error);
  }

  if (!canUseAutoUpdater()) {
    const error = new Error(getUpdaterUnavailableMessage());
    updateUpdateStatus({ status: "not-available", errorMessage: error.message });
    return Promise.reject(error);
  }

  if (updateStatus.status === "installing") {
    return Promise.resolve(updateStatus);
  }

  if (updateStatus.status === "downloaded") {
    installRequestedAfterDownload = true;
    installAndRestart();
    return Promise.resolve(updateStatus);
  }

  if (updateStatus.status === "downloading" && downloadUpdatePromise) {
    installRequestedAfterDownload = true;
    return downloadUpdatePromise;
  }

  if (updateStatus.status !== "available") {
    return Promise.reject(new Error("没有可用的更新"));
  }

  installRequestedAfterDownload = true;

  downloadUpdatePromise = (async () => {
    try {
      await autoUpdater.downloadUpdate();
      return updateStatus;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "下载更新失败";
      installRequestedAfterDownload = false;
      updateUpdateStatus({
        status: "error",
        errorMessage,
      });
      throw error;
    } finally {
      downloadUpdatePromise = null;
    }
  })();

  return downloadUpdatePromise;
}

function installAndRestart(): void {
  if (isDev || !canUseAutoUpdater()) {
    return;
  }
  if (updateStatus.status !== "downloaded") {
    console.warn("Cannot install: update not downloaded");
    return;
  }
  installRequestedAfterDownload = false;
  updateUpdateStatus({ status: "installing", errorMessage: null });
  setTimeout(() => {
    autoUpdater.quitAndInstall();
  }, 200);
}

function registerIpcHandlers() {
  ipcMain.handle("desktop:app:get-version", () => desktopAppVersion || app.getVersion());
  ipcMain.handle("desktop:app:get-auto-launch", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("desktop:app:set-auto-launch", (_event, enabled: boolean) => setAutoLaunch(Boolean(enabled)));
  ipcMain.handle("desktop:app:get-startup-announcement", () => getStartupAnnouncement());
  ipcMain.handle("desktop:app:mark-startup-announcement-seen", (_event, version: string) => markStartupAnnouncementSeen(version));
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
  ipcMain.handle("desktop:clipboard:write-image", (_event, dataUrl: string) => {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) {
      throw new Error("图片写入剪贴板失败。");
    }
    clipboard.writeImage(image);
  });
  ipcMain.handle("desktop:media:pick-video-file", async () => {
    const dialogOptions: OpenDialogOptions = {
      title: "选择本地视频",
      properties: ["openFile"],
      filters: [
        {
          name: "视频文件",
          extensions: ["mp4", "mov", "mkv", "avi", "wmv", "webm", "flv", "m4v", "ts", "mpeg", "mpg"],
        },
      ],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("desktop:bilibili:capture-login-cookies", async () => openBilibiliLoginAndCaptureCookies());
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
  ipcMain.handle("desktop:file-manager:get-storage-overview", async (_event, input: StorageOverviewInput) => getStorageOverview(input));
  ipcMain.handle("desktop:file-manager:cleanup-orphans", async (_event, input: StorageCleanupInput) => cleanupOrphans(input));
  ipcMain.handle("desktop:file-manager:open-directory", (_event, kind: StorageLocationKind, input: { dataDir: string; cacheDir: string; tasksDir: string }) => {
    const targetPath = resolveDirectoryByKind(kind, input);
    fs.mkdirSync(targetPath, { recursive: true });
    return shell.openPath(targetPath);
  });
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
  recordOpenedVersionIfNoAnnouncement();
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
