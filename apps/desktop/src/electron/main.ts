import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, shell } from "electron";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startWebServer, type WebServerHandle } from "../web/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");

// 启动诊断日志：写进 %TEMP%\ocarina-startup.log，用来定位「静默退出」
const startupLogPath = path.join(app.getPath("temp"), "ocarina-startup.log");
function logStartup(message: string): void {
  try {
    appendFileSync(startupLogPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // 忽略
  }
}
logStartup("main start");
process.on("uncaughtException", (error) => logStartup(`uncaught: ${String((error as Error)?.stack ?? error)}`));
process.on("unhandledRejection", (reason) => logStartup(`unhandled: ${String(reason)}`));

// 这台机器上 GPU 子进程创建被拦（error_code=18），Electron 会因
// "GPU process isn't usable" 直接退出。下面几条组合起来绕开：
// 关硬件加速、禁 GPU 沙箱、把 GPU 塞进主进程、整体禁用沙箱。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("no-sandbox");
// 深色标题栏（Win11 生效），和界面配色一致
nativeTheme.themeSource = "dark";

let mainWindow: BrowserWindow | null = null;
let webServer: WebServerHandle | null = null;

function getWindowFromSender(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
}

function getStaticRoot(): string {
  return path.resolve(__dirname, "..", "web", "static");
}

function getPreloadPath(): string {
  return path.resolve(__dirname, "preload.js");
}

function getBundledFirmwareRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "firmware", "esp32");
  }

  return path.join(repoRoot, "firmware", "esp32");
}

function getAppIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "icon.png");
  }

  return path.join(repoRoot, "build", "icon.png");
}

function getWindowsDriverRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "drivers", "windows");
  }

  return path.join(repoRoot, "drivers", "windows");
}

function getRecoverySessionsRoot(): string {
  return path.join(app.getPath("documents"), "FriendMaker", "recovery-sessions");
}

function hasWhitespace(value: string): boolean {
  return /\s/u.test(value);
}

function getPlatformIoSafeDataRoot(): string {
  const homeRoot = path.join(app.getPath("home"), ".friend-maker");
  if (!hasWhitespace(homeRoot)) {
    return homeRoot;
  }

  const windowsPublicRoot = process.env.PUBLIC
    ? path.join(process.env.PUBLIC, "FriendMaker")
    : "";
  if (process.platform === "win32" && windowsPublicRoot && !hasWhitespace(windowsPublicRoot)) {
    return windowsPublicRoot;
  }

  return homeRoot;
}

async function hashDirectory(root: string, current = root, files: string[] = []): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".pio") {
      continue;
    }

    const fullPath = path.join(current, entry.name);

    if (entry.isDirectory()) {
      await hashDirectory(root, fullPath, files);
      continue;
    }

    if (entry.isFile()) {
      files.push(path.relative(root, fullPath));
    }
  }

  return files;
}

