const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_REMINDER_INTERVAL_MS = 300000;
const PAGE_DIRECT_DEDUPLICATION_MS = 45000;

const CATEGORY_COPY = {
  liveSupport: { title: 'Destek Bildirimi', label: 'destek talebi', sourceLabel: 'Destek', sourceInitials: 'DS' },
  reservation: { title: 'Rezervasyon Bildirimi', label: 'rezervasyon talebi', sourceLabel: 'Rezervasyon', sourceInitials: 'RZ' },
  housekeeping: { title: 'Kat Hizmetleri Bildirimi', label: 'kat hizmetleri talebi', sourceLabel: 'Kat Hizmeti', sourceInitials: 'HK' },
  technic: { title: 'Teknik Bildirimi', label: 'teknik talep', sourceLabel: 'Teknik', sourceInitials: 'TK' },
  orders: { title: 'Sipariş Bildirimi', label: 'sipariş talebi', sourceLabel: 'Sipariş', sourceInitials: 'SP' },
  ordersReservations: { title: 'Masa Rezervasyonu Bildirimi', label: 'masa rezervasyonu', sourceLabel: 'Yemek Rez.', sourceInitials: 'MR' },
  upsell: { title: 'Upsell Bildirimi', label: 'upsell talebi', sourceLabel: 'Upsell', sourceInitials: 'UP' },
  spa: { title: 'Spa Bildirimi', label: 'spa talebi', sourceLabel: 'Spa', sourceInitials: 'SP' },
  lostAndFound: { title: 'Kayıp Eşya Bildirimi', label: 'kayıp eşya talebi', sourceLabel: 'Kayıp Eşya', sourceInitials: 'KE' },
  conversation: { title: 'Sohbet Bildirimi', label: 'sohbet bildirimi', sourceLabel: 'Sohbet', sourceInitials: 'SH' }
};

function coerceTimestampMs(value) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getPendingItemKey(sourceKey, item, index) {
  const requestId = String(item?.id || item?.requestId || '').trim();
  return requestId
    ? `${sourceKey}:${requestId}`
    : `${sourceKey}:unknown:${item?.requestedAt || index}`;
}

function buildSourceUrl(brand, tab) {
  const brandPart = String(brand || '').trim();
  const tabPart = String(tab || '').trim();
  const adminPath = brandPart ? `/${brandPart}/admin` : '/admin';
  return tabPart ? `${adminPath}?tab=${encodeURIComponent(tabPart)}` : adminPath;
}

function formatHousekeepingSubject(value) {
  const subject = String(value || '')
    .trim()
    .replace(/^(?:odama|odaya|odam için)\s+/i, '')
    .replace(/[\s,.!?]+$/, '')
    .replace(/^(.+?)\s+(?:istiyorum|isterim|rica(?:\s+ediyorum|\s+ederim)?)\s+(\d+)\s*(?:adet|tane)\b/i, '$2 Adet $1')
    .replace(/\s+(?:(?:gönder|getir|ver)(?:ilmesini|ilmesi|ilebilir\s+misiniz|ebilir\s+misiniz|ir\s+misiniz|in)?|rica(?:\s+ediyorum|\s+ederim)?|istiyorum|isterim|lütfen|lazım(?:\s+ya)?|lazim(?:\s+ya)?|gerekiyor|gerekli)$/i, '')
    .trim();

  return subject
    .split(/\s+/)
    .map((word) => word.toLocaleLowerCase('tr-TR') === 'wc'
      ? 'WC'
      : `${word.charAt(0).toLocaleUpperCase('tr-TR')}${word.slice(1).toLocaleLowerCase('tr-TR')}`)
    .join(' ');
}

function buildServiceDetailLabel(item, category) {
  const rawSubject = String(item?.serviceSubject || '').trim();
  const serviceSubject = category === 'housekeeping'
    ? formatHousekeepingSubject(rawSubject)
    : rawSubject;
  return serviceSubject;
}

