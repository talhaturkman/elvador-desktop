const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SAMPLE_RATE = 44100;
const DEFAULT_SOUND_DURATION_MS = 1400;
const DEFAULT_CRITICAL_DURATION_MS = 30000;
const DEFAULT_PREVIEW_DURATION_MS = 7000;
const MAX_SOUND_DURATION_MS = 5 * 60 * 1000;
const RESTART_COOLDOWN_MS = 900;
const SOUND_CACHE_DIR = path.join(os.tmpdir(), 'elvador-desktop');

const TONE_PATTERNS = Object.freeze({
  smoothChime: [
    { frequency: 523.25, durationMs: 360, releaseMs: 760, peak: 0.26, partials: [[1, 1], [1.5, 0.08], [2, 0.045]] },
    { frequency: 659.25, startMs: 150, durationMs: 420, releaseMs: 860, peak: 0.23, partials: [[1, 1], [2, 0.08]] },
    { frequency: 783.99, startMs: 320, durationMs: 500, releaseMs: 920, peak: 0.15, partials: [[1, 1], [2, 0.06]] }
  ],
  orderPing: [
    { frequency: 659.25, durationMs: 180, releaseMs: 280, attackMs: 8, peak: 0.2, partials: [[1, 1], [2, 0.08]] },
    { frequency: 880, startMs: 100, durationMs: 230, releaseMs: 360, attackMs: 8, peak: 0.17, partials: [[1, 1]] },
    { frequency: 1174.66, startMs: 220, durationMs: 260, releaseMs: 440, attackMs: 10, peak: 0.1, partials: [[1, 1]] }
  ],
  warmBell: [
    { frequency: 392, durationMs: 430, releaseMs: 900, peak: 0.25, partials: [[1, 1], [1.5, 0.08], [2, 0.045]] },
    { frequency: 493.88, startMs: 170, durationMs: 460, releaseMs: 980, peak: 0.2, partials: [[1, 1], [2, 0.08]] },
    { frequency: 659.25, startMs: 380, durationMs: 520, releaseMs: 1080, peak: 0.13, partials: [[1, 1], [2, 0.06]] }
  ],
  glassBell: [
    { frequency: 659.25, durationMs: 280, releaseMs: 780, attackMs: 14, peak: 0.17, partials: [[1, 1], [2, 0.07]] },
    { frequency: 987.77, startMs: 150, durationMs: 380, releaseMs: 900, attackMs: 16, peak: 0.13, partials: [[1, 1]] },
    { frequency: 1318.51, startMs: 330, durationMs: 430, releaseMs: 980, attackMs: 18, peak: 0.08, partials: [[1, 1]] }
  ],
  mellowTap: [
    { frequency: 392, durationMs: 190, releaseMs: 330, attackMs: 6, peak: 0.18, partials: [[1, 1], [2, 0.055]] },
    { frequency: 493.88, startMs: 120, durationMs: 220, releaseMs: 380, attackMs: 7, peak: 0.15, partials: [[1, 1], [2, 0.05]] },
    { frequency: 587.33, startMs: 250, durationMs: 240, releaseMs: 440, attackMs: 8, peak: 0.1, partials: [[1, 1], [2, 0.045]] }
  ],
  classicBeep: [
    { frequency: 880, durationMs: 300, releaseMs: 340, attackMs: 10, peak: 0.16, partials: [[1, 1]] },
    { frequency: 1046.5, startMs: 180, durationMs: 300, releaseMs: 380, attackMs: 10, peak: 0.12, partials: [[1, 1]] }
  ]
});

function clampVolume(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0.75;
  }
  return Math.min(1, Math.max(0, numericValue));
}

function coerceDurationMs(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }
  return Math.min(MAX_SOUND_DURATION_MS, Math.max(250, Math.round(numericValue)));
}

function normalizeTone(value) {
  return TONE_PATTERNS[value] ? value : 'smoothChime';
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
  return 2200;
}

function getPatternDurationMs(pattern) {
  return pattern.reduce((durationMs, note) => {
    const noteEndMs = (note.startMs || 0) + (note.durationMs || 0) + (note.releaseMs || 0) + 120;
    return Math.max(durationMs, noteEndMs);
  }, 0);
}

