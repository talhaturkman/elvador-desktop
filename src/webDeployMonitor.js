const http = require('http');
const https = require('https');

const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_RESPONSE_BYTES = 32 * 1024;

function resolveAppVersionUrl(adminUrl) {
  try {
    return new URL('/app-version.json', adminUrl).toString();
  } catch (_) {
    return '';
  }
}

function normalizeBuildId(value) {
  const buildId = String(value || '').trim();
  return buildId ? buildId.slice(0, 256) : '';
}

function requestBuildInfo(requestUrl, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(requestUrl);
    } catch (_) {
      reject(new Error('invalid_app_version_url'));
      return;
    }

    const transport = parsedUrl.protocol === 'https:' ? https : parsedUrl.protocol === 'http:' ? http : null;
    if (!transport) {
      reject(new Error('unsupported_app_version_protocol'));
      return;
    }

    const request = transport.request(parsedUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'User-Agent': 'Elvador-Desktop-WebDeployMonitor'
      }
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      const location = response.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location && redirectCount < 3) {
        response.resume();
        requestBuildInfo(new URL(location, parsedUrl).toString(), timeoutMs, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`app_version_http_${statusCode || 'unknown'}`));
        return;
      }

      let totalBytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('app_version_response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const buildId = normalizeBuildId(parsed?.buildId);
          if (!buildId) {
            throw new Error('app_version_build_id_missing');
          }
          resolve({
            buildId,
            generatedAt: typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : null,
            endpointUrl: requestUrl
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error('app_version_json_invalid'));
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('app_version_request_timeout'));
    });
    request.on('error', reject);
    request.end();
  });
}

function createWebDeployMonitor({
  adminUrl,
  intervalMs = DEFAULT_CHECK_INTERVAL_MS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  requestBuildInfo: requestBuildInfoOverride = requestBuildInfo,
  onDeploymentChanged = async () => ({ reloaded: true }),
  onStateChange = () => {},
  writeLog = () => {}
} = {}) {
  const endpointUrl = resolveAppVersionUrl(adminUrl);
  const safeIntervalMs = Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_CHECK_INTERVAL_MS;
  const safeTimeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  let timer = null;
  let firstCheckTimer = null;
  let inFlight = false;
  let state = {
    active: false,
    endpointUrl,
    intervalMs: safeIntervalMs,
    timeoutMs: safeTimeoutMs,
    checks: 0,
    lastBuildId: null,
    lastSeenBuildId: null,
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastReloadAt: null,
    lastReloadResult: null,
    lastError: null
  };

  function snapshot() {
    return { ...state };
  }

  function emit(event, details = {}) {
    const payload = {
      event,
      details,
      state: snapshot()
    };
    writeLog('web_deploy_monitor', payload);
    try {
      onStateChange(payload);
    } catch (_) {
      // Diagnostics must never affect the panel or update monitor.
    }
  }

  async function checkNow(reason = 'scheduled') {
    if (!endpointUrl) {
      state.lastError = 'app_version_url_unavailable';
      emit('check_skipped', { reason, error: state.lastError });
      return { ok: false, reason: state.lastError };
    }

    if (inFlight) {
      emit('check_skipped', { reason, skipReason: 'check_already_running' });
      return { ok: false, reason: 'check_already_running' };
    }

    inFlight = true;
    state.checks += 1;
    state.lastCheckedAt = new Date().toISOString();
    emit('check_started', { reason });

    try {
      const requestUrl = new URL(endpointUrl);
      requestUrl.searchParams.set('_elvadorDesktopCheck', String(Date.now()));
      const buildInfo = await requestBuildInfoOverride(requestUrl.toString(), safeTimeoutMs);
      const buildId = normalizeBuildId(buildInfo?.buildId);
      if (!buildId) {
        throw new Error('app_version_build_id_missing');
      }

      const previousBuildId = state.lastBuildId;
      state.lastSeenBuildId = buildId;
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;

      if (!previousBuildId) {
        state.lastBuildId = buildId;
        emit('baseline_registered', {
          reason,
          buildId,
          generatedAt: buildInfo?.generatedAt || null
        });
        return { ok: true, changed: false, buildId };
      }

      if (previousBuildId === buildId) {
        emit('version_unchanged', { reason, buildId });
        return { ok: true, changed: false, buildId };
      }

      emit('deployment_detected', {
        reason,
        previousBuildId,
        buildId,
        generatedAt: buildInfo?.generatedAt || null
      });

      const reloadResult = await onDeploymentChanged({
        previousBuildId,
        buildId,
        generatedAt: buildInfo?.generatedAt || null,
        endpointUrl
      });

      if (reloadResult?.reloaded === false) {
        throw new Error(reloadResult.reason || 'panel_reload_not_completed');
      }

      state.lastBuildId = buildId;
      state.lastReloadAt = new Date().toISOString();
      state.lastReloadResult = reloadResult || { reloaded: true };
      emit('deployment_reload_completed', {
        previousBuildId,
        buildId,
        reloadResult: state.lastReloadResult
      });
      return { ok: true, changed: true, buildId, reloadResult: state.lastReloadResult };
    } catch (error) {
      state.lastError = error?.message || String(error);
      emit('check_failed', { reason, error: state.lastError });
      return { ok: false, reason: state.lastError };
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (timer || state.active) {
      return;
    }

    state.active = true;
    emit('monitor_started', { endpointUrl, intervalMs: safeIntervalMs, timeoutMs: safeTimeoutMs });
    firstCheckTimer = setTimeout(() => {
      firstCheckTimer = null;
      checkNow('startup');
    }, 5000);
    if (typeof firstCheckTimer.unref === 'function') {
      firstCheckTimer.unref();
    }
    timer = setInterval(() => {
      checkNow('scheduled');
    }, safeIntervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (firstCheckTimer) {
      clearTimeout(firstCheckTimer);
      firstCheckTimer = null;
    }
    if (state.active) {
      state.active = false;
      emit('monitor_stopped');
    }
  }

  return {
    start,
    stop,
    checkNow,
    getState: snapshot
  };
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createWebDeployMonitor,
  requestBuildInfo,
  resolveAppVersionUrl
};
