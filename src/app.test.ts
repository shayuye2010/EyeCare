import { afterEach, expect, it, vi } from 'vitest';
import { defaultState } from './state';
import { storageKey } from './storage';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

it.each(['smart', 'fullscreen', 'flash', 'toast'] as const)(
  'restores the desktop window when %s expires without a frontend hide event',
  async (notifyStyle) => {
    vi.useFakeTimers();
    const state = defaultState();
    state.notifyStyle = notifyStyle;
    state.phaseEndsAt = Date.now() + 1000;
    state.settings.soundEnabled = false;
    state.settings.floatingEnabled = false;
    const classes = new Set<string>();
    const toast = {
      querySelector: () => null,
      classList: {
        add: (value: string) => classes.add(value),
        remove: (value: string) => classes.delete(value),
      },
      setAttribute: vi.fn(),
    };
    // Only the mount and reminder surface are needed for this desktop-flow check.
    vi.stubGlobal('document', {
      querySelector: (selector: string) => selector === '#app' ? { innerHTML: '' }
        : selector === '#cornerToast' ? toast : null,
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {},
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === storageKey ? JSON.stringify(state) : null,
      setItem: vi.fn(),
    });
    const { invoke } = await import('@tauri-apps/api/core');
    await import('./app');
    await vi.advanceTimersByTimeAsync(1000);

    expect(invoke).toHaveBeenCalledWith('show_main_window', undefined);
    expect(classes.has('show')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'show_main_window')).toHaveLength(1);
  },
);
