import './styles.css';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { defaultSettings, freshStats, Mode, NotifyStyle, PersistedState } from './state';
import { loadState, saveState, setStorageErrorReporter } from './storage';
import { TimerEngine, TimerSnapshot } from './timer';
import { claimWindowAction, shouldRestoreMainForTray, withTimeout } from './interaction';

const eyeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2.5 12s3.6-6 9.5-6 9.5 6 9.5 6-3.6 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.8"/></svg>';
const chartIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 19V5m0 14h16"/><path d="m7 15 3-4 3 2 5-7"/></svg>';
const settingsIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="m19.4 15 .1.1a1.8 1.8 0 0 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3 .9v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3-.9l-.1.1a1.8 1.8 0 0 1-2.5-2.5l.1-.1a1.8 1.8 0 0 0-.9-3h-.2a1.8 1.8 0 0 1 0-3.6H4a1.8 1.8 0 0 0 .9-3l-.1-.1a1.8 1.8 0 0 1 2.5-2.5l.1.1a1.8 1.8 0 0 0 3-.9v-.2a1.8 1.8 0 0 1 3.6 0v.2a1.8 1.8 0 0 0 3 .9l.1-.1a1.8 1.8 0 0 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 .9 3h.2a1.8 1.8 0 0 1 0 3.6h-.2a1.8 1.8 0 0 0-.9 3Z"/></svg>';
const pauseIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 5v14M16 5v14"/><circle cx="12" cy="12" r="9"/></svg>';
const playIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m10 8 6 4-6 4V8Z"/><circle cx="12" cy="12" r="9"/></svg>';
const resetIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4.5 9A8 8 0 1 1 4 14"/><path d="M4 4v5h5"/></svg>';
const closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
const minimizeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14"/></svg>';
const bellIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/></svg>';
const sparkleIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m12 2 1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/></svg>';

type BreakAction = 'snooze' | 'skip' | 'done';
type StatsPeriod = 'day' | 'week' | 'month';
type HostOptions = { silent?: boolean; timeoutMs?: number };
let timer: TimerEngine;
let state: PersistedState;
let floatingEnabled = true;
let mainHidden = false;
let floatingStatus: 'ready' | 'hidden' | 'syncing' | 'unavailable' = 'ready';
let floatingSyncRequest = 0;
let latestTimerSnapshot: TimerSnapshot | undefined;
let lastFloatingSnapshotKey: string | undefined;
let restInterval: number | undefined;
let edgeTimeout: number | undefined;
let audioContext: AudioContext | undefined;
let keyListenerBound = false;
let windowActionPending: 'minimize' | 'quit' | undefined;
let breakSequence = 0;
let breakSession: { id: number; deadline: number; native: boolean; pending: boolean; completed: boolean } | undefined;
let focusedSeconds = 0;
let focusLastTick = Date.now();
let lastFocusedFlush = 0;
let lastFocusedPaused = false;
let modalTrigger: HTMLElement | undefined;
let pendingStorageError: string | undefined;
let statsPeriod: StatsPeriod = 'day';
type SmartStage = 'quiet' | 'edge' | 'card';
let smartStage: SmartStage = 'quiet';
let smartEscalationTimer: number | undefined;
let smartReminderActive = false;
let bridgeUnlisten: Array<() => void> = [];

function inTauri(): boolean { return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__); }

function showError(message: string): void {
  console.error(`[EyeCare] ${message}`);
  if (!document.querySelector('#cornerToast')) { pendingStorageError = message; return; }
  const toast = document.querySelector('#cornerToast');
  const title = toast?.querySelector('h3');
  const desc = toast?.querySelector('p');
  if (title && desc) { title.textContent = '操作未完成'; desc.textContent = message; }
  toast?.classList.add('show');
  toast?.setAttribute('aria-hidden', 'false');
}

function invokeHost<T>(command: string, args?: Record<string, unknown>, options: HostOptions = {}): Promise<T> {
  if (!inTauri()) return Promise.reject(new Error('当前运行环境不支持桌面功能'));
  const request = Promise.resolve().then(() => invoke<T>(command, args));
  const timeoutMs = options.timeoutMs ?? 8_000;
  const guarded = timeoutMs <= 0 ? request : withTimeout(request, timeoutMs, `${command} timed out`);
  return guarded.catch((error: unknown) => {
    console.error(`[EyeCare] ${command} failed`, error);
    if (!options.silent) {
      const detail = error instanceof Error ? error.message : String(error);
      showError(`${command} 失败：${detail || '请稍后重试'}`);
    }
    throw error;
  });
}

