"use client";

import { ArchiveDownload } from "./archive-download";
import { namedConfirmation } from "@/lib/confirmation-state";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { use, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { emptyPlanRow, emptyReceiptRow } from "@/lib/empty-rows";
import { handoffReport } from "@/lib/handoff-report";
import { readinessState } from "@/lib/readiness-state";
import { outsideTheMove, receiptDownload } from "@/lib/outside";
import { EventBuffer, streamStats, type Stream, type StreamEvent } from "@/lib/stream-stats";
import { COUNT_LABEL, runKind, runMode, runStatus } from "@/lib/labels";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import type { RunEvent } from "@/server/trpc/routers/run";
import { Block, Cell, clock, Danger, Explain, fieldClass, Go, Grid, Mark, Note, Plain, plural, Problem, Progress, Quiet, Row, saveFile, Status, statusRefetchMs, useMigrationId } from "./bits";
import { LinkTable } from "./link-table";
import { readAgainOn, runKey } from "./queries";
import { heldSentence } from "./move-section";
import { TOOLS } from "./migration-sheet";
import { VirtualLog } from "./virtual-log";

export function ToolsNav({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pathname = usePathname();
  const current = TOOLS.find(([slug]) => pathname.endsWith(`/${slug}`))?.[1] ?? null;
  return (
    <>
      <nav aria-label="Tools" className="flex flex-wrap print:hidden items-center gap-x-4 gap-y-1 pb-4 text-[15px]">
        <Link prefetch={false} href={`/migrations/${id}`}>← Back to the sheet</Link>
        <span className="text-cake-muted">·</span>
        {TOOLS.map(([slug, label]) => (
          <Link key={slug} prefetch={false} href={`/migrations/${id}/${slug}`} aria-current={pathname.endsWith(`/${slug}`) ? "page" : undefined} className={pathname.endsWith(`/${slug}`) ? "font-medium text-cake-ink no-underline" : undefined}>{label}</Link>
        ))}
      </nav>
      {current ? <h2 className="pb-3 text-xl font-medium">{current}</h2> : null}
    </>
  );
}

const when = (ms: number | string): string => clock(typeof ms === "string" ? Date.parse(ms) : ms);

const writesLine = (planned: number): string => `${plural(planned, "planned change")}.`;

function duration(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const SHOWN = ["writes", "created", "updated", "unchanged", "failures", "ambiguous", "deletedItems", "deletedGroups"] as const;

export function RunHistory({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  const trpc = useTRPC();
  const history = useQuery(trpc.run.history.queryOptions({ migrationId }));
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Block>
      <Problem error={history.error} title="Could not read the runs" />
      {history.isPending ? <Note>Reading the runs…</Note> : null}
      {history.data && !history.data.length ? <Note>No runs yet.</Note> : null}
      {history.data?.length ? (
        <Grid head={["#", "Kind", "Mode", "Status", "Counts", "Asana calls", "Started", "Took"]} align={["left", "left", "left", "left", "left", "right", "left", "right"]} testId="runs">
          {history.data.map((r) => (
            <Row key={r.id}>
              <Cell><button type="button" className="text-left text-cake-brand-550 underline underline-offset-3" aria-expanded={open === r.id} data-testid={`run-${r.id}`} onClick={() => setOpen(open === r.id ? null : r.id)}>{r.id}</button></Cell>
              <Cell>{runKind(r.kind)}</Cell>
              <Cell>{r.mode ? runMode(r.mode) : "—"}{r.since ? <span className="block text-sm text-cake-muted">since {when(r.since)}</span> : null}</Cell>
              <Cell><Status kind={r.status === "succeeded" ? "done" : r.status === "failed" ? "flag" : r.status === "running" ? "now" : "next"}>{runStatus(r.status)}</Status></Cell>
              <Cell className="text-sm">{SHOWN.filter((k) => r.counts?.[k]).map((k) => `${r.counts![k]} ${COUNT_LABEL[k] ?? k}`).join(", ") || (r.plannedWrites !== null ? `planned ${r.plannedWrites}` : "—")}</Cell>
              <Cell right>{r.asanaCalls ?? "—"}</Cell>
              <Cell className="text-sm">{when(r.startedAt)}</Cell>
              <Cell right>{r.status === "running" ? "running" : duration(r.durationMs)}</Cell>
            </Row>
          ))}
        </Grid>
      ) : null}
      {open !== null ? <RunDetails key={open} migrationId={migrationId} runId={open} /> : null}
    </Block>
  );
}

function Problems({ items, truncated }: { items: { id: number; level: string; board: string | null; boardUrl: string | null; asanaItemUrl: string | null; message: string }[]; truncated: boolean }) {
  if (!items.length) return <Note>None.</Note>;
  return (
    <ul className="flex flex-col gap-2" data-testid="problems">
      {items.map((p) => (
        <li key={p.id} className="flex flex-col gap-1">
          <span className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><span>{p.board ? <strong>{p.board}: </strong> : null}<Explain text={`${p.level === "error" ? "" : "outcome unknown: "}${p.message}`} /></span></span>
          <span className="ml-6 flex flex-wrap gap-4 text-[15px]">
            {p.asanaItemUrl ? <a href={p.asanaItemUrl} target="_blank" rel="noreferrer" data-testid="asana-item-link">Open in Asana</a> : null}
            {p.boardUrl ? <a href={p.boardUrl} target="_blank" rel="noreferrer">Open the board in Plaky</a> : null}
          </span>
        </li>
      ))}
      {truncated ? <li className="text-sm text-cake-muted">and more: the first {items.length} are shown.</li> : null}
    </ul>
  );
}

function RunDetails({ migrationId, runId }: { migrationId: number; runId: number }) {
  const trpc = useTRPC();
  const problems = useQuery(trpc.run.problems.queryOptions({ migrationId, runId }));
  const receipt = useQuery(trpc.run.receipt.queryOptions({ migrationId, runId }));
  const r = receipt.data;
  return (
    <div className="flex flex-col gap-3 border-t border-cake-line pt-4" data-testid="run-details">
      <h4 className="text-[15px] font-semibold">Run {runId}{r ? ` (${runKind(r.kind)})` : ""}</h4>
      <Problem error={problems.error} title="Could not read the run's problems" />
      <Problem error={receipt.error} title="Could not read the run's receipt" />
      <div className="flex flex-col gap-2" data-testid="run-problems">
        <span className="text-sm text-cake-muted">Problems ({problems.data?.items.length ?? 0}{problems.data?.truncated ? "+" : ""})</span>
        {problems.data ? <Problems items={problems.data.items} truncated={problems.data.truncated} /> : null}
      </div>
      <div className="flex flex-col gap-2" data-testid="run-receipt">
        <span className="text-sm text-cake-muted">Receipt</span>
        {r?.receipt ? (
          <>
            <p>{r.receipt.ok ? <Status kind="done">Complete</Status> : <Status kind="flag"><strong>Incomplete</strong></Status>} · {r.receipt.matched} of {plural(r.receipt.asana_items, "Asana item")} present in Plaky.</p>
            <Grid head={["Board", "In Asana", "In Plaky", "Matched", ""]} align={["left", "right", "right", "right", "left"]}>
              {r.receipt.boards.filter((b) => !emptyReceiptRow(b)).map((b) => (
                <Row key={b.asana_board_id}>
                  <Cell>{b.name}</Cell><Cell right>{b.asana_items}</Cell><Cell right>{b.plaky_items}</Cell><Cell right>{b.matched}</Cell>
                  <Cell>{b.complete ? <Status kind="done">Match</Status> : <Status kind="flag"><strong>{b.missing.length ? `${b.missing.length} not moved` : b.extra.length ? `${b.extra.length} extra in Plaky` : b.differing.length ? `${b.differing.length} differ` : "Short"}</strong></Status>}</Cell>
                </Row>
              ))}
            </Grid>
            {r.receipt.failures.map((f, i) => <div key={`${i}:${f}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={`Could not verify ${f}`} /></div></div>)}
            {r.receipt.unmatched_users.map((u, i) => <p key={`${i}:${u}`} className="flex items-start gap-2"><Mark kind="flag" /><span>Assignment not carried: {u}</span></p>)}
          </>
        ) : r?.plan ? (
          <>
            <p>Dry run: {writesLine(r.plan.plannedWrites)}</p>
            <Grid head={["Board", "Create", "Update", "Unchanged"]} align={["left", "right", "right", "right"]}>
              {r.plan.boards.filter((b) => !emptyPlanRow(b)).map((b) => <Row key={b.asanaBoardId}><Cell>{b.name}</Cell><Cell right>{b.creates}</Cell><Cell right>{b.updates}</Cell><Cell right>{b.unchanged}</Cell></Row>)}
            </Grid>
            {r.plan.failures.map((f, i) => <div key={`${i}:${f}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={`Cannot plan ${f}`} /></div></div>)}
          </>
        ) : r ? <Note>This run left no receipt.</Note> : null}
      </div>
    </div>
  );
}

function bufferedStream<E extends StreamEvent>() {
  const buffer = new EventBuffer<E>();
  let stream: Stream<E> = { events: [], received: 0, duplicates: 0 };
  return {
    push: (event: E): void => buffer.push(event),
    get: (): Stream<E> => stream,
    subscribe(changed: () => void): () => void {
      const timer = setInterval(() => {
        const batch = buffer.drain();
        if (!batch.length && stream.received === buffer.received) return;
        stream = { events: stream.events.concat(batch), received: buffer.received, duplicates: buffer.duplicates };
        changed();
      }, 250);
      return () => clearInterval(timer);
    },
  };
}

export function LiveLog({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const status = useQuery({ ...trpc.run.status.queryOptions({ migrationId }), refetchInterval: (q) => statusRefetchMs(q.state.data), refetchOnWindowFocus: true });
  const start = useMutation(trpc.run.start.mutationOptions({ onSuccess: () => void status.refetch() }));
  const stop = useMutation(trpc.run.stop.mutationOptions({ onSuccess: () => void status.refetch() }));
  const cancelResume = useMutation(trpc.run.cancelResume.mutationOptions({ onSuccess: () => void status.refetch() }));
  const active = status.data?.active === true;
  const [ends, setEnds] = useState({ active, count: 0 });
  if (ends.active !== active) setEnds({ active, count: ends.count + (ends.active ? 1 : 0) });
  const problems = useQuery({ ...readAgainOn(trpc.run.problems.queryOptions({ migrationId }), ends.count, queryClient), refetchInterval: active ? 2000 : false });

  const [log] = useState(() => bufferedStream<RunEvent>());
  const stream = useSyncExternalStore(log.subscribe, log.get, log.get);
  const onData = useCallback((payload: unknown) => log.push(((payload as { data?: RunEvent }).data ?? payload) as RunEvent), [log]);
  const sub = useSubscription(trpc.run.events.subscriptionOptions({ migrationId }, { onData }));

  const stats = useMemo(() => streamStats(stream), [stream]);
  const s = status.data;
  const done = s?.progress?.done ?? 0;
  const planned = s?.progress?.planned ?? 0;
  const currentRun = s?.run?.id ?? null;
  const perBoard = useMemo(() => {
    const m = new Map<string, { events: number; problems: number }>();
    for (const e of stream.events) {
      if (!e.board || e.runId !== currentRun) continue;
      const cur = m.get(e.board) ?? { events: 0, problems: 0 };
      cur.events++;
      if (e.level === "error" || e.level === "ambiguous") cur.problems++;
      m.set(e.board, cur);
    }
    return m;
  }, [stream, currentRun]);

  return (
    <>
      <Block>
        <div className="flex flex-wrap items-center gap-4">
          <Go onClick={() => start.mutate({ migrationId })} disabled={start.isPending || active}>{s?.run ? "Run again" : "Start run"}</Go>
          <Plain onClick={() => stop.mutate({ migrationId })} disabled={!active || s?.elsewhere || stop.isPending} title={s?.elsewhere ? "Started by another copy of this app: stop it there." : undefined}>Stop after this write</Plain>
          <span role="status" data-testid="run-status">{active ? <Status kind="now">running</Status> : s?.waiting ? <Status kind="now">waiting for Asana</Status> : <Status kind={s?.run?.status === "succeeded" ? "done" : s?.run ? "flag" : "next"}>{s?.run ? runStatus(s.run.status) : "not started"}</Status>}</span>
        </div>
        {s?.waiting && !active ? (
          <p className="flex items-start gap-2" data-testid="asana-wait"><Mark kind="now" /><span>
            Paused at Asana’s per-minute limit until {clock(s.waiting.reset)}. {s.waiting.armed ? `The run resumes on its own at ${clock(s.waiting.resumeAt)}` : "It resumes once the keys are entered again under Connect"}; everything written so far is kept.{" "}
            <Quiet onClick={() => cancelResume.mutate({ migrationId })} disabled={cancelResume.isPending}>Don’t continue on its own</Quiet>
          </span></p>
        ) : null}
        <Problem error={start.error} title="Could not start the run" />
        <Problem error={stop.error} title="Could not stop the run" />
        <Problem error={cancelResume.error} title="Could not cancel the automatic resume" />
        <Problem error={status.error} title="Could not read the run status" />
        <Problem error={sub.error} title="The live log disconnected" />
        {s?.since ? <Note testId="run-since">Changes-only run: Asana items changed since {when(s.since)}.</Note> : null}
        <p className="text-sm" data-testid="progress-text">{done} of {plural(planned, "write")} done.</p>
        <Progress done={done} planned={planned} />
        <p className="flex flex-wrap gap-4 text-sm" data-testid="counters">
          <span>Outcome unknown: <strong>{s?.counters.ambiguous ?? 0}</strong></span>
          <span>Failures: <strong>{s?.counters.errors ?? 0}</strong></span>
          <span>Warnings: <strong>{s?.counters.warnings ?? 0}</strong></span>
        </p>
        <Grid head={["Board", "Status", "Events"]} align={["left", "left", "right"]}>
          {(s?.boards ?? []).map((b, i) => {
            const seen = perBoard.get(b.name);
            const state = b.nestedIn ? `nested in ${b.nestedIn}` : b.applied ? "moved" : seen ? (active ? "moving" : "partly moved") : "waiting";
            return <Row key={`${i}:${b.name}`}><Cell>{b.name}</Cell><Cell>{state}{seen?.problems ? ` · ${plural(seen.problems, "problem")}` : ""}</Cell><Cell right>{seen?.events ?? 0}</Cell></Row>;
          })}
        </Grid>
        {problems.data?.items.length ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-cake-muted">To look at ({problems.data.items.length}{problems.data.truncated ? "+" : ""}). Run again settles what it can: only what is missing or different in Plaky is written, so nothing is duplicated.</span>
            <Problems items={problems.data.items} truncated={problems.data.truncated} />
          </div>
        ) : null}
        <Problem error={problems.error} title="Could not read the problems" />
        <VirtualLog rows={stream.events} />
        <details className="text-sm text-cake-muted">
          <summary className="cursor-pointer">Technical details</summary>
          <p data-testid="stream-stats">
            events {stats.first === null ? "none yet" : `#${stats.first}–#${stats.last}`}, {stream.events.length} shown, {stream.received} received, gaps {stats.gaps}, duplicates {stream.duplicates}, stream {STREAM_STATE[sub.status] ?? sub.status}
          </p>
        </details>
      </Block>
      <UndoBoard migrationId={migrationId} disabled={active} onDone={() => void status.refetch()} />
    </>
  );
}

const STREAM_STATE: Record<string, string> = { idle: "closed", connecting: "connecting", pending: "live", error: "reconnecting" };

const undoCounts = (items: number, nested: number, groups: number, their = true): string =>
  `${items} item(s)${nested ? `, ${their ? "their " : ""}${nested} nested subitem(s)` : ""} and ${groups} group(s)`;

export function UndoBoard({ migrationId, disabled, onDone }: { migrationId: number; disabled: boolean; onDone?: () => void }) {
  const trpc = useTRPC();
  const boards = useQuery(trpc.undo.boards.queryOptions({ migrationId }));
  const [board, setBoard] = useState("");
  const [typed, setTyped] = useState("");
  const preview = useMutation(trpc.undo.preview.mutationOptions());
  const queryClient = useQueryClient();
  const commit = useMutation(trpc.undo.commit.mutationOptions({ onSettled: () => {
    preview.reset(); setTyped(""); onDone?.();
    void queryClient.invalidateQueries(trpc.verify.summary.queryFilter({ migrationId }));
    void queryClient.invalidateQueries(trpc.run.problems.queryFilter({ migrationId }));
    void queryClient.invalidateQueries(trpc.provision.readiness.queryFilter({ migrationId }));
  } }));
  const p = preview.data && preview.data.board.asanaBoardId === board ? preview.data : null;
  const r = commit.data;
  if (boards.error) return <Block title="Undo one board" testId="undo"><Problem error={boards.error} title="Could not read the boards that can be undone" /></Block>;
  if (!boards.data?.length) return null;
  return (
    <Block title="Undo one board" testId="undo">
      <Note>Deletes only items and empty groups created by this migration. The next import rebuilds them.</Note>
      <div className="flex flex-wrap items-center gap-4">
        <select aria-label="Board to undo" className={fieldClass} value={board} disabled={preview.isPending || commit.isPending || disabled} onChange={(e) => { setBoard(e.target.value); setTyped(""); preview.reset(); commit.reset(); }}>
          <option value="">Choose a board…</option>
          {boards.data.map((b) => <option key={b.asanaBoardId} value={b.asanaBoardId}>{b.name}</option>)}
        </select>
        <Plain disabled={!board || preview.isPending || commit.isPending || disabled} onClick={() => { setTyped(""); preview.reset(); commit.reset(); preview.mutate({ migrationId, asanaBoardId: board }); }}>
          {preview.isPending ? "Reading Plaky…" : "Preview undo"}
        </Plain>
      </div>
      <Problem error={preview.error} title="Could not read the board" />
      {p ? (
        <div className="flex flex-col gap-3" data-testid="undo-preview">
          <p>
            Would delete <strong data-testid="undo-items">{p.items.length}</strong> item(s){p.nested.length ? <>, their <strong data-testid="undo-nested">{p.nested.length}</strong> nested subitem(s)</> : null} and <strong data-testid="undo-groups">{p.groups.length}</strong> group(s) on{" "}
            {p.board.url ? <a href={p.board.url} target="_blank" rel="noreferrer">{p.board.name}</a> : p.board.name}.
          </p>
          {p.items.length ? (
            <details><summary className="cursor-pointer">Items ({p.items.length})</summary>
              <ul className="ml-5 max-h-48 list-disc overflow-auto text-cake-muted">{p.items.map((i) => <li key={i.plakyId}>{i.title} <span className="text-sm">(asana {i.asanaId}{countsOf(i)})</span></li>)}</ul>
            </details>
          ) : null}
          {p.nested.length ? (
            <details><summary className="cursor-pointer">Nested subitems ({p.nested.length}), deleted with their items</summary>
              <ul className="ml-5 max-h-48 list-disc overflow-auto text-cake-muted">{p.nested.map((n) => <li key={n.plakyId}>{n.title} <span className="text-sm">(asana {n.asanaId}{countsOf(n)})</span></li>)}</ul>
            </details>
          ) : null}
          {p.groups.length ? <Note>Groups: {p.groups.map((g) => g.title).join(", ")}</Note> : null}
          {p.kept.length ? <div><p className="flex items-start gap-2"><Mark kind="now" /><strong>Left alone ({p.kept.length})</strong></p><ul className="ml-5 list-disc text-[15px]">{p.kept.map((k, i) => <li key={`${i}:${k}`}>{k}</li>)}</ul></div> : null}
          {p.gone.length ? <Note>{p.gone.length} record(s) of rows already gone from Plaky are cleared.</Note> : null}
          <label className="flex max-w-[520px] flex-col gap-1.5">
            <span>Type the board’s name, <strong>{p.board.name}</strong>, to confirm</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} disabled={commit.isPending} aria-label="Board name to confirm" className={fieldClass} />
          </label>
          <div>
            <Danger disabled={namedConfirmation(p.board.name, typed, preview.isPending || commit.isPending, disabled) !== "ready"} onClick={() => commit.mutate({ migrationId, asanaBoardId: board, confirm: typed, expected: { items: p.items.map((i) => i.plakyId), groups: p.groups.map((g) => g.plakyId), nested: p.nested.map((n) => n.plakyId) } })}>
              {commit.isPending ? "Deleting…" : `Delete ${undoCounts(p.items.length, p.nested.length, p.groups.length, false)}`}
            </Danger>
          </div>
        </div>
      ) : null}
      <Problem error={commit.error} title="Undo failed" />
      {r ? (
        <div className="flex items-start gap-2" data-testid="undo-result"><span className="pt-1"><Mark kind={r.failures.length ? "flag" : "done"} /></span><div>
          Deleted {undoCounts(r.deletedItems, r.deletedNested, r.deletedGroups, false)} on {r.board.name}.{r.reset ? " The board is marked not applied: the next run rebuilds it." : ""}
          {r.scheduleCancelled ? " The schedule to bring over changes was cancelled, so nothing rebuilds it by itself." : ""}{r.undone ? " The last check is out of date: Move again, then Check now." : ""}
          {r.failures.length ? <ul className="ml-5 list-disc">{r.failures.map((f, i) => <li key={`${i}:${f}`}><Explain text={f} /></li>)}</ul> : null}
        </div></div>
      ) : null}
    </Block>
  );
}

export function Exports({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  const trpc = useTRPC();
  const client = useTRPCClient();
  const [shownAt, setShownAt] = useState(() => Date.now());
  const shown = useCallback((el: HTMLDivElement | null) => { if (el) setShownAt(Date.now()); }, []);
  const status = useQuery({ ...trpc.run.status.queryOptions({ migrationId }), refetchInterval: (q) => statusRefetchMs(q.state.data) });
  const queryClient = useQueryClient();
  const summary = useQuery({ ...readAgainOn(trpc.verify.summary.queryOptions({ migrationId }), runKey(status.data), queryClient), enabled: status.data !== undefined || status.isError });
  const discovered = useQuery(trpc.discovery.manifest.queryOptions({ migrationId }));
  const planned = useQuery(trpc.plan.latest.queryOptions({ migrationId }));
  const outside = outsideTheMove(discovered.data?.manifest, planned.data?.summary);
  const verifyNow = useMutation(trpc.verify.run.mutationOptions({ onSuccess: async () => { await summary.refetch(); } }));
  const [exportError, setExportError] = useState<Error | null>(null);
  const [checklistError, setChecklistError] = useState<Error | null>(null);
  const [reporting, setReporting] = useState(false);
  const saving = (fn: () => void): void => {
    setExportError(null);
    try {
      fn();
    } catch (e) {
      setExportError(e instanceof Error ? e : new Error(String(e)));
    }
  };
  const exportReport = async (): Promise<void> => {
    const data = summary.data;
    if (!data?.receipt) return;
    setExportError(null);
    setChecklistError(null);
    setReporting(true);
    try {
      let checklistFailure: Error | null = null;
      const readiness = (await client.provision.readiness.query({ migrationId }).catch((e: unknown) => { checklistFailure = e instanceof Error ? e : new Error(String(e)); return null; }))?.filter((i) => readinessState(i) !== "status-types") ?? null;
      const text = handoffReport({
        migrationName: data.migrationName, generatedAt: new Date(), receipt: data.receipt, boardLinks: data.links, readiness,
        verifiedAt: data.receiptAt === null ? null : new Date(data.receiptAt),
        unverifiedLaterRun: data.run && data.receiptRunId !== null && data.run.id !== data.receiptRunId && !data.quietSince ? { status: data.run.status, startedAt: new Date(data.run.startedAt) } : null,
        undoneAfter: data.undoneAfter,
        boardNames: new Map(data.receipt.boards.map((b) => [b.asana_board_id, b.name])),
        outside,
      });
      saveFile(`migration-report-${migrationId}.md`, text, "text/markdown");
      setChecklistError(checklistFailure);
    } catch (e) {
      setExportError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setReporting(false);
    }
  };
  const r = summary.data;
  const busy = status.data?.active === true || verifyNow.isPending;
  const outsideRead = discovered.isSuccess && planned.isSuccess;
  const receiptRead = status.dataUpdatedAt >= shownAt && summary.dataUpdatedAt > 0;
  const receiptIsOlder = r?.receipt && r.run && r.receiptRunId !== null && r.receiptRunId !== r.run.id && !r.quietSince;
  return (
    <Block>
      <Problem error={summary.error} title="Could not read the receipt" />
      <Problem error={status.error} title="Could not read the run status" />
      {status.isError ? <div><Plain onClick={() => void status.refetch()} disabled={status.isFetching}>{status.isFetching ? "Reading…" : "Read the run status again"}</Plain></div> : null}
      <Problem error={discovered.error} title="Could not read the boards, so the exports are off" />
      <Problem error={planned.error} title="Could not read the last plan, so the exports are off" />
      {r?.receipt ? (
        <p>{r.undoneAfter ? <Status kind="flag"><strong>Out of date</strong></Status> : r.receipt.ok ? <Status kind="done">Complete</Status> : <Status kind="flag"><strong>Incomplete</strong></Status>} · {r.receipt.matched} of {plural(r.receipt.asana_items, "Asana item")} present in Plaky{r.receiptAt ? `, checked at ${clock(r.receiptAt)}` : ""}.</p>
      ) : <Note>No receipt yet: finish a run first.</Note>}
      {r?.receipt && r.undoneAfter ? <Note>A board was undone after this check: move again, then check now.</Note> : null}
      {receiptIsOlder && !busy ? <Note>This receipt is from an earlier run: the last run{status.data?.since ? ` (changes since ${when(status.data.since)})` : ""} was not checked. Check now for a current one.</Note> : null}
      {verifyNow.isPending ? <Note>Checking: reading every board on both sides…</Note> : null}
      <Problem error={verifyNow.error} title="Could not check" />
      <div ref={shown} className="flex flex-wrap gap-4">
        <Plain onClick={() => verifyNow.mutate({ migrationId })} disabled={busy}>Check now</Plain>
        <Plain disabled={!r?.receipt || !outsideRead || !receiptRead || reporting} onClick={() => void exportReport()}>{reporting ? "Reading Plaky…" : "Export the report"}</Plain>
        <Plain disabled={!r?.receipt || !outsideRead || !receiptRead} onClick={() => { const got = r?.receipt; if (got) saving(() => saveFile(`receipt-${migrationId}.json`, `${JSON.stringify(receiptDownload(got, outside), null, 2)}\n`)); }}>Export the receipt (JSON)</Plain>
      </div>
      <ArchiveDownload migrationId={migrationId} disabled={busy || !!status.data?.waiting || !!status.data?.schedule || !discovered.data?.manifest} />
      <Problem error={exportError} title="Export failed" />
      <Problem error={checklistError} title="Report saved without the unavailable checklist" />
    </Block>
  );
}

const countsOf = (row: { comments?: number | undefined; files?: number | undefined }): string =>
  `${row.comments ? `; ${row.comments} comment thread(s)` : ""}${row.files ? `; ${row.files} file(s)` : ""}${row.comments || row.files ? ", all from the move" : ""}`;

type Destructive = "prune" | "recreateDrifted";
const WARNING: Record<Destructive, { title: string; text: string }> = {
  prune: { title: "Delete Plaky rows that Asana no longer has?", text: "Permanently deletes matching items whose Asana task was deleted, moved or archived. A row holding anything made or changed in Plaky stays, and is named." },
  recreateDrifted: { title: "Rebuild items with changed structure?", text: "Replaces an item renamed in Asana with a new one (Plaky cannot rename it), under a new ID. An item holding anything made or changed in Plaky stays, and its rename is listed as a step by hand." },
};

export function PlanOptions({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  const trpc = useTRPC();
  const latest = useQuery(trpc.plan.latest.queryOptions({ migrationId }));
  const discovered = useQuery(trpc.discovery.manifest.queryOptions({ migrationId }));
  const nested = discovered.data?.manifest?.boards.some((b) => b.nested) ?? false;
  const [showValues, setShowValues] = useState(false);
  const [asking, setAsking] = useState<Destructive | null>(null);
  const details = useQuery({ ...trpc.plan.details.queryOptions({ migrationId, showValues: true }), enabled: showValues });
  const run = useMutation(trpc.plan.run.mutationOptions({ onSuccess: () => { void latest.refetch(); if (showValues) void details.refetch(); } }));
  const queryClient = useQueryClient();
  const setOptions = useMutation(trpc.plan.setOptions.mutationOptions({
    onSuccess: (stored) => {
      setAsking(null);
      queryClient.setQueryData(trpc.plan.latest.queryKey({ migrationId }), (old) => (old ? { ...old, prune: stored.prune, recreateDrifted: stored.recreateDrifted } : old));
      run.reset();
      void latest.refetch();
      void queryClient.invalidateQueries({ queryKey: trpc.run.status.queryKey({ migrationId }) });
      void queryClient.invalidateQueries({ queryKey: trpc.verify.summary.queryKey({ migrationId }) });
      void queryClient.invalidateQueries({ queryKey: trpc.plan.details.queryKey({ migrationId }) });
    },
  }));
  const summary = run.data ?? latest.data?.summary ?? null;
  const prune = latest.data?.prune ?? false;
  const recreate = latest.data?.recreateDrifted ?? false;
  const set = (key: Destructive, on: boolean): void => setOptions.mutate({ migrationId, [key]: on });
  const change = (key: Destructive, on: boolean): void => (on ? setAsking(key) : set(key, false));
  const option = (key: Destructive, label: string, hint: string, checked: boolean) => (
    <label className="flex items-start gap-2.5"><input type="checkbox" className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={checked} disabled={setOptions.isPending || (key === "recreateDrifted" && !checked && (nested || !discovered.isSuccess))} onChange={(e) => change(key, e.target.checked)} /><span>{label}<span className="block text-sm text-cake-muted">{key === "recreateDrifted" && nested ? "Unavailable with nested subitems." : hint}</span></span></label>
  );
  return (
    <Block>
      <div className="flex flex-wrap items-center gap-4">
        <Plain onClick={() => run.mutate({ migrationId })} disabled={run.isPending}>{run.isPending ? "Planning… (reads Asana and Plaky)" : "Plan again"}</Plain>
        <Note>Previews changes without modifying either account.</Note>
      </div>
      <Problem error={run.error} title="Could not plan" />
      <Problem error={latest.error} title="Could not read the last plan" />
      <Problem error={discovered.error} title="Could not read the subitem setup" />
      {summary ? (
        <>
          <Grid head={["Board", "Create", "Update", "Unchanged", "Drift", "Orphans", "Groups", "Comments", "Files"]} align={["left", "right", "right", "right", "right", "right", "right", "right", "right"]} testId="dry-run">
            {summary.boards.filter((b) => !emptyPlanRow(b)).map((b) => (
              <Row key={b.asanaBoardId}><Cell>{b.name}</Cell><Cell right>{b.creates}</Cell><Cell right>{b.updates}</Cell><Cell right>{b.unchanged}</Cell><Cell right>{b.drifted}</Cell><Cell right>{b.orphans}</Cell><Cell right>{b.groupWrites}</Cell><Cell right>{b.comments}</Cell><Cell right>{b.files}</Cell></Row>
            ))}
          </Grid>
          <Note testId="dry-run-totals">{writesLine(summary.plannedWrites)} Read from Asana at {clock(summary.at)}{summary.asanaCalls !== undefined ? ` with ${plural(summary.asanaCalls, "call")}` : ""}.</Note>
          {summary.failures.map((f, i) => <div key={`${i}:${f}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={`Cannot plan ${f}`} /></div></div>)}
          {summary.boards.filter((b) => b.uncarried.length || b.notCarriedValues).map((b) => (
            <div key={b.asanaBoardId} className="text-[15px]">
              <strong>{b.name}:</strong> {[b.uncarried.length ? plural(b.uncarried.length, "column") + " not carried" : "", b.notCarriedValues ? plural(b.notCarriedValues, "value") + " not carried" : ""].filter(Boolean).join(", ")}
              <ul className="ml-5 list-disc text-cake-muted">{b.uncarried.map((line, i) => <li key={`${i}:${line}`}>{line}</li>)}</ul>
            </div>
          ))}
          {latest.data ? (
            <Note testId="asana-budget">
              {heldSentence(run.data ? run.data.held : latest.data.held)}
            </Note>
          ) : null}
        </>
      ) : <Note>{latest.isPending ? "Reading the last plan…" : "No plan yet."}</Note>}
      <div className="flex flex-col gap-3 border-t border-cake-line pt-4">
        <label className="flex items-start gap-2.5"><input type="checkbox" className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={showValues} onChange={(e) => setShowValues(e.target.checked)} /><span>Show values<span className="block text-sm text-cake-muted">Contains personal data.</span></span></label>
        <Problem error={details.error} title="Could not read the values" />
        {showValues && details.isSuccess && details.data === null && summary ? <Note>Plan again to view values.</Note> : null}
        {showValues && details.data ? (
          <div className="flex flex-col gap-2 text-[15px]" data-testid="dry-run-values">
            {details.data.boards.map((b, i) => (
              <div key={`${i}:${b.name}`}>
                <strong>{b.name}</strong>
                {b.creates.length ? <p className="text-cake-muted">Create: {b.creates.join(", ")}</p> : null}
                {b.updates.length ? <p className="text-cake-muted">Update: {b.updates.join(", ")}</p> : null}
                {b.notCarried.map((line, i) => <p key={`${i}:${line}`} className="text-cake-muted">Not carried: {line}</p>)}
              </div>
            ))}
          </div>
        ) : null}
        {option("prune", "Delete items missing from Asana", "Permanently deletes matching destination items that hold nothing made or changed in Plaky.", prune)}
        {option("recreateDrifted", "Rebuild items with changed structure", "Replaces items renamed in Asana that hold nothing made or changed in Plaky.", recreate)}
        {asking ? (
          <div className="flex flex-col gap-2 border-t border-cake-line pt-3" role="alertdialog" aria-labelledby="plan-ask" data-testid="confirm-option">
            <p id="plan-ask" className="flex items-start gap-2"><Mark kind="flag" /><strong>{WARNING[asking].title}</strong></p>
            <Note>{WARNING[asking].text}</Note>
            <div className="flex flex-wrap gap-4"><Plain onClick={() => set(asking, true)} disabled={setOptions.isPending}>Turn it on</Plain><Quiet onClick={() => setAsking(null)}>Keep it off</Quiet></div>
          </div>
        ) : null}
        {prune || recreate ? <p className="flex items-start gap-2"><Mark kind="now" /><span>Destructive options are on for the next run.</span></p> : null}
        <Problem error={setOptions.error} title="Could not save that" />
      </div>
    </Block>
  );
}

export function Pairing({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const previewKey = ["link.preview", migrationId];
  const preview = useQuery({ queryKey: previewKey, queryFn: ({ signal }) => client.link.preview.mutate({ migrationId }, { signal }), refetchOnReconnect: false });
  const read = (): void => void preview.refetch();
  const readAfterSave = async (): Promise<void> => {
    await queryClient.cancelQueries({ queryKey: previewKey, exact: true });
    await preview.refetch();
  };
  return (
    <Block>
      <Problem error={preview.isFetching ? null : preview.error} title="Could not read the pairing" />
      {preview.isFetching ? <Note>Reading Plaky…</Note> : !preview.isError && preview.data ? <LinkTable preview={preview.data} /> : null}
      <div><Plain onClick={read} disabled={preview.isFetching}>Check again</Plain></div>
      <PairingEditor migrationId={migrationId} onSaved={() => void readAfterSave()} />
    </Block>
  );
}

export function PairingEditor({ migrationId, onSaved }: { migrationId: number; onSaved?: () => void }) {
  const trpc = useTRPC();
  const pairing = useQuery(trpc.link.pairing.queryOptions({ migrationId }));
  const save = useMutation(trpc.link.setPairing.mutationOptions({ onSuccess: () => { void pairing.refetch(); onSaved?.(); } }));
  if (pairing.error) return <Problem error={pairing.error} title="Could not read the column pairing" />;
  if (!pairing.data) return <Note>Reading the column pairing…</Note>;
  return (
    <div className="flex flex-col gap-5" data-testid="pairing-editor">
      <h3 className="text-[17px] font-medium">Where each column lands</h3>
      <Note>Choose a field or Don’t carry. Match Status and Tag labels below.</Note>
      <Problem error={save.error} title="Could not change the pairing" />
      {pairing.data.boards.map((board) => (
        <div key={board.asanaBoardId} className="flex flex-col gap-2" data-testid={`pairing-${board.asanaBoardId}`}>
          <h4 className="text-[15px] font-semibold">{board.name}</h4>
          <Grid head={["Column", "Lands in"]} testId={`pairing-grid-${board.asanaBoardId}`}>
            {board.columns.map((c) => {
              const value = c.state === "skipped" ? "skip" : c.field?.key ?? "auto";
              const target = board.fields.find((f) => f.key === c.field?.key);
              const choose = (v: string): void => save.mutate({ migrationId, asanaBoardId: board.asanaBoardId, columnId: c.id, choice: v === "skip" ? { kind: "skip" } : v === "auto" ? { kind: "auto" } : { kind: "field", key: v } });
              return (
                <Row key={c.id}>
                  <Cell>{c.title} <span className="text-[15px] text-cake-muted">({c.type})</span></Cell>
                  <Cell>
                    <select aria-label={`Where ${c.title} lands`} className={fieldClass} value={value} disabled={save.isPending} onChange={(e) => choose(e.target.value)}>
                      <option value="auto">Automatic (a field of the same name)</option>
                      <option value="skip">Don’t carry</option>
                      {board.fields.map((f) => <option key={f.key} value={f.key}>{f.name} ({f.typeLabel})</option>)}
                    </select>
                    {c.state === "unpaired" ? <p className="mt-1 text-[15px]"><Mark kind="flag" /> Choose a field or Don’t carry to continue.</p> : null}
                    {target && (target.type === "STATUS" || target.type === "TAG") && c.labels.length ? (
                      <details className="mt-1 text-[15px]">
                        <summary className="cursor-pointer">Labels ({c.labels.length})</summary>
                        <ul className="mt-1 flex flex-col gap-1">
                          {c.labels.map((label) => (
                            <li key={label} className="flex flex-wrap items-center gap-2">
                              <span>{label} →</span>
                              <select aria-label={`${c.title} label ${label}`} className={fieldClass} value={c.labelMap[label] ?? label} disabled={save.isPending}
                                onChange={(e) => save.mutate({ migrationId, asanaBoardId: board.asanaBoardId, columnId: c.id, choice: { kind: "field", key: target.key }, labels: { ...c.labelMap, [label]: e.target.value } })}>
                                {[...new Set([label, ...target.labels])].map((l) => <option key={l} value={l}>{l === label ? `${l} (same name)` : l}</option>)}
                              </select>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </Cell>
                </Row>
              );
            })}
          </Grid>
        </div>
      ))}
    </div>
  );
}

export function EraseMigration({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  return <EraseBlock migrationId={migrationId} onErased={() => window.location.replace("/")} />;
}

export function EraseBlock({ migrationId, onErased }: { migrationId: number; onErased: () => void }) {
  const trpc = useTRPC();
  const got = useQuery(trpc.connection.get.queryOptions({ migrationId }));
  const [typed, setTyped] = useState("");
  const forget = useMutation(trpc.connection.forget.mutationOptions({ onSuccess: onErased }));
  const name = got.data?.migration.name ?? null;
  return (
    <Block testId="erase">
      <p>Permanently deletes local records for migration #{migrationId}. Save the report first. Asana, Plaky boards and other migrations remain unchanged.</p>
      <Problem error={got.error} title="Could not read this migration" />
      {name === null ? (got.isPending ? <Note>Reading…</Note> : null) : (
        <>
          <label className="flex max-w-[520px] flex-col gap-1.5">
            <span>Type the migration’s name, <strong>{name}</strong>, to confirm</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Migration name to confirm" autoComplete="off" spellCheck={false} className={fieldClass} />
          </label>
          <div>
            <Danger disabled={namedConfirmation(name, typed, forget.isPending || forget.isSuccess) !== "ready"} onClick={() => forget.mutate({ migrationId, confirm: typed })}>
              {forget.isPending ? "Erasing…" : `Erase migration #${migrationId}`}
            </Danger>
          </div>
        </>
      )}
      <Problem error={forget.error} title="Could not erase" />
    </Block>
  );
}
