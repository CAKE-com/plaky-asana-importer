export type ConfirmationState = "unavailable" | "confirming" | "ready" | "submitting";

export function namedConfirmation(target: string | null, typed: string, pending: boolean, blocked = false): ConfirmationState {
  if (pending) return "submitting";
  if (target === null || blocked) return "unavailable";
  return typed.trim() === target.trim() ? "ready" : "confirming";
}

export function closeConfirmation(saved: boolean, shortfall: string | null, acknowledged: string | null, pending: boolean): ConfirmationState {
  if (pending) return "submitting";
  return saved && (shortfall === null || shortfall === acknowledged) ? "ready" : "confirming";
}
