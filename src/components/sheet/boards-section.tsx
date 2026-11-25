"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import Link from "next/link";
import { Fragment, memo, useCallback, useId, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { boardsTransition, downloadScanDue, focusScanDue, linkReadiness, SetupWatcher } from "@/lib/setup-state";
import { readinessState } from "@/lib/readiness-state";
import { checklistText, isLabelColorInstruction, plainGuide } from "@/lib/checklist-copy";
import { label } from "@/lib/people-entry";
import { DUPLICATE_FIRST, DUPLICATE_STEPS, ANY_ORDER, IMPORT_STEPS, INSTRUCTIONS_FILE, MASTER_NOTE, ONCE, instructionsText, typeLines, type SeedBoard } from "@/lib/seed-steps";
import { setUpCounts, tasksText } from "@/lib/counts";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { ScopeReportBlock } from "./scope-section";
import { zip } from "@/lib/zip";
import { Block, Cell, Explain, fieldClass, Go, Grid, Mark, Note, Plain, plural, Problem, Quiet, Row, Section, Status } from "./bits";
import { useSave } from "./use-save";
import { useSetupDraft } from "./use-setup-draft";

export { AWAKE_MS } from "@/lib/setup-state";

const WATCH_MS = 30_000;
const WATCH_SLOW_MS = 120_000;
const CSV = "text/csv;charset=utf-8";
type ScanIntent = "full" | "background";
const subscribeVisibility = (changed: () => void): (() => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};
const shownNow = (): boolean => !document.hidden;
const shownOnServer = (): boolean => true;

type Subitems = "auto" | "board" | "nested";
type Options = { syncComments: boolean; syncFiles: boolean; syncSubscribers: boolean; paidAsana: boolean; withCreated: boolean; withLink: boolean; subitems: Subitems };

const SUBITEMS: readonly { value: Subitems; label: string; hint: string }[] = [
  { value: "auto", label: "Automatic", hint: "Nested, unless subtasks have fields their tasks lack; then a separate board." },
  { value: "board", label: "Separate board", hint: "Subitems use their own fields." },
  { value: "nested", label: "Nested subitems", hint: "Under their parent, with extra fields added." },
];

export function BoardsSection({ migrationId, linked, onLinked, watchMs }: { migrationId: number; linked: boolean; onLinked: () => void; watchMs?: number }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const saved = useQuery({ ...trpc.discovery.manifest.queryOptions({ migrationId }), staleTime: 5_000 });
  const [mode, transition] = useReducer(boardsTransition, "overview");
  const [why, setWhy] = useState<"deleted" | "reread">("deleted");
  const seedFailures = saved.data?.seedFailures ?? [];
  const reread = useMutation(trpc.discovery.run.mutationOptions({ onSuccess: async () => {
    void queryClient.resetQueries(trpc.plan.latest.queryFilter({ migrationId }));
    await saved.refetch();
    setWhy("reread");
    transition("repair");
    onLinked();
  } }));
  const dismiss = useMutation(trpc.link.dismissSeedFailures.mutationOptions({ onSuccess: () => void saved.refetch() }));
  const manifest = saved.data?.manifest ?? null;
  if (linked && mode === "repairing") {
    return (
      <Section n={2} title="Set up boards" state="open">
        <Note>{why === "reread" ? "Projects read again. Set up any board that is new in Plaky, then link it." : "Reimport the deleted board’s setup file, then link it."}</Note>
        <Destination migrationId={migrationId} spaceId={saved.data?.spaceId ?? null} selected={saved.data?.selected ?? []} />
        {manifest ? (
          <Setup migrationId={migrationId} items={new Map(manifest.boards.map((b) => [b.id, b.items]))} again onLinked={() => { transition("back"); onLinked(); void saved.refetch(); }} onChoose={() => undefined} watchMs={watchMs} />
        ) : <Note>Reading…</Note>}
        <div><Quiet onClick={() => transition("back")}>Back</Quiet></div>
      </Section>
    );
  }
  if (linked) {
    const all = manifest?.boards ?? [];
    const paired = (id: string | null): boolean => all.some((b) => b.id === id && b.plakyBoardId !== null);
    const setUp = all.filter((b) => b.plakyBoardId !== null || (b.nested && paired(b.subitemsOf)));
    const own = all.filter((b) => !b.nested);
    const left = own.filter((b) => !setUp.includes(b)).map((b) => b.name);
    const { tasks, subtasks } = setUpCounts(all, true);
    const counted = left.length ? `${own.length - left.length} of ${plural(own.length, "board")} set up in Plaky (not set up: ${left.join(", ")})` : `${plural(own.length, "board")} set up in Plaky`;
    return (
      <>
        <Section
          n={2} title="Set up boards" state="closed"
          summary={<>{manifest ? `${counted} · ${tasksText(tasks, subtasks)}` : "set up in Plaky"}<PeopleLine migrationId={migrationId} /></>}
        />
        <Problem error={saved.error} title="Could not read this migration's boards" />
        <div className="-mt-2 mb-4 flex flex-wrap gap-4">
          <Quiet onClick={() => { setWhy("deleted"); transition("repair"); }}>Set up a deleted board again</Quiet>
          <Quiet disabled={reread.isPending || !saved.data?.selected.length || !saved.data.spaceId} onClick={() => {
            const data = saved.data;
            if (data?.spaceId) reread.mutate({ migrationId, boardIds: data.selected, spaceId: data.spaceId, options: data.options });
          }}>{reread.isPending ? "Reading projects…" : "Read projects again"}</Quiet>
        </div>
        <Problem error={reread.error} title="Could not read projects" />
        {seedFailures.length ? (
          <div className="mb-4 flex flex-col gap-1.5 rounded border border-cake-line bg-white px-6 py-4" data-testid="seed-failures">
            <p className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><strong className="font-medium">{plural(seedFailures.length, "imported example row")} could not be deleted from Plaky. Delete {seedFailures.length === 1 ? "it" : "them"} by hand:</strong></p>
            <ul className="ml-6 flex flex-col gap-1 text-[15px]">{seedFailures.map((f, i) => <li key={`${i}:${f}`}><Explain text={f} /></li>)}</ul>
            <div><Quiet onClick={() => dismiss.mutate({ migrationId })} disabled={dismiss.isPending}>Done, I deleted {seedFailures.length === 1 ? "it" : "them"}</Quiet></div>
            <Problem error={dismiss.error} title="Could not save that" />
          </div>
        ) : null}
      </>
    );
  }
  return (
    <Section n={2} title="Set up boards" state="open">
      <Problem error={saved.error} title="Could not read this migration" />
      {manifest && mode !== "choosing" ? <><Destination migrationId={migrationId} spaceId={saved.data?.spaceId ?? null} selected={saved.data?.selected ?? []} /><ScopeReportBlock migrationId={migrationId} /></> : null}
      {saved.isPending ? <Note>Reading…</Note> : !manifest || mode === "choosing" ? (
        <Picker migrationId={migrationId} saved={saved.data ?? null} onRead={() => { transition("read"); void saved.refetch(); }} onSplit={() => { void saved.refetch(); void queryClient.invalidateQueries(trpc.connection.get.queryFilter({ migrationId })); }} />
      ) : (
        <Setup migrationId={migrationId} items={new Map(manifest.boards.map((b) => [b.id, b.items]))} onLinked={() => { onLinked(); void saved.refetch(); }} onChoose={() => transition("choose")} watchMs={watchMs} />
      )}
    </Section>
  );
}

function Destination({ migrationId, spaceId, selected }: { migrationId: number; spaceId: number | null; selected: readonly string[] }) {
  const trpc = useTRPC();
  const stored = useQuery(trpc.connection.get.queryOptions({ migrationId }));
  const env = useQuery(trpc.connection.env.queryOptions());
  const catalog = useQuery({ ...trpc.discovery.catalog.queryOptions({ migrationId, includeMyTasks: selected.some((id) => id.startsWith("mytasks:")) }), enabled: false });
  if (spaceId === null) return null;
  const connection = stored.data?.connection;
  const base = connection ? connection.plakyWebBase ?? (connection.typedPlakyKey ? null : env.data?.plakyWebBase ?? null) : null;
  const name = catalog.data?.spaces.find((s) => s.id === spaceId)?.title;
  const label = name ? `${name} (#${spaceId})` : `Space #${spaceId}`;
  return <p data-testid="setup-destination">Destination: <strong>{base ? <a href={`${base}/spaces/${spaceId}`} target="_blank" rel="noreferrer">{label}</a> : label}</strong>.</p>;
}

type Saved = { spaceId: number | null; options: Options; selected: string[]; pick?: string[] | null; draftIdentity?: string; manifest?: { generatedAt: string } | null };

function Picker({ migrationId, saved, onRead, onSplit = () => undefined }: { migrationId: number; saved: Saved | null; onRead: () => void; onSplit?: () => void }) {
  const trpc = useTRPC();
  const { draft, save, clear, warning } = useSetupDraft(`${migrationId}:${saved?.draftIdentity ?? ""}`, JSON.stringify([saved?.manifest?.generatedAt, saved?.selected, saved?.spaceId, saved?.pick, saved?.options]));
  const includeMyTasks = draft?.includeMyTasks ?? (saved?.selected.some((id) => id.startsWith("mytasks:")) ?? false);
  const catalog = useQuery(trpc.discovery.catalog.queryOptions({ migrationId, includeMyTasks }));
  const read = useMutation(trpc.discovery.run.mutationOptions({ onSuccess: () => { clear(); onRead(); } }));
  const boards = (catalog.data?.boards ?? []).filter((b) => b.selectable).sort((a, b) => (a.workspace ?? "").localeCompare(b.workspace ?? ""));
  const outside = (catalog.data?.boards ?? []).filter((b) => !b.selectable && b.kind !== "sub_items_board");
  const chosen = draft?.selected ?? (saved?.selected.length ? saved.selected : (saved?.pick ?? []));
  const selected = new Set(catalog.data ? chosen.filter((id) => boards.some((b) => b.id === id)) : chosen);
  const workspaces = [...new Set(boards.map((b) => b.workspace))];
  const splittable = (catalog.data?.boards ?? []).filter((b) => b.selectable && !b.id.startsWith("mytasks:") && !b.why?.startsWith("archived in Asana"));
  const splitWorkspaces = [...new Map(splittable.map((b) => [b.workspaceId ?? b.workspace, b.workspace])).values()];
  const folders = new Set(boards.flatMap((b) => (b.folder ? [b.folder] : [])));
  const privateCount = boards.filter((b) => b.privacy?.startsWith("private")).length;
  const teamCount = boards.filter((b) => b.privacy?.startsWith("team")).length;
  const split = useMutation(trpc.discovery.split.mutationOptions({ onSuccess: () => { clear(); onSplit(); } }));
  const spaces = catalog.data?.spaces ?? [];
  const spaceId = draft?.spaceId ?? saved?.spaceId ?? (spaces.length === 1 ? spaces[0]!.id : undefined);
  const first = !saved?.selected.length;
  const opts: Partial<Options> = draft?.options ?? {};
  const o: Options = {
    syncComments: opts.syncComments ?? (first ? true : saved.options.syncComments), syncFiles: opts.syncFiles ?? (first ? true : saved.options.syncFiles),
    syncSubscribers: opts.syncSubscribers ?? saved?.options.syncSubscribers ?? false, paidAsana: opts.paidAsana ?? saved?.options.paidAsana ?? false, withCreated: opts.withCreated ?? saved?.options.withCreated ?? true,
    withLink: opts.withLink ?? saved?.options.withLink ?? true, subitems: opts.subitems ?? saved?.options.subitems ?? "auto",
  };
  const saveChoices = (patch: Partial<NonNullable<typeof draft>>) => save({ selected: [...selected], spaceId: spaceId ?? null, options: o, includeMyTasks, ...patch });
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    saveChoices({ selected: [...next] });
  };
  const items = boards.filter((b) => selected.has(b.id)).reduce((n, b) => n + b.items, 0);
  const readHint = catalog.isPending || read.isPending ? null : selected.size === 0 && !spaces.some((s) => s.id === spaceId) ? "Tick a project and choose a Space to read." : selected.size === 0 ? "Tick at least one project to read." : !spaces.some((s) => s.id === spaceId) ? "Choose a Space to read into." : null;
  const option = (key: Exclude<keyof Options, "subitems">, label: string) => (
    <label className="flex min-h-10 items-center gap-2"><input type="checkbox" className="size-[18px] flex-none accent-cake-brand-500" checked={o[key]} onChange={(e) => saveChoices({ options: { ...o, [key]: e.target.checked } })} /><span>{label}</span></label>
  );
  return (
    <fieldset disabled={read.isPending || split.isPending} className="min-w-0 flex flex-col gap-4">
      <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={includeMyTasks} onChange={(e) => {
        saveChoices({ includeMyTasks: e.target.checked, selected: [...selected].filter((id) => e.target.checked || !id.startsWith("mytasks:")) });
      }} />Include My Tasks (tasks outside projects)</label>
      <Note>Projects become boards. Archived projects use an Archived group.</Note>
      <div className="flex flex-wrap items-center gap-2">
        <Quiet disabled={catalog.isFetching || read.isPending} onClick={() => { saveChoices({}); void catalog.refetch(); }}>Refresh projects and Spaces</Quiet>
        <Quiet disabled={catalog.isPending || !boards.length} onClick={() => saveChoices({ selected: boards.map((b) => b.id) })}>Select all</Quiet>
        <Quiet disabled={catalog.isPending || !boards.length} onClick={() => saveChoices({ selected: [] })}>Select none</Quiet>
      </div>
      <Problem error={catalog.error} title="Could not list the boards" />
      {teamCount ? <Note testId="team-summary">{plural(teamCount, "project")} {teamCount === 1 ? "is" : "are"} team-only in Asana: limit {teamCount === 1 ? "its board" : "their boards"} to that team in Plaky.</Note> : null}
      {privateCount ? <Note testId="privacy-summary">{plural(privateCount, "project")} {privateCount === 1 ? "is" : "are"} private in Asana: make {privateCount === 1 ? "its board" : "their boards"} private in Plaky.</Note> : null}
      {catalog.isPending ? <Note>Reading the Asana account…</Note> : (
        <Grid head={["Project", "Tasks"]} align={["left", "right"]} testId="pick-boards">
          {boards.map((b, at) => (
            <Fragment key={b.id}>
            {workspaces.length > 1 && boards[at - 1]?.workspace !== b.workspace ? (
              <Row><Cell><strong data-testid="workspace-heading">{b.workspace}</strong></Cell><Cell right>{""}</Cell></Row>
            ) : null}
            <Row>
              <Cell>
                <div className="flex items-start gap-2.5">
                  <input id={`pick-${b.id}`} type="checkbox" className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={selected.has(b.id)} onChange={(e) => toggle(b.id, e.target.checked)} aria-describedby={b.privacy ? `pick-${b.id}-private` : undefined} />
                  <div>
                    <label htmlFor={`pick-${b.id}`}>{b.name}</label>
                    {b.archived ? <span className="ml-2 text-[15px] text-cake-muted" data-testid={`archived-${b.id}`}>Archived</span> : null}
                    {b.folder && b.folder !== b.workspace && folders.size > 1 ? <span className="ml-2 text-[15px] text-cake-muted">in {b.folder}</span> : null}
                    {b.why ? <span className="block text-[15px] text-cake-muted" data-testid={`why-${b.id}`}>{b.why}</span> : null}
                    {b.privacy ? <span id={`pick-${b.id}-private`} className="block text-[15px] text-cake-muted" data-testid={`privacy-${b.id}`}>{b.privacy.charAt(0).toUpperCase() + b.privacy.slice(1)}</span> : null}
                  </div>
                </div>
              </Cell>
              <Cell right>{b.items}</Cell>
            </Row>
            </Fragment>
          ))}
        </Grid>
      )}
      {(splitWorkspaces.length > 1 && !saved?.pick && !saved?.selected.length) || split.data ? (
        <Block title={`These boards are in ${splitWorkspaces.length} workspaces`} testId="split">
          <Note>Separate migrations per workspace. This one keeps {splitWorkspaces[0]}.</Note>
          {split.data ? (
            <ul className="flex flex-col gap-1" data-testid="split-done">
              {split.data.migrations.map((m) => <li key={m.migrationId}><Link prefetch={false} href={`/migrations/${m.migrationId}`}>{m.workspace} ({plural(m.boards, "board")})</Link>{m.migrationId === migrationId ? " — this migration" : ""}</li>)}
            </ul>
          ) : <div><Plain onClick={() => split.mutate({ migrationId })} disabled={split.isPending}>{split.isPending ? "Splitting…" : "Split by workspace"}</Plain></div>}
          <Problem error={split.error} title="Could not split" />
        </Block>
      ) : null}
      {outside.length ? (
        <p className="text-[15px] text-cake-muted" data-testid="pick-outside">Not carried: {outside.map((b) => `${b.name} (${b.why ?? "not a board"})`).join("; ")}.</p>
      ) : null}
      <label className="flex min-w-0 flex-col gap-2">Space
        <select aria-label="Space" className={`${fieldClass} w-full min-w-0 max-w-full truncate`} value={spaceId === undefined ? "" : String(spaceId)} disabled={read.isPending}
          onChange={e => saveChoices({ spaceId: Number(e.target.value) })}>
          <option value="" disabled>Choose a Space</option>
          {spaceId !== undefined && !spaces.some(s => s.id === spaceId) ? <option value={String(spaceId)} disabled>{catalog.isPending ? "Loading Spaces…" : `Space #${spaceId} (unavailable)`}</option> : null}
          {spaces.map(s => <option key={s.id} value={String(s.id)}>{s.title}</option>)}
        </select>
      </label>
      {warning ? <p role="alert" className="text-sm">{warning}</p> : null}
      <details>
        <summary className="min-h-8 cursor-pointer">Import options</summary>
        <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
          {option("syncComments", "Comments")}
          {option("syncFiles", "Files")}
          {option("syncSubscribers", "Subscribers")}
          {option("paidAsana", "Asana uses a paid plan")}
          {option("withCreated", "Original creator and creation date")}
          {option("withLink", "Links to Asana items")}
        </div>
        <Note>Files up to 100 MB each are imported. The task archive names larger ones, so you can save them from Asana.</Note>
      </details>
        <fieldset className="mt-1 flex min-w-0 flex-col gap-2" data-testid="subitems">
          <legend className="mb-2 font-semibold">Subitem layout</legend>
          {SUBITEMS.map((c) => (
            <label key={c.value} className="choice-card flex min-h-10 items-start gap-3 rounded border border-cake-line p-3">
              <input type="radio" name="subitems" value={c.value} className="mt-1 size-[18px] flex-none accent-cake-brand-500" checked={o.subitems === c.value} onChange={() => saveChoices({ options: { ...o, subitems: c.value } })} />
              <span><strong className="block text-sm font-medium">{c.label}</strong><span className="text-sm text-cake-muted">{c.hint}</span></span>
            </label>
          ))}
          <Note>Existing boards keep their layout.</Note>
        </fieldset>
      <div className="flex flex-wrap items-center gap-5">
        <Go aria-describedby={readHint ? "read-hint" : undefined} disabled={read.isPending || !spaces.some(s => s.id === spaceId) || selected.size === 0} onClick={() => read.mutate({ migrationId, boardIds: [...selected], spaceId: spaceId!, options: o })}>
          {read.isPending ? "Reading the projects…" : `Read ${plural(selected.size, "project")}`}
        </Go>
        <Note>{plural(items, "task")}.</Note>
      </div>
      {readHint ? <Note id="read-hint">{readHint}</Note> : null}
      <Problem error={read.error} title="Could not read the boards" />
    </fieldset>
  );
}

