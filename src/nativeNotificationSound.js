const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_SOUND_DURATION_MS = 1400;
const DEFAULT_CRITICAL_DURATION_MS = 30000;
const DEFAULT_PREVIEW_DURATION_MS = 7000;
const MAX_SOUND_DURATION_MS = 5 * 60 * 1000;
const RESTART_COOLDOWN_MS = 900;

function coerceDurationMs(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }
  return Math.min(MAX_SOUND_DURATION_MS, Math.max(250, Math.round(numericValue)));
}

function getPowerShellPath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  const defaultPath = systemRoot
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : '';

  return defaultPath && fs.existsSync(defaultPath) ? defaultPath : 'powershell.exe';
}

function getSoundDurationMs(options = {}) {
  if (Number(options.previewDurationMs) > 0) {
    return coerceDurationMs(options.previewDurationMs, DEFAULT_PREVIEW_DURATION_MS);
  }

  if (options.profile === 'critical') {
    return coerceDurationMs(options.criticalDurationMs, DEFAULT_CRITICAL_DURATION_MS);
  }

  return DEFAULT_SOUND_DURATION_MS;
}

function getRepeatDelayMs(durationMs) {
  if (durationMs <= 1800) {
    return 900;
  }
  if (durationMs <= 8000) {
    return 1600;
  }
  return 3300;
}

function buildPowerShellSoundScript(durationMs) {
  const repeatDelayMs = getRepeatDelayMs(durationMs);
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$end = [DateTime]::UtcNow.AddMilliseconds(${durationMs})`,
    'while ([DateTime]::UtcNow -lt $end) {',
    '  [System.Media.SystemSounds]::Exclamation.Play()',
    '  Start-Sleep -Milliseconds 220',
    '  [System.Media.SystemSounds]::Asterisk.Play()',
    `  Start-Sleep -Milliseconds ${repeatDelayMs}`,
    '}'
  ].join('; ');
}

function createNativeNotificationSoundService({ writeLog = () => {} } = {}) {
  const activeChildren = new Set();
  let lastStartedAt = 0;

  function stopNotificationSound(reason = 'manual') {
    const stoppedCount = activeChildren.size;
    if (stoppedCount === 0) {
      return;
    }

    for (const child of activeChildren) {
      try {
        child.kill();
      } catch (_) {
        // The child may have already exited.
      }
    }
    activeChildren.clear();
    writeLog('notification_sound_stop', { reason, count: stoppedCount });
  }

  function playNotificationSound(options = {}) {
    if (process.platform !== 'win32') {
      return { played: false, reason: 'unsupported_platform' };
    }

    const now = Date.now();
    if (activeChildren.size > 0 && now - lastStartedAt < RESTART_COOLDOWN_MS) {
      return { played: false, reason: 'cooldown' };
    }

    stopNotificationSound('restart');
    const durationMs = getSoundDurationMs(options);
    const powershellPath = getPowerShellPath();
    const script = buildPowerShellSoundScript(durationMs);

    try {
      const child = spawn(
        powershellPath,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-Command',
          script
        ],
        {
          windowsHide: true,
          stdio: 'ignore'
        }
      );

      activeChildren.add(child);
      lastStartedAt = now;

      child.once('exit', (code, signal) => {
        activeChildren.delete(child);
        writeLog('notification_sound_exit', { code, signal });
      });

      child.once('error', (error) => {
        activeChildren.delete(child);
        writeLog('notification_sound_error', { message: error?.message });
      });

      child.unref();
      writeLog('notification_sound_start', {
        durationMs,
        profile: options.profile || null,
        source: options.source || null
      });

      return {
        played: true,
        engine: 'powershell-system-sounds',
        durationMs
      };
    } catch (error) {
      writeLog('notification_sound_spawn_error', { message: error?.message });
      return {
        played: false,
        reason: 'spawn_failed',
        message: error?.message || String(error)
      };
    }
  }

  return {
    playNotificationSound,
    stopNotificationSound
  };
}

module.exports = {
  createNativeNotificationSoundService
};