function render(): void {
  document.querySelector('#app')!.innerHTML = `
    <div class="app-shell">
      <div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>
      <main class="app-window" aria-label="EyeCare 亮睛睛">
        <header class="titlebar">
          <div class="brand">
            <div class="brand-mark">${eyeIcon}</div>
            <div class="brand-copy"><div class="brand-name">EyeCare <span>亮睛睛</span></div><div class="brand-tagline">每天多眨一次眼</div></div>
          </div>
          <div class="title-actions">
            <button class="icon-btn" id="statsButton" title="健康统计" aria-label="健康统计">${chartIcon}</button>
            <button class="icon-btn" id="settingsButton" title="偏好设置" aria-label="偏好设置">${settingsIcon}</button>
            <button class="icon-btn" id="minimizeButton" title="最小化到托盘" aria-label="最小化到托盘">${minimizeIcon}</button>
            <button class="icon-btn quit-btn" id="quitButton" title="退出应用" aria-label="退出应用">${closeIcon}</button>
          </div>
        </header>

        <section class="content">
          <div class="eyebrow"><span class="eyebrow-dot"></span><span>专注，也要记得照顾眼睛</span><span class="eyebrow-line"></span></div>
          <div class="mode-tabs" role="tablist" aria-label="计时模式">
            ${modeTab('20', '20-20-20', '科学护眼', 'panel-20')}
            ${modeTab('pomo', '番茄专注', '高效工作', 'panel-pomo')}
            ${modeTab('custom', '自定义', '按需调整', 'panel-custom')}
          </div>
          <div id="panel-20" class="tab-panel" role="tabpanel" aria-label="20-20-20 模式"><span class="sr-only">每专注 20 分钟，看向约 6 米外的远方 20 秒。</span></div>
          <div id="panel-pomo" class="tab-panel" role="tabpanel" aria-label="番茄专注模式" hidden><span class="sr-only">借鉴番茄工作法，每专注 25 分钟，看向约 6 米外的远方 20 秒。</span></div>
          <div id="panel-custom" class="tab-panel" role="tabpanel" aria-label="自定义模式" hidden><span class="sr-only">自定义 1 到 180 分钟的专注时长，提醒时看向约 6 米外的远方 20 秒。</span></div>

          <div id="modeSummary" class="mode-summary" aria-live="polite"><strong id="modeName">20-20-20 护眼</strong><span id="modeDescription">专注 20 分钟后，远眺 20 秒</span></div>

          <div class="timer-wrap">
            <div class="timer-orbit orbit-one"></div><div class="timer-orbit orbit-two"></div>
            <svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="timer-gradient" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#34d399"/><stop offset=".5" stop-color="#14b8a6"/><stop offset="1" stop-color="#38bdf8"/></linearGradient><filter id="timer-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.8" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><circle class="timer-guide" cx="50" cy="50" r="42"/><circle class="timer-track" cx="50" cy="50" r="42"/><circle id="timerProgress" class="timer-progress" cx="50" cy="50" r="42" stroke-dasharray="263.89" stroke-dashoffset="0" filter="url(#timer-glow)"/></svg>
            <div class="timer-center"><div class="timer-kicker">下一次休息还有</div><div id="timeDisplay" class="timer-value" role="timer" aria-label="专注倒计时" aria-live="off">20:00</div><div class="timer-caption"><span id="statusDot" class="status-dot"></span><span id="statusText">正在专注</span></div></div>
          </div>

          <div class="timer-controls" aria-label="计时控制"><button id="resetButton" class="round-btn" title="重置计时" aria-label="重置计时">${resetIcon}</button><button id="pauseButton" class="pause-btn">${pauseIcon}<span id="pauseText">暂停计时</span></button><button id="breakButton" class="round-btn" title="立即开始休息" aria-label="立即开始休息">${eyeIcon}</button></div>

          <section class="rule-card" aria-labelledby="ruleTitle"><div class="card-heading"><div class="heading-with-icon"><span class="heading-icon teal">${sparkleIcon}</span><div><h2 id="ruleTitle">20-20-20 科学护眼法则</h2><p id="ruleSubtitle">简单、有效、容易坚持的护眼节奏</p></div></div><span class="recommend-badge">推荐</span></div><div id="ruleGrid" class="rule-grid">${ruleMarkup('20')}</div></section>

          <section class="dashboard-stats" aria-label="今日数据"><div class="mini-stat"><span class="mini-stat-icon green">${eyeIcon}</span><div><span class="mini-label">今日完成休息</span><strong id="todayCompleted">0</strong><small>次</small></div></div><div class="mini-stat"><span class="mini-stat-icon blue">${chartIcon}</span><div><span class="mini-label">专注时长</span><strong id="todayFocused">0</strong><small>分钟</small></div></div><div class="mini-stat mini-stat-muted"><span class="mini-stat-icon amber">${bellIcon}</span><div><span class="mini-label">跳过提醒</span><strong id="todaySkipped">0</strong><small>次</small></div></div></section>

          <section class="reminder-card" aria-label="提醒设置"><div class="context-row"><div class="context-label"><span class="context-icon">${bellIcon}</span><div><strong>到期提醒方式</strong><small>选择适合你的提示</small></div></div><select id="notifyStyle" aria-label="到期提醒方式"><option value="smart">智能分级提醒（推荐）</option><option value="fullscreen">桌面提醒卡片（不打断操作）</option><option value="edge">屏幕边缘光晕</option><option value="toast">角落悬浮卡片</option></select></div><div id="customRow" class="context-row" hidden><div class="context-label"><span class="context-icon">${settingsIcon}</span><div><strong>自定义专注时长</strong><small>1–180 分钟</small></div></div><input id="customMinutes" class="number-input" type="number" min="1" max="180" step="1" aria-label="自定义专注时长" /></div><button id="restButton" class="rest-link">${eyeIcon}<span>立即开始休息</span><span class="rest-link-note">预览遮罩</span></button></section>
          <p class="hint">智能提醒会逐级增强 · 始终不抢焦点、不影响鼠标操作</p>
        </section>
      </main>

      <div id="edgeGlow" class="edge-glow" aria-hidden="true"></div>
      <aside id="cornerToast" class="corner-toast" role="status" aria-live="polite" aria-hidden="true"><div class="toast-mark">${eyeIcon}</div><div><h3>该让眼睛休息一下了</h3><p>远眺 20 秒，缓解持续近距离用眼。</p><div class="toast-actions"><button id="toastRest">现在休息</button><button id="toastDismiss">稍后提醒</button></div></div></aside>
      <div id="breakOverlay" class="break-overlay" role="dialog" aria-modal="true" aria-labelledby="breakTitle" aria-describedby="breakDesc" aria-hidden="true" hidden><div class="break-panel"><button id="breakClose" class="break-close" aria-label="完成并关闭休息">${closeIcon}</button><div class="break-eye">${eyeIcon}</div><span class="break-eyebrow">EYE RESET / 护眼时刻</span><h1 id="breakTitle">看向 6 米外的远方</h1><p id="breakDesc">配合呼吸，眨眨眼，让眼部睫状肌彻底放松。</p><div class="exercise-tabs" role="tablist" aria-label="休息练习"><button class="exercise-tab active" role="tab" aria-selected="true" data-exercise="far">远眺放松</button><button class="exercise-tab" role="tab" aria-selected="false" data-exercise="roll">转动眼球</button><button class="exercise-tab" role="tab" aria-selected="false" data-exercise="breathe">深度呼吸</button></div><div id="breakTime" class="break-time" role="timer" aria-live="polite">20s</div><p class="break-tip">多眨眨眼，保持眼部湿润</p><div class="break-actions"><button id="snoozeButton" class="secondary-btn">延后 5 分钟</button><button id="skipButton" class="secondary-btn">跳过本次</button><button id="doneButton" class="primary-btn">完成休息</button></div></div></div>

      ${modalMarkup('settingsModal', 'settingsTitle', '偏好设置', `<div class="modal-intro"><span class="modal-icon green">${settingsIcon}</span><div><p>让提醒节奏更贴合你的工作方式。</p><small>修改会自动保存在本机</small></div></div><div class="modal-section"><h3>计时与提醒</h3><div class="settings-card"><div class="setting-row"><span>到期提醒方式<small>智能升级提醒，始终不阻断鼠标和键盘操作</small></span><select id="notifyStyleSetting" aria-label="设置到期提醒方式"><option value="smart">智能分级提醒（推荐）</option><option value="fullscreen">桌面提醒卡片（不打断操作）</option><option value="edge">屏幕边缘光晕</option><option value="toast">角落悬浮卡片</option></select></div><div class="setting-row" id="customSettingRow"><label for="customMinutesSetting">自定义专注时长<small>自定义模式使用的分钟数</small></label><div class="range-wrap"><output id="customMinutesValue" for="customMinutesSetting">45 分钟</output><input id="customMinutesSetting" type="range" min="1" max="180" step="1" aria-label="自定义专注时长" /></div></div><div class="setting-row"><span>启用护眼提醒<small>在后台持续运行计时</small></span><button id="guardSwitch" class="switch" role="switch" aria-checked="false" aria-label="启用护眼提醒"></button></div><div class="setting-row floating-setting-row"><span>显示悬浮倒计时<small id="floatingStatus" role="status" aria-live="polite">${floatingEnabled ? '悬浮倒计时已开启' : '悬浮倒计时已关闭'}</small></span><button id="floatingSwitch" class="switch" role="switch" aria-checked="${floatingEnabled}" aria-label="显示悬浮倒计时"></button></div><div class="setting-row"><span>提示音<small>提醒到期时播放柔和提示音</small></span><button id="soundSwitch" class="switch" role="switch" aria-checked="false" aria-label="提示音"></button></div></div></div><div class="modal-section"><h3>系统体验</h3><div class="settings-card"><div class="setting-row"><span>智能避让<small>全屏应用时暂缓提醒</small></span><button id="avoidSwitch" class="switch" role="switch" aria-checked="false" aria-label="智能避让"></button></div><div class="setting-row"><span>开机启动<small>登录 Windows 后自动运行</small></span><button id="bootSwitch" class="switch" role="switch" aria-checked="false" aria-label="开机启动"></button></div><label class="setting-row" for="volumeInput"><span>提示音量<small>当前音量 ${(state.settings.soundVolume * 100).toFixed(0)}%</small></span><input id="volumeInput" type="range" min="0" max="1" step="0.01" /></label></div></div><p class="modal-footnote" id="settingsStatus" role="status" aria-live="polite">设置会即时生效。</p>`)}
      ${modalMarkup('statsModal', 'statsTitle', '护眼数据统计', `<div class="modal-intro"><span class="modal-icon blue">${chartIcon}</span><div><p>记录每一次真正完成的休息。</p><small id="statsDate">今日数据</small></div></div><div class="stats-period" role="tablist" aria-label="统计周期"><button id="statsTabDay" role="tab" aria-selected="true">今日</button><button id="statsTabWeek" role="tab" aria-selected="false">本周</button><button id="statsTabMonth" role="tab" aria-selected="false">本月</button></div><div id="statsTodayData"><div class="stat-grid"><div class="stat stat-green"><strong id="statCompleted">0</strong><span>成功休息</span></div><div class="stat stat-blue"><strong id="statFocused">0</strong><span>专注分钟</span></div><div class="stat stat-amber"><strong id="statSkipped">0</strong><span>跳过提醒</span></div></div><div class="progress-card"><div class="progress-heading"><span>休息完成率</span><strong id="statRate">—</strong></div><div class="progress-track"><div id="statProgressBar" class="progress-bar"></div></div><p id="statProgressLabel">还没有休息记录</p></div></div><div id="statsHistoryEmpty" class="stats-empty" hidden><span>${chartIcon}</span><strong>历史汇总暂未记录</strong><p>当前版本保存今日累计数据，后续可继续扩展周/月趋势。</p></div>`)}
      <div id="appStatus" class="sr-only" role="status" aria-live="polite"></div>
    </div>`;
  bindEvents();
  document.querySelectorAll<HTMLOptionElement>('#notifyStyle option, #notifyStyleSetting option').forEach((option) => {
    if (option.value === 'edge') { option.value = 'flash'; option.textContent = '屏幕闪烁提醒（持续到处理）'; }
    if (option.value === 'fullscreen') option.textContent = '全屏挡屏提醒（覆盖屏幕）';
    if (option.value === 'toast') option.textContent = '角落卡片提醒（持续显示）';
  });
  renderSettings();
  updateStats();
  updateModeUi();
  if (pendingStorageError) { const message = pendingStorageError; pendingStorageError = undefined; showError(message); }
}

