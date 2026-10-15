const { BrowserWindow, ipcMain, screen } = require('electron');

const OVERLAY_WIDTH = 304;
const OVERLAY_HEIGHT = 56;
const OVERLAY_MARGIN = 12;
const OVERLAY_GAP = 8;
const MAX_VISIBLE_OVERLAYS = 3;
const OVERLAY_CHANNEL_OPEN = 'elvador:overlay-notification-open';
const OVERLAY_CHANNEL_MINIMIZE = 'elvador:overlay-notification-minimize';
const ACTIVE_DUPLICATE_SUPPRESS_MS = 45000;
const OPENED_NOTIFICATION_SUPPRESS_MS = 45000;
const DEFAULT_NOTIFICATION_SOUND_OPTIONS = Object.freeze({
  profile: 'low',
  soundTone: 'smoothChime',
  volume: 0.75,
  criticalDurationMs: 15000
});
const SOUND_PROFILES = new Set(['low', 'medium', 'high', 'critical']);
const SOUND_TONES = new Set(['smoothChime', 'orderPing', 'warmBell', 'glassBell', 'mellowTap', 'classicBeep']);

const CATEGORY_UI = Object.freeze({
  liveSupport: { label: 'Destek', initials: 'DS', accent: '#2563eb' },
  reservation: { label: 'Rezervasyon', initials: 'RZ', accent: '#7c3aed' },
  housekeeping: { label: 'Kat hizmetleri', initials: 'HK', accent: '#0f766e' },
  technic: { label: 'Teknik', initials: 'TK', accent: '#ea580c' },
  orders: { label: 'Sipariş', initials: 'SP', accent: '#d97706' },
  ordersReservations: { label: 'Masa Rezervasyonu', initials: 'MR', accent: '#d97706' },
  upsell: { label: 'Upsell', initials: 'UP', accent: '#059669' },
  spa: { label: 'Spa', initials: 'SP', accent: '#db2777' },
  lostAndFound: { label: 'Kayıp eşya', initials: 'KE', accent: '#475569' },
  conversation: { label: 'Sohbet', initials: 'SH', accent: '#0284c7' },
  desktopTest: { label: 'Test', initials: 'EL', accent: '#111827' },
  panelVisualNotification: { label: 'Panel', initials: 'EL', accent: '#111827' },
  default: { label: 'Elvador', initials: 'EL', accent: '#111827' }
});

const COMPACT_NOTIFICATION_COPY = Object.freeze({
  liveSupport: 'Yeni destek talebi',
  reservation: 'Yeni rezervasyon',
  housekeeping: 'Yeni kat talebi',
  technic: 'Yeni teknik talep',
  orders: 'Yeni sipariş',
  ordersReservations: 'Yeni masa rezervasyonu',
  upsell: 'Yeni upsell talebi',
  spa: 'Yeni spa talebi',
  lostAndFound: 'Yeni kayıp eşya talebi',
  conversation: 'Yeni sohbet',
  desktopTest: 'Test bildirimi',
  panelVisualNotification: 'Yeni talep',
  default: 'Yeni talep'
});

const CATEGORY_ALIASES = Object.freeze({
  'desktop-test': 'desktopTest',
  desktoptest: 'desktopTest',
  live_support: 'liveSupport',
  livesupport: 'liveSupport',
  liveSupport: 'liveSupport',
  support: 'liveSupport',
  reservation: 'reservation',
  housekeeping: 'housekeeping',
  houseKeeping: 'housekeeping',
  technic: 'technic',
  technical: 'technic',
  orders: 'orders',
  order: 'orders',
  ordersreservations: 'ordersReservations',
  orders_reservations: 'ordersReservations',
  upsell: 'upsell',
  spa: 'spa',
  lostandfound: 'lostAndFound',
  lost_and_found: 'lostAndFound',
  'lost-and-found': 'lostAndFound',
  conversation: 'conversation',
  conversations: 'conversation',
  'panel-visual-notification': 'panelVisualNotification',
  panel_visual_notification: 'panelVisualNotification',
  paneltitleNotification: 'panelVisualNotification',
  'panel-title-notification': 'panelVisualNotification'
});

