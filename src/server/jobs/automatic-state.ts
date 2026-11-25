export type Schedule = { at: number; everyHours: number | null };
export type AutomaticIntent = { at: number };
export type AutomaticDecision =
  | { state: "absent" }
  | { state: "waiting"; at: number }
  | { state: "busy" }
  | { state: "claimable" };

export function automaticDecision(intent: AutomaticIntent | null | undefined, now: number, busy: boolean): AutomaticDecision {
  if (!intent) return { state: "absent" };
  if (intent.at > now) return { state: "waiting", at: intent.at };
  return { state: busy ? "busy" : "claimable" };
}

export const HOUR_MS = 3_600_000;
export function nextOccurrence(schedule: Schedule, now: number): number | null {
  if (!schedule.everyHours) return null;
  const step = schedule.everyHours * HOUR_MS;
  return schedule.at + (Math.floor((now - schedule.at) / step) + 1) * step;
}

export type ScheduleClaim = { at: number } | null;
