const { contextBridge, ipcRenderer } = require('electron');

const PANEL_VISUAL_NOTIFICATION_SELECTOR = '.admin-visual-alert-ribbon';
const PANEL_VISUAL_NOTIFICATION_REMINDER_MS = 300000;
const PANEL_FALLBACK_SUPPRESS_AFTER_DIRECT_MS = 8000;

let lastSyncedSessionKey = null;
let lastPanelNotificationCount = 0;
let lastPanelNotificationSignature = '';
let lastPanelNotificationAt = 0;
let lastDirectNativeNotificationAt = 0;
let hasUsedDirectNativeBridge = false;
let panelNotificationObserver = null;
let panelNotificationEvaluateTimer = null;
const pendingDirectDetailPayloads = new Map();
let lastPanelDetailEnrichmentSignature = '';
const pendingNotificationOpenedPayloads = [];
let notificationOpenedListenerCount = 0;

function traceDesktopNotification(event, details = {}) {
  console.info('[DESKTOP_NOTIFICATION_TRACE]', {
    event,
    at: new Date().toISOString(),
    ...details
  });
}

function readStorageValue(storage, key) {
  try {
    return storage?.getItem(key) || null;
  } catch (_) {
    return null;
  }
}

function parseStoredJson(rawValue) {
  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue);
  } catch (_) {
    return null;
  }
}

function getStoredAdminSession() {
  const sessionStorageToken = readStorageValue(window.sessionStorage, 'adminToken');
  const legacyLocalStorageToken = readStorageValue(window.localStorage, 'adminToken');
  const token = sessionStorageToken || legacyLocalStorageToken;
  const rawUser = readStorageValue(window.sessionStorage, 'adminUser')
    || readStorageValue(window.localStorage, 'adminUser');
  const user = parseStoredJson(rawUser);

  return {
    token,
    user,
    brand: user?.brand || null,
    username: user?.username || null,
    role: user?.role || null
  };
}