function modalMarkup(id: string, titleId: string, title: string, body: string): string {
  return `<div id="${id}" class="modal-backdrop" role="presentation" aria-hidden="true" hidden><div class="modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}"><div class="modal-head"><h2 id="${titleId}">${title}</h2><button class="icon-btn close-modal" aria-label="关闭">${closeIcon}</button></div>${body}</div></div>`;
}

function modeTab(mode: Mode, label: string, description: string, panel: string): string {
  const active = state.mode === mode;
  return `<button class="mode-tab ${active ? 'active' : ''}" data-mode="${mode}" role="tab" aria-selected="${active}" aria-controls="${panel}" tabindex="${active ? 0 : -1}"><span>${label}</span><small>${description}</small></button>`;
}

function ruleMarkup(mode: Mode): string {
  if (mode === 'pomo') return '<div><strong class="rule-green">25 分钟</strong><span>深度专注</span></div><div><strong class="rule-teal">20 秒</strong><span>远眺放松</span></div><div><strong class="rule-blue">4 次</strong><span>循环后长休</span></div>';
  if (mode === 'custom') return '<div class="rule-wide"><strong>按你的节奏</strong><span>可在设置中调整 1–180 分钟</span></div>';
  return '<div><strong class="rule-green">20 分钟</strong><span>屏幕专注</span></div><div><strong class="rule-teal">6 米</strong><span>远方视线</span></div><div><strong class="rule-blue">20 秒</strong><span>眼睛放松</span></div>';
}

