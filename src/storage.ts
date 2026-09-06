import { normalizeState, PersistedState } from './state';

export const storageKey = 'eyecare-state-v1';
type StorageOperation = 'load' | 'save';

export interface StorageError {
  operation: StorageOperation;
  error: unknown;
}

export type StorageErrorReporter = (details: StorageError) => void;

const reportedOperations = new Set<StorageOperation>();
let reportStorageError: StorageErrorReporter = ({ operation, error }) => {
  // Keep failures observable without making persistence a reason for the app
  // to stop working. The operation is included so the message is actionable.
  console.error(`EyeCare failed to ${operation} persisted state`, error);
};

function reportError(operation: StorageOperation, error: unknown): void {
  if (reportedOperations.has(operation)) return;
  reportedOperations.add(operation);
  try {
    reportStorageError({ operation, error });
  } catch {
    // A diagnostic hook must never break the application either.
  }
}

function clearError(operation: StorageOperation): void {
  reportedOperations.delete(operation);
}

/** Replace the default console diagnostic, primarily for UI integration/tests. */
export function setStorageErrorReporter(reporter?: StorageErrorReporter): void {
  reportStorageError = reporter ?? (({ operation, error }) => {
    console.error(`EyeCare failed to ${operation} persisted state`, error);
  });
}

/** Reset one-shot diagnostics, useful when starting a new app/test session. */
export function resetStorageErrorReporting(): void {
  reportedOperations.clear();
}

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(storageKey);
    const state = raw ? normalizeState(JSON.parse(raw)) : normalizeState(null);
    clearError('load');
    return state;
  } catch (error) {
    reportError('load', error);
    return normalizeState(null);
  }
}

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
    clearError('save');
  } catch (error) {
    reportError('save', error);
    // The app remains usable if storage is blocked or unavailable.
  }
}
