import { ENCODINGS_MAP, SUFFIX_MAP, TYPES_MAP } from "./mimeTypes";
import { pyStrip, truthy } from "./pystr";
import { strOf } from "./pyvalue";

export const MAX_UPLOAD_BYTES = 99_500_000;
export const URL_LIFETIME_SECONDS = 90;

export type AsanaFile = {
  name: string;
  assetId: string | null;
  url: string | null;
};

export function filesInValue(value: unknown): AsanaFile[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const files = (parsed as Record<string, unknown>).files;
  if (typeof files === "number" && files !== 0) throw new TypeError(`'${Number.isInteger(files) ? "int" : "float"}' object is not iterable`);
  if (files === true) throw new TypeError("'bool' object is not iterable");
  const out: AsanaFile[] = [];
  for (const entry of Array.isArray(files) ? files : []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const name = truthy(row.name) ? strOf(row.name) : "file";
    const kind = (truthy(row.fileType) ? strOf(row.fileType) : "ASSET").toUpperCase();
    const asset = row.assetId;
    if (kind === "ASSET" && asset !== undefined && asset !== null) {
      out.push({ name, assetId: strOf(asset), url: null });
    } else {
      const link = truthy(row.linkToFile) ? row.linkToFile : row.url;
      out.push({ name, assetId: null, url: truthy(link) ? strOf(link) : null });
    }
  }
  return out;
}

const utf8 = new TextEncoder();

export function safeName(name: string, maxBytes = 255): string {
  const base = name.replaceAll("\\", "/").split("/").pop()!;
  const cleaned = pyStrip([...base].filter((ch) => !/^\p{C}$/u.test(ch)).join("")) || "file";
  const encoded = utf8.encode(cleaned);
  if (encoded.length <= maxBytes) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const stem = dot < 0 ? "" : cleaned.slice(0, dot);
  const ext = dot < 0 ? "" : cleaned.slice(dot + 1);
  const suffix = dot >= 0 && utf8.encode(ext).length < 20 ? `.${ext}` : "";
  const room = maxBytes - utf8.encode(suffix).length;
  const bytes = suffix ? utf8.encode(stem) : encoded;
  let cut = Math.min(room, bytes.length);
  while (cut > 0 && cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return new TextDecoder().decode(bytes.subarray(0, cut)) + suffix;
}

const has = (table: Readonly<Record<string, string>>, key: string): boolean => Object.hasOwn(table, key);

function splitExt(path: string): [string, string] {
  const sep = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot > sep) {
    for (let i = sep + 1; i < dot; i++) if (path[i] !== ".") return [path.slice(0, dot), path.slice(dot)];
  }
  return [path, ""];
}

function guessType(name: string): string | null {
  const url = name;
  let [base, ext] = splitExt(url);
  for (let lower = ext.toLowerCase(); has(SUFFIX_MAP, lower); lower = ext.toLowerCase()) {
    [base, ext] = splitExt(base + SUFFIX_MAP[lower]!);
  }
  if (has(ENCODINGS_MAP, ext)) ext = splitExt(base)[1];
  ext = ext.toLowerCase();
  return has(TYPES_MAP, ext) ? TYPES_MAP[ext]! : null;
}

export function contentType(name: string): string {
  return guessType(name) ?? "application/octet-stream";
}
