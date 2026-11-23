const http = require('http');
const https = require('https');

const REQUEST_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CONFLICT_STATUS_CODES = new Set([400, 403, 404, 409, 422]);

function sendJsonRequest({ apiBaseUrl, method, urlPath, token, idempotencyKey, body }) {
  return new Promise((resolve, reject) => {
    let requestUrl;
    try {
      requestUrl = new URL(urlPath, apiBaseUrl);
    } catch (_) {
      reject(Object.assign(new Error('outbox_url_invalid'), { code: 'outbox_url_invalid' }));
      return;
    }

    const transport = requestUrl.protocol === 'https:' ? https : requestUrl.protocol === 'http:' ? http : null;
    if (!transport) {
      reject(Object.assign(new Error('outbox_protocol_unsupported'), { code: 'outbox_protocol_unsupported' }));
      return;
    }

    const hasBody = body !== null && body !== undefined && method !== 'GET' && method !== 'HEAD';
    const bodyString = hasBody ? JSON.stringify(body) : '';
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Elvador-Desktop': 'true'
    };
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyString, 'utf8');
    }

    const request = transport.request(requestUrl, {
      method,
      headers
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      let totalBytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          request.destroy(Object.assign(new Error('outbox_response_too_large'), { code: 'outbox_response_too_large' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(Object.assign(new Error('outbox_response_aborted'), { code: 'outbox_response_aborted' })));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {
          json = null;
        }
        resolve({ statusCode, json, text });
      });
    });

    const timeout = setTimeout(() => {
      request.destroy(Object.assign(new Error('outbox_request_timeout'), { code: 'outbox_request_timeout' }));
    }, REQUEST_TIMEOUT_MS);
    request.on('close', () => clearTimeout(timeout));
    request.on('error', reject);
    if (hasBody) {
      request.write(bodyString);
    }
    request.end();
  });
}

function createOfflineOutboxSync({
  apiBaseUrl,
  outbox,
  onSyncComplete = () => {},
  onStateChange = () => {},
  writeLog = () => {}
}) {
  let authToken = null;
  let brand = null;
  let stopped = true;
  let inFlight = false;

  function emitState() {
    onStateChange({
      active: Boolean(authToken) && !stopped,
      syncing: inFlight,
      summary: outbox ? outbox.getSummary() : { pendingCount: 0, conflictCount: 0, totalCount: 0, syncing: false }
    });
  }

  function start(session = {}) {
    const nextToken = String(session.token || '').trim();
    const nextBrand = String(session.brand || session.user?.brand || '').trim().toLowerCase();
    if (!nextToken) {
      stop();
      return;
    }
    authToken = nextToken;
    if (nextBrand) {
      brand = nextBrand;
      outbox?.setBrand(nextBrand);
    }
    stopped = false;
    emitState();
  }

  function stop() {
    stopped = true;
    authToken = null;
    emitState();
  }

  async function syncPending({ includeConflicts = false, onlyItemId = null } = {}) {
    if (inFlight || stopped || !authToken || !outbox) {
      return { ok: false, reason: 'not_ready', summary: outbox ? outbox.getSummary() : null };
    }

    const candidates = outbox.list().filter((item) => {
      if (onlyItemId) return item.id === onlyItemId;
      if (includeConflicts) return item.status === 'pending' || item.status === 'conflict';
      return item.status === 'pending';
    });

    if (candidates.length === 0) {
      return { ok: true, syncedCount: 0, conflictCount: 0, summary: outbox.getSummary() };
    }

    inFlight = true;
    emitState();
    let syncedCount = 0;
    let conflictCount = 0;
    let aborted = false;

    try {
      for (const item of candidates) {
        if (stopped || !authToken) break;

        const resolvedUrl = outbox.resolveTempIds(item.url);
        const resolvedBody = outbox.resolveTempIds(item.body);
        const unresolved = [...resolvedUrl.unresolved, ...resolvedBody.unresolved];
        if (unresolved.length > 0) {
          outbox.markItem(item.id, {
            status: 'conflict',
            errorCode: 'UNRESOLVED_DEPENDENCY',
            errorMessage: 'Bağlı olduğu önceki kayıt henüz gönderilemedi.',
            attempts: (item.attempts || 0) + 1
          });
          conflictCount += 1;
          emitState();
          continue;
        }

        outbox.markItem(item.id, { status: 'syncing' });
        emitState();

        try {
          const res = await sendJsonRequest({
            apiBaseUrl,
            method: item.method,
            urlPath: resolvedUrl.resolved,
            token: authToken,
            idempotencyKey: item.idempotencyKey,
            body: resolvedBody.resolved
          });

          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (item.tempId) {
              const realId = res.json?.reservationId
                || res.json?.note?.id
                || res.json?.request?.id
                || res.json?.id
                || null;
              if (realId) {
                outbox.recordIdMapping(item.tempId, realId);
              }
            }
            outbox.removeItem(item.id);
            syncedCount += 1;
            writeLog('offline outbox item synced', {
              id: item.id,
              label: item.label,
              method: item.method,
              statusCode: res.statusCode
            });
            emitState();
            continue;
          }

          if (res.statusCode === 401) {
            outbox.markItem(item.id, {
              status: 'pending',
              attempts: (item.attempts || 0) + 1
            });
            stopped = true;
            authToken = null;
            aborted = true;
            writeLog('offline outbox sync paused on auth_401', { brand });
            break;
          }

          if (CONFLICT_STATUS_CODES.has(res.statusCode)) {
            const errorMessage = res.json?.error || res.json?.message || `Sunucu işlemi reddetti (${res.statusCode}).`;
            const errorCode = res.json?.code || `HTTP_${res.statusCode}`;
            outbox.markItem(item.id, {
              status: 'conflict',
              errorCode,
              errorMessage,
              httpStatus: res.statusCode,
              attempts: (item.attempts || 0) + 1
            });
            conflictCount += 1;
            writeLog('offline outbox item conflict', {
              id: item.id,
              label: item.label,
              statusCode: res.statusCode,
              errorCode
            });
            emitState();
            continue;
          }

          // Transient 5xx / 429: preserve pending status and retry later.
          outbox.markItem(item.id, {
            status: 'pending',
            httpStatus: res.statusCode,
            attempts: (item.attempts || 0) + 1
          });
          aborted = true;
          break;
        } catch (networkErr) {
          outbox.markItem(item.id, {
            status: 'pending',
            errorCode: networkErr?.code || 'NETWORK_ERROR',
            attempts: (item.attempts || 0) + 1
          });
          aborted = true;
          break;
        }
      }

      if (syncedCount > 0) {
        try {
          await onSyncComplete({ syncedCount, conflictCount });
        } catch (_) {
          // Non-blocking refresh notification.
        }
      }

      return {
        ok: !aborted,
        syncedCount,
        conflictCount,
        summary: outbox.getSummary()
      };
    } finally {
      inFlight = false;
      emitState();
    }
  }

  return {
    start,
    stop,
    syncPending,
    isSyncing: () => inFlight
  };
}

module.exports = {
  createOfflineOutboxSync
};