function modeInfo(): { name: string; description: string; title: string; subtitle: string } {
  if (state.mode === 'pomo') return { name: '番茄专注', description: '专注 25 分钟后，看远方 20 秒', title: '番茄专注 + 护眼休整', subtitle: '专注与休息交替，保持高效节奏' };
  if (state.mode === 'custom') return { name: '自定义专注', description: `专注 ${state.settings.customMinutes} 分钟后，看远方 20 秒`, title: '自定义专注节奏', subtitle: '按照你的工作习惯安排护眼间隔' };
  return { name: '20-20-20 护眼', description: '每专注 20 分钟，看约 6 米外的远方 20 秒', title: '20-20-20 科学护眼法则', subtitle: '简单、有效、容易坚持的护眼节奏' };
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function persist(): void {
  state.stats = freshStats(state.stats);
  state.settings.floatingEnabled = floatingEnabled;
  saveState(state);
}

function readFloatingPreference(): boolean {
  return state.settings.floatingEnabled;
}

function announce(text: string): void { const el = document.querySelector('#appStatus'); if (el) el.textContent = text; }

async function quitApplication(): Promise<void> {
  if (claimWindowAction(windowActionPending, 'quit') === undefined) return;
  windowActionPending = 'quit';
  resetSmartReminder();
  hideToast();
  hideEdge();
  hideBreakUi();
  void invokeHost('quit_app', undefined, { silent: true, timeoutMs: 2_000 })
    .catch((error) => console.error('[EyeCare] quit_app failed', error))
    .finally(() => { windowActionPending = undefined; });
}

async function minimizeApplication(): Promise<boolean> {
  if (claimWindowAction(windowActionPending, 'minimize') === undefined) return false;
  windowActionPending = 'minimize';
  if (!inTauri()) {
    windowActionPending = undefined;
    return false;
  }
  void invokeHost('minimize_to_tray', undefined, { silent: true, timeoutMs: 8_000 })
    .then(() => { mainHidden = true; })
    .catch((error) => {
      console.error('[EyeCare] minimize_to_tray failed', error);
      mainHidden = false;
      const detail = error instanceof Error ? error.message : String(error);
      showError(`最小化到托盘失败：${detail || '请再试一次'}`);
    });
  windowActionPending = undefined;
  return true;
}

async function restoreMainWindow(): Promise<boolean> {
  if (!inTauri()) {
    mainHidden = false;
    return true;
  }
  try {
    await invokeHost('show_main_window', undefined, { silent: true });
    mainHidden = false;
    return true;
  } catch (error) {
    console.error('[EyeCare] show_main_window failed', error);
    return false;
  }
}

async function restoreMainForReminder(): Promise<void> {
  // Native minimization does not update the frontend's hidden flag.
  await restoreMainWindow();
}

async function confirmBreak(): Promise<void> {
  hideToast();
  hideEdge();
  if (!inTauri()) {
    showBreak('fast');
    return;
  }
  const minimized = await minimizeApplication();
  if (minimized) showBreak('fast', true);
}

function setFloatingStatus(status: typeof floatingStatus): void {
  floatingStatus = status;
  const label = document.querySelector<HTMLElement>('#floatingStatus');
  if (label) {
    label.textContent = status === 'ready' ? (floatingEnabled ? '悬浮倒计时已开启' : '悬浮倒计时已关闭') : status === 'hidden' ? '悬浮倒计时已隐藏' : status === 'syncing' ? '正在同步悬浮倒计时…' : '悬浮窗口暂不可用';
    label.dataset.state = status;
  }
}

function emitLatestSnapshot(force = false): void {
  if (!inTauri() || !latestTimerSnapshot || !floatingEnabled) return;
  const snapshot = latestTimerSnapshot;
  const key = `${snapshot.remaining}|${snapshot.paused}|${snapshot.total}`;
  if (!force && key === lastFloatingSnapshotKey) return;
  lastFloatingSnapshotKey = key;
  void emitTo('floating', 'timer-snapshot', snapshot).catch(() => {
    // The floating window may still be registering its event listener.
    // floating-ready triggers a forced retry once it is ready.
  });
}

function updateSnapshot(snapshot: TimerSnapshot): void {
  latestTimerSnapshot = snapshot;
  recordFocusElapsed(snapshot.paused);
  const display = document.querySelector('#timeDisplay'); if (display) display.textContent = formatTime(snapshot.remaining);
  const ring = document.querySelector('#timerProgress') as SVGCircleElement | null; if (ring) ring.style.strokeDashoffset = String(263.89 * (1 - Math.min(1, snapshot.progress)));
  document.querySelector('#statusDot')?.classList.toggle('paused', snapshot.paused);
  const statusText = document.querySelector('#statusText'); if (statusText) statusText.textContent = snapshot.paused ? '计时已暂停' : '正在专注';
  const caption = document.querySelector('.timer-kicker'); if (caption) caption.textContent = snapshot.paused ? '计时暂停中' : '下一次休息还有';
  const pauseButton = document.querySelector('#pauseButton'); if (pauseButton) pauseButton.innerHTML = `${snapshot.paused ? playIcon : pauseIcon}<span id="pauseText">${snapshot.paused ? '继续计时' : '暂停计时'}</span>`;
  state.paused = snapshot.paused; state.pausedRemaining = snapshot.remaining;
  emitLatestSnapshot();
}

function recordFocusElapsed(paused: boolean): void {
  const now = Date.now();
  if (!lastFocusedPaused && !breakSession) focusedSeconds += Math.min(2, Math.max(0, (now - focusLastTick) / 1000));
  focusLastTick = now; lastFocusedPaused = paused;
  if (focusedSeconds >= 60) flushFocusedMinutes();
}

function flushFocusedMinutes(): void {
  const minutes = Math.floor(focusedSeconds / 60); if (!minutes) return;
  focusedSeconds %= 60; state.stats = freshStats(state.stats); state.stats.focusedMinutes += minutes;
  if (state.stats.focusedMinutes !== lastFocusedFlush) { lastFocusedFlush = state.stats.focusedMinutes; updateStats(); persist(); }
}

function updateStats(): void {
  state.stats = freshStats(state.stats);
  const values: Array<[string, number]> = [['statCompleted', state.stats.completed], ['statSkipped', state.stats.skipped], ['statFocused', state.stats.focusedMinutes], ['todayCompleted', state.stats.completed], ['todaySkipped', state.stats.skipped], ['todayFocused', state.stats.focusedMinutes]];
  for (const [id, value] of values) { const el = document.querySelector(`#${id}`); if (el) el.textContent = String(value); }
  const totalBreaks = state.stats.completed + state.stats.skipped;
  const rate = totalBreaks ? Math.round((state.stats.completed / totalBreaks) * 100) : undefined;
  const rateEl = document.querySelector('#statRate'); if (rateEl) rateEl.textContent = rate === undefined ? '—' : `${rate}%`;
  const bar = document.querySelector<HTMLElement>('#statProgressBar'); if (bar) bar.style.width = `${rate ?? 0}%`;
  const label = document.querySelector('#statProgressLabel'); if (label) label.textContent = totalBreaks ? `${state.stats.completed} / ${totalBreaks} 次提醒已完成` : '还没有休息记录';
  const date = document.querySelector('#statsDate'); if (date) date.textContent = `记录日期：${formatStatsDate(state.stats.date)}`;
  renderStatsPeriod();
}

function formatStatsDate(value: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date();
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(date);
}

function renderStatsPeriod(): void {
  const today = document.querySelector<HTMLElement>('#statsTodayData');
  const empty = document.querySelector<HTMLElement>('#statsHistoryEmpty');
  const isToday = statsPeriod === 'day';
  today?.toggleAttribute('hidden', !isToday);
  empty?.toggleAttribute('hidden', isToday);
  document.querySelectorAll<HTMLButtonElement>('.stats-period button').forEach((button) => {
    const active = button.id === `statsTab${statsPeriod === 'day' ? 'Day' : statsPeriod === 'week' ? 'Week' : 'Month'}`;
    button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active));
  });
}

