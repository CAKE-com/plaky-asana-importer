import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ATTACHMENT_FIELDS, STORY_FIELDS, attachmentSchema, storySchema, type AsanaClient } from "../clients/asana";
import { eachAtOnce, fieldColumnType, readProject, projectBoard, storedByAsana, subtaskBoard } from "./extract";
import { safeName } from "./transform/files";
import { FileTooLarge, streamDownload } from "./assets";

const FILE_LIMIT = 100_000_000;
const ARCHIVE_BUDGET = 2_000_000_000;
const PROCESS_TOKEN = randomUUID().slice(0, 8);
const LEFTOVER_MS = 24 * 3_600_000;

async function downloadToFile(url: string, path: string, maxBytes: number): Promise<number> {
  const part = `${path.slice(0, path.lastIndexOf("/") + 1)}.part-${randomUUID().slice(0, 8)}`;
  const out = createWriteStream(part, { mode: 0o600 });
  try {
    const length = await streamDownload(url, maxBytes, (chunk) => new Promise<void>((resolve, reject) => {
      out.write(chunk, (error) => (error ? reject(error) : resolve()));
    }));
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    await rename(part, path);
    return length;
  } catch (error) {
    out.destroy();
    await rm(part, { force: true }).catch(() => undefined);
    throw error;
  }
}

const escape = (value: unknown): string => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const page = (title: string, content: string): string => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:16px/1.6 system-ui;max-width:900px;margin:40px auto;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-top:1px solid #ddd;padding:16px 0}a{overflow-wrap:anywhere}</style><h1>${escape(title)}</h1>${content}</html>`;
const fileLink = (path: string, title: string): string => `<a href="${path.split("/").map(encodeURIComponent).join("/")}">${escape(title)}</a>`;
const publicLink = (raw: string | null | undefined): string | null => {
  try { const u = new URL(raw ?? ""); return ["https:", "http:"].includes(u.protocol) ? u.href : null; } catch { return null; }
};
export type ArchiveResult = { path: string; bytes: number; tasks: number; missingFiles: number; cleanup: () => Promise<void> };
type ArchivedFile = { id: string; name: string } & (
  | { status: "saved"; path: string; externalUrl: null }
  | { status: "external"; path: null; externalUrl: string }
  | { status: "unavailable"; path: null; externalUrl: null }
);

