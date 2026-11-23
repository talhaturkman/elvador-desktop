const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FILE_MAGIC = Buffer.from('EAPC', 'ascii');
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

const MAX_ENTRIES = 250;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const FLUSH_DEBOUNCE_MS = 3000;
const VOLATILE_QUERY_PARAMS = new Set(['_', 't', 'ts', 'cb', '_t', 'cachebust']);

function atomicWriteFileSync(targetPath, data) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (_) {
      // Ignore cleanup failure after failed atomic write.
    }
    throw error;
  }
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {
    // Ignore file removal errors during cache cleanup.
  }
}

function normalizeCacheKey(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(input, 'http://elvador.local');
  } catch (_) {
    return '';
  }

  const keptPairs = [];
  parsed.searchParams.forEach((value, key) => {
    if (!VOLATILE_QUERY_PARAMS.has(key)) {
      keptPairs.push([key, value]);
    }
  });
  keptPairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  const search = keptPairs.length > 0
    ? `?${keptPairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    : '';
  return `${parsed.pathname}${search}`;
}

function createOfflineApiCache({ userDataDir, safeStorage, writeLog = () => {} }) {
  const cacheDir = path.join(userDataDir, 'offline-panel-cache');
  const keyPath = path.join(cacheDir, 'key.bin');
  const dataPath = path.join(cacheDir, 'api-cache.enc');
  const metaPath = path.join(cacheDir, 'api-cache-meta.json');

  const entries = new Map();
  let totalBytes = 0;
  let brandCode = '';
  let lastSavedAt = null;
  let lastEncryptedSizeBytes = 0;
  let flushTimer = null;
  let dirty = false;

  function canUseEncryption() {
    return Boolean(
      safeStorage
      && typeof safeStorage.isEncryptionAvailable === 'function'
      && safeStorage.isEncryptionAvailable()
      && typeof safeStorage.encryptString === 'function'
      && typeof safeStorage.decryptString === 'function'
    );
  }

  function getOrCreateDataKey() {
    if (!canUseEncryption()) {
      return null;
    }

    if (fs.existsSync(keyPath)) {
      try {
        const encryptedKey = fs.readFileSync(keyPath);
        const keyBase64 = safeStorage.decryptString(encryptedKey);
        const keyBuffer = Buffer.from(keyBase64, 'base64');
        if (keyBuffer.length === KEY_BYTES) {
          return keyBuffer;
        }
      } catch (error) {
        writeLog('offline api cache key decrypt failed, rotating key', { message: error?.message });
      }
    }

    const freshKey = crypto.randomBytes(KEY_BYTES);
    const encryptedFreshKey = safeStorage.encryptString(freshKey.toString('base64'));
    atomicWriteFileSync(keyPath, encryptedFreshKey);
    return freshKey;
  }

  function readExistingDataKey() {
    if (!canUseEncryption() || !fs.existsSync(keyPath)) {
      return null;
    }

    const encryptedKey = fs.readFileSync(keyPath);
    const keyBase64 = safeStorage.decryptString(encryptedKey);
    const keyBuffer = Buffer.from(keyBase64, 'base64');
    return keyBuffer.length === KEY_BYTES ? keyBuffer : null;
  }

  function clearFlushTimer() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function evictIfNeeded() {
    while (entries.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
      const oldestKey = entries.keys().next().value;
      if (!oldestKey) {
        break;
      }
      const evicted = entries.get(oldestKey);
      entries.delete(oldestKey);
      totalBytes = Math.max(0, totalBytes - (evicted?.byteSize || 0));
    }
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushSync();
    }, FLUSH_DEBOUNCE_MS);
  }

  function setBrand(nextBrand) {
    const normalized = String(nextBrand || '').trim().toLowerCase();
    if (!normalized) {
      return;
    }
    if (brandCode && brandCode !== normalized) {
      entries.clear();
      totalBytes = 0;
      dirty = true;
    }
    brandCode = normalized;
  }

  function set(rawUrl, payload = {}) {
    const key = normalizeCacheKey(rawUrl);
    if (!key) {
      return { ok: false, reason: 'invalid_url' };
    }

    const bodyText = typeof payload.body === 'string'
      ? payload.body
      : JSON.stringify(payload.body ?? {});
    const byteSize = Buffer.byteLength(bodyText, 'utf8');
    if (byteSize > MAX_ENTRY_BYTES) {
      return { ok: false, reason: 'entry_too_large' };
    }

    if (payload.brand) {
      setBrand(payload.brand);
    }

    if (entries.has(key)) {
      const prev = entries.get(key);
      totalBytes = Math.max(0, totalBytes - (prev?.byteSize || 0));
      entries.delete(key);
    }

    const optimisticOnly = payload.optimisticOnly === true;
    const savedAt = new Date().toISOString();
    entries.set(key, {
      status: Number(payload.status) || 200,
      contentType: String(payload.contentType || 'application/json'),
      body: bodyText,
      baseBody: null,
      optimisticOnly,
      byteSize,
      savedAt
    });
    totalBytes += byteSize;
    evictIfNeeded();
    scheduleFlush();
    return { ok: true, key, entryCount: entries.size };
  }

  function get(rawUrl) {
    const key = normalizeCacheKey(rawUrl);
    if (!key) {
      return { hit: false };
    }

    const found = entries.get(key);
    if (!found) {
      return { hit: false };
    }

    return {
      hit: true,
      status: found.status,
      contentType: found.contentType,
      body: found.body,
      savedAt: found.savedAt
    };
  }

  function flushSync() {
    clearFlushTimer();
    if (!dirty && fs.existsSync(dataPath) && fs.existsSync(metaPath)) {
      return { ok: true, skipped: true };
    }
    if (!canUseEncryption()) {
      writeLog('offline api cache encryption unavailable; refusing plaintext write');
      return { ok: false, reason: 'encryption_unavailable' };
    }

    try {
      const key = getOrCreateDataKey();
      if (!key) {
        return { ok: false, reason: 'encryption_key_unavailable' };
      }

      const savedAt = new Date().toISOString();
      const serializedEntries = [];
      for (const [entryKey, entryValue] of entries.entries()) {
        serializedEntries.push([entryKey, entryValue]);
      }

      const plainPayload = {
        formatVersion: FORMAT_VERSION,
        brandCode,
        savedAt,
        entries: serializedEntries
      };
      const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(plainPayload), 'utf8'));
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encryptedBody = Buffer.concat([cipher.update(compressed), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const versionByte = Buffer.from([FORMAT_VERSION]);
      const finalBuffer = Buffer.concat([FILE_MAGIC, versionByte, iv, authTag, encryptedBody]);

      atomicWriteFileSync(dataPath, finalBuffer);

      lastSavedAt = savedAt;
      lastEncryptedSizeBytes = finalBuffer.length;
      dirty = false;

      const meta = {
        brandCode,
        savedAt,
        entryCount: entries.size,
        sizeBytes: finalBuffer.length
      };
      atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2));
      return { ok: true, meta };
    } catch (error) {
      writeLog('offline api cache flush failed', { message: error?.message });
      return { ok: false, reason: 'flush_failed', message: error?.message };
    }
  }

  function loadFromDisk() {
    if (!canUseEncryption()) {
      return { ok: false, reason: 'encryption_unavailable' };
    }
    if (!fs.existsSync(dataPath) || !fs.existsSync(keyPath)) {
      return { ok: false, reason: 'cache_not_found' };
    }

    try {
      const key = readExistingDataKey();
      if (!key) {
        return { ok: false, reason: 'encryption_key_unavailable' };
      }

      const raw = fs.readFileSync(dataPath);
      const headerLength = FILE_MAGIC.length + 1 + IV_BYTES + AUTH_TAG_BYTES;
      if (raw.length <= headerLength) {
        return { ok: false, reason: 'cache_corrupted' };
      }
      if (!raw.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
        return { ok: false, reason: 'cache_invalid_magic' };
      }
      const version = raw[FILE_MAGIC.length];
      if (version !== FORMAT_VERSION) {
        return { ok: false, reason: 'cache_unsupported_version' };
      }

      const ivStart = FILE_MAGIC.length + 1;
      const tagStart = ivStart + IV_BYTES;
      const dataStart = tagStart + AUTH_TAG_BYTES;
      const iv = raw.subarray(ivStart, tagStart);
      const authTag = raw.subarray(tagStart, dataStart);
      const ciphertext = raw.subarray(dataStart);

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const parsed = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));

      entries.clear();
      totalBytes = 0;
      brandCode = String(parsed.brandCode || '').trim().toLowerCase();
      lastSavedAt = parsed.savedAt || null;
      lastEncryptedSizeBytes = raw.length;
      dirty = false;

      if (Array.isArray(parsed.entries)) {
        for (const pair of parsed.entries) {
          if (!Array.isArray(pair) || pair.length !== 2) continue;
          const [entryKey, entryValue] = pair;
          if (!entryKey || !entryValue || typeof entryValue.body !== 'string') continue;
          const byteSize = Number(entryValue.byteSize) || Buffer.byteLength(entryValue.body, 'utf8');
          entries.set(entryKey, {
            status: Number(entryValue.status) || 200,
            contentType: String(entryValue.contentType || 'application/json'),
            body: entryValue.body,
            baseBody: typeof entryValue.baseBody === 'string' ? entryValue.baseBody : null,
            optimisticOnly: Boolean(entryValue.optimisticOnly),
            byteSize,
            savedAt: entryValue.savedAt || lastSavedAt
          });
          totalBytes += byteSize;
        }
        evictIfNeeded();
      }

      return { ok: true, meta: getMeta() };
    } catch (error) {
      writeLog('offline api cache load failed', { message: error?.message });
      return { ok: false, reason: 'decrypt_failed', message: error?.message };
    }
  }

  function getMeta() {
    if (entries.size > 0 && lastSavedAt) {
      return {
        brandCode,
        savedAt: lastSavedAt,
        entryCount: entries.size,
        sizeBytes: lastEncryptedSizeBytes
      };
    }

    try {
      if (!fs.existsSync(metaPath) || !fs.existsSync(dataPath) || !fs.existsSync(keyPath)) {
        return null;
      }
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function clear() {
    clearFlushTimer();
    entries.clear();
    totalBytes = 0;
    brandCode = '';
    lastSavedAt = null;
    lastEncryptedSizeBytes = 0;
    dirty = false;
    removeFileIfExists(dataPath);
    removeFileIfExists(metaPath);
    removeFileIfExists(keyPath);
    try {
      if (fs.existsSync(cacheDir)) {
        for (const name of fs.readdirSync(cacheDir)) {
          if (name.includes('.tmp.')) {
            removeFileIfExists(path.join(cacheDir, name));
          }
        }
      }
    } catch (_) {
      // Ignore cleanup scan failures.
    }
    return { ok: true };
  }

  function mutateMatchingEntries(predicate, updater) {
    if (typeof predicate !== 'function' || typeof updater !== 'function') {
      return { mutatedCount: 0 };
    }

    let mutatedCount = 0;
    const nowIso = new Date().toISOString();
    for (const [key, entryValue] of Array.from(entries.entries())) {
      let matches = false;
      try {
        matches = Boolean(predicate(key, entryValue));
      } catch (_) {
        matches = false;
      }
      if (!matches) continue;

      let parsed;
      try {
        parsed = JSON.parse(entryValue.body);
      } catch (_) {
        continue;
      }

      let nextJson;
      try {
        nextJson = updater(parsed, key);
      } catch (_) {
        continue;
      }
      if (nextJson === undefined || nextJson === null) continue;

      const nextBody = JSON.stringify(nextJson);
      const nextByteSize = Buffer.byteLength(nextBody, 'utf8');
      if (nextByteSize > MAX_ENTRY_BYTES) continue;

      const preservedBaseBody = entryValue.optimisticOnly
        ? null
        : (typeof entryValue.baseBody === 'string' ? entryValue.baseBody : entryValue.body);

      totalBytes = Math.max(0, totalBytes - (entryValue.byteSize || 0)) + nextByteSize;
      entries.set(key, {
        ...entryValue,
        body: nextBody,
        baseBody: preservedBaseBody,
        optimisticOnly: Boolean(entryValue.optimisticOnly),
        byteSize: nextByteSize,
        savedAt: nowIso
      });
      mutatedCount += 1;
    }

    if (mutatedCount > 0) {
      evictIfNeeded();
      scheduleFlush();
    }
    return { mutatedCount };
  }

  // 2026-11-23: Restore mutated entries to pre-offline baseline and drop synthetic entries so discarded outbox writes vanish immediately.
  function resetToBaseline() {
    let restoredCount = 0;
    let deletedCount = 0;

    for (const [entryKey, entryValue] of Array.from(entries.entries())) {
      if (entryValue.optimisticOnly === true) {
        entries.delete(entryKey);
        totalBytes = Math.max(0, totalBytes - (entryValue.byteSize || 0));
        deletedCount += 1;
        continue;
      }

      if (typeof entryValue.baseBody === 'string') {
        const restoredBody = entryValue.baseBody;
        const restoredBytes = Buffer.byteLength(restoredBody, 'utf8');
        totalBytes = Math.max(0, totalBytes - (entryValue.byteSize || 0)) + restoredBytes;
        entries.set(entryKey, {
          ...entryValue,
          body: restoredBody,
          baseBody: null,
          optimisticOnly: false,
          byteSize: restoredBytes
        });
        restoredCount += 1;
      }
    }

    if (restoredCount > 0 || deletedCount > 0) {
      evictIfNeeded();
      scheduleFlush();
    }

    return { restoredCount, deletedCount };
  }

  return {
    cacheDir,
    normalizeCacheKey,
    loadFromDisk,
    setBrand,
    set,
    get,
    mutateMatchingEntries,
    resetToBaseline,
    getMeta,
    flushSync,
    clear
  };
}

module.exports = {
  createOfflineApiCache,
  normalizeCacheKey
};