const STATE_TEXT: Record<string, string> = { active: "active in Asana", pending: "invited in Asana, not joined", inactive: "deactivated in Asana" };

type ScanAnswer<I> = { preview: NonNullable<Parameters<typeof linkReadiness>[0]> & { hints: readonly { text: string }[] }; readiness: readonly I[] };
type LinkGates = { tagGate: boolean; clear: boolean; movedBefore: boolean; needsConfirm: boolean };

function linkGates<I extends { key: string; done: boolean }>(answer: ScanAnswer<I> | undefined, keepTags: boolean): LinkGates & { asTag: I[]; unread: I[] } {
  const items = answer?.readiness ?? [];
  const asTag = items.filter((i) => readinessState(i) === "status-types" && !i.done);
  const unread = items.filter((i) => readinessState(i) === "unread" && !i.done);
  return {
    asTag, unread,
    tagGate: (asTag.length > 0 && !keepTags) || unread.length > 0,
    clear: !unread.length && linkReadiness(answer?.preview, asTag.length, keepTags) === "ready",
    movedBefore: (answer?.preview.hints ?? []).some((h) => h.text.includes("already holds")),
    needsConfirm: answer?.preview.needsConfirm ?? false,
  };
}

function Setup({ migrationId, items, onLinked, onChoose, again = false, watchMs = WATCH_MS }: { migrationId: number; items: ReadonlyMap<string, number>; onLinked: () => void; onChoose: () => void; again?: boolean; watchMs?: number | undefined }) {
  const trpc = useTRPC();
  const download = useSave();
  const [watcher] = useState(() => new SetupWatcher());
  const wake = (): void => { watcher.wake(Date.now()); };
  const guide = useQuery(trpc.provision.guide.queryOptions({ migrationId }));
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const commit = useMutation(trpc.link.commit.mutationOptions({ onSuccess: (r) => { if (r.status === "linked") onLinked(); }, onSettled: () => watcher.linked() }));
  const mount = useId();
  const scanKey = useMemo(() => ["provision.detect", migrationId, mount], [migrationId, mount]);
  const intent = useRef<ScanIntent | null>(null);
  const scanAgain = useRef(false);
  const lastSentAt = useRef(0);
  const shown = useSyncExternalStore(subscribeVisibility, shownNow, shownOnServer);
  const slowMs = watchMs === WATCH_MS ? WATCH_SLOW_MS : watchMs * 4;
  const paceMs = (): number => (watcher.pace === "slow" ? slowMs : watchMs);
  const scan = useQuery({
    queryKey: scanKey,
    queryFn: async ({ queryKey }) => {
      const state = queryClient.getQueryState(queryKey);
      const opening = !state || state.dataUpdateCount + state.errorUpdateCount === 0;
      let full = intent.current ? intent.current === "full" : opening;
      if (intent.current === null && !opening) watcher.timedScanSent();
      intent.current = null;
      for (;;) {
        scanAgain.current = false;
        const sentAt = Date.now();
        lastSentAt.current = sentAt;
        try {
          const answer = { ...(await client.provision.detect.mutate({ migrationId, ...(full ? {} : { background: true }) })), sentAt };
          if (!scanAgain.current) return answer;
          queryClient.setQueryData(queryKey, answer);
        } catch (error) {
          if (!scanAgain.current) throw error;
        }
        full = true;
      }
    },
    enabled: !commit.isPending,
    refetchInterval: () => {
      const ms = paceMs();
      return watcher.watching(Date.now() + ms, !shown) ? ms : false;
    },
    refetchIntervalInBackground: true,
    staleTime: "static", refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false, retryOnMount: false,
  });
  const scanning = useCallback((): boolean => queryClient.isFetching({ queryKey: scanKey }) > 0, [queryClient, scanKey]);
  const { refetch: refetchScan } = scan;
  const rescan = useCallback((next: ScanIntent): void => {
    if (watcher.isLinking) return;
    if (scanning()) { if (next === "full") scanAgain.current = true; return; }
    intent.current = next;
    void refetchScan();
  }, [watcher, scanning, refetchScan]);
  const checkNow = (): void => { wake(); rescan("full"); };
  const save: typeof download.save = (name, body, type) => {
    wake();
    download.save(name, body, type);
    if (downloadScanDue(Date.now(), lastSentAt.current, paceMs())) rescan("background");
  };
  const answer = scan.data;
  const scanError = scan.isFetching ? null : scan.error;
  const preview = answer?.preview;
  const found = new Set((preview?.links ?? []).map((l) => l.asanaBoardId));
  const boards = guide.data?.boards ?? [];
  const own = boards.filter((b) => !b.nested);
  const allFound = own.length > 0 && own.every((b) => found.has(b.id));

  const { mutate: commitBoards } = commit;
  const slow = useSyncExternalStore(watcher.subscribe, () => watcher.pace === "slow", () => false);
  const [keepTags, setKeepTags] = useState(false);
  const [linkQueued, setLinkQueued] = useState(false);
  const pendingLink = useRef<AbortController | null>(null);
  const dropPendingLink = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    return () => pendingLink.current?.abort();
  }, []);
  const link = (force: boolean, allowed: (gates: LinkGates) => boolean): void => {
    if (!watcher.link()) return;
    const pending = new AbortController();
    const letGo = (): void => {
      if (pendingLink.current === pending) pendingLink.current = null;
      setLinkQueued(false);
    };
    pending.signal.addEventListener("abort", () => { letGo(); watcher.linked(); });
    pendingLink.current = pending;
    const queued = scanning();
    setLinkQueued(queued);
    const inFlight = queued ? refetchScan({ cancelRefetch: false }).then(() => undefined, () => undefined) : Promise.resolve();
    void inFlight.then(() => {
      if (pending.signal.aborted) return;
      letGo();
      if (!allowed(linkGates(queryClient.getQueryData<typeof answer>(scanKey), keepTags))) { watcher.linked(); return; }
      commitBoards({ migrationId, force });
    });
  };
  const watchLine = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const onBack = (): void => { if (focusScanDue(Date.now(), document.hidden, lastSentAt.current)) rescan("background"); };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    return () => {
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
    };
  }, [rescan]);
  const checkedAt = answer?.sentAt ?? null;
  const peopleChanged = useCallback(() => rescan("full"), [rescan]);

  const { asTag, unread: unreadBoards, tagGate, clear, movedBefore } = linkGates(answer, keepTags);
  const confirmAsked = commit.data?.status === "confirm";
  const waiting = allFound && !clear && !commit.isPending;
  const fixes = new Map((preview?.links ?? []).map((l) => [l.asanaBoardId, l.unmatched]));
  const listed = new Set([...fixes.values()].flat());
  const elsewhere = (preview?.blocking ?? []).filter((b) => !listed.has(b));

  const gone = new Set((preview?.gone ?? []).map((g) => g.id));
  const hints = new Map<string, string[]>();
  for (const h of preview?.hints ?? []) hints.set(h.id, [...(hints.get(h.id) ?? []), h.text]);
  const offered = (b: (typeof boards)[number]): boolean => Boolean(b.fileName && b.csv && (!b.linked || gone.has(b.id)));
  const todo = boards.filter((b) => !found.has(b.id) && !hints.has(b.id) && offered(b));
  const copies = boards.filter((b) => b.duplicateOf && !found.has(b.id) && !hints.has(b.id));
  const withFile = boards.filter(offered).length;
  const scanned = Boolean(answer);
  const downloadAll = (): void => {
    const only = todo.length === 1 ? todo[0]! : null;
    if (only) save(only.fileName!, () => only.csv!, CSV);
    else save(`plaky-boards-${migrationId}.zip`, () => zip([...todo.map((b) => ({ name: b.fileName!, text: b.csv! })), { name: INSTRUCTIONS_FILE, text: instructionsText([...todo, ...copies]) }]), "application/zip");
  };

  return (
    <>
      <Problem error={guide.error} title="Could not read the boards" />
      <Problem error={download.error} title="Could not save the file" />
      {todo.length ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid="download-all">
          <Go disabled={!scanned} onClick={downloadAll}>
            {!scanned ? (scanError ? "Plaky could not be checked" : "Checking Plaky first…") : todo.length === 1 ? `Download ${todo[0]!.fileName}`
              : todo.length === withFile ? `Download all ${todo.length} files (.zip)` : `Download the ${todo.length} files still to import (.zip)`}
          </Go>
          <Note>Fields and labels only. Items import later.</Note>
          {!scanned && scanError ? <Plain onClick={checkNow} disabled={scan.isFetching}>{scan.isFetching ? "Checking…" : "Check Plaky again"}</Plain> : null}
        </div>
      ) : null}
      {todo.length ? (
        <Block title={todo.length === 1 ? "Import in Plaky" : "Import each file in Plaky"} testId="setup-steps">
          <ol className="flex list-decimal flex-col gap-2 pl-5">{IMPORT_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
          <Note>{todo.length > 1 ? `${ANY_ORDER} ${ONCE}` : ONCE}</Note>
        </Block>
      ) : null}
      {copies.length ? (
        <Block title="Duplicate shared layouts" testId="duplicate-steps">
          <ol className="flex list-decimal flex-col gap-2 pl-5">{DUPLICATE_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
          <ul className="ml-5 list-disc" data-testid="duplicates">{copies.map((b) => <li key={b.id}>Duplicate “{b.duplicateOf}” as <strong className="font-semibold">{b.title}</strong></li>)}</ul>
          <Note>{DUPLICATE_FIRST}</Note>
        </Block>
      ) : null}
      <Grid head={["Project", "Tasks", "File", "In Plaky"]} align={["left", "right", "left", "left"]} testId="setup-boards">
        {own.map((b) => (
          <Row key={b.id}>
            <Cell>
              {b.name}
              {b.parent ? <span className="block text-[15px] text-cake-muted" data-testid={`subtasks-of-${b.id}`}>Subitems of {b.parent}</span> : null}
            </Cell>
            <Cell right>{items.get(b.id) ?? ""}</Cell>
            <Cell className="break-all text-[15px]">
              {b.duplicateOf ? <span className="text-cake-muted">Copy of {b.duplicateOf}</span> : !offered(b) ? <span className="text-cake-muted">{b.linked ? "Linked" : "No file needed"}</span>
                : found.has(b.id) ? <span className="text-cake-muted">{b.fileName}</span>
                  : <button type="button" disabled={!scanned} className={cn("text-left underline underline-offset-3 disabled:no-underline disabled:opacity-60", hints.has(b.id) ? "text-cake-muted" : "text-cake-brand-550")} onClick={() => save(b.fileName!, () => b.csv!, CSV)}>{b.fileName}</button>}
            </Cell>
            <Cell>
              {fixes.get(b.id)?.length ? <Status kind="flag"><strong>Found, needs a fix</strong></Status>
                : found.has(b.id) ? <Status kind="done">Found</Status> : gone.has(b.id) ? <Status kind="now"><strong>Deleted in Plaky: import again</strong></Status>
                  : hints.has(b.id) ? <Status kind="flag"><strong>In Plaky already?</strong></Status>
                  : b.duplicateOf ? <Status kind="now"><strong>To duplicate</strong></Status>
                  : offered(b) ? <Status kind="now"><strong>To import</strong></Status> : <Status kind="next">{b.linked ? "Linked" : "Comes with its board"}</Status>}
              {fixes.get(b.id)?.length ? <ul className="mt-1.5 flex flex-col gap-1 text-[15px]">{fixes.get(b.id)!.map((f, i) => <li key={`${i}:${f}`}><Explain text={f} /></li>)}</ul> : null}
              {hints.has(b.id) ? <ul className="mt-1.5 flex flex-col gap-1 text-[15px]" data-testid={`hint-${b.id}`}>{hints.get(b.id)!.map((h) => <li key={h}>{h}.</li>)}</ul> : null}
            </Cell>
          </Row>
        ))}
      </Grid>

      {todo.map((b) => <BoardTypes key={b.id} board={b} save={save} ready={scanned} />)}

      {guide.data?.buildGuide ? (
        <details className="print:hidden" data-testid="build-guide">
          <summary className="min-h-8 cursor-pointer">Full setup guide</summary>
          <pre className="mt-2 max-h-[480px] overflow-auto whitespace-pre-wrap rounded border border-cake-line bg-cake-grey-50 p-4 font-sans text-[15px]">{plainGuide(guide.data.buildGuide.split(/\r?\n/).filter((line) => !isLabelColorInstruction(line)).map(checklistText).join("\n"))}</pre>
        </details>
      ) : null}

      <PeopleChoices migrationId={migrationId} linked={again} onChanged={peopleChanged} />

      {unreadBoards.length ? (
        <Block title="Plaky could not be read for every board" testId="unread">
          {unreadBoards.map((i) => <div key={i.key} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><strong>{boards.find((b) => b.id === i.board)?.name ?? i.board}:</strong> <Explain text={i.text} /></div></div>)}
          <Note>Check again before linking: a board that could not be read has not been checked.</Note>
        </Block>
      ) : null}
      {asTag.length && !keepTags ? (
        <Block title="Convert to Status before linking" testId="as-tag">
          {asTag.map((i) => <div key={i.key} className="flex items-start gap-2"><span className="pt-1"><Mark kind="now" /></span><div><strong>{boards.find((b) => b.id === i.board)?.name ?? i.board}:</strong> <Explain text={i.text} /></div></div>)}
          <Note>Finish field setup before linking.</Note>
          <div><Plain onClick={() => setKeepTags(true)}>Keep as Tag</Plain></div>
        </Block>
      ) : null}
      {(preview?.links ?? []).flatMap((l) => l.warnings.map((w) => `${l.name}: ${w}`)).map((w, i) => <div key={`${i}:${w}`} className="text-sm text-cake-muted"><Explain text={w} /></div>)}

      {elsewhere.length ? (
        <ul className="flex flex-col gap-1.5" data-testid="blocking">
          {elsewhere.map((b, i) => <li key={`${i}:${b}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={b} /></div></li>)}
        </ul>
      ) : null}
      {commit.data?.status === "blocked" ? commit.data.blocking.map((b, i) => <div key={`${i}:${b}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={b} /></div></div>) : null}
      {clear ? (
        <div className="flex flex-wrap items-center gap-4">
          <Note>Field setup complete? Link the boards.</Note>
          <Go onClick={() => link(false, (g) => g.clear)} disabled={linkQueued || commit.isPending}>Link boards</Go>
        </div>
      ) : null}
      {movedBefore ? (
        <div className="flex flex-wrap items-center gap-4" data-testid="link-existing">
          <span>Match existing boards using their Asana items.</span>
          <Plain onClick={() => link(false, (g) => g.movedBefore && !g.tagGate)} disabled={scan.isFetching || commit.isPending || tagGate}>Link existing boards</Plain>
        </div>
      ) : null}
      {confirmAsked || preview?.needsConfirm ? (
        <div className="flex flex-wrap items-center gap-4" data-testid="confirm-relink">
          <span>This changes what an earlier link recorded, so data already moved could be re-pointed.</span>
          <Plain onClick={() => link(true, (g) => (confirmAsked || g.needsConfirm) && !g.tagGate)} disabled={scan.isFetching || commit.isPending || tagGate}>Link anyway</Plain>
        </div>
      ) : null}
      <Problem error={commit.error} title="Could not link" />
      <Problem error={scanError} title="Could not check Plaky" />

      <div ref={watchLine} className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[15px]" data-testid="watch">
        <Mark kind={allFound && !waiting ? "done" : "now"} />
        <span ref={dropPendingLink} role="status">
          {commit.isPending ? "Linking the boards…" : linkQueued ? "Linking after this check of Plaky…" : again && allFound && !preview?.needsConfirm ? `Every board is still in Plaky: nothing to set up again.` : waiting
            ? `All ${plural(own.length, "board")} found in Plaky; linking waits for what is above. Plaky is checked again every ${slow ? "2 minutes" : "30 seconds"}.`
            : allFound ? `All ${plural(own.length, "board")} found in Plaky.`
              : `Plaky is checked every ${slow ? "2 minutes" : "30 seconds"} while this page is open. ${own.filter((b) => found.has(b.id)).length} of ${plural(own.length, "board")} found.`}
        </span>
        {checkedAt !== null && !scan.isFetching ? <LastChecked at={checkedAt} /> : null}
        <Quiet onClick={checkNow} disabled={scan.isFetching || commit.isPending}>{scan.isFetching ? "Checking…" : "Check now"}</Quiet>
        {again ? null : <Quiet onClick={onChoose}>Choose other boards</Quiet>}
      </div>
    </>
  );
}

function secondClock(start: number) {
  let now = start;
  return {
    subscribe(changed: () => void): () => void {
      const tick = setInterval(() => { now = Date.now(); changed(); }, 1_000);
      return () => clearInterval(tick);
    },
    get: (): number => now,
  };
}

function LastChecked({ at }: { at: number }) {
  const [clock] = useState(() => secondClock(Date.now()));
  const now = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  return <span className="text-cake-muted" data-testid="last-checked">Last checked {agoText(now - at)}.</span>;
}

function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1_000));
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
}


