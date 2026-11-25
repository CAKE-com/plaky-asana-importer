import { applyOutcome, settledStatus, verificationDecision, runLiveness } from "./run-state";
import { automaticDecision, nextOccurrence, HOUR_MS, type Schedule, type ScheduleClaim } from "./automatic-state";
export type { Schedule } from "./automatic-state";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { env } from "@/server/env";
import { boardLocks, connections, migrationLogs, migrationRuns, migrations } from "@/db/schema";
import { AsanaClient, DEFAULT_REQUESTS_PER_MINUTE, PAID_REQUESTS_PER_MINUTE, isAsanaRateLimited } from "../clients/asana";
import { PlakyClient } from "../clients/plaky";
import type { PipelineEvent } from "../pipeline/events";
import { ExtractCache, applyStep, planStep, verifyStep, type Deps, type PlanStepResult } from "../pipeline/migration";
import { PROCESS_TOKEN, RUN_HEARTBEAT_MS, boardIdsByName, keysFor, ownRunIds, type Keys, dbLog, finishRun, getMigration, recordAsanaCall, setStatusUnlessOtherRun, startRun, forgetKeys, plakyKeyHeld } from "../pipeline/store";
import { reaches } from "../pipeline/status";
import { migrationBoards } from "@/db/schema";
import { boardItemIds, type ListTrees } from "../pipeline/extract";
import { changesPlan, recordSyncPoints, type ChangesPlan } from "../pipeline/changes";
import { receiptJson, receiptOk, type Receipt } from "../pipeline/verify";
import type { ApplyResult } from "../pipeline/load";
import { ConflictError, PreconditionError } from "../errors";
import { logger, redactString } from "../redact";

