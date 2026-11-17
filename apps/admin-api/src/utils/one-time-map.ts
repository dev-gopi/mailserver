/** Remove a one-time value synchronously before any asynchronous verification work. */
export function takeOneTimeValue<T>(store: Map<string, T>, key: string): T | undefined {
  const value = store.get(key);
  store.delete(key);
  return value;
}

/** Prevent concurrent submissions from consuming the same pending MFA challenge. */
export function tryAcquireAttemptLock(state: { verificationInProgress?: boolean }): boolean {
  if (state.verificationInProgress) return false;
  state.verificationInProgress = true;
  return true;
}

export function releaseAttemptLock(state: { verificationInProgress?: boolean }): void {
  state.verificationInProgress = false;
}
