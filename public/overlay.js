const invoke = window.__TAURI__?.core?.invoke;
const buttons = [...document.querySelectorAll('button')];
const status = document.querySelector('#overlayStatus');
let submitted = false;
const doneButton = document.querySelector('#done');
if (doneButton) {
  doneButton.disabled = true;
  window.setTimeout(() => { doneButton.disabled = false; }, 60_000);
}

async function sendAction(action) {
  if (submitted) return;
  if (action === 'done' && doneButton?.disabled) {
    if (status) status.textContent = '请至少休息 1 分钟后再完成。';
    return;
  }
  if (typeof invoke !== 'function') {
    if (status) status.textContent = '桌面接口不可用，请关闭此窗口后重试。';
    return;
  }
  submitted = true;
  buttons.forEach((button) => { button.disabled = true; button.setAttribute('aria-busy', 'true'); });
  if (status) status.textContent = '正在处理…';
  try {
    await Promise.race([
      invoke('break_action', { action }),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error('break_action timed out')), 8_000)),
    ]);
  } catch (error) {
    submitted = false;
    buttons.forEach((button) => { button.disabled = false; button.removeAttribute('aria-busy'); });
    if (status) status.textContent = '操作失败，请重试。';
    console.error('EyeCare break action failed', error);
  }
}

buttons.forEach((button) => button.addEventListener('click', () => sendAction(button.id)));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    void sendAction('done');
  }
});
window.addEventListener('DOMContentLoaded', () => document.querySelector('button')?.focus());
