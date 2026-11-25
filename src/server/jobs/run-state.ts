import type { migrationRuns } from "@/db/schema";

export type RunStatus = (typeof migrationRuns.$inferSelect)["status"];
export type RunOutcome = Exclude<RunStatus, "running">;

export type RunLiveness = "live" | "dead" | "silent";
export function runLiveness(run: { host: string | null; pid: number | null; token: string | null; silent: number },
  process: { host: string; pid: number; token: string; alive: (pid: number) => boolean }): RunLiveness {
  if (run.silent) return "silent";
  if (run.host !== process.host || run.pid === null) return "live";
  if (run.pid !== process.pid) return process.alive(run.pid) ? "live" : "dead";
  return run.token !== null && run.token !== process.token ? "dead" : "live";
}

export const RUN_REACHED_FROM = {
  running: [], succeeded: ["running"], failed: ["running"], interrupted: ["running"],
  rate_limited: ["running"], plaky_rate_limited: ["running"],
} as const satisfies Record<RunStatus, readonly RunStatus[]>;

const SETTLED = {
  succeeded: "completed", failed: "failed", interrupted: "interrupted",
  rate_limited: "interrupted", plaky_rate_limited: "interrupted",
} as const satisfies Record<RunOutcome, "completed" | "failed" | "interrupted">;
export const settledStatus = (outcome: RunOutcome) => SETTLED[outcome];

export function applyOutcome(input: {
  applied: boolean; aborted: boolean; asanaLimited: boolean;
  counts: Record<string, number>; planningFailures: number;
}): RunOutcome {
  const { applied, aborted, asanaLimited, counts, planningFailures } = input;
  let outcome: RunOutcome;
  if (!applied) outcome = aborted ? "interrupted" : "failed";
  else if (counts.rateLimited) outcome = "plaky_rate_limited";
  else if (counts.stopped || counts.notStarted || aborted) outcome = "interrupted";
  else if (counts.failures || counts.ambiguous || planningFailures) outcome = "failed";
  else outcome = "succeeded";
  return asanaLimited && outcome !== "interrupted" ? "rate_limited" : outcome;
}

export type VerificationDecision = "wait-for-asana" | "skip-changes" | "verify" | "skip-stopped";
export function verificationDecision(applied: boolean, changes: boolean, limited: boolean, outcome: RunOutcome): VerificationDecision {
  if (limited) return "wait-for-asana";
  if (applied && changes && outcome !== "interrupted") return "skip-changes";
  return applied && outcome !== "interrupted" && outcome !== "plaky_rate_limited" ? "verify" : "skip-stopped";
}
