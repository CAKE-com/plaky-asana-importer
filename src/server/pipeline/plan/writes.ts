import { redactString } from "../../redact";
import { type BoardSync } from "../config";
import { type PlannedComment } from "../transform/comments";
import type { WrittenEntry, WrittenView } from "../written";
import { type AsanaFile } from "../transform/files";
import { type FieldMap } from "../transform/mapping";
import { type PlannedGroup } from "../transform/order";
import { PY_SPACE } from "../transform/pystr";

export const MAX_PLAKY_PAGE_SIZE = 1000;
export const SEED_GROUP_TITLE = "New group";

export const SHARED_ID_FIX =
  'Plaky\'s "Duplicate item" copies the Asana ID: in the copy (titled "... (duplicated)" unless renamed), clear the Asana ID field, or delete the copy if it is not needed. ' +
  "Then re-run.";

export class SyncSetupError extends Error {
  override readonly name = "SyncSetupError";
}

export type PlannedWrite = {
  asanaItemId: string;
  title: string;
  groupTitle: string | null;
  fields: Record<string, unknown>;
  existingItemId: number | null;
  existingTitle: string | null;
  unchanged: boolean;
  sameFields: boolean;
  sameSubscribers: boolean;
  drifted: boolean;
  moveGroup?: boolean;
  stayed?: true;
  othersHold?: true;
  send?: string[];
  kept?: string[];
  subscriberIds: number[];
  existingFields: Record<string, unknown> | null;
  existingGroupId: number | null;
  existingSubscriberIds: number[];
  warnings: string[];
  notCarried: string[];
  parentAsanaItemId: string | null;
  uncleared: string[];
  stale?: string[];
};

export function plannedWrite(init: Pick<PlannedWrite, "asanaItemId" | "title" | "groupTitle" | "fields"> & Partial<PlannedWrite>): PlannedWrite {
  return {
    existingItemId: null,
    existingTitle: null,
    unchanged: false,
    sameFields: false,
    sameSubscribers: false,
    drifted: false,
    subscriberIds: [],
    existingFields: null,
    existingGroupId: null,
    existingSubscriberIds: [],
    warnings: [],
    notCarried: [],
    parentAsanaItemId: null,
    uncleared: [],
    ...init,
  };
}

export function writeAction(write: PlannedWrite): "create" | "update" | "unchanged" {
  if (!write.existingItemId) return "create";
  return write.unchanged ? "unchanged" : "update";
}

export type ItemFiles = {
  assets: AsanaFile[];
  plakyItemId: number | null;
  fileCount: number;
  settled?: boolean;
};

export type ItemComments = {
  planned: PlannedComment[];
  plakyItemId: number | null;
  commentCount: number;
  settled?: boolean;
};

export type BoardPlan = {
  config: BoardSync;
  asanaBoardName: string;
  plakyBoardName: string;
  fieldMap: FieldMap;
  writes: PlannedWrite[];
  groupWrites: PlannedGroup[];
  orphans: [itemId: number, title: string, seen: { asanaId: string; read: Readonly<Record<string, unknown>> }][];
  groupIds: Map<string, number>;
  notes: string[];
  asanaIdKey: string | null;
  parentFields?: readonly { key: string; name: string }[];
  seedGroup: { id: number; title: string } | null;
  comments: Map<string, ItemComments>;
  files: Map<string, ItemFiles>;
  uncarried: string[];
  archivedGroups: string[];
  existingIds: ReadonlyMap<string, number>;
  written?: WrittenView;
  hashOf?: (key: string, value: unknown) => string | null;
  ownership?: (asanaId: string, row: { id: number; title?: string | null | undefined; group?: number | null | undefined; fields?: readonly { key: string; value?: unknown }[] | null | undefined }) => string[];
  assetMeta?: (assetId: string) => [name: string, size: number | null] | undefined;
  groupsRecord?: (skipped?: ReadonlySet<number>) => WrittenEntry[];
  kept?: string[];
  protectedOrphans?: number[];
  inAsana?: (asanaId: string) => boolean;
  readShort?: true;
};

function commentEstimate(entry: ItemComments): number {
  const top = entry.planned.filter((c) => c.kind === "update").length;
  const missing = Math.max(0, top - entry.commentCount);
  return missing + (missing > 0 ? entry.planned.length - top : 0);
}

export function commentsToWrite(plan: BoardPlan): number {
  let total = 0;
  for (const entry of plan.comments.values()) total += commentEstimate(entry);
  return total;
}

export function filesToUpload(plan: BoardPlan): number {
  let total = 0;
  for (const entry of plan.files.values()) total += Math.max(0, entry.assets.length - entry.fileCount);
  return total;
}

export const GROUP_COLORS = ["#283593", "#00796B", "#C62828", "#6A1B9A", "#EF6C00", "#37474F"] as const;
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export const MAX_TITLE = 255;

export type PlakyRow = Readonly<Record<string, unknown>>;

export const codePoints = (text: string): string[] => [...text];
export const TRAILING_SPACE = new RegExp(`[${PY_SPACE}]+$`);
export const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
export const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function failureText(error: unknown): string {
  if (error instanceof Error) return redactString(error.message || error.name);
  return redactString(String(error) || "Error");
}

export function replacesSubscribers(config: BoardSync, write: PlannedWrite): boolean {
  return config.syncSubscribers && write.subscriberIds.length > 0 && !write.sameSubscribers;
}

export function plannedWrites(plans: readonly BoardPlan[], options: { prune?: boolean; recreateDrifted?: boolean } = {}): number {
  let total = 0;
  for (const plan of plans) {
    const rebuilt = new Set(plan.writes.filter((write) => options.recreateDrifted && write.drifted && write.existingItemId).map((write) => write.asanaItemId));
    for (const write of plan.writes) {
      if (rebuilt.has(write.asanaItemId)) total += 2;
      else if (writeAction(write) === "create") total += 1;
      else if (writeAction(write) === "update") {
        total += write.sameFields ? 0 : 1;
        total += write.moveGroup ? 1 : 0;
        total += replacesSubscribers(plan.config, write) ? 1 : 0;
      }
    }
    total += plan.groupWrites.length;
    total += options.prune ? plan.orphans.length : 0;
    total += plan.seedGroup !== null ? 1 : 0;
    for (const [asanaId, held] of plan.comments) total += rebuilt.has(asanaId) ? held.planned.length : commentEstimate(held);
    total += filesToUpload(plan);
    for (const [asanaId, held] of plan.files) if (rebuilt.has(asanaId)) total += Math.min(held.assets.length, held.fileCount);
  }
  return total;
}

