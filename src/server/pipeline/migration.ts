import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { migrationBoards, migrations } from "@/db/schema";
import { PreconditionError } from "../errors";
import type { AsanaClient } from "../clients/asana";
import type { PipelinePlaky } from "./load/guarded";
import type { BoardSync, PeopleMap } from "./config";
import type { SinceByBoard } from "./changes";
import { discover, asanaSource, type SubitemsMode } from "./discover";
import type { PipelineLog } from "./events";
import { boardItemIds, extractProject, readMembers, type BoardExtract, type ListTrees } from "./extract";
import { type AsanaWorkspaceMembership } from "../clients/asana";
import { baseBoardId, isLevelTwo, levelTwoId } from "./names";
import { boardHints, decideRelink, deleteSeeds, isReady, linkManifest, liveKeysOf, recordPairings, type RelinkDecision } from "./link";
import { applyPlans, withBoardLocks, type ApplyPlansResult } from "./load";
import { keepPairings, keptShapes, type Manifest } from "./manifest";
import { AssetFetcher, asanaAssetUrls } from "./assets";
import { personRefs } from "./transform/mapping";
import { syncNameFields } from "./people-match";
import { loadDirectory, planBoards, plannedWrites, type BoardPlan } from "./plan";
import { DbLoadStore } from "./store-load";
import { eventTokens, ensureConnection, forgetPlakyBoard, getMigration, loadLinkConfig, loadManifest, markBoardUnapplied, saveLinkConfig, saveManifest, setSeedFailures, setStatus } from "./store";
import { verify, type Receipt } from "./verify";
import { dbWrittenRecorder, loadWritten } from "./written";

export type Since = string | null | SinceByBoard;

export type Deps = {
  db: Db;
  migrationId: number;
  asana: AsanaClient;
  plaky: PipelinePlaky;
  log: PipelineLog;
  signal?: AbortSignal | undefined;
};