function addTone(samples, note, volume) {
  const startSample = Math.max(0, Math.round(((note.startMs || 0) / 1000) * SAMPLE_RATE));
  const durationSamples = Math.max(1, Math.round(((note.durationMs || 320) / 1000) * SAMPLE_RATE));
  const releaseSamples = Math.max(1, Math.round(((note.releaseMs || 600) / 1000) * SAMPLE_RATE));
  const attackSamples = Math.max(1, Math.round(((note.attackMs || 24) / 1000) * SAMPLE_RATE));
  const totalSamples = durationSamples + releaseSamples;
  const partials = Array.isArray(note.partials) && note.partials.length > 0 ? note.partials : [[1, 1]];
  const peak = (Number(note.peak) || 0.18) * volume;

  for (let index = 0; index < totalSamples && startSample + index < samples.length; index += 1) {
    let envelope;
    if (index < attackSamples) {
      envelope = index / attackSamples;
    } else if (index < durationSamples) {
      const sustainProgress = (index - attackSamples) / Math.max(1, durationSamples - attackSamples);
      envelope = 1 - (sustainProgress * 0.72);
    } else {
      const releaseProgress = (index - durationSamples) / releaseSamples;
      envelope = Math.max(0, 0.28 * (1 - releaseProgress));
    }

    const time = index / SAMPLE_RATE;
    const toneValue = partials.reduce((sum, partial) => {
      const ratio = Number(partial[0]) || 1;
      const partialGain = Number(partial[1]) || 1;
      return sum + (Math.sin(2 * Math.PI * note.frequency * ratio * time) * partialGain);
    }, 0);

    samples[startSample + index] += toneValue * peak * envelope;
  }
}

function writeAscii(buffer, offset, value) {
  buffer.write(value, offset, value.length, 'ascii');
}

function createWavBuffer(samples) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  writeAscii(buffer, 0, 'RIFF');
  buffer.writeUInt32LE(36 + dataSize, 4);
  writeAscii(buffer, 8, 'WAVE');
  writeAscii(buffer, 12, 'fmt ');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  writeAscii(buffer, 36, 'data');
  buffer.writeUInt32LE(dataSize, 40);

  samples.forEach((sample, index) => {
    const clampedSample = Math.max(-1, Math.min(1, sample));
    buffer.writeInt16LE(Math.round(clampedSample * 32767), 44 + (index * 2));
  });

  return buffer;
}

function buildChimeWav(tone, volume) {
  const pattern = TONE_PATTERNS[tone] || TONE_PATTERNS.smoothChime;
  const durationMs = getPatternDurationMs(pattern);
  const samples = new Float32Array(Math.ceil((durationMs / 1000) * SAMPLE_RATE));
  pattern.forEach((note) => addTone(samples, note, volume));
  return createWavBuffer(samples);
}

function getSoundFilePath(tone, volume) {
  const volumeKey = Math.round(volume * 20);
  return path.join(SOUND_CACHE_DIR, `notification-${tone}-${volumeKey}.wav`);
}

function ensureSoundFile(tone, volume) {
  const soundFilePath = getSoundFilePath(tone, volume);
  if (fs.existsSync(soundFilePath)) {
    return soundFilePath;
  }

  fs.mkdirSync(SOUND_CACHE_DIR, { recursive: true });
  fs.writeFileSync(soundFilePath, buildChimeWav(tone, volume));
  return soundFilePath;
}