function syncStoredAdminSession() {
  const session = getStoredAdminSession();
  const sessionKey = session.token
    ? `${session.token}:${session.username || ''}:${session.brand || ''}:${session.role || ''}`
    : '';

  if (sessionKey === lastSyncedSessionKey) {
    return;
  }

  lastSyncedSessionKey = sessionKey;
  if (session.token) {
    void ipcRenderer.invoke('elvador:sync-admin-session', session);
  } else {
    void ipcRenderer.invoke('elvador:clear-admin-session');
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKeyText(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0131/g, 'i')
    .replace(/\u0130/g, 'I')
    .toLowerCase();
}

function parsePendingCountFromText(value) {
  const text = normalizeText(value);
  const directMatch = text.match(/(\d+)\s+(?:Bekleyen|Pending)/i);
  if (directMatch) {
    return Number(directMatch[1]) || 0;
  }

  const parenthesizedMatch = text.match(/\((\d+)\)\s*(?:Bekleyen|Pending)/i);
  if (parenthesizedMatch) {
    return Number(parenthesizedMatch[1]) || 0;
  }

  const titleCountMatch = text.match(/^\((\d+)\)/);
  if (titleCountMatch && /Bekleyen|Pending/i.test(text)) {
    return Number(titleCountMatch[1]) || 0;
  }

  const firstNumberMatch = text.match(/(\d+)/);
  return firstNumberMatch ? Number(firstNumberMatch[1]) || 0 : 0;
}

function getPanelSourceInfo(rawLabel) {
  const key = normalizeKeyText(rawLabel);

  if (key === 'hk' || key.includes('housekeeping') || key.includes('kat')) {
    return { category: 'housekeeping', label: 'Kat hizmetleri', initials: 'HK' };
  }
  if (key.includes('teknik') || key.includes('technical') || key.includes('technic')) {
    return { category: 'technic', label: 'Teknik', initials: 'TK' };
  }
  if (key.includes('rezervasyon') || key.includes('reservation')) {
    return { category: 'reservation', label: 'Rezervasyon', initials: 'RZ' };
  }
  if (key.includes('siparis') || key.includes('order') || key.includes('f&b') || key.includes('yemek')) {
    return { category: 'orders', label: 'Sipariş', initials: 'SP' };
  }
  if (key.includes('upsell')) {
    return { category: 'upsell', label: 'Upsell', initials: 'UP' };
  }
  if (key.includes('spa')) {
    return { category: 'spa', label: 'Spa', initials: 'SP' };
  }
  if (key.includes('kayip') || key.includes('lost')) {
    return { category: 'lostAndFound', label: 'Kayıp eşya', initials: 'KE' };
  }
  if (key.includes('sohbet') || key.includes('conversation')) {
    return { category: 'conversation', label: 'Sohbet', initials: 'SH' };
  }
  if (key.includes('destek') || key.includes('support') || key.includes('live')) {
    return { category: 'liveSupport', label: 'Destek', initials: 'DS' };
  }

  const label = normalizeText(rawLabel) || 'Talep';
  return { category: 'panel-visual-notification', label, initials: label.slice(0, 2).toUpperCase() || 'EL' };
}

function normalizePayloadCategory(rawCategory) {
  const key = normalizeKeyText(rawCategory);
  if (key.includes('live') || key.includes('support')) return 'liveSupport';
  if (key.includes('reservation')) return 'reservation';
  if (key.includes('housekeeping') || key === 'hk') return 'housekeeping';
  if (key.includes('technic') || key.includes('technical')) return 'technic';
  if (key.includes('order')) return 'orders';
  if (key.includes('upsell')) return 'upsell';
  if (key.includes('spa')) return 'spa';
  if (key.includes('lost')) return 'lostAndFound';
  if (key.includes('conversation')) return 'conversation';
  return rawCategory || '';
}

function getCurrentPanelUrl() {
  try {
    return `${window.location.pathname || '/admin'}${window.location.search || ''}`;
  } catch (_) {
    return '/admin';
  }
}

function parsePanelChip(chip) {
  if (
    !chip
    || chip.classList?.contains('admin-visual-alert-ribbon__chip--more')
    || chip.classList?.contains('admin-visual-alert-ribbon__chip--seen')
  ) {
    return null;
  }

  const countText = normalizeText(chip.querySelector?.('.admin-visual-alert-ribbon__chip-count')?.textContent);
  const count = Number(countText.replace(/^\+/, '')) || 1;
  if (count <= 0) {
    return null;
  }

  const rawLabel = normalizeText(chip.querySelector?.('.admin-visual-alert-ribbon__chip-label')?.textContent)
    || normalizeText(chip.getAttribute?.('title')).replace(/^\d+\s+/, '')
    || 'Talep';
  const detailLabel = normalizeText(chip.querySelector?.('.admin-visual-alert-ribbon__chip-detail')?.textContent)
    .replace(/^\s*-\s*/, '');
  const sourceInfo = getPanelSourceInfo(rawLabel);
  return {
    ...sourceInfo,
    count,
    rawLabel,
    detailLabel,
    requestId: normalizeText(chip.getAttribute?.('data-request-id')),
    roomNumber: normalizeText(chip.getAttribute?.('data-room-number'))
  };
}

function getPanelVisualNotificationItems(element) {
  try {
    return Array.from(element.querySelectorAll('.admin-visual-alert-ribbon__chip'))
      .map(parsePanelChip)
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function parsePendingCountFromElement(element) {
  const chipTotal = getPanelVisualNotificationItems(element)
    .reduce((total, item) => total + item.count, 0);
  if (chipTotal > 0) {
    return chipTotal;
  }

  return parsePendingCountFromText(element?.getAttribute?.('aria-label') || element?.textContent);
}

function getPanelVisualNotificationContext() {
  const element = document.querySelector(PANEL_VISUAL_NOTIFICATION_SELECTOR);
  if (!element) {
    return null;
  }

  const items = getPanelVisualNotificationItems(element);
  const count = items.length > 0
    ? items.reduce((total, item) => total + item.count, 0)
    : parsePendingCountFromElement(element);
  if (count <= 0) {
    return null;
  }

  const ageLabel = normalizeText(element.querySelector('.admin-visual-alert-ribbon__age')?.textContent);
  const headline = normalizeText(element.querySelector('strong')?.textContent);
  const firstItem = items[0] || null;
  const summary = items.length > 0
    ? items.slice(0, 3).map((item) => `${item.count} ${item.label}`).join(' / ')
    : normalizeText(element.getAttribute('aria-label') || element.textContent);
  const sourceLabel = items.length === 1
    ? firstItem.label
    : items.length > 1
      ? `${items.length} kaynak`
      : 'Panel';
  const sourceInitials = items.length === 1
    ? firstItem.initials
    : String(count);
  const title = items.length === 1
    ? `${firstItem.label} Bildirimi`
    : 'Bekleyen Talepler';
  const ageText = ageLabel ? `${ageLabel} açık` : '';
  const body = [summary, ageText].filter(Boolean).join(' | ');
  const guestName = firstItem?.category === 'reservation' ? firstItem.detailLabel : '';
  const detailLabel = firstItem?.detailLabel || '';

  return {
    id: 'panel-visual-notification',
    category: firstItem?.category || 'panel-visual-notification',
    sourceLabel,
    sourceInitials,
    title,
    body,
    url: getCurrentPanelUrl(),
    persist: true,
    count,
    ageLabel,
    guestName,
    detailLabel,
    requestId: firstItem?.requestId || '',
    roomNumber: firstItem?.roomNumber || '',
    items
  };
}

function getPanelVisualNotificationPayload() {
  const context = getPanelVisualNotificationContext();
  if (context) {
    return context;
  }

  if (document.querySelector(PANEL_VISUAL_NOTIFICATION_SELECTOR)) {
    return null;
  }

  const titleText = normalizeText(document.title);
  const titleCount = parsePendingCountFromText(titleText);
  if (titleCount <= 0) {
    return null;
  }

  return {
    id: 'panel-visual-notification',
    category: 'panel-title-notification',
    sourceLabel: 'Panel',
    sourceInitials: String(titleCount),
    title: `${titleCount} bekleyen işlem`,
    body: titleText,
    url: getCurrentPanelUrl(),
    persist: true,
    count: titleCount
  };
}

function enrichNotificationPayloadFromPanel(payload = {}) {
  const context = getPanelVisualNotificationContext();
  if (!context) {
    return payload;
  }

  const payloadCategory = normalizePayloadCategory(payload.category);
  const matchingItem = context.items.find((item) => item.category === payloadCategory);
  if (!matchingItem && context.items.length !== 1) {
    return payload;
  }

  const sourceItem = matchingItem || context.items[0];
  return {
    ...payload,
    count: Number(payload.count) || sourceItem?.count || context.count,
    sourceLabel: payload.sourceLabel || sourceItem?.label || context.sourceLabel,
    sourceInitials: payload.sourceInitials || sourceItem?.initials || context.sourceInitials,
    ageLabel: payload.ageLabel || context.ageLabel,
    detailLabel: payload.detailLabel || sourceItem?.detailLabel || '',
    requestId: payload.requestId || sourceItem?.requestId || '',
    roomNumber: payload.roomNumber || sourceItem?.roomNumber || '',
    guestName: payload.guestName
      || (payloadCategory === 'reservation' ? sourceItem?.detailLabel : '')
      || context.guestName
  };
}

function queueDirectDetailEnrichment(payload) {
  if (!payload?.id || normalizeText(payload.detailLabel)) {
    return;
  }

  pendingDirectDetailPayloads.set(payload.id, payload);
}

function enrichQueuedDirectNotifications() {
  for (const [notificationId, payload] of pendingDirectDetailPayloads.entries()) {
    const enrichedPayload = enrichNotificationPayloadFromPanel({
      ...payload,
      bridgeSource: 'page-direct-detail-enrichment',
      playSound: false
    });
    if (!normalizeText(enrichedPayload.detailLabel)) {
      continue;
    }

    pendingDirectDetailPayloads.delete(notificationId);
    void ipcRenderer.invoke('elvador:show-native-notification', enrichedPayload)
      .then((result) => {
        traceDesktopNotification('page_direct_detail_enriched', {
          id: enrichedPayload.id,
          category: enrichedPayload.category,
          detailLabel: enrichedPayload.detailLabel,
          result
        });
      });
  }
}

function syncVisibleServiceDetailToNativeNotification() {
  const context = getPanelVisualNotificationContext();
  const item = context?.items?.length === 1 ? context.items[0] : null;
  const category = normalizePayloadCategory(item?.category);
  const detailLabel = normalizeText(item?.detailLabel);
  const brand = normalizeKeyText(getStoredAdminSession().brand);
  if (!detailLabel || !brand || !['housekeeping', 'technic'].includes(category)) {
    return;
  }

  const sourceId = `service:${brand}:${category}`;
  const signature = `${sourceId}:${item.count}:${detailLabel}`;
  if (signature === lastPanelDetailEnrichmentSignature) {
    return;
  }

  lastPanelDetailEnrichmentSignature = signature;
  void ipcRenderer.invoke('elvador:show-native-notification', {
    id: sourceId,
    category,
    count: item.count,
    sourceLabel: category === 'housekeeping' ? 'Kat Hizmeti' : item.label,
    sourceInitials: item.initials,
    title: context.title,
    body: context.body,
    url: getCurrentPanelUrl(),
    persist: true,
    playSound: false,
    detailLabel,
    requestId: item.requestId || '',
    roomNumber: item.roomNumber || '',
    bridgeSource: 'panel-visible-detail-sync'
  }).then((result) => {
    traceDesktopNotification('panel_visible_detail_synced', {
      id: sourceId,
      category,
      detailLabel,
      result
    });
  });
}

function isPanelFallbackSuppressedByDirectBridge() {
  return hasUsedDirectNativeBridge
    || Date.now() - lastDirectNativeNotificationAt <= PANEL_FALLBACK_SUPPRESS_AFTER_DIRECT_MS;
}

function shouldNotifyPanelVisualNotification(payload) {
  const now = Date.now();
  const signature = `${payload.count}:${payload.title}:${payload.body}:${payload.sourceLabel || ''}`;
  const countIncreased = payload.count > lastPanelNotificationCount;
  const firstSeen = lastPanelNotificationCount <= 0 && payload.count > 0;
  const reminderDue = payload.count > 0 && now - lastPanelNotificationAt >= PANEL_VISUAL_NOTIFICATION_REMINDER_MS;
  const meaningfulTextChanged = signature !== lastPanelNotificationSignature && now - lastPanelNotificationAt > 2500;
  const suppressedByDirectBridge = isPanelFallbackSuppressedByDirectBridge();

  lastPanelNotificationCount = payload.count;
  lastPanelNotificationSignature = signature;

  if (suppressedByDirectBridge) {
    lastPanelNotificationAt = now;
    traceDesktopNotification('panel_fallback_suppressed', {
      reason: 'recent_page_direct_notification',
      id: payload.id,
      category: payload.category,
      count: payload.count
    });
    return false;
  }

  if (firstSeen || countIncreased || reminderDue || meaningfulTextChanged) {
    lastPanelNotificationAt = now;
    traceDesktopNotification('panel_fallback_triggered', {
      id: payload.id,
      category: payload.category,
      count: payload.count,
      reason: firstSeen ? 'first_seen' : countIncreased ? 'count_increased' : reminderDue ? 'reminder_due' : 'meaningful_text_changed'
    });
    return true;
  }

  return false;
}

function evaluatePanelVisualNotification() {
  panelNotificationEvaluateTimer = null;
  enrichQueuedDirectNotifications();
  const payload = getPanelVisualNotificationPayload();
  if (!payload) {
    if (lastPanelNotificationCount > 0) {
      traceDesktopNotification('panel_pending_cleared', { previousCount: lastPanelNotificationCount });
    }
    lastPanelNotificationCount = 0;
    lastPanelNotificationSignature = '';
    return;
  }

  if (!shouldNotifyPanelVisualNotification(payload)) {
    return;
  }

  void ipcRenderer.invoke('elvador:show-native-notification', {
    ...payload,
    bridgeSource: 'panel-fallback',
    playSound: true
  }).then((result) => {
    traceDesktopNotification('panel_fallback_result', {
      id: payload.id,
      category: payload.category,
      count: payload.count,
      result
    });
  });
}

function schedulePanelVisualNotificationEvaluation(delayMs = 250) {
  if (panelNotificationEvaluateTimer) {
    clearTimeout(panelNotificationEvaluateTimer);
  }

  panelNotificationEvaluateTimer = setTimeout(evaluatePanelVisualNotification, delayMs);
}

function startPanelVisualNotificationObserver() {
  if (panelNotificationObserver || typeof MutationObserver === 'undefined') {
    return;
  }

  panelNotificationObserver = new MutationObserver(() => {
    schedulePanelVisualNotificationEvaluation();
  });

  panelNotificationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'class', 'title']
  });

  schedulePanelVisualNotificationEvaluation(900);
  window.setInterval(() => {
    schedulePanelVisualNotificationEvaluation(0);
  }, 2000);
  window.setInterval(() => {
    schedulePanelVisualNotificationEvaluation(0);
  }, PANEL_VISUAL_NOTIFICATION_REMINDER_MS);
}