export class ExtractCache {
  private readonly projects = new Map<string, Promise<{ top: BoardExtract; second: BoardExtract }>>();
  private readonly lists: ListTrees = new Map();
  private readonly members = new Map<string, Promise<AsanaWorkspaceMembership[]>>();
  private linked: Promise<readonly BoardSync[]> | undefined;
  private selection: Promise<string[]> | undefined;
  readonly tokens = new Map<string, string>();
  constructor(
    private readonly deps: Pick<Deps, "db" | "migrationId" | "asana"> & Partial<Pick<Deps, "log">>,
    private readonly since: Since = null,
  ) {}
  private nestedSince(board: Pick<BoardSync, "asanaBoardId"> & Partial<Pick<BoardSync, "applied">>, project: string | null): string | null {
    if (board.applied === false || this.since === null) return null;
    if (typeof this.since === "string") return this.since;
    return this.since.has(board.asanaBoardId) ? (this.since.get(board.asanaBoardId) ?? null) : project;
  }
  sinceFor(board: Pick<BoardSync, "asanaBoardId"> & Partial<Pick<BoardSync, "applied">>): string | null {
    if (board.applied === false || this.since === null) return null;
    return typeof this.since === "string" ? this.since : (this.since.get(board.asanaBoardId) ?? null);
  }
  private boards(): Promise<readonly BoardSync[]> {
    return (this.linked ??= loadLinkConfig(this.deps.db, this.deps.migrationId).then((loaded) => loaded?.config.boards ?? []));
  }
  private selected(): Promise<string[]> {
    return (this.selection ??= this.boards().then((boards) => [...new Set(boards.map((b) => baseBoardId(b.asanaBoardId)))]));
  }
  private async carried(): Promise<Set<string>> {
    return new Set((await this.boards()).filter((b) => isLevelTwo(b.asanaBoardId)).map((b) => baseBoardId(b.asanaBoardId)));
  }
  private membersOf(workspace: string): Promise<AsanaWorkspaceMembership[]> {
    let found = this.members.get(workspace);
    if (!found) this.members.set(workspace, (found = readMembers(this.deps.asana, workspace)));
    return found;
  }
  read = async (board: Pick<BoardSync, "asanaBoardId"> & Partial<Pick<BoardSync, "applied">>): Promise<BoardExtract> => {
    const base = baseBoardId(board.asanaBoardId);
    let found = this.projects.get(base);
    if (!found) {
      found = this.extract(base, board);
      this.projects.set(base, found);
      found.catch(() => this.projects.delete(base));
    }
    const { top, second } = await found;
    return isLevelTwo(board.asanaBoardId) ? second : top;
  };
  private async extract(base: string, board: Partial<Pick<BoardSync, "applied">>): Promise<{ top: BoardExtract; second: BoardExtract }> {
    const { asana, db, migrationId } = this.deps;
    const { workspace } = await asana.sourceProject(base);
    let since = this.sinceFor({ asanaBoardId: base, ...(board.applied === undefined ? {} : { applied: board.applied }) });
    const subtasks = (await this.boards()).find((b) => b.asanaBoardId === levelTwoId(base));
    const own = subtasks !== undefined && !subtasks.nested;
    let subSince = own ? this.sinceFor(subtasks) : subtasks === undefined ? since : this.nestedSince(subtasks, since);
    const fromSubtasks = subSince !== null && (since === null || Date.parse(subSince) < Date.parse(since));
    const held = since === null && subSince === null ? null : ((await eventTokens(db, migrationId)).get(fromSubtasks ? levelTwoId(base) : base) ?? null);
    const feed = base.startsWith("mytasks:") ? { sync: "", rows: [], expired: true } : await asana.events(base, held);
    if (feed.sync) { this.tokens.set(base, feed.sync); this.tokens.set(levelTwoId(base), feed.sync); }
    if ((since !== null || subSince !== null) && (feed.expired || held === null)) {
      since = null; subSince = null;
      this.deps.log?.({ level: "info", code: "changes.full_read", message: "Reading comments and files in full because no continuous event history is available." });
    }
    const edited = feed.rows.filter((e) => e.resource?.resource_type === "story" && e.action === "changed").map((e) => e.resource!.gid);
    const stories = await asana.storyTargets([...new Set(edited)]);
    return extractProject(asana, base, {
      since,
      alsoRead: stories.tasks,
      ...(stories.hidden ? { hiddenEdits: stories.hidden } : {}),
      selected: await this.selected(),
      subtasksCarried: await this.carried(),
      members: workspace ? await this.membersOf(workspace.gid) : [],
      lists: this.lists,
      ...(own ? { subtaskBoard: true, subSince } : subSince !== since ? { subSince } : {}),
    });
  }
}

export type Identity = {
  connection: { asanaAccountId: string; asanaUserId: string; asanaUserGid: string; asanaTimeZone: string | null; plakyUserId: number; asanaAccountSlug: string | null; asanaTier: string | null };
  account: string | null; user: string | null; zone: string | null; plakyUser: string | null;
};
export async function identify(asana: AsanaClient, plaky: PipelinePlaky): Promise<Identity> {
  const [me, zone, user] = await Promise.all([asana.me(), Promise.resolve(null), plaky.getCurrentUser()]);
  return {
    connection: { asanaAccountId: me.account ?? "unknown", asanaUserId: me.email ?? me.name ?? "unknown", asanaUserGid: me.gid, asanaTimeZone: zone, plakyUserId: Number(user.id), asanaAccountSlug: me.slug, asanaTier: me.tier },
    account: me.account, user: me.email ?? me.name, zone, plakyUser: user.email ?? user.name ?? null,
  };
}

export async function connect(db: Db, asana: AsanaClient, plaky: PipelinePlaky): Promise<{ connectionId: number } & Omit<Identity, "connection">> {
  const { connection, ...who } = await identify(asana, plaky);
  return { connectionId: await ensureConnection(db, connection), ...who };
}