function BoardTypes({ board, save, ready }: { board: SeedBoard; save: ReturnType<typeof useSave>["save"]; ready: boolean }) {
  const lines = typeLines(board.checklist);
  return (
    <Block title={board.name} testId={`setup-board-${board.id}`}>
      <p className="text-[15px]">
        <button type="button" disabled={!ready} className="text-left text-cake-brand-550 underline underline-offset-3 disabled:no-underline disabled:opacity-60" onClick={() => save(board.fileName!, () => board.csv!, CSV)}>{board.fileName}</button>
        {" "}→ rename “New board” to <strong>“{board.title ?? board.name}”</strong>
      </p>
      <div>
        In the import dialog, top to bottom:
        <ol className="mt-2.5 text-[15px]" data-testid={`types-${board.id}`}>
          {lines.map((l) => (
            <li key={l.field} className="flex flex-wrap gap-x-2 border-t border-cake-line py-1.5">
              <span>{l.field} → {l.master ? <strong>{l.path}</strong> : l.path}</span>
              {l.master ? <strong>({MASTER_NOTE})</strong> : null}
              {l.note ? <span className={l.master ? undefined : "text-cake-muted"}>{l.note}</span> : null}
            </li>
          ))}
        </ol>
      </div>
      {board.lossy?.length ? (
        <div className="text-[15px]" data-testid={`lossy-${board.id}`}>
          Imported as static values:
          <ul className="ml-5 list-disc">{board.lossy.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      ) : null}
    </Block>
  );
}

function PeopleLine({ migrationId }: { migrationId: number }) {
  const trpc = useTRPC();
  const people = useQuery(trpc.people.list.queryOptions({ migrationId }));
  const rows = people.data?.rows ?? [];
  if (people.error) return <> · who takes over the tasks of people Plaky cannot assign could not be read (reload to try again)</>;
  if (!rows.length) return null;
  const count = (c: string): number => rows.filter((r) => r.choice === c).length;
  const parts = [
    count("user") ? `${plural(count("user"), "person", "people")} given to a Plaky user` : "",
    count("header") ? `${plural(count("header"), "person", "people")} with their name kept as text` : "",
    count("other") ? `${plural(count("other"), "person", "people")} matched another way` : "",
    count("unassigned") ? `${plural(count("unassigned"), "person", "people")} left unassigned` : "",
    count("team") ? `${plural(count("team"), "person", "people")} on ${count("team") === 1 ? "a stand-in team" : "stand-in teams"}` : "",
  ].filter(Boolean);
  return parts.length ? <> · {parts.join(", ")}</> : null;
}

export const PeopleChoices = memo(function PeopleChoices({ migrationId, linked, onChanged }: { migrationId: number; linked: boolean; onChanged?: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const people = useQuery(trpc.people.list.queryOptions({ migrationId }));
  const changed = () => { void people.refetch(); void queryClient.invalidateQueries(trpc.provision.guide.queryFilter({ migrationId })); onChanged?.(); };
  const choose = useMutation(trpc.people.match.mutationOptions({ onSuccess: changed }));
  const everyone = useMutation(trpc.people.matchAll.mutationOptions({ onSuccess: changed }));
  if (!people.data?.rows.length) return <Problem error={people.error} title="Could not read the people" />;
  const busy = choose.isPending || everyone.isPending;
  return (
    <Block title="Unmatched people" testId="people">
      <Note>
        “Leave their tasks unassigned” discards original names.
        {linked ? " Add Text fields to keep names on existing boards." : ""}
      </Note>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[15px]" data-testid="people-everyone">
        <span>Apply to all:</span>
        <Quiet disabled={busy} onClick={() => everyone.mutate({ migrationId, to: "header" })}>Keep their names as text</Quiet>
        <Quiet disabled={busy} onClick={() => everyone.mutate({ migrationId, to: "team" })}>Use stand-in teams</Quiet>
        <Quiet disabled={busy} onClick={() => everyone.mutate({ migrationId, to: "unassigned" })}>Leave unassigned</Quiet>
      </div>
      <Grid head={["Person in Asana", "Their tasks go to"]}>
        {people.data.rows.map((r) => {
          const value = r.choice === "user" && r.plakyUserId !== null ? String(r.plakyUserId) : r.choice;
          const offered = people.data.users;
          const gone = r.choice === "user" && r.plakyUserId !== null && !offered.some((u) => u.id === r.plakyUserId);
          return (
            <Row key={r.asanaUserId}>
              <Cell>
                <span className="flex flex-col"><span>{r.name}</span><span className="text-sm text-cake-muted">{STATE_TEXT[r.state] ?? r.state}{r.email ? `, ${r.email}` : ""}</span></span>
              </Cell>
              <Cell>
                <select aria-label={`Who takes over ${r.name}’s tasks`} className={`${fieldClass} w-full min-w-0 max-w-full truncate`} value={value} disabled={busy}
                  onChange={(e) => { const v = e.target.value; choose.mutate({ migrationId, asanaUserId: r.asanaUserId, to: v === "unassigned" || v === "header" || v === "team" ? v : Number(v) }); }}>
                  <option value="header">{label("header")}</option>
                  <option value="unassigned">{label("unassigned")}</option>
                  <option value="team" disabled={linked && !r.teamExists}>{label("team", { placeholder: r.placeholder ?? r.name, mustExist: linked && !r.teamExists })}</option>
                  {r.choice === "other" ? <option value="other" disabled>{label("other", { other: r.other })}</option> : null}
                  {gone ? <option value={String(r.plakyUserId)} disabled>{`Plaky user #${r.plakyUserId} (no longer available)`}</option> : null}
                  {offered.map((u) => <option key={u.id} value={String(u.id)}>{`${u.name}, ${u.email}`}</option>)}
                </select>
                {r.choice === "team" && !r.teamExists && r.placeholder ? (
                  <p className="mt-2 flex items-start gap-2 text-[15px]"><Mark kind="now" /><span>Create an empty team named <strong>{r.placeholder}</strong>. Remove yourself to prevent notifications.</span></p>
                ) : null}
                {r.problem ? <div className="mt-2 text-sm"><Explain text={r.problem} /></div> : null}
              </Cell>
            </Row>
          );
        })}
      </Grid>
      <Problem error={[choose.error, everyone.error]} title="Could not save that" />
      <Problem error={people.error} title="Could not refresh people" />
    </Block>
  );
});
