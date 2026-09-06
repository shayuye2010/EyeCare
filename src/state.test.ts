import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultState,
  freshStats,
  normalizeState,
  today,
  totalSeconds,
} from './state';
import {
  loadState,
  resetStorageErrorReporting,
  saveState,
  setStorageErrorReporter,
  storageKey,
} from './storage';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setStorageErrorReporter();
  resetStorageErrorReporting();
});

describe('state normalization', () => {
  it('uses valid defaults for malformed persisted data', () => {
    const state = normalizeState({ mode: 'bad', settings: { customMinutes: 999 } });
    expect(state.mode).toBe('20');
    expect(state.settings.customMinutes).toBe(180);
    expect(state.stats.completed).toBe(0);
  });

  it('uses the local calendar date rather than the UTC date', () => {
    const localDate = new Date(2024, 6, 9, 0, 30, 0);
    vi.setSystemTime(localDate);
    const expected = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`;
    expect(today()).toBe(expected);
    expect(freshStats({ date: '2024-06-08', completed: 4, skipped: 2, focusedMinutes: 10 })).toEqual({
      date: expected,
      completed: 0,
      skipped: 0,
      focusedMinutes: 0,
    });
  });

  it('accepts only booleans and strictly normalizes numeric fields', () => {
    const state = normalizeState({
      mode: 'pomo',
      paused: 'false',
      pausedRemaining: 999999,
      settings: {
        guardEnabled: 0,
        soundEnabled: 'false',
        smartAvoidance: 1,
        startOnBoot: null,
        soundVolume: 0,
      },
      stats: {
        date: today(),
        completed: '12',
        skipped: -1,
        focusedMinutes: Number.POSITIVE_INFINITY,
      },
    });
    expect(state.paused).toBe(false);
    expect(state.pausedRemaining).toBe(1500);
    expect(state.settings.guardEnabled).toBe(true);
    expect(state.settings.soundEnabled).toBe(true);
    expect(state.settings.smartAvoidance).toBe(false);
    expect(state.settings.startOnBoot).toBe(false);
    expect(state.settings.floatingEnabled).toBe(true);
    expect(state.settings.soundVolume).toBe(0);
    expect(state.stats).toEqual({ date: today(), completed: 0, skipped: 0, focusedMinutes: 0 });
  });

  it('clamps valid statistics to a safe upper bound', () => {
    const state = normalizeState({
      stats: { date: today(), completed: 2_000_000, skipped: 7, focusedMinutes: 1_000_001 },
    });
    expect(state.stats.completed).toBe(1_000_000);
    expect(state.stats.skipped).toBe(7);
    expect(state.stats.focusedMinutes).toBe(1_000_000);
  });

  it('handles unknown versions by returning a safe default', () => {
    const state = normalizeState({ version: 999, mode: 'pomo', paused: true, settings: { soundVolume: 0 } });
    expect(state.version).toBe(3);
    expect(state.mode).toBe('20');
    expect(state.paused).toBe(false);
    expect(state.settings.soundVolume).toBe(0.18);
  });

  it('migrates the old unversioned shape to smart reminders', () => {
    expect(normalizeState({ mode: 'pomo', settings: { soundVolume: 0 } }).mode).toBe('pomo');
    expect(normalizeState({ version: 0, settings: { soundVolume: 0 } }).settings.soundVolume).toBe(0);
    expect(normalizeState({ version: 0 }).notifyStyle).toBe('smart');
  });

  it('migrates the blocking fullscreen preference to smart reminders', () => {
    expect(normalizeState({ version: 1, notifyStyle: 'fullscreen' }).notifyStyle).toBe('smart');
    expect(normalizeState({ version: 2, notifyStyle: 'smart' }).notifyStyle).toBe('smart');
  });

  it('migrates v0, v1, and v2 data with floating enabled by default', () => {
    expect(normalizeState({ version: 0 }).version).toBe(3);
    expect(normalizeState({ version: 0 }).settings.floatingEnabled).toBe(true);
    expect(normalizeState({ version: 1 }).settings.floatingEnabled).toBe(true);
    expect(normalizeState({ version: 2 }).settings.floatingEnabled).toBe(true);
    expect(normalizeState({ version: 3, settings: { floatingEnabled: false } }).settings.floatingEnabled).toBe(false);
  });

  it('limits paused remaining to the current mode duration', () => {
    expect(normalizeState({ mode: 'custom', settings: { customMinutes: 10 }, paused: true, pausedRemaining: 999 }).pausedRemaining).toBe(600);
    expect(normalizeState({ mode: 'custom', settings: { customMinutes: 10 }, paused: true, pausedRemaining: -1 }).pausedRemaining).toBe(0);
    expect(normalizeState({ mode: 'custom', settings: { customMinutes: 10 }, paused: true, pausedRemaining: '600' }).pausedRemaining).toBe(600);
  });

  it('calculates each supported focus duration', () => {
    expect(totalSeconds(defaultState())).toBe(1200);
    expect(totalSeconds({ mode: 'pomo', settings: defaultState().settings })).toBe(1500);
    expect(totalSeconds({ mode: 'custom', settings: { ...defaultState().settings, customMinutes: 30 } })).toBe(1800);
  });
});

describe('storage reliability', () => {
  it('returns defaults and reports a load failure only once', () => {
    const error = new Error('storage unavailable');
    const getItem = vi.fn(() => { throw error; });
    vi.stubGlobal('localStorage', { getItem, setItem: vi.fn() });
    const reporter = vi.fn();
    setStorageErrorReporter(reporter);

    expect(loadState().mode).toBe('20');
    expect(loadState().mode).toBe('20');
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith({ operation: 'load', error });
  });

  it('does not throw on save failure and avoids duplicate diagnostics', () => {
    const error = new Error('quota exceeded');
    const setItem = vi.fn(() => { throw error; });
    vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem });
    const reporter = vi.fn();
    setStorageErrorReporter(reporter);

    expect(() => saveState(defaultState())).not.toThrow();
    expect(() => saveState(defaultState())).not.toThrow();
    expect(setItem).toHaveBeenCalledWith(storageKey, expect.any(String));
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith({ operation: 'save', error });
  });
});
