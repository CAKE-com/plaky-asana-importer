import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { writtenValues } from "@/db/schema";

export const valueHash = (normalized: unknown): string =>
  createHash("sha256").update(JSON.stringify(normalized ?? null, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).digest("hex").slice(0, 16);

export type WrittenView = {
  get(subject: string, key: string): string | undefined;
  keys(subject: string): string[];
};

export function forRow(view: WrittenView | undefined, subject: string, rowId: number | null | undefined): ((key: string) => string | undefined) | undefined {
  if (view === undefined) return undefined;
  const valid = rowId !== null && rowId !== undefined && view.get(subject, "__row") === valueHash(rowId);
  return (key) => (valid ? view.get(subject, key) : undefined);
}

export type WrittenEntry = { plakyBoardId: number; subject: string; key: string; hash: string };

export type WrittenSubject = { plakyBoardId: number; subject: string };

export type WrittenRecorder = { record(entries: readonly WrittenEntry[], forget?: readonly WrittenSubject[]): Promise<void> };

const keyOf = (subject: string, key: string): string => `${subject}\u0000${key}`;

export function writtenView(rows: ReadonlyMap<string, string>): WrittenView {
  let bySubject: Map<string, string[]> | null = null;
  return {
    get: (subject, key) => rows.get(keyOf(subject, key)),
    keys: (subject) => {
      if (bySubject === null) {
        bySubject = new Map();
        for (const k of rows.keys()) {
          const at = k.indexOf("\u0000");
          const of = k.slice(0, at);
          bySubject.set(of, [...(bySubject.get(of) ?? []), k.slice(at + 1)]);
        }
      }
      return bySubject.get(subject) ?? [];
    },
  };
}

export async function loadWritten(db: Db, migrationId: number, plakyBoardIds: readonly number[]): Promise<Map<number, WrittenView>> {
  const ids = [...new Set(plakyBoardIds)];
  const rows = ids.length
    ? await db.select().from(writtenValues).where(and(eq(writtenValues.migrationId, migrationId), inArray(writtenValues.plakyBoardId, ids)))
    : [];
  const byBoard = new Map<number, Map<string, string>>(ids.map((id) => [id, new Map()]));
  for (const row of rows) byBoard.get(row.plakyBoardId)?.set(keyOf(row.subject, row.key), row.hash);
  return new Map([...byBoard].map(([id, held]) => [id, writtenView(held)]));
}

export function dbWrittenRecorder(db: Db, migrationId: number): WrittenRecorder {
  return {
    async record(entries, forget = []) {
      for (const { plakyBoardId, subject } of forget) {
        await db.delete(writtenValues).where(and(eq(writtenValues.migrationId, migrationId), eq(writtenValues.plakyBoardId, plakyBoardId), eq(writtenValues.subject, subject)));
      }
      for (let at = 0; at < entries.length; at += 200) {
        const batch = entries.slice(at, at + 200).map((e) => ({ migrationId, plakyBoardId: e.plakyBoardId, subject: e.subject, key: e.key, hash: e.hash }));
        await db.insert(writtenValues).values(batch).onConflictDoUpdate({
          target: [writtenValues.migrationId, writtenValues.plakyBoardId, writtenValues.subject, writtenValues.key],
          set: { hash: sql`excluded.hash`, updatedAt: sql`(unixepoch('subsec') * 1000)` },
        });
      }
    },
  };
}

export async function forgetWritten(db: Db, migrationId: number, plakyBoardId: number, subjects: readonly string[], groupIds: readonly number[]): Promise<void> {
  const onBoard = and(eq(writtenValues.migrationId, migrationId), eq(writtenValues.plakyBoardId, plakyBoardId));
  for (let at = 0; at < subjects.length; at += 500) {
    await db.delete(writtenValues).where(and(onBoard, inArray(writtenValues.subject, subjects.slice(at, at + 500))));
  }
  if (!groupIds.length) return;
  await db.delete(writtenValues).where(and(onBoard, eq(writtenValues.subject, ""), inArray(writtenValues.key, groupIds.map((id) => `__group_title:${id}`))));
  const order = (await db.select().from(writtenValues).where(and(onBoard, eq(writtenValues.subject, ""), eq(writtenValues.key, "__group_order"))))[0];
  if (order === undefined) return;
  const gone = new Set(groupIds);
  let ids: unknown;
  try {
    ids = JSON.parse(order.hash);
  } catch {
    ids = null;
  }
  const left = Array.isArray(ids) ? ids.filter((id) => !gone.has(Number(id))) : null;
  if (left === null) await db.delete(writtenValues).where(and(onBoard, eq(writtenValues.subject, ""), eq(writtenValues.key, "__group_order")));
  else await db.update(writtenValues).set({ hash: JSON.stringify(left) }).where(and(onBoard, eq(writtenValues.subject, ""), eq(writtenValues.key, "__group_order")));
}
