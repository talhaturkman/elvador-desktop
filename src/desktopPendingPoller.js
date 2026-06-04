const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_REMINDER_INTERVAL_MS = 60000;

const CATEGORY_COPY = {
  liveSupport: { title: 'Destek Bildirimi', label: 'destek talebi', sourceLabel: 'Destek', sourceInitials: 'DS' },
  reservation: { title: 'Rezervasyon Bildirimi', label: 'rezervasyon talebi', sourceLabel: 'Rezervasyon', sourceInitials: 'RZ' },
  housekeeping: { title: 'Kat Hizmetleri Bildirimi', label: 'kat hizmetleri talebi', sourceLabel: 'Kat Hizmetleri', sourceInitials: 'HK' },
  technic: { title: 'Teknik Bildirimi', label: 'teknik talep', sourceLabel: 'Teknik', sourceInitials: 'TK' },
  orders: { title: 'Sipariş Bildirimi', label: 'sipariş talebi', sourceLabel: 'Sipariş', sourceInitials: 'SP' },
  upsell: { title: 'Upsell Bildirimi', label: 'upsell talebi', sourceLabel: 'Upsell', sourceInitials: 'UP' },
  spa: { title: 'Spa Bildirimi', label: 'spa talebi', sourceLabel: 'Spa', sourceInitials: 'SP' },
  lostAndFound: { title: 'Kayıp Eşya Bildirimi', label: 'kayıp eşya talebi', sourceLabel: 'Kayıp Eşya', sourceInitials: 'KE' },
  conversation: { title: 'Sohbet Bildirimi', label: 'sohbet bildirimi', sourceLabel: 'Sohbet', sourceInitials: 'SH' }
};

function buildSourceUrl(brand, tab) {
  const brandPart = String(brand || '').trim();
  const tabPart = String(tab || '').trim();
  const adminPath = brandPart ? `/${brandPart}/admin` : '/admin';
  return tabPart ? `${adminPath}?tab=${encodeURIComponent(tabPart)}` : adminPath;
}

function createDesktopPendingPoller({
  apiBaseUrl,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  reminderIntervalMs = DEFAULT_REMINDER_INTERVAL_MS,
  showNotification,
  onStateChange = () => {}
}) {
  let authToken = null;
  let brand = null;
  let timerId = null;
  let inFlight = false;
  let stopped = true;
  let hasCompletedInitialPoll = false;
  let previousCounts = new Map();
  let lastNotificationAtBySource = new Map();
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

  function makeNotification(source, totalBrand) {
    const copy = CATEGORY_COPY[source.category] || CATEGORY_COPY.liveSupport;
    return {
      id: source.key || `${source.category}:${totalBrand || 'default'}`,
      category: source.category,
      sourceLabel: copy.sourceLabel,
      sourceInitials: copy.sourceInitials,
      count: source.count,
      oldestRequestedAt: source.oldestRequestedAt,
      title: copy.title,
      body: `${source.count} bekleyen ${copy.label}`,
      url: buildSourceUrl(totalBrand, source.tab),
      persist: true
    };
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
      const now = Date.now();
      let totalPending = 0;

      sources.forEach((source) => {
        const sourceKey = source.key || `${source.category}:${source.tab}`;
        const nextCount = Math.max(0, Number(source.count) || 0);
        const previousCount = previousCounts.get(sourceKey) || 0;
        const lastNotificationAt = lastNotificationAtBySource.get(sourceKey) || 0;
        const reminderDue = now - lastNotificationAt >= reminderIntervalMs;
        nextCounts.set(sourceKey, nextCount);
        totalPending += nextCount;

        if (nextCount > 0 && (!hasCompletedInitialPoll || nextCount > previousCount || reminderDue)) {
          const result = showNotification(makeNotification({ ...source, key: sourceKey, count: nextCount }, payload.brand || brand));
          if (!result || result.shown !== false) {
            lastNotificationAtBySource.set(sourceKey, now);
          }
        }
      });

      for (const sourceKey of lastNotificationAtBySource.keys()) {
        if (!nextCounts.has(sourceKey)) {
          lastNotificationAtBySource.delete(sourceKey);
        }
      }

      previousCounts = nextCounts;
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
        lastNotificationAtBySource = new Map();
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
      lastNotificationAtBySource = new Map();
      lastTotalPending = 0;
      hasCompletedInitialPoll = false;
    }

    scheduleNext(200);
  }

  function stop() {
    stopped = true;
    authToken = null;
    previousCounts = new Map();
    lastNotificationAtBySource = new Map();
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

  return {
    start,
    stop,
    poll,
    getState
  };
}

module.exports = {
  createDesktopPendingPoller
};
