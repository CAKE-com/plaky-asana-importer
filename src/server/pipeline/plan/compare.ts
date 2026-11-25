import Decimal from "decimal.js";
import type { ColumnValue, ExtractedColumn } from "../extract";
import { PLAKY_TYPE_LABEL, compatibleTypes, preferredType, singleSelect } from "../transform/compat";
import { asId, clearValue, normalizeStamp, titleByKey, titleKey, type PlakyField } from "../transform/mapping";
import { isDict, pyDecimal, pyStrip, truthy } from "../transform/pystr";
import { sortedStrings, strOf } from "../transform/pyvalue";
import { fromIsoFormat } from "../transform/isotime";
import { UserDirectory } from "../transform/people";
import { SyncSetupError, own } from "./writes";
import { valueHash } from "../written";

export function findField(fields: readonly PlakyField[], wanted: string | null | undefined): PlakyField | null {
  if (!wanted) return null;
  const byKey = fields.filter((candidate) => candidate.key === wanted);
  if (byKey.length === 1) return byKey[0] ?? null;
  const exact = fields.filter((candidate) => candidate.name === wanted);
  if (exact.length === 1) return exact[0] ?? null;
  const target = titleKey(wanted);
  const matches = fields.filter((candidate) => titleKey(candidate.name) === target);
  if (matches.length > 1) {
    throw new SyncSetupError(
      `field name '${wanted}' is ambiguous on the Plaky board; rename one of the matching fields or map it by its field key`,
    );
  }
  return matches[0] ?? null;
}

export function holdsValue(cv: ColumnValue | null | undefined): boolean {
  return [cv?.["text"], cv?.["display_value"]].some((text) => typeof text === "string" && pyStrip(text) !== "");
}

export function uncarriedLine(column: ExtractedColumn, why: string, held: number, fields: readonly PlakyField[], taken: ReadonlySet<string>): string {
  const head = `${column.title} (${column.id}): ${why}; ${held} item(s) hold a value in Asana.`;
  const named = fields.filter((f) => titleKey(f.name) === titleKey(column.title));
  const first = named[0];
  if (first === undefined) {
    const preferred = preferredType(column.type) ?? "";
    const wanted = column.type === "dropdown" && singleSelect(column) ? "Dropdown" : Object.hasOwn(PLAKY_TYPE_LABEL, preferred) ? PLAKY_TYPE_LABEL[preferred] : "Text";
    return `${head} In Plaky, add a ${wanted} field named '${column.title}' to the board (the + at the right end of its header row), then run link again.`;
  }
  if (named.length === 1 && !taken.has(first.key) && compatibleTypes(column.type).includes(first.type)) {
    return `${head} Run link again to pair it with the Plaky field of that name.`;
  }
  return `${head} Fix that in Plaky, then run link again.`;
}

function pyEquals(a: unknown, b: unknown): boolean {
  const num = (v: unknown): unknown => (typeof v === "boolean" ? Number(v) : v);
  const dec = (v: unknown): Decimal | null => (v instanceof Decimal ? v : typeof v === "boolean" ? new Decimal(Number(v)) : null);
  if (a instanceof Decimal || b instanceof Decimal) return dec(a)?.eq(dec(b) ?? NaN) ?? false;
  if (typeof a === "boolean" || typeof b === "boolean") return num(a) === num(b);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => pyEquals(v, b[i]));
  if (isDict(a) || isDict(b)) {
    if (!isDict(a) || !isDict(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && pyEquals(a[k], b[k]));
  }
  return (a ?? null) === (b ?? null);
}

function utcOffset(value: string): number | null {
  const stamp = fromIsoFormat(value.replaceAll("Z", "+00:00"));
  return stamp && stamp.offset !== null ? stamp.offset + (stamp.offsetMicro ?? 0) / 1e6 : null;
}

const asList = (value: unknown): unknown[] => (truthy(value) && Array.isArray(value) ? value : []);

