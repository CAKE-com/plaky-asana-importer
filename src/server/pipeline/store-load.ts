import { canReconcile, entityState, entityWrite, type EntityEvent } from "./load/entity-state";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { boardLocks, entityMappings } from "../../db/schema";
import { BoardLockedError, REFUSED_FOR_GOOD, type BoardKey, type Commit, type EntityRef, type LoadStore } from "./load";
import { markBoardApplied, markBoardUnapplied } from "./board-state";
import type { BoardSync } from "./config";

export const LEASE_MS = 2 * 60_000;

export type DbLoadStoreOptions = {
  db: Db;
  migrationId: number;
  owner?: string;
  leaseMs?: number;
  autoHeartbeatMs?: number;
  now?: () => number;
};


export class DbLoadStore implements LoadStore {
  private readonly db: Db;
  private readonly migrationId: number;
  readonly owner: string;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly beatMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly held = new Map<string, number>();

  constructor(options: DbLoadStoreOptions) {
    this.db = options.db;
    this.migrationId = options.migrationId;
    this.owner = options.owner ?? randomUUID();
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.now = options.now ?? Date.now;
    this.beatMs = options.autoHeartbeatMs ?? this.leaseMs / 3;
  }

  async lock(boards: readonly BoardKey[]): Promise<void> {
    const taken: BoardKey[] = [];
    try {
      for (const key of boards) {
        if (!(await this.acquire(key))) throw new BoardLockedError(key);
        taken.push(key);
      }
    } catch (error) {
      await this.unlock(taken).catch(() => undefined);
      throw error;
    }
  }

  private async acquire(key: BoardKey): Promise<boolean> {
    const now = this.now();
    await this.db
      .insert(boardLocks)
      .values({ plakySpaceId: key.space, plakyBoardId: key.board, owner: this.owner, expiresAt: new Date(now + this.leaseMs) })
      .onConflictDoUpdate({
        target: [boardLocks.plakySpaceId, boardLocks.plakyBoardId],
        set: { owner: this.owner, expiresAt: new Date(now + this.leaseMs) },
        setWhere: sql`${boardLocks.expiresAt} < ${now} OR ${boardLocks.owner} = ${this.owner}`,
      });
    const [row] = await this.db
      .select({ owner: boardLocks.owner })
      .from(boardLocks)
      .where(and(eq(boardLocks.plakySpaceId, key.space), eq(boardLocks.plakyBoardId, key.board)));
    if (row?.owner !== this.owner) return false;
    const id = keyOf(key);
    this.held.set(id, (this.held.get(id) ?? 0) + 1);
    if (this.timer === undefined && this.beatMs > 0) {
      this.timer = setInterval(() => void this.heartbeat().catch(() => undefined), this.beatMs);
      this.timer.unref();
    }
    return true;
  }

  async heartbeat(): Promise<boolean> {
    const expiresAt = new Date(this.now() + this.leaseMs);
    for (const id of this.held.keys()) {
      const key = parseKey(id);
      const updated = await this.db
        .update(boardLocks)
        .set({ expiresAt })
        .where(and(eq(boardLocks.plakySpaceId, key.space), eq(boardLocks.plakyBoardId, key.board), eq(boardLocks.owner, this.owner)))
        .returning({ board: boardLocks.plakyBoardId });
      if (updated.length === 0) return false;
    }
    return true;
  }

