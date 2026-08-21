const DEFAULT_ADMIN_URL = 'https://chat.elvador.com/admin';
const DEFAULT_PROTOCOL = 'elvador';
const DEFAULT_NOTIFICATION_REMINDER_MS = 300000;
const DEFAULT_WEB_DEPLOY_CHECK_INTERVAL_MS = 60000;
const DEFAULT_WEB_DEPLOY_REQUEST_TIMEOUT_MS = 15000;

function normalizeAdminUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate) {
    return DEFAULT_ADMIN_URL;
  }

  try {
    return new URL(candidate).toString();
  } catch (_) {
    return DEFAULT_ADMIN_URL;
  }
}

function normalizeApiBaseUrl(value, adminUrl) {
  const candidate = String(value || '').trim();
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      return parsed.origin;
    } catch (_) {
      // Fall through to admin URL origin.
    }
  }

  try {
    return new URL(adminUrl).origin;
  } catch (_) {
    return new URL(DEFAULT_ADMIN_URL).origin;
  }
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getDesktopConfig() {
  const adminUrl = normalizeAdminUrl(process.env.ELVADOR_ADMIN_URL);
  return {
    adminUrl,
    apiBaseUrl: normalizeApiBaseUrl(process.env.ELVADOR_API_BASE_URL, adminUrl),
    appUserModelId: process.env.ELVADOR_APP_USER_MODEL_ID || 'com.elvador.desktop.brandmark.2',
    autoStartEnabled: process.env.ELVADOR_AUTO_START !== 'false',
    notificationReminderMs: normalizePositiveInteger(
      process.env.ELVADOR_NOTIFICATION_REMINDER_MS,
      DEFAULT_NOTIFICATION_REMINDER_MS
    ),
    webDeployCheckIntervalMs: normalizePositiveInteger(
      process.env.ELVADOR_WEB_DEPLOY_CHECK_INTERVAL_MS,
      DEFAULT_WEB_DEPLOY_CHECK_INTERVAL_MS
    ),
    webDeployRequestTimeoutMs: normalizePositiveInteger(
      process.env.ELVADOR_WEB_DEPLOY_REQUEST_TIMEOUT_MS,
      DEFAULT_WEB_DEPLOY_REQUEST_TIMEOUT_MS
    ),
    protocol: process.env.ELVADOR_PROTOCOL || DEFAULT_PROTOCOL
  };
}

module.exports = {
  DEFAULT_ADMIN_URL,
  DEFAULT_NOTIFICATION_REMINDER_MS,
  DEFAULT_PROTOCOL,
  DEFAULT_WEB_DEPLOY_CHECK_INTERVAL_MS,
  DEFAULT_WEB_DEPLOY_REQUEST_TIMEOUT_MS,
  getDesktopConfig
};
