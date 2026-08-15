const path = require('path');
const fs = require('fs');

const earlyLogDirectory = path.join(process.env.APPDATA || process.cwd(), 'Elvador');
const earlyLogFilePath = path.join(earlyLogDirectory, 'desktop.log');
const startupStatePath = path.join(earlyLogDirectory, 'desktop-startup-state.json');
const STARTUP_AUTO_SAFE_MODE_WINDOW_MS = 10 * 60 * 1000;

function readEarlyStartupState() {
  try {
    return JSON.parse(fs.readFileSync(startupStatePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeEarlyStartupState(nextState = {}) {
  try {
    fs.mkdirSync(path.dirname(startupStatePath), { recursive: true });
    fs.writeFileSync(startupStatePath, JSON.stringify(nextState, null, 2), 'utf8');
  } catch (_) {
    // Startup recovery state must never break app startup.
  }
}

function isRecentStartingState(state) {
  if (!state || state.status !== 'starting' || !state.startedAt) {
    return false;
  }

  const startedAt = Date.parse(state.startedAt);
  return Number.isFinite(startedAt) && Date.now() - startedAt < STARTUP_AUTO_SAFE_MODE_WINDOW_MS;
}

const previousStartupState = readEarlyStartupState();
const GPU_SAFE_MODE_REQUESTED =
  process.argv.includes('--elvador-gpu-safe-mode') ||
  process.env.ELVADOR_GPU_SAFE_MODE === 'true';
const GPU_SAFE_MODE_PERSISTED =
  previousStartupState?.persistGpuSafeMode === true;
const GPU_SAFE_MODE_AUTO_FALLBACK =
  !GPU_SAFE_MODE_REQUESTED &&
  !GPU_SAFE_MODE_PERSISTED &&
  previousStartupState?.gpuSafeModeEnabled !== true &&
  isRecentStartingState(previousStartupState);
const GPU_SAFE_MODE_ENABLED =
  GPU_SAFE_MODE_REQUESTED ||
  GPU_SAFE_MODE_PERSISTED ||
  GPU_SAFE_MODE_AUTO_FALLBACK;

writeEarlyStartupState({
  status: 'starting',
  startedAt: new Date().toISOString(),
  pid: process.pid,
  execPath: process.execPath,
  launchFlags: process.argv.slice(1).filter((arg) => String(arg || '').startsWith('--')),
  gpuSafeModeEnabled: GPU_SAFE_MODE_ENABLED,
  gpuSafeModeRequested: GPU_SAFE_MODE_REQUESTED,
  gpuSafeModePersisted: GPU_SAFE_MODE_PERSISTED,
  gpuSafeModeAutoFallback: GPU_SAFE_MODE_AUTO_FALLBACK,
  persistGpuSafeMode: GPU_SAFE_MODE_PERSISTED,
  previousStatus: previousStartupState?.status || null,
  previousStartedAt: previousStartupState?.startedAt || null,
  previousUpdatedAt: previousStartupState?.updatedAt || null
});

const { app: earlyApp } = require('electron');
// The desktop shell only hosts the web panel and native overlays. Keeping GPU
// acceleration disabled prevents virtualized and legacy Windows GPUs from
// creating a Chromium shared context during startup.
earlyApp.disableHardwareAcceleration();
earlyApp.commandLine.appendSwitch('disable-gpu');
earlyApp.commandLine.appendSwitch('disable-gpu-compositing');
earlyApp.commandLine.appendSwitch('disable-gpu-sandbox');
earlyApp.commandLine.appendSwitch('disable-software-rasterizer');
earlyApp.commandLine.appendSwitch('use-gl', 'swiftshader');
earlyApp.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function writeEarlyDesktopLog(message, details = null) {
  try {
    fs.mkdirSync(earlyLogDirectory, { recursive: true });
    const detailText = details
      ? ` ${typeof details === 'string' ? details : JSON.stringify(details)}`
      : '';
    fs.appendFileSync(earlyLogFilePath, `[${new Date().toISOString()}] ${message}${detailText}\n`);
  } catch (_) {
    // Logging must never break app startup.
  }
}

writeEarlyDesktopLog('main file entered', {
  argv: process.argv,
  execPath: process.execPath,
  cwd: process.cwd(),
  gpuSafeModeEnabled: GPU_SAFE_MODE_ENABLED,
  gpuSafeModeRequested: GPU_SAFE_MODE_REQUESTED,
  gpuSafeModePersisted: GPU_SAFE_MODE_PERSISTED,
  gpuSafeModeAutoFallback: GPU_SAFE_MODE_AUTO_FALLBACK,
  previousStartupStatus: previousStartupState?.status || null
});

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell
} = require('electron');
const { autoUpdater } = require('electron-updater');
const { getDesktopConfig } = require('./config');
const { createNativeNotificationService } = require('./nativeNotifications');
const { createNativeNotificationSoundService } = require('./nativeNotificationSound');
const { createDesktopPendingPoller } = require('./desktopPendingPoller');
const { createWebDeployMonitor } = require('./webDeployMonitor');

if (!app.isPackaged) {
  process.env.ELVADOR_ADMIN_URL = process.env.ELVADOR_ADMIN_URL || 'http://127.0.0.1:3000/admin';
  process.env.ELVADOR_API_BASE_URL = process.env.ELVADOR_API_BASE_URL || 'http://127.0.0.1:5002';
}

const config = getDesktopConfig();
const gotSingleInstanceLock = app.requestSingleInstanceLock();
const logDirectory = earlyLogDirectory;
const logFilePath = earlyLogFilePath;
const DESKTOP_ONBOARDING_URL = 'elvador-desktop://onboarding';
const AUTO_UPDATE_CHECK_INTERVAL_MS = 60 * 1000;

let mainWindow = null;
let tray = null;
let notificationService = null;
let notificationSoundService = null;
let pendingPoller = null;
let webDeployMonitor = null;
let isQuitting = false;
let webDeployReloadInProgress = false;
let lastLoadError = null;
let lastLoadedUrl = config.adminUrl;
let lastNotificationState = { activeCount: 0, activeIds: [] };
let desktopSettings = {};
let developerShortcutState = {};
let lastDevToolsRequestAt = null;
let startupStableTimer = null;
let developmentSourceWatcher = null;
let developmentReloadTimer = null;
let updatePromptState = {
  open: false,
  promptedVersion: null,
  dismissedVersion: null
};

function writeDesktopLog(message, details = null) {
  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    const detailText = details
      ? ` ${typeof details === 'string' ? details : JSON.stringify(details)}`
      : '';
    fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] ${message}${detailText}\n`);
  } catch (_) {
    // Logging must never break app startup.
  }
}

function startDevelopmentSourceWatcher() {
  if (app.isPackaged || developmentSourceWatcher) {
    return;
  }

  try {
    const sourceDirectory = path.join(__dirname);
    developmentSourceWatcher = fs.watch(sourceDirectory, { recursive: true }, (_eventType, filename) => {
      if (!filename || isQuitting) {
        return;
      }

      clearTimeout(developmentReloadTimer);
      developmentReloadTimer = setTimeout(() => {
        if (isQuitting) {
          return;
        }

        writeDesktopLog('development source changed, restarting', { filename });
        app.relaunch();
        app.exit(0);
      }, 300);
    });
    writeDesktopLog('development source watcher started', { sourceDirectory });
  } catch (error) {
    writeDesktopLog('development source watcher failed', { message: error?.message });
  }
}
function emitWebDeployBrowserLog(event, details = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const payload = {
    event,
    at: new Date().toISOString(),
    ...details
  };
  const script = `(function () {
    try {
      const entry = ${JSON.stringify(payload)};
      const previous = Array.isArray(window.__elvadorWebDeployDiagnostics)
        ? window.__elvadorWebDeployDiagnostics
        : [];
      previous.push(entry);
      window.__elvadorWebDeployDiagnostics = previous.slice(-40);
      console.info('[WEB_DEPLOY]', entry);
    } catch (_) {}
  })();`;

  mainWindow.webContents.executeJavaScript(script).catch(() => {});
}

async function reloadPanelForWebDeploy({ previousBuildId, buildId, generatedAt, endpointUrl }) {
  if (!mainWindow || mainWindow.isDestroyed() || !isWindowOnSameOrigin()) {
    const result = {
      reloaded: true,
      skipped: true,
      reason: 'panel_not_loaded'
    };
    writeDesktopLog('web_deploy_reload_skipped', {
      ...result,
      previousBuildId,
      buildId,
      endpointUrl
    });
    return result;
  }

  if (webDeployReloadInProgress) {
    return {
      reloaded: false,
      reason: 'reload_already_in_progress'
    };
  }

  const webContents = mainWindow.webContents;
  const reloadTrace = {
    event: 'reload_requested',
    at: new Date().toISOString(),
    previousBuildId,
    buildId,
    generatedAt: generatedAt || null,
    endpointUrl,
    url: webContents.getURL()
  };
  const setReloadTraceScript = `(function () {
    try {
      const trace = ${JSON.stringify(reloadTrace)};
      sessionStorage.setItem('__elvadorDesktopWebDeployReload', JSON.stringify(trace));
      console.info('[WEB_DEPLOY]', trace);
    } catch (_) {}
  })();`;

  webDeployReloadInProgress = true;
  writeDesktopLog('web_deploy_reload_requested', reloadTrace);
  emitWebDeployBrowserLog('reload_requested', reloadTrace);

  try {
    await webContents.executeJavaScript(setReloadTraceScript);
  } catch (error) {
    writeDesktopLog('web_deploy_reload_trace_write_failed', {
      message: error?.message || String(error),
      buildId
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;

    const finish = (reloaded, reason, extra = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      webDeployReloadInProgress = false;
      if (timeout) {
        clearTimeout(timeout);
      }
      webContents.removeListener('did-finish-load', onFinishLoad);
      webContents.removeListener('did-fail-load', onFailLoad);

      const result = {
        reloaded,
        reason,
        ...extra
      };
      writeDesktopLog('web_deploy_reload_finished', {
        ...result,
        previousBuildId,
        buildId,
        url: webContents.getURL()
      });
      emitWebDeployBrowserLog('reload_finished', {
        ...result,
        previousBuildId,
        buildId
      });
      resolve(result);
    };

    const onFinishLoad = () => {
      finish(true, 'did_finish_load');
    };
    const onFailLoad = (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        finish(false, 'did_fail_load', {
          errorCode,
          errorDescription,
          validatedUrl
        });
      }
    };

    webContents.once('did-finish-load', onFinishLoad);
    webContents.on('did-fail-load', onFailLoad);
    timeout = setTimeout(() => {
      finish(false, 'reload_timeout');
    }, 30000);

    try {
      webContents.reloadIgnoringCache();
    } catch (error) {
      finish(false, 'reload_throw', {
        message: error?.message || String(error)
      });
    }
  });
}

function markStartupState(status, details = {}) {
  writeEarlyStartupState({
    status,
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    version: app?.isReady?.() ? app.getVersion() : undefined,
    gpuSafeModeEnabled: GPU_SAFE_MODE_ENABLED,
    gpuSafeModeRequested: GPU_SAFE_MODE_REQUESTED,
    gpuSafeModePersisted: GPU_SAFE_MODE_PERSISTED,
    gpuSafeModeAutoFallback: GPU_SAFE_MODE_AUTO_FALLBACK,
    persistGpuSafeMode: GPU_SAFE_MODE_PERSISTED || GPU_SAFE_MODE_AUTO_FALLBACK,
    ...details
  });
}

function redactUrlToken(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  return text.replace(/(\/admin-access\/)([A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/i, '$1$2...');
}

function getCurrentMainWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return {
      exists: false
    };
  }

  const bounds = mainWindow.getBounds();
  const webContents = mainWindow.webContents;
  return {
    exists: true,
    visible: mainWindow.isVisible(),
    minimized: mainWindow.isMinimized(),
    focused: mainWindow.isFocused(),
    bounds,
    url: webContents.getURL(),
    devToolsOpened: webContents.isDevToolsOpened(),
    devToolsWindow: getDevToolsWindowState(webContents),
    crashed: typeof webContents.isCrashed === 'function' ? webContents.isCrashed() : false
  };
}

function buildDiagnosticsReport() {
  const pollerState = pendingPoller?.getState() || null;
  const notificationState = notificationService?.getState() || lastNotificationState;
  const soundState = notificationSoundService?.getState?.() || null;
  const settingsPath = app.isReady() ? getDesktopSettingsPath() : '';

  return {
    generatedAt: new Date().toISOString(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    gpuSafeModeEnabled: GPU_SAFE_MODE_ENABLED,
    gpuSafeModeRequested: GPU_SAFE_MODE_REQUESTED,
    gpuSafeModePersisted: GPU_SAFE_MODE_PERSISTED,
    gpuSafeModeAutoFallback: GPU_SAFE_MODE_AUTO_FALLBACK,
    startupStatePath,
    previousStartupState,
    execPath: process.execPath,
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath || '',
    userData: app.isReady() ? app.getPath('userData') : '',
    appData: process.env.APPDATA || '',
    argv: process.argv,
    adminUrl: config.adminUrl,
    apiBaseUrl: config.apiBaseUrl,
    startupUrl: redactUrlToken(getStartupUrl()),
    lastLoadedUrl: redactUrlToken(lastLoadedUrl),
    lastLoadError,
    mainWindow: getCurrentMainWindowState(),
    notificationState,
    soundState,
    pendingPollerState: pollerState,
    webDeployMonitorState: webDeployMonitor?.getState() || null,
    webDeployReloadInProgress,
    developerShortcutState,
    lastDevToolsRequestAt,
    logFilePath,
    settingsPath,
    settingsFileExists: settingsPath ? fs.existsSync(settingsPath) : false
  };
}

function writeDiagnosticsReport() {
  const reportPath = path.join(app.getPath('userData'), 'desktop-diagnostics.txt');
  const report = buildDiagnosticsReport();
  const text = [
    'Elvador Desktop Diagnostics',
    JSON.stringify(report, null, 2)
  ].join('\n\n');

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, text, 'utf8');
  writeDesktopLog('diagnostics_report_write', { reportPath });
  return reportPath;
}

function openDiagnosticsReport() {
  try {
    const reportPath = writeDiagnosticsReport();
    shell.openPath(reportPath).then((errorMessage) => {
      if (errorMessage) {
        writeDesktopLog('diagnostics_report_open_error', { message: errorMessage });
        shell.showItemInFolder(reportPath);
      }
    });
    return reportPath;
  } catch (error) {
    writeDesktopLog('diagnostics_report_error', { message: error?.message });
    return null;
  }
}

function openDesktopLogFile() {
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    if (!fs.existsSync(logFilePath)) {
      fs.writeFileSync(logFilePath, '', 'utf8');
    }
    shell.openPath(logFilePath).then((errorMessage) => {
      if (errorMessage) {
        writeDesktopLog('desktop_log_open_error', { message: errorMessage });
        shell.showItemInFolder(logFilePath);
      }
    });
  } catch (error) {
    writeDesktopLog('desktop_log_open_error', { message: error?.message });
  }
}

function playSoundTest(source = 'manual-sound-test') {
  const result = notificationSoundService?.playNotificationSound({
    source,
    previewDurationMs: 7000,
    profile: 'medium'
  }) || {
    played: false,
    reason: 'sound_service_unavailable'
  };

  writeDesktopLog('notification_sound_test', result);
  return result;
}

writeDesktopLog('main module loaded', {
  argv: process.argv,
  execPath: process.execPath,
  cwd: process.cwd()
});

process.on('uncaughtException', (error) => {
  writeDesktopLog('uncaughtException', {
    message: error?.message,
    stack: error?.stack
  });
});

process.on('unhandledRejection', (error) => {
  writeDesktopLog('unhandledRejection', {
    message: error?.message || String(error),
    stack: error?.stack
  });
});

function getAppIconPath() {
  const packagedIconPath = path.join(process.resourcesPath || '', 'icon.ico');
  const repoIconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  const fallbackPath = path.join(__dirname, '..', 'assets', 'icon-512.png');
  if (app.isPackaged) {
    return fs.existsSync(packagedIconPath) ? packagedIconPath : path.join(process.resourcesPath || '', 'icon-512.png');
  }
  return fs.existsSync(repoIconPath) ? repoIconPath : fallbackPath;
}

function getNotificationIconDataUrl(filename) {
  const iconPath = path.join(__dirname, '..', 'assets', 'notification-icons', filename);
  try {
    return `data:image/svg+xml;base64,${fs.readFileSync(iconPath).toString('base64')}`;
  } catch (error) {
    writeDesktopLog('notification icon asset unavailable', { filename, message: error?.message });
    return '';
  }
}

function getDesktopSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function readDesktopSettings() {
  try {
    const rawValue = fs.readFileSync(getDesktopSettingsPath(), 'utf8');
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeDesktopSettings(nextSettings = {}) {
  desktopSettings = {
    ...nextSettings,
    updatedAt: new Date().toISOString()
  };

  try {
    const settingsPath = getDesktopSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(desktopSettings, null, 2));
  } catch (error) {
    writeDesktopLog('settings write failed', {
      message: error?.message
    });
  }

  refreshTrayMenu();
  return desktopSettings;
}

function extractAdminAccessToken(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    return null;
  }

  const pathMatch = value.match(/\/admin-access\/([A-Za-z0-9_-]+)/i);
  if (pathMatch?.[1]) {
    return pathMatch[1];
  }

  if (/^[A-Za-z0-9_-]{24,}$/.test(value)) {
    return value;
  }

  return null;
}

function normalizeAdminAccessInput(rawValue) {
  const token = extractAdminAccessToken(rawValue);
  if (!token) {
    return null;
  }

  try {
    const baseUrl = new URL(config.adminUrl);
    return `${baseUrl.origin}/admin-access/${encodeURIComponent(token)}`;
  } catch (_) {
    return null;
  }
}

function getSavedAdminAccessUrl() {
  return normalizeAdminAccessInput(desktopSettings.adminAccessUrl);
}

function saveAdminAccessUrl(rawValue) {
  const adminAccessUrl = normalizeAdminAccessInput(rawValue);
  if (!adminAccessUrl) {
    return null;
  }

  writeDesktopSettings({
    ...desktopSettings,
    adminAccessUrl,
    adminAccessSavedAt: new Date().toISOString()
  });
  writeDesktopLog('admin access url saved', { adminAccessUrl });
  return adminAccessUrl;
}

function clearAdminAccessUrl() {
  const { adminAccessUrl: _adminAccessUrl, adminAccessSavedAt: _adminAccessSavedAt, ...rest } = desktopSettings;
  writeDesktopSettings(rest);
  writeDesktopLog('admin access url cleared');
}

function getStartupUrl() {
  return getSavedAdminAccessUrl() || DESKTOP_ONBOARDING_URL;
}

function createTrayIcon(iconPath) {
  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 });
}

function focusMainWindow() {
  if (!mainWindow) {
    createMainWindow(getStartupUrl());
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function isMainWindowActiveForNotifications() {
  return Boolean(
    mainWindow
    && !mainWindow.isDestroyed()
    && mainWindow.isVisible()
    && !mainWindow.isMinimized()
    && mainWindow.isFocused()
  );
}

function dismissNativeOverlaysForActivePanel(reason) {
  if (!isMainWindowActiveForNotifications()) {
    return;
  }

  const activeCount = notificationService?.getState().activeCount || 0;
  if (activeCount === 0) {
    return;
  }

  notificationService.clearAll();
  writeDesktopLog('native overlays cleared because panel is active', { reason, activeCount });
}

function getDevToolsWindow(webContents) {
  const devToolsWebContents = webContents?.devToolsWebContents;
  if (!devToolsWebContents || devToolsWebContents.isDestroyed()) {
    return null;
  }

  return BrowserWindow.fromWebContents(devToolsWebContents);
}

function getDevToolsWindowState(webContents) {
  const devToolsWebContents = webContents?.devToolsWebContents;
  const devToolsWindow = getDevToolsWindow(webContents);

  return {
    webContentsExists: !!devToolsWebContents && !devToolsWebContents.isDestroyed(),
    windowExists: !!devToolsWindow,
    visible: devToolsWindow ? devToolsWindow.isVisible() : false,
    minimized: devToolsWindow ? devToolsWindow.isMinimized() : false,
    focused: devToolsWindow ? devToolsWindow.isFocused() : false,
    bounds: devToolsWindow ? devToolsWindow.getBounds() : null,
    url: devToolsWebContents && !devToolsWebContents.isDestroyed() ? devToolsWebContents.getURL() : ''
  };
}

function getCenteredDevToolsBounds() {
  const display = mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(area.width, Math.max(720, Math.min(1120, Math.floor(area.width * 0.82))));
  const height = Math.min(area.height, Math.max(560, Math.min(820, Math.floor(area.height * 0.82))));

  return {
    x: area.x + Math.max(0, Math.floor((area.width - width) / 2)),
    y: area.y + Math.max(0, Math.floor((area.height - height) / 2)),
    width,
    height
  };
}

function focusDetachedDevTools(webContents) {
  const devToolsWindow = getDevToolsWindow(webContents);
  if (!devToolsWindow) {
    return {
      focused: false,
      reason: webContents?.devToolsWebContents ? 'devtools_window_unavailable' : 'devtools_webcontents_unavailable',
      state: getDevToolsWindowState(webContents)
    };
  }

  try {
    if (devToolsWindow.isMinimized()) {
      devToolsWindow.restore();
    }

    devToolsWindow.setBounds(getCenteredDevToolsBounds());
    devToolsWindow.show();
    devToolsWindow.focus();
    if (typeof devToolsWindow.moveTop === 'function') {
      devToolsWindow.moveTop();
    }

    return {
      focused: true,
      state: getDevToolsWindowState(webContents)
    };
  } catch (error) {
    return {
      focused: false,
      reason: 'devtools_focus_error',
      message: error?.message,
      state: getDevToolsWindowState(webContents)
    };
  }
}

function verifyMainDevToolsOpen(webContents) {
  if (!mainWindow || mainWindow.isDestroyed() || webContents.isDestroyed()) {
    writeDesktopLog('devtools_open_verify', { opened: false, reason: 'destroyed' });
    return;
  }

  const opened = webContents.isDevToolsOpened();
  const focusResult = opened ? focusDetachedDevTools(webContents) : null;
  writeDesktopLog('devtools_open_verify', {
    opened,
    focusResult,
    devToolsWindow: getDevToolsWindowState(webContents)
  });
  if (!opened || !focusResult?.focused) {
    openDiagnosticsReport();
  }
}

function openOrFocusMainDevTools() {
  lastDevToolsRequestAt = new Date().toISOString();
  focusMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    writeDesktopLog('devtools_toggle_skip', { reason: 'main_window_unavailable' });
    openDiagnosticsReport();
    return;
  }

  const webContents = mainWindow.webContents;
  try {
    if (webContents.isDevToolsOpened()) {
      const focusResult = focusDetachedDevTools(webContents);
      if (focusResult.focused) {
        writeDesktopLog('devtools_focus', focusResult);
        return;
      }

      webContents.closeDevTools();
      writeDesktopLog('devtools_reopen_detached', focusResult);
    }

    webContents.once('devtools-opened', () => {
      const focusResult = focusDetachedDevTools(webContents);
      writeDesktopLog('devtools_opened_event', focusResult);
    });
    webContents.openDevTools({ mode: 'detach', activate: true });
    writeDesktopLog('devtools_toggle', {
      open: true,
      mode: 'detach',
      url: webContents.getURL()
    });
    setTimeout(() => verifyMainDevToolsOpen(webContents), 1200);
  } catch (error) {
    writeDesktopLog('devtools_toggle_error', { message: error?.message });
    openDiagnosticsReport();
  }
}

function closeMainDevTools() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  try {
    mainWindow.webContents.closeDevTools();
    writeDesktopLog('devtools_toggle', { open: false });
  } catch (error) {
    writeDesktopLog('devtools_close_error', { message: error?.message });
  }
}

function registerDeveloperShortcuts() {
  [
    'F12',
    'CommandOrControl+Shift+I',
    'CommandOrControl+Shift+D'
  ].forEach((accelerator) => {
    try {
      const registered = globalShortcut.register(accelerator, openOrFocusMainDevTools);
      developerShortcutState[accelerator] = registered;
      writeDesktopLog('devtools_shortcut_register', { accelerator, registered });
    } catch (error) {
      developerShortcutState[accelerator] = false;
      writeDesktopLog('devtools_shortcut_register_error', {
        accelerator,
        message: error?.message
      });
    }
  });
}

function resolveAppUrl(rawUrl) {
  if (!rawUrl) {
    return config.adminUrl;
  }

  try {
    const baseUrl = new URL(config.adminUrl);
    const nextUrl = new URL(rawUrl, baseUrl);
    if (nextUrl.origin !== baseUrl.origin) {
      return config.adminUrl;
    }
    return nextUrl.toString();
  } catch (_) {
    return config.adminUrl;
  }
}

function isWindowOnSameOrigin() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  try {
    const currentUrl = mainWindow.webContents.getURL();
    if (!currentUrl || currentUrl.startsWith('data:text/html')) {
      return false;
    }

    const baseUrl = new URL(config.adminUrl);
    const loadedUrl = new URL(currentUrl);
    return loadedUrl.origin === baseUrl.origin;
  } catch (_) {
    return false;
  }
}

function navigateInPage(targetUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  try {
    const url = new URL(targetUrl);
    const pathWithQuery = `${url.pathname}${url.search}${url.hash}`;
    const js = `(function(){
      try { window.history.pushState(null, '', ${JSON.stringify(pathWithQuery)}); window.dispatchEvent(new PopStateEvent('popstate')); } catch(e) {}
    })()`;
    mainWindow.webContents.executeJavaScript(js).catch(() => {});
  } catch (_) {
    // fallback: no navigation needed
  }
}

function openInApp(rawUrl) {
  if (rawUrl === DESKTOP_ONBOARDING_URL) {
    if (!mainWindow) {
      createMainWindow(DESKTOP_ONBOARDING_URL);
      return;
    }
    loadDesktopOnboardingPage();
    return;
  }

  const targetUrl = resolveAppUrl(rawUrl);
  const savedAdminAccessUrl = normalizeAdminAccessInput(targetUrl);
  if (savedAdminAccessUrl) {
    saveAdminAccessUrl(savedAdminAccessUrl);
  }

  lastLoadedUrl = targetUrl;
  if (!mainWindow) {
    createMainWindow(targetUrl);
    return;
  }

  if (isWindowOnSameOrigin()) {
    navigateInPage(targetUrl);
    return;
  }

  mainWindow.loadURL(targetUrl);
}

function parseLaunchUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    return null;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  try {
    const protocolUrl = new URL(value);
    if (protocolUrl.protocol !== `${config.protocol}:`) {
      return null;
    }

    const embeddedUrl = protocolUrl.searchParams.get('url');
    if (embeddedUrl) {
      return embeddedUrl;
    }

    const tab = protocolUrl.searchParams.get('tab');
    return tab ? `/admin?tab=${encodeURIComponent(tab)}` : config.adminUrl;
  } catch (_) {
    return null;
  }
}

function shouldOpenInsideApp(url) {
  if (String(url || '').startsWith('data:text/html')) {
    return true;
  }

  try {
    const baseUrl = new URL(config.adminUrl);
    const nextUrl = new URL(url);
    return nextUrl.origin === baseUrl.origin;
  } catch (_) {
    return false;
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadDesktopOnboardingPage(errorMessage = '') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  lastLoadedUrl = DESKTOP_ONBOARDING_URL;
  const escapedError = escapeHtml(errorMessage);
  const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Elvador Desktop Kurulum</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: #f6f6f6; color: #111; font-family: Arial, sans-serif; }
      body { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      main { width: min(560px, 100%); background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 28px; box-shadow: 0 12px 40px rgba(0,0,0,.08); }
      h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.2; }
      p { margin: 0 0 18px; color: #444; line-height: 1.45; }
      label { display: block; margin-bottom: 8px; font-weight: 700; }
      textarea { width: 100%; min-height: 104px; resize: vertical; border: 1px solid #bbb; border-radius: 7px; padding: 12px; font: inherit; line-height: 1.35; }
      textarea:focus { outline: 2px solid #111; outline-offset: 2px; }
      button { margin-top: 14px; width: 100%; border: 0; border-radius: 7px; background: #111; color: #fff; padding: 12px 14px; font-weight: 700; cursor: pointer; }
      button[disabled] { opacity: .55; cursor: wait; }
      .hint { margin-top: 14px; font-size: 13px; color: #666; }
      .error { display: ${escapedError ? 'block' : 'none'}; margin-bottom: 14px; padding: 10px 12px; border-radius: 7px; background: #fff0f0; color: #9b1111; border: 1px solid #f0c8c8; }
    </style>
  </head>
  <body>
    <main>
      <h1>Elvador Desktop kurulumu</h1>
      <p>Bu PC'yi bir otel/admin panel cihazına bağlamak için Superadmin'deki admin erişim QR/linkini buraya yapıştır.</p>
      <div class="error" id="error">${escapedError}</div>
      <form id="setupForm">
        <label for="adminAccessLink">Admin erisim QR/linki</label>
        <textarea id="adminAccessLink" autocomplete="off" spellcheck="false" placeholder="https://chat.elvador.com/admin-access/..."></textarea>
        <button id="saveButton" type="submit">Kaydet ve Elvador'u aç</button>
      </form>
      <p class="hint">Bu bilgi sadece bu bilgisayarda saklanır. Sonraki açılışlarda tekrar sorulmaz; gerekirse tray menüsünden değiştirilebilir.</p>
    </main>
    <script>
      const form = document.getElementById('setupForm');
      const input = document.getElementById('adminAccessLink');
      const button = document.getElementById('saveButton');
      const error = document.getElementById('error');

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.style.display = 'none';
        error.textContent = '';
        button.disabled = true;
        button.textContent = 'Kaydediliyor...';

        try {
          const result = await window.elvadorDesktop.saveAdminAccessLink(input.value);
          if (!result || !result.ok) {
            throw new Error(result?.message || 'Geçerli admin erişim linki bulunamadı.');
          }
        } catch (saveError) {
          error.textContent = saveError.message || 'Link kaydedilemedi.';
          error.style.display = 'block';
          button.disabled = false;
          button.textContent = "Kaydet ve Elvador'u aç";
        }
      });

      input.focus();
    </script>
  </body>
</html>`;

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function loadDesktopErrorPage(error = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const targetUrl = escapeHtml(lastLoadedUrl || config.adminUrl);
  const message = escapeHtml(error.errorDescription || error.message || 'Panel could not be loaded.');
  const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Elvador Desktop</title>
    <style>
      html, body { margin: 0; height: 100%; background: #111; color: #f5f5f5; font-family: Arial, sans-serif; }
      body { display: grid; place-items: center; }
      .panel { width: min(520px, calc(100vw - 48px)); border: 1px solid #333; border-radius: 10px; padding: 26px; background: #1b1b1b; box-shadow: 0 18px 60px rgba(0,0,0,.35); }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p { margin: 0 0 14px; color: #cfcfcf; line-height: 1.45; }
      code { display: block; padding: 10px; border-radius: 7px; background: #0b0b0b; color: #e6e6e6; white-space: normal; word-break: break-all; }
      button { margin-top: 18px; border: 0; border-radius: 7px; background: #fff; color: #111; padding: 10px 14px; font-weight: 700; cursor: pointer; }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>Elvador paneli yüklenemedi</h1>
      <p>İnternet bağlantısını, VPN/proxy ayarlarını veya admin URL'ini kontrol edin.</p>
      <p>${message}</p>
      <code>${targetUrl}</code>
      <button onclick="location.href='${targetUrl}'">Yeniden dene</button>
    </main>
  </body>
</html>`;

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function createMainWindow(initialUrl = getStartupUrl()) {
  const iconPath = getAppIconPath();
  const shouldShowOnboarding = initialUrl === DESKTOP_ONBOARDING_URL;
  lastLoadedUrl = shouldShowOnboarding ? DESKTOP_ONBOARDING_URL : resolveAppUrl(initialUrl);

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: 'Elvador',
    icon: iconPath,
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      devTools: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const hasSelectedText = Boolean(String(params.selectionText || '').trim());
    // Added selected-text copy because the desktop right-click menu previously exposed only shell actions.
    // A guest/admin can now copy a selected panel value without relying on the keyboard shortcut.
    const contextMenu = Menu.buildFromTemplate([
      ...(hasSelectedText ? [{ label: 'Kopyala', role: 'copy' }, { type: 'separator' }] : []),
      {
        label: `Version ${app.getVersion()}`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'QR/Link Sıfırla',
        click: () => {
          clearAdminAccessUrl();
          pendingPoller?.stop();
          loadDesktopOnboardingPage();
        }
      },
      {
        label: 'Güncelleme Kontrol Et',
        click: () => {
          autoUpdater.checkForUpdates().catch(() => {});
        }
      },
      {
        label: 'Ses Testi',
        click: () => playSoundTest('context-menu-sound-test')
      },
      {
        label: 'Developer Tools',
        accelerator: 'Ctrl+Shift+D',
        click: () => openOrFocusMainDevTools()
      },
      {
        label: 'Developer Tools Kapat',
        enabled: mainWindow.webContents.isDevToolsOpened(),
        click: () => closeMainDevTools()
      },
      {
        label: 'Tani Raporu Ac',
        click: () => openDiagnosticsReport()
      },
      {
        label: 'Log Dosyasini Ac',
        click: () => openDesktopLogFile()
      },
      { type: 'separator' },
      {
        label: `Yakınlaştır (${Math.round((mainWindow.webContents.getZoomFactor()) * 100)}%)`,
        submenu: [
          { label: 'Büyüt', accelerator: 'Ctrl+=', click: () => { mainWindow.webContents.setZoomFactor(mainWindow.webContents.getZoomFactor() + 0.1); } },
          { label: 'Küçült', accelerator: 'Ctrl+-', click: () => { mainWindow.webContents.setZoomFactor(Math.max(0.3, mainWindow.webContents.getZoomFactor() - 0.1)); } },
          { label: 'Sıfırla (100%)', accelerator: 'Ctrl+0', click: () => { mainWindow.webContents.setZoomFactor(1.0); } }
        ]
      },
      { type: 'separator' },
      { label: 'Geri', click: () => mainWindow.webContents.goBack(), enabled: mainWindow.webContents.canGoBack() },
      { label: 'İleri', click: () => mainWindow.webContents.goForward(), enabled: mainWindow.webContents.canGoForward() },
      { label: 'Yenile', click: () => mainWindow.webContents.reload() }
    ]);
    contextMenu.popup();
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    const isDevToolsShortcut =
      key === 'f12' ||
      ((input.control || input.meta) && input.shift && (key === 'i' || key === 'd'));

    if (isDevToolsShortcut) {
      event.preventDefault();
      openOrFocusMainDevTools();
      return;
    }

    if (input.control || input.meta) {
      if (key === '=' || key === '+') {
        event.preventDefault();
        mainWindow.webContents.setZoomFactor(mainWindow.webContents.getZoomFactor() + 0.1);
      } else if (key === '-') {
        event.preventDefault();
        mainWindow.webContents.setZoomFactor(Math.max(0.3, mainWindow.webContents.getZoomFactor() - 0.1));
      } else if (key === '0') {
        event.preventDefault();
        mainWindow.webContents.setZoomFactor(1.0);
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenInsideApp(url)) {
      openInApp(url);
      return { action: 'deny' };
    }

    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (shouldOpenInsideApp(url)) {
      return;
    }

    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    callback({ responseHeaders: headers });
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const currentUrl = mainWindow.webContents.getURL();
    if (!currentUrl.startsWith('data:text/html')) {
      lastLoadError = null;
      lastLoadedUrl = currentUrl;
      refreshTrayMenu();
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) {
      return;
    }

    lastLoadError = {
      errorCode,
      errorDescription,
      validatedUrl
    };
    refreshTrayMenu();
    loadDesktopErrorPage(lastLoadError);
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('focus', () => dismissNativeOverlaysForActivePanel('window_focus'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Clear HTTP cache on startup so web deploy changes are always picked up
  mainWindow.webContents.session.clearCache().catch(() => {}).then(() => {
    if (shouldShowOnboarding) {
      loadDesktopOnboardingPage();
    } else {
      mainWindow.loadURL(lastLoadedUrl);
    }
  });
}

function configureAutoStart() {
  if (!app.isPackaged || process.platform !== 'win32') {
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: config.autoStartEnabled,
    openAsHidden: true
  });
}

function createTray() {
  const iconPath = getAppIconPath();
  tray = new Tray(createTrayIcon(iconPath));
  tray.setToolTip('Elvador');
  refreshTrayMenu();
  tray.on('click', () => focusMainWindow());
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }

  const loadStatusLabel = lastLoadError
    ? 'Status: Panel yüklenemedi'
    : 'Status: Panel hazir';
  const versionStatusLabel = `Version: ${app.getVersion()}`;
  const pollerState = pendingPoller?.getState();
  const savedAdminAccessUrl = getSavedAdminAccessUrl();
  const accessStatusLabel = savedAdminAccessUrl
    ? 'Admin access: kayitli'
    : 'Admin access: kurulum gerekli';
  const notificationStatusLabel = `Pending: ${pollerState?.totalPending || 0} | Active notifications: ${lastNotificationState.activeCount}`;
  const pollerStatusLabel = pollerState?.active
    ? `Notifier: aktif${pollerState.lastError ? ` (${pollerState.lastError})` : ''}`
    : 'Notifier: oturum bekliyor';

  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: versionStatusLabel,
      enabled: false
    },
    {
      label: loadStatusLabel,
      enabled: false
    },
    {
      label: notificationStatusLabel,
      enabled: false
    },
    {
      label: pollerStatusLabel,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Elvador Aç',
      click: () => openInApp(getStartupUrl())
    },
    {
      label: 'QR/Link Sıfırla',
      click: () => {
        clearAdminAccessUrl();
        pendingPoller?.stop();
        focusMainWindow();
        loadDesktopOnboardingPage();
      }
    },
    {
      label: 'Test Bildirimi',
      click: () => {
        notificationService?.showNotification({
          id: `desktop-test-${Date.now()}`,
          title: 'Elvador Desktop',
          body: 'Test bildirimi çalışıyor.',
          url: '/admin',
          persist: true,
          category: 'desktop-test'
        });
      }
    },
    {
      label: 'Ses Testi',
      click: () => playSoundTest('tray-sound-test')
    },
    {
      label: 'Developer Tools',
      click: () => openOrFocusMainDevTools()
    },
    {
      label: 'Developer Tools Kapat',
      enabled: mainWindow?.webContents?.isDevToolsOpened() || false,
      click: () => closeMainDevTools()
    },
    {
      label: 'Tani Raporu Ac',
      click: () => openDiagnosticsReport()
    },
    {
      label: 'Log Dosyasini Ac',
      click: () => openDesktopLogFile()
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => {
        isQuitting = true;
        pendingPoller?.stop();
        notificationService?.clearAll();
        notificationSoundService?.stopNotificationSound('quit');
        app.quit();
      }
    }
  ]));
}

function isInternalOnboardingSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
  return String(senderUrl).startsWith('data:text/html');
}

function registerIpcHandlers() {
  ipcMain.handle('elvador:get-desktop-info', () => ({
    isDesktopShell: true,
    platform: process.platform,
    adminUrl: config.adminUrl,
    apiBaseUrl: config.apiBaseUrl,
    version: app.getVersion(),
    notificationState: notificationService?.getState() || lastNotificationState,
    pendingPollerState: pendingPoller?.getState() || null,
    lastLoadError
  }));

  ipcMain.handle('elvador:sync-admin-session', (_event, session = {}) => {
    pendingPoller?.start(session);
    refreshTrayMenu();
    return { ok: true, pendingPollerState: pendingPoller?.getState() || null };
  });

  ipcMain.handle('elvador:clear-admin-session', () => {
    pendingPoller?.stop();
    refreshTrayMenu();
    return { ok: true };
  });

  ipcMain.handle('elvador:notification-read-state-applied', (_event, details = {}) => {
    writeDesktopLog('web notification read state applied', {
      category: details?.category || null,
      requestId: details?.requestId || null,
      seenKey: details?.seenKey || null,
      phase: details?.phase || 'state_written',
      cardClassName: details?.cardClassName || null
    });
    return { ok: true };
  });

  ipcMain.handle('elvador:save-admin-access-link', (event, rawValue = '') => {
    if (!isInternalOnboardingSender(event)) {
      return {
        ok: false,
        message: 'Admin access link can only be changed from the desktop setup screen.'
      };
    }

    const adminAccessUrl = saveAdminAccessUrl(rawValue);
    if (!adminAccessUrl) {
      return {
        ok: false,
        message: 'Geçerli admin erişim linki bulunamadı.'
      };
    }

    openInApp(adminAccessUrl);
    return {
      ok: true,
      adminAccessUrl
    };
  });

  ipcMain.handle('elvador:show-native-notification', (_event, payload = {}) => {
    return notificationService.showNotification(payload);
  });

  ipcMain.handle('elvador:acknowledge-native-notification', (_event, payload = {}) => {
    const nativeResult = notificationService?.acknowledgeNotification(payload) || {
      acknowledged: false,
      reason: 'notification_service_unavailable'
    };
    const pollerResult = pendingPoller?.acknowledgePendingNotification(payload) || {
      suppressedCount: 0
    };
    return {
      ...nativeResult,
      suppressedCount: pollerResult.suppressedCount
    };
  });

  ipcMain.handle('elvador:play-notification-sound', (_event, options = {}) => {
    return notificationSoundService?.playNotificationSound(options) || {
      played: false,
      reason: 'sound_service_unavailable'
    };
  });

  ipcMain.handle('elvador:stop-notification-sound', (_event, reason = 'renderer_request') => {
    notificationSoundService?.stopNotificationSound(reason);
    return { stopped: true };
  });
}

if (!gotSingleInstanceLock) {
  writeDesktopLog('single instance lock unavailable, quitting');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const urlArg = argv.map(parseLaunchUrl).find(Boolean);
    focusMainWindow();
    if (urlArg) {
      openInApp(urlArg);
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    const launchUrl = parseLaunchUrl(url);
    focusMainWindow();
    if (launchUrl) {
      openInApp(launchUrl);
    }
  });

  app.whenReady().then(() => {
    desktopSettings = readDesktopSettings();
    writeDesktopLog('app ready', {
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      adminUrl: config.adminUrl,
      apiBaseUrl: config.apiBaseUrl
    });

    app.setName('Elvador');
    if (process.platform === 'win32') {
      app.setAppUserModelId(config.appUserModelId);
    }
    configureAutoStart();
    app.setAsDefaultProtocolClient(config.protocol);
    registerDeveloperShortcuts();
    notificationSoundService = createNativeNotificationSoundService({
      writeLog: writeDesktopLog
    });

    const iconPath = getAppIconPath();
    notificationService = createNativeNotificationService({
      appIconPath: iconPath,
      reservationIconUrl: getNotificationIconDataUrl('reservation.svg'),
      housekeepingIconUrl: getNotificationIconDataUrl('Housekeeping.svg'),
      clockIconUrl: getNotificationIconDataUrl('clock.svg'),
      notificationsIconUrl: getNotificationIconDataUrl('Notifications.svg'),
      overlayPreloadPath: path.join(__dirname, 'overlayPreload.js'),
      focusApp: focusMainWindow,
      openInApp,
      playSound: (options) => notificationSoundService.playNotificationSound(options),
      stopSound: (reason) => notificationSoundService.stopNotificationSound(reason),
      writeLog: writeDesktopLog,
      shouldShowOverlay: () => !isMainWindowActiveForNotifications(),
      onNotificationOpened: (payload) => {
        pendingPoller?.acknowledgePendingNotification(payload);
        // 2026-08-15: Only an overlay click reaches this callback. Mark it as
        // user-initiated so the panel clears the matching visual alert.
        mainWindow?.webContents?.send('elvador:notification-opened', {
          ...payload,
          userInitiated: true
        });
      },
      onNotificationMinimized: (payload) => {
        pendingPoller?.acknowledgePendingNotification(payload);
        mainWindow?.webContents?.send('elvador:notification-minimized', payload);
      },
      onChange: (state) => {
        lastNotificationState = state;
        refreshTrayMenu();
      }
    });
    pendingPoller = createDesktopPendingPoller({
      apiBaseUrl: config.apiBaseUrl,
      reminderIntervalMs: config.notificationReminderMs,
      showNotification: (payload) => notificationService.showNotification(payload),
      dismissNotification: (payload) => notificationService.dismissNotification(payload),
      writeLog: writeDesktopLog,
      onStateChange: () => refreshTrayMenu()
    });
    webDeployMonitor = createWebDeployMonitor({
      adminUrl: config.adminUrl,
      intervalMs: config.webDeployCheckIntervalMs,
      timeoutMs: config.webDeployRequestTimeoutMs,
      onDeploymentChanged: reloadPanelForWebDeploy,
      onStateChange: ({ event, details }) => emitWebDeployBrowserLog(event, details),
      writeLog: writeDesktopLog
    });

    registerIpcHandlers();
    createMainWindow();
    createTray();
    webDeployMonitor.start();
    startDevelopmentSourceWatcher();
    if (app.isPackaged) {
      autoUpdater.logger = { info: (m) => writeDesktopLog('updater:info', m), warn: (m) => writeDesktopLog('updater:warn', m), error: (m) => writeDesktopLog('updater:error', m) };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      writeDesktopLog('update available', { version: info?.version });
      });
      autoUpdater.on('update-downloaded', (info) => {
      writeDesktopLog('update downloaded', { version: info?.version });
      const updateVersion = String(info?.version || '').trim() || 'unknown';
      if (updatePromptState.open) {
        writeDesktopLog('update_prompt_skip', { version: updateVersion, reason: 'already_open' });
        return;
      }
      if (updatePromptState.dismissedVersion === updateVersion || updatePromptState.promptedVersion === updateVersion) {
        writeDesktopLog('update_prompt_skip', { version: updateVersion, reason: 'already_prompted' });
        return;
      }
      updatePromptState = {
        open: true,
        promptedVersion: updateVersion,
        dismissedVersion: updatePromptState.dismissedVersion
      };
      writeDesktopLog('update_prompt_show', { version: updateVersion });
      const { dialog } = require('electron');
      dialog.showMessageBox(mainWindow || null, {
        type: 'info',
        title: 'Güncelleme Hazır',
        message: `Elvador v${info?.version} indirildi.`,
        detail: 'Güncellemeyi yüklemek için uygulama yeniden başlatılacak.',
        buttons: ['Şimdi Yeniden Başlat', 'Sonra'],
        defaultId: 0,
        noLink: true
      }).then((result) => {
        const accepted = result.response === 0;
        updatePromptState = {
          open: false,
          promptedVersion: updateVersion,
          dismissedVersion: accepted ? updatePromptState.dismissedVersion : updateVersion
        };
        writeDesktopLog('update_prompt_choice', {
          version: updateVersion,
          choice: accepted ? 'install' : 'later'
        });
        if (accepted) {
          isQuitting = true;
          setImmediate(() => autoUpdater.quitAndInstall(false, true));
        }
      });
    });
    autoUpdater.on('error', (err) => {
      writeDesktopLog('updater error', { message: err?.message });
      });
      setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 10000);
      setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, AUTO_UPDATE_CHECK_INTERVAL_MS);
    } else {
      writeDesktopLog('development mode: release updater disabled');
    }

    writeDesktopLog('main window and tray created');
    startupStableTimer = setTimeout(() => {
      markStartupState('stable', {
        stableAt: new Date().toISOString()
      });
      writeDesktopLog('startup marked stable', {
        gpuSafeModeEnabled: GPU_SAFE_MODE_ENABLED,
        gpuSafeModePersisted: GPU_SAFE_MODE_PERSISTED,
        gpuSafeModeAutoFallback: GPU_SAFE_MODE_AUTO_FALLBACK
      });
    }, 30000);
  }).catch((error) => {
    writeDesktopLog('app ready failed', {
      message: error?.message,
      stack: error?.stack
    });
  });

  app.on('activate', () => {
    focusMainWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    developmentSourceWatcher?.close();
    developmentSourceWatcher = null;
    clearTimeout(developmentReloadTimer);
    developmentReloadTimer = null;
    if (startupStableTimer) {
      clearTimeout(startupStableTimer);
      startupStableTimer = null;
    }
    markStartupState('quit', {
      quitAt: new Date().toISOString()
    });
    pendingPoller?.stop();
    webDeployMonitor?.stop();
    notificationSoundService?.stopNotificationSound('before_quit');
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    // Keep the app alive in tray unless the user explicitly quits.
  });
}