function getReservationGuestName(item) {
  const directName = String(
    item?.guestName
    || item?.fullName
    || item?.customerName
    || item?.guest?.fullName
    || item?.guest?.guestName
    || item?.guest?.name
    || item?.customer?.fullName
    || item?.customer?.name
    || item?.reservation?.guestName
    || item?.reservation?.fullName
    || item?.restaurantReservation?.guestName
    || item?.restaurantReservation?.fullName
    || ''
  ).trim();
  if (directName) {
    return directName;
  }

  const summary = String(
    item?.notificationSummary
    || item?.translatedMessage
    || item?.message
    || item?.description
    || ''
  );
  return String(summary.match(/(?:^|\||\s)(?:name=|Guest:\s*)([^|\r\n]+)/i)?.[1] || '').trim();
}

function createDesktopPendingPoller({
  apiBaseUrl,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  reminderIntervalMs = DEFAULT_REMINDER_INTERVAL_MS,
  showNotification,
  dismissNotification = () => {},
  writeLog = () => {},
  onStateChange = () => {}
}) {
  let authToken = null;
  let brand = null;
  let timerId = null;
  let inFlight = false;
  let stopped = true;
  let hasCompletedInitialPoll = false;
  let previousCounts = new Map();
  let previousSources = new Map();
  let previousPendingItemKeys = new Map();
  let lastNotificationAtById = new Map();
  let recentlyDirectNotifiedAtById = new Map();
  let acknowledgedPendingIds = new Set();
  let lastError = null;
  let lastPollAt = null;
  let lastTotalPending = 0;

  function emitState() {
    onStateChange({
      active: Boolean(authToken) && !stopped,
      brand,
      lastError,
      lastPollAt,
      pollIntervalMs,
      reminderIntervalMs,
      totalPending: lastTotalPending
    });
  }

  function clearTimer() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function scheduleNext(delayMs = pollIntervalMs) {
    clearTimer();
    if (stopped || !authToken) {
      emitState();
      return;
    }

    timerId = setTimeout(() => {
      void poll();
    }, delayMs);
    emitState();
  }

  function pruneRecentlyDirectNotified(now = Date.now()) {
    for (const [notificationId, notifiedAt] of recentlyDirectNotifiedAtById.entries()) {
      if (now - notifiedAt > PAGE_DIRECT_DEDUPLICATION_MS) {
        recentlyDirectNotifiedAtById.delete(notificationId);
      }
    }
  }

  function makeNotification(source, item, totalBrand) {
    const copy = CATEGORY_COPY[source.category] || CATEGORY_COPY.liveSupport;
    const sourceKey = source.key || `${source.category}:${source.tab}`;
    const notificationId = getPendingItemKey(sourceKey, item, 0);
    return {
      id: notificationId,
      category: source.category,
      sourceLabel: copy.sourceLabel,
      sourceInitials: copy.sourceInitials,
      count: 1,
      oldestRequestedAt: item?.requestedAt || item?.createdAt || source.oldestRequestedAt,
      roomNumber: item?.roomNumber || null,
      guestName: ['reservation', 'ordersReservations'].includes(source.category)
        ? getReservationGuestName(item)
        : item?.guestName || null,
      requestId: item?.id || item?.requestId || null,
      detailLabel: buildServiceDetailLabel(item, source.category),
      reservationLocation: item?.reservationLocation || null,
      acknowledgementKey: notificationId,
      title: copy.title,
      body: `${source.count} bekleyen ${copy.label}`,
      url: buildSourceUrl(totalBrand, source.tab),
      persist: true
    };
  }

  function showPendingNotifications(entries, totalBrand) {
    return entries.map(({ source, item }) => showNotification(
      makeNotification(source, item, totalBrand)
    ));
  }

  async function poll() {
    if (inFlight || stopped || !authToken) {
      scheduleNext();
      return;
    }

    inFlight = true;

    try {
      const response = await fetch(`${apiBaseUrl}/api/admin/desktop-notifications/pending`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: 'application/json'
        }
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error(`auth_${response.status}`);
      }

      if (!response.ok) {
        throw new Error(`http_${response.status}`);
      }

      const payload = await response.json();
      const sources = Array.isArray(payload.sources) ? payload.sources : [];
      const nextCounts = new Map();
      const nextSources = new Map();
      const nextPendingItemKeys = new Map();
      const newPendingEntries = [];
      const directBridgeSuppressedIds = [];
      const now = Date.now();
      pruneRecentlyDirectNotified(now);
      let totalPending = 0;

      sources.forEach((source) => {
        const sourceKey = source.key || `${source.category}:${source.tab}`;
        const nextCount = Math.max(0, Number(source.count) || 0);
        const previousCount = previousCounts.get(sourceKey) || 0;
        const previousItemKeys = previousPendingItemKeys.get(sourceKey) || new Set();
        const sourceItemKeys = new Set();
        nextCounts.set(sourceKey, nextCount);
        nextSources.set(sourceKey, { category: source.category, count: nextCount });
        (Array.isArray(source.items) ? source.items : []).forEach((item, index) => {
          const itemKey = getPendingItemKey(sourceKey, item, index);
          sourceItemKeys.add(itemKey);
          const directlyNotifiedAt = recentlyDirectNotifiedAtById.get(itemKey) || 0;
          const recentlyNotifiedByPage = now - directlyNotifiedAt <= PAGE_DIRECT_DEDUPLICATION_MS;
          if (hasCompletedInitialPoll && !previousItemKeys.has(itemKey) && !recentlyNotifiedByPage) {
            newPendingEntries.push({ source, item, index });
          } else if (hasCompletedInitialPoll && !previousItemKeys.has(itemKey) && recentlyNotifiedByPage) {
            // 2026-08-21: The panel bridge and native poller can observe one request seconds apart.
            // Preserve the first desktop alert; treating the poll result as new caused a second
            // bottom-right reservation overlay for the same request ID.
            directBridgeSuppressedIds.push(itemKey);
            lastNotificationAtById.set(itemKey, directlyNotifiedAt);
          }
        });
        nextPendingItemKeys.set(sourceKey, sourceItemKeys);
        totalPending += nextCount;

        for (const previousItemKey of previousItemKeys) {
          if (!sourceItemKeys.has(previousItemKey)) {
            dismissNotification({ id: previousItemKey, category: source.category });
            lastNotificationAtById.delete(previousItemKey);
            acknowledgedPendingIds.delete(previousItemKey);
            writeLog('pending notification resolved', { notificationId: previousItemKey, category: source.category });
          }
        }
      });

      for (const [sourceKey, previousSource] of previousSources.entries()) {
        const nextSource = nextSources.get(sourceKey);
        if (!nextSource || nextSource.count <= 0) {
          for (const notificationId of previousPendingItemKeys.get(sourceKey) || []) {
            dismissNotification({ id: notificationId, category: previousSource.category });
            lastNotificationAtById.delete(notificationId);
            acknowledgedPendingIds.delete(notificationId);
            writeLog('pending notification resolved', { notificationId, category: previousSource.category });
          }
        }
      }

      const allPendingEntries = sources.flatMap((source) => (
        Array.isArray(source.items) ? source.items.map((item, index) => ({ source, item, index })) : []
      ));
      const reminderEntries = allPendingEntries.filter(({ source, item, index }) => {
        const sourceKey = source.key || `${source.category}:${source.tab}`;
        const notificationId = getPendingItemKey(sourceKey, item, index);
        const lastNotificationAt = lastNotificationAtById.get(notificationId) || 0;
        return !acknowledgedPendingIds.has(notificationId)
          && now - lastNotificationAt >= reminderIntervalMs;
      });
      const reminderDue = reminderEntries.length > 0;
      if (newPendingEntries.length > 0) {
        showPendingNotifications(newPendingEntries, payload.brand || brand);
        newPendingEntries.forEach(({ source, item, index = 0 }) => {
          const sourceKey = source.key || `${source.category}:${source.tab}`;
          lastNotificationAtById.set(getPendingItemKey(sourceKey, item, index), now);
        });
      }

      if (reminderDue) {
        // 2026-08-21: A reminder belongs to the panel's single sound path.
        // The desktop poller used to turn the same pending request into a second
        // chime plus a new bottom-right overlay; it now records the candidate
        // only, so cards are reserved for requests that are newly observed.
        reminderEntries.forEach(({ source, item, index = 0 }) => {
          const sourceKey = source.key || `${source.category}:${source.tab}`;
          lastNotificationAtById.set(getPendingItemKey(sourceKey, item, index), now);
        });
      }

      writeLog('pending poll', {
        totalPending,
        trigger: newPendingEntries.length > 0 ? 'new_request' : reminderDue ? 'reminder_panel_only' : 'none',
        sources: sources.map((source) => ({ key: source.key || `${source.category}:${source.tab}`, category: source.category, count: Number(source.count) || 0 })),
        newPendingIds: newPendingEntries.map(({ source, item, index }) => getPendingItemKey(source.key || `${source.category}:${source.tab}`, item, index)),
        reminderIds: reminderEntries.map(({ source, item, index }) => getPendingItemKey(source.key || `${source.category}:${source.tab}`, item, index)),
        directBridgeSuppressedIds
      });

      previousCounts = nextCounts;
      previousSources = nextSources;
      previousPendingItemKeys = nextPendingItemKeys;
      brand = payload.brand || brand;
      lastPollAt = new Date().toISOString();
      lastTotalPending = totalPending;
      lastError = null;
      hasCompletedInitialPoll = true;
    } catch (error) {
      lastError = error?.message || 'poll_failed';
      if (lastError.startsWith('auth_')) {
        authToken = null;
        previousCounts = new Map();
        previousSources = new Map();
        previousPendingItemKeys = new Map();
        lastNotificationAtById = new Map();
        acknowledgedPendingIds = new Set();
        lastTotalPending = 0;
        hasCompletedInitialPoll = false;
      }
    } finally {
      inFlight = false;
      scheduleNext(lastError ? Math.min(pollIntervalMs * 2, 60000) : pollIntervalMs);
    }
  }

  function start(session = {}) {
    const nextToken = String(session.token || '').trim();
    if (!nextToken) {
      stop();
      return;
    }

    const tokenChanged = nextToken !== authToken;
    authToken = nextToken;
    brand = session.brand || session.user?.brand || brand;
    stopped = false;
    lastError = null;

    if (tokenChanged) {
      previousCounts = new Map();
      previousSources = new Map();
      previousPendingItemKeys = new Map();
      lastNotificationAtById = new Map();
      acknowledgedPendingIds = new Set();
      lastTotalPending = 0;
      hasCompletedInitialPoll = false;
    }

    scheduleNext(200);
  }

  function stop() {
    stopped = true;
    authToken = null;
    previousCounts = new Map();
    previousSources = new Map();
    previousPendingItemKeys = new Map();
    lastNotificationAtById = new Map();
    acknowledgedPendingIds = new Set();
    lastTotalPending = 0;
    hasCompletedInitialPoll = false;
    clearTimer();
    emitState();
  }

  function getState() {
    return {
      active: Boolean(authToken) && !stopped,
      brand,
      lastError,
      lastPollAt,
      pollIntervalMs,
      reminderIntervalMs,
      totalPending: lastTotalPending
    };
  }

  function acknowledgePendingNotification({ id, requestId, category } = {}) {
    const notificationId = String(id || '').trim();
    const normalizedRequestId = String(requestId || '').trim();
    const normalizedCategory = String(category || '').trim();
    const matchedIds = new Set();

    if (notificationId) {
      matchedIds.add(notificationId);
    }

    if (normalizedRequestId) {
      for (const [sourceKey, itemKeys] of previousPendingItemKeys.entries()) {
        const source = previousSources.get(sourceKey);
        if (normalizedCategory && source?.category !== normalizedCategory) {
          continue;
        }
        for (const itemKey of itemKeys) {
          if (itemKey.endsWith(`:${normalizedRequestId}`)) {
            matchedIds.add(itemKey);
          }
        }
      }
    }

    for (const matchedId of matchedIds) {
      acknowledgedPendingIds.add(matchedId);
    }

    if (matchedIds.size > 0) {
      writeLog('pending notification reminders suppressed after acknowledgement', {
        notificationIds: Array.from(matchedIds),
        category: normalizedCategory || null
      });
    }

    return { suppressedCount: matchedIds.size };
  }

  function registerDirectNotification({ id, requestId } = {}) {
    const notificationId = String(id || requestId || '').trim();
    if (!notificationId) {
      return { registered: false, reason: 'notification_id_missing' };
    }

    const notifiedAt = Date.now();
    pruneRecentlyDirectNotified(notifiedAt);
    recentlyDirectNotifiedAtById.set(notificationId, notifiedAt);
    writeLog('pending poller direct bridge registered', { notificationId });
    return { registered: true, notificationId };
  }

  return {
    start,
    stop,
    poll,
    acknowledgePendingNotification,
    registerDirectNotification,
    getState
  };
}

module.exports = {
  createDesktopPendingPoller
};
