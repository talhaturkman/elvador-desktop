// 2026-10-13: Sparse account preferences preserve the existing notification design
// until staff explicitly customize it. Keep this contract independent of access rules.
export const TYPE_KEYS = ['liveSupport', 'housekeeping', 'technic', 'reservation', 'ordersRequests', 'ordersReservations', 'spaRequests', 'lostAndFound', 'analyticsConversations', 'upsellRequests'];
export const ENUMS = { size: ['small', 'normal', 'large', 'extra-large'], appearance: ['standard', 'minimal', 'prominent'], color: ['existing', 'neutral', 'blue', 'green', 'red', 'purple'], position: ['top-right', 'top-left', 'bottom-right', 'bottom-left'], duration: [5, 10, 30, 0], soundTone: ['smoothChime', 'orderPing', 'warmBell', 'glassBell', 'mellowTap', 'classicBeep'] };
export const DEFAULT_VIEW = { design: 'existing', width: 390, scale: 1, fontSize: 16, radius: 12, maxHeight: 480, duration: 0, volume: 0.3, position: 'existing', animation: 'default', soundTone: 'smoothChime', profile: 'low', background: '#991b1b', text: '#ffffff', accent: '#5f1024' };
export const DESKTOP_DEFAULT_VIEW = { ...DEFAULT_VIEW, width: 304, fontSize: 15, radius: 10, volume: 0.75, position: 'bottom-right', background: '#18181b' };
export const CUSTOMIZATION_VERSION = 3;
export const DEFAULT_CHOICES = { size: 'normal', appearance: 'standard', color: 'existing', position: 'top-right', duration: 0, soundEnabled: true, soundTone: 'smoothChime' };
export const COLOR_PALETTES = { neutral: ['#27272a', '#ffffff', '#d4d4d8'], blue: ['#1e40af', '#ffffff', '#bfdbfe'], green: ['#166534', '#ffffff', '#bbf7d0'], red: ['#991b1b', '#ffffff', '#fecaca'], purple: ['#581c87', '#ffffff', '#e9d5ff'] };
const sizeMetrics = {
  small: { width: 320, desktopWidth: 270, fontSize: 14, radius: 8, padding: 8, iconSize: 20, maxHeight: 400 },
  normal: { width: 390, desktopWidth: 304, fontSize: 16, radius: 12, padding: 12, iconSize: 24, maxHeight: 480 },
  large: { width: 520, desktopWidth: 380, fontSize: 19, radius: 14, padding: 16, iconSize: 28, maxHeight: 560 },
  'extra-large': { width: 640, desktopWidth: 460, fontSize: 22, radius: 16, padding: 20, iconSize: 32, maxHeight: 640 }
};
export const emptyCustomization = () => ({ version: CUSTOMIZATION_VERSION, notifications: { general: {}, types: {} } });
// 2026-10-13: Replace the CSS-like editor with coordinated presets. Legacy
// records are adapted on read, without mass writes or changing untouched accounts.
function migrateFields(value, surface) {
  if (!value || typeof value !== 'object') return value;
  const migrated = { ...value };
  if (Number.isFinite(value.width) || Number.isFinite(value.fontSize) || Number.isFinite(value.scale)) {
    const base = surface === 'desktop' ? 304 : 390;
    const width = (value.width || base * (value.fontSize || 16) / 16) * (value.scale || 1);
    migrated.size = ENUMS.size.reduce((best, size) => Math.abs(sizeMetrics[size][surface === 'desktop' ? 'desktopWidth' : 'width'] - width) < Math.abs(sizeMetrics[best][surface === 'desktop' ? 'desktopWidth' : 'width'] - width) ? size : best, 'normal');
  }
  if (value.design) migrated.appearance = ({ existing: 'standard', minimal: 'minimal', cards: 'prominent', strip: 'minimal' })[value.design];
  if (/^#[0-9a-f]{6}$/i.test(value.background)) {
    const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
    const input = rgb(value.background);
    const distance = name => rgb(COLOR_PALETTES[name][0]).reduce((sum, channel, index) => sum + (channel - input[index]) ** 2, 0);
    migrated.color = Object.keys(COLOR_PALETTES).reduce((best, name) => distance(name) < distance(best) ? name : best, 'neutral');
  }
  if (Number.isFinite(value.duration)) migrated.duration = value.duration <= 0 ? 0 : [5, 10, 30].reduce((best, seconds) => Math.abs(seconds - value.duration) < Math.abs(best - value.duration) ? seconds : best, 5);
  if (Number.isFinite(value.volume)) migrated.soundEnabled = value.volume > 0;
  return migrated;
}
function normalizeFields(value, isType, surface, legacy) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  if (legacy) value = migrateFields(value, surface);
  for (const key of Object.keys(DEFAULT_CHOICES)) {
    if (isType && surface === 'web' && ['position', 'duration'].includes(key)) continue;
    const candidate = value[key];
    if (key === 'soundEnabled' && typeof candidate === 'boolean') result[key] = candidate;
    else if (ENUMS[key]?.includes(candidate)) result[key] = candidate;
  }
  return result;
}
function normalizeSurface(value, surface, legacy) {
  const result = { general: normalizeFields(value?.general, false, surface, legacy), types: {} };
  for (const key of TYPE_KEYS) {
    const fields = normalizeFields(value?.types?.[key], true, surface, legacy);
    if (Object.keys(fields).length) result.types[key] = fields;
  }
  return result;
}
export function normalizeCustomization(value) {
  const legacy = value?.version === 1 || value?.version === 2;
  const result = { version: CUSTOMIZATION_VERSION, notifications: normalizeSurface(value?.notifications, 'web', legacy) };
  const desktop = normalizeSurface(value?.notifications?.desktop, 'desktop', legacy);
  // 2026-10-13: Web queue styles and native short cards are separate surfaces;
  // changing the web appearance must not unexpectedly restyle the desktop.
  if (Object.keys(desktop.general).length || Object.keys(desktop.types).length) result.notifications.desktop = desktop;
  return result;
}
export function notificationPreferences(value, surface = 'web') {
  return surface === 'desktop' ? (value?.notifications?.desktop || { general: {}, types: {} })
    : (value?.notifications || { general: {}, types: {} });
}
export function customizationForSurface(value, surface = 'web') {
  const { general, types } = notificationPreferences(value, surface);
  return { version: CUSTOMIZATION_VERSION, notifications: { general, types } };
}
export function notificationType(value) {
  const aliases = { orders: 'ordersRequests', ordersKitchen: 'ordersRequests', roomServiceRequests: 'ordersRequests', conversation: 'analyticsConversations', spa: 'spaRequests', upsell: 'upsellRequests' };
  const key = String(value || '').split('-')[0];
  return aliases[key] || key;
}
export function resolveNotificationStyle(value, type, surface = 'web') {
  const choices = resolveNotificationChoices(value, type, surface);
  const result = {};
  if (choices.size) {
    const metrics = sizeMetrics[choices.size];
    const { desktopWidth, ...web } = metrics;
    Object.assign(result, web, { width: surface === 'desktop' ? desktopWidth : web.width, fontSize: web.fontSize - (surface === 'desktop' ? 1 : 0), scale: 1 });
  }
  if (choices.appearance) {
    result.design = { standard: 'existing', minimal: 'minimal', prominent: 'cards' }[choices.appearance];
    if (choices.appearance === 'minimal') result.radius = 4;
  }
  if (choices.color) {
    const fallback = surface === 'desktop' ? DESKTOP_DEFAULT_VIEW : DEFAULT_VIEW;
    const [background, text, accent] = COLOR_PALETTES[choices.color] || [fallback.background, fallback.text, fallback.accent];
    Object.assign(result, { background, text, accent });
  }
  for (const key of ['position', 'duration', 'soundTone']) if (choices[key] !== undefined) result[key] = choices[key];
  if (choices.soundEnabled !== undefined) result.volume = choices.soundEnabled ? (surface === 'desktop' ? .75 : .3) : 0;
  return result;
}
export function resolveNotificationChoices(value, type, surface = 'web') {
  const preferences = notificationPreferences(value, surface);
  return { ...preferences.general, ...preferences.types?.[notificationType(type)] };
}
// Native consumes a safe presentation projection, while Firebase keeps choices.
// The caller has already selected/flattened the desktop group for this bridge.
export function desktopNotificationPresentation(value) {
  const desktop = normalizeCustomization({ version: value?.version, notifications: { general: {}, types: {}, desktop: value?.notifications } });
  const types = {};
  for (const key of Object.keys(desktop.notifications.desktop?.types || {})) types[key] = resolveNotificationStyle(desktop, key, 'desktop');
  return { version: CUSTOMIZATION_VERSION, notifications: { general: resolveNotificationStyle(desktop, null, 'desktop'), types } };
}
export function notificationDeadline(duration, now = Date.now()) {
  return Number.isFinite(duration) && duration > 0 ? now + duration * 1000 : null;
}
export function notificationDeadlineElapsed(deadline, now = Date.now()) {
  return Number.isFinite(deadline) && now >= deadline;
}
export function notificationGeometry(fields, viewport, height) {
  const scale = fields.scale || 1;
  const width = Math.min(fields.width || 390, Math.max(1, (viewport.width - 24) / scale));
  const maxHeight = Math.max(48, Math.min(fields.maxHeight || 480, (viewport.height - 120) / scale));
  const visualHeight = Math.min(height, maxHeight) * scale;
  const position = fields.position || 'existing';
  const x = position === 'center' ? (viewport.width - width * scale) / 2
    : position.endsWith('left') ? 12 : viewport.width - width * scale - 12;
  const y = position === 'center' ? (viewport.height - visualHeight) / 2
    : position.startsWith('bottom') ? viewport.height - visualHeight - 84 : 76;
  return { scale, width, maxHeight, x: Math.max(12, x), y: Math.max(12, Math.min(y, viewport.height - visualHeight - 12)) };
}
