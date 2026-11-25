import { FIELD_KEY, type BoardSync, type PeopleMap, type SyncConfig } from "../config";
import { PARENT_ID_FIELD, PARENT_TITLE_FIELD } from "../names";
import { type JsonObject, type SeededBoard, type BoardLink } from "./types";

export function buildConfig(
  links: readonly BoardLink[],
  space: number,
  people: PeopleMap | null = null,
  options: { previous?: SyncConfig | null; comments?: boolean | null; files?: boolean | null; subscribers?: boolean | null } = {},
): SyncConfig {
  const earlier = new Map((options.previous?.boards ?? []).map((board) => [board.asanaBoardId, board]));
  const boards = links.map((link): BoardSync => {
    const kept = earlier.get(link.asanaBoardId);
    const flat = Boolean(link.subitemsOf) && !link.nested;
    return {
      name: link.name,
      asanaBoardId: link.asanaBoardId,
      plakySpaceId: space,
      plakyBoardId: link.plakyBoardId,
      fieldMap: { ...link.fieldMap },
      skipColumns: [...link.skipColumns],
      labelMap: kept?.labelMap ?? {},
      asanaIdField: link.asanaIdKey,
      subitemsOf: link.subitemsOf,
      nested: Boolean(link.subitemsOf) && link.nested,
      parentTitleField: flat ? link.parentTitleKey : PARENT_TITLE_FIELD,
      parentIdField: flat ? link.parentIdKey : PARENT_ID_FIELD,
      syncGroups: link.subitemsOf ? false : (kept?.syncGroups ?? true),
      syncSubscribers: options.subscribers ?? kept?.syncSubscribers ?? false,
      syncComments: options.comments ?? kept?.syncComments ?? false,
      syncFiles: options.files ?? kept?.syncFiles ?? false,
      seedGroupId: link.seedGroupId || null,
      applied: kept?.applied ?? false,
    };
  });
  return { boards, people: { ...(people ?? {}) } };
}

const linkedKeys = (board: BoardSync): Map<string, string | null> =>
  new Map<string, string | null>([...Object.entries(board.fieldMap), ["asanaIdField", board.asanaIdField], ["parentTitleField", board.parentTitleField], ["parentIdField", board.parentIdField]]);

const SWITCHES = [["syncComments", "comments"], ["syncFiles", "files"], ["syncSubscribers", "subscribers"]] as const;

const withoutKeys = (board: BoardSync): unknown => ({ ...board, fieldMap: null, asanaIdField: null, parentTitleField: null, parentIdField: null, syncComments: null, syncFiles: null, syncSubscribers: null });

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(b)) return false;
  const left = Object.entries(a);
  return left.length === Object.keys(b).length && left.every(([k, v]) => Object.hasOwn(b, k) && same(v, (b as JsonObject)[k]));
}

export function safeChanges(existing: SyncConfig, built: SyncConfig, liveKeys: ReadonlyMap<string, ReadonlySet<string>>): string[] | null {
  const now = new Map(built.boards.map((b) => [b.asanaBoardId, b]));
  const changes: string[] = [];
  for (const entry of existing.boards) {
    const next = now.get(entry.asanaBoardId);
    if (next === undefined) return null;
    if (same(next, entry)) continue;
    const before = linkedKeys(entry);
    const after = linkedKeys(next);
    if (!same(withoutKeys(entry), withoutKeys(next))) return null;
    const live = liveKeys.get(entry.asanaBoardId) ?? new Set<string>();
    const kept = [...before].filter(([, key]) => key !== null && (live.has(key) || !FIELD_KEY.test(key))).map(([column]) => column);
    if (kept.some((column) => (after.get(column) ?? null) !== before.get(column))) return null;
    const repaired = [...before].filter(([column, key]) => (after.get(column) ?? null) !== key).map(([column]) => column);
    if (repaired.some((column) => (after.get(column) ?? null) === null)) return null;
    changes.push(...repaired.map((c) => `${entry.name}: ${before.get(c)} -> ${after.get(c)}`));
    changes.push(...[...after.keys()].filter((c) => !before.has(c)).map((c) => `${entry.name}: ${c} -> ${after.get(c)}`));
    changes.push(...SWITCHES.filter(([key]) => entry[key] !== next[key]).map(([key, what]) => `${entry.name}: ${what} ${next[key] ? "on" : "off"}`));
  }
  if (Object.entries(existing.people).some(([key, value]) => !same(built.people[key] ?? null, value))) return null;
  const paired = new Set(existing.boards.map((b) => b.asanaBoardId));
  return [...built.boards.filter((b) => !paired.has(b.asanaBoardId)).map((b) => b.name), ...changes];
}

export const liveKeysOf = (seeded: ReadonlyMap<string, SeededBoard>): Map<string, Set<string>> =>
  new Map([...seeded].map(([boardId, found]) => [boardId, new Set(found.fields.map((f) => f.key))]));

export type RelinkDecision =
  | { action: "write"; changes: string[] | null }
  | { action: "reuse" }
  | { action: "confirm" };

export function decideRelink(existing: SyncConfig | null, built: SyncConfig, liveKeys: ReadonlyMap<string, ReadonlySet<string>>, force = false): RelinkDecision {
  const changes = existing !== null ? safeChanges(existing, built, liveKeys) : null;
  if (existing !== null && !force && changes === null) return { action: "confirm" };
  if (existing !== null && same(existing, built)) return { action: "reuse" };
  return { action: "write", changes: changes?.length ? changes : null };
}
