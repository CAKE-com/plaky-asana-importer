import { isNotSent, isPlakyNotFound, isRateLimited, type PlakyItem } from "../../clients/plaky";
import { deleteRow, type PipelinePlaky } from "../load/guarded";
import { checkConfig, type PeopleMap, type SyncConfig } from "../config";
import type { PipelineLog } from "../events";
import { seededColumns, type Manifest } from "../manifest";
import { seedOf } from "../provision";
import { spellingKey } from "../transform/mapping";
import { ASANA_ID_FIELD, isSeedMarker, markerBoardId } from "../names";
import { blankIn, loadDirectory } from "../plan";
import { UserDirectory } from "../transform/people";
import { RATE_LIMITED, type SeededBoard, type BoardLink, isReady, type LinkResult } from "./types";
import { SEED_TITLE_PREFIX, type Unmarked } from "./scan";
import { type ResolveOptions, resolveTargets } from "./targets";
import { pairBoards } from "./pairing";
import { peopleWithStandIns, checkPeople } from "./people";
import { buildConfig } from "./config";

export * from "./types";
export * from "./scan";
export * from "./targets";
export * from "./pairing";
export * from "./people";
export * from "./config";

export type LinkOptions = ResolveOptions & {
  directory?: UserDirectory;
  people?: PeopleMap | null;
  comments?: boolean;
  files?: boolean;
  subscribers?: boolean;
  log?: PipelineLog;
};

export type LinkOutcome = {
  seeded: Map<string, SeededBoard>;
  gone: Map<string, number>;
  unmarked: Map<number, Unmarked>;
  result: LinkResult;
  blocking: string[];
  peopleWarnings: string[];
  people: PeopleMap | null;
  built: { syncConfig: SyncConfig } | null;
};

export async function linkManifest(
  plaky: PipelinePlaky,
  manifest: Manifest,
  space: number,
  previousConfig: SyncConfig | null,
  options: LinkOptions = {},
): Promise<LinkOutcome> {
  const log = options.log ?? (() => undefined);
  const gone = new Map<string, number>();
  const unmarked = new Map<number, Unmarked>();
  const seeded = await resolveTargets(plaky, manifest, space, { ...options, sweepSeeds: options.sweepSeeds ?? !options.preview, gone, unmarked });
  for (const [boardId, plakyBoardId] of gone) {
    const board = manifest.boards.find((b) => b.id === boardId);
    if (board?.nested) continue;
    const name = board?.name ?? boardId;
    const again = seeded.get(boardId);
    log({
      level: "warn",
      code: "link.board_gone",
      board: name,
      message: again
        ? `${name}: Plaky board ${plakyBoardId} is not in space ${space} any more (deleted, or moved to another space); the seed imported again on board ${again.plakyBoardId} takes its place.`
        : `${name}: Plaky board ${plakyBoardId} is not in space ${space} any more (deleted, or moved to another space). Import its file again to set it up again.`,
    });
  }
  for (const board of manifest.boards) {
    const found = seeded.get(board.id);
    if (!board.nested && board.plakyBoardId === null && found !== undefined && found.seedItemIds.length === 0) {
      log({
        level: "info",
        code: "link.already_in_plaky",
        board: board.name,
        message: `${board.name}: already in Plaky on board ${found.plakyBoardId} (most of its items are this board's items in Asana), so it is paired with that board again.`,
      });
    }
  }

  const result = pairBoards(manifest, seeded, previousConfig);
  const blocking: string[] = [];
  for (const link of result.links) {
    for (const problem of link.unmatched) {
      blocking.push(problem);
      log({ level: "error", code: "link.unmatched", board: link.name, message: problem });
    }
    for (const warning of link.warnings) log({ level: "warn", code: "link.field_warning", board: link.name, message: warning });
    if (link.asanaIdKey === null) {
      const message = `no '${ASANA_ID_FIELD}' field: re-runs would duplicate every item`;
      blocking.push(`${link.name}: ${message}`);
      log({ level: "error", code: "link.no_asana_id", board: link.name, message });
    }
  }
  for (const [id, name] of result.missing) log({ level: "info", code: "link.missing", board: name, message: `${name} (${id}): no seeded Plaky board found yet` });

  if (!result.links.length) {
    log({ level: "error", code: "link.nothing_linked", message: "Nothing linked. Import the seed CSVs from the blueprint first." });
    return { seeded, gone, unmarked, result, blocking, peopleWarnings: [], people: previousConfig?.people ?? null, built: null };
  }

  let people: PeopleMap | null = previousConfig?.people ?? options.people ?? null;
  let peopleWarnings: string[] = [];
  if (manifest.people.length) {
    const directory = options.directory ?? (await loadDirectory(plaky));
    const [problems, warnings] = checkPeople(manifest, directory, people);
    peopleWarnings = warnings;
    people = peopleWithStandIns(manifest, directory, people);
    for (const problem of problems) {
      blocking.push(problem);
      log({ level: "error", code: "link.people_problem", message: problem });
    }
    for (const warning of warnings) log({ level: "warn", code: "link.people_warning", message: warning });
  }

  const outcome: LinkOutcome = { seeded, gone, unmarked, result, blocking, peopleWarnings, people, built: null };
  if (!result.links.every(isReady) || blocking.length) return outcome;
  const syncConfig = buildConfig(result.links, space, people, {
    previous: previousConfig,
    ...(options.comments === undefined ? {} : { comments: options.comments }),
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.subscribers === undefined ? {} : { subscribers: options.subscribers }),
  });
  try {
    checkConfig(syncConfig.boards, "link config");
    outcome.built = { syncConfig };
  } catch (error) {
    blocking.push(error instanceof Error ? error.message : String(error));
  }
  return outcome;
}