export function comparable(value: unknown, target: PlakyField, directory: UserDirectory | null = null): unknown {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  if (target.type === "STATUS" || target.type === "TAG") {
    const titles = titleByKey(target);
    const empty = new Set(target.labelsByKey.filter(([, title]) => !title).map(([key]) => key));
    const items = (Array.isArray(value) ? value : [value]).map(strOf).filter((v) => !empty.has(v));
    if (items.length === 0) return null;
    return sortedStrings([...new Set(items.map((v) => titles.get(v) ?? v))]);
  }
  if (target.type === "NUMBER") {
    return pyPDecimal(value) ?? value;
  }
  if (target.type === "DATE_TIME" && typeof value === "string") {
    return [normalizeStamp(value) || value, utcOffset(value)];
  }
  if (target.type === "LINK") {
    if (!isDict(value)) return truthy(value) ? value : null;
    const url = truthy(value["url"]) ? value["url"] : "";
    if (!url) return null;
    return [url, truthy(value["displayText"]) ? value["displayText"] : url];
  }
  if (target.type === "PERSON") {
    if (!isDict(value) || directory === null) return null;
    const users = new Set<number>();
    for (const entry of asList(value["users"])) {
      if (!isDict(entry)) continue;
      const userId = entry["id"] !== null && entry["id"] !== undefined ? asId(entry["id"]) : (directory.resolve(entry["email"] as string | null | undefined)?.id ?? null);
      if (userId !== null) users.add(userId);
    }
    for (const u of asList(value["assignedUsers"])) {
      const userId = asId(u);
      if (userId !== null) users.add(userId);
    }
    const teams = new Set<number>();
    for (const t of [...asList(value["teams"]), ...asList(value["assignedTeams"])]) {
      const teamId = asId(t);
      if (teamId !== null) teams.add(teamId);
    }
    const sorted = (ids: Set<number>): number[] => [...ids].sort((a, b) => a - b);
    return users.size || teams.size ? [sorted(users), sorted(teams)] : null;
  }
  return value;
}

function pyPDecimal(value: unknown): Decimal | null {
  const parsed = pyDecimal(strOf(value));
  return parsed?.kind === "num" ? parsed.value : null;
}

export function sameValues(
  wanted: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  targets: ReadonlyMap<string, PlakyField>,
  directory: UserDirectory | null = null,
): boolean {
  for (const [key, value] of Object.entries(wanted)) {
    const target = targets.get(key);
    if (target === undefined) return false;
    if (target.type === "PERSON" && directory === null) return false;
    if (!pyEquals(comparable(own(current, key), target, directory), comparable(value, target, directory))) return false;
  }
  return true;
}

export function withoutClears<V>(fields: Readonly<Record<string, V>>, targets: ReadonlyMap<string, PlakyField>): Record<string, V> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => {
      const target = targets.get(key);
      return target === undefined || !pyEquals(value, clearValue(target));
    }),
  );
}

export function planFields(
  desired: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  targets: ReadonlyMap<string, PlakyField>,
  directory: UserDirectory | null,
  options: { record?: { get(key: string): string | undefined } | undefined; partial?: ReadonlySet<string> } = {},
): { changes: Record<string, unknown>; hashes: Record<string, string>; emptied: PlakyField[]; left: string[] } {
  const changes: Record<string, unknown> = {};
  const hashes: Record<string, string> = {};
  const emptied: PlakyField[] = [];
  const left: string[] = [];
  for (const [key, value] of Object.entries(desired)) {
    const target = targets.get(key);
    if (target === undefined || (target.type === "PERSON" && directory === null)) {
      if (!sameValues({ [key]: value }, current, targets, directory)) {
        changes[key] = value;
        hashes[key] = valueHash(value);
      }
      continue;
    }
    const want = recordable(value, target, directory);
    const have = recordable(own(current, key), target, directory);
    if (pyEquals(want, have)) continue;
    if (want === null) {
      emptied.push(target);
      continue;
    }
    const last = options.record?.get(key);
    if (have === null) {
      if (last !== undefined && last !== valueHash(null)) {
        left.push(`'${target.name}' was cleared in Plaky since the app wrote it, so it stays empty; Asana has a value there`);
        continue;
      }
    } else {
      if (options.partial?.has(key)) {
        left.push(`'${target.name}': Asana did not give all of it (a task it would not name), so Plaky keeps its value`);
        continue;
      }
      if (options.record !== undefined && last !== valueHash(have)) {
        left.push(`'${target.name}' was changed in Plaky since the app wrote it (or before this version kept a record), so Plaky keeps its value; Asana's differs`);
        continue;
      }
    }
    changes[key] = value;
    hashes[key] = valueHash(want);
  }
  return { changes, hashes, emptied, left };
}

function blankAsEmpty(normalized: unknown): unknown {
  if (typeof normalized !== "string") return normalized;
  const text = normalized.replace(/<[^>]*>/g, "").replace(/&(?:nbsp|#0*160|#x0*a0|#0*65279|#x0*feff);/gi, " ").replace(/[\u00a0\ufeff]/g, " ");
  return text.trim() === "" ? null : normalized;
}

export function recordable(value: unknown, target: PlakyField, directory: UserDirectory | null = null): unknown {
  const normalized = comparable(value, target, directory);
  return target.type === "RICH_TEXT" ? blankAsEmpty(normalized) : normalized;
}

export function cellHash(target: PlakyField | undefined, value: unknown, directory: UserDirectory | null = null): string | null {
  const normalized = target === undefined ? value : recordable(value, target, directory);
  return normalized === null || normalized === undefined ? null : valueHash(normalized);
}

const blankShape = (value: unknown): boolean =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (isDict(value) && Object.values(value).every(blankShape));

export function blankIn(value: unknown, target: PlakyField | undefined): boolean {
  return blankShape(value) || (target !== undefined && target.type !== "PERSON" && recordable(value, target) === null);
}
