import { RUN_REACHED_FROM, type RunOutcome } from "../jobs/run-state";
import { hostname } from "node:os";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { connections, migrationLogs, migrationRuns, migrations, asanaUsage } from "@/db/schema";
import { logger, redact, redactString, registerSecret } from "../redact";
import { REACHED_FROM } from "./status";
import { sameConnectionUser } from "./connection-identity";
import type { PipelineEvent } from "./events";
import type { Manifest } from "./manifest";
import { recordManifestBoards } from "./board-state";
import { withoutAddresses } from "./transform/people";

type Options = typeof migrations.$inferInsert.options;
export const DEFAULT_OPTIONS: Options = {
  syncComments: true, syncFiles: true, syncSubscribers: true, syncGroups: true, withCreated: true, withLink: true,
  prune: false, recreateDrifted: false, allowDuplicateImport: false, paidAsana: false, subitems: "auto",
};
type Status = (typeof migrations.$inferSelect)["status"];

export async function ensureConnection(
  db: Db,
  c: { asanaAccountId: string; asanaUserId: string; asanaUserGid?: string | null; asanaTimeZone: string | null; plakyUserId: number; asanaAccountSlug?: string | null; asanaTier?: string | null; label?: string },
): Promise<number> {
  const candidates = await db.select().from(connections).where(eq(connections.plakyUserId, c.plakyUserId));
  const found = c.asanaUserGid
    ? candidates.find(row => row.asanaUserGid === c.asanaUserGid) ?? candidates.find(row => sameConnectionUser(row, c))
    : candidates.find(row => row.asanaUserGid === null && row.asanaAccountId === c.asanaAccountId && row.asanaUserId === c.asanaUserId);
  if (found) {
    await db.update(connections).set({
      asanaAccountId: c.asanaAccountId, asanaUserId: c.asanaUserId,
      ...(c.asanaUserGid ? { asanaUserGid: c.asanaUserGid } : {}),
      ...(c.asanaAccountSlug ? { asanaAccountSlug: c.asanaAccountSlug } : {}),
      ...(c.asanaTier ? { asanaTier: c.asanaTier } : {}),
    }).where(eq(connections.id, found.id));
    return found.id;
  }
  const [row] = await db.insert(connections).values({ ...c, label: c.label ?? `Asana ${c.asanaAccountId}` }).returning({ id: connections.id });
  return row!.id;
}

export type Keys = { asanaToken: string | null; plakyKey: string | null; paidAsana?: boolean };
export type Typed = Keys & { plakyWebBase: string | null };

const sessionKeys = ((globalThis as { __a2pSessionKeys?: Map<number, Keys> }).__a2pSessionKeys ??= new Map());

export async function saveKeys(db: Db, connectionId: number, keys: Partial<Typed>): Promise<void> {
  registerSecret(keys.asanaToken);
  registerSecret(keys.plakyKey);
  const held = sessionKeys.get(connectionId) ?? { asanaToken: null, plakyKey: null };
  sessionKeys.set(connectionId, {
    asanaToken: keys.asanaToken === undefined ? held.asanaToken : keys.asanaToken || null,
    plakyKey: keys.plakyKey === undefined ? held.plakyKey : keys.plakyKey || null,
  });
  if (keys.plakyWebBase !== undefined) await db.update(connections).set({ plakyWebBase: keys.plakyWebBase || null }).where(eq(connections.id, connectionId));
}

export function forgetKeys(connectionId: number): void {
  sessionKeys.delete(connectionId);
}

export const plakyKeyHeld = (key: string): boolean => [...sessionKeys.values()].some((held) => held.plakyKey === key);

export async function keysFor(db: Db, migrationId: number): Promise<Typed> {
  const row = (await db.select({ connectionId: connections.id, plakyWebBase: connections.plakyWebBase, options: migrations.options }).from(migrations)
    .innerJoin(connections, eq(connections.id, migrations.connectionId)).where(eq(migrations.id, migrationId)).limit(1))[0];
  const held = row ? sessionKeys.get(row.connectionId) : undefined;
  return { asanaToken: held?.asanaToken ?? null, plakyKey: held?.plakyKey ?? null, plakyWebBase: row?.plakyWebBase ?? null, paidAsana: row?.options.paidAsana === true };
}

