"use client";

import { useState, useSyncExternalStore } from "react";
import { z } from "zod";

const options = z.object({
  syncComments: z.boolean(), syncFiles: z.boolean(), syncSubscribers: z.boolean(), paidAsana: z.boolean(), withCreated: z.boolean(), withLink: z.boolean(),
  subitems: z.enum(["auto", "board", "nested"]),
});
const draftSchema = z.object({ selected: z.array(z.string()), spaceId: z.number().int().positive().nullable(), includeMyTasks: z.boolean(), options });
type Draft = z.infer<typeof draftSchema>;
const EVENT = "migration-setup-draft";
const UNAVAILABLE = "storage-unavailable";
function subscribe(update: () => void) {
  window.addEventListener(EVENT, update);
  window.addEventListener("storage", update);
  return () => { window.removeEventListener(EVENT, update); window.removeEventListener("storage", update); };
}
const serverSnapshot = () => null;

export function useSetupDraft(identity: string, revision: string) {
  const key = `migration-setup:${identity}`;
  const [memory, setMemory] = useState<{ key: string; revision: string; draft: Draft | null; failed: boolean } | null>(null);
  const raw = useSyncExternalStore(subscribe, () => {
    try { return sessionStorage.getItem(key); } catch { return UNAVAILABLE; }
  }, serverSnapshot);
  let draft: Draft | null = null;
  let invalid = false;
  if (raw && raw !== UNAVAILABLE) {
    try {
      const saved = z.object({ revision: z.string(), draft: draftSchema }).parse(JSON.parse(raw));
      if (saved.revision === revision) draft = saved.draft;
    } catch { invalid = true; }
  }
  const local = memory?.key === key && memory.revision === revision ? memory : null;
  if (local) draft = local.draft;
  const save = (next: Draft | null) => {
    let failed = false;
    try {
      if (next) sessionStorage.setItem(key, JSON.stringify({ revision, draft: next }));
      else sessionStorage.removeItem(key);
    } catch { failed = true; }
    setMemory(failed ? { key, revision, draft: next, failed } : null);
    window.dispatchEvent(new Event(EVENT));
  };
  return {
    draft, save, clear: () => save(null),
    warning: raw === UNAVAILABLE || local?.failed ? "Choices cannot be saved in this tab. Keep this page open until projects are read."
      : invalid ? "Saved choices could not be restored. Review the selected projects and Space." : null,
  };
}
