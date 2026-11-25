const KEY = "migration-closed";

export function rememberClosed(keysDropped: boolean): void {
  try { sessionStorage.setItem(KEY, keysDropped ? "keys" : "data"); } catch {  }
}

export function takeClosed(): { keysDropped: boolean } | null {
  try {
    const was = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return was === null ? null : { keysDropped: was === "keys" };
  } catch { return null; }
}