export async function discoverStep(deps: Deps, o: { extras?: Iterable<string>; only?: Iterable<string>; listArchived?: boolean; handLists?: boolean; subitems?: SubitemsMode } = {}): Promise<Manifest> {
  const { db, migrationId, asana, plaky, log } = deps;
  const directory = await loadDirectory(plaky);
  const previous = await loadManifest(db, migrationId);
  const fresh = await discover({ asana: asanaSource(asana, [...(o.only ?? [])].filter((id) => id.startsWith("mytasks:"))), directory }, {
    extras: o.extras ?? ["created", "link"], levels: true, subitems: o.subitems ?? "auto", keepShape: keptShapes(previous),
    ...(o.only ? { only: o.only } : {}), ...(o.listArchived ? { listArchived: true } : {}),
  });
  fresh.generatedAt = new Date().toISOString();
  const merged = previous ? keepPairings(fresh, previous) : { manifest: fresh, kept: 0, unread: [] };
  if (merged.kept) log({ level: "info", code: "discover.pairings_kept", message: `Kept ${merged.kept} board pairing(s) from the earlier discovery.` });
  for (const b of merged.unread) log({ level: "info", code: "discover.unread_kept", board: b.name, message: `${b.name} was not read this time and is kept as recorded.` });
  await saveManifest(db, migrationId, merged.manifest);
  await syncNameFields(db, migrationId);
  await setStatus(db, migrationId, "discovered");
  return (await loadManifest(db, migrationId)) ?? merged.manifest;
}

export type LinkStepResult =
  | { ok: true; boards: number; deletedSeeds: number; seedFailures: string[]; decision: RelinkDecision }
  | { ok: false; reason: "blocked"; blocking: string[] }
  | { ok: false; reason: "confirm" };

export const linkedSources = (manifest: Pick<Manifest, "boards">): string[] => manifest.boards.filter((b) => !b.parentBoardId).map((b) => b.id);

export type LinkLookups = {
  itemIds?: ((boardId: string) => Promise<Set<string>>) | undefined;
  noAsana?: boolean | undefined;
  homes?: Map<string, number[]> | undefined;
};

async function linkOutcome(deps: Deps, o: LinkLookups & { preview?: boolean } = {}) {
  const { db, migrationId, asana, plaky, log } = deps;
  const migration = await getMigration(db, migrationId);
  const manifest = await loadManifest(db, migrationId);
  if (!manifest) throw new PreconditionError("discover first: this migration has no manifest");
  if (migration.plakySpaceId === null) throw new Error("this migration has no Plaky space");
  const previous = (await loadLinkConfig(db, migrationId))?.config ?? null;
  const lists: ListTrees = new Map();
  const outcome = await linkManifest(plaky, manifest, migration.plakySpaceId, previous, {
    ...(o.noAsana ? {} : {
      itemIds: o.itemIds ?? ((boardId: string) => boardItemIds(asana, boardId, linkedSources(manifest), lists)),
      itemBoards: (ids: readonly string[]) => asana.activeItemBoards(ids),
    }),
    preview: o.preview ?? false,
    ...(o.preview && o.homes ? (o.noAsana ? { knownHomes: o.homes } : { homes: o.homes }) : {}),
    comments: migration.options.syncComments,
    files: migration.options.syncFiles,
    subscribers: migration.options.syncSubscribers,
    people: migration.people as PeopleMap,
    log,
  });
  return { migration, manifest, previous, outcome };
}

async function boardsRecordedElsewhere(db: Deps["db"], migrationId: number, plakyBoardIds: readonly number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!plakyBoardIds.length) return out;
  const rows = await db.select({ board: migrationBoards.plakyBoardId, id: migrations.id, name: migrations.name }).from(migrationBoards)
    .innerJoin(migrations, eq(migrations.id, migrationBoards.migrationId))
    .where(and(inArray(migrationBoards.plakyBoardId, [...plakyBoardIds]), ne(migrationBoards.migrationId, migrationId)));
  for (const r of rows) if (r.board !== null) out.set(r.board, [...(out.get(r.board) ?? []), `#${r.id} '${r.name}'`]);
  return out;
}

