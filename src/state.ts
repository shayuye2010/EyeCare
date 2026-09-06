export type Mode = '20' | 'pomo' | 'custom';
export type NotifyStyle = 'smart' | 'fullscreen' | 'flash' | 'toast';

export interface Settings {
  guardEnabled: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  smartAvoidance: boolean;
  startOnBoot: boolean;
  floatingEnabled: boolean;
  customMinutes: number;
}

export interface Stats {
  date: string;
  completed: number;
  skipped: number;
  focusedMinutes: number;
}

export interface PersistedState {
  version: 3;
  mode: Mode;
  paused: boolean;
  phaseEndsAt: number | null;
  pausedRemaining: number;
  notifyStyle: NotifyStyle;
  settings: Settings;
  stats: Stats;
}

export const defaultSettings: Settings = {
  guardEnabled: true,
  soundEnabled: true,
  soundVolume: 0.18,
  smartAvoidance: false,
  startOnBoot: false,
  floatingEnabled: true,
  customMinutes: 45,
};

/** The largest value accepted for a persisted statistic. */
export const MAX_STAT_VALUE = 1_000_000;

export function today(): string {
  const date = new Date();
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function defaultState(): PersistedState {
  return {
    version: 3,
    mode: '20',
    paused: false,
    phaseEndsAt: Date.now() + 20 * 60 * 1000,
    pausedRemaining: 20 * 60,
    notifyStyle: 'smart',
    settings: { ...defaultSettings },
    stats: { date: today(), completed: 0, skipped: 0, focusedMinutes: 0 },
  };
}

export function totalSeconds(state: Pick<PersistedState, 'mode' | 'settings'>): number {
  if (state.mode === 'pomo') return 25 * 60;
  if (state.mode === 'custom') return Math.min(180, Math.max(1, state.settings.customMinutes)) * 60;
  return 20 * 60;
}

function emptyStats(): Stats {
  return { date: today(), completed: 0, skipped: 0, focusedMinutes: 0 };
}

function finiteNonNegative(value: unknown, fallback: number, maximum = Number.POSITIVE_INFINITY): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Convert the currently supported payload (and the old unversioned/v0 shape)
 * to the current version. Unknown versions are deliberately not migrated.
 */
export function migrateState(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const version = raw.version;
  if (version === 3) return { ...raw };
  if (version === 2) return {
    ...raw,
    version: 3,
    settings: { ...(isRecord(raw.settings) ? raw.settings : {}), floatingEnabled: true },
  };
  if (version === 1) return {
    ...raw,
    version: 3,
    notifyStyle: raw.notifyStyle === 'fullscreen' ? 'smart' : raw.notifyStyle,
    settings: { ...(isRecord(raw.settings) ? raw.settings : {}), floatingEnabled: true },
  };
  if (version === 0 || version === undefined) return {
    ...raw,
    version: 3,
    notifyStyle: 'smart',
    settings: { ...(isRecord(raw.settings) ? raw.settings : {}), floatingEnabled: true },
  };
  return null;
}

export function freshStats(stats: Stats): Stats {
  return stats.date === today() ? stats : emptyStats();
}

export function normalizeState(raw: unknown): PersistedState {
  const base = defaultState();
  const migrated = migrateState(raw);
  if (!migrated) return base;

  const mode: Mode = migrated.mode === 'pomo' || migrated.mode === 'custom' ? migrated.mode : '20';
  const notifyStyle: NotifyStyle = migrated.notifyStyle === 'edge' ? 'flash' : migrated.notifyStyle === 'smart' || migrated.notifyStyle === 'flash' || migrated.notifyStyle === 'fullscreen' || migrated.notifyStyle === 'toast' ? migrated.notifyStyle : 'smart';
  const persistedSettings = isRecord(migrated.settings) ? migrated.settings : {};
  const settings: Settings = {
    guardEnabled: normalizeBoolean(persistedSettings.guardEnabled, defaultSettings.guardEnabled),
    soundEnabled: normalizeBoolean(persistedSettings.soundEnabled, defaultSettings.soundEnabled),
    soundVolume: finiteNonNegative(persistedSettings.soundVolume, defaultSettings.soundVolume, 1),
    smartAvoidance: normalizeBoolean(persistedSettings.smartAvoidance, defaultSettings.smartAvoidance),
    startOnBoot: normalizeBoolean(persistedSettings.startOnBoot, defaultSettings.startOnBoot),
    floatingEnabled: normalizeBoolean(persistedSettings.floatingEnabled, defaultSettings.floatingEnabled),
    customMinutes: Math.min(180, Math.max(1, finiteNonNegative(persistedSettings.customMinutes, defaultSettings.customMinutes))),
  };
  const duration = totalSeconds({ mode, settings });
  const persistedStats = isRecord(migrated.stats) ? migrated.stats : {};
  const stats = freshStats({
    date: typeof persistedStats.date === 'string' ? persistedStats.date : '',
    completed: finiteNonNegative(persistedStats.completed, 0, MAX_STAT_VALUE),
    skipped: finiteNonNegative(persistedStats.skipped, 0, MAX_STAT_VALUE),
    focusedMinutes: finiteNonNegative(persistedStats.focusedMinutes, 0, MAX_STAT_VALUE),
  });
  const paused = normalizeBoolean(migrated.paused, base.paused);
  const storedPhaseEndsAt = typeof migrated.phaseEndsAt === 'number' && Number.isFinite(migrated.phaseEndsAt) ? migrated.phaseEndsAt : null;
  const now = Date.now();
  const phaseEndsAt = paused ? null : storedPhaseEndsAt !== null && storedPhaseEndsAt > now ? storedPhaseEndsAt : now + duration * 1000;
  const pausedRemaining = typeof migrated.pausedRemaining === 'number' && Number.isFinite(migrated.pausedRemaining)
    ? Math.min(duration, Math.max(0, migrated.pausedRemaining))
    : duration;

  return {
    ...base,
    mode,
    paused,
    phaseEndsAt,
    pausedRemaining,
    notifyStyle,
    settings,
    stats,
  };
}