export async function createMigration(db: Db, m: { connectionId: number; name: string; plakySpaceId: number | null; options?: Partial<Options> }): Promise<number> {
  const [row] = await db.insert(migrations).values({ connectionId: m.connectionId, name: m.name, plakySpaceId: m.plakySpaceId, options: { ...DEFAULT_OPTIONS, ...m.options } }).returning({ id: migrations.id });
  return row!.id;
}

export async function getMigration(db: Db, id: number): Promise<typeof migrations.$inferSelect> {
  const row = (await db.select().from(migrations).where(eq(migrations.id, id)).limit(1))[0];
  if (!row) throw new Error(`no migration ${id}`);
  return row;
}

export async function renameMigration(db: Db, id: number, name: string): Promise<void> {
  await db.update(migrations).set({ name: [...name].slice(0, 80).join(""), updatedAt: new Date() }).where(eq(migrations.id, id));
}

export async function updateSetup(db: Db, id: number, setup: { plakySpaceId?: number | null; options?: Partial<Options> }): Promise<void> {
  const current = await getMigration(db, id);
  await db.update(migrations).set({
    ...(setup.plakySpaceId === undefined ? {} : { plakySpaceId: setup.plakySpaceId }),
    options: { ...current.options, ...setup.options },
    updatedAt: new Date(),
  }).where(eq(migrations.id, id));
}

async function moveStatus(db: Db, id: number, status: Status, unless?: SQL): Promise<void> {
  const allowed = REACHED_FROM[status];
  const moved = await db.update(migrations).set({ status, updatedAt: new Date() })
    .where(and(eq(migrations.id, id), inArray(migrations.status, [...allowed]), unless)).returning({ id: migrations.id });
  if (moved.length) return;
  const from = (await db.select({ status: migrations.status }).from(migrations).where(eq(migrations.id, id)).limit(1))[0]?.status;
  if (from !== undefined && from !== status && !allowed.includes(from)) logger.warn(`migration ${id}: status ${from} cannot become ${status}; left as it is`);
}

export async function setSeedFailures(db: Db, id: number, failures: readonly string[]): Promise<void> {
  await db.update(migrations).set({ seedFailures: [...failures], updatedAt: new Date() }).where(eq(migrations.id, id));
}

export async function setStatus(db: Db, id: number, status: Status): Promise<void> {
  await moveStatus(db, id, status);
}

export async function setStatusUnlessOtherRun(db: Db, id: number, status: Status, ownRunId: number | null = null): Promise<void> {
  await moveStatus(db, id, status, sql`NOT EXISTS (SELECT 1 FROM ${migrationRuns} WHERE ${migrationRuns.migrationId} = ${id} AND ${migrationRuns.status} = 'running' AND ${migrationRuns.kind} <> 'plan' AND ${migrationRuns.id} <> ${ownRunId ?? -1})`);
}