function normalizeCategory(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    return 'default';
  }

  const compactValue = value.replace(/[\s_-]/g, '');
  return CATEGORY_ALIASES[value] || CATEGORY_ALIASES[compactValue] || value;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function coerceTimestampMs(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value.toMillis === 'function') {
    return value.toMillis();
  }

  if (typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }

  if (typeof value === 'number') {
    return value > 0 && value < 100000000000 ? value * 1000 : value;
  }

  if (typeof value === 'object') {
    const seconds = Number(value.seconds ?? value._seconds);
    const nanoseconds = Number(value.nanoseconds ?? value._nanoseconds ?? 0);
    if (Number.isFinite(seconds)) {
      return (seconds * 1000) + Math.floor(nanoseconds / 1000000);
    }
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestamp(value) {
  const timestampMs = coerceTimestampMs(value);
  return Number.isFinite(timestampMs) && timestampMs > 0
    ? new Date(timestampMs).toISOString()
    : null;
}

function sanitizeColor(value, fallback) {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function coercePositiveNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.round(numberValue) : null;
}

function coerceSoundVolume(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return DEFAULT_NOTIFICATION_SOUND_OPTIONS.volume;
  }
  return Math.min(1, Math.max(0, numberValue));
}

function normalizeSoundProfile(value) {
  const profile = String(value || '').trim();
  return SOUND_PROFILES.has(profile) ? profile : DEFAULT_NOTIFICATION_SOUND_OPTIONS.profile;
}

function normalizeSoundTone(value) {
  const tone = String(value || '').trim();
  return SOUND_TONES.has(tone) ? tone : DEFAULT_NOTIFICATION_SOUND_OPTIONS.soundTone;
}

function parseCountFromText(value) {
  const text = normalizeText(value);
  const countMatch = text.match(/(\d+)/);
  return countMatch ? coercePositiveNumber(countMatch[1]) : null;
}