function updateModeUi(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => { const active = button.dataset.mode === state.mode; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  document.querySelectorAll<HTMLElement>('[role="tabpanel"]').forEach((panel) => panel.toggleAttribute('hidden', panel.id !== `panel-${state.mode}`));
  document.querySelector('#customRow')?.toggleAttribute('hidden', state.mode !== 'custom');
  const info = modeInfo();
  const name = document.querySelector('#modeName'); if (name) name.textContent = info.name;
  const description = document.querySelector('#modeDescription'); if (description) description.textContent = info.description;
  const title = document.querySelector('#ruleTitle'); if (title) title.textContent = info.title;
  const subtitle = document.querySelector('#ruleSubtitle'); if (subtitle) subtitle.textContent = info.subtitle;
  const rules = document.querySelector('#ruleGrid'); if (rules) rules.innerHTML = ruleMarkup(state.mode);
  const custom = document.querySelector('#customMinutes') as HTMLInputElement | null; if (custom) custom.value = String(state.settings.customMinutes);
  const customSetting = document.querySelector('#customMinutesSetting') as HTMLInputElement | null; if (customSetting) customSetting.value = String(state.settings.customMinutes);
  const customValue = document.querySelector('#customMinutesValue'); if (customValue) customValue.textContent = `${state.settings.customMinutes} 分钟`;
}

function setNotifyStyle(value: string): void {
  if (value !== 'smart' && value !== 'fullscreen' && value !== 'flash' && value !== 'toast') return;
  resetSmartReminder();
  hideToast();
  hideEdge();
  state.notifyStyle = value as NotifyStyle;
  document.querySelectorAll<HTMLSelectElement>('#notifyStyle, #notifyStyleSetting').forEach((select) => { select.value = state.notifyStyle; });
  persist();
  announce('提醒方式已更新');
}

function setCustomMinutes(value: number): void {
  state.settings.customMinutes = clamp(value, 1, 180);
  const mainInput = document.querySelector('#customMinutes') as HTMLInputElement | null; if (mainInput) mainInput.value = String(state.settings.customMinutes);
  const settingInput = document.querySelector('#customMinutesSetting') as HTMLInputElement | null; if (settingInput) settingInput.value = String(state.settings.customMinutes);
  const output = document.querySelector('#customMinutesValue'); if (output) output.textContent = `${state.settings.customMinutes} 分钟`;
  if (state.mode === 'custom') { timer.setMode('custom'); updateModeUi(); }
  persist();
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => { timer.setMode(button.dataset.mode as Mode); persist(); updateModeUi(); announce(`已切换到${button.querySelector('span')?.textContent ?? ''}模式`); });
    button.addEventListener('keydown', (event) => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')]; const index = tabs.indexOf(button); const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]; next.focus(); next.click(); });
  });
  document.querySelector('#pauseButton')?.addEventListener('click', () => { timer.togglePause(); persist(); });
  document.querySelector('#resetButton')?.addEventListener('click', () => { timer.reset(); persist(); announce('计时已重置'); });
  document.querySelector('#breakButton')?.addEventListener('click', () => showBreak('fast'));
  document.querySelector('#restButton')?.addEventListener('click', () => showBreak('fast'));
  document.querySelector<HTMLButtonElement>('#minimizeButton')?.addEventListener('click', () => { void minimizeApplication(); });
  document.querySelector<HTMLButtonElement>('#quitButton')?.addEventListener('click', () => { void quitApplication(); });
  document.querySelector<HTMLElement>('.titlebar')?.addEventListener('dblclick', (event) => {
    if (event.target instanceof Element && event.target.closest('button')) return;
    event.preventDefault();
  });
  document.querySelector<HTMLElement>('.titlebar')?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target instanceof Element && event.target.closest('button')) return;
    void getCurrentWindow().startDragging().catch((error) => console.error('[EyeCare] window drag failed', error));
  });
  document.querySelector('#settingsButton')?.addEventListener('click', () => openModal('settingsModal'));
  document.querySelector('#statsButton')?.addEventListener('click', () => { updateStats(); openModal('statsModal'); });
  document.querySelector('#notifyStyle')?.addEventListener('change', (event) => setNotifyStyle((event.target as HTMLSelectElement).value));
  document.querySelector('#notifyStyleSetting')?.addEventListener('change', (event) => setNotifyStyle((event.target as HTMLSelectElement).value));
  document.querySelector('#customMinutes')?.addEventListener('change', (event) => setCustomMinutes(Number((event.target as HTMLInputElement).value)));
  document.querySelector('#customMinutesSetting')?.addEventListener('input', (event) => setCustomMinutes(Number((event.target as HTMLInputElement).value)));
  document.querySelector('#snoozeButton')?.addEventListener('click', () => handleBreakAction('snooze'));
  document.querySelector('#skipButton')?.addEventListener('click', () => handleBreakAction('skip'));
  document.querySelector('#doneButton')?.addEventListener('click', () => handleBreakAction('done'));
  document.querySelector('#breakClose')?.addEventListener('click', () => handleBreakAction('done'));
  document.querySelector('#toastRest')?.addEventListener('click', () => { void confirmBreak(); });
  document.querySelector('#toastDismiss')?.addEventListener('click', () => { resetSmartReminder(); hideToast(); hideEdge(); timer.snooze(5); persist(); });
  document.querySelectorAll<HTMLButtonElement>('.close-modal').forEach((button) => button.addEventListener('click', () => closeModal(button.closest('.modal-backdrop')?.id)));
  document.querySelectorAll<HTMLElement>('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(backdrop.id); }));
  document.querySelectorAll<HTMLButtonElement>('[data-exercise]').forEach((button) => button.addEventListener('click', () => selectExercise(button.dataset.exercise ?? 'far')));
  document.querySelectorAll<HTMLButtonElement>('.stats-period button').forEach((button) => button.addEventListener('click', () => switchStatsTab(button.id.replace('statsTab', '').toLowerCase() as StatsPeriod)));
  bindSwitch('guardSwitch', 'guardEnabled'); bindSwitch('soundSwitch', 'soundEnabled'); bindSwitch('avoidSwitch', 'smartAvoidance'); bindSwitch('bootSwitch', 'startOnBoot');
  document.querySelector('#floatingSwitch')?.addEventListener('click', () => { void setFloatingEnabled(!floatingEnabled); });
  document.querySelector('#volumeInput')?.addEventListener('input', (event) => { state.settings.soundVolume = Number((event.target as HTMLInputElement).value); persist(); const status = document.querySelector('#settingsStatus'); if (status) status.textContent = '提示音量已更新。'; });
  if (!keyListenerBound) { document.addEventListener('keydown', onKeyDown); keyListenerBound = true; }
  setNotifyStyle(state.notifyStyle);
}