export async function saveManifest(db: Db, id: number, manifest: Manifest): Promise<void> {
  await db.update(migrations).set({ manifest: manifest as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(migrations.id, id));
  await recordManifestBoards(db, id, manifest);
}

export async function loadManifest(db: Db, id: number): Promise<Manifest | null> {
  const raw = (await getMigration(db, id)).manifest;
  if (!raw) return null;
  const manifest = raw as unknown as Manifest;
  const stale = manifest.people.some((p) => p.placeholder?.includes("@"));
  return stale ? { ...manifest, people: manifest.people.map((p) => (p.placeholder?.includes("@") ? { ...p, placeholder: withoutAddresses(p.placeholder, p.id) } : p)) } : manifest;
}

export { saveLinkConfig, loadLinkConfig, markBoardUnapplied, forgetPlakyBoard, setSyncPoints, setEventTokens, eventTokens, clearSyncPoints } from "./board-state";

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export async function recordAsanaCall(db: Db, at: number = Date.now(), n = 1): Promise<void> {
  await db.insert(asanaUsage).values({ day: utcDay(at), calls: n }).onConflictDoUpdate({ target: asanaUsage.day, set: { calls: sql`${asanaUsage.calls} + ${n}` } });
}

export async function asanaCallsOn(db: Db, at: number = Date.now()): Promise<number> {
  return (await db.select({ calls: asanaUsage.calls }).from(asanaUsage).where(eq(asanaUsage.day, utcDay(at))).limit(1))[0]?.calls ?? 0;
}

export type RunKind = (typeof migrationRuns.$inferInsert)["kind"];

export const RUN_HEARTBEAT_MS = 20_000;
type Beats = WeakMap<Db, Map<number, ReturnType<typeof setInterval>>>;
const allBeats: Beats = ((globalThis as { __a2pRunBeats?: Beats }).__a2pRunBeats ??= new WeakMap());
const beatsOf = (db: Db): Map<number, ReturnType<typeof setInterval>> => {
  let beats = allBeats.get(db);
  if (!beats) allBeats.set(db, (beats = new Map()));
  return beats;
};

export const ownRunIds = (db: Db): number[] => [...beatsOf(db).keys()];

export const PROCESS_TOKEN: string = ((globalThis as { __a2pProcessToken?: string }).__a2pProcessToken ??= crypto.randomUUID());

export async function startRun(db: Db, migrationId: number, kind: RunKind): Promise<number> {
  const [row] = await db.insert(migrationRuns).values({ migrationId, kind, status: "running", heartbeatAt: new Date(), ownerHost: hostname(), ownerPid: process.pid, ownerToken: PROCESS_TOKEN })
    .returning({ id: migrationRuns.id });
  const runId = row!.id;
  const beat: ReturnType<typeof setInterval> = setInterval(() => {
    if (db.$client.closed) {
      clearInterval(beat);
      beatsOf(db).delete(runId);
      return;
    }
    void db.update(migrationRuns).set({ heartbeatAt: new Date() }).where(and(eq(migrationRuns.id, runId), eq(migrationRuns.status, "running"))).catch(() => undefined);
  }, RUN_HEARTBEAT_MS);
  (beat as { unref?: () => void }).unref?.();
  beatsOf(db).set(runId, beat);
  return runId;
}

export async function finishRun(
  db: Db, runId: number, status: RunOutcome,
  extra: { plannedWrites?: number; counts?: Record<string, number>; receipt?: unknown } = {},
): Promise<void> {
  const beats = beatsOf(db);
  clearInterval(beats.get(runId));
  beats.delete(runId);
  const finished = await db.update(migrationRuns).set({ status, finishedAt: new Date(), ...extra }).where(and(eq(migrationRuns.id, runId), inArray(migrationRuns.status, [...RUN_REACHED_FROM[status]]))).returning({ id: migrationRuns.id });
  if (!finished.length && Object.keys(extra).length) await db.update(migrationRuns).set(extra).where(eq(migrationRuns.id, runId));
}

export function boardIdsByName(rows: readonly { asanaBoardName: string; id: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const shared = new Set<string>();
  for (const r of rows) {
    if (out.has(r.asanaBoardName)) shared.add(r.asanaBoardName);
    out.set(r.asanaBoardName, r.id);
  }
  for (const name of shared) out.delete(name);
  return out;
}

const LOG_INSERT_RETRIES = 1;

export function dbLog(db: Db, runId: number, boardIds: ReadonlyMap<string, number> = new Map()): { log: (event: PipelineEvent) => void; flush: () => Promise<void> } {
  let queue: Promise<unknown> = Promise.resolve();
  let lost = 0;
  const insert = async (event: PipelineEvent): Promise<void> => {
    const row = {
      runId, level: event.level, code: event.code, message: redactString(event.message), data: event.data === undefined ? null : (redact(event.data) as Record<string, unknown>),
      migrationBoardId: event.board ? (boardIds.get(event.board) ?? null) : null,
    };
    for (let attempt = 0; ; attempt++) {
      try {
        await db.insert(migrationLogs).values(row);
        return;
      } catch (error) {
        if (attempt >= LOG_INSERT_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  };
  return {
    log(event) {
      queue = queue.then(() => insert(event)).catch(() => void lost++);
    },
    flush: async () => {
      let counted = false;
      for (;;) {
        const seen = queue;
        await seen;
        if (lost && !counted) {
          counted = true;
          const n = lost;
          lost = 0;
          queue = queue.then(() => insert({ level: "error", code: "log.lost", message: `${n} log event(s) could not be saved.`, data: { lost: n } })).catch(() => void (lost += n));
        } else if (seen === queue) return;
      }
    },
  };
}
