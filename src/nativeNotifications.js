const { BrowserWindow, ipcMain, screen } = require('electron');

const OVERLAY_WIDTH = 320;
const OVERLAY_HEIGHT = 190;
const OVERLAY_MARGIN = 16;
const OVERLAY_GAP = 10;
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
    playSound: payload.playSound !== false && payload.silent !== true
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

function isOverlayIconSource(value) {
  const source = String(value || '').trim();
  return /^https?:\/\/[\w.-]+(?::\d+)?\//i.test(source)
    || /^data:image\/svg\+xml;base64,[a-z0-9+/]+=*$/i.test(source);
}

function buildOverlayHtml(notification) {
  const id = escapeHtml(notification.id);
  const title = escapeHtml(notification.title);
  const count = notification.count || 1;

  let cleanTitleType = title.replace(/bildirimi/i, '').replace(/talepleri/i, '').replace(/talebi/i, '').trim();
  if (cleanTitleType.toLowerCase().includes('destek')) {
    cleanTitleType = 'Destek';
  } else if (cleanTitleType.toLowerCase().includes('sohbet')) {
    cleanTitleType = 'Sohbet';
  } else if (cleanTitleType.toLowerCase().includes('rezervasyon')) {
    cleanTitleType = 'Rezervasyon';
  } else if (cleanTitleType.toLowerCase().includes('kat hizmetleri') || cleanTitleType.toLowerCase().includes('temizlik')) {
    cleanTitleType = 'Kat Hizmetleri';
  } else if (cleanTitleType.toLowerCase().includes('teknik')) {
    cleanTitleType = 'Teknik';
  } else if (cleanTitleType.toLowerCase().includes('sipariş') || cleanTitleType.toLowerCase().includes('yemek')) {
    cleanTitleType = 'Sipariş';
  } else if (cleanTitleType.toLowerCase().includes('upsell')) {
    cleanTitleType = 'Upsell';
  } else if (cleanTitleType.toLowerCase().includes('spa')) {
    cleanTitleType = 'Spa';
  } else if (cleanTitleType.toLowerCase().includes('kayıp')) {
    cleanTitleType = 'Kayıp Eşya';
  }

  const displayTitle = 'Bekleyen Talep';
  const roomValue = notification.roomNumber ? escapeHtml(notification.roomNumber) : '';
  const reservationGuestName = escapeHtml(notification.guestName);
  const isReservation = notification.category === 'reservation' || notification.category === 'ordersReservations';
  const serviceSourceLabel = notification.category === 'panelVisualNotification'
    ? ''
    : escapeHtml(notification.sourceLabel);
  const serviceRequestTitle = escapeHtml(notification.detailLabel);
  const rawRoomNumber = String(notification.roomNumber || '').trim();
  const rawDetailLabel = String(notification.detailLabel || '').trim().toLocaleLowerCase('tr-TR');
  const detailIncludesRoom = rawRoomNumber && (
    rawDetailLabel === rawRoomNumber.toLocaleLowerCase('tr-TR')
    || rawDetailLabel.startsWith(`oda ${rawRoomNumber.toLocaleLowerCase('tr-TR')}`)
    || rawDetailLabel.startsWith(`${rawRoomNumber.toLocaleLowerCase('tr-TR')} -`)
  );
  const requestTitle = isReservation
    ? ['Rezervasyon', reservationGuestName].filter(Boolean).join(' - ')
    : [serviceSourceLabel || cleanTitleType, detailIncludesRoom ? '' : roomValue, serviceRequestTitle].filter(Boolean).join(' - ');
  const requestDetail = isReservation
    ? ''
    : '';
  const sharedReservationIconUrl = isOverlayIconSource(notification.reservationIconUrl)
    ? escapeHtml(notification.reservationIconUrl)
    : '';
  const sharedHousekeepingIconUrl = isOverlayIconSource(notification.housekeepingIconUrl)
    ? escapeHtml(notification.housekeepingIconUrl)
    : '';
  const sharedClockIconUrl = isOverlayIconSource(notification.clockIconUrl)
    ? escapeHtml(notification.clockIconUrl)
    : '';
  const sharedNotificationsIconUrl = isOverlayIconSource(notification.notificationsIconUrl)
    ? escapeHtml(notification.notificationsIconUrl)
    : '';
  const requestIcon = isReservation
    ? (sharedReservationIconUrl
      ? `<img class="shared-reservation-icon" src="${sharedReservationIconUrl}" width="24" height="24" alt="">`
      : '<svg viewBox="0 0 24 24" fill="none" width="24" height="24" stroke-width="2.2"><path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/></svg>')
    : notification.category === 'housekeeping' && sharedHousekeepingIconUrl
      ? `<img class="shared-housekeeping-icon" src="${sharedHousekeepingIconUrl}" width="24" height="24" alt="">`
    : '<svg viewBox="0 0 24 24" fill="none" width="24" height="24" stroke-width="2.2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.121 2.121 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.77 3.77Z"/></svg>';
  const parsedOldestTimeEpoch = coerceTimestampMs(notification.oldestRequestedAt);
  const oldestTimeEpoch = Number.isFinite(parsedOldestTimeEpoch) && parsedOldestTimeEpoch > 0
    ? parsedOldestTimeEpoch
    : Date.now();

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${displayTitle}</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; user-select: none; }
      .n {
        width: 100vw;
        height: 100vh;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 18px;
        border-radius: 12px;
        background: rgba(220, 38, 38, 0.85);
        border: 1px solid rgba(255, 255, 255, 0.18);
        box-shadow: 0 4px 14px rgba(220, 38, 38, 0.25), 0 2px 6px rgba(0, 0, 0, 0.1);
        cursor: pointer;
        animation: notification-spawn 1150ms cubic-bezier(0.16, 1, 0.3, 1) both;
      }
      .headline {
        display: flex;
        align-items: center;
        width: 100%;
        height: 28px;
        gap: 10px;
        color: #fff;
      }
      .title {
        font-size: 23px;
        font-weight: 750;
        line-height: 28px;
        color: #ffffff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
      }
      .minimize-button {
        width: 40px;
        height: 40px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: #ffffff;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 40px;
        transition: background 160ms ease;
      }
      .minimize-button:hover, .minimize-button:focus-visible { background: rgba(255, 255, 255, 0.2); outline: none; }
      .divider { height: 1px; width: 100%; background: #ffffff; }
      .request-card {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 10px;
        padding: 14px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.92);
        color: #5f1024;
      }
      .request-line { display: flex; align-items: center; gap: 5px; min-width: 0; }
      .request-name { font-size: 16px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .request-title { font-weight: 700; }
      .request-detail { font-weight: 400; }
      .request-age { font-size: 16px; font-weight: 700; color: #5f1024; }
      .request-age--recent { color: #137333; font-weight: 400; }
      .request-age--critical { color: #dc2626; }
      .request-icon { flex: 0 0 24px; color: #5f1024; }
      .request-icon svg { display: block; stroke: currentColor; }
      .shared-reservation-icon { display: block; width: 24px; height: 24px; filter: brightness(0) saturate(100%) invert(11%) sepia(76%) saturate(2979%) hue-rotate(326deg) brightness(80%) contrast(100%); }
      .shared-housekeeping-icon { display: block; width: 24px; height: 24px; filter: brightness(0) saturate(100%) invert(11%) sepia(76%) saturate(2979%) hue-rotate(326deg) brightness(80%) contrast(100%); }
      .shared-clock-icon { display: block; width: 24px; height: 24px; filter: brightness(0) saturate(100%) invert(11%) sepia(76%) saturate(2979%) hue-rotate(326deg) brightness(80%) contrast(100%); }
      .headline-icon { display: flex; flex: 0 0 24px; width: 24px; height: 24px; align-items: center; justify-content: center; }
      .headline-icon svg { display: block; stroke: currentColor; }
      .headline-icon .shared-notifications-icon { display: block; width: 24px; height: 24px; filter: brightness(0) invert(1); transform: translateY(1px); }
      @keyframes notification-spawn {
        from { opacity: 0; translate: 0 calc(100vh + 32px); }
        to { opacity: 1; translate: 0 0; }
      }
    </style>
  </head>
  <body>
    <main class="n" role="button" tabindex="0" data-id="${id}">
      <div class="headline">
        <span class="headline-icon" aria-hidden="true">
          ${sharedNotificationsIconUrl
            ? `<img class="shared-notifications-icon" src="${sharedNotificationsIconUrl}" width="24" height="24" alt="">`
            : '<svg viewBox="0 0 24 24" fill="none" width="24" height="24" stroke-width="2.1"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>'}
        </span>
        <span class="title">${displayTitle}</span>
        <button class="minimize-button" type="button" aria-label="Merkez bildirime küçült">
          <svg viewBox="0 0 24 24" fill="none" width="26" height="26" stroke="currentColor" stroke-width="2.7"><path d="m6 6 12 12M18 6 6 18"/></svg>
        </button>
      </div>
      <div class="divider" aria-hidden="true"></div>
      <div class="request-card">
        <div class="request-line">
          <span class="request-icon" aria-hidden="true">${requestIcon}</span>
          <span class="request-name"><span class="request-title">${requestTitle}</span>${requestDetail ? `<span class="request-detail"> - ${requestDetail}</span>` : ''}</span>
        </div>
        <div class="request-line">
          <span class="request-icon" aria-hidden="true">${sharedClockIconUrl
            ? `<img class="shared-clock-icon" src="${sharedClockIconUrl}" width="24" height="24" alt="">`
            : '<svg viewBox="0 0 24 24" fill="none" width="24" height="24" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'}</span>
          <span class="request-age request-age--recent" id="time-elapsed">Az önce</span>
        </div>
      </div>
    </main>
    <script>
      const open = () => window.elvadorOverlay.open("${id}");
      const minimize = (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.elvadorOverlay.minimize("${id}");
      };
      document.body.addEventListener('click', open);
      document.querySelector('.minimize-button').addEventListener('click', minimize);
      document.body.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
      });

      const oldestTime = ${oldestTimeEpoch};
      const criticalAgeMs = 5 * 60 * 1000;
      const updateTime = () => {
        const elapsedMs = Date.now() - oldestTime;
        const ageElement = document.getElementById('time-elapsed');
        ageElement.classList.toggle('request-age--recent', elapsedMs < 60000);
        ageElement.classList.toggle('request-age--critical', elapsedMs >= criticalAgeMs);
        if (elapsedMs < 60000) {
          ageElement.innerText = 'Az önce';
          return;
        }

        const minutes = Math.floor(elapsedMs / 60000);
        if (minutes < 60) {
          ageElement.innerText = minutes + ' dk önce';
          return;
        }

        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        ageElement.innerText = remainingMinutes > 0
          ? hours + ' sa ' + remainingMinutes + ' dk önce'
          : hours + ' sa önce';
      };
      updateTime();
      setInterval(updateTime, 1000);
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

    records.forEach((record, index) => {
      const x = Math.round(workArea.x + workArea.width - OVERLAY_WIDTH - OVERLAY_MARGIN);
      const y = Math.round(workArea.y + workArea.height - OVERLAY_HEIGHT - OVERLAY_MARGIN - (index * (OVERLAY_HEIGHT + OVERLAY_GAP)));
      record.overlayWindow.setBounds({
        x,
        y: Math.max(workArea.y + OVERLAY_MARGIN, y),
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT
      });
    });
  }

  function closeRecord(record) {
    if (!record) {
      return;
    }

    record.isClosing = true;
    if (record.overlayWindow && !record.overlayWindow.isDestroyed()) {
      record.overlayWindow.close();
    }
    record.overlayWindow = null;
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
    openNotification(String(notificationId || ''));
  });

  ipcMain.removeAllListeners(OVERLAY_CHANNEL_MINIMIZE);
  ipcMain.on(OVERLAY_CHANNEL_MINIMIZE, (_event, notificationId) => {
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
      writeLog('notification overlay ready', {
        id: record.payload.id,
        title: record.payload.title,
        category: record.payload.category
      });
      repositionOverlays();
      overlayWindow.showInactive();
      overlayWindow.moveTop();
    });

    overlayWindow.on('closed', () => {
      record.overlayWindow = null;
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
