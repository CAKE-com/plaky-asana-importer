import type { ExtractedColumn } from "../extract";
import { isDict, parseJsonOrdered, pyOr, pyStr, pyStrip, type OrderedJson } from "./pystr";

export const COMPAT: Readonly<Record<string, readonly string[]>> = {
  text: ["STRING", "RICH_TEXT"],
  long_text: ["RICH_TEXT", "STRING"],
  numbers: ["NUMBER", "STRING"],
  status: ["STATUS", "TAG", "STRING"],
  dropdown: ["TAG", "STRING"],
  tags: ["TAG", "STRING"],
  people: ["PERSON"],
  date: ["DATE_TIME", "STRING"],
  link: ["LINK", "STRING"],
  creation_log: ["DATE_TIME", "STRING"],
  last_updated: ["DATE_TIME", "STRING"],
  time_tracking: [],
  file: [],
};

const LOSSY_REASON: Readonly<Record<string, string>> = {};

export const lossyColumns = (columns: readonly { title: string; type: string; plakyType: string | null }[]): string[] =>
  columns.flatMap((c) => (c.plakyType !== null && LOSSY_REASON[c.type] ? [`${c.title}: ${LOSSY_REASON[c.type]}`] : []));

export const UNMAPPABLE_REASON: Readonly<Record<string, string>> = {
  time_tracking: "time tracked in Asana (a Timer field) is not carried: Plaky has no time-tracking field, and time tracking is left out by decision",
  file: "Plaky has no file field: with sync_files on, the files arrive as item files",
};

export const PLAKY_TYPE_LABEL: Readonly<Record<string, string>> = {
  STRING: "Text",
  RICH_TEXT: "Rich Text",
  NUMBER: "Numbers",
  STATUS: "Status",
  TAG: "Tag",
  PERSON: "Person",
  DATE_TIME: "Date",
  TIMELINE: "Timeline",
  LINK: "Link",
};

const UNKNOWN_FALLBACK: readonly string[] = ["STRING", "RICH_TEXT"];

export function compatibleTypes(asanaType: string): readonly string[] {
  return Object.hasOwn(COMPAT, asanaType) ? (COMPAT[asanaType] ?? UNKNOWN_FALLBACK) : UNKNOWN_FALLBACK;
}

export function preferredType(asanaType: string): string | null {
  return compatibleTypes(asanaType)[0] ?? null;
}

const asMap = (v: OrderedJson | undefined): Map<string, OrderedJson> | null => (v instanceof Map ? v : null);

export const importLabel = (plakyType: string | null, importAs?: string | null): string =>
  importAs ?? (Object.hasOwn(PLAKY_TYPE_LABEL, plakyType ?? "") ? (PLAKY_TYPE_LABEL[plakyType ?? ""] ?? "") : (plakyType ?? ""));

export function singleSelect(column: Pick<ExtractedColumn, "settings" | "settingsStr">): boolean {
  let settings: unknown = column.settings;
  if (!isDict(settings) || settings["limit_select"] === undefined) {
    try {
      settings = JSON.parse(column.settingsStr || "{}");
    } catch {
      return false;
    }
  }
  return isDict(settings) && settings["limit_select"] === true && Number(settings["label_limit_count"]) === 1;
}

export const fieldTypesFor = (column: Pick<ExtractedColumn, "type" | "settings" | "settingsStr">): readonly string[] =>
  column.type === "dropdown" && singleSelect(column) ? [...compatibleTypes(column.type), "STATUS"] : compatibleTypes(column.type);

export function labelTitles(column: Pick<ExtractedColumn, "settings" | "settingsStr">): Map<string, string> {
  const typed = isDict(column.settings) ? column.settings : null;
  if (typed !== null && Array.isArray(typed["labels"])) {
    const out = new Map<string, string>();
    for (const entry of typed["labels"] as unknown[]) {
      if (!isDict(entry) || entry["id"] === null || entry["id"] === undefined) continue;
      const title = pyOr(entry["label"], entry["name"]);
      if (typeof title === "string" && pyStrip(title)) out.set(pyStr(entry["id"]), title);
    }
    if (out.size) return out;
  }
  const text = column.settingsStr || "{}";
  try {
    JSON.parse(text);
  } catch {
    return new Map();
  }
  const settings = asMap(parseJsonOrdered(text));
  const labels = settings?.get("labels");
  const out = new Map<string, string>();
  if (labels instanceof Map) {
    for (const [id, title] of labels) if (typeof title === "string" && pyStrip(title)) out.set(id, title);
  } else if (Array.isArray(labels)) {
    for (const entry of labels) {
      const fields = asMap(entry);
      const name = fields?.get("name");
      if (fields && typeof name === "string" && pyStrip(name)) out.set(pyStr(fields.get("id")), name);
    }
  }
  return out;
}

export const asanaLabels = (column: Pick<ExtractedColumn, "settings" | "settingsStr">): string[] => [...labelTitles(column).values()];
