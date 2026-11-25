"use client";

import { useCallback, useRef, useState } from "react";
import { cn } from "cn";
import { explainMessage } from "@/lib/explain";

const ROW = 24;
const LEVEL_WORD: Readonly<Record<string, string>> = { error: "Failed:", ambiguous: "Outcome unknown:", warn: "Note:" };
const VIEW = 336;

export type LogRow = { id: number; level: string; code: string; message: string; board: string | null };

export function VirtualLog({ rows }: { rows: readonly LogRow[] }) {
  const [top, setTop] = useState(0);
  const follow = useRef<"following" | "reading">("following");
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el && rows.length && follow.current === "following") el.scrollTop = el.scrollHeight;
  }, [rows.length]);
  const first = Math.max(0, Math.floor(top / ROW) - 5);
  const last = Math.min(rows.length, Math.ceil((top + VIEW) / ROW) + 5);
  return (
    <div
      ref={ref}
      role="log"
      aria-label="Run log"
      tabIndex={0}
      className="overflow-auto rounded border border-cake-line bg-white font-mono text-xs focus-visible:ring-2 focus-visible:ring-cake-brand-100 focus-visible:outline-none"
      style={{ height: VIEW }}
      onScroll={(e) => {
        const el = e.currentTarget;
        setTop(el.scrollTop);
        follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW ? "following" : "reading";
      }}
    >
      <div style={{ height: rows.length * ROW, position: "relative" }}>
        {rows.slice(first, last).map((r, i) => {
          const said = explainMessage(r.message);
          return (
            <div
              key={r.id}
              title={said.technical ? `${r.code}: ${said.technical}` : said.text}
              className={cn("absolute left-0 right-0 truncate px-2 leading-6", (r.level === "error" || r.level === "ambiguous") && "text-cake-red-500", r.level === "warn" && "text-cake-warn")}
              style={{ top: (first + i) * ROW, height: ROW }}
            >
              {LEVEL_WORD[r.level] ? <strong className="font-semibold">{LEVEL_WORD[r.level]} </strong> : null}{r.board ? `${r.board}: ` : ""}{said.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