export async function previewLink(deps: Deps, o: LinkLookups = {}) {
  const { manifest, previous, outcome } = await linkOutcome(deps, { ...o, preview: true });
  const decision = outcome.built ? decideRelink(previous, outcome.built.syncConfig, liveKeysOf(outcome.seeded)) : null;
  const elsewhere = await boardsRecordedElsewhere(deps.db, deps.migrationId, outcome.result.links.map((l) => l.plakyBoardId));
  return {
    links: outcome.result.links.map((l) => ({
      asanaBoardId: l.asanaBoardId, name: l.name, plakyBoardId: l.plakyBoardId, paired: Object.keys(l.fieldMap).length,
      unmatched: l.unmatched, warnings: [...l.warnings, ...(elsewhere.get(l.plakyBoardId) ?? []).map((m) => `Plaky board ${l.plakyBoardId} is also recorded for migration ${m}: both would write to it`)], seedRows: l.seedItemIds.length, ready: isReady(l), subitemsOf: l.subitemsOf,
    })),
    missing: outcome.result.missing.map(([id, name]) => ({ id, name })),
    gone: manifest.boards.filter((b) => !b.nested && outcome.gone.has(b.id) && !outcome.seeded.has(b.id)).map((b) => ({ id: b.id, name: b.name, plakyBoardId: outcome.gone.get(b.id)! })),
    hints: boardHints(manifest, outcome.result.missing.map(([id]) => id), outcome.unmarked, new Set(manifest.boards.flatMap((b) => (b.plakyBoardId === null ? [] : [b.plakyBoardId])))),
    blocking: outcome.blocking,
    peopleWarnings: outcome.peopleWarnings,
    wanted: manifest.boards.length,
    needsConfirm: decision?.action === "confirm",
    changes: decision?.action === "write" ? decision.changes : null,
  };
}

export async function linkStep(deps: Deps, o: { force?: boolean } = {}): Promise<LinkStepResult> {
  const { db, migrationId, plaky, log } = deps;
  const { migration, manifest, previous, outcome } = await linkOutcome(deps);
  const unseeded = new Map([...outcome.gone].filter(([boardId]) => !outcome.seeded.has(boardId)));
  const current = unseeded.size ? recordPairings(manifest, [], unseeded) : manifest;
  if (unseeded.size) await saveManifest(db, migrationId, current);
  for (const [boardId, plakyBoardId] of unseeded) {
    await forgetPlakyBoard(db, migrationId, plakyBoardId);
    await markBoardUnapplied(db, migrationId, boardId);
  }
  if (!outcome.built) {
    const gone = manifest.boards.filter((b) => !b.nested && unseeded.has(b.id))
      .map((b) => `${b.name}: Plaky board ${unseeded.get(b.id)} is not in this space any more (deleted, or moved to another space). Import its file again, then link.`);
    return { ok: false, reason: "blocked", blocking: [...gone, ...outcome.blocking] };
  }
  const missing = outcome.result.missing.filter(([id]) => !manifest.boards.some((b) => b.id === id && b.nested));
  if (missing.length && !o.force) {
    return { ok: false, reason: "blocked", blocking: missing.map(([, name]) => `${name}: not found in Plaky yet. Import its file into the space (this page offers it), then link again.`) };
  }
  const decision = decideRelink(previous, outcome.built.syncConfig, liveKeysOf(outcome.seeded), o.force ?? false);
  if (decision.action === "confirm") return { ok: false, reason: "confirm" };
  const before = new Map((await loadLinkConfig(db, migrationId))?.config.boards.map((b) => [b.asanaBoardId, b.plakyBoardId]) ?? []);
  await saveManifest(db, migrationId, recordPairings(current, outcome.result.links));
  await saveLinkConfig(db, migrationId, outcome.built.syncConfig);
  for (const link of outcome.result.links) {
    const old = before.get(link.asanaBoardId);
    if (old === undefined || old === link.plakyBoardId) continue;
    await forgetPlakyBoard(db, migrationId, old);
    await markBoardUnapplied(db, migrationId, link.asanaBoardId);
    log({ level: "info", code: "link.repaired", board: link.name, message: `${link.name}: paired with Plaky board ${link.plakyBoardId} in place of board ${old}; the next run reads it in full.` });
  }
  const { deleted, failures } = await deleteSeeds(plaky, migration.plakySpaceId!, outcome.result.links, { manifest, seeded: outcome.seeded });
  for (const failure of failures) log({ level: "warn", code: "link.seed_delete_failed", message: failure });
  await setSeedFailures(db, migrationId, failures);
  log({ level: "info", code: "link.done", message: `Linked ${outcome.result.links.length} board(s); deleted ${deleted} seed row(s).` });
  await setStatus(db, migrationId, "linked");
  return { ok: true, boards: outcome.result.links.length, deletedSeeds: deleted, seedFailures: failures, decision };
}

