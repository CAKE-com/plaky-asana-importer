"use client";

import { cn } from "cn";
import { explainMessage, PLAKY_KEY_PATH, Said, type Explained } from "@/lib/explain";
import { notFound } from "next/navigation";
import { createContext, use, useContext, useId } from "react";

const SheetId = createContext("sheet");

export function useMigrationId(params: Promise<{ id: string }>): number {
  const { id } = use(params);
  if (!/^[1-9]\d{0,9}$/.test(id)) notFound();
  return Number(id);
}

export function Progress({ done, planned }: { done: number; planned: number }) {
  return (
    <div role="progressbar" aria-label="Changes completed" aria-valuemin={0} aria-valuemax={planned} aria-valuenow={done} className="h-1.5 overflow-hidden rounded-full bg-cake-grey-250">
      <div className="h-full rounded-full bg-cake-brand-500" style={{ width: `${planned ? Math.min(100, Math.round((100 * done) / planned)) : 0}%` }} />
    </div>
  );
}

export type MarkKind = "done" | "next" | "now" | "flag";

const MARK_COLOUR: Record<MarkKind, string> = { done: "text-cake-brand-500", now: "text-cake-brand-500", next: "text-cake-grey-670", flag: "text-cake-red-500" };

export function Mark({ kind }: { kind: MarkKind }) {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" className={cn("flex-none", MARK_COLOUR[kind])}>
      {kind === "done" ? <circle cx="8" cy="8" r="5" fill="currentColor" /> : null}
      {kind === "next" ? <circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
      {kind === "now" ? <><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="8" r="2.5" fill="currentColor" /></> : null}
      {kind === "flag" ? <><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="M8 4.5v4.5M8 11v.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></> : null}
    </svg>
  );
}

export function Status({ kind, children }: { kind: MarkKind; children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-2"><Mark kind={kind} />{children}</span>;
}

export function Section({ n, title, state, summary, action, children }: {
  n: number; title: string; state: "open" | "closed" | "later"; summary?: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode;
}) {
  const sheetId = useContext(SheetId);
  return (
    <section
      aria-labelledby={`${sheetId}-s${n}`} data-testid={`section-${n}`} data-state={state}
      className={cn("mb-4 flex gap-3 rounded-lg border border-cake-line bg-white sm:gap-4 print:mb-0 print:rounded-none print:border-x-0 print:border-b-0", state === "open" ? "p-4 sm:p-6" : "px-4 py-4 sm:px-6", state === "later" && "bg-cake-grey-50 text-cake-muted")}
    >
      <div
        aria-hidden="true"
        className={cn("flex size-8 flex-none items-center justify-center rounded-full text-[15px] font-medium tabular-nums", state === "open" ? "bg-cake-brand-50 text-cake-brand-550" : "border border-cake-grey-250 bg-cake-grey-50 text-cake-muted")}
      >{n}</div>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1">
          <h2 id={`${sheetId}-s${n}`} className="scroll-mt-6 text-xl font-medium">{title}</h2>
          {summary ? <span className="text-[15px] text-cake-muted">{summary}</span> : null}
          {action ? <span className="ml-auto text-sm print:hidden">{action}</span> : null}
        </div>
        {state === "open" ? <div className="mt-5 flex flex-col gap-5">{children}</div> : null}
      </div>
    </section>
  );
}

const BUTTON = "inline-flex min-h-10 items-center justify-center gap-2 rounded border text-[15px] font-medium no-underline transition-colors disabled:cursor-not-allowed disabled:border-cake-grey-250 disabled:bg-cake-grey-50 disabled:text-cake-grey-500 print:hidden";

export const buttonClass = {
  cta: `${BUTTON} border-transparent bg-cake-brand-500 px-5 text-white hover:bg-cake-brand-550 active:bg-cake-brand-700`,
  primary: `${BUTTON} border-cake-brand-100 bg-cake-brand-50 px-4 text-cake-brand-550 hover:bg-cake-brand-100 active:bg-cake-brand-100`,
  secondary: `${BUTTON} border-cake-grey-250 bg-cake-grey-50 px-4 text-cake-ink hover:bg-cake-grey-150 active:bg-cake-grey-200`,
  quiet: `${BUTTON} min-h-8 border-transparent bg-transparent px-2 text-cake-brand-550 hover:border-cake-grey-250 hover:bg-cake-grey-150 active:bg-cake-grey-200`,
  danger: `${BUTTON} border-cake-red-500 bg-cake-red-500 px-5 text-white hover:border-cake-red-700 hover:bg-cake-red-700`,
} as const;

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

export function Go({ children, className, ...rest }: ButtonProps) {
  return <button type="button" {...rest} className={cn(buttonClass.cta, className)}>{children}</button>;
}

export function Plain({ children, className, ...rest }: ButtonProps) {
  return <button type="button" {...rest} className={cn(buttonClass.secondary, className)}>{children}</button>;
}

export function Quiet({ children, className, ...rest }: ButtonProps) {
  return <button type="button" {...rest} className={cn(buttonClass.quiet, className)}>{children}</button>;
}

export function Danger({ children, className, ...rest }: ButtonProps) {
  return <button type="button" {...rest} className={cn(buttonClass.danger, className)}>{children}</button>;
}

export const fieldClass = "min-h-10 rounded border border-cake-grey-500 bg-white px-3 text-cake-ink hover:border-cake-grey-670 focus-visible:border-cake-brand-500 focus-visible:ring-2 focus-visible:ring-cake-brand-100 focus-visible:outline-none";

export function Note({ children, className, testId, id }: { children: React.ReactNode; className?: string; testId?: string; id?: string }) {
  return <p id={id} className={cn("text-sm text-cake-muted", className)} data-testid={testId}>{children}</p>;
}

export function Block({ title, children, testId, className }: { title?: string; children: React.ReactNode; testId?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 border-t border-cake-line pt-4", className)} data-testid={testId}>
      {title ? <h3 className="text-[17px] font-semibold">{title}</h3> : null}
      {children}
    </div>
  );
}

export function Grid({ head, align, children, testId }: { head: string[]; align?: ("left" | "right")[]; children: React.ReactNode; testId?: string }) {
  return (
    <div className="overflow-x-auto rounded border border-cake-line print:overflow-visible">
      <table className="w-full border-collapse tabular-nums" data-testid={testId}>
        <thead className="bg-cake-grey-50">
          <tr>{head.map((h, i) => <th key={`${i}:${h}`} scope="col" className={cn("py-2 pr-3 text-[13px] font-medium text-cake-muted first:pl-3", align?.[i] === "right" ? "text-right" : "text-left")}>{h || <span className="sr-only">Result</span>}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cn("py-3 pr-3 align-top first:pl-3", right && "text-right", className)}>{children}</td>;
}

export function Row({ children }: { children: React.ReactNode }) {
  return <tr className="border-t border-cake-line">{children}</tr>;
}

type Failure = { message: string; data?: unknown } | null | undefined;

function explainFailure(error: { message: string; data?: unknown }): Explained {
  const data = error.data as { httpStatus?: unknown; technical?: unknown } | null | undefined;
  if (data && typeof data === "object" && "httpStatus" in data) return { text: error.message, technical: typeof data.technical === "string" ? data.technical : null };
  if (error instanceof Said) return { text: error.message, technical: null };
  const out = explainMessage(error.message);
  return out.technical ? out : { text: "Something went wrong on this page. Reload it; if it keeps happening, send the technical details to support.", technical: out.text };
}

function Technical({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <details className="mt-1 text-sm text-cake-muted print:hidden">
      <summary className="cursor-pointer">Technical details</summary>
      <div className="mt-1 break-words font-mono text-xs">{text}</div>
    </details>
  );
}

export function Problem({ error, title, id }: { error: Failure | readonly Failure[]; title: string; id?: string }) {
  const errors = (Array.isArray(error) ? error : [error]).filter((e): e is { message: string; data?: unknown } => !!e);
  const seen = new Set<string>();
  const said = errors.map(explainFailure).filter((e) => (seen.has(e.text) ? false : (seen.add(e.text), true)));
  if (!said.length) return null;
  return (
    <div id={id} role="alert" className="flex items-start gap-2 rounded border border-cake-red-500/30 bg-cake-red-10 px-3 py-2 text-[15px]">
      <span className="pt-1"><Mark kind="flag" /></span>
      <div className="flex min-w-0 flex-col gap-1">
        {said.map((e) => <div key={e.text}><strong className="font-medium">{title}.</strong> {e.text}<Technical text={e.technical} /></div>)}
      </div>
    </div>
  );
}

export function Explain({ text }: { text: string }) {
  const out = explainMessage(text);
  return <>{out.text}<Technical text={out.technical} /></>;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function clock(ms: number, now: number = Date.now(), alwaysDate = false): string {
  if (!Number.isFinite(ms)) return "an unknown time";
  const at = new Date(ms);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  const day = !alwaysDate && at.toDateString() === new Date(now).toDateString() ? "" : `${at.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, `;
  return `${day}${time} (${at.toISOString().slice(11, 16)} UTC)`;
}

export function Sheet({ children, footer, title, step, help }: {
  children: React.ReactNode; footer?: React.ReactNode; title?: string | undefined;
  step?: 1 | 2 | 3 | 4; help?: React.ReactNode;
}) {
  const sheetId = `sheet-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const steps = ["Connect accounts", "Set up boards", "Move and review", "Finish"];
  return (
    <SheetId value={sheetId}><div className="sheet min-h-full flex-1 bg-cake-ground text-cake-ink print:bg-white">
      <a href={`#${sheetId}-content`} className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:bg-white focus:p-3">Skip to migration</a>
      <header className="border-b border-cake-line bg-white px-5 py-4 sm:px-8 print:border-0">
        <div className="mx-auto flex max-w-[1480px] flex-wrap items-center gap-x-5 gap-y-1">
          <span className="text-sm text-cake-muted">Import from Asana</span>
          <span className="ml-auto hidden text-sm text-cake-muted sm:block">Asana stays unchanged</span>
        </div>
      </header>
      <div className="migration-layout mx-auto grid max-w-[1544px] items-start gap-6 px-4 py-7 sm:px-8 print:block print:p-0">
        {step ? <nav aria-label="Migration steps" className="migration-steps print:hidden">
          <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-cake-muted">Steps</p>
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-1">
            {steps.map((label, i) => <li key={label} className="min-w-0">
              {i + 1 <= step ? <a href={`#${sheetId}-s${i + 1}`} aria-current={i + 1 === step ? "step" : undefined} className="step-link">
                <span className="step-number" aria-hidden="true">{i + 1 < step ? "✓" : i + 1}</span>{label}
              </a> : <span className="step-link text-cake-muted"><span className="step-number" aria-hidden="true">{i + 1}</span>{label}</span>}
            </li>)}
          </ol>
        </nav> : <div className="hidden 2xl:block" />}
        <main id={`${sheetId}-content`} className="min-w-0">
          <div className="mb-6">
            <h1 className="text-[26px] leading-tight font-semibold">{title ?? "Move your work to Plaky"}</h1>
          </div>
          {children}
          <footer className="flex flex-wrap items-start justify-between gap-4 pt-5 text-xs text-cake-muted print:hidden">
            {footer}
            <span data-testid="version">Asana to Plaky Migrator {process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}</span>
          </footer>
        </main>
        <aside aria-label="Migration help" className="migration-help print:hidden">
          <p className="mb-3 text-sm font-semibold">Help</p>
          <details className="help-card"><summary>API keys</summary><div>
            <p><strong>Asana token</strong></p><p>In Asana: app.asana.com/0/my-apps → Create new token.</p>
            <p><strong>Plaky API key</strong></p><p>In Plaky: {PLAKY_KEY_PATH} → Generate API key.</p>
            <p>Keys stay in memory while the app runs.</p>
          </div></details>
          <details className="help-card"><summary>Import structure</summary><div>
            <p>Projects → boards. Sections → groups. Tasks → items.</p>
            <p>Subtasks → nested subitems or separate boards. Archived projects → Archived group.</p>
            <p>My Tasks → boards for tasks outside projects.</p>
          </div></details>
          {help}
        </aside>
      </div>
    </div></SheetId>
  );
}

export function statusRefetchMs(status: { active: boolean; waiting: unknown; schedule?: unknown } | undefined): number | false {
  return status?.active ? 1000 : status?.waiting || status?.schedule ? 30_000 : false;
}

export function saveFile(name: string, body: string | Uint8Array<ArrayBuffer>, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
