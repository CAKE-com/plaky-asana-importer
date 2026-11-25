import type { entityMappings } from "@/db/schema";
import type { Commit } from "./store";

export const REFUSED_FOR_GOOD = "refused for good: ";
type StoredStatus = (typeof entityMappings.$inferSelect)["status"];
export type EntityState = StoredStatus | "absent" | "refused";
type Mapping = { status: StoredStatus; lastError: string | null };

export function entityState(row: Mapping | null | undefined): EntityState {
  if (!row) return "absent";
  return row.status === "failed" && row.lastError?.startsWith(REFUSED_FOR_GOOD) ? "refused" : row.status;
}

export const canReconcile = (row: Mapping): boolean => ["dispatched", "ambiguous", "failed"].includes(entityState(row));
export const canInspectForUndo = (row: Mapping): boolean => ["committed", "failed"].includes(entityState(row));

export type EntityEvent =
  | { type: "dispatch" }
  | { type: "commit"; commit: Commit }
  | { type: "unknown"; error: string }
  | { type: "refuse"; error: string };

export function entityWrite(event: EntityEvent): { status: StoredStatus; lastError: string | null } & Commit {
  switch (event.type) {
    case "dispatch": return { status: "dispatched", lastError: null };
    case "commit": return { ...event.commit, status: "committed", lastError: null };
    case "unknown": return { status: "ambiguous", lastError: event.error };
    case "refuse": return { status: "failed", lastError: event.error };
  }
}
