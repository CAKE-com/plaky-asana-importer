"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ASANA_TOKEN_REFUSED, PLAKY_KEY_PATH, PLAKY_KEY_REFUSED } from "@/lib/explain";
import { migrationStatus } from "@/lib/labels";
import { useTRPC } from "@/lib/trpc";
import { normalizeWebAddress, PLAKY_WEB_ADDRESS, PLAKY_WEB_ADDRESS_HINT, workspaceName } from "@/lib/web-address";
import { fieldClass, Go, Note, Problem, Quiet, Section } from "./bits";
import { ClosedNotice } from "./closed-notice";

export function ConnectOpen() {
  const trpc = useTRPC();
  const router = useRouter();
  const env = useQuery(trpc.connection.env.queryOptions());
  const list = useQuery(trpc.connection.list.queryOptions());
  const create = useMutation(trpc.connection.create.mutationOptions({ gcTime: 0, onSuccess: (r) => router.push(`/migrations/${r.migrationId}`) }));
  const [name, setName] = useState("");
  const [asanaToken, setAsanaToken] = useState("");
  const [plakyKey, setPlakyKey] = useState("");
  const [plakyWebBase, setPlakyWebBase] = useState("");
  const [addressLeft, leaveAddress] = useState(false);
  const address = normalizeWebAddress(plakyWebBase);
  const addressWrong = plakyKey.trim() !== "" && address !== "" && !PLAKY_WEB_ADDRESS.test(address);
  const ready = name.trim() && (asanaToken.trim() || env.data?.asanaToken) && (plakyKey.trim() || env.data?.plakyKey) && !addressWrong;
  const refused = { asana: create.error?.message === ASANA_TOKEN_REFUSED, plaky: create.error?.message === PLAKY_KEY_REFUSED };
  const edited = <T,>(set: (v: T) => void) => (v: T): void => { set(v); if (create.error) create.reset(); };
  const missing = [!name.trim() && "a migration name", !(asanaToken.trim() || env.data?.asanaToken) && "the Asana API token", !(plakyKey.trim() || env.data?.plakyKey) && "the Plaky API key"].filter(Boolean);
  const hint = env.isPending || create.isPending ? null : missing.length ? `Enter ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")} to connect.` : addressWrong && addressLeft ? "Correct the Plaky workspace address to connect." : null;
  return (
    <>
      <ClosedNotice />
      {list.data?.length ? (
        <section aria-labelledby="continue-heading" className="mb-4 rounded-lg border-2 border-cake-brand-500 bg-white px-6 py-5 print:hidden" data-testid="earlier">
          <h2 id="continue-heading" className="text-xl font-medium">Continue a migration</h2>
          <ul className="mt-3 flex flex-col gap-2" data-testid="migrations">
            {list.data.map((m) => (
              <li key={m.id} className="flex flex-wrap items-baseline gap-3">
                <Link prefetch={false} href={`/migrations/${m.id}`} className="text-[17px] font-semibold">Continue “{m.name}”</Link>
                <span className="text-cake-muted">{migrationStatus(m.status)}</span>
              </li>
            ))}
          </ul>
          <Note className="mt-3">Or start a new migration below.</Note>
        </section>
      ) : null}
      <Section n={1} title="Connect accounts" state="open">
        <div className="flex flex-col gap-5" data-testid="keys">
          <div className="flex max-w-[520px] flex-col gap-1.5">
            <label htmlFor="migration-name" className="text-[15px] font-semibold">Migration name</label>
            <input id="migration-name" type="text" autoComplete="off" maxLength={80} value={name} onChange={(e) => edited(setName)(e.target.value)} placeholder="e.g. Acme team" className={fieldClass} />
          </div>
          <KeyField id="asana-token" label="Asana API token" value={asanaToken} onChange={edited(setAsanaToken)} inEnv={env.data?.asanaToken ?? false} invalid={refused.asana} errorId="connect-error"
            how="In Asana: app.asana.com/0/my-apps → Create new token → Copy." />
          <KeyField id="plaky-key" label="Plaky API key" value={plakyKey} onChange={edited(setPlakyKey)} inEnv={env.data?.plakyKey ?? false} invalid={refused.plaky} errorId="connect-error"
            how={`In Plaky: ${PLAKY_KEY_PATH} → Generate API key.`} />
          {plakyKey.trim() ? (
            <div className="flex max-w-[520px] flex-col gap-1.5">
              <label htmlFor="plaky-web-base" className="text-[15px] font-semibold">Plaky workspace address</label>
              <input
                id="plaky-web-base" type="url" autoComplete="off" spellCheck={false} value={plakyWebBase} onChange={(e) => { edited(setPlakyWebBase)(e.target.value); leaveAddress(false); }} onBlur={() => leaveAddress(true)}
                aria-invalid={addressWrong && addressLeft} aria-describedby={addressWrong && addressLeft ? "plaky-web-base-error" : undefined}
                placeholder="https://yourcompany.plaky.com" className={fieldClass}
              />
              {addressWrong && addressLeft ? <span id="plaky-web-base-error" role="alert" className="text-sm text-cake-red-500">{PLAKY_WEB_ADDRESS_HINT.charAt(0).toUpperCase() + PLAKY_WEB_ADDRESS_HINT.slice(1)}.</span> : null}
              <span className="text-sm text-cake-muted">Optional. Adds board links to reports.</span>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-5">
          <Go aria-describedby={hint ? "connect-hint" : undefined} onClick={() => create.mutate({ name: name.trim(), asanaToken, plakyKey, plakyWebBase: plakyKey.trim() ? plakyWebBase : "" })} disabled={!ready || create.isPending || create.isSuccess}>{create.isPending ? "Connecting…" : "Connect"}</Go>
          <Note>Keys are not saved to disk.</Note>
        </div>
        {hint ? <Note id="connect-hint">{hint}</Note> : null}
        <Problem id="connect-error" error={create.error} title="Could not connect" />
        <Problem error={env.error} title="Could not read configured keys" />
      </Section>
      <Problem error={list.error} title="Could not read the earlier migrations" />
      <Section n={2} title="Set up boards" state="later"  />
      <Section n={3} title="Move and review" state="later"  />
    </>
  );
}

function KeyField({ id, label, how, value, onChange, inEnv, invalid = false, errorId }: { id: string; label: string; how: string; value: string; onChange: (v: string) => void; inEnv: boolean; invalid?: boolean; errorId?: string }) {
  return (
    <div className="flex max-w-[520px] flex-col gap-1.5">
      <label htmlFor={id} className="text-[15px] font-semibold">{label}</label>
      <input
        id={id} type="text" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"
        value={value} onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined}
        placeholder={inEnv ? "Leave blank to use configured key" : "Paste key"}
        className={`${fieldClass} [-webkit-text-security:disc]`}
      />
      <details className="text-sm text-cake-muted 2xl:hidden"><summary className="cursor-pointer">Get key</summary><p className="mt-2">{how}</p></details>
    </div>
  );
}

function KeysAgain({ migrationId, needed, change, onDone }: { migrationId: number; needed: { asana: boolean; plaky: boolean }; change?: { why: string | null }; onDone?: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const rekey = useMutation(trpc.connection.rekey.mutationOptions({ gcTime: 0, onSuccess: () => { onDone?.(); void queryClient.invalidateQueries(); } }));
  const [asanaToken, setAsanaToken] = useState("");
  const [plakyKey, setPlakyKey] = useState("");
  const asana = needed.asana || Boolean(change);
  const plaky = needed.plaky || Boolean(change);
  const missing = change ? !asanaToken.trim() && !plakyKey.trim() : (needed.asana && !asanaToken.trim()) || (needed.plaky && !plakyKey.trim());
  return (
    <Section n={1} title="Connect accounts" state="open">
      <div className="flex flex-col gap-5" data-testid="keys-again">
        <Note>{change ? `${change.why ? `${change.why} ` : ""}Enter the new key; leave a field blank to keep the key you entered before.` : "Re-enter your keys to continue. Progress is saved."}</Note>
        {asana ? <KeyField id="asana-token" label="Asana API token" value={asanaToken} onChange={setAsanaToken} inEnv={false} invalid={rekey.error?.message === ASANA_TOKEN_REFUSED} errorId="rekey-error" how="In Asana: app.asana.com/0/my-apps → Create new token → Copy." /> : null}
        {plaky ? <KeyField id="plaky-key" label="Plaky API key" value={plakyKey} onChange={setPlakyKey} inEnv={false} invalid={rekey.error?.message === PLAKY_KEY_REFUSED} errorId="rekey-error" how={`In Plaky: ${PLAKY_KEY_PATH} → Generate API key.`} /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-5">
        <Go onClick={() => rekey.mutate({ migrationId, asanaToken, plakyKey })} disabled={rekey.isPending || missing}>{rekey.isPending ? "Checking…" : "Continue"}</Go>
        {change && onDone ? <Quiet onClick={onDone} disabled={rekey.isPending}>Cancel</Quiet> : null}
      </div>
      <Problem id="rekey-error" error={rekey.error} title="Could not use these keys" />
    </Section>
  );
}

const refusedSentence = (error: { message: string } | null): string | null =>
  error && [PLAKY_KEY_REFUSED, ASANA_TOKEN_REFUSED].includes(error.message) ? error.message : null;

export function ConnectClosed({ migrationId }: { migrationId: number }) {
  const trpc = useTRPC();
  const env = useQuery(trpc.connection.env.queryOptions());
  const stored = useQuery(trpc.connection.get.queryOptions({ migrationId }));
  const queryClient = useQueryClient();
  const check = useMutation(trpc.connection.check.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries(trpc.plan.latest.queryFilter({ migrationId })) }));
  const [changing, setChanging] = useState(false);
  const base = stored.data?.connection.plakyWebBase ?? (stored.data?.connection.typedPlakyKey ? null : env.data?.plakyWebBase ?? null);
  const address = workspaceName(base) && base ? base.replace(/^https:\/\//, "") : null;
  const summary = stored.data
    ? `Asana: ${check.data?.account ?? stored.data.connection.account} (${check.data?.user ?? stored.data.connection.user}) · Plaky: ${[address ? `address ${address}` : null, check.data?.plakyUser].filter(Boolean).join(" · ") || "connected"}`
    : "…";
  const needed = stored.data && env.data
    ? { asana: !stored.data.keysHeld.asana && !env.data?.asanaToken, plaky: !stored.data.keysHeld.plaky && !env.data?.plakyKey } : null;
  if (needed && (needed.asana || needed.plaky)) return <KeysAgain migrationId={migrationId} needed={needed} />;
  const refused = refusedSentence(check.error);
  if (changing || refused) {
    return <KeysAgain migrationId={migrationId} needed={{ asana: false, plaky: false }} change={{ why: refused }} onDone={() => { setChanging(false); check.reset(); }} />;
  }
  return (
    <>
      <Section
        n={1} title="Connect accounts" state="closed" summary={check.data ? `${summary} · checked just now` : summary}
        action={
          <div className="flex flex-wrap gap-3">
            <Quiet onClick={() => check.mutate({ migrationId })} disabled={check.isPending}>{check.isPending ? "Checking…" : "Check again"}</Quiet>
            <Quiet onClick={() => setChanging(true)}>Change keys</Quiet>
          </div>
        }
      />
      <Problem error={check.error} title="Connection check failed" />
      <Problem error={stored.error} title="Could not read this migration's connection" />
      <Problem error={env.error} title="Could not read configured keys" />
    </>
  );
}