function showNativeNotificationFromPage(payload = {}) {
  lastDirectNativeNotificationAt = Date.now();
  hasUsedDirectNativeBridge = true;
  const enrichedPayload = enrichNotificationPayloadFromPanel({
    ...payload,
    bridgeSource: 'page-direct',
    playSound: payload.playSound === true
  });
  queueDirectDetailEnrichment(enrichedPayload);
  traceDesktopNotification('page_direct_requested', {
    id: enrichedPayload.id,
    category: enrichedPayload.category,
    count: enrichedPayload.count,
    acknowledgementKey: enrichedPayload.acknowledgementKey || null
  });
  return ipcRenderer.invoke(
    'elvador:show-native-notification',
    enrichedPayload
  ).then((result) => {
    traceDesktopNotification('page_direct_result', {
      id: enrichedPayload.id,
      category: enrichedPayload.category,
      count: enrichedPayload.count,
      result
    });
    return result;
  });
}

function playNotificationSoundFromPage(options = {}) {
  return ipcRenderer.invoke('elvador:play-notification-sound', {
    ...options,
    source: options.source || 'page-direct'
  });
}

function stopNotificationSoundFromPage(reason = 'page-direct') {
  return ipcRenderer.invoke('elvador:stop-notification-sound', reason);
}

function acknowledgeNativeNotificationFromPage(payload = {}) {
  return ipcRenderer.invoke('elvador:acknowledge-native-notification', payload);
}

