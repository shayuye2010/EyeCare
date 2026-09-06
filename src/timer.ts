import { Mode, PersistedState, totalSeconds } from './state';

export interface TimerSnapshot {
  remaining: number;
  total: number;
  progress: number;
  paused: boolean;
}

export class TimerEngine {
  private state: PersistedState;
  private tickHandle: ReturnType<typeof globalThis.setInterval> | undefined;
  private onTick: (snapshot: TimerSnapshot) => void;
  private onDue: () => void;

  constructor(state: PersistedState, onTick: (snapshot: TimerSnapshot) => void, onDue: () => void) {
    this.state = state;
    this.onTick = onTick;
    this.onDue = onDue;
  }

  start(): void {
    this.stop();
    this.emit();
    this.tickHandle = globalThis.setInterval(() => this.emit(), 500);
  }

  stop(): void {
    if (this.tickHandle !== undefined) globalThis.clearInterval(this.tickHandle);
    this.tickHandle = undefined;
  }

  getState(): PersistedState {
    return this.state;
  }

  setState(state: PersistedState): void {
    this.state = state;
    this.emit();
  }

  setMode(mode: Mode): void {
    this.state.mode = mode;
    this.state.paused = false;
    this.state.pausedRemaining = totalSeconds(this.state);
    this.state.phaseEndsAt = Date.now() + this.state.pausedRemaining * 1000;
    this.emit();
  }

  togglePause(): void {
    if (this.state.paused) {
      this.state.paused = false;
      this.state.phaseEndsAt = Date.now() + this.state.pausedRemaining * 1000;
    } else {
      this.state.pausedRemaining = this.remaining();
      this.state.paused = true;
      this.state.phaseEndsAt = null;
    }
    this.emit();
  }

  snooze(minutes: number): void {
    this.state.paused = false;
    this.state.pausedRemaining = Math.max(1, minutes) * 60;
    this.state.phaseEndsAt = Date.now() + this.state.pausedRemaining * 1000;
    this.emit();
  }

  reset(): void {
    this.state.paused = false;
    this.state.pausedRemaining = totalSeconds(this.state);
    this.state.phaseEndsAt = Date.now() + this.state.pausedRemaining * 1000;
    this.emit();
  }

  remaining(): number {
    if (this.state.paused || !this.state.phaseEndsAt) return Math.max(0, this.state.pausedRemaining);
    return Math.max(0, Math.ceil((this.state.phaseEndsAt - Date.now()) / 1000));
  }

  private emit(): void {
    const total = totalSeconds(this.state);
    const remaining = this.remaining();
    if (!this.state.paused && remaining <= 0) {
      this.state.pausedRemaining = total;
      this.state.phaseEndsAt = Date.now() + total * 1000;
      this.onDue();
      this.onTick({ remaining: total, total, progress: 1, paused: false });
      return;
    }
    this.onTick({ remaining, total, progress: total ? remaining / total : 0, paused: this.state.paused });
  }
}
