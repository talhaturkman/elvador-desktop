const http = require('http');
const https = require('https');

const DEFAULT_PREFETCH_INTERVAL_MS = 300000;
const INITIAL_PREFETCH_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function formatLocalIsoDate(offsetDays = 0) {
  const dt = new Date();
  dt.setDate(dt.getDate() + offsetDays);
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatMonthRange(monthOffset = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  const year = start.getFullYear();
  const month = String(start.getMonth() + 1).padStart(2, '0');
  const lastDay = String(end.getDate()).padStart(2, '0');
  return {
    startDate: `${year}-${month}-01`,
    endDate: `${year}-${month}-${lastDay}`
  };
}

function requestApiPath(apiBaseUrl, relativePath, token) {
  return new Promise((resolve, reject) => {
    let requestUrl;
    try {
      requestUrl = new URL(relativePath, apiBaseUrl);
    } catch (_) {
      reject(Object.assign(new Error('prefetch_url_invalid'), { code: 'prefetch_url_invalid' }));
      return;
    }

    const transport = requestUrl.protocol === 'https:' ? https : requestUrl.protocol === 'http:' ? http : null;
    if (!transport) {
      reject(Object.assign(new Error('prefetch_protocol_unsupported'), { code: 'prefetch_protocol_unsupported' }));
      return;
    }

    const request = transport.request(requestUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'X-Elvador-Desktop': 'true'
      }
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        resolve({
          ok: false,
          statusCode,
          contentType: String(response.headers['content-type'] || ''),
          body: null
        });
        return;
      }

      let totalBytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          request.destroy(Object.assign(new Error('prefetch_response_too_large'), { code: 'prefetch_response_too_large' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(Object.assign(new Error('prefetch_response_aborted'), { code: 'prefetch_response_aborted' })));
      response.on('end', () => {
        resolve({
          ok: true,
          statusCode,
          contentType: String(response.headers['content-type'] || 'application/json'),
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    const timeout = setTimeout(() => {
      request.destroy(Object.assign(new Error('prefetch_request_timeout'), { code: 'prefetch_request_timeout' }));
    }, REQUEST_TIMEOUT_MS);
    request.on('close', () => clearTimeout(timeout));
    request.on('error', reject);
    request.end();
  });
}

function extractAuthorizedHotelCodes(configJson, sessionUser) {
  const codes = new Set();
  const hotels = Array.isArray(configJson?.data?.hotels)
    ? configJson.data.hotels
    : (Array.isArray(configJson?.hotels) ? configJson.hotels : []);
  for (const hotel of hotels) {
    const code = String(hotel?.code || hotel?.id || '').trim().toLowerCase();
    if (code) {
      codes.add(code);
    }
  }

  if (codes.size === 0 && Array.isArray(sessionUser?.hotelAccess)) {
    for (const code of sessionUser.hotelAccess) {
      const normalized = String(code || '').trim().toLowerCase();
      if (normalized && normalized !== 'all' && normalized !== 'none') {
        codes.add(normalized);
      }
    }
  }

  return Array.from(codes);
}

function createOfflinePrefetcher({
  apiBaseUrl,
  cache,
  writeLog = () => {},
  onStateChange = () => {},
  intervalMs = DEFAULT_PREFETCH_INTERVAL_MS
}) {
  let authToken = null;
  let brand = null;
  let sessionUser = null;
  let timerId = null;
  let inFlight = false;
  let stopped = true;
  let lastSyncAt = null;
  let lastError = null;

  function clearTimer() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function getState() {
    return {
      active: Boolean(authToken && brand) && !stopped,
      syncing: inFlight,
      brand,
      lastSyncAt,
      lastError,
      meta: cache ? cache.getMeta() : null
    };
  }

  function emitState() {
    onStateChange(getState());
  }

  function scheduleNext(delayMs = intervalMs) {
    clearTimer();
    if (stopped || !authToken || !brand) {
      emitState();
      return;
    }

    timerId = setTimeout(() => {
      void syncNow();
    }, delayMs);
    emitState();
  }

  async function fetchAndStore(relativePath, activeBrand, activeToken) {
    const res = await requestApiPath(apiBaseUrl, relativePath, activeToken);
    if (res.statusCode === 401) {
      const err = new Error('auth_401');
      err.code = 'auth_401';
      throw err;
    }
    if (!res.ok) {
      return { stored: false, statusCode: res.statusCode, parsed: null };
    }

    if (!res.contentType.toLowerCase().includes('application/json')) {
      return { stored: false, statusCode: res.statusCode, parsed: null };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(res.body);
    } catch (_) {
      return { stored: false, statusCode: res.statusCode, parsed: null };
    }

    let bodyToStore = res.body;
    if (relativePath === '/api/admin/check-auth' && parsed && typeof parsed === 'object' && parsed.token) {
      const { token: _omittedToken, ...safeAuthPayload } = parsed;
      bodyToStore = JSON.stringify(safeAuthPayload);
    }

    cache.set(relativePath, {
      status: res.statusCode,
      contentType: res.contentType,
      body: bodyToStore,
      brand: activeBrand
    });
    return { stored: true, statusCode: res.statusCode, parsed };
  }

  async function syncNow({ manual = false } = {}) {
    if (inFlight || stopped || !authToken || !brand) {
      return { ok: false, reason: 'not_ready' };
    }

    inFlight = true;
    emitState();
    const startedAt = Date.now();
    const activeToken = authToken;
    const activeBrand = brand;
    const encodedBrand = encodeURIComponent(activeBrand);
    let storedCount = 0;
    let skippedCount = 0;

    try {
      cache.setBrand(activeBrand);

      const corePaths = [
        '/api/admin/check-auth',
        '/api/admin/configuration',
        `/api/admin/configuration?brand=${encodedBrand}`,
        '/api/admin/intent-tab-status',
        '/api/admin/reservation-requests'
      ];

      let configJson = null;
      for (const pathItem of corePaths) {
        if (stopped) return { ok: false, reason: 'stopped' };
        const result = await fetchAndStore(pathItem, activeBrand, activeToken);
        if (result.stored) {
          storedCount += 1;
          if (pathItem.startsWith('/api/admin/configuration') && result.parsed) {
            configJson = result.parsed;
          }
        } else {
          skippedCount += 1;
        }
      }

      const scopedHotel = String(sessionUser?.restaurantHotel || '').trim();
      const withHotelQuery = (urlPath) => (
        scopedHotel
          ? `${urlPath}${urlPath.includes('?') ? '&' : '?'}hotel=${encodeURIComponent(scopedHotel)}`
          : urlPath
      );

      const restaurantPaths = [
        withHotelQuery(`/api/admin/orders/${encodedBrand}/config`),
        `/api/admin/orders/${encodedBrand}/outlets`,
        withHotelQuery(`/api/admin/orders/${encodedBrand}/locations`),
        withHotelQuery(`/api/admin/orders/${encodedBrand}/requests?scope=requests`),
        withHotelQuery(`/api/admin/orders/${encodedBrand}/requests?scope=restaurant_reservations`),
        withHotelQuery(`/api/admin/orders/${encodedBrand}/history`),
        // Keep inventory cached even though Menu editor stays hidden offline: Salonlar uses it when creating new manual orders.
        withHotelQuery(`/api/admin/orders/${encodedBrand}/inventory`)
      ];

      for (const pathItem of restaurantPaths) {
        if (stopped) return { ok: false, reason: 'stopped' };
        const result = await fetchAndStore(pathItem, activeBrand, activeToken);
        if (result.stored) storedCount += 1;
        else skippedCount += 1;
      }

      const pricingSharedPaths = [
        `/api/pricing-admin/hotels?brand=${encodedBrand}`,
        '/api/pricing-admin/hotels',
        `/api/static-config/languages?brand=${encodedBrand}`,
        '/api/static-config/languages'
      ];

      const hotelCodeSet = new Set(extractAuthorizedHotelCodes(configJson, sessionUser));
      for (const pathItem of pricingSharedPaths) {
        if (stopped) return { ok: false, reason: 'stopped' };
        const result = await fetchAndStore(pathItem, activeBrand, activeToken);
        if (result.stored) {
          storedCount += 1;
          if (pathItem.startsWith('/api/pricing-admin/hotels') && Array.isArray(result.parsed?.hotels)) {
            for (const hotel of result.parsed.hotels) {
              const code = String(hotel?.code || '').trim().toLowerCase();
              if (code && code !== 'hotel_code') {
                hotelCodeSet.add(code);
              }
            }
          }
        } else {
          skippedCount += 1;
        }
      }

      const hotelCodes = Array.from(hotelCodeSet);
      const dates = [
        formatLocalIsoDate(-1),
        formatLocalIsoDate(0),
        formatLocalIsoDate(1),
        formatLocalIsoDate(2)
      ];

      for (const hotelCode of hotelCodes) {
        const encodedHotel = encodeURIComponent(hotelCode);
        for (const dateStr of dates) {
          if (stopped) return { ok: false, reason: 'stopped' };
          const rackRes = await fetchAndStore(
            `/api/pms/${encodedBrand}/hotels/${encodedHotel}/front-office?date=${encodeURIComponent(dateStr)}`,
            activeBrand,
            activeToken
          );
          if (rackRes.stored) storedCount += 1;
          else skippedCount += 1;
        }

        const pmsHotelPaths = [
          `/api/pms/${encodedBrand}/hotels/${encodedHotel}/front-office/history`,
          `/api/pms/${encodedBrand}/hotels/${encodedHotel}/folios`,
          `/api/pms/${encodedBrand}/hotels/${encodedHotel}/notes`,
          `/api/pms/${encodedBrand}/hotels/${encodedHotel}/notes?scope=general`,
          `/api/pms/${encodedBrand}/hotels/${encodedHotel}/rooms`
        ];

        for (const pathItem of pmsHotelPaths) {
          if (stopped) return { ok: false, reason: 'stopped' };
          const result = await fetchAndStore(pathItem, activeBrand, activeToken);
          if (result.stored) {
            storedCount += 1;
            if (pathItem.endsWith('/folios') && Array.isArray(result.parsed?.folios)) {
              for (const folio of result.parsed.folios.slice(0, 25)) {
                if (!folio?.reservationId || stopped) continue;
                const detailRes = await fetchAndStore(
                  `/api/pms/${encodedBrand}/hotels/${encodedHotel}/folios/${encodeURIComponent(folio.reservationId)}`,
                  activeBrand,
                  activeToken
                );
                if (detailRes.stored) storedCount += 1;
              }
            }
          } else {
            skippedCount += 1;
          }
        }

        const availabilityMonthPaths = [0, 1, 2].map((monthOffset) => {
          const { startDate, endDate } = formatMonthRange(monthOffset);
          return `/api/pricing-admin/room-availability/${encodedHotel}?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
        });

        const pricingHotelPaths = [
          `/api/pricing-admin/occupancy/${encodedHotel}`,
          ...availabilityMonthPaths,
          // Keep room-info cached even though the Rooms sub-tab stays hidden offline: PriceTablePanel reads room catalogs from it.
          `/api/pricing-admin/room-info/${encodedHotel}?language=tr`,
          `/api/pricing-admin/room-info/${encodedHotel}?language=en`,
          `/api/pricing-admin/markets/${encodedHotel}`,
          `/api/pricing-admin/price-tables/markets/${encodedHotel}`
        ];

        for (const pathItem of pricingHotelPaths) {
          if (stopped) return { ok: false, reason: 'stopped' };
          const result = await fetchAndStore(pathItem, activeBrand, activeToken);
          if (result.stored) {
            storedCount += 1;
            const marketList = Array.isArray(result.parsed?.markets) ? result.parsed.markets.slice(0, 6) : [];
            if (pathItem === `/api/pricing-admin/markets/${encodedHotel}`) {
              for (const market of marketList) {
                if (!market || stopped) continue;
                const mRes = await fetchAndStore(
                  `/api/pricing-admin/market/${encodedHotel}/${encodeURIComponent(market)}`,
                  activeBrand,
                  activeToken
                );
                if (mRes.stored) storedCount += 1;
                else skippedCount += 1;
              }
            } else if (pathItem === `/api/pricing-admin/price-tables/markets/${encodedHotel}`) {
              for (const market of marketList) {
                if (!market || stopped) continue;
                const ptRes = await fetchAndStore(
                  `/api/pricing-admin/price-table/${encodedHotel}/${encodeURIComponent(market)}`,
                  activeBrand,
                  activeToken
                );
                if (ptRes.stored) storedCount += 1;
                else skippedCount += 1;
              }
            }
          } else {
            skippedCount += 1;
          }
        }
      }

      const flushResult = cache.flushSync();
      lastSyncAt = new Date().toISOString();
      lastError = null;

      writeLog('offline panel cache prefetched', {
        brand: activeBrand,
        hotels: hotelCodes.length,
        storedCount,
        skippedCount,
        totalEntries: cache.getMeta()?.entryCount || 0,
        sizeBytes: flushResult?.meta?.sizeBytes || cache.getMeta()?.sizeBytes || 0,
        durationMs: Date.now() - startedAt
      });
      return { ok: true, storedCount, meta: cache.getMeta() };
    } catch (error) {
      const errorCode = error?.code || error?.message || 'prefetch_failed';
      lastError = errorCode;

      if (errorCode === 'auth_401') {
        authToken = null;
        clearTimer();
        writeLog('offline panel prefetch paused on auth_401', { brand: activeBrand });
        return { ok: false, reason: errorCode };
      }

      if (manual || storedCount > 0) {
        if (storedCount > 0) {
          cache.flushSync();
        }
        writeLog('offline panel prefetch failed', {
          brand: activeBrand,
          error: errorCode,
          storedCount,
          durationMs: Date.now() - startedAt
        });
      }
      return { ok: false, reason: errorCode };
    } finally {
      inFlight = false;
      if (!stopped && authToken && brand) {
        scheduleNext(intervalMs);
      } else {
        emitState();
      }
    }
  }

  function start(session = {}) {
    const nextToken = String(session.token || '').trim();
    const nextBrand = String(session.brand || session.user?.brand || '').trim().toLowerCase();
    if (!nextToken) {
      stop();
      return;
    }

    const sessionChanged = nextToken !== authToken || (nextBrand && nextBrand !== brand);
    authToken = nextToken;
    if (nextBrand) {
      brand = nextBrand;
      cache?.setBrand(nextBrand);
    }
    if (session.user && typeof session.user === 'object') {
      sessionUser = session.user;
    }
    if (!brand) {
      emitState();
      return;
    }

    stopped = false;
    if (sessionChanged) {
      lastError = null;
      scheduleNext(INITIAL_PREFETCH_DELAY_MS);
    } else if (!timerId) {
      scheduleNext(intervalMs);
    } else {
      emitState();
    }
  }

  function stop() {
    stopped = true;
    authToken = null;
    clearTimer();
    emitState();
  }

  return {
    start,
    stop,
    syncNow,
    getState
  };
}

module.exports = {
  createOfflinePrefetcher
};