export type Extracts = Pick<ExtractCache, "read">;

async function reviewedRead(deps: Deps, cache: Extracts, people: PeopleMap, boards: readonly BoardSync[]): Promise<Extracts["read"]> {
  const manifest = await loadManifest(deps.db, deps.migrationId);
  if (!manifest) return cache.read;
  const known = new Set(manifest.people.filter((p) => p.kind === "person").map((p) => p.id));
  let directory: ReturnType<typeof loadDirectory> | undefined;
  return async (board) => {
    const extract = await cache.read(board);
    const sync = boards.find((b) => b.asanaBoardId === board.asanaBoardId);
    const assigned = new Set(extract.items.flatMap((item) => [
      ...Object.entries(item.columnValues).flatMap(([id, cell]) => cell.type === "people" && !sync?.skipColumns.includes(id) ? personRefs(cell).filter(([kind]) => kind === "person").map(([, id]) => id) : []),
      ...(sync?.syncSubscribers ? item.subscriberIds : []),
    ]));
    const fresh = [...assigned].filter((id) => !known.has(id) && !Object.hasOwn(people, id));
    if (fresh.length) {
      directory ??= loadDirectory(deps.plaky);
      const users = await directory;
      const unmatched = fresh.filter((id) => !users.assignable(extract.users[id]?.email));
      if (unmatched.length) throw new PreconditionError(`New unmatched people: ${unmatched.map((id) => extract.users[id]?.name || id).join(", ")}. Read projects again, review People, then link the boards before moving.`);
    }
    return extract;
  };
}

export type PlanStepResult = { plans: BoardPlan[]; failures: string[]; plannedWrites: number; cache: Extracts };

export async function planStep(deps: Deps, o: { cache?: Extracts; since?: Since } = {}): Promise<PlanStepResult> {
  const { db, migrationId, plaky } = deps;
  const migration = await getMigration(db, migrationId);
  const loaded = await loadLinkConfig(db, migrationId);
  if (!loaded) throw new PreconditionError("link first: this migration has no config");
  const since = o.since ?? null;
  const cache = o.cache ?? new ExtractCache(deps, since);
  const points = new Map((await db.select({ id: migrationBoards.asanaBoardId, at: migrationBoards.syncedReadAt }).from(migrationBoards).where(eq(migrationBoards.migrationId, migrationId)))
    .map((b) => [b.id, b.at?.toISOString() ?? null]));
  const { plans, failures } = await planBoards(await reviewedRead(deps, cache, loaded.config.people, loaded.config.boards), plaky, loaded.config, {
    allowDuplicateImport: migration.options.allowDuplicateImport,
    rich: true,
    parentTitles: (boardId, only) => (only ? deps.asana.itemNames(only) : deps.asana.itemTitles(baseBoardId(boardId))),
    syncPoint: (boardId) => points.get(boardId) ?? null,
    written: await loadWritten(db, migrationId, loaded.config.boards.map((b) => b.plakyBoardId)),
  });
  if (!deps.signal?.aborted) for (const failure of failures) deps.log({ level: "error", code: "plan.board_failed", message: `cannot plan ${failure}` });
  return { plans, failures, plannedWrites: plannedWrites(plans, { prune: migration.options.prune, recreateDrifted: migration.options.recreateDrifted }), cache };
}

