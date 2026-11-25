import type { BoardSync } from "../config";

type EntityType = "group" | "item" | "subitem" | "comment" | "file";
export const BY_HAND_CODE = "item.by_hand";

export type EntityRef = { type: EntityType; asanaId: string; scope: string; occurrence: number };
export type Commit = { plakyId?: number | null; plakyParentId?: number | null; created?: true };
export type BoardKey = { space: number; board: number };

export class BoardLockedError extends Error {
  override readonly name = "BoardLockedError";
  constructor(readonly board: BoardKey) {
    super(`another apply is already running: Plaky board ${board.space}/${board.board} is held by another run`);
  }
}

export { REFUSED_FOR_GOOD } from "./entity-state";
export const PERMANENT_UPLOAD = new Set([400, 413, 415, 422]);

export interface LoadStore {
  lock(boards: readonly BoardKey[]): Promise<void>;
  heartbeat(): Promise<boolean>;
  unlock(boards: readonly BoardKey[]): Promise<void>;
  markDispatched(ref: EntityRef): Promise<void>;
  markCommitted(ref: EntityRef, commit: Commit): Promise<void>;
  markAmbiguous(ref: EntityRef, error: string): Promise<void>;
  markFailed(ref: EntityRef, error: string): Promise<void>;
  markApplied(board: BoardSync): Promise<void>;
  markNotApplied?(board: BoardSync): Promise<void>;
  reconcile(settled: readonly { ref: EntityRef; commit: Commit }[]): Promise<void>;
  adopt?(found: readonly { ref: EntityRef; commit: Commit }[]): Promise<void>;
  refusedBefore?(ref: EntityRef): Promise<string | null>;
}

const byBoard = (a: BoardKey, b: BoardKey): number => a.space - b.space || a.board - b.board;

export async function withBoardLocks<T>(store: LoadStore, boards: readonly BoardKey[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Map<string, BoardKey>(boards.map((b) => [`${b.space}/${b.board}`, b])).values()].sort(byBoard);
  if (keys.length === 0) return fn();
  await store.lock(keys);
  try {
    return await fn();
  } finally {
    await store.unlock(keys).catch(() => undefined);
  }
}