function formatOpenAge(value) {
  const timestampMs = coerceTimestampMs(value);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return '';
  }

  const ageMs = Date.now() - timestampMs;
  if (ageMs < 2 * 60 * 1000) {
    return '';
  }

  const minutes = Math.max(1, Math.floor(ageMs / 60000));
  if (minutes < 60) {
    return `${minutes} dk açık`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${hours} sa ${remainingMinutes} dk açık`
    : `${hours} sa açık`;
}

function getInitials(value, fallback) {
  const text = normalizeText(value);
  if (!text) {
    return fallback;
  }

  const words = text.split(' ').filter(Boolean);
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

function buildStableNotificationSignature(notification) {
  return [
    notification.id,
    notification.category,
    notification.sourceLabel,
    notification.count || '',
    notification.url || ''
  ].join('|');
}

function buildOpenedNotificationFingerprint(notification) {
  const acknowledgementKey = normalizeText(notification.acknowledgementKey);
  if (acknowledgementKey) {
    return `ack:${acknowledgementKey}`;
  }
  if (!notification.count) {
    return '';
  }

  return [
    notification.category,
    notification.count
  ].join('|');
}

function buildActiveNotificationFingerprint(notification) {
  if (!notification.count || !notification.url) {
    return '';
  }

  return [
    notification.requestId || notification.id,
    notification.category,
    notification.count,
    notification.url
  ].join('|');
}

function estimateOldestRequestedAt(ageLabel) {
  if (!ageLabel) return null;
  const clean = ageLabel.toLowerCase().replace(/açık/g, '').trim();
  let minsAgo = 0;

  const hrMatch = clean.match(/(\d+)\s*sa/);
  const minMatch = clean.match(/(\d+)\s*dk/);
  const secMatch = clean.match(/(\d+)\s*sn/);

  if (hrMatch) minsAgo += parseInt(hrMatch[1], 10) * 60;
  if (minMatch) minsAgo += parseInt(minMatch[1], 10);
  if (secMatch) minsAgo += parseInt(secMatch[1], 10) / 60;

  if (minsAgo > 0) {
    return new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
  }
  return null;
}

function sanitizeNotificationPayload(payload = {}) {
  const category = normalizeCategory(payload.category);
  const categoryUi = CATEGORY_UI[category] || CATEGORY_UI.default;
  const count = coercePositiveNumber(payload.count)
    || parseCountFromText(payload.body)
    || parseCountFromText(payload.title);
  const sourceLabel = normalizeText(payload.sourceLabel || payload.label) || categoryUi.label;
  const sourceInitials = normalizeText(payload.sourceInitials)
    || categoryUi.initials
    || getInitials(sourceLabel, CATEGORY_UI.default.initials);
  const title = normalizeText(payload.title)
    || (count ? `${sourceLabel} Bildirimi` : 'Elvador Bildirimi');
  const body = normalizeText(payload.body)
    || (count ? `${count} bekleyen ${sourceLabel.toLocaleLowerCase('tr-TR')} talebi` : '');
  const id = normalizeText(payload.id || payload.requestId || payload.sessionId || Date.now());
  const url = normalizeText(payload.url);
  const ageLabel = normalizeText(payload.ageLabel)
    || formatOpenAge(payload.oldestRequestedAt || payload.requestedAt || payload.createdAt);

  const oldestRequestedAt = normalizeTimestamp(
    payload.oldestRequestedAt || payload.requestedAt || payload.createdAt
  ) || estimateOldestRequestedAt(ageLabel) || null;
  const roomNumber = normalizeText(payload.roomNumber || '');
  const guestName = normalizeText(payload.guestName || payload.fullName || '');
  const requestId = normalizeText(payload.requestId || '');
  const detailLabel = normalizeText(payload.detailLabel || '');
  const reservationLocation = normalizeText(payload.reservationLocation || '');

  return {
    id,
    title,
    body,
    url,
    category,
    sourceLabel,
    sourceInitials: sourceInitials.slice(0, 3).toUpperCase(),
    accentColor: sanitizeColor(payload.accentColor, categoryUi.accent),
    count,
    ageLabel,
    roomNumber,
    guestName,
    requestId,
    detailLabel,
    reservationLocation,
    oldestRequestedAt,
    acknowledgementKey: normalizeText(payload.acknowledgementKey),
    persist: payload.persist !== false,
    playSound: payload.playSound !== false && payload.silent !== true,
    showWhenPanelActive: payload.showWhenPanelActive === true
  };
}

function buildNotificationSoundOptions(notification, payload = {}) {
  return {
    source: normalizeText(payload.soundSource || payload.source) || 'native-notification',
    id: notification.id,
    category: notification.category,
    profile: normalizeSoundProfile(payload.profile || payload.soundProfile),
    soundTone: normalizeSoundTone(payload.soundTone || payload.tone),
    volume: coerceSoundVolume(payload.volume ?? payload.soundVolume),
    criticalDurationMs: coercePositiveNumber(payload.criticalDurationMs)
      || DEFAULT_NOTIFICATION_SOUND_OPTIONS.criticalDurationMs
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getCompactNotificationIcon(category) {
  if (category === 'reservation' || category === 'ordersReservations') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2v4M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M9 16l2 2 4-4"/></svg>';
  }
  if (category === 'housekeeping') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h16M6 20v-5h12v5M8 15V9h8v6M10 9V5h4v4"/></svg>';
  }
  if (category === 'technic') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18l3 3 5.3-5.3a5 5 0 0 0 6.4-6.4l-3.2 3.2-2.8-2.8 3-3.4Z"/></svg>';
  }
  if (category === 'orders') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v8M10 3v8M6 7h4M8 11v10M17 3v18M17 3c3 2 3 6 0 8"/></svg>';
  }
  if (category === 'liveSupport' || category === 'conversation') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11.5a8 8 0 0 1-8.5 8 8.6 8.6 0 0 1-3.7-.9L4 20l1.4-3.4A8 8 0 1 1 20 11.5Z"/><path d="M8 11h.01M12 11h.01M16 11h.01"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
}

function buildOverlayHtml(notification) {
  const custom = notification.customization || {};
  const id = escapeHtml(notification.id);
  // 2026-10-14: Minimal/standard samples hid the preview caption and looked
  // like real requests. Mark the short message in every preview composition.
  const message = escapeHtml(
    (notification.preview ? 'Önizleme · ' : '') + (COMPACT_NOTIFICATION_COPY[notification.category] || COMPACT_NOTIFICATION_COPY.default)
  );
  const accentColor = sanitizeColor(notification.accentColor, CATEGORY_UI.default.accent);
  const notificationIcon = getCompactNotificationIcon(notification.category);
  const design = custom.design || 'existing';
  const caption = escapeHtml(notification.preview ? 'Önizleme' : notification.sourceLabel);

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${message}</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; user-select: none; }
      .toast {
        width: 100vw;
        height: 100vh;
        display: flex;
        align-items: center;
        gap: ${custom.padding ? Math.round(custom.padding * .7) : 10}px;
        padding: ${custom.padding || 10}px 8px ${custom.padding || 10}px ${custom.padding || 12}px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-left: 4px solid ${custom.accent || accentColor};
        border-radius: ${custom.radius ?? 10}px;
        background: ${custom.background || 'rgba(24, 24, 27, 0.98)'};
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
        color: ${custom.text || '#ffffff'};
        cursor: pointer;
        animation: ${custom.animation === 'none' ? 'none' : custom.animation === 'fade' ? 'notification-fade 220ms ease-out both' : 'notification-spawn 220ms ease-out both'};
      }
      .icon { display: flex; flex: 0 0 ${custom.iconSize || 22}px; width: ${custom.iconSize || 22}px; height: ${custom.iconSize || 22}px; color: ${custom.accent || accentColor}; }
      .icon svg { width: 100%; height: 100%; }
      .message { display: block; flex: 1; min-width: 0; overflow: hidden; color: ${custom.text || '#ffffff'}; font-size: ${Math.min(36, (custom.fontSize || 15) * (custom.scale || 1))}px; font-weight: 650; line-height: ${custom.fontSize || custom.scale ? '1.3' : '20px'}; text-overflow: ellipsis; white-space: nowrap; }
      @keyframes notification-fade { from { opacity: 0; } to { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
      .copy { flex: 1; min-width: 0; }
      .caption { display: none; font-size: 11px; opacity: .75; margin-bottom: 4px; }
      .toast[data-design="minimal"] { border-left-width: 1px; box-shadow: none; padding-left: 10px; }
      .toast[data-design="cards"] { align-items: center; padding: 12px; border-left-width: 1px; border-top: 3px solid ${custom.accent || accentColor}; }
      .toast[data-design="cards"] .caption { display: block; }
      .toast[data-design="cards"] .icon { width: 32px; height: 32px; flex-basis: 32px; }
      .toast[data-design="strip"] { border-left-width: 1px; border-bottom: 3px solid ${custom.accent || accentColor}; padding: 6px 8px; border-radius: ${custom.radius ?? 4}px; }
      .close-button {
        width: 30px;
        height: 30px;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: ${custom.text || 'rgba(255, 255, 255, 0.76)'};
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 30px;
      }
      .close-button:hover, .close-button:focus-visible { background: rgba(255, 255, 255, 0.12); color: ${custom.text || '#ffffff'}; outline: none; }
      .close-button svg { width: 18px; height: 18px; }
      @keyframes notification-spawn {
        from { opacity: 0; translate: 0 12px; }
        to { opacity: 1; translate: 0 0; }
      }
    </style>
  </head>
  <body>
    <main class="toast" role="button" tabindex="0" data-id="${id}" data-design="${design}">
      <span class="icon" aria-hidden="true">${notificationIcon}</span>
      <span class="copy"><span class="caption">${caption}</span><span class="message">${message}</span></span>
      <button class="close-button" type="button" aria-label="Bildirimi kapat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </main>
    <script>
      const open = () => window.elvadorOverlay.open("${id}");
      const minimize = (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.elvadorOverlay.minimize("${id}");
      };
      document.body.addEventListener('click', open);
      document.querySelector('.close-button').addEventListener('click', minimize);
      document.body.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
      });
    </script>
  </body>
</html>`;
}