export function recordPairings(manifest: Manifest, links: readonly BoardLink[], gone: ReadonlyMap<string, number> = new Map()): Manifest {
  const byAsana = new Map(links.map((link) => [link.asanaBoardId, link.plakyBoardId]));
  return {
    ...manifest,
    boards: manifest.boards.map((board) => (byAsana.has(board.id) ? { ...board, plakyBoardId: byAsana.get(board.id)! } : gone.has(board.id) ? { ...board, plakyBoardId: null } : board)),
  };
}

export async function deleteSeeds(
  plaky: PipelinePlaky,
  space: number,
  links: readonly BoardLink[],
  made: { manifest?: Manifest; seeded?: ReadonlyMap<string, SeededBoard> } = {},
): Promise<{ deleted: number; failures: string[] }> {
  let deleted = 0;
  const failures: string[] = [];
  const seeds = links.reduce((sum, link) => sum + link.seedItemIds.length, 0);
  for (const link of links) {
    const judge = seedJudge(plaky, space, link, made);
    for (const itemId of link.seedItemIds) {
      try {
        const outcome = await deleteRow(plaky, { space, board: link.plakyBoardId, row: itemId }, judge);
        if (outcome.done === "gone") continue;
        if (outcome.done === "kept") {
          failures.push(`${link.name}: seed item ${itemId} kept: ${outcome.why.join("; ")}; ${outcome.slow ? "delete it by hand if it should go" : "delete it by hand once what it holds is safe elsewhere"}`);
          continue;
        }
        deleted++;
      } catch (error) {
        if (isPlakyNotFound(error)) continue;
        if (isRateLimited(error) || isNotSent(error, "held")) {
          failures.push(`${seeds - deleted} seed row(s) remain: ${RATE_LIMITED}`);
          return { deleted, failures };
        }
        failures.push(`${link.name}: seed item ${itemId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { deleted, failures };
}

function seedJudge(plaky: PipelinePlaky, space: number, link: BoardLink, made: { manifest?: Manifest; seeded?: ReadonlyMap<string, SeededBoard> }) {
  const found = made.manifest?.boards.find((b) => b.id === link.asanaBoardId);
  const board = found && made.manifest ? seedOf(found, made.manifest) : undefined;
  const fields = new Map((made.seeded?.get(link.asanaBoardId)?.fields ?? []).map((f) => [f.key, f]));
  const columns = board ? seededColumns(board).flatMap((c) => (link.fieldMap[c.id] ? [[link.fieldMap[c.id]!, c.labels] as const] : [])) : [];
  const given = (key: string, index: number): string => columns.find(([k]) => k === key)?.[1][index] ?? "";
  const asGiven = (key: string, value: unknown): string => {
    const titles = new Map(fields.get(key)?.labelsByKey ?? []);
    if (Array.isArray(value)) return value.length === 1 ? (titles.get(String(value[0])) ?? String(value[0])) : JSON.stringify(value);
    return titles.get(String(value)) ?? String(value);
  };
  return async (row: PlakyItem, nested: readonly PlakyItem[]): Promise<string[]> => {
    const why: string[] = [];
    const itemId = row.id;
    const number = new RegExp(`^${SEED_TITLE_PREFIX} (\\d+)$`).exec(String(row.title ?? ""))?.[1];
    if (number === undefined) why.push("its title was changed in Plaky");
    const marker = (row.fields ?? []).find((f) => f.key === link.asanaIdKey)?.value;
    if (!isSeedMarker(marker) || markerBoardId(String(marker)) !== link.asanaBoardId) why.push("its Asana ID cell no longer holds its seed marker");
    const index = Number(number ?? 0) - 1;
    const changed = (row.fields ?? []).filter((f) => f.key !== link.asanaIdKey && !blankIn(f.value, fields.get(f.key)) && asGiven(f.key, f.value) !== "" && spellingKey(asGiven(f.key, f.value)) !== spellingKey(given(f.key, index)));
    if (changed.length) why.push(`${changed.length} value(s) on it were set in Plaky`);
    if (nested.length) why.push(`it holds ${nested.length} nested row(s) added in Plaky, which its delete would take along`);
    if ((await plaky.listItemComments(space, link.plakyBoardId, itemId)).length) why.push("it holds comments made in Plaky");
    if ((await plaky.listItemFiles(space, link.plakyBoardId, itemId)).length) why.push("it holds files added in Plaky");
    return why;
  };
}
