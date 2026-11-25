import { ItemTargets } from "./item-state";
import { isFeatureLimit, isNotSent, isOutcomeUnknown, isPlakyHttp, isRateLimited, type CreateItemBody, type PlakyItem } from "../../clients/plaky";
import { isAsanaRateLimited } from "../../clients/asana";
import { FileTooLarge, type AssetSource } from "../assets";
import { MAX_TITLE, SyncSetupError, blankIn, existingByAsanaId, readPlakyRows, replacesSubscribers, withoutClears, type BoardPlan, type PlannedWrite } from "../plan";
import { MAX_COMMENTS_PER_ITEM, commentHeader, headerOf, markerOf, type PlannedComment } from "../transform/comments";
import { contentType, type AsanaFile } from "../transform/files";
import { asId, plakyField, spellingKey, titleByKey } from "../transform/mapping";
import { groupAction } from "../transform/order";
import { isDict, truthy } from "../transform/pystr";
import { BY_HAND_CODE, type EntityRef, type Commit, REFUSED_FOR_GOOD, PERMANENT_UPLOAD } from "./store";
import { type ApplyResult, newApplyResult, stopBoard, type ApplyDeps, type ApplyOptions, textOf, emptyListing, fileKey } from "./results";
import { forRow, valueHash, type WrittenEntry, type WrittenSubject } from "../written";
import { linkCellsMoved, madeInPlaky, type LinkCells } from "./owned";
import { deleteGroup, deleteRow, writeComment, writeGroup, writeRow, type Deleted, type RowStep } from "./guarded";

const GROUP_COLOR = /^#[0-9a-fA-F]{6}$/;
const needColor = (color: unknown): void => {
  if (typeof color !== "string" || !GROUP_COLOR.test(color)) throw new SyncSetupError("body.color must be a #RRGGBB colour");
};

export const RATE_LIMITED = "Plaky kept answering 429 (rate limit), so that request was not applied. Re-run to continue.";

type FilesOutcome = "ok" | "rate_limited" | "asana_limit" | "stopped";


export async function applyPlan(deps: ApplyDeps, plan: BoardPlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  const recorded: WrittenEntry[] = [];
  const forgotten: WrittenSubject[] = [];
  try {
    return await applyBoard(deps, plan, options, recorded, forgotten);
  } finally {
    if ((recorded.length || forgotten.length) && deps.written) await deps.written.record(recorded, forgotten);
  }
}

