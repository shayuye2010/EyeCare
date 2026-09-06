import { describe, expect, it, vi } from 'vitest';
import { claimWindowAction, shouldRestoreMainForTray, withTimeout } from './interaction';

describe('desktop interaction guards', () => {
  it('allows only one window action at a time', () => {
    expect(claimWindowAction(undefined, 'minimize')).toBe('minimize');
    expect(claimWindowAction('minimize', 'quit')).toBeUndefined();
    expect(claimWindowAction(undefined, 'quit')).toBe('quit');
  });

  it('restores the main window unless tray already restored it', () => {
    expect(shouldRestoreMainForTray(undefined)).toBe(true);
    expect(shouldRestoreMainForTray(false)).toBe(true);
    expect(shouldRestoreMainForTray(true)).toBe(false);
  });

  it('rejects a stalled desktop request and clears its timer', async () => {
    vi.useFakeTimers();
    const request = withTimeout(new Promise<never>(() => undefined), 100, 'desktop timeout');
    const assertion = expect(request).rejects.toThrow('desktop timeout');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('settles before the timeout when the desktop request completes', async () => {
    vi.useFakeTimers();
    const request = withTimeout(Promise.resolve('ok'), 100);
    await expect(request).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