function onNotificationOpened(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }

  const handler = (event) => listener(event.detail || {});
  window.addEventListener('elvador-notification-opened', handler);
  notificationOpenedListenerCount += 1;

  while (pendingNotificationOpenedPayloads.length > 0) {
    listener(pendingNotificationOpenedPayloads.shift());
  }

  return () => {
    window.removeEventListener('elvador-notification-opened', handler);
    notificationOpenedListenerCount = Math.max(0, notificationOpenedListenerCount - 1);
  };
}

ipcRenderer.on('elvador:notification-opened', (_event, payload = {}) => {
  const detail = payload && typeof payload === 'object' ? payload : {};
  traceDesktopNotification('native_notification_opened_delivered', {
    id: detail.id || null,
    category: detail.category || null,
    requestId: detail.requestId || null
  });
  if (notificationOpenedListenerCount === 0) {
    pendingNotificationOpenedPayloads.push(detail);
  }
  window.dispatchEvent(new CustomEvent('elvador-notification-opened', { detail }));
});

function reportNotificationReadState(details = {}) {
  return ipcRenderer.invoke('elvador:notification-read-state-applied', details);
}

function reportWebDeployReloadFromSession() {
  try {
    const traceText = window.sessionStorage.getItem('__elvadorDesktopWebDeployReload');
    if (!traceText) {
      return;
    }

    window.sessionStorage.removeItem('__elvadorDesktopWebDeployReload');
    const trace = JSON.parse(traceText);
    const entry = {
      ...trace,
      event: 'renderer_reloaded',
      rendererLoadedAt: new Date().toISOString(),
      pageUrl: window.location.href
    };
    const previous = Array.isArray(window.__elvadorWebDeployDiagnostics)
      ? window.__elvadorWebDeployDiagnostics
      : [];
    previous.push(entry);
    window.__elvadorWebDeployDiagnostics = previous.slice(-40);
    console.info('[WEB_DEPLOY]', entry);
  } catch (error) {
    console.warn('[WEB_DEPLOY] renderer_reload_trace_failed', {
      message: error?.message || String(error)
    });
  }
}

contextBridge.exposeInMainWorld('elvadorDesktop', {
  isDesktopShell: true,
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke('elvador:get-desktop-info'),
  syncAdminSession: (session) => ipcRenderer.invoke('elvador:sync-admin-session', session),
  clearAdminSession: () => ipcRenderer.invoke('elvador:clear-admin-session'),
  saveAdminAccessLink: (value) => ipcRenderer.invoke('elvador:save-admin-access-link', value),
  showNativeNotification: showNativeNotificationFromPage,
  playNotificationSound: playNotificationSoundFromPage,
  stopNotificationSound: stopNotificationSoundFromPage,
  acknowledgeNativeNotification: acknowledgeNativeNotificationFromPage,
  onNotificationOpened,
  reportNotificationReadState
});

window.addEventListener('DOMContentLoaded', () => {
  reportWebDeployReloadFromSession();
  syncStoredAdminSession();
  window.setInterval(syncStoredAdminSession, 4000);
  window.dispatchEvent(new CustomEvent('elvador-desktop-ready'));
});