async function setFloatingEnabled(enabled: boolean): Promise<void> {
  const previous = floatingEnabled;
  floatingEnabled = enabled;
  renderSettings();
  setFloatingStatus('syncing');
  const command = enabled ? 'show_floating' : 'hide_floating';
  if (!inTauri()) {
    setFloatingStatus(enabled ? 'ready' : 'hidden');
    persist();
    announce(enabled ? '已开启悬浮倒计时' : '已关闭悬浮倒计时');
    return;
  }
  const request = ++floatingSyncRequest;
  try {
    await invokeHost(command, undefined, { silent: true });
    if (request !== floatingSyncRequest) return;
    setFloatingStatus(enabled ? 'ready' : 'hidden');
    persist();
    announce(enabled ? '已开启悬浮倒计时' : '已关闭悬浮倒计时');
    if (enabled) emitLatestSnapshot(true);
  } catch {
    if (request !== floatingSyncRequest) return;
    floatingEnabled = previous;
    renderSettings();
    setFloatingStatus(previous ? 'unavailable' : 'hidden');
    showError(enabled ? '悬浮窗口启动失败，已恢复原设置' : '悬浮窗口关闭失败，已恢复原设置');
  }
}

function bindSwitch(id: string, setting: keyof typeof defaultSettings): void {
  document.querySelector(`#${id}`)?.addEventListener('click', () => {
    const oldValue = state.settings[setting] as boolean; const nextValue = !oldValue; state.settings[setting] = nextValue as never; renderSettings();
    if (setting === 'startOnBoot') { void invokeHost('set_autostart', { enabled: nextValue }, { silent: true }).then(() => announce(nextValue ? '已开启开机启动' : '已关闭开机启动')).catch(() => { state.settings[setting] = oldValue as never; renderSettings(); persist(); showError('开机启动设置失败，已恢复原状态'); }); }
    persist();
  });
}

function renderSettings(): void {
  (['guardEnabled', 'soundEnabled', 'smartAvoidance', 'startOnBoot'] as const).forEach((key) => { const id = { guardEnabled: 'guardSwitch', soundEnabled: 'soundSwitch', smartAvoidance: 'avoidSwitch', startOnBoot: 'bootSwitch' }[key]; const el = document.querySelector(`#${id}`); el?.classList.toggle('on', state.settings[key]); el?.setAttribute('aria-checked', String(state.settings[key])); });
  const floatingSwitch = document.querySelector('#floatingSwitch'); floatingSwitch?.classList.toggle('on', floatingEnabled); floatingSwitch?.setAttribute('aria-checked', String(floatingEnabled));
  const volume = document.querySelector('#volumeInput') as HTMLInputElement | null; if (volume) volume.value = String(state.settings.soundVolume);
  const custom = document.querySelector('#customMinutesSetting') as HTMLInputElement | null; if (custom) custom.value = String(state.settings.customMinutes);
  const output = document.querySelector('#customMinutesValue'); if (output) output.textContent = `${state.settings.customMinutes} 分钟`;
  document.querySelectorAll<HTMLSelectElement>('#notifyStyle, #notifyStyleSetting').forEach((select) => { select.value = state.notifyStyle; });
}

function openModal(id: string): void { const backdrop = document.querySelector<HTMLElement>(`#${id}`); if (!backdrop) return; modalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined; backdrop.hidden = false; backdrop.setAttribute('aria-hidden', 'false'); backdrop.classList.add('open'); backdrop.querySelector<HTMLElement>('[role="dialog"]')?.removeAttribute('inert'); window.setTimeout(() => backdrop.querySelector<HTMLElement>('button, input, select')?.focus(), 0); }
function closeModal(id?: string): void { if (!id) return; const backdrop = document.querySelector<HTMLElement>(`#${id}`); if (!backdrop) return; backdrop.classList.remove('open'); backdrop.setAttribute('aria-hidden', 'true'); backdrop.hidden = true; if (!document.querySelector('.modal-backdrop.open')) modalTrigger?.focus(); }

