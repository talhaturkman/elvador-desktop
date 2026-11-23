const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FILE_MAGIC = Buffer.from('EOBX', 'ascii');
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_OUTBOX_ITEMS = 500;
const MAX_ID_MAP_ENTRIES = 500;
const TEMP_ID_PATTERN = /offline_(?:res|note|ord)_[a-zA-Z0-9]+(?:_[a-zA-Z0-9]+)*/g;

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
    // Ignore file removal errors during cleanup.
  }
}

function cloneJson(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function replaceTempIdsInValue(value, idMap, unresolvedSet) {
  if (typeof value === 'string') {
    return value.replace(TEMP_ID_PATTERN, (match) => {
      if (Object.prototype.hasOwnProperty.call(idMap, match) && idMap[match]) {
        return idMap[match];
      }
      if (unresolvedSet) unresolvedSet.add(match);
      return match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceTempIdsInValue(item, idMap, unresolvedSet));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = replaceTempIdsInValue(v, idMap, unresolvedSet);
    }
    return out;
  }
  return value;
}

function createOfflineOutboxStore({ userDataDir, safeStorage, writeLog = () => {} }) {
  const storeDir = path.join(userDataDir, 'offline-panel-cache');
  const keyPath = path.join(storeDir, 'outbox-key.bin');
  const dataPath = path.join(storeDir, 'outbox.enc');

  let brandCode = '';
  let items = [];
  let idMap = {};

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
    if (!canUseEncryption()) return null;

    if (fs.existsSync(keyPath)) {
      try {
        const encryptedKey = fs.readFileSync(keyPath);
        const keyBase64 = safeStorage.decryptString(encryptedKey);
        const keyBuffer = Buffer.from(keyBase64, 'base64');
        if (keyBuffer.length === KEY_BYTES) {
          return keyBuffer;
        }
      } catch (error) {
        writeLog('offline outbox key decrypt failed, rotating key', { message: error?.message });
      }
    }

    const freshKey = crypto.randomBytes(KEY_BYTES);
    const encryptedFreshKey = safeStorage.encryptString(freshKey.toString('base64'));
    atomicWriteFileSync(keyPath, encryptedFreshKey);
    return freshKey;
  }

  function readExistingDataKey() {
    if (!canUseEncryption() || !fs.existsSync(keyPath)) return null;
    const encryptedKey = fs.readFileSync(keyPath);
    const keyBase64 = safeStorage.decryptString(encryptedKey);
    const keyBuffer = Buffer.from(keyBase64, 'base64');
    return keyBuffer.length === KEY_BYTES ? keyBuffer : null;
  }

  function flushSync() {
    if (!canUseEncryption()) {
      writeLog('offline outbox encryption unavailable; refusing plaintext write');
      return { ok: false, reason: 'encryption_unavailable' };
    }

    try {
      const key = getOrCreateDataKey();
      if (!key) {
        return { ok: false, reason: 'encryption_key_unavailable' };
      }

      const payload = {
        formatVersion: FORMAT_VERSION,
        brandCode,
        savedAt: new Date().toISOString(),
        items,
        idMap
      };
      const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encryptedBody = Buffer.concat([cipher.update(compressed), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const versionByte = Buffer.from([FORMAT_VERSION]);
      const finalBuffer = Buffer.concat([FILE_MAGIC, versionByte, iv, authTag, encryptedBody]);

      atomicWriteFileSync(dataPath, finalBuffer);
      return { ok: true, summary: getSummary() };
    } catch (error) {
      writeLog('offline outbox flush failed', { message: error?.message });
      return { ok: false, reason: 'flush_failed', message: error?.message };
    }
  }

  function loadFromDisk() {
    if (!canUseEncryption()) {
      return { ok: false, reason: 'encryption_unavailable' };
    }
    if (!fs.existsSync(dataPath) || !fs.existsSync(keyPath)) {
      return { ok: false, reason: 'outbox_not_found' };
    }

    try {
      const key = readExistingDataKey();
      if (!key) return { ok: false, reason: 'encryption_key_unavailable' };

      const raw = fs.readFileSync(dataPath);
      const headerLength = FILE_MAGIC.length + 1 + IV_BYTES + AUTH_TAG_BYTES;
      if (raw.length <= headerLength) return { ok: false, reason: 'outbox_corrupted' };
      if (!raw.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
        return { ok: false, reason: 'outbox_invalid_magic' };
      }
      if (raw[FILE_MAGIC.length] !== FORMAT_VERSION) {
        return { ok: false, reason: 'outbox_unsupported_version' };
      }

      const ivStart = FILE_MAGIC.length + 1;
      const tagStart = ivStart + IV_BYTES;
      const dataStart = tagStart + AUTH_TAG_BYTES;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(ivStart, tagStart));
      decipher.setAuthTag(raw.subarray(tagStart, dataStart));
      const compressed = Buffer.concat([decipher.update(raw.subarray(dataStart)), decipher.final()]);
      const parsed = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));

      brandCode = String(parsed.brandCode || '').trim().toLowerCase();
      items = (Array.isArray(parsed.items) ? parsed.items : []).map((item) => ({
        ...item,
        status: item.status === 'syncing' ? 'pending' : (item.status || 'pending')
      }));
      idMap = parsed.idMap && typeof parsed.idMap === 'object' ? { ...parsed.idMap } : {};
      return { ok: true, summary: getSummary() };
    } catch (error) {
      writeLog('offline outbox load failed', { message: error?.message });
      return { ok: false, reason: 'decrypt_failed', message: error?.message };
    }
  }

  function setBrand(nextBrand) {
    const normalized = String(nextBrand || '').trim().toLowerCase();
    if (!normalized) return;
    if (brandCode && brandCode !== normalized) {
      items = [];
      idMap = {};
      flushSync();
    }
    brandCode = normalized;
  }

  function enqueue(entry = {}) {
    if (items.length >= MAX_OUTBOX_ITEMS) {
      return { ok: false, reason: 'outbox_full' };
    }
    if (entry.brand) {
      setBrand(entry.brand);
    }

    const item = {
      id: entry.id || `q_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      idempotencyKey: entry.idempotencyKey || `off_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
      brand: String(entry.brand || brandCode || '').trim().toLowerCase(),
      method: String(entry.method || 'POST').toUpperCase(),
      url: String(entry.url || ''),
      body: entry.body !== undefined ? cloneJson(entry.body) : null,
      label: String(entry.label || 'İşlem'),
      tempId: entry.tempId || null,
      status: 'pending',
      errorCode: null,
      errorMessage: null,
      httpStatus: null,
      createdAt: entry.createdAt || new Date().toISOString(),
      attempts: 0
    };

    items.push(item);
    const flushRes = flushSync();
    if (!flushRes.ok) {
      items.pop();
      return flushRes;
    }
    return { ok: true, item: cloneJson(item) };
  }

  function list() {
    return items.map((item) => cloneJson(item));
  }

  function getSummary() {
    let pendingCount = 0;
    let conflictCount = 0;
    let syncing = false;
    for (const item of items) {
      if (item.status === 'conflict') {
        conflictCount += 1;
      } else {
        pendingCount += 1;
        if (item.status === 'syncing') syncing = true;
      }
    }
    return {
      pendingCount,
      conflictCount,
      totalCount: items.length,
      syncing
    };
  }

  function markItem(id, patch = {}) {
    const idx = items.findIndex((item) => item.id === id);
    if (idx === -1) return null;
    items[idx] = {
      ...items[idx],
      ...patch
    };
    flushSync();
    return cloneJson(items[idx]);
  }

  function removeItem(id) {
    const idx = items.findIndex((item) => item.id === id);
    if (idx === -1) return false;
    items.splice(idx, 1);
    flushSync();
    return true;
  }

  function recordIdMapping(tempId, realId) {
    if (!tempId || !realId) return;
    idMap[tempId] = String(realId);
    const keys = Object.keys(idMap);
    if (keys.length > MAX_ID_MAP_ENTRIES) {
      for (const oldKey of keys.slice(0, keys.length - MAX_ID_MAP_ENTRIES)) {
        delete idMap[oldKey];
      }
    }
    flushSync();
  }

  function getIdMap() {
    return { ...idMap };
  }

  function resolveTempIds(value) {
    const unresolvedSet = new Set();
    const resolved = replaceTempIdsInValue(value, idMap, unresolvedSet);
    return {
      resolved,
      unresolved: Array.from(unresolvedSet)
    };
  }

  function clear() {
    brandCode = '';
    items = [];
    idMap = {};
    removeFileIfExists(dataPath);
    removeFileIfExists(keyPath);
    try {
      if (fs.existsSync(storeDir)) {
        for (const name of fs.readdirSync(storeDir)) {
          if (name.includes('.tmp.')) {
            removeFileIfExists(path.join(storeDir, name));
          }
        }
      }
    } catch (_) {
      // Ignore cleanup failures.
    }
    return { ok: true };
  }

  return {
    storeDir,
    loadFromDisk,
    setBrand,
    enqueue,
    list,
    getSummary,
    markItem,
    removeItem,
    recordIdMapping,
    getIdMap,
    resolveTempIds,
    flushSync,
    clear
  };
}

module.exports = {
  createOfflineOutboxStore,
  TEMP_ID_PATTERN
};
