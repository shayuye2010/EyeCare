import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface TimerSnapshot {
  remaining: number;
  total: number;
  progress: number;
  paused: boolean;
}

const CIRCUMFERENCE = 2 * Math.PI * 29;
const root = document.querySelector<HTMLElement>('#floating');
const time = document.querySelector<HTMLElement>('#time');
const progress = document.querySelector<SVGCircleElement>('#progress');
const stateLabel = document.querySelector<HTMLElement>('#stateLabel');
let currentUnlisten: (() => void) | undefined;

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeSnapshot(payload: unknown): TimerSnapshot {
  const value = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
  const total = Math.max(1, finiteNonNegative(value.total, 20 * 60));
  const remaining = Math.min(total, finiteNonNegative(value.remaining, total));
  const progressValue = finiteNonNegative(value.progress, remaining / total);
  return {
    remaining,
    total,
    progress: Math.min(1, progressValue),
    paused: value.paused === true,
  };
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function updateSnapshot(payload: unknown): void {
  const snapshot = normalizeSnapshot(payload);
  const paused = snapshot.paused;
  const text = formatTime(snapshot.remaining);
  if (time) time.textContent = text;
  if (progress) progress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - snapshot.progress));
  root?.classList.toggle('paused', paused);
  const status = paused ? '计时已暂停' : '正在专注';
  if (stateLabel) stateLabel.textContent = paused ? '已暂停' : '专注中';
  if (root) root.setAttribute('aria-label', `护眼倒计时 ${text}，${status}，点击恢复主窗口`);
}

async function restoreMainWindow(): Promise<void> {
  try {
    await invoke('show_main_window');
  } catch (error) {
    console.error('EyeCare failed to restore the main window', error);
  }
}

async function startDragging(): Promise<void> {
  try {
    await getCurrentWindow().startDragging();
  } catch (error) {
    console.error('EyeCare failed to drag the floating window', error);
  }
}

function bindInteractions(): void {
  root?.addEventListener('click', (event) => {
    if (event.target === document.querySelector('#dragRegion')) return;
    void restoreMainWindow();
  });
  root?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void restoreMainWindow();
  });
  document.querySelector('#dragRegion')?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void startDragging();
  });
  document.querySelector('#dragRegion')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
}

async function initialize(): Promise<void> {
  bindInteractions();
  try {
    currentUnlisten = await listen<TimerSnapshot>('timer-snapshot', (event) => updateSnapshot(event.payload));
    await emit('floating-ready');
  } catch (error) {
    console.error('EyeCare floating window event setup failed', error);
  }
}

window.addEventListener('beforeunload', () => {
  currentUnlisten?.();
  currentUnlisten = undefined;
});

updateSnapshot({ remaining: 20 * 60, total: 20 * 60, progress: 1, paused: false });
void initialize();