function escapePowerShellSingleQuotedValue(value) {
  return String(value || '').replace(/'/g, "''");
}

function buildPowerShellSoundScript({ soundFilePath, durationMs, toneDurationMs }) {
  const repeatDelayMs = getRepeatDelayMs(durationMs);
  const escapedSoundFilePath = escapePowerShellSingleQuotedValue(soundFilePath);
  return [
    '$ErrorActionPreference = "Stop"',
    `$soundPath = '${escapedSoundFilePath}'`,
    `$durationMs = ${durationMs}`,
    `$toneDurationMs = ${toneDurationMs}`,
    `$repeatDelayMs = ${repeatDelayMs}`,
    '$end = [DateTime]::UtcNow.AddMilliseconds($durationMs)',
    'try {',
    '  $player = New-Object System.Media.SoundPlayer($soundPath)',
    '  $player.Load()',
    '  Write-Output "engine=soundplayer status=loaded"',
    '  while ([DateTime]::UtcNow -lt $end) {',
    '    $player.PlaySync()',
    '    Start-Sleep -Milliseconds $repeatDelayMs',
    '  }',
    '  Write-Output "engine=soundplayer status=ok"',
    '  exit 0',
    '} catch {',
    '  Write-Output ("engine=soundplayer status=fail message=" + $_.Exception.Message)',
    '  try {',
    '    Add-Type -AssemblyName PresentationCore',
    '    $uri = New-Object System.Uri($soundPath)',
    '    while ([DateTime]::UtcNow -lt $end) {',
    '      $mediaPlayer = New-Object System.Windows.Media.MediaPlayer',
    '      $mediaPlayer.Open($uri)',
    '      $mediaPlayer.Play()',
    '      Start-Sleep -Milliseconds $toneDurationMs',
    '      $mediaPlayer.Stop()',
    '      $mediaPlayer.Close()',
    '      Start-Sleep -Milliseconds $repeatDelayMs',
    '    }',
    '    Write-Output "engine=mediaplayer status=ok"',
    '    exit 0',
    '  } catch {',
    '    Write-Output ("engine=mediaplayer status=fail message=" + $_.Exception.Message)',
    '    exit 2',
    '  }',
    '}'
  ].join('; ');
}

function createNativeNotificationSoundService({ writeLog = () => {} } = {}) {
  const activeChildren = new Set();
  let lastStartedAt = 0;
  let lastState = {
    activeCount: 0,
    lastResult: null,
    lastExit: null,
    lastError: null
  };

  function updateState(patch = {}) {
    lastState = {
      ...lastState,
      ...patch,
      activeCount: activeChildren.size,
      updatedAt: new Date().toISOString()
    };
  }

  function appendLimitedOutput(currentValue, chunk) {
    const nextValue = `${currentValue || ''}${chunk || ''}`;
    return nextValue.length > 1200 ? nextValue.slice(-1200) : nextValue;
  }

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
    updateState({ lastStopReason: reason });
    writeLog('notification_sound_stop', { reason, count: stoppedCount });
  }

  function playNotificationSound(options = {}) {
    if (process.platform !== 'win32') {
      updateState({ lastResult: { played: false, reason: 'unsupported_platform' } });
      return { played: false, reason: 'unsupported_platform' };
    }

    const now = Date.now();
    if (activeChildren.size > 0 && now - lastStartedAt < RESTART_COOLDOWN_MS) {
      updateState({ lastResult: { played: false, reason: 'cooldown' } });
      return { played: false, reason: 'cooldown' };
    }

    stopNotificationSound('restart');

    const durationMs = getSoundDurationMs(options);
    const tone = normalizeTone(options.soundTone);
    const volume = clampVolume(options.volume);
    const powershellPath = getPowerShellPath();

    let soundFilePath;
    try {
      soundFilePath = ensureSoundFile(tone, volume);
    } catch (error) {
      writeLog('notification_sound_asset_error', { message: error?.message });
      updateState({
        lastError: {
          stage: 'asset',
          message: error?.message || String(error)
        },
        lastResult: {
          played: false,
          reason: 'asset_failed'
        }
      });
      return {
        played: false,
        reason: 'asset_failed',
        message: error?.message || String(error)
      };
    }

    const toneDurationMs = getPatternDurationMs(TONE_PATTERNS[tone] || TONE_PATTERNS.smoothChime);
    const script = buildPowerShellSoundScript({ soundFilePath, durationMs, toneDurationMs });

    try {
      const child = spawn(
        powershellPath,
        [
          '-STA',
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
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );

      activeChildren.add(child);
      lastStartedAt = now;
      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk) => {
        stdout = appendLimitedOutput(stdout, chunk.toString('utf8'));
      });

      child.stderr?.on('data', (chunk) => {
        stderr = appendLimitedOutput(stderr, chunk.toString('utf8'));
      });

      child.once('exit', (code, signal) => {
        activeChildren.delete(child);
        const exitState = {
          code,
          signal,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        };
        updateState({
          lastExit: exitState,
          lastError: code === 0 ? null : {
            stage: 'player_exit',
            code,
            stderr: exitState.stderr || null
          }
        });
        writeLog('notification_sound_exit', exitState);
      });

      child.once('error', (error) => {
        activeChildren.delete(child);
        const errorState = { stage: 'spawn_event', message: error?.message };
        updateState({
          lastError: errorState,
          lastResult: {
            played: false,
            reason: 'spawn_event_error'
          }
        });
        writeLog('notification_sound_error', errorState);
      });

      child.unref();
      updateState({
        lastResult: {
          played: true,
          engine: 'powershell-elvador-chime',
          tone,
          durationMs,
          source: options.source || null
        },
        lastError: null
      });
      writeLog('notification_sound_start', {
        durationMs,
        tone,
        profile: options.profile || null,
        source: options.source || null,
        fileSize: fs.statSync(soundFilePath).size,
        shell: path.basename(powershellPath)
      });

      return {
        played: true,
        engine: 'powershell-elvador-chime',
        durationMs,
        tone
      };
    } catch (error) {
      writeLog('notification_sound_spawn_error', { message: error?.message });
      updateState({
        lastError: {
          stage: 'spawn',
          message: error?.message || String(error)
        },
        lastResult: {
          played: false,
          reason: 'spawn_failed'
        }
      });
      return {
        played: false,
        reason: 'spawn_failed',
        message: error?.message || String(error)
      };
    }
  }

  return {
    playNotificationSound,
    stopNotificationSound,
    getState: () => ({
      ...lastState,
      activeCount: activeChildren.size
    })
  };
}

module.exports = {
  createNativeNotificationSoundService
};
