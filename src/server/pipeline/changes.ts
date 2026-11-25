import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { migrationBoards } from "@/db/schema";
import { PreconditionError } from "../errors";
import type { ApplyPlansResult } from "./load";
import { clearSyncPoints, loadLinkConfig, setEventTokens, setSyncPoints } from "./store";
import type { BoardReport, Receipt } from "./verify";

import { SINCE_MARGIN_MS } from "./names";

export { SINCE_MARGIN_MS };

export type SinceByBoard = ReadonlyMap<string, string | null>;

export type ChangesPlan = { since: string; from: SinceByBoard; full: string[] };

export async function changesPlan(db: Db, migrationId: number): Promise<ChangesPlan> {
  const loaded = await loadLinkConfig(db, migrationId);
  if (!loaded) throw new PreconditionError("link the boards first");
  const rows = await db.select({ board: migrationBoards.asanaBoardId, at: migrationBoards.syncedReadAt }).from(migrationBoards).where(eq(migrationBoards.migrationId, migrationId));
  const points = new Map(rows.map((r) => [r.board, r.at]));
  const from = new Map<string, string | null>();
  for (const b of loaded.config.boards) {
    const at = points.get(b.asanaBoardId);
    from.set(b.asanaBoardId, at ? new Date(at.getTime() - SINCE_MARGIN_MS).toISOString() : null);
  }
  const sinces = [...from.values()].filter((s): s is string => s !== null).sort();
  if (!sinces.length) throw new PreconditionError("no board is in step with Asana yet: run a full migration first");
  return { since: sinces[0]!, from, full: [...from].filter(([, s]) => s === null).map(([b]) => b) };
}

const shortBoard = (b: BoardReport): boolean => b.missing.length > 0 || b.differing.length > 0 || b.shortWithinLimits;

export function syncedBoards(applied: ApplyPlansResult, receipt: Receipt | null): { clean: string[]; short: string[] } {
  const verified = new Map((receipt?.boards ?? []).map((b) => [b.asanaBoardId, b]));
  const isShort = new Map<string, boolean>();
  for (const { plan, result } of applied.results) {
    const id = plan.config.asanaBoardId;
    const v = verified.get(id);
    const ok = result.failures.length === result.permanentFailures && !result.ambiguous.length && !result.rateLimited && !result.stopped && !(v && shortBoard(v)) && !plan.readShort;
    isShort.set(id, !ok);
  }
  for (const { plan } of applied.results) {
    const { nested, subitemsOf, asanaBoardId } = plan.config;
    if (nested && subitemsOf && isShort.has(subitemsOf) && (isShort.get(asanaBoardId) || isShort.get(subitemsOf))) {
      isShort.set(asanaBoardId, true);
      isShort.set(subitemsOf, true);
    }
  }
  const clean: string[] = [];
  const short: string[] = [];
  for (const [id, bad] of isShort) (bad ? short : clean).push(id);
  return { clean, short };
}

export async function recordSyncPoints(db: Db, migrationId: number, applied: ApplyPlansResult, receipt: Receipt | null, readAt: number, tokens: ReadonlyMap<string, string> = new Map()): Promise<{ clean: string[]; short: string[] }> {
  const synced = syncedBoards(applied, receipt);
  await setSyncPoints(db, migrationId, synced.clean, readAt);
  await setEventTokens(db, migrationId, synced.clean, tokens);
  await clearSyncPoints(db, migrationId, synced.short);
  return synced;
}

export const shortAtVerify = (receipt: Receipt): string[] => receipt.boards.filter(shortBoard).map((b) => b.asanaBoardId);