export type ApplyStepResult = {
  planned: PlanStepResult;
  applied: ApplyPlansResult | null;
};

export async function applyStep(
  deps: Deps,
  o: { cache?: Extracts; since?: Since; progress?: () => void; confirm?: (planned: PlanStepResult) => boolean | Promise<boolean>; owner?: string;
    unattended?: boolean } = {},
): Promise<ApplyStepResult> {
  const { db, migrationId, asana, plaky, log, signal } = deps;
  const migration = await getMigration(db, migrationId);
  const loaded = await loadLinkConfig(db, migrationId);
  if (!loaded) throw new PreconditionError("link first: this migration has no config");
  const store = new DbLoadStore({ db, migrationId, ...(o.owner === undefined ? {} : { owner: o.owner }) });
  const boards = loaded.config.boards.map((b) => ({ space: b.plakySpaceId, board: b.plakyBoardId }));
  return withBoardLocks(store, boards, async () => {
    await setStatus(db, migrationId, "running");
    const planned = await planStep(deps, { ...(o.cache ? { cache: o.cache } : {}), ...(o.since ? { since: o.since } : {}) });
    if (!planned.plans.length) {
      await setStatus(db, migrationId, signal?.aborted ? "interrupted" : "failed");
      return { planned, applied: null };
    }
    if (o.confirm && !(await o.confirm(planned))) {
      await setStatus(db, migrationId, "interrupted");
      return { planned, applied: null };
    }
    let applied: ApplyPlansResult;
    try {
      applied = await applyPlans(
        planned.plans,
        { plaky, store, log, ...(o.progress ? { progress: o.progress } : {}), fetcher: new AssetFetcher({ fetchAssetUrls: asanaAssetUrls(asana) }), written: dbWrittenRecorder(db, migrationId) },
        { prune: migration.options.prune && !o.unattended, recreateDrifted: migration.options.recreateDrifted && !o.unattended, signal },
      );
    } catch (error) {
      await setStatus(db, migrationId, "failed").catch(() => undefined);
      throw error;
    }
    const failed = planned.failures.length > 0 || applied.results.some((r) => r.result.failures.length || r.result.ambiguous.length);
    const stopped = applied.notStarted.length > 0 || applied.results.some((r) => r.result.stopped || r.result.rateLimited);
    await setStatus(db, migrationId, stopped ? "interrupted" : failed ? "failed" : "completed");
    return { planned, applied };
  });
}

export async function verifyStep(deps: Deps, o: { cache?: Extracts } = {}): Promise<Receipt> {
  const { db, migrationId, plaky, asana } = deps;
  const loaded = await loadLinkConfig(db, migrationId);
  if (!loaded) throw new PreconditionError("link first: this migration has no config");
  const manifest = await loadManifest(db, migrationId);
  const cache = o.cache ?? new ExtractCache(deps);
  const points = new Map((await db.select({ id: migrationBoards.asanaBoardId, at: migrationBoards.syncedReadAt }).from(migrationBoards).where(eq(migrationBoards.migrationId, migrationId)))
    .map((b) => [b.id, b.at?.toISOString() ?? null]));
  return verify(await reviewedRead(deps, cache, loaded.config.people, loaded.config.boards), plaky, loaded.config, manifest ? { boards: manifest.boards.map((b) => ({ id: b.id, dropped: b.columns.filter((c) => c.plakyType === null).map((c) => ({ title: c.title, type: c.type, reason: c.reason ?? "" })) })) } : null, { parentTitles: (boardId) => asana.itemTitles(baseBoardId(boardId)), rich: true, written: await loadWritten(db, migrationId, loaded.config.boards.map((b) => b.plakyBoardId)), syncPoint: (boardId) => points.get(boardId) ?? null });
}
