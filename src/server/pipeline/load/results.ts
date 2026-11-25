import type { PipelinePlaky } from "./guarded";
import { type AssetSource } from "../assets";
import type { PipelineLog } from "../events";
import { failureText } from "../plan";
import { asId, titleKey } from "../transform/mapping";
import { isDict } from "../transform/pystr";
import { type LoadStore } from "./store";
import type { WrittenRecorder } from "../written";

export type ApplyResult = {
  created: number;
  updated: number;
  fieldUpdates: number;
  unchanged: number;
  recreated: number;
  pruned: number;
  groupsCreated: number;
  groupsReordered: number;
  groupsRenamed: number;
  commentsCreated: number;
  commentsUpdated: number;
  filesUploaded: number;
  subscribersReplaced: number;
  ambiguous: string[];
  failures: string[];
  notes: string[];
  rateLimited: boolean;
  seedGroupDeleted: boolean;
  writes: number;
  stopped: boolean;
  stoppedBy?: "operator" | "lease" | "key";
  permanentFailures: number;
  plakyItemIds: Record<string, number>;
};

export function newApplyResult(): ApplyResult {
  return {
    created: 0, updated: 0, fieldUpdates: 0, unchanged: 0, recreated: 0, pruned: 0, groupsCreated: 0, groupsReordered: 0, groupsRenamed: 0,
    commentsCreated: 0, commentsUpdated: 0, filesUploaded: 0, subscribersReplaced: 0,
    ambiguous: [], failures: [], notes: [], rateLimited: false, seedGroupDeleted: false, writes: 0, stopped: false, permanentFailures: 0, plakyItemIds: {},
  };
}

export type BoardStop = "operator" | "lease" | "key" | "rate-limit";
export function stopBoard(result: ApplyResult, reason: BoardStop): void {
  if (reason === "rate-limit") result.rateLimited = true;
  else {
    result.stopped = true;
    result.stoppedBy = reason;
  }
}

export type ApplyDeps = {
  plaky: PipelinePlaky;
  store: LoadStore;
  log?: PipelineLog;
  progress?: () => void;
  fetcher?: AssetSource | undefined;
  written?: WrittenRecorder | undefined;
};

export type ApplyOptions = {
  recreateDrifted?: boolean;
  prune?: boolean;
  signal?: AbortSignal | undefined;
  maxCommentsPerItem?: number;
  parentIds?: ((parentAsanaItemId: string) => number | null) | undefined;
  inRun?: ((asanaItemId: string) => boolean) | undefined;
};

export const textOf = (error: unknown): string => failureText(error);

export const FRESH_WRITE_MS = 5_000;
export const HELD_TRIES = 3;

export const emptyListing = (value: unknown): boolean =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (isDict(value) && Object.keys(value).length === 0);

export function fileKey(name: string, size: unknown): string {
  return `${titleKey(name)}\u0000${asId(size) ?? ""}`;
}