async function applyBoard(deps: ApplyDeps, plan: BoardPlan, options: ApplyOptions, recorded: WrittenEntry[], forgotten: WrittenSubject[]): Promise<ApplyResult> {
  const { store, fetcher } = deps;
  const whole = deps.plaky;
  const plaky = options.signal ? whole.scoped({ signal: options.signal }) : whole;
  const config = plan.config;
  const result = newApplyResult();
  const space = config.plakySpaceId;
  const board = config.plakyBoardId;
  const itemType = config.subitemsOf ? "subitem" : "item";
  const commentCap = options.maxCommentsPerItem ?? MAX_COMMENTS_PER_ITEM;

  const emit = (level: "info" | "warn" | "error" | "ambiguous", code: string, message: string, data?: Record<string, unknown>): void => {
    try {
      deps.log?.({ level, code, message, board: config.name, ...(data ? { data } : {}) });
    } catch {
    }
  };
  const tick = (): void => {
    try {
      deps.progress?.();
    } catch {
    }
  };
  let current: string | null = null;
  const about = (): Record<string, unknown> | undefined => (current === null ? undefined : { asanaItemId: current });
  const fail = (message: string): void => {
    result.failures.push(message);
    emit("error", "write.failed", message, about());
  };
  const failForGood = (message: string): void => {
    result.permanentFailures++;
    fail(message);
  };
  const failBoard = (message: string): void => {
    result.failures.push(message);
    emit("error", "write.failed", message);
  };
  const unknownOutcome = (message: string): void => {
    result.ambiguous.push(message);
    emit("ambiguous", "write.ambiguous", message, about());
  };
  const note = (message: string): void => {
    result.notes.push(message);
    emit("info", "note", message);
  };
  const stopRateLimited = (label: string): void => {
    result.failures.push(`${label}: ${RATE_LIMITED}`);
    stopBoard(result, "rate-limit");
    emit("error", "rate_limited", `${label}: ${RATE_LIMITED}`, about());
  };
  const haltedBy = (error: unknown, label: string): boolean => {
    if (isRateLimited(error)) stopRateLimited(label);
    else if (isNotSent(error, "stopped")) {
      stopBoard(result, "operator");
      note(`stopped on request while ${label} waited for Plaky's rate limit, so it was not sent; re-run to continue`);
    } else return false;
    return true;
  };

  for (const message of plan.uncarried) failForGood(`not carried: ${message}`);

  const cache = async (write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch (error) {
      note(`entity_mappings not updated (${textOf(error)})`);
    }
  };

  const send = async <T>(ref: EntityRef | null, request: () => Promise<T>, onOk?: (answer: T) => Commit, afterDelete = false): Promise<T> => {
    if (ref) {
      if (afterDelete) await cache(() => store.markDispatched(ref));
      else await store.markDispatched(ref);
    }
    result.writes++;
    let answer: T;
    try {
      answer = await request();
    } catch (error) {
      if (ref) await cache(() => (isOutcomeUnknown(error) ? store.markAmbiguous(ref, textOf(error)) : store.markFailed(ref, textOf(error))));
      if (isPlakyHttp(error) && (error.status === 401 || error.status === 403) && !isFeatureLimit(error)) {
        stopBoard(result, "key");
      }
      throw error;
    }
    tick();
    if (ref && onOk) await cache(() => store.markCommitted(ref, onOk(answer)));
    return answer;
  };

  const itemRef = (asanaItemId: string): EntityRef => ({ type: itemType, asanaId: asanaItemId, scope: config.asanaBoardId, occurrence: 0 });
  const groupRef = (title: string): EntityRef => ({ type: "group", asanaId: spellingKey(title), scope: config.asanaBoardId, occurrence: 0 });
  const itemCommit = (plakyId: number): Commit => ({ plakyId, plakyParentId: board });
  const madeCommit = (plakyId: number): Commit => ({ ...itemCommit(plakyId), created: true });

  const proceed = async (): Promise<boolean> => {
    if (result.stopped) return false;
    if (options.signal?.aborted) {
      stopBoard(result, "operator");
      note("stopped on request, after the write in flight; re-run to continue");
      return false;
    }
    let held = false;
    let why = "its lease was taken over";
    try {
      held = await store.heartbeat();
    } catch (error) {
      why = `the lease could not be extended: ${textOf(error)}`;
    }
    if (!held) {
      stopBoard(result, "lease");
      failBoard(`stopped: another run may hold Plaky board ${space}/${board} now (${why}); re-run to continue`);
    }
    return held;
  };

  const groupTroubleBefore = result.failures.length + result.ambiguous.length;
  const skippedGroups = new Set<number>();
  for (const planned of plan.groupWrites) {
    if (planned.groupId === null || skippedGroups.has(planned.groupId)) continue;
    if (!(await proceed())) return result;
    const label = `group '${planned.title}'`;
    const change = groupAction(planned);
    const inPlace = change === "rename" && planned.heldRanking !== undefined && planned.ranking === planned.heldRanking;
    const groupId = planned.groupId;
    try {
      if (!planned.ranking) throw new SyncSetupError("body.ranking must be a non-empty string");
      const ranking = planned.ranking;
      const written = await writeGroup(plaky, { space, board, group: groupId }, (now) => {
        if (now !== null && (change === "rename" ? now.title !== planned.renamedFrom : spellingKey(now.title ?? "") !== spellingKey(planned.title))) return null;
        const color = now?.color ?? planned.color;
        needColor(color);
        return { title: change === "rename" ? planned.title : (now?.title ?? planned.title), ranking: inPlace && now?.ranking ? now.ranking : ranking, color };
      }, { judged: plan.hashOf !== undefined, send: (request) => send(groupRef(planned.title), request, () => itemCommit(groupId)) });
      if (written.done !== "sent") {
        skippedGroups.add(groupId);
        emit("warn", BY_HAND_CODE, `${label}: ${written.done === "gone" ? "deleted" : "renamed"} in Plaky while the run went on, so it is left as it is`, { plakyGroupId: groupId });
        continue;
      }
      if (change === "rename") result.groupsRenamed++;
      else result.groupsReordered++;
      emit("info", `group.${change === "rename" ? "renamed" : "reordered"}`, `${label} ${change === "rename" ? "renamed" : "re-ranked"}`, { plakyGroupId: groupId });
    } catch (error) {
      if (haltedBy(error, label)) {
        return result;
      }
      if (isOutcomeUnknown(error)) unknownOutcome(`${label}: ${change} dispatched, outcome unknown (${textOf(error)})`);
      else fail(`${label}: ${change} failed (${textOf(error)})`);
    }
  }

  for (const planned of plan.groupWrites.filter((g) => g.groupId === null).reverse()) {
    if (!(await proceed())) return result;
    const title = planned.title;
    const ref = groupRef(title);
    const body: { title: string; color: string; ranking?: string } = { title: [...title].slice(0, MAX_TITLE).join(""), color: planned.color };
    if (planned.ranking) body.ranking = planned.ranking;
    try {
      needColor(planned.color);
      const group = await send(ref, () => plaky.createItemGroup(space, board, body), (g) => madeCommit(g.id));
      plan.groupIds.set(spellingKey(title), group.id);
      result.groupsCreated++;
      emit("info", "group.created", `group '${title}' created`, { plakyGroupId: group.id });
    } catch (error) {
      if (haltedBy(error, `group '${title}'`)) {
        return result;
      }
      if (!(isOutcomeUnknown(error))) {
        fail(`group '${title}': ${textOf(error)}`);
        continue;
      }
      let recovered: number | null = null;
      try {
        const matches = (await plaky.allItemGroups(space, board)).filter((g) => spellingKey(g.title) === spellingKey(title));
        recovered = matches.length === 1 ? matches[0]!.id : null;
      } catch {
        recovered = null;
      }
      if (recovered !== null) {
        plan.groupIds.set(spellingKey(title), recovered);
        result.groupsCreated++;
        const groupId = recovered;
        await cache(() => store.markCommitted(ref, itemCommit(groupId)));
        skippedGroups.add(groupId);
        emit("info", "group.found", `group '${title}' found after its create's answer was lost`, { plakyGroupId: groupId });
      } else {
        unknownOutcome(`group '${title}': dispatched, outcome unknown (${textOf(error)})`);
      }
    }
  }

  if (plan.groupsRecord && result.failures.length + result.ambiguous.length === groupTroubleBefore) recorded.push(...plan.groupsRecord(skippedGroups));

  if (plan.seedGroup !== null) {
    const groupTrouble = result.failures.length + result.ambiguous.length > groupTroubleBefore;
    const seed = plan.seedGroup.id;
    const seedTitle = plan.seedGroup.title;
    const label = `seed group ${seed}`;
    const others = [...plan.groupIds.values()].filter((id) => id !== seed);
    if (groupTrouble || others.length === 0) {
      note(`${label} kept: the Asana groups are not all in place yet`);
    } else {
      try {
        if (!(await proceed())) return result;
        const deleted = await deleteGroup(plaky, { space, board, group: seed }, (fresh) => (fresh.title ?? "") !== seedTitle, (request) => send(null, request));
        if (deleted.done === "left") {
          note(`${label} kept: renamed in Plaky (the import named it '${seedTitle}'); delete it by hand if it should go`);
        } else if (deleted.done === "holds") {
          note(`${label} kept: it still holds items`);
        } else if (deleted.done === "slow") {
          note(`${label} kept: its checks took longer than 5 s three times, so it was not deleted; delete it by hand if it should go`);
        } else if (deleted.done === "gone") {
          note(`${label} is gone from Plaky already`);
        } else {
          result.seedGroupDeleted = true;
          emit("info", "group.seed_deleted", `${label} deleted`, { plakyGroupId: seed });
        }
      } catch (error) {
        if (haltedBy(error, label)) {
          return result;
        }
        note(`${label} kept: could not delete it (${textOf(error)})`);
      }
    }
  }

  const targets = new ItemTargets();
  const remember = (asanaItemId: string, plakyItemId: number): void => {
    targets.remember(asanaItemId, plakyItemId);
    result.plakyItemIds[asanaItemId] = plakyItemId;
  };
  const targetByKey = new Map(plan.fieldMap.pairs.map((pair) => [pair.target.key, pair.target]));

  const parentRowOf = (write: PlannedWrite): number | null => (config.nested && write.parentAsanaItemId ? (options.parentIds?.(write.parentAsanaItemId) ?? null) : null);

  const settled = plan.writes.filter((w) => w.unchanged && w.existingItemId !== null).map((w) => ({ ref: itemRef(w.asanaItemId), commit: itemCommit(w.existingItemId!) }));
  if (settled.length) await cache(() => store.reconcile(settled));
  if (settled.length && store.adopt) await cache(() => store.adopt!(settled));

  const hashOf = plan.hashOf;
  const rebound = new Set<string>();
  const held = async (write: PlannedWrite, rowId: number, keys: readonly string[], o: { groupId?: number | null | undefined; title?: string; values?: Readonly<Record<string, unknown>> } = {}): Promise<void> => {
    if (!hashOf) return;
    const subject = write.asanaItemId;
    if (!rebound.has(subject) && plan.written?.get(subject, "__row") !== valueHash(rowId) && plan.written?.keys(subject).length) forgotten.push({ plakyBoardId: board, subject });
    rebound.add(subject);
    recorded.push({ plakyBoardId: board, subject, key: "__row", hash: valueHash(rowId) });
    for (const key of keys) {
      const hash = hashOf(key, (o.values ?? write.fields)[key]);
      if (hash !== null) recorded.push({ plakyBoardId: board, subject, key, hash });
    }
    if (o.groupId != null) recorded.push({ plakyBoardId: board, subject, key: "__group", hash: valueHash(o.groupId) });
    if (o.title !== undefined) recorded.push({ plakyBoardId: board, subject, key: "__title", hash: valueHash(o.title) });
    if (deps.written) await deps.written.record(recorded.splice(0), forgotten.splice(0));
  };
  const keptOf = (write: PlannedWrite): Set<string> => new Set(write.kept ?? []);

  const ourFile = (asanaId: string, rowId: number) => (fileId: number): boolean =>
    plan.written === undefined || forRow(plan.written, asanaId, rowId)?.(`__file:${fileId}`) !== undefined;
  const ourComment = (asanaId: string, rowId: number) => (commentId: string, content: string): boolean =>
    plan.written === undefined || forRow(plan.written, asanaId, rowId)?.(`__comment:${commentId}`) === valueHash(content);
  const linkCells: LinkCells = { asanaIdKey: plan.asanaIdKey, parentFields: plan.parentFields ?? [], hash: plan.hashOf ?? ((_key, value) => valueHash(value)) };
  const asanaIdOf = (row: PlakyItem): string => (plan.asanaIdKey ? String((row.fields ?? []).find((f) => f.key === plan.asanaIdKey)?.value ?? "").trim() : "");
  const nestedWhy = async (children: readonly PlakyItem[]): Promise<string[]> => {
    let theirs = 0;
    let alive = 0;
    for (const child of children) {
      const asanaId = asanaIdOf(child);
      if (asanaId !== "" && options.inRun?.(asanaId)) {
        alive++;
        continue;
      }
      const why = asanaId === "" ? ["no Asana ID"] : [...(plan.ownership?.(asanaId, child) ?? []), ...(await madeInPlaky(plaky, space, board, child, ourFile(asanaId, child.id), ourComment(asanaId, child.id)))];
      if (why.length) theirs++;
    }
    const why: string[] = [];
    if (theirs) why.push(`it holds ${theirs} nested row(s) made or changed in Plaky, which its delete would take along`);
    if (alive) why.push(`it holds ${alive} nested row(s) whose Asana task is still in Asana (under another parent), which its delete would take along`);
    return why;
  };
  const rebuildRefused = (write: PlannedWrite, rowId: number) => async (fresh: PlakyItem, nested: readonly PlakyItem[]): Promise<string[]> => {
    const why: string[] = [];
    if (write.stale?.length || write.othersHold) why.push("it keeps values Asana no longer gives, or values changed in Plaky");
    why.push(...(plan.ownership?.(write.asanaItemId, fresh) ?? []));
    const record = forRow(plan.written, write.asanaItemId, rowId);
    const now = new Map((fresh.fields ?? []).map((f) => [f.key, f.value ?? null]));
    why.push(...linkCellsMoved(fresh.fields, { asanaId: write.asanaItemId, read: write.existingFields ?? {} }, linkCells));
    if (!Array.isArray(fresh.subscribedUsers) || !Array.isArray(fresh.subscribedTeams)) why.push("Plaky's answer for it did not list its followers and teams, so its replacement could not carry them");
    const cleared = record === undefined ? [] : [...targetByKey.values()].filter((t) => record(t.key) !== undefined && blankIn(now.get(t.key), t)).map((t) => `'${t.name}'`);
    if (cleared.length) why.push(`${cleared.join(", ")} cleared in Plaky since the app wrote ${cleared.length === 1 ? "it" : "them"}, which its replacement would fill again`);
    why.push(...(await madeInPlaky(plaky, space, board, fresh, ourFile(write.asanaItemId, rowId), ourComment(write.asanaItemId, rowId))));
    if (nested.length) why.push(`it holds ${nested.length} nested row(s), which its delete would take along`);
    if (!why.length && write.groupTitle && !plan.groupIds.has(spellingKey(write.groupTitle))) throw new SyncSetupError(`item group '${write.groupTitle}' could not be created`);
    return [...new Set(why)];
  };

  const create = async (write: PlannedWrite, afterDelete = false, followers: readonly number[] = [], teams: readonly number[] = []): Promise<void> => {
    const body: CreateItemBody = { title: write.title, fields: withoutClears(write.fields, targetByKey) };
    const parentId = parentRowOf(write);
    if (parentId !== null) body.parentId = parentId;
    const subscribers = [...new Set([...followers, ...(config.syncSubscribers ? write.subscriberIds : [])])];
    if (subscribers.length > 0) body.subscribedUserIds = subscribers;
    if (teams.length > 0) body.subscribedTeamIds = [...teams];
    if (write.groupTitle) {
      const groupId = plan.groupIds.get(spellingKey(write.groupTitle));
      if (groupId === undefined) throw new SyncSetupError(`item group '${write.groupTitle}' could not be created`);
      body.groupId = groupId;
    }
    const created = await send(itemRef(write.asanaItemId), () => (afterDelete ? whole : plaky).createItem(space, board, body), (item) => madeCommit(item.id), afterDelete);
    remember(write.asanaItemId, created.id);
    await held(write, created.id, Object.keys(body.fields ?? {}), { groupId: body.groupId, title: body.title });
    emit("info", "item.created", "item created", { asanaItemId: write.asanaItemId, plakyItemId: created.id });
  };

  const restoreDeleted = async (write: PlannedWrite, why: string, followers: readonly number[], teams: readonly number[], parent: number | null): Promise<number | null> => {
    if (write.existingFields === null) {
      fail("rollback unavailable: the old item snapshot was not retained");
      return null;
    }
    const oldFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(write.existingFields)) {
      const target = targetByKey.get(key);
      if (emptyListing(value)) continue;
      if (target?.type === "LINK" && isDict(value) && !truthy(value["url"])) continue;
      if (target?.type === "STATUS") {
        oldFields[key] = titleByKey(target).get(String(value)) ?? value;
      } else if (target?.type === "TAG" && Array.isArray(value)) {
        const titles = titleByKey(target);
        oldFields[key] = value.map((entry) => titles.get(String(entry)) ?? entry);
      } else if (target?.type === "PERSON" && isDict(value)) {
        const ids = (entries: unknown) => (Array.isArray(entries) ? entries : []).flatMap((entry) => asId(entry) ?? []).map((id) => ({ id }));
        oldFields[key] = { users: ids(value["assignedUsers"]), teams: ids(value["assignedTeams"]) };
      } else {
        oldFields[key] = value;
      }
    }
    const body: CreateItemBody = { title: write.existingTitle || write.title, fields: oldFields };
    if (write.existingGroupId !== null) body.groupId = write.existingGroupId;
    if (parent !== null) body.parentId = parent;
    if (followers.length > 0) body.subscribedUserIds = [...followers];
    if (teams.length > 0) body.subscribedTeamIds = [...teams];
    let restoredId: number;
    try {
      restoredId = (await send(itemRef(write.asanaItemId), () => whole.createItem(space, board, body), (item) => madeCommit(item.id), true)).id;
      await held(write, restoredId, Object.keys(oldFields), { groupId: body.groupId, title: body.title, values: write.existingFields ?? {} });
    } catch (error) {
      if (isOutcomeUnknown(error)) {
        unknownOutcome(`rollback for item '${write.title}': outcome unknown (${textOf(error)})`);
        return null;
      }
      fail(
        `item '${write.title}' is not in Plaky now: its rebuild failed (${why}) and so did the rollback (${textOf(error)}); the next run creates it again, without its Plaky comments and files`,
      );
      if (isRateLimited(error)) throw error;
      return null;
    }
    return restoredId;
  };

  const rowCarrying = async (asanaItemId: string): Promise<number | null> => {
    if (!plan.asanaIdKey) throw new SyncSetupError("no Asana ID field to find the item by");
    const index = existingByAsanaId(await readPlakyRows(whole, config), config, plakyField({ key: plan.asanaIdKey, name: "Asana ID", type: "STRING" }));
    return index.get(asanaItemId)?.itemId ?? null;
  };

  const halted = new Map<string | null, number>();
  for (const write of [...plan.writes].reverse()) {
    const label = `item '${write.title}' (asana ${write.asanaItemId})`;
    current = write.asanaItemId;
    const stack = config.nested ? write.parentAsanaItemId : write.groupTitle;
    const isCreate = !write.existingItemId;
    if (isCreate && halted.has(stack)) {
      halted.set(stack, halted.get(stack)! + 1);
      continue;
    }
    const existing = write.existingItemId;
    let rebuild = !!existing && write.drifted && options.recreateDrifted === true;
    let followers: readonly number[] = [];
    let teams: readonly number[] = [];
    let parent: number | null = null;
    const renameByHand = (): void => {
      if (write.existingTitle !== null && write.existingTitle !== write.title) emit("warn", BY_HAND_CODE, `Rename “${write.existingTitle}” to “${write.title}”.`, { asanaItemId: write.asanaItemId });
    };
    if (existing && write.drifted && !rebuild) renameByHand();
    for (const note of write.stale ?? []) emit("warn", BY_HAND_CODE, `${write.title}: ${note}`, { asanaItemId: write.asanaItemId });
    if ((isCreate || rebuild) && config.nested && !write.parentAsanaItemId) {
      fail(`${label}: no parent in Asana, so it cannot be nested; not carried`);
      continue;
    }
    if ((isCreate || rebuild) && config.nested && write.parentAsanaItemId && parentRowOf(write) === null) {
      fail(`${label}: its parent (asana ${write.parentAsanaItemId}) is not in Plaky yet, so it waits for the next run`);
      continue;
    }
    if ((rebuild || !write.unchanged) && !(await proceed())) return result;
    try {
      if (existing && rebuild) {
        let deleted: Deleted;
        const judged: { row: PlakyItem | null } = { row: null };
        try {
          deleted = await deleteRow(plaky, { space, board, row: existing }, (fresh, nested) => {
            judged.row = fresh;
            return rebuildRefused(write, existing)(fresh, nested);
          }, (request) => send(itemRef(write.asanaItemId), request));
        } catch (error) {
          if (!(isOutcomeUnknown(error))) throw error;
          unknownOutcome(`${label}: delete outcome unknown (${textOf(error)})`);
          let gone: boolean;
          try {
            gone = (await rowCarrying(write.asanaItemId)) === null;
          } catch {
            targets.unsettle(write.asanaItemId);
            continue;
          }
          const restored = gone ? await restoreDeleted(write, textOf(error), judged.row?.subscribedUsers ?? [], judged.row?.subscribedTeams ?? [], asId(judged.row?.parent)) : null;
          if (restored === null) targets.unsettle(write.asanaItemId);
          else remember(write.asanaItemId, restored);
          continue;
        }
        if (deleted.done === "gone") throw deleted.error;
        if (deleted.done === "kept") {
          rebuild = false;
          emit("warn", BY_HAND_CODE, deleted.slow
            ? `${write.title}: not rebuilt: ${deleted.why.join("; ")}; the next run with Rebuild tries again`
            : `${write.title}: not rebuilt, as Rebuild would delete what Plaky holds of its own (${deleted.why.join("; ")})`, { asanaItemId: write.asanaItemId });
          renameByHand();
        } else {
          followers = deleted.fresh.subscribedUsers ?? [];
          teams = deleted.fresh.subscribedTeams ?? [];
          parent = asId(deleted.fresh.parent);
        }
      }
      if (existing && rebuild) {
        targets.unsettle(write.asanaItemId);
        let rebuilt = false;
        try {
          await create(write, true, followers, teams);
          rebuilt = true;
        } catch (error) {
          if (isRateLimited(error)) {
            await restoreDeleted(write, textOf(error), followers, teams, parent);
            throw error;
          }
          let replacement: number | null;
          try {
            replacement = await rowCarrying(write.asanaItemId);
          } catch (unread) {
            unknownOutcome(`${label}: replacement outcome unknown (${textOf(error)}) and the board could not be re-read (${textOf(unread)}); the next run settles it`);
            continue;
          }
          if (replacement !== null) {
            remember(write.asanaItemId, replacement);
            const replacementId = replacement;
            await cache(() => store.markCommitted(itemRef(write.asanaItemId), madeCommit(replacementId)));
            emit("info", "item.created", "item created (a rebuild's replacement, found again after its answer was lost)", { asanaItemId: write.asanaItemId, plakyItemId: replacementId });
            result.recreated++;
            continue;
          }
          const why = textOf(error);
          if (isOutcomeUnknown(error)) {
            unknownOutcome(`${label}: replacement outcome unknown (${why}) and no row carries its Asana ID yet; the old row is not put back, the next run settles it`);
            continue;
          }
          const restored = await restoreDeleted(write, why, followers, teams, parent);
          if (restored !== null) {
            remember(write.asanaItemId, restored);
            fail(`${label}: replacement failed (${why}); the old row is back`);
          }
        }
        if (rebuilt) result.recreated++;
      } else if (write.unchanged) {
        result.unchanged++;
      } else if (existing) {
        let wrote = false;
        const steps: RowStep[] = [];
        if (write.moveGroup) {
          const destination = write.groupTitle ? plan.groupIds.get(spellingKey(write.groupTitle)) : undefined;
          steps.push({
            write: (fresh) => {
              if (fresh !== null && (fresh.group ?? null) !== write.existingGroupId) {
                emit("warn", BY_HAND_CODE, `${write.title}: moved in Plaky while the run went on, so it stays there`, { asanaItemId: write.asanaItemId });
                return null;
              }
              if (destination === undefined) throw new SyncSetupError(`item group '${write.groupTitle}' could not be created`);
              return { move: destination };
            },
            sent: async () => {
              await held(write, existing, [], { groupId: destination });
              wrote = true;
              emit("info", "item.moved", `Moved to ${write.groupTitle}`, { asanaItemId: write.asanaItemId, plakyItemId: existing });
            },
          });
        }
        const planned = write.sameFields ? [] : (write.send ?? Object.keys(write.fields).filter((key) => !keptOf(write).has(key)));
        const told = new Set<string>();
        let keys: string[] = [];
        if (planned.length) {
          steps.push({
            write: (fresh) => {
              const freshFields = new Map((fresh?.fields ?? []).map((f) => [f.key, f.value]));
              const since = (key: string): boolean => fresh !== null && hashOf!(key, freshFields.get(key) ?? null) !== hashOf!(key, write.existingFields?.[key] ?? null);
              keys = planned.filter((key) => !since(key));
              for (const key of planned.filter((k) => since(k) && !told.has(k))) {
                told.add(key);
                emit("warn", BY_HAND_CODE, `${write.title}: '${targetByKey.get(key)?.name ?? key}' changed in Plaky while the run went on, so Plaky keeps its value`, { asanaItemId: write.asanaItemId });
              }
              return keys.length ? { fields: Object.fromEntries(keys.map((key) => [key, write.fields[key]])) } : null;
            },
            sent: async () => {
              await held(write, existing, keys);
              wrote = true;
              result.fieldUpdates++;
            },
          });
        }
        if (replacesSubscribers(config, write)) {
          steps.push({
            write: () => ({
              addSubscribers: write.subscriberIds,
              unlisted: () => emit("warn", BY_HAND_CODE, `${write.title}: Plaky's answer for it did not list its followers and teams, so the app added none (Plaky's follower update replaces both lists); add them by hand`, { asanaItemId: write.asanaItemId }),
            }),
            sent: () => {
              wrote = true;
              result.subscribersReplaced++;
            },
          });
        }
        await writeRow(plaky, { space, board, row: existing }, steps, { judged: hashOf !== undefined, send: (request) => send(itemRef(write.asanaItemId), request, () => itemCommit(existing)) });
        if (wrote) {
          result.updated++;
          emit("info", "item.updated", "item updated", { asanaItemId: write.asanaItemId, plakyItemId: existing });
        } else {
          result.unchanged++;
        }
      } else {
        await create(write);
        result.created++;
      }
    } catch (error) {
      if (haltedBy(error, label)) {
        return result;
      }
      if (isOutcomeUnknown(error)) {
        unknownOutcome(`${label}: dispatched, outcome unknown (${textOf(error)})`);
        if (isCreate && !halted.has(stack)) halted.set(stack, 0);
      } else {
        fail(`${label}: ${textOf(error)}`);
      }
    }
  }

  current = null;
  for (const [groupTitle, heldBack] of halted) {
    if (!heldBack) continue;
    const where = groupTitle ? (config.nested ? `under Asana item ${groupTitle}` : `in group '${groupTitle}'`) : "on the board";
    fail(`${heldBack} new item(s) ${where} held back after an unknown outcome, so the next run still lands them in Asana order. Re-run to continue.`);
  }

  const rowFor = (asanaId: string, planned: number | null): number | null => targets.rowFor(asanaId, planned);

  const syncItemComments = async (asanaItemId: string, itemId: number, planned: readonly PlannedComment[], count: number): Promise<boolean> => {
    const record = forRow(plan.written, asanaItemId, itemId);
    const found = new Map<string, [id: number, header: string, content: string]>();
    let total = 0;
    if (count > 0) {
      try {
        for (const top of await plaky.listItemComments(space, board, itemId)) {
          for (const entry of [top, ...(top.replies ?? [])]) {
            if (entry.deleted) continue;
            total++;
            const content = String(entry.content ?? "");
            const marker = markerOf(content);
            if (marker !== null && !found.has(marker[1])) found.set(marker[1], [entry.id, headerOf(content), content]);
          }
        }
      } catch (error) {
        if (haltedBy(error, `comments on Plaky item ${itemId}`)) {
          return false;
        }
        fail(`could not read the comments already on Plaky item ${itemId} (${textOf(error)}); the next run carries them`);
        return true;
      }
    }
    const waiting = new Set<string>();
    let overCap = 0;
    for (const comment of planned) {
      const label = `comment for Asana ${comment.kind} ${comment.asanaId}`;
      if (comment.replyTo !== null && waiting.has(comment.replyTo)) {
        waiting.add(comment.asanaId);
        continue;
      }
      const header = commentHeader(comment);
      const known = found.get(comment.asanaId);
      if (known !== undefined && known[1] === header) continue;
      if (known !== undefined && record !== undefined && record(`__comment:${comment.asanaId}`) !== valueHash(known[2])) {
        emit("warn", BY_HAND_CODE, `${label}: edited in Asana, and changed in Plaky since the app wrote it (or before this version kept a record), so Plaky's comment stays; carry the edit by hand`, { asanaItemId, plakyItemId: itemId });
        continue;
      }
      if (known === undefined && record?.(`__comment:${comment.asanaId}`) !== undefined) {
        emit("warn", BY_HAND_CODE, `${label}: the comment the app wrote was changed or removed in Plaky, so it is not posted again`, { asanaItemId, plakyItemId: itemId });
        continue;
      }
      if (known === undefined && total >= commentCap) {
        overCap++;
        continue;
      }
      let repliesToId: number | undefined;
      if (known === undefined && comment.kind === "reply") {
        const parent = found.get(comment.replyTo ?? "");
        if (parent === undefined) {
          waiting.add(comment.asanaId);
          continue;
        }
        repliesToId = parent[0];
      }
      if (!(await proceed())) return false;
      const ref: EntityRef = { type: "comment", asanaId: comment.asanaId, scope: asanaItemId, occurrence: 0 };
      try {
        if (known !== undefined) {
          const replaced = await writeComment(plaky, { space, board, row: itemId, comment: known[0] }, comment.text, known[2], (request) =>
            send(ref, request, () => ({ plakyId: known[0], plakyParentId: itemId })));
          if (!replaced) {
            emit("warn", BY_HAND_CODE, `${label}: edited in Asana, and changed in Plaky while the run went on, so Plaky's comment stays; carry the edit by hand`, { asanaItemId, plakyItemId: itemId });
            continue;
          }
          result.commentsUpdated++;
          recorded.push({ plakyBoardId: board, subject: asanaItemId, key: `__comment:${comment.asanaId}`, hash: valueHash(comment.text) });
        } else {
          const created = await send(
            ref,
            () => plaky.createItemComment(space, board, itemId, { text: comment.text, ...(repliesToId === undefined ? {} : { repliesToId }) }),
            (c) => ({ plakyId: c.id, plakyParentId: itemId }),
          );
          total++;
          result.commentsCreated++;
          found.set(comment.asanaId, [created.id, header, comment.text]);
          recorded.push({ plakyBoardId: board, subject: asanaItemId, key: `__comment:${comment.asanaId}`, hash: valueHash(comment.text) });
        }
        emit("info", known === undefined ? "comment.created" : "comment.updated", label, { asanaItemId, plakyItemId: itemId });
      } catch (error) {
        if (haltedBy(error, label)) {
          return false;
        }
        if (isOutcomeUnknown(error)) unknownOutcome(`${label}: dispatched, outcome unknown (${textOf(error)})`);
        else fail(`${label}: ${textOf(error)}`);
        waiting.add(comment.asanaId);
      }
    }
    if (overCap) failForGood(`Plaky item ${itemId}: ${overCap} comment(s) not carried; Plaky allows ${commentCap} per item`);
    return true;
  };

  const asLeft = (asanaId: string, entry: { settled?: boolean | undefined }, count: number, planned: number): boolean => entry.settled === true && !targets.created(asanaId) && count === planned;
  for (const [asanaId, wanted] of plan.comments) {
    const itemId = rowFor(asanaId, wanted.plakyItemId);
    if (itemId === null) continue;
    const count = targets.created(asanaId) ? 0 : wanted.commentCount;
    if (asLeft(asanaId, wanted, count, wanted.planned.filter((c) => c.kind === "update").length)) continue;
    current = asanaId;
    if (!(await syncItemComments(asanaId, itemId, wanted.planned, count))) return result;
  }
  current = null;

  const syncItemFiles = async (source: AssetSource, asanaItemId: string, itemId: number, assets: readonly AsanaFile[], count: number): Promise<FilesOutcome> => {
    const present: Set<string>[] = [];
    if (count > 0) {
      try {
        for (const entry of await plaky.listItemFiles(space, board, itemId)) {
          const name = String(entry.name ?? "");
          const keys = new Set([fileKey(name, entry.size)]);
          if (truthy(entry.extension)) keys.add(fileKey(`${name}.${entry.extension}`, entry.size));
          present.push(keys);
        }
      } catch (error) {
        if (haltedBy(error, `files on Plaky item ${itemId}`)) {
          return "rate_limited";
        }
        fail(`could not read the files already on Plaky item ${itemId} (${textOf(error)}); the next run carries them`);
        return "ok";
      }
    }
    const copies = new Map<string, number>();
    for (const wanted of assets) {
      const label = `file '${wanted.name}' on Plaky item ${itemId}`;
      const assetId = wanted.assetId ?? "";
      const occurrence = copies.get(assetId) ?? 0;
      copies.set(assetId, occurrence + 1);
      const ref: EntityRef = { type: "file", asanaId: assetId, scope: asanaItemId, occurrence };
      try {
        const [metaName, size] = plan.assetMeta?.(assetId) ?? (await source.meta(assetId));
        const key = fileKey(metaName, size);
        const byName = fileKey(metaName, null);
        const heldAt = size === null || size === undefined ? present.findIndex((keys) => [...keys].some((k) => k.startsWith(byName))) : present.findIndex((keys) => keys.has(key));
        if (heldAt >= 0) {
          present.splice(heldAt, 1);
          continue;
        }
        if (!(await proceed())) return "stopped";
        const before = store.refusedBefore ? await store.refusedBefore(ref) : null;
        if (before !== null) {
          failForGood(`${label}: Plaky refused it on an earlier run (${before}); upload it by hand`);
          continue;
        }
        const [name, data] = await source.fetch(assetId);
        const uploaded = await send(ref, () => plaky.uploadItemFile(space, board, itemId, { name, data, type: contentType(name) }), (file) => ({ plakyId: file.id, plakyParentId: itemId }));
        if (hashOf) recorded.push({ plakyBoardId: board, subject: asanaItemId, key: `__file:${uploaded.id}`, hash: valueHash(uploaded.id) });
        result.filesUploaded++;
        emit("info", "file.uploaded", label, { asanaItemId, plakyItemId: itemId });
      } catch (error) {
        if (error instanceof FileTooLarge) failForGood(`${label}: ${textOf(error)}; Plaky takes files up to 100 MB each, so this one is kept by hand: save it in the task archive`);
        else if (isFeatureLimit(error)) {
          failForGood(`${label}: ${textOf(error)}; the Plaky plan's limit refused it, so it is kept in the task archive`);
          await cache(() => store.markFailed(ref, `${REFUSED_FOR_GOOD}${textOf(error)}`));
        } else if (isPlakyHttp(error) && PERMANENT_UPLOAD.has(error.status)) {
          failForGood(`${label}: ${textOf(error)}; upload it by hand`);
          await cache(() => store.markFailed(ref, `${REFUSED_FOR_GOOD}${textOf(error)}`));
        } else if (isAsanaRateLimited(error)) {
          failBoard(`files: ${textOf(error)}`);
          return "asana_limit";
        } else if (haltedBy(error, label)) {
          return "rate_limited";
        } else if (isOutcomeUnknown(error)) unknownOutcome(`${label}: dispatched, outcome unknown (${textOf(error)})`);
        else fail(`${label}: ${textOf(error)}`);
      }
    }
    return "ok";
  };

  if (plan.files.size > 0 && fetcher === undefined) {
    fail("files: no downloader was given to applyPlan; none were copied");
  } else if (fetcher !== undefined) {
    const toRead = [...plan.files].filter(([asanaId, held]) => !asLeft(asanaId, held, targets.created(asanaId) ? 0 : held.fileCount, held.assets.length));
    for (const [asanaId, held] of toRead) {
      const itemId = rowFor(asanaId, held.plakyItemId);
      if (itemId === null) continue;
      const count = targets.created(asanaId) ? 0 : held.fileCount;
      current = asanaId;
      const outcome = await syncItemFiles(fetcher, asanaId, itemId, held.assets, count);
      if (outcome === "rate_limited" || outcome === "stopped") return result;
      if (outcome === "asana_limit") break;
    }
    current = null;
  }

  if (options.prune) {
    const kept = new Set(plan.protectedOrphans ?? []);
    for (const [itemId, title, seen] of plan.orphans) {
      if (kept.has(itemId)) {
        note(`orphan '${title}' (${itemId}) kept: it holds values changed in Plaky since the app wrote them`);
        continue;
      }
      if (!(await proceed())) return result;
      try {
        const deleted = await deleteRow(plaky, { space, board, row: itemId }, async (fresh, nested) => {
          const asanaId = asanaIdOf(fresh);
          return [...linkCellsMoved(fresh.fields, seen, linkCells), ...(plan.ownership?.(asanaId, fresh) ?? []), ...(await madeInPlaky(plaky, space, board, fresh, ourFile(asanaId, itemId), ourComment(asanaId, itemId))), ...(await nestedWhy(nested))];
        }, (request) => send(null, request));
        if (deleted.done === "gone") {
          note(`orphan '${title}' (${itemId}) is gone from Plaky already`);
        } else if (deleted.done === "kept") {
          note(`orphan '${title}' (${itemId}) kept: ${deleted.why.join("; ")}; delete it by hand if it should go`);
        } else {
          result.pruned++;
          emit("info", "item.pruned", "orphan deleted", { plakyItemId: itemId });
        }
      } catch (error) {
        if (haltedBy(error, `orphan '${title}' (${itemId})`)) {
          return result;
        }
        if (isOutcomeUnknown(error)) unknownOutcome(`orphan '${title}' (${itemId}): delete dispatched, outcome unknown (${textOf(error)})`);
        else fail(`orphan '${title}' (${itemId}): ${textOf(error)}`);
      }
    }
  }
  return result;
}