  async unlock(boards: readonly BoardKey[]): Promise<void> {
    const failures: unknown[] = [];
    for (const key of boards) {
      const id = keyOf(key);
      const count = (this.held.get(id) ?? 0) - 1;
      if (count > 0) {
        this.held.set(id, count);
        continue;
      }
      this.held.delete(id);
      try {
        await this.db.delete(boardLocks).where(and(eq(boardLocks.plakySpaceId, key.space), eq(boardLocks.plakyBoardId, key.board), eq(boardLocks.owner, this.owner)));
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.held.size === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (failures.length) throw failures[0];
  }

  async markDispatched(ref: EntityRef): Promise<void> {
    await this.write(ref, { type: "dispatch" });
  }
  async markCommitted(ref: EntityRef, commit: Commit): Promise<void> {
    await this.write(ref, { type: "commit", commit });
  }
  async markAmbiguous(ref: EntityRef, error: string): Promise<void> {
    await this.write(ref, { type: "unknown", error });
  }
  async markFailed(ref: EntityRef, error: string): Promise<void> {
    await this.write(ref, { type: "refuse", error });
  }

  private async write(ref: EntityRef, event: EntityEvent): Promise<void> {
    const patch = entityWrite(event);
    const { status, lastError } = patch;
    const at = new Date(this.now());
    const known = {
      ...(patch.plakyId == null ? {} : { plakyId: patch.plakyId }),
      ...(patch.plakyParentId == null ? {} : { plakyParentId: patch.plakyParentId }),
      ...(patch.created && patch.plakyId != null ? { createdPlakyId: patch.plakyId } : {}),
    };
    await this.db
      .insert(entityMappings)
      .values({
        migrationId: this.migrationId,
        entityType: ref.type,
        asanaId: ref.asanaId,
        scope: ref.scope,
        occurrence: ref.occurrence,
        status,
        lastError,
        updatedAt: at,
        ...known,
      })
      .onConflictDoUpdate({
        target: [entityMappings.migrationId, entityMappings.entityType, entityMappings.scope, entityMappings.asanaId, entityMappings.occurrence],
        set: { status, lastError, updatedAt: at, ...known },
      });
    if (event.type === "commit" && (ref.type === "item" || ref.type === "subitem") && ref.scope !== "") {
      await this.db.delete(entityMappings).where(and(
        eq(entityMappings.migrationId, this.migrationId), eq(entityMappings.entityType, ref.type), eq(entityMappings.scope, ""), eq(entityMappings.asanaId, ref.asanaId),
        patch.plakyParentId == null ? isNull(entityMappings.plakyParentId) : or(isNull(entityMappings.plakyParentId), eq(entityMappings.plakyParentId, patch.plakyParentId)),
      ));
    }
  }

  async refusedBefore(ref: EntityRef): Promise<string | null> {
    const row = (await this.db.select({ status: entityMappings.status, lastError: entityMappings.lastError }).from(entityMappings)
      .where(and(eq(entityMappings.migrationId, this.migrationId), eq(entityMappings.entityType, ref.type), eq(entityMappings.scope, ref.scope), eq(entityMappings.asanaId, ref.asanaId), eq(entityMappings.occurrence, ref.occurrence))).limit(1))[0];
    return entityState(row) === "refused" ? row!.lastError!.slice(REFUSED_FOR_GOOD.length) : null;
  }

  async reconcile(settled: readonly { ref: EntityRef; commit: Commit }[]): Promise<void> {
    if (!settled.length) return;
    const types = [...new Set(settled.map((s) => s.ref.type))];
    const pending = (await this.db.select().from(entityMappings)
      .where(and(eq(entityMappings.migrationId, this.migrationId), inArray(entityMappings.entityType, types), inArray(entityMappings.status, ["dispatched", "ambiguous", "failed"]))))
      .filter(canReconcile);
    if (!pending.length) return;
    const keyOf = (type: string, scope: string, asanaId: string, occurrence: number): string => [type, scope, asanaId, String(occurrence)].join("\u0000");
    const byKey = new Map(settled.map((s) => [keyOf(s.ref.type, s.ref.scope, s.ref.asanaId, s.ref.occurrence), s.commit]));
    const at = new Date(this.now());
    for (const row of pending) {
      const commit = byKey.get(keyOf(row.entityType, row.scope, row.asanaId, row.occurrence));
      if (commit === undefined) continue;
      await this.db.update(entityMappings)
        .set({ status: "committed", lastError: null, updatedAt: at, plakyId: commit.plakyId, ...(commit.plakyParentId == null ? {} : { plakyParentId: commit.plakyParentId }) })
        .where(eq(entityMappings.id, row.id));
    }
  }

  async adopt(found: readonly { ref: EntityRef; commit: Commit }[]): Promise<void> {
    const at = new Date(this.now());
    for (let i = 0; i < found.length; i += 200) {
      await this.db.insert(entityMappings).values(found.slice(i, i + 200).map(({ ref, commit }) => ({
        migrationId: this.migrationId, entityType: ref.type, asanaId: ref.asanaId, scope: ref.scope, occurrence: ref.occurrence,
        status: "committed" as const, lastError: null, updatedAt: at,
        ...(commit.plakyId == null ? {} : { plakyId: commit.plakyId }), ...(commit.plakyParentId == null ? {} : { plakyParentId: commit.plakyParentId }),
      }))).onConflictDoNothing();
    }
  }

  async markApplied(board: BoardSync): Promise<void> {
    if (!(await markBoardApplied(this.db, this.migrationId, board.asanaBoardId))) throw new Error(`migration ${this.migrationId} has no board row for Asana board ${board.asanaBoardId} to mark applied`);
  }
  async markNotApplied(board: BoardSync): Promise<void> {
    await markBoardUnapplied(this.db, this.migrationId, board.asanaBoardId);
  }
}

const keyOf = (key: BoardKey): string => `${key.space}/${key.board}`;
const parseKey = (id: string): BoardKey => {
  const [space, board] = id.split("/").map(Number);
  return { space: space!, board: board! };
};
