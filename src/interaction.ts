export type WindowAction = 'minimize' | 'quit';

export function claimWindowAction(current: WindowAction | undefined, requested: WindowAction): WindowAction | undefined {
  return current === undefined ? requested : undefined;
}

export function shouldRestoreMainForTray(payload: boolean | undefined): boolean {
  return payload !== true;
}

export function withTimeout<T>(request: Promise<T>, timeoutMs: number, message = '操作超时'): Promise<T> {
  if (timeoutMs <= 0) return request;
  return new Promise<T>((resolve, reject) => {
    const timeoutHandle = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    request.then(resolve, reject);
    request.then(
      () => globalThis.clearTimeout(timeoutHandle),
      () => globalThis.clearTimeout(timeoutHandle),
    );
  });
}