async function getFirmwareSourceFingerprint(sourceRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const files = (await hashDirectory(sourceRoot)).sort();

  for (const file of files) {
    const fullPath = path.join(sourceRoot, file);
    const info = await stat(fullPath);

    hash.update(file);
    hash.update("\0");
    hash.update(String(info.size));
    hash.update("\0");
    hash.update(await readFile(fullPath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function ensureWritableFirmwareRoot(): Promise<string> {
  const dataRoot = getPlatformIoSafeDataRoot();
  const targetRoot = path.join(dataRoot, "firmware", "esp32");
  const markerPath = path.join(dataRoot, "firmware", ".friend-maker-version");
  const sourceRoot = getBundledFirmwareRoot();
  const expectedMarker = `${app.getVersion()}:${await getFirmwareSourceFingerprint(sourceRoot)}`;
  let marker = "";

  try {
    marker = (await readFile(markerPath, "utf8")).trim();
  } catch {
    marker = "";
  }

  if (marker === expectedMarker && existsSync(path.join(targetRoot, "platformio.ini"))) {
    return targetRoot;
  }

  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(path.dirname(targetRoot), { recursive: true });
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.pio${path.sep}`),
  });
  await writeFile(markerPath, `${expectedMarker}\n`, "utf8");

  return targetRoot;
}

// 检查更新走 Electron 自己的网络栈（Chromium）：它用 Windows 证书库和系统代理，
// 比 Node 自带的 fetch 更容易过掉本地代理 / 加速器造成的证书链问题。
function createUpdateFetcher(): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const request = net.fetch(url, { method: init?.method ?? "GET", headers });
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error("update check timeout"), { name: "TimeoutError" }));
      }, 10_000);
      timer.unref?.();
    });

    return (await Promise.race([request, timeout])) as Response;
  };
}

async function createMainWindow(): Promise<void> {
  const firmwareRoot = await ensureWritableFirmwareRoot();
  const appIcon = getAppIconPath();
  const isMac = process.platform === "darwin";

  if (isMac && existsSync(appIcon)) {
    app.dock?.setIcon(appIcon);
  }

  webServer = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    staticRoot: getStaticRoot(),
    firmwareRoot,
    appVersion: app.getVersion(),
    updateFetcher: createUpdateFetcher(),
    refreshFirmwareRoot: ensureWritableFirmwareRoot,
    appDataRoot: getPlatformIoSafeDataRoot(),
    recoverySessionsRoot: getRecoverySessionsRoot(),
    windowsDriverRoot: getWindowsDriverRoot(),
  });

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 760,
    title: "时之笛 · 乐谱编排器&演奏器",
    // 用原生标题栏：最小化 / 最大化 / 关闭按钮和顶部拖动都由系统提供
    frame: true,
    ...(isMac ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 13, y: 12 } } : {}),
    backgroundColor: "#0f1115",
    roundedCorners: true,
    ...(existsSync(appIcon) ? { icon: appIcon } : {}),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 「关于」页里的项目地址等外链：交给系统浏览器，不要在应用里新开窗口
  const serverUrl = webServer.url;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//iu.test(url)) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(serverUrl)) {
      return;
    }

    event.preventDefault();

    if (/^https?:\/\//iu.test(url)) {
      void shell.openExternal(url);
    }
  });

  logStartup("window created, loading " + webServer.url);
  await mainWindow.loadURL(webServer.url);
  logStartup("window loaded");
}

async function stopWebServer(): Promise<void> {
  const handle = webServer;
  webServer = null;
  await handle?.close().catch(() => undefined);
}

const hasLock = app.requestSingleInstanceLock();

if (!hasLock) {
  app.quit();
} else {
  ipcMain.handle("friend-maker-window:minimize", (event) => {
    getWindowFromSender(event)?.minimize();
  });

  ipcMain.handle("friend-maker-window:toggle-maximize", (event) => {
    const window = getWindowFromSender(event);
    if (!window) {
      return false;
    }

    if (window.isMaximized()) {
      window.unmaximize();
      return false;
    }

    window.maximize();
    return true;
  });

  ipcMain.handle("friend-maker-window:close", (event) => {
    getWindowFromSender(event)?.close();
  });

  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.focus();
  });

  app.on("before-quit", () => {
    void stopWebServer();
  });

  app.whenReady()
    .then(createMainWindow)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack ?? "" : "";
      logStartup(`startup failed: ${message}\n${stack}`);
      void dialog.showMessageBox({
        type: "error",
        title: "时之笛启动失败",
        message,
      });
      app.quit();
    });

  app.on("window-all-closed", () => {
    // 关窗口时必须能退出：串口关闭偶发卡死会连累 stopWebServer，
    // 这里最多等 2 秒就强退，避免进程赖着不走、一直占着 COM 口。
    const forcedQuit = new Promise<void>((resolve) => setTimeout(resolve, 2000));
    void Promise.race([stopWebServer().catch(() => undefined), forcedQuit]).finally(() => {
      if (process.platform !== "darwin") {
        app.quit();
      }
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
}