export type ResumeClock = { now: () => number; setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
const realResumeClock: ResumeClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
const requestsPerMinute = (paid = false): number => env.ASANA_REQUESTS_PER_MINUTE ?? (paid ? PAID_REQUESTS_PER_MINUTE : DEFAULT_REQUESTS_PER_MINUTE);

const MAX_TIMER_MS = 2 ** 31 - 1;
const timerDelay = (at: number, now: number): number => Math.min(Math.max(0, at - now), MAX_TIMER_MS);

export const RESUME_MARGIN_MS = 5 * 60_000;
export const RESUME_RETRY_MS = 60_000;

export type Clients = { asana: () => AsanaClient; plaky: () => PlakyClient };

export const PLAN_MAX_AGE_MS = 10 * 60_000;

export type Job = {
  migrationId: number; runId: number; controller: AbortController; done: Promise<void>;
  byHand?: boolean;
};

export type HeldPlan = { planned: PlanStepResult; at: number; readAt: number; asana?: AsanaClient | undefined; calls: number };

type Registry = {
  jobs: Map<number, Job>;
  plans: Map<number, HeldPlan>;
  setup: Map<number, string>;
  plakyByKey: Map<string, PlakyClient>;
  itemIds: Map<number, { at: number; boards: Map<string, Promise<Set<string>>>; homes: Map<string, number[]>; lists: ListTrees; selection?: string }>;
  swept?: WeakMap<Db, { at: number; done: Promise<void> }>;
  countWarned?: boolean;
  resumes: Map<number, unknown>;
  schedules: Map<number, unknown>;
  resumeClock?: ResumeClock | undefined;
  walRetry?: unknown;
};
const globalForJobs = globalThis as unknown as { __a2pJobs?: Registry };
function registry(): Registry {
  const r = (globalForJobs.__a2pJobs ??= { jobs: new Map(), plans: new Map(), setup: new Map(), resumes: new Map(), schedules: new Map(), plakyByKey: new Map(), itemIds: new Map() });
  r.setup ??= new Map();
  r.resumes ??= new Map();
  r.schedules ??= new Map();
  r.plakyByKey ??= new Map();
  r.itemIds ??= new Map();
  return r;
}

const clientId = (key: string | null): string => createHash("sha256").update((key ?? process.env.PLAKY_API_KEY ?? "").trim()).digest("hex");

export function plakyFor(key: string | null): PlakyClient {
  const r = registry();
  const id = clientId(key);
  let client = r.plakyByKey.get(id);
  if (!client) {
    client = key ? new PlakyClient({ apiKey: key }) : PlakyClient.fromEnv();
    r.plakyByKey.set(id, client);
  }
  return client;
}
export function countAsanaCall(open: () => Promise<Db> = getDb): Promise<void> {
  const at = Date.now();
  return open().then((db) => recordAsanaCall(db, at)).catch((error: unknown) => {
    const r = registry();
    if (r.countWarned) return;
    r.countWarned = true;
    logger.warn(`an Asana call could not be counted, so "Asana calls today" reads low from now on: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export function clientsWith(keys: Partial<Keys> = {}, { fresh = false }: { fresh?: boolean } = {}): Clients {
  const precondition = <T>(make: () => T): T => {
    try {
      return make();
    } catch (error) {
      if (error instanceof Error && /is not set$/.test(error.message)) {
        throw new PreconditionError("The keys are gone: they last only while this app is running. Enter them again under Connect.");
      }
      throw error;
    }
  };
  return {
    asana: () => precondition(() => (keys.asanaToken ? new AsanaClient({ token: keys.asanaToken, requestsPerMinute: requestsPerMinute(keys.paidAsana), onCall: () => void countAsanaCall() }) : AsanaClient.fromEnv({ requestsPerMinute: requestsPerMinute(keys.paidAsana), onCall: () => void countAsanaCall() }))),
    plaky: () => precondition(() => (!fresh ? plakyFor(keys.plakyKey ?? null) : keys.plakyKey ? new PlakyClient({ apiKey: keys.plakyKey }) : PlakyClient.fromEnv())),
  };
}

export async function clientsFor(db: Db, migrationId: number): Promise<Clients> {
  return clientsWith(await keysFor(db, migrationId));
}

export const RUN_STALE_MS = 3 * RUN_HEARTBEAT_MS;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sweepInterrupted(db: Db, now: number = Date.now()): Promise<void> {
  const r = registry();
  const sweeps = (r.swept ??= new WeakMap());
  const last = sweeps.get(db);
  if (last && now - last.at < RUN_HEARTBEAT_MS) return last.done;
  const done = (async () => {
    const lastLogged = sql`coalesce((SELECT max(${migrationLogs.ts}) FROM ${migrationLogs} WHERE ${migrationLogs.runId} = ${migrationRuns.id}), ${migrationRuns.startedAt})`;
    const open = await db.select({ id: migrationRuns.id, host: migrationRuns.ownerHost, pid: migrationRuns.ownerPid, token: migrationRuns.ownerToken, silent: sql<number>`coalesce(${migrationRuns.heartbeatAt}, ${lastLogged}) < ${now - RUN_STALE_MS}` })
      .from(migrationRuns).where(and(eq(migrationRuns.status, "running"), notInArray(migrationRuns.id, ownRunIds(db))));
    const here = hostname();
    const dead = open.filter((run) => runLiveness(run, { host: here, pid: process.pid, token: PROCESS_TOKEN, alive: processAlive }) !== "live").map((run) => run.id);
    if (dead.length) {
      await db.update(migrationRuns).set({ status: "interrupted", finishedAt: lastLogged }).where(and(eq(migrationRuns.status, "running"), inArray(migrationRuns.id, dead)));
      await db.delete(boardLocks).where(inArray(boardLocks.owner, dead.map(String)));
    }
    await db.update(migrations).set({ status: "interrupted" }).where(and(
      eq(migrations.status, "running"),
      sql`NOT EXISTS (SELECT 1 FROM ${migrationRuns} WHERE ${migrationRuns.migrationId} = ${migrations.id} AND ${migrationRuns.status} = 'running')`,
    ));
  })();
  const swept = { at: now, done };
  sweeps.set(db, swept);
  done.catch(() => {
    if (sweeps.get(db) === swept) sweeps.delete(db);
  });
  return done;
}

export const activeJob = (migrationId: number): Job | undefined => registry().jobs.get(migrationId);

function assertNoSetup(r: Registry, migrationId: number): void {
  const what = r.setup.get(migrationId);
  if (what) throw new ConflictError(`${what} is in progress for this migration; wait for it to finish`);
}

export async function withSetup<T>(migrationId: number, what: string, work: () => Promise<T>): Promise<T> {
  const r = registry();
  if (r.jobs.has(migrationId)) throw new ConflictError("a run is in progress for this migration; wait for it to finish or stop it first");
  assertNoSetup(r, migrationId);
  r.setup.set(migrationId, what);
  try {
    return await work();
  } finally {
    r.setup.delete(migrationId);
  }
}
function evictStale(plans: Registry["plans"]): void {
  for (const [id, held] of plans) if (Date.now() - held.at > PLAN_MAX_AGE_MS) plans.delete(id);
}
export const rememberPlan = (migrationId: number, planned: PlanStepResult, o: { readAt?: number; asana?: AsanaClient } = {}): void => {
  const { plans } = registry();
  evictStale(plans);
  const at = Date.now();
  plans.set(migrationId, { planned, at, readAt: o.readAt ?? at, asana: o.asana, calls: o.asana?.requests ?? 0 });
};
function scanCache(migrationId: number) {
  const { itemIds } = registry();
  for (const held of itemIds.values()) {
    if (Date.now() - held.at <= PLAN_MAX_AGE_MS) continue;
    held.boards = new Map();
    held.lists = new Map();
    held.at = Date.now();
  }
  let held = itemIds.get(migrationId);
  if (!held) itemIds.set(migrationId, (held = { at: Date.now(), boards: new Map(), homes: new Map(), lists: new Map() }));
  return held;
}
export const scanHomes = (migrationId: number): Map<string, number[]> => scanCache(migrationId).homes;
export function scanItemIds(migrationId: number, asana: AsanaClient, selected: readonly string[]): (boardId: string) => Promise<Set<string>> {
  const held = scanCache(migrationId);
  const selection = [...selected].sort().join(",");
  if (held.selection !== selection) Object.assign(held, { boards: new Map(), lists: new Map(), selection });
  const { boards, lists } = held;
  return (boardId) => {
    let ids = boards.get(boardId);
    if (!ids) {
      ids = boardItemIds(asana, boardId, selected, lists);
      boards.set(boardId, ids);
      ids.catch(() => boards.delete(boardId));
    }
    return ids;
  };
}
export const ASANA_WAITING_CODE = "asana.waiting";
function sayLimited(log: (e: PipelineEvent) => void): (seconds: number) => void {
  let said = 0;
  return (seconds) => {
    const until = Date.now() + seconds * 1000;
    if (until <= said + 1000) return;
    said = until;
    log({ level: "info", code: ASANA_WAITING_CODE, message: `Asana's per-minute limit: waiting ${Math.ceil(seconds)} s, then carrying on.`, data: { until } });
  };
}
export const dropPlan = (migrationId: number): void => void registry().plans.delete(migrationId);
export const lastPlan = (migrationId: number): HeldPlan | undefined => {
  const { plans } = registry();
  evictStale(plans);
  return plans.get(migrationId);
};

const sum = (results: readonly { result: ApplyResult }[], pick: (r: ApplyResult) => number): number => results.reduce((n, r) => n + pick(r.result), 0);

function applyCounts(applied: { results: { result: ApplyResult }[]; notStarted: string[] } | null): Record<string, number> {
  if (!applied) return {};
  const r = applied.results;
  return {
    writes: sum(r, (x) => x.writes), created: sum(r, (x) => x.created), updated: sum(r, (x) => x.updated), unchanged: sum(r, (x) => x.unchanged),
    recreated: sum(r, (x) => x.recreated), pruned: sum(r, (x) => x.pruned), groupsCreated: sum(r, (x) => x.groupsCreated),
    groupsReordered: sum(r, (x) => x.groupsReordered), commentsCreated: sum(r, (x) => x.commentsCreated), filesUploaded: sum(r, (x) => x.filesUploaded),
    ambiguous: sum(r, (x) => x.ambiguous.length), failures: sum(r, (x) => x.failures.length), notStarted: applied.notStarted.length,
    rateLimited: r.some((x) => x.result.rateLimited) ? 1 : 0, stopped: r.some((x) => x.result.stopped) ? 1 : 0,
    keyRefused: r.some((x) => x.result.stoppedBy === "key") ? 1 : 0, leaseLost: r.some((x) => x.result.stoppedBy === "lease") ? 1 : 0,
  };
}

export const STOPPED: unique symbol = Symbol("stopped");
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof STOPPED> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.resolve(STOPPED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      work.catch(() => undefined);
      resolve(STOPPED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

function progressLogger(log: (e: PipelineEvent) => void, getPlanned: () => number): { tick: () => void; flush: () => void } {
  let done = 0;
  let lastEmit = 0;
  const emit = (): void => {
    lastEmit = Date.now();
    log({ level: "progress", code: "apply.progress", message: `${done} of ${getPlanned()} write(s) done`, data: { done, planned: getPlanned() } });
  };
  return {
    tick() {
      done++;
      if (Date.now() - lastEmit >= 400) emit();
    },
    flush: emit,
  };
}

export async function startApply(db: Db, migrationId: number, given?: Clients, o: { changes?: ChangesPlan | null; byHand?: boolean; unattended?: boolean;
  resumeTries?: number } = {}): Promise<Job> {
  const changes = o.changes ?? null;
  const since = changes?.since ?? null;
  const r = registry();
  if (r.jobs.has(migrationId)) throw new ConflictError("a run is already in progress for this migration");
  assertNoSetup(r, migrationId);
  const controller = new AbortController();
  const job: Job = { migrationId, runId: 0, controller, done: Promise.resolve(), ...(o.byHand ? { byHand: true } : {}) };
  r.jobs.set(migrationId, job);
  let runId: number | null = null;
  let log: (e: PipelineEvent) => void;
  let flush: () => Promise<void>;
  let deps: Deps;
  let clients: Clients;
  let boardNames: Map<string, string>;
  try {
    await sweepInterrupted(db);
    clients = given ?? await clientsFor(db, migrationId);
    const asana = clients.asana();
    const plaky = clients.plaky();
    runId = await startRun(db, migrationId, "apply");
    const boardRows = await db.select().from(migrationBoards).where(eq(migrationBoards.migrationId, migrationId));
    boardNames = new Map(boardRows.map((b) => [b.asanaBoardId, b.asanaBoardName]));
    const boardIds = boardIdsByName(boardRows);
    ({ log, flush } = dbLog(db, runId, boardIds));
    deps = { db, migrationId, asana, plaky, log, signal: controller.signal };
    asana.stopOn?.(controller.signal);
    asana.onLimited = sayLimited(log);
  } catch (error) {
    r.jobs.delete(migrationId);
    if (runId !== null) await finishRun(db, runId, "failed").catch(() => undefined);
    throw error;
  }
  job.runId = runId;
  const held = r.plans.get(migrationId);
  r.plans.delete(migrationId);
  const cached = !since && held && Date.now() - held.at <= PLAN_MAX_AGE_MS ? held : undefined;
  if (cached?.asana) {
    cached.asana.onLimited = deps.asana.onLimited;
    cached.asana.rateLimited = false;
    cached.asana.stopOn?.(controller.signal);
  }
  const readAt = cached ? cached.readAt : Date.now();
  const asanaLimited = (): boolean => deps.asana.rateLimited || (cached?.asana?.rateLimited ?? false);
  const asanaCalls = (): number => deps.asana.requests + (cached?.asana ? cached.asana.requests - cached.calls : 0);
  const resumeTries = (): number => {
    const c = counts ?? {};
    const landed = (c.created ?? 0) + (c.updated ?? 0) + (c.recreated ?? 0) + (c.pruned ?? 0) + (c.groupsCreated ?? 0) + (c.groupsReordered ?? 0) + (c.commentsCreated ?? 0) + (c.filesUploaded ?? 0);
    return landed > 0 ? 0 : (o.resumeTries ?? 0);
  };
  let planned = 0;
  const progress = progressLogger(log, () => planned);
  const finalRunId = runId;
  let counts: Record<string, number> | null = null;
  let abandoned: Promise<void> | null = null;
  job.done = (async () => {
    try {
      const full = (changes?.full ?? []).map((b) => boardNames.get(b) ?? b);
      log({
        level: "info", code: "run.started",
        message: changes ? `Run started: Asana items changed since ${since}${full.length ? `; read in full: ${full.join(", ")}` : ""}.` : "Run started.",
        data: { since, readAt: new Date(readAt).toISOString(), ...(changes ? { from: Object.fromEntries(changes.from) } : {}) },
      });
      if (o.unattended) log({ level: "info", code: "run.unattended", message: "Started by itself, on schedule or after Asana's limit. Nothing is deleted in this run: prune and rebuild are off." });
      const run = await applyStep(deps, {
        ...(o.unattended ? { unattended: true } : {}),
        owner: String(runId),
        ...(cached ? { cache: cached.planned.cache } : changes ? { cache: new ExtractCache(deps, changes.from), since: changes.from } : {}),
        progress: progress.tick,
        confirm: (p) => {
          planned = p.plannedWrites;
          progress.flush();
          return true;
        },
      });
      progress.flush();
      counts = applyCounts(run.applied);
      let limited = asanaLimited();
      for (const f of run.planned.failures) log({ level: "error", code: "run.board_failed", message: f });
      let status = applyOutcome({ applied: run.applied !== null, aborted: controller.signal.aborted, asanaLimited: limited, counts, planningFailures: run.planned.failures.length });
      const verification = verificationDecision(run.applied !== null, Boolean(since), limited, status);
      let receipt: Record<string, unknown> | null = null;
      let report: Receipt | null = null;
      if (verification === "wait-for-asana") {
        if (status === "rate_limited") await waitForAsanaReset(db, migrationId, since, log, given, resumeTries());
      } else if (verification === "skip-changes") {
        log({ level: "info", code: "verify.skipped", message: "Changes-only run: not verified. Use Check now for a full check." });
      } else if (verification === "verify") {
        log({ level: "info", code: "verify.started", message: "Verifying against Asana." });
        const verifying = verifyStep(deps, { cache: run.planned.cache });
        const verified = await untilAborted(verifying, controller.signal);
        if (verified === STOPPED) {
          abandoned = verifying.then(() => undefined, () => undefined);
          status = "interrupted";
          log({ level: "warn", code: "verify.stopped", message: "Stopped before verification finished; no receipt for this run." });
        } else if (asanaLimited()) {
          limited = true;
          status = "rate_limited";
          await waitForAsanaReset(db, migrationId, since, log, given, resumeTries());
        } else {
          report = verified;
          receipt = receiptJson(verified);
          log({ level: receiptOk(verified) ? "info" : "error", code: "verify.done", message: receiptOk(verified) ? "Verification OK." : "Verification found a shortfall." });
          if (!receiptOk(verified) && status === "succeeded") status = "failed";
        }
      }
      if (run.applied) await recordSyncPoints(db, migrationId, run.applied, report, readAt, run.planned.cache instanceof ExtractCache ? run.planned.cache.tokens : new Map());
      await setStatusUnlessOtherRun(db, migrationId, settledStatus(status), finalRunId);
      log({ level: "info", code: "run.finished", message: `Run ${status}.`, data: { status } });
      await flush();
      await finishRun(db, finalRunId, status, { plannedWrites: planned, counts: { ...counts, asanaCalls: asanaCalls() }, ...(receipt ? { receipt } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const limited = isAsanaRateLimited(error) || asanaLimited();
      log({ level: limited ? "warn" : "error", code: limited ? "asana.daily_limit_hit" : "run.crashed", message: message.slice(0, 500) });
      if (limited) await waitForAsanaReset(db, migrationId, since, log, given, resumeTries()).catch(() => undefined);
      log({ level: "info", code: "run.finished", message: `Run ${limited ? "rate_limited" : "failed"}.`, data: { status: limited ? "rate_limited" : "failed" } });
      await flush();
      await finishRun(db, finalRunId, limited ? "rate_limited" : "failed", { plannedWrites: planned, counts: { ...(counts ?? {}), asanaCalls: asanaCalls() } }).catch(() => undefined);
      const refused = error instanceof Error && error.name === "BoardLockedError";
      if (!refused) await setStatusUnlessOtherRun(db, migrationId, limited ? "interrupted" : "failed", finalRunId).catch(() => undefined);
    } finally {
      if (abandoned) await abandoned;
      r.jobs.delete(migrationId);
    }
  })();
  return job;
}

export function stopJob(migrationId: number): boolean {
  const job = registry().jobs.get(migrationId);
  if (!job) return false;
  job.controller.abort();
  return true;
}

export function dryRun(db: Db, migrationId: number, clients?: Clients): Promise<{ planned: PlanStepResult; runId: number; asanaCalls: number }> {
  return withSetup(migrationId, "a dry run", () => planHeld(db, migrationId, clients));
}

async function planHeld(db: Db, migrationId: number, given?: Clients): Promise<{ planned: PlanStepResult; runId: number; asanaCalls: number }> {
  await sweepInterrupted(db);
  const clients = given ?? await clientsFor(db, migrationId);
  const asana = clients.asana();
  const plaky = clients.plaky();
  const runId = await startRun(db, migrationId, "plan");
  const { log, flush } = dbLog(db, runId);
  try {
    const deps: Deps = { db, migrationId, asana, plaky, log };
    const readAt = Date.now();
    const planned = await planStep(deps, { cache: new ExtractCache(deps) });
    if (reaches((await getMigration(db, migrationId)).status, "planned")) await setStatusUnlessOtherRun(db, migrationId, "planned", runId);
    rememberPlan(migrationId, planned, { readAt, asana });
    await flush();
    return { planned, runId, asanaCalls: asana.requests };
  } catch (error) {
    await flush();
    await finishRun(db, runId, "failed", { counts: { asanaCalls: asana.requests } }).catch(() => undefined);
    throw error;
  }
}

export async function finishPlanRun(db: Db, runId: number, plannedWrites: number, summary: unknown, asanaCalls = 0): Promise<void> {
  await finishRun(db, runId, "succeeded", { plannedWrites, receipt: summary, counts: { asanaCalls } });
}

const resumeClock = (): ResumeClock => registry().resumeClock ?? realResumeClock;
export const setResumeClock = (clock: ResumeClock | undefined): void => void (registry().resumeClock = clock);

function nextTry(now: number): number {
  return now + 65_000;
}

const MAX_RESUMES = 5;

async function waitForAsanaReset(db: Db, migrationId: number, since: string | null, log: (e: PipelineEvent) => void, clients: Clients | undefined, tries = 0): Promise<void> {
  if (tries >= MAX_RESUMES) {
    log({
      level: "error", code: "asana.daily_limit",
      message: `Asana kept answering 429 through ${MAX_RESUMES} restarts that wrote nothing, so nothing is set to restart it. Move again later.`,
      data: { tries, since },
    });
    return;
  }
  const reset = nextTry(resumeClock().now());
  const at = reset + RESUME_MARGIN_MS;
  await db.update(migrations).set({ resume: { at, since, reset, tries: tries + 1 } }).where(eq(migrations.id, migrationId));
  armResume(db, migrationId, at, clients);
  log({
    level: "warn", code: "asana.daily_limit",
    message: `Asana kept answering 429. Waiting until ${new Date(reset).toISOString()}; the run then resumes on its own${tries ? ` (restart ${tries + 1} of ${MAX_RESUMES})` : ""}.`,
    data: { resumeAt: at, since, tries: tries + 1 },
  });
}

export const resumeArmed = (migrationId: number): boolean => registry().resumes.has(migrationId);

export function armResume(db: Db, migrationId: number, at: number, clients?: Clients): void {
  const r = registry();
  const clock = resumeClock();
  if (r.resumes.has(migrationId)) clock.clearTimeout(r.resumes.get(migrationId));
  const handle = clock.setTimeout(() => {
    r.resumes.delete(migrationId);
    void fireResume(db, migrationId, clients).catch(() => undefined);
  }, timerDelay(at, clock.now()));
  (handle as { unref?: () => void } | null)?.unref?.();
  r.resumes.set(migrationId, handle);
}

type Resume = NonNullable<(typeof migrations.$inferSelect)["resume"]>;
const stillAt = (migrationId: number, at: number) => and(eq(migrations.id, migrationId), sql`json_extract(${migrations.resume}, '$.at') = ${at}`);

async function retryLater(db: Db, migrationId: number, resume: Resume, from: { at: number } | null, now: number, clients: Clients | undefined): Promise<void> {
  if (registry().jobs.get(migrationId)?.byHand) {
    await cancelResume(db, migrationId);
    return;
  }
  const at = now + RESUME_RETRY_MS;
  const moved = await db.update(migrations).set({ resume: { ...resume, at } })
    .where(from ? stillAt(migrationId, from.at) : and(eq(migrations.id, migrationId), isNull(migrations.resume))).returning({ id: migrations.id });
  if (moved.length) armResume(db, migrationId, at, clients);
}

async function fireResume(db: Db, migrationId: number, clients?: Clients): Promise<Job | null> {
  const row = (await db.select({ resume: migrations.resume }).from(migrations).where(eq(migrations.id, migrationId)).limit(1))[0];
  const resume = row?.resume ?? null;
  if (!resume) return null;
  const now = resumeClock().now();
  const r = registry();
  const decision = automaticDecision(resume, now, r.jobs.has(migrationId) || r.setup.has(migrationId));
  if (decision.state === "waiting") {
    armResume(db, migrationId, decision.at, clients);
    return null;
  }
  if (decision.state === "busy") {
    await retryLater(db, migrationId, resume, resume, now, clients);
    return null;
  }
  const claimed = await db.update(migrations).set({ resume: null }).where(stillAt(migrationId, resume.at)).returning({ id: migrations.id });
  if (!claimed.length) return null;
  try {
    const changes = resume.since === null ? null : await changesPlan(db, migrationId).catch((error: unknown) => {
      if (error instanceof PreconditionError) return null;
      throw error;
    });
    return await startApply(db, migrationId, clients, { changes, unattended: true, resumeTries: resume.tries ?? 1 });
  } catch (error) {
    if (error instanceof ConflictError) {
      await retryLater(db, migrationId, resume, null, now, clients);
      return null;
    }
    await recordResumeFailure(db, migrationId, error).catch(() => undefined);
    throw error;
  }
}

async function recordResumeFailure(db: Db, migrationId: number, error: unknown, what = "resume", code = "resume.failed", hint = "Press Move to run it by hand once that is fixed."): Promise<void> {
  const why = redactString(error instanceof Error ? error.message : String(error)).slice(0, 500);
  logger.error(`migration ${migrationId}: the scheduled ${what} could not start: ${why}`);
  const runId = await startRun(db, migrationId, "apply");
  const { log, flush } = dbLog(db, runId);
  log({ level: "error", code, message: `The automatic ${what} could not start: ${why}. ${hint}` });
  await flush();
  await finishRun(db, runId, "failed");
  await setStatusUnlessOtherRun(db, migrationId, "failed", runId);
}

export async function cancelResume(db: Db, migrationId: number, onlyAt?: number): Promise<boolean> {
  const r = registry();
  const cleared = await db.update(migrations).set({ resume: null })
    .where(onlyAt === undefined ? and(eq(migrations.id, migrationId), isNotNull(migrations.resume)) : stillAt(migrationId, onlyAt)).returning({ id: migrations.id });
  if (cleared.length && r.resumes.has(migrationId)) {
    resumeClock().clearTimeout(r.resumes.get(migrationId));
    r.resumes.delete(migrationId);
  }
  return cleared.length > 0;
}

async function hasKeys(db: Db, migrationId: number, given?: Clients): Promise<boolean> {
  if (given) return true;
  try {
    const clients = await clientsFor(db, migrationId);
    clients.asana();
    clients.plaky();
    return true;
  } catch (error) {
    if (error instanceof PreconditionError) return false;
    throw error;
  }
}

export async function rearmResumes(db: Db, clients?: Clients, connectionId?: number): Promise<number> {
  const rows = await db.select({ id: migrations.id, resume: migrations.resume }).from(migrations)
    .where(and(isNotNull(migrations.resume), connectionId === undefined ? undefined : eq(migrations.connectionId, connectionId)));
  let armed = 0;
  for (const row of rows) {
    if (!row.resume || !(await hasKeys(db, row.id, clients))) continue;
    armResume(db, row.id, row.resume.at, clients);
    armed++;
  }
  return armed;
}

const scheduleStillAt = (migrationId: number, at: number) => and(eq(migrations.id, migrationId), sql`json_extract(${migrations.schedule}, '$.at') = ${at}`);

async function writeSchedule(db: Db, migrationId: number, next: Schedule | null, claim?: ScheduleClaim): Promise<boolean> {
  const written = await db.update(migrations).set({ schedule: next })
    .where(claim === undefined ? eq(migrations.id, migrationId) : claim === null ? and(eq(migrations.id, migrationId), isNull(migrations.schedule)) : scheduleStillAt(migrationId, claim.at)).returning({ id: migrations.id });
  return written.length > 0;
}

function armSchedule(db: Db, migrationId: number, at: number, clients?: Clients): void {
  const r = registry();
  const clock = resumeClock();
  if (r.schedules.has(migrationId)) clock.clearTimeout(r.schedules.get(migrationId));
  const handle = clock.setTimeout(() => {
    r.schedules.delete(migrationId);
    void fireSchedule(db, migrationId, clients).catch(() => undefined);
  }, timerDelay(at, clock.now()));
  (handle as { unref?: () => void } | null)?.unref?.();
  r.schedules.set(migrationId, handle);
}

export async function setSchedule(db: Db, migrationId: number, schedule: Schedule, clients?: Clients): Promise<void> {
  if (!clients) {
    const now = await clientsFor(db, migrationId);
    now.asana();
    now.plaky();
  }
  await writeSchedule(db, migrationId, schedule);
  armSchedule(db, migrationId, schedule.at, clients);
}

export async function cancelSchedule(db: Db, migrationId: number): Promise<boolean> {
  const r = registry();
  if (r.schedules.has(migrationId)) {
    resumeClock().clearTimeout(r.schedules.get(migrationId));
    r.schedules.delete(migrationId);
  }
  const cleared = await db.update(migrations).set({ schedule: null }).where(and(eq(migrations.id, migrationId), isNotNull(migrations.schedule))).returning({ id: migrations.id });
  return cleared.length > 0;
}

export async function fireSchedule(db: Db, migrationId: number, clients?: Clients): Promise<Job | null> {
  const row = (await db.select({ schedule: migrations.schedule, resume: migrations.resume }).from(migrations).where(eq(migrations.id, migrationId)).limit(1))[0];
  const schedule = row?.schedule;
  if (!row || !schedule) return null;
  const now = resumeClock().now();
  const r = registry();
  const decision = automaticDecision(schedule, now, r.jobs.has(migrationId) || r.setup.has(migrationId) || Boolean(row.resume));
  if (decision.state === "waiting") {
    armSchedule(db, migrationId, decision.at, clients);
    return null;
  }
  const later = async (from: ScheduleClaim, base: Schedule): Promise<void> => {
    const at = Math.max(now, row.resume?.at ?? 0) + RESUME_RETRY_MS;
    if (await writeSchedule(db, migrationId, { ...base, at }, from)) armSchedule(db, migrationId, at, clients);
  };
  if (decision.state === "busy") {
    await later({ at: schedule.at }, schedule);
    return null;
  }
  let changes: ChangesPlan;
  try {
    changes = await changesPlan(db, migrationId);
  } catch (error) {
    if (!(error instanceof PreconditionError)) throw error;
    const waitUntil = nextOccurrence(schedule, now) ?? now + HOUR_MS;
    if (await writeSchedule(db, migrationId, { ...schedule, at: waitUntil }, schedule)) armSchedule(db, migrationId, waitUntil, clients);
    return null;
  }
  const nextAt = nextOccurrence(schedule, now);
  const next = nextAt === null ? null : { ...schedule, at: nextAt };
  if (!(await writeSchedule(db, migrationId, next, schedule))) return null;
  if (nextAt !== null) armSchedule(db, migrationId, nextAt, clients);
  try {
    return await startApply(db, migrationId, clients, { changes, unattended: true });
  } catch (error) {
    if (error instanceof ConflictError) {
      await later(next, schedule);
      return null;
    }
    await recordResumeFailure(db, migrationId, error, "Import changes", "schedule.failed", "Open the sheet to fix it, then use Import changes.").catch(() => undefined);
    throw error;
  }
}

export async function rearmSchedules(db: Db, clients?: Clients, connectionId?: number): Promise<number> {
  const rows = await db.select({ id: migrations.id, schedule: migrations.schedule }).from(migrations)
    .where(and(isNotNull(migrations.schedule), connectionId === undefined ? undefined : eq(migrations.connectionId, connectionId)));
  let armed = 0;
  for (const row of rows) {
    if (!row.schedule || !(await hasKeys(db, row.id, clients))) continue;
    armSchedule(db, row.id, row.schedule.at, clients);
    armed++;
  }
  return armed;
}

export async function forgetMigration(db: Db, migrationId: number): Promise<void> {
  await withSetup(migrationId, "erasing", async () => {
    await cancelResume(db, migrationId);
    await cancelSchedule(db, migrationId);
    for (const timers of [registry().resumes, registry().schedules]) {
      const handle = timers.get(migrationId);
      if (handle !== undefined) resumeClock().clearTimeout(handle);
      timers.delete(migrationId);
    }
    registry().plans.delete(migrationId);
    registry().itemIds.delete(migrationId);
    const row = (await db.select({ connectionId: migrations.connectionId }).from(migrations).where(eq(migrations.id, migrationId)).limit(1))[0];
    if (!row) return;
    const { plakyKey } = await keysFor(db, migrationId);
    await db.delete(boardLocks).where(inArray(boardLocks.owner, db.select({ owner: sql<string>`CAST(${migrationRuns.id} AS TEXT)` }).from(migrationRuns).where(eq(migrationRuns.migrationId, migrationId))));
    const others = await db.select({ id: migrations.id }).from(migrations).where(and(eq(migrations.connectionId, row.connectionId), ne(migrations.id, migrationId))).limit(1);
    if (others.length) await db.delete(migrations).where(eq(migrations.id, migrationId));
    else {
      forgetKeys(row.connectionId);
      await db.delete(connections).where(eq(connections.id, row.connectionId));
    }
    if (plakyKey && !plakyKeyHeld(plakyKey)) registry().plakyByKey.delete(clientId(plakyKey));
  });
  try {
    await db.$client.execute("VACUUM");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    logger.warn(`migration ${migrationId}: erased; compacting the database file failed (${typeof code === "string" ? code : error instanceof Error ? error.name : "error"}), and is done again at the next erase`);
  }
  await emptyWal(db, migrationId);
}

const WAL_RETRY_MS = 60_000;

async function emptyWal(db: Db, migrationId: number): Promise<void> {
  const r = registry();
  let busy: boolean;
  try {
    const row = (await db.$client.execute("PRAGMA wal_checkpoint(TRUNCATE)")).rows[0];
    busy = Number(row?.[0] ?? 0) !== 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    logger.warn(`migration ${migrationId}: erased; emptying the write-ahead log failed (${typeof code === "string" ? code : error instanceof Error ? error.name : "error"})`);
    busy = true;
  }
  if (!busy || r.walRetry !== undefined) return;
  logger.warn(`migration ${migrationId}: erased, but another program has the database file open, so its write-ahead log still holds the erased pages; tried again every minute until it lets go`);
  const clock = resumeClock();
  const handle = clock.setTimeout(() => {
    r.walRetry = undefined;
    void emptyWal(db, migrationId);
  }, WAL_RETRY_MS);
  (handle as { unref?: () => void } | null)?.unref?.();
  r.walRetry = handle;
}
