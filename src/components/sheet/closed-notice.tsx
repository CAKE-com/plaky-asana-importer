"use client";

import { useState, useSyncExternalStore } from "react";
import { takeClosed } from "@/lib/closed-notice";

type Closed = { keysDropped: boolean } | null;

function closedStore() {
  let taken: Closed | undefined;
  return {
    subscribe(changed: () => void): () => void {
      if (taken === undefined) { taken = takeClosed(); changed(); }
      return () => undefined;
    },
    get: (): Closed => taken ?? null,
  };
}

export function ClosedNotice() {
  const [store] = useState(closedStore);
  const closed = useSyncExternalStore(store.subscribe, store.get, store.get);
  return (
    <div role="status" className="print:hidden" data-testid="closed-notice">
      {closed ? <p className="mb-4 rounded border border-cake-line bg-white px-6 py-4">Migration closed: its local data was deleted{closed.keysDropped ? ", and its keys" : ""}.</p> : null}
    </div>
  );
}