const swept = new Set<string>();
export async function sweepArchiveFiles(dir: string = tmpdir()): Promise<void> {
  if (swept.has(dir)) return;
  swept.add(dir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const found = /^asana-migration-archive-(\d+)-(?:([0-9a-f]{8})-)?/.exec(entry.name);
    if (!found || !entry.isDirectory() || found[2] === PROCESS_TOKEN) continue;
    const path = join(dir, entry.name);
    try {
      let gone = false;
      try { process.kill(Number(found[1]), 0); } catch (error) { gone = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      const old = Date.now() - (await stat(path)).mtimeMs > LEFTOVER_MS;
      if (gone || old) await rm(path, { recursive: true, force: true });
    } catch {
    }
  }
}

export async function buildArchive(asana: AsanaClient, sources: readonly string[], name: string, options: {
  signal?: AbortSignal; download?: (url: string, limit: number) => Promise<Uint8Array>; maxBytes?: number;
} = {}): Promise<ArchiveResult> {
  const directory = await mkdtemp(join(tmpdir(), `asana-migration-archive-${process.pid}-${PROCESS_TOKEN}-`));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  const root = join(directory, "archive");
  const records: { source: string; name: string; archived: boolean; tasks: { id: string; title: string }[] }[] = [];
  const failures: { task: string; attachment: string; name: string; reason: string }[] = [];
  const done = new Set<string>();
  const relationships = new Map<string, { id: string; name: string; kind: string }[]>();
  const check = (): void => options.signal?.throwIfAborted();
  const budget = options.maxBytes ?? ARCHIVE_BUDGET;
  let fileBytes = 0;
  const save = async (path: string, body: string | Uint8Array): Promise<void> => {
    check();
    await writeFile(join(root, path), body, { mode: 0o600 });
  };
  try {
    const titles = new Map<string, string>();
    await mkdir(join(root, "tasks"), { recursive: true });
    await mkdir(join(root, "files"));
    for (const source of [...new Set(sources)]) {
      check();
      const read = await readProject(asana, source, sources);
      const excludedFields = new Set([...projectBoard(read).columns, ...(await subtaskBoard(asana, read)).board.columns].filter((field) => field.type === "time_tracking").map((field) => field.id));
      const record = { source, name: read.project.name ?? source, archived: read.project.archived === true, tasks: [] as { id: string; title: string }[] };
      records.push(record);
      const fresh: (typeof read.tree)[number]["task"][] = [];
      for (const { task } of read.tree) {
        check();
        if (!/^\d+$/.test(task.gid)) throw new Error("Asana returned an invalid task ID");
        record.tasks.push({ id: task.gid, title: task.name ?? task.gid });
        titles.set(task.gid, task.name ?? task.gid);
        if (done.has(task.gid)) continue;
        done.add(task.gid);
        relationships.set(task.gid, [
          ...(task.parent ? [{ id: task.parent.gid, name: task.parent.name ?? task.parent.gid, kind: "Parent" }] : []),
          ...(task.dependencies ?? []).map((r) => ({ id: r.gid, name: r.name ?? r.gid, kind: "Blocked by" })),
          ...(task.dependents ?? []).map((r) => ({ id: r.gid, name: r.name ?? r.gid, kind: "Blocking" })),
        ]);
        fresh.push(task);
      }
      await eachAtOnce(fresh, async (task) => {
        check();
        const stories = await asana.list(`/tasks/${task.gid}/stories`, storySchema, { opt_fields: STORY_FIELDS });
        const comments = stories.filter((s) => s.resource_subtype === "comment_added");
        const storyOf = new Map(stories.flatMap((s) => (s.comment_gid ? [[s.comment_gid, s.gid] as const] : [])));
        const replyTo = (s: (typeof stories)[number]): string | null => (s.anchor_gid && s.anchor_gid !== task.gid ? (storyOf.get(s.anchor_gid) ?? null) : null);
        const attachments = await asana.list(`/tasks/${task.gid}/attachments`, attachmentSchema, { opt_fields: ATTACHMENT_FIELDS });
        const files: ArchivedFile[] = [];
        for (const attachment of attachments) {
          check();
          if (!/^\d+$/.test(attachment.gid)) throw new Error("Asana returned an invalid attachment ID");
          const title = attachment.name ?? attachment.gid;
          const identity = { id: attachment.gid, name: title };
          const unavailable = (reason = "File could not be downloaded; retain it from Asana before closing access."): void => {
            files.push({ ...identity, status: "unavailable", path: null, externalUrl: null });
            failures.push({ task: task.gid, attachment: attachment.gid, name: title, reason });
          };
          const OVER_BUDGET = `The archive's ${Math.round(budget / 1e9)} GB was spent before this file; export fewer projects at once, or retain it from Asana before closing access.`;
          if (!storedByAsana(attachment)) {
            const externalUrl = publicLink(attachment.view_url);
            if (externalUrl) files.push({ ...identity, status: "external", path: null, externalUrl });
            else unavailable();
            continue;
          }
          let reserved = 0;
          try {
            const meta = (await asana.assets([attachment.gid])).get(attachment.gid);
            if (!meta?.download_url) throw new Error("unavailable");
            const expected = typeof meta.size === "number" && meta.size >= 0 ? meta.size : null;
            if (fileBytes + (expected ?? 0) > budget) {
              unavailable(OVER_BUDGET);
              continue;
            }
            reserved = expected ?? 0;
            fileBytes += reserved;
            const prefix = `${task.gid}-${attachment.gid}-`;
            const path = `files/${prefix}${safeName(title, 255 - Buffer.byteLength(prefix)).replace(/^\.+$/, "file")}`;
            let length: number;
            if (options.download) {
              const data = await options.download(meta.download_url, FILE_LIMIT);
              await writeFile(join(root, path), data, { mode: 0o600 });
              length = data.byteLength;
            } else {
              length = await downloadToFile(meta.download_url, join(root, path), FILE_LIMIT);
            }
            if (expected !== null && length !== expected) {
              await rm(join(root, path), { force: true });
              throw new Error("File size mismatch");
            }
            fileBytes += length - reserved;
            reserved = 0;
            if (fileBytes > budget) {
              await rm(join(root, path), { force: true });
              fileBytes -= length;
              unavailable(OVER_BUDGET);
              continue;
            }
            files.push({ ...identity, status: "saved", path, externalUrl: null });
          } catch (error) {
            fileBytes -= reserved;
            check();
            unavailable(error instanceof FileTooLarge ? "File is over 100 MB, Asana's limit; retain it from Asana before closing access." : undefined);
          }
        }
        const taskFields = (task.custom_fields ?? []).filter((field) => !excludedFields.has(field.gid) && fieldColumnType(field) !== "time_tracking");
        const data = {
          id: task.gid, title: task.name, description: task.notes, originalHtml: task.html_notes,
          completed: task.completed, customStatus: task.custom_type_status_option, assignee: task.assignee,
          createdAt: task.created_at, createdBy: task.created_by, modifiedAt: task.modified_at,
          startAt: task.start_at ?? task.start_on, dueAt: task.due_at ?? task.due_on, completedAt: task.completed_at,
          type: task.resource_subtype, customType: task.custom_type, approvalStatus: task.approval_status, tags: task.tags, followers: task.followers,
          parent: task.parent, memberships: task.memberships, fields: taskFields,
          dependencies: task.dependencies, dependents: task.dependents, comments: comments.map((c) => ({ id: c.gid, text: c.text, originalHtml: c.html_text, author: c.created_by, createdAt: c.created_at, replyTo: replyTo(c) })), files,
        };
        await save(`tasks/${task.gid}.json`, JSON.stringify(data, null, 2));
        const fileRows = files.map((f) => `<li>${f.path ? fileLink(`../${f.path}`, f.name) : f.externalUrl ? `<a href="${escape(f.externalUrl)}">${escape(f.name)}</a>` : escape(f.name)} — ${f.status === "external" ? "external link; access still depends on the original provider" : f.status}</li>`).join("");
        await save(`tasks/${task.gid}.html`, page(task.name ?? task.gid, `<p><a href="../index.html">All projects</a> · ${fileLink(`${task.gid}.json`, "Machine-readable record")}</p><p>${[`Asana ID: ${escape(task.gid)}`, task.completed ? "Completed" : "Incomplete", escape(task.custom_type_status_option?.name)].filter(Boolean).join(" · ")}</p><pre>${escape(task.notes)}</pre><!--a2p-relationships--><h2>Fields and relationships</h2><pre>${escape(JSON.stringify({ assignee: task.assignee, parent: task.parent, fields: taskFields, dependencies: task.dependencies, dependents: task.dependents }, null, 2))}</pre><h2>Files</h2><ul>${fileRows}</ul><h2>Comments</h2>${comments.map((c) => `<article><p>${[escape(c.created_by?.name), escape(c.created_at)].filter(Boolean).join(" · ")}</p><pre>${escape(c.text)}</pre></article>`).join("")}`));
      });
    }
    for (const [id, references] of relationships) {
      const path = `tasks/${id}.html`;
      const html = await readFile(join(root, path), "utf8");
      const navigation = references.length ? `<h2>Related work</h2><ul>${references.map((r) => `<li>${escape(r.kind)}: ${done.has(r.id) ? fileLink(`${r.id}.html`, titles.get(r.id) ?? r.name) : `${escape(r.name)} (outside this archive)`} — Asana ID ${escape(r.id)}</li>`).join("")}</ul>` : "";
      await save(path, html.replace("<!--a2p-relationships-->", () => navigation));
    }
    const manifest = { version: 1, name, generatedAt: new Date().toISOString(), tasks: done.size, sources: records, missingFiles: failures, scope: "Selected accessible task work only. External links are not file copies. Briefs, status updates, time tracking, reactions and automations are excluded." };
    await save("manifest.json", JSON.stringify(manifest, null, 2));
    await save("index.html", page(name, `<p>${escape(manifest.scope)}</p><p>${done.size} tasks. <strong>${failures.length} files could not be saved.</strong> ${fileLink("manifest.json", "Export details and missing files")}</p>${records.map((r) => `<h2>${escape(r.name)}</h2><ul>${r.tasks.map((t) => `<li>${fileLink(`tasks/${t.id}.html`, t.title)}</li>`).join("")}</ul>`).join("")}<h2>Missing files</h2><ul>${failures.map((f) => `<li>${escape(f.name)} (task ${escape(f.task)}): ${escape(f.reason)}</li>`).join("")}</ul>`));
    check();
    const path = join(directory, "archive.tar.gz");
    await promisify(execFile)("tar", ["-czf", path, "-C", directory, "archive"], { signal: options.signal, env: { ...process.env, COPYFILE_DISABLE: "1" } });
    return { path, bytes: (await stat(path)).size, tasks: done.size, missingFiles: failures.length, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