function createNativeNotificationService({
  appIconPath,
  reservationIconUrl = '',
  housekeepingIconUrl = '',
  clockIconUrl = '',
  notificationsIconUrl = '',
  overlayPreloadPath,
  focusApp,
  openInApp,
  playSound = () => ({ played: false, reason: 'sound_service_unavailable' }),
  stopSound = () => {},
  writeLog = () => {},
  shouldShowOverlay = () => true,
  onNotificationOpened = () => {},
  onNotificationMinimized = () => {},
  onChange = () => {}
}) {
  const activeNotifications = new Map();
  const recentlyOpenedNotifications = new Map();
  const recentlyOpenedFingerprints = new Map();
  const minimizedNotificationIds = new Set();
  let customization = null;
  let previewRecord = null;
  const previewId = '__ui-customization-preview__';
  const customizationType = category => ({ orders: 'ordersRequests', conversation: 'analyticsConversations', spa: 'spaRequests', upsell: 'upsellRequests' }[category] || category);
  const resolveCustomization = category => ({ ...customization?.notifications?.general, ...customization?.notifications?.types?.[customizationType(category)] });
  function setCustomization(preferences) {
    if (JSON.stringify(customization) !== JSON.stringify(preferences)) closeCustomizationPreview();
    customization = preferences;
    // New arrivals, including the independent native poller, use the same
    // personal settings. Existing visible cards finish their original lifecycle.
  }
  function overlayDimensions(custom, workArea) {
    const designHeight = custom.design === 'cards' ? 96 : custom.design === 'strip' ? 44 : custom.design === 'minimal' ? 48 : OVERLAY_HEIGHT;
    return {
      width: Math.min(workArea.width - OVERLAY_MARGIN * 2, Math.round((custom.width || OVERLAY_WIDTH) * (custom.scale || 1))),
      height: Math.min(Math.floor((workArea.height - OVERLAY_MARGIN * 2 - OVERLAY_GAP * 2) / 3), Math.max(designHeight, Math.round((custom.fontSize || 15) * (custom.scale || 1) * 1.3 + (custom.padding ? custom.padding * 2 : 30) + (custom.design === 'cards' ? 19 : 0)), (custom.iconSize || 22) + (custom.padding || 10) * 2))
    };
  }
  function placePreview() {
    if (!previewRecord?.overlayWindow || previewRecord.overlayWindow.isDestroyed()) return;
    const workArea = screen.getPrimaryDisplay().workArea;
    const custom = previewRecord.payload.customization;
    const { width, height } = overlayDimensions(custom, workArea);
    const position = custom.position || 'bottom-right';
    previewRecord.overlayWindow.setBounds({ width, height,
      x: Math.round(position === 'center' ? workArea.x + (workArea.width - width) / 2 : position.endsWith('left') ? workArea.x + 12 : workArea.x + workArea.width - width - 12),
      y: Math.round(position === 'center' ? workArea.y + (workArea.height - height) / 2 : position.startsWith('top') ? workArea.y + 12 : workArea.y + workArea.height - height - 12) });
  }
  function closeCustomizationPreview() {
    if (previewRecord) closeRecord(previewRecord);
    previewRecord = null;
  }
  function showCustomizationPreview(preferences, category, previewRequestId) {
    closeCustomizationPreview();
    const nativeCategory = { ordersRequests: 'orders', analyticsConversations: 'conversation', spaRequests: 'spa', upsellRequests: 'upsell' }[category] || category;
    const payload = sanitizeNotificationPayload({ id: previewId, category: nativeCategory, title: 'Bildirim önizlemesi', count: 1, playSound: false });
    payload.customization = { ...preferences.notifications.general, ...preferences.notifications.types[customizationType(payload.category)] };
    if (payload.customization.position === 'existing') delete payload.customization.position;
    payload.preview = true;
    previewRecord = { payload, preview: true, overlayWindow: null, createdAt: Date.now(), isClosing: false };
    previewRecord.overlayWindow = createOverlayWindow(previewRecord);
    writeLog('notification customization preview started', { previewRequestId, category: payload.category, design: payload.customization.design || 'existing' });
    return { shown: true, preview: true };
  }
  function armDuration(record) {
    const duration = record.payload.customization?.duration;
    if (!duration) return;
    const deadline = Date.now() + duration * 1000;
    record.durationDeadline = deadline;
    const expire = () => {
      if (record.isClosing) return;
      if (Date.now() < deadline) { record.durationTimer = setTimeout(expire, deadline - Date.now()); return; }
      if (record.preview) closeCustomizationPreview();
      else {
        if (activeNotifications.get(record.payload.id) !== record) return;
        activeNotifications.delete(record.payload.id);
        minimizedNotificationIds.add(record.payload.id);
        closeRecord(record); emitChange(); repositionOverlays();
      }
      writeLog('notification customization duration elapsed', { category: record.payload.category, preview: Boolean(record.preview), duration });
    };
    record.durationTimer = setTimeout(expire, duration * 1000);
  }

  function emitChange() {
    onChange({
      activeCount: activeNotifications.size,
      activeIds: Array.from(activeNotifications.keys())
    });
  }

  function pruneRecentlyOpenedNotifications() {
    for (const [notificationId, record] of recentlyOpenedNotifications.entries()) {
      if (!record) {
        recentlyOpenedNotifications.delete(notificationId);
      }
    }
    for (const [fingerprint, record] of recentlyOpenedFingerprints.entries()) {
      if (!record) {
        recentlyOpenedFingerprints.delete(fingerprint);
      }
    }
  }

  function rememberOpenedNotification(payload) {
    recentlyOpenedNotifications.set(payload.id, {
      signature: buildStableNotificationSignature(payload),
      openedAt: Date.now()
    });

    const fingerprint = buildOpenedNotificationFingerprint(payload);
    if (fingerprint) {
      recentlyOpenedFingerprints.set(fingerprint, {
        id: payload.id,
        category: payload.category,
        openedAt: Date.now()
      });
    }
  }

  function shouldSuppressRecentlyOpenedNotification(payload) {
    pruneRecentlyOpenedNotifications();
    const recentRecord = recentlyOpenedNotifications.get(payload.id);
    if (
      recentRecord
      && Date.now() - recentRecord.openedAt < OPENED_NOTIFICATION_SUPPRESS_MS
    ) {
      return true;
    }

    const fingerprint = buildOpenedNotificationFingerprint(payload);
    const fingerprintRecord = fingerprint ? recentlyOpenedFingerprints.get(fingerprint) : null;
    return Boolean(
      fingerprintRecord
      && Date.now() - fingerprintRecord.openedAt < OPENED_NOTIFICATION_SUPPRESS_MS
    );
  }

  function findRecentActiveDuplicate(payload) {
    const fingerprint = buildActiveNotificationFingerprint(payload);
    if (!fingerprint) {
      return null;
    }

    const now = Date.now();
    for (const record of activeNotifications.values()) {
      if (!record || record.isClosing) {
        continue;
      }

      if (
        buildActiveNotificationFingerprint(record.payload) === fingerprint
        && now - record.createdAt <= ACTIVE_DUPLICATE_SUPPRESS_MS
      ) {
        return record;
      }
    }

    return null;
  }

  function repositionOverlays() {
    const display = screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const records = Array.from(activeNotifications.values())
      .filter((record) => record.overlayWindow && !record.overlayWindow.isDestroyed())
      .sort((left, right) => left.createdAt - right.createdAt);

    const stackOffsets = new Map();
    const stackHeight = records.reduce((height, record) => {
      return height + overlayDimensions(record.payload.customization || {}, workArea).height + OVERLAY_GAP;
    }, -OVERLAY_GAP);
    records.forEach((record) => {
      const custom = record.payload.customization || {};
      const { width, height } = overlayDimensions(custom, workArea);
      const position = custom.position || 'bottom-right';
      // Type-specific corners stack independently; a left-side message must
      // not leave an empty gap beneath unrelated right-side orders.
      const stackOffset = stackOffsets.get(position) || 0;
      const x = Math.round(position === 'center' ? workArea.x + (workArea.width - width) / 2 : position.endsWith('left') ? workArea.x + OVERLAY_MARGIN : workArea.x + workArea.width - width - OVERLAY_MARGIN);
      const y = Math.round(position === 'center' ? workArea.y + (workArea.height - stackHeight) / 2 + stackOffset : position.startsWith('top') ? workArea.y + OVERLAY_MARGIN + stackOffset : workArea.y + workArea.height - height - OVERLAY_MARGIN - stackOffset);
      stackOffsets.set(position, stackOffset + height + OVERLAY_GAP);
      record.overlayWindow.setBounds({
        x,
        y: Math.max(workArea.y + OVERLAY_MARGIN, y),
        width,
        height
      });
    });
  }

  function closeRecord(record) {
    if (!record) {
      return;
    }

    record.isClosing = true;
    clearTimeout(record.durationTimer);
    if (record.overlayWindow && !record.overlayWindow.isDestroyed()) {
      record.overlayWindow.close();
    }
    record.overlayWindow = null;
  }

  function makeRoomForCompactOverlay() {
    if (activeNotifications.size < MAX_VISIBLE_OVERLAYS) {
      return;
    }

    const oldestRecord = Array.from(activeNotifications.values())
      .filter((record) => !record.isClosing)
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!oldestRecord) {
      return;
    }

    // 2026-09-09: Background bursts used to fill small laptop screens with large cards.
    // Keep the newest three direct targets visible; every request remains available in the panel.
    activeNotifications.delete(oldestRecord.payload.id);
    closeRecord(oldestRecord);
    writeLog('notification compact stack limit replaced oldest overlay', {
      removedId: oldestRecord.payload.id,
      removedCategory: oldestRecord.payload.category,
      maxVisibleOverlays: MAX_VISIBLE_OVERLAYS
    });
  }

  function openNotification(notificationId) {
    const record = activeNotifications.get(notificationId);
    if (!record) {
      return;
    }

    activeNotifications.delete(notificationId);
    rememberOpenedNotification(record.payload);
    closeRecord(record);
    stopSound('notification_open');
    writeLog('notification acknowledged by open', {
      id: record.payload.id,
      category: record.payload.category,
      count: record.payload.count,
      requestId: record.payload.requestId || null,
      acknowledgementKey: record.payload.acknowledgementKey || null
    });
    onNotificationOpened({
      id: record.payload.id,
      category: record.payload.category,
      count: record.payload.count,
      requestId: record.payload.requestId || null,
      acknowledgementKey: record.payload.acknowledgementKey || null
    });
    emitChange();
    repositionOverlays();
    focusApp();
    if (record.payload.url) {
      // Deliver the acknowledgement to the React panel before navigation can
      // replace its renderer state.
      setTimeout(() => openInApp(record.payload.url), 75);
    }
  }

  ipcMain.removeAllListeners(OVERLAY_CHANNEL_OPEN);
  ipcMain.on(OVERLAY_CHANNEL_OPEN, (_event, notificationId) => {
    if (notificationId === previewId) { if (_event.sender === previewRecord?.overlayWindow?.webContents) closeCustomizationPreview(); return; }
    openNotification(String(notificationId || ''));
  });

  ipcMain.removeAllListeners(OVERLAY_CHANNEL_MINIMIZE);
  ipcMain.on(OVERLAY_CHANNEL_MINIMIZE, (_event, notificationId) => {
    if (notificationId === previewId) { if (_event.sender === previewRecord?.overlayWindow?.webContents) closeCustomizationPreview(); return; }
    const record = activeNotifications.get(String(notificationId || ''));
    if (!record) {
      return;
    }

    activeNotifications.delete(record.payload.id);
    closeRecord(record);
    minimizedNotificationIds.add(record.payload.id);
    stopSound('notification_minimized_to_panel');
    writeLog('notification minimized to panel', {
      id: record.payload.id,
      category: record.payload.category,
      requestId: record.payload.requestId || null
    });
    onNotificationMinimized({
      id: record.payload.id,
      category: record.payload.category,
      requestId: record.payload.requestId || null
    });
    emitChange();
    repositionOverlays();
  });

  function createOverlayWindow(record) {
    const overlayWindow = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      webPreferences: {
        preload: overlayPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    overlayWindow.setMenuBarVisibility(false);
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    overlayWindow.once('ready-to-show', () => {
      if (record.isClosing || overlayWindow.isDestroyed()) return;
      writeLog('notification overlay ready', {
        id: record.payload.id,
        title: record.payload.title,
        category: record.payload.category
      });
      if (record.preview) placePreview(); else repositionOverlays();
      overlayWindow.showInactive();
      overlayWindow.moveTop();
      // 2026-10-13: Count visibility duration from ready/show, not from slow
      // window creation. Preview uses the same window/timer without pending IDs.
      armDuration(record);
    });

    overlayWindow.on('closed', () => {
      record.overlayWindow = null;
      if (record.preview) { clearTimeout(record.durationTimer); if (previewRecord === record) previewRecord = null; return; }
      if (!record.isClosing) {
        activeNotifications.delete(record.payload.id);
        emitChange();
        repositionOverlays();
      }
    });

    overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildOverlayHtml({
      ...record.payload,
      reservationIconUrl,
      housekeepingIconUrl,
      clockIconUrl,
      notificationsIconUrl
    }))}`);
    return overlayWindow;
  }

  function showNotification(payload = {}) {
    const normalized = sanitizeNotificationPayload(payload);
    normalized.customization = resolveCustomization(normalized.category);
    if (normalized.customization.position === 'existing') delete normalized.customization.position;
    payload = { ...payload, ...Object.fromEntries(['profile', 'soundTone', 'volume'].filter(key => normalized.customization[key] !== undefined).map(key => [key, normalized.customization[key]])) };
    if (normalized.customization.volume === 0) normalized.playSound = false;
    if (minimizedNotificationIds.has(normalized.id)) {
      writeLog('notification suppressed after minimize to panel', {
        id: normalized.id,
        category: normalized.category
      });
      return {
        shown: false,
        id: normalized.id,
        reason: 'minimized_to_panel'
      };
    }
    if (shouldSuppressRecentlyOpenedNotification(normalized)) {
      writeLog('notification suppressed after open', {
        id: normalized.id,
        category: normalized.category,
        count: normalized.count
      });
      return {
        shown: false,
        id: normalized.id,
        reason: 'recently_opened'
      };
    }

    if (!shouldShowOverlay(normalized)) {
      const soundResult = normalized.playSound
        ? playSound(buildNotificationSoundOptions(normalized, payload))
        : { played: false, reason: 'disabled_for_payload' };
      writeLog('notification kept in visible panel', {
        id: normalized.id,
        category: normalized.category,
        detailLabel: normalized.detailLabel,
        sound: soundResult?.played ? 'played' : soundResult?.reason || 'not_played'
      });
      return {
        shown: false,
        id: normalized.id,
        reason: 'panel_visible',
        overlay: false
      };
    }

    const existing = activeNotifications.get(normalized.id);
    const isDetailEnrichment = existing
      && Boolean(normalized.detailLabel)
      && normalized.detailLabel !== existing.payload.detailLabel
      && payload?.bridgeSource === 'page-direct-detail-enrichment';
    if (existing && !isDetailEnrichment) {
      writeLog('notification duplicate suppressed', {
        id: normalized.id,
        activeId: existing.payload.id,
        category: normalized.category,
        count: normalized.count,
        reason: 'active_notification_id'
      });
      return {
        shown: false,
        id: normalized.id,
        reason: 'active_notification_id'
      };
    }
    const activeDuplicate = findRecentActiveDuplicate(normalized);
    if (activeDuplicate && !isDetailEnrichment) {
      writeLog('notification duplicate suppressed', {
        id: normalized.id,
        activeId: activeDuplicate.payload.id,
        category: normalized.category,
        count: normalized.count,
        ageMs: Date.now() - activeDuplicate.createdAt
      });
      return {
        shown: false,
        id: normalized.id,
        reason: 'active_duplicate'
      };
    }

    if (existing) {
      activeNotifications.delete(normalized.id);
      closeRecord(existing);
    }

    // A category is one desktop attention lane. When a newer request arrives
    // for the same lane, keep its overlay current instead of stacking stale
    // cards from that category in the bottom-right corner.
    for (const record of activeNotifications.values()) {
      if (record.payload.category !== normalized.category) {
        continue;
      }
      activeNotifications.delete(record.payload.id);
      closeRecord(record);
      writeLog('notification category overlay replaced', {
        previousId: record.payload.id,
        nextId: normalized.id,
        category: normalized.category
      });
    }

    makeRoomForCompactOverlay();

    const record = {
      payload: normalized,
      overlayWindow: null,
      createdAt: Date.now(),
      isClosing: false
    };

    activeNotifications.set(normalized.id, record);
    record.overlayWindow = createOverlayWindow(record);
    const soundResult = normalized.playSound
      ? playSound(buildNotificationSoundOptions(normalized, payload))
      : { played: false, reason: 'disabled_for_payload' };
    writeLog('notification shown', {
      id: normalized.id,
      title: normalized.title,
      category: normalized.category,
      detailLabel: normalized.detailLabel,
      origin: payload?.bridgeSource || 'native_poller_or_unknown',
      requestId: normalized.requestId || null,
      acknowledgementKey: normalized.acknowledgementKey || null,
      overlay: true,
      native: false,
      sound: soundResult?.played ? 'played' : soundResult?.reason || 'not_played'
    });
    emitChange();
    repositionOverlays();

    return {
      shown: true,
      id: normalized.id,
      overlay: true,
      native: false
    };
  }

  function clearAll() {
    closeCustomizationPreview();
    const hadNotifications = activeNotifications.size > 0;
    for (const record of activeNotifications.values()) {
      closeRecord(record);
    }
    activeNotifications.clear();
    if (hadNotifications) {
      stopSound('notification_clear_all');
    }
    emitChange();
  }

  function getState() {
    return {
      activeCount: activeNotifications.size,
      activeIds: Array.from(activeNotifications.keys())
    };
  }

  function dismissNotification({ id, category } = {}) {
    const notificationId = normalizeText(id);
    const normalizedCategory = normalizeCategory(category);
    const record = activeNotifications.get(notificationId);
    if (record) {
      activeNotifications.delete(notificationId);
      closeRecord(record);
    }
    minimizedNotificationIds.delete(notificationId);
    recentlyOpenedNotifications.delete(notificationId);
    for (const [fingerprint, opened] of recentlyOpenedFingerprints.entries()) {
      if (opened?.id === notificationId) {
        recentlyOpenedFingerprints.delete(fingerprint);
      }
    }
    writeLog('notification dismissed after pending resolved', { id: notificationId, category: normalizedCategory });
    emitChange();
    repositionOverlays();
  }

  function acknowledgeNotification({ id, category, requestId } = {}) {
    const notificationId = normalizeText(id);
    const normalizedCategory = normalizeCategory(category);
    const normalizedRequestId = normalizeText(requestId);
    const records = [];
    const directRecord = activeNotifications.get(notificationId);

    if (directRecord) {
      records.push(directRecord);
    }

    for (const record of activeNotifications.values()) {
      const hasSameRequest = normalizedRequestId
        && record.payload.requestId === normalizedRequestId;
      if (record !== directRecord && hasSameRequest) {
        records.push(record);
      }
    }

    if (records.length === 0 && normalizedCategory) {
      for (const record of activeNotifications.values()) {
        if (record.payload.category === normalizedCategory) {
          records.push(record);
        }
      }
    }

    for (const record of records) {
      activeNotifications.delete(record.payload.id);
      rememberOpenedNotification(record.payload);
      closeRecord(record);
    }

    if (records.length > 0) {
      stopSound('notification_acknowledged_from_panel');
      writeLog('notification acknowledged from panel', {
        id: notificationId || null,
        category: normalizedCategory || null,
        requestId: normalizedRequestId || null,
        dismissedCount: records.length
      });
      emitChange();
      repositionOverlays();
    }

    return { acknowledged: records.length > 0, dismissedCount: records.length };
  }

  return {
    showCustomizationPreview,
    closeCustomizationPreview,
    setCustomization,
    showNotification,
    dismissNotification,
    acknowledgeNotification,
    clearAll,
    getState
  };
}

module.exports = {
  createNativeNotificationService
};
