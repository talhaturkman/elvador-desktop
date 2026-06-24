const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_REMINDER_INTERVAL_MS = 300000;

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

function coerceTimestampMs(value) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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
  let lastReminderNotificationAt = 0;
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

  function makeSummaryNotification(sources, totalPending, totalBrand) {
    const brandPart = totalBrand || brand;
    const visibleSources = sources
      .map((source) => ({
        ...source,
        count: Math.max(0, Number(source.count) || 0)
      }))
      .filter((source) => source.count > 0);
    const firstSource = visibleSources[0] || null;
    const firstCopy = firstSource ? (CATEGORY_COPY[firstSource.category] || CATEGORY_COPY.liveSupport) : null;
    const oldestTimestampMs = visibleSources.reduce((oldest, source) => {
      const timestampMs = coerceTimestampMs(source.oldestRequestedAt);
      if (!timestampMs) {
        return oldest;
      }
      return oldest === null || timestampMs < oldest ? timestampMs : oldest;
    }, null);
    const sourceSummary = visibleSources
      .slice(0, 3)
      .map((source) => {
        const copy = CATEGORY_COPY[source.category] || CATEGORY_COPY.liveSupport;
        return `${source.count} ${copy.sourceLabel}`;
      })
      .join(' / ');

    return {
      id: `pending-summary:${brandPart || 'default'}`,
      category: firstSource?.category || 'panel-visual-notification',
      sourceLabel: visibleSources.length === 1 && firstCopy ? firstCopy.sourceLabel : 'Panel',
      sourceInitials: visibleSources.length === 1 && firstCopy ? firstCopy.sourceInitials : String(totalPending),
      count: totalPending,
      oldestRequestedAt: oldestTimestampMs ? new Date(oldestTimestampMs).toISOString() : null,
      title: visibleSources.length === 1 && firstCopy ? firstCopy.title : 'Bekleyen Talepler',
      body: sourceSummary || `${totalPending} bekleyen talep`,
      url: buildSourceUrl(brandPart, visibleSources.length === 1 ? firstSource?.tab : ''),
      persist: true
    };
  }

  function showPendingNotification(sources, totalPending, totalBrand) {
    const visibleSources = sources.filter((source) => Math.max(0, Number(source.count) || 0) > 0);
    if (visibleSources.length === 0 || totalPending <= 0) {
      return null;
    }

    const notification = visibleSources.length === 1
      ? makeNotification(visibleSources[0], totalBrand)
      : makeSummaryNotification(visibleSources, totalPending, totalBrand);
    return showNotification(notification);
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
      let hasNotificationTrigger = false;
      let totalPending = 0;

      sources.forEach((source) => {
        const sourceKey = source.key || `${source.category}:${source.tab}`;
        const nextCount = Math.max(0, Number(source.count) || 0);
        const previousCount = previousCounts.get(sourceKey) || 0;
        nextCounts.set(sourceKey, nextCount);
        totalPending += nextCount;

        if (nextCount > 0 && (!hasCompletedInitialPoll || nextCount > previousCount)) {
          hasNotificationTrigger = true;
        }
      });

      const reminderDue = totalPending > 0 && now - lastReminderNotificationAt >= reminderIntervalMs;
      if (hasNotificationTrigger || reminderDue) {
        const result = showPendingNotification(
          sources,
          totalPending,
          payload.brand || brand
        );
        if (!result || result.shown !== false) {
          lastReminderNotificationAt = now;
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
        lastReminderNotificationAt = 0;
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
      lastReminderNotificationAt = 0;
      lastTotalPending = 0;
      hasCompletedInitialPoll = false;
    }

    scheduleNext(200);
  }

  function stop() {
    stopped = true;
    authToken = null;
    previousCounts = new Map();
    lastReminderNotificationAt = 0;
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
