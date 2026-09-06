import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultState } from './state';
import { TimerEngine } from './timer';

afterEach(() => {
  vi.useRealTimers();
});

describe('TimerEngine', () => {
  it('emits a due event once and starts the next phase from a deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const state = defaultState();
    state.phaseEndsAt = Date.now() + 1000;
    const due = vi.fn();
    const snapshots: number[] = [];
    const timer = new TimerEngine(state, (snapshot) => snapshots.push(snapshot.remaining), due);

    timer.start();
    vi.advanceTimersByTime(1000);
    expect(due).toHaveBeenCalledTimes(1);
    expect(state.phaseEndsAt).toBe(Date.now() + 20 * 60 * 1000);
    expect(snapshots.at(-1)).toBe(1200);

    vi.advanceTimersByTime(1000);
    expect(due).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  it('pauses and resumes without losing the remaining duration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const state = defaultState();
    const timer = new TimerEngine(state, () => undefined, () => undefined);
    timer.start();
    vi.advanceTimersByTime(2500);
    timer.togglePause();
    const paused = timer.remaining();
    expect(state.paused).toBe(true);
    expect(paused).toBe(1198);
    vi.advanceTimersByTime(5000);
    expect(timer.remaining()).toBe(paused);
    timer.togglePause();
    expect(state.paused).toBe(false);
    expect(timer.remaining()).toBe(paused);
    timer.stop();
  });
});