function onKeyDown(event: KeyboardEvent): void {
  const open = document.querySelector<HTMLElement>('.modal-backdrop.open');
  if (event.key === 'Tab' && open) {
    const focusable = [...open.querySelectorAll<HTMLElement>('button, input, select, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute('disabled'));
    if (focusable.length) { const first = focusable[0]; const last = focusable[focusable.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    return;
  }
  if (event.key !== 'Escape') return;
  event.preventDefault(); event.stopPropagation();
  if (breakSession) { handleBreakAction('done'); return; }
  if (open) { closeModal(open.id); return; }
  const wasSmartReminder = smartReminderActive;
  resetSmartReminder(); hideToast(); hideEdge();
  if (wasSmartReminder) { timer.snooze(5); persist(); announce('已暂缓智能提醒 5 分钟'); }
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
function setBreakButtons(disabled: boolean): void { document.querySelectorAll<HTMLButtonElement>('#breakOverlay .break-actions button, #breakClose').forEach((button) => { button.disabled = disabled; button.setAttribute('aria-busy', String(disabled)); }); }
function setBreakCompletionButtons(disabled: boolean): void { document.querySelectorAll<HTMLButtonElement>('#doneButton, #breakClose').forEach((button) => { button.disabled = disabled; button.setAttribute('aria-busy', String(disabled)); }); }
function updateBreakClock(): void {
  if (!breakSession) return;
  const remaining = Math.max(0, Math.ceil((breakSession.deadline - Date.now()) / 1000));
  const time = document.querySelector('#breakTime');
  if (time) time.textContent = remaining > 60 ? `${Math.ceil(remaining / 60)}m` : `${remaining}s`;
  if (remaining === 0) setBreakCompletionButtons(false);
}

function cleanupNativeBreakOverlays(): void {
  if (!inTauri()) return;
  const attempt = (retry: boolean): void => {
    void invokeHost('close_break_overlays', undefined, { silent: true }).catch((error) => {
      console.error('[EyeCare] native break overlay cleanup failed', error);
      if (retry) window.setTimeout(() => attempt(false), 250);
    });
  };
  attempt(true);
}

function showBreak(type: 'fast' | 'long', forceNative = false): void {
  if (breakSession) return;
  resetSmartReminder(); hideToast(); hideEdge(); recordFocusElapsed(false);
  const duration = type === 'fast' ? 60 : 300; const id = ++breakSequence; breakSession = { id, deadline: Date.now() + duration * 1000, native: false, pending: false, completed: false };
  selectExercise(type === 'fast' ? 'far' : 'breathe');
  const native = inTauri() && (state.notifyStyle === 'fullscreen' || forceNative);
  // Never make a rest action wait for an auxiliary desktop window. The local
  // dialog is the immediate, manual acknowledgement surface in every mode.
  showLocalBreak();
  if (native) {
    void invokeHost<boolean>('show_break_overlays', { style: 'fullscreen' }, { silent: true, timeoutMs: 8_000 })
      .then((shown) => {
        if (!breakSession || breakSession.id !== id || breakSession.completed) {
          if (shown) cleanupNativeBreakOverlays();
          return;
        }
        if (shown) breakSession.native = true;
      })
      .catch((error) => {
        cleanupNativeBreakOverlays();
        if (breakSession?.id === id) {
          console.error('[EyeCare] native break overlay failed', error);
        }
      });
  }
  playSoftChime(); updateBreakClock(); if (restInterval !== undefined) window.clearInterval(restInterval); restInterval = window.setInterval(updateBreakClock, 250);
}

function showLocalBreak(): void { const overlay = document.querySelector<HTMLElement>('#breakOverlay'); if (!overlay) return; overlay.hidden = false; overlay.setAttribute('aria-hidden', 'false'); overlay.classList.add('open'); setBreakButtons(false); setBreakCompletionButtons(true); window.setTimeout(() => overlay.querySelector<HTMLElement>('button')?.focus(), 0); }
function hideBreakUi(): void { if (restInterval !== undefined) window.clearInterval(restInterval); restInterval = undefined; const overlay = document.querySelector<HTMLElement>('#breakOverlay'); overlay?.classList.remove('open'); if (overlay) { overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true'); } }
function handleBreakAction(action: BreakAction): void { const session = breakSession; if (!session || session.completed || session.pending) return; if (action === 'done' && Date.now() < session.deadline) { announce('请至少休息 1 分钟后再完成'); return; } session.pending = true; setBreakButtons(true); if (session.native) { void invokeHost('break_action', { action }, { silent: true }).then(() => applyBreakAction(action)).catch(() => { cleanupNativeBreakOverlays(); if (breakSession?.id === session.id) { showError('全屏遮罩动作失败，已在窗口内完成本次操作'); session.native = false; applyBreakAction(action); } }); } else applyBreakAction(action); }
function applyBreakAction(action: BreakAction): void { const session = breakSession; if (!session || session.completed) return; session.completed = true; hideBreakUi(); hideToast(); recordFocusElapsed(false); breakSession = undefined; flushFocusedMinutes(); if (action === 'snooze') timer.snooze(5); else { if (action === 'skip') state.stats.skipped += 1; if (action === 'done') state.stats.completed += 1; timer.reset(); updateStats(); } persist(); announce(action === 'done' ? '休息已完成' : action === 'skip' ? '已跳过本次休息' : '已延后休息'); }

function selectExercise(type: string): void { document.querySelectorAll<HTMLButtonElement>('.exercise-tab').forEach((button) => { const active = button.dataset.exercise === type; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); }); const title = document.querySelector('#breakTitle'); const desc = document.querySelector('#breakDesc'); const copy: Record<string, [string, string]> = { far: ['看向 6 米外的远方', '配合呼吸，眨眨眼，让眼部睫状肌彻底放松。'], roll: ['跟随视线转动眼球', '保持头部不动，双眼追随光点做圆周运动，放松眼部肌肉。'], breathe: ['4-7-8 深度呼吸减压', '吸气 4 秒，憋气 7 秒，缓慢呼气 8 秒，舒缓眼部压力。'] }; if (title && desc) { title.textContent = copy[type]?.[0] ?? copy.far[0]; desc.textContent = copy[type]?.[1] ?? copy.far[1]; } }
function showToast(message = '请确认开始休息，挡屏至少持续 1 分钟。'): void { if (breakSession) return; const toast = document.querySelector('#cornerToast'); const description = toast?.querySelector('p'); if (description) description.textContent = message; toast?.classList.add('show'); toast?.setAttribute('aria-hidden', 'false'); playSoftChime('chime'); }
function hideToast(): void { const toast = document.querySelector('#cornerToast'); toast?.classList.remove('show'); toast?.setAttribute('aria-hidden', 'true'); }
function startSmartReminder(): void {
  if (smartReminderActive || breakSession) return;
  smartReminderActive = true;
  smartStage = 'quiet';
  showToast('请确认开始休息：看向 6 米外的远方，至少 1 分钟。');
  smartEscalationTimer = window.setTimeout(() => {
    if (!smartReminderActive || breakSession) return;
    smartStage = 'edge';
    hideToast();
    document.querySelector('#edgeGlow')?.classList.add('show');
    playSoftChime('chime');
    smartEscalationTimer = window.setTimeout(() => {
      if (!smartReminderActive || breakSession) return;
      smartStage = 'card';
      hideEdge();
      showToast('提醒：请先确认开始休息，主界面会自动缩回托盘。');
    }, 20_000);
  }, 10_000);
}

function resetSmartReminder(): void { if (smartEscalationTimer !== undefined) window.clearTimeout(smartEscalationTimer); smartEscalationTimer = undefined; smartStage = 'quiet'; smartReminderActive = false; }
function hideEdge(): void { if (edgeTimeout !== undefined) window.clearTimeout(edgeTimeout); edgeTimeout = undefined; document.querySelector('#edgeGlow')?.classList.remove('show'); }
function playSoftChime(kind: 'bowl' | 'chime' = 'bowl'): void { if (!state.settings.soundEnabled || state.settings.soundVolume <= 0) return; try { audioContext ??= new AudioContext(); if (audioContext.state === 'suspended') void audioContext.resume(); const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain(); oscillator.type = 'sine'; oscillator.frequency.value = kind === 'bowl' ? 432 : 523.25; gain.gain.setValueAtTime(state.settings.soundVolume, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + (kind === 'bowl' ? 2.5 : 1.1)); oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + (kind === 'bowl' ? 2.5 : 1.1)); } catch { /* Audio is optional; visual reminders remain available. */ } }
function onDue(): void { if (!state.settings.guardEnabled || breakSession || smartReminderActive) return; recordFocusElapsed(false); const shouldAvoid = state.settings.smartAvoidance && inTauri(); if (shouldAvoid) { void invokeHost<boolean>('is_fullscreen_app', undefined, { silent: true }).then((busy) => { if (busy) { timer.snooze(5); announce('检测到全屏应用，提醒已自动顺延 5 分钟'); } else triggerNotice(); }).catch(() => triggerNotice()); } else triggerNotice(); }
function triggerNotice(): void { if (breakSession) return; void restoreMainForReminder().finally(() => { if (state.notifyStyle === 'smart') startSmartReminder(); else if (state.notifyStyle === 'flash') { document.querySelector('#edgeGlow')?.classList.add('show'); playSoftChime(); showToast('提醒：请确认开始休息，主界面会自动缩回托盘。'); } else showToast('提醒：请确认开始休息，主界面会自动缩回托盘。'); }); }
function switchStatsTab(period: StatsPeriod): void { statsPeriod = period; renderStatsPeriod(); }

setStorageErrorReporter(({ operation }) => showError(operation === 'load' ? '读取设置失败，已使用默认设置' : '保存设置失败，当前修改仅保存在内存中'));
state = loadState();
floatingEnabled = readFloatingPreference();
lastFocusedPaused = state.paused;
state.stats = freshStats(state.stats);
render();
timer = new TimerEngine(state, updateSnapshot, onDue);

async function setupTauriBridge(): Promise<void> {
  if (!inTauri()) return;
  bridgeUnlisten.forEach((unlisten) => unlisten());
  bridgeUnlisten = [];
  const registrations = await Promise.allSettled([
    listen<TimerSnapshot>('floating-ready', () => emitLatestSnapshot(true)),
    listen('break-action', (event) => { const action = event.payload as BreakAction; if (action === 'snooze' || action === 'skip' || action === 'done') applyBreakAction(action); }),
    listen('main-window-shown', () => { mainHidden = false; }),
    listen('main-window-hidden', () => { mainHidden = true; }),
    listen('break-overlay-closed', () => {
      const session = breakSession;
      if (!session || session.completed || !session.native) return;
      session.native = false;
      session.pending = false;
      showError('桌面提醒已关闭，已切换为窗口内提醒');
      showLocalBreak();
    }),
    listen<boolean>('tray-rest', async (event) => {
      if (shouldRestoreMainForTray(event.payload) && !(await restoreMainWindow())) return;
      mainHidden = false;
      showBreak('fast');
    }),
    listen('tray-pause', () => { timer.togglePause(); persist(); }),
  ]);
  bridgeUnlisten = registrations.flatMap((registration) => registration.status === 'fulfilled' ? [registration.value] : []);
  const registrationFailures = registrations.filter((registration) => registration.status === 'rejected');
  if (registrationFailures.length) {
    console.error('[EyeCare] Tauri event listener registration failed', registrationFailures);
    setFloatingStatus('unavailable');
  }
  const request = ++floatingSyncRequest;
  setFloatingStatus('syncing');
  try {
    await invokeHost(floatingEnabled ? 'show_floating' : 'hide_floating', undefined, { silent: true });
    if (request !== floatingSyncRequest) return;
    setFloatingStatus(floatingEnabled ? 'ready' : 'hidden');
    if (floatingEnabled) emitLatestSnapshot(true);
  } catch (error) {
    console.error('[EyeCare] floating initialization failed', error);
    if (request !== floatingSyncRequest) return;
    setFloatingStatus('unavailable');
  }
}

timer.start();
void setupTauriBridge();
window.addEventListener('visibilitychange', () => { focusLastTick = Date.now(); updateBreakClock(); });
window.addEventListener('beforeunload', () => {
  bridgeUnlisten.forEach((unlisten) => unlisten());
  bridgeUnlisten = [];
  flushFocusedMinutes();
  timer.stop();
  persist();
  if (inTauri()) {
    void invokeHost('close_floating', undefined, { silent: true }).catch(() => undefined);
    cleanupNativeBreakOverlays();
  }
});
