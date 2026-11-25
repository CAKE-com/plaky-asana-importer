import type { UserDirectory } from "../transform/people";
import type { PlakyField } from "../transform/mapping";
import { forRow, valueHash, type WrittenView } from "../written";
import { blankIn, recordable } from "./compare";
import { isDict } from "../transform/pystr";

export type OwnedRow = { id: number; title?: string | null | undefined; group?: number | null | undefined; fields?: readonly { key: string; value?: unknown }[] | null | undefined };

export const emptyListed = (value: unknown): boolean =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (isDict(value) && Object.keys(value).length === 0);

export type RowOwnership = {
  others(asanaId: string, rowId: number, fields: Readonly<Record<string, unknown>>): string[];
  reasons(asanaId: string, row: OwnedRow): string[];
};

export function rowOwnership(written: WrittenView, fields: readonly PlakyField[], directory: UserDirectory | null, support: ReadonlySet<string>): RowOwnership {
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));
  const others = (asanaId: string, rowId: number, values: Readonly<Record<string, unknown>>): string[] => {
    const record = forRow(written, asanaId, rowId);
    return Object.entries(values).flatMap(([key, value]) => {
      const target = fieldByKey.get(key);
      if (support.has(key) || blankIn(value, target)) return [];
      const normalized = target ? recordable(value, target, directory) : value;
      return normalized !== null && record?.(key) !== valueHash(normalized) ? [target?.name ?? key] : [];
    });
  };
  return {
    others,
    reasons(asanaId, row) {
      const record = forRow(written, asanaId, row.id);
      if (record === undefined || record("__row") === undefined) return ["no record of what the app wrote there (it was written before this version kept one)"];
      const why: string[] = [];
      const changed = others(asanaId, row.id, Object.fromEntries((row.fields ?? []).map((f) => [f.key, f.value ?? null])));
      if (changed.length) why.push(`${changed.map((name) => `'${name}'`).join(", ")} changed in Plaky since the app wrote ${changed.length === 1 ? "it" : "them"}`);
      const title = record("__title");
      if (title === undefined) why.push("no record of the title the app gave it");
      else if (title !== valueHash(row.title ?? "")) why.push("its title was changed in Plaky");
      if (row.group != null && record("__group") !== undefined && record("__group") !== valueHash(row.group)) why.push("it was moved to another group in Plaky");
      return why;
    },
  };
}
