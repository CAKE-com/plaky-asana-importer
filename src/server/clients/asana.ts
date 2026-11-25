import { createHash } from "node:crypto";
import { z } from "zod";
import { redactString, registerSecret } from "../redact";
import { fetchTransport, realClock, retryAfterSeconds, retryDecision, USER_AGENT, type Clock, type Transport } from "./http";
import { Pacer } from "./plaky";

export const ASANA_BASE_URL = "https://app.asana.com/api/1.0";
import { DEFAULT_REQUESTS_PER_MINUTE, PAID_REQUESTS_PER_MINUTE } from "@/lib/asana-pace";

export { DEFAULT_REQUESTS_PER_MINUTE, PAID_REQUESTS_PER_MINUTE };
export const PAGE_SIZE = 100;
export const MAX_429_REPLAYS = 5;
export const MAX_READ_RETRIES = 5;
const MAX_PAGES = 100_000;
const REQUEST_TIMEOUT_MS = 60_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 60_000;
const MAX_RETRY_AFTER_S = 120;

export class AsanaError extends Error {
  override name = "AsanaError";
}
export class AsanaHttpError extends AsanaError {
  override name = "AsanaHttpError";
  constructor(
    readonly status: number,
    message: string,
    readonly sync?: string,
  ) {
    super(message);
  }
}
export class AsanaRateLimitedError extends AsanaError {
  override name = "AsanaRateLimitedError";
}
export class AsanaOutcomeUnknownError extends AsanaError {
  override name = "AsanaOutcomeUnknownError";
}
export class AsanaDecodeError extends AsanaError {
  override name = "AsanaDecodeError";
}
const isGid = (id: string): boolean => /^\d{1,20}$/.test(id);
export const isAsanaNotFound = (error: unknown): boolean => error instanceof AsanaHttpError && error.status === 404;
export const isAsanaHidden = (error: unknown): boolean => error instanceof AsanaHttpError && (error.status === 403 || error.status === 404);
export const UNREADABLE_BOARD = "unreadable";
export const isAsanaRateLimited = (error: unknown): boolean => error instanceof AsanaRateLimitedError || (error instanceof Error && error.name === "AsanaRateLimitedError");

const gid = z.string();
const str = z.string().nullish();
export const compactSchema = z.looseObject({ gid, name: str, resource_type: str, resource_subtype: str });
const namedSchema = z.looseObject({ gid: str, name: str });
export const userSchema = z.looseObject({ gid, name: str, email: str });

const enumOptionSchema = z.looseObject({ gid, name: str, enabled: z.boolean().nullish(), color: str });
export const customFieldValueSchema = z.looseObject({
  gid,
  name: str,
  type: str,
  resource_subtype: str,
  display_value: str,
  text_value: str,
  number_value: z.number().nullish(),
  enum_value: enumOptionSchema.nullish(),
  multi_enum_values: z.array(enumOptionSchema).nullish(),
  date_value: z.looseObject({ date: str, date_time: str }).nullish(),
  people_value: z.array(userSchema).nullish(),
  reference_value: z.array(compactSchema).nullish(),
  enum_options: z.array(enumOptionSchema).nullish(),
  is_formula_field: z.boolean().nullish(),
  id_prefix: str,
  precision: z.number().nullish(),
  representation_type: str,
  format: str,
  currency_code: str,
  custom_label: str,
  custom_label_position: str,
  is_lookup_field: z.boolean().nullish(),
  is_value_read_only: z.boolean().nullish(),
});
export const customFieldSettingSchema = z.looseObject({ gid, is_important: z.boolean().nullish(), custom_field: customFieldValueSchema });
export const membershipSchema = z.looseObject({ project: compactSchema.nullish(), section: compactSchema.nullish() });
export const taskSchema = z.looseObject({
  gid,
  name: str,
  resource_subtype: str,
  approval_status: str,
  custom_type: namedSchema.nullish(),
  custom_type_status_option: namedSchema.nullish(),
  assignee: userSchema.nullish(),
  completed: z.boolean().nullish(),
  completed_at: str,
  completed_by: userSchema.nullish(),
  created_at: str,
  created_by: compactSchema.nullish(),
  modified_at: str,
  start_on: str,
  start_at: str,
  due_on: str,
  due_at: str,
  notes: str,
  html_notes: str,
  parent: compactSchema.nullish(),
  num_subtasks: z.number().nullish(),
  num_likes: z.number().nullish(),
  permalink_url: str,
  memberships: z.array(membershipSchema).nullish(),
  followers: z.array(userSchema).nullish(),
  tags: z.array(compactSchema).nullish(),
  dependencies: z.array(compactSchema).nullish(),
  dependents: z.array(compactSchema).nullish(),
  custom_fields: z.array(customFieldValueSchema).nullish(),
});
export const storySchema = z.looseObject({
  gid,
  type: str,
  resource_subtype: str,
  text: str,
  html_text: str,
  created_at: str,
  created_by: userSchema.nullish(),
  is_pinned: z.boolean().nullish(),
  is_edited: z.boolean().nullish(),
  comment_gid: str,
  anchor_gid: str,
});
export const attachmentSchema = z.looseObject({
  gid,
  name: str,
  resource_subtype: str,
  host: str,
  size: z.number().nullish(),
  created_at: str,
  download_url: str,
  view_url: str,
  permanent_url: str,
});
export const sectionSchema = z.looseObject({ gid, name: str, created_at: str });
export const projectSchema = z.looseObject({
  gid,
  name: str,
  archived: z.boolean().nullish(),
  color: str,
  notes: str,
  html_notes: str,
  owner: compactSchema.nullish(),
  team: compactSchema.nullish(),
  privacy_setting: str,
  permalink_url: str,
  created_at: str,
  modified_at: str,
  default_view: str,
  workspace: compactSchema.nullish(),
});
export const workspaceSchema = z.looseObject({ gid, name: str, is_organization: z.boolean().nullish() });
export const workspaceMembershipSchema = z.looseObject({ gid, user: userSchema.nullish(), is_active: z.boolean().nullish(), is_admin: z.boolean().nullish(), is_guest: z.boolean().nullish() });

export type AsanaTask = z.infer<typeof taskSchema>;
export type AsanaAttachment = z.infer<typeof attachmentSchema>;
export type AsanaSection = z.infer<typeof sectionSchema>;
export type AsanaProject = z.infer<typeof projectSchema>;
export type AsanaCustomFieldValue = z.infer<typeof customFieldValueSchema>;
export type AsanaCustomFieldSetting = z.infer<typeof customFieldSettingSchema>;
export type AsanaWorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;

type Query = Record<string, string | number | boolean | undefined>;
type Method = "GET" | "POST" | "PUT" | "DELETE";

export type AsanaClientOptions = {
  token: string;
  baseUrl?: string;
  transport?: Transport;
  clock?: Clock;
  requestsPerMinute?: number;
  userAgent?: string;
  onCall?: () => void;
};

const eventSchema = z.looseObject({ action: str, resource: compactSchema.nullish(), change: z.looseObject({ field: str }).nullish() });
const eventPageSchema = z.looseObject({ data: z.array(eventSchema), sync: z.string(), has_more: z.boolean().nullish() });
export type AsanaEvent = z.infer<typeof eventSchema>;

export type ListedProject = { gid: string; name: string; tasks: number; archived: boolean; privacy: string | null; team: string | null; workspace: { gid: string; name: string } };

const pageSchema = <T extends z.ZodType>(row: T) => z.looseObject({ data: z.array(row), next_page: z.looseObject({ offset: z.string() }).nullish() });
const dataSchema = <T extends z.ZodType>(row: T) => z.looseObject({ data: row });

const pacers = ((globalThis as { __a2pPacers?: Map<string, Pacer> }).__a2pPacers ??= new Map());

function sharedPacer(token: string, rate: number): Pacer {
  const key = `${createHash("sha256").update(token).digest("hex")}:${rate}`;
  let found = pacers.get(key);
  if (!found) pacers.set(key, (found = new Pacer(realClock, rate)));
  return found;
}

export class AsanaClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly pacer: Pacer;
  private readonly userAgent: string;
  private readonly onCall: AsanaClientOptions["onCall"];
  private stopSignal: AbortSignal | undefined;
  requests = 0;
  rateLimited = false;
  onLimited: ((seconds: number) => void) | undefined;

  constructor(options: AsanaClientOptions) {
    if (!options.token.trim()) throw new Error("AsanaClient: token is required");
    this.token = options.token;
    registerSecret(options.token);
    this.baseUrl = options.baseUrl ?? ASANA_BASE_URL;
    this.transport = options.transport ?? fetchTransport;
    this.clock = options.clock ?? realClock;
    const rate = options.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
    this.pacer = this.clock === realClock ? sharedPacer(options.token, rate) : new Pacer(this.clock, rate);
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.onCall = options.onCall;
  }

  stopOn(signal: AbortSignal): void {
    this.stopSignal = signal;
  }

  static fromEnv(overrides: Partial<AsanaClientOptions> = {}): AsanaClient {
    const token = (process.env.ASANA_ACCESS_TOKEN ?? "").trim();
    if (!token) throw new Error("ASANA_ACCESS_TOKEN is not set");
    return new AsanaClient({ token, ...overrides });
  }

  private async send<S extends z.ZodType>(method: Method, path: string, schema: S, opts: { query?: Query; body?: unknown; form?: FormData } = {}): Promise<z.infer<S>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const write = method !== "GET";
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json", "user-agent": this.userAgent };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const body = opts.form ?? (opts.body === undefined ? null : JSON.stringify({ data: opts.body }));
    const label = `${method} ${url.pathname.replace(/^\/api\/1\.0/, "")}`;

    let attempt = 0;
    const backOff = async (response: Response | null): Promise<boolean> => {
      if (retryDecision("uncertain", write, attempt, MAX_READ_RETRIES) !== "retry") return false;
      const after = response ? retryAfterSeconds(response) : null;
      const capped = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
      await this.clock.sleep(after !== null ? Math.min(Math.max(after * 1000, 0), BACKOFF_CAP_MS) : capped / 2 + Math.random() * (capped / 2), this.stopSignal);
      return true;
    };

    for (; ; attempt++) {
      this.stopSignal?.throwIfAborted();
      await this.pacer.claim(this.stopSignal);
      this.requests++;
      this.onCall?.();
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        response = await this.transport(url, { method, headers, body, signal: this.stopSignal ? AbortSignal.any([timeout, this.stopSignal]) : timeout });
      } catch (error) {
        this.stopSignal?.throwIfAborted();
        const reason = redactString(`${label}: ${(error as Error).name}`);
        if (write) throw new AsanaOutcomeUnknownError(reason);
        if (await backOff(null)) continue;
        throw new AsanaError(reason);
      }
      if (response.status === 429) {
        const wait = Math.min(Math.max(retryAfterSeconds(response) ?? 60, 1), MAX_RETRY_AFTER_S);
        void response.body?.cancel().catch(() => undefined);
        this.pacer.pause(wait * 1000);
        if (retryDecision("rate-limit", write, attempt, MAX_429_REPLAYS) === "rate-limited") {
          this.rateLimited = true;
          throw new AsanaRateLimitedError(`${label}: 429 after ${attempt} retries`);
        }
        this.onLimited?.(wait);
        continue;
      }
      const text = await response.text().catch(() => null);
      if (text === null) {
        if (write) throw new AsanaOutcomeUnknownError(`${label}: answer body unreadable (HTTP ${response.status})`);
        if (await backOff(null)) continue;
        throw new AsanaError(`${label}: answer body unreadable`);
      }
      if (response.status >= 500) {
        const reason = `${label}: HTTP ${response.status}`;
        if (write) throw new AsanaOutcomeUnknownError(reason);
        if (await backOff(response)) continue;
        throw new AsanaHttpError(response.status, reason);
      }
      if (!response.ok) throw new AsanaHttpError(response.status, `${redactString(label)}: HTTP ${response.status} ${errorText(text)}`, syncOf(text));

      let json: unknown = null;
      if (text.trim()) {
        try {
          json = JSON.parse(text);
        } catch {
          const reason = `${label}: undecodable answer`;
          throw write ? new AsanaOutcomeUnknownError(reason) : new AsanaDecodeError(reason);
        }
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        const reason = `${label}: answer does not match the schema (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")})`;
        throw write ? new AsanaOutcomeUnknownError(reason) : new AsanaDecodeError(reason);
      }
      return parsed.data;
    }
  }

  async get<S extends z.ZodType>(path: string, row: S, query: Query = {}): Promise<z.infer<S>> {
    return (await this.send("GET", path, dataSchema(row), { query })).data as z.infer<S>;
  }

  async list<S extends z.ZodType>(path: string, row: S, query: Query = {}): Promise<z.infer<S>[]> {
    const out: z.infer<S>[] = [];
    const seen = new Set<string>();
    let offset: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await this.send("GET", path, pageSchema(row), { query: { ...query, limit: PAGE_SIZE, offset } });
      out.push(...(got.data as z.infer<S>[]));
      const next = got.next_page?.offset;
      if (!next) return out;
      if (seen.has(next)) throw new AsanaDecodeError(`GET ${path}: repeated page offset`);
      seen.add(next);
      offset = next;
    }
    throw new AsanaDecodeError(`GET ${path}: paging exceeded ${MAX_PAGES} pages`);
  }

  async write<S extends z.ZodType>(method: Exclude<Method, "GET">, path: string, row: S, body?: unknown, query: Query = {}): Promise<z.infer<S>> {
    return (await this.send(method, path, dataSchema(row), { query, ...(body === undefined ? {} : { body }) })).data as z.infer<S>;
  }

  async upload<S extends z.ZodType>(path: string, row: S, form: FormData): Promise<z.infer<S>> {
    return (await this.send("POST", path, dataSchema(row), { form })).data as z.infer<S>;
  }

  async me(): Promise<{ gid: string; name: string | null; email: string | null; account: string | null; slug: string | null; tier: string | null }> {
    const user = await this.get("/users/me", userSchema, { opt_fields: "name,email" });
    const workspaces = await this.list("/workspaces", workspaceSchema, { opt_fields: "name,is_organization" });
    return { gid: user.gid, name: user.name ?? null, email: user.email ?? null, account: workspaces.map((w) => w.name).join(", ") || null, slug: null, tier: null };
  }

  async listProjects(o: { counts?: boolean } = {}): Promise<ListedProject[]> {
    const out: ListedProject[] = [];
    const counts = new Map<string, number>();
    for (const workspace of await this.list("/workspaces", workspaceSchema, { opt_fields: "name" })) {
      for (const archived of [false, true]) {
        const rows = await this.list("/projects", projectSchema, { workspace: workspace.gid, archived, opt_fields: "name,archived,privacy_setting,team.name" });
        if (o.counts !== false) for (const row of rows) counts.set(row.gid, await this.taskCount(row.gid));
        out.push(...rows.map((row) => ({ gid: row.gid, name: row.name ?? row.gid, tasks: counts.get(row.gid) ?? 0, archived, privacy: row.privacy_setting ?? null, team: row.team?.name ?? null, workspace: { gid: workspace.gid, name: workspace.name ?? workspace.gid } })));
      }
    }
    return out;
  }

  async listPersonalProjects(): Promise<ListedProject[]> {
    const out: ListedProject[] = [];
    for (const workspace of await this.list("/workspaces", workspaceSchema, { opt_fields: "name" })) {
      const users = await this.list(`/workspaces/${workspace.gid}/users`, userSchema, { opt_fields: "name" });
      for (const user of users) {
        try {
          const list = await this.get(`/users/${user.gid}/user_task_list`, projectSchema, { workspace: workspace.gid });
          out.push({ gid: `mytasks:${list.gid}`, name: `My Tasks — ${user.name ?? user.gid}`, tasks: 0, archived: false, privacy: "private", team: null, workspace: { gid: workspace.gid, name: workspace.name ?? workspace.gid } });
        } catch (error) {
          if (!(error instanceof AsanaHttpError && [403, 404].includes(error.status))) throw error;
        }
      }
    }
    return out;
  }

  async sourceProject(id: string): Promise<AsanaProject> {
    if (!id.startsWith("mytasks:")) return this.get(`/projects/${id}`, projectSchema, { opt_fields: PROJECT_FIELDS });
    const list = await this.get(`/user_task_lists/${id.slice(8)}`, z.looseObject({ gid, name: str, owner: compactSchema, workspace: compactSchema }), { opt_fields: "name,owner.name,workspace.name" });
    return { gid: id, name: `My Tasks — ${list.owner.name ?? list.owner.gid}`, workspace: list.workspace, owner: list.owner, privacy_setting: "private", archived: false };
  }

  async sourceTasks(id: string): Promise<AsanaTask[]> {
    if (!id.startsWith("mytasks:")) return this.list(`/projects/${id}/tasks`, taskSchema, { opt_fields: TASK_FIELDS });
    const rows = await this.list(`/user_task_lists/${id.slice(8)}/tasks`, taskSchema, { opt_fields: TASK_FIELDS });
    const eligible: AsanaTask[] = [];
    const known = new Map(rows.map((task) => [task.gid, task]));
    for (const task of rows) {
      let ancestor = task;
      const seen = new Set<string>();
      let inProject = false;
      while (!seen.has(ancestor.gid)) {
        seen.add(ancestor.gid);
        if (ancestor.memberships?.some((m) => m.project)) { inProject = true; break; }
        if (!ancestor.parent) break;
        const above: AsanaTask | null = known.get(ancestor.parent.gid) ?? await this.get(`/tasks/${ancestor.parent.gid}`, taskSchema, { opt_fields: "parent.name,memberships.project.name" }).catch((error: unknown) => {
          if (isAsanaHidden(error)) return null;
          throw error;
        });
        if (!above) break;
        ancestor = above;
        known.set(ancestor.gid, ancestor);
      }
      if (!inProject) eligible.push(task);
    }
    const ids = new Set(eligible.map((t) => t.gid));
    return eligible.filter((t) => !t.parent || !ids.has(t.parent.gid));
  }

  private async taskCount(project: string): Promise<number> {
    try {
      return (await this.get(`/projects/${project}/task_counts`, z.looseObject({ num_tasks: z.number().nullish() }), { opt_fields: "num_tasks" })).num_tasks ?? 0;
    } catch (error) {
      if (error instanceof AsanaHttpError) return 0;
      throw error;
    }
  }

  async itemTitles(projectGid: string): Promise<Map<string, string>> {
    const rows = projectGid.startsWith("mytasks:") ? await this.sourceTasks(projectGid) : await this.list(`/projects/${projectGid}/tasks`, compactSchema, { opt_fields: "name" });
    return new Map(rows.map((t) => [t.gid, t.name ?? ""]));
  }

  async itemNames(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of ids.filter(isGid)) {
      try {
        out.set(id, (await this.get(`/tasks/${id}`, compactSchema, { opt_fields: "name" })).name ?? "");
      } catch (error) {
        if (!isAsanaHidden(error)) throw error;
      }
    }
    return out;
  }

  async activeItemBoards(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const read = (id: string) => this.get(`/tasks/${id}`, taskSchema, { opt_fields: "memberships.project.name,parent.name" });
    for (const id of ids.filter(isGid)) {
      try {
        let task = await read(id);
        const project = task.memberships?.find((m) => m.project)?.project?.gid;
        if (project) { out.set(id, project); continue; }
        if (!task.parent) continue;
        let above: string | undefined;
        for (let depth = 0; depth < 8 && task.parent && above === undefined; depth++) {
          task = await read(task.parent.gid);
          above = task.memberships?.find((m) => m.project)?.project?.gid;
        }
        out.set(id, above === undefined ? UNREADABLE_BOARD : `${above}:level2`);
      } catch (error) {
        if (error instanceof AsanaHttpError && error.status === 403) out.set(id, UNREADABLE_BOARD);
        else if (!isAsanaNotFound(error)) throw error;
      }
    }
    return out;
  }

  async assets(ids: readonly string[]): Promise<Map<string, { name?: string | null | undefined; size?: number | null | undefined; download_url?: string | null | undefined }>> {
    const out = new Map<string, { name?: string | null | undefined; size?: number | null | undefined; download_url?: string | null | undefined }>();
    for (const id of ids) {
      try {
        out.set(id, await this.get(`/attachments/${id}`, attachmentSchema, { opt_fields: "name,size,download_url" }));
      } catch (error) {
        if (!isAsanaHidden(error)) throw error;
      }
    }
    return out;
  }

  async events(resource: string, sync: string | null): Promise<{ sync: string; rows: AsanaEvent[]; expired: boolean }> {
    const rows: AsanaEvent[] = [];
    let token = sync ?? "";
    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        const got = await this.send("GET", "/events", eventPageSchema, { query: { resource, ...(token ? { sync: token } : {}) } });
        rows.push(...got.data);
        if (got.has_more && got.sync === token) throw new AsanaDecodeError("GET /events: the same sync token came back with more to read");
        token = got.sync;
        if (!got.has_more) return { sync: token, rows, expired: false };
      } catch (error) {
        if (error instanceof AsanaHttpError && error.status === 412 && error.sync) return { sync: error.sync, rows, expired: sync !== null };
        throw error;
      }
    }
    throw new AsanaDecodeError(`GET /events: paging exceeded ${MAX_PAGES} pages`);
  }

  async storyTargets(storyIds: readonly string[]): Promise<{ tasks: Set<string>; hidden: number }> {
    const tasks = new Set<string>();
    let hidden = 0;
    for (const id of storyIds) {
      try {
        const story = await this.get(`/stories/${id}`, z.looseObject({ target: compactSchema.nullish() }), { opt_fields: "target.name" });
        if (story.target) tasks.add(story.target.gid);
      } catch (error) {
        if (!isAsanaHidden(error)) throw error;
        if (!isAsanaNotFound(error)) hidden++;
      }
    }
    return { tasks, hidden };
  }

}

function errorText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { errors?: { message?: string }[] };
    const messages = (parsed.errors ?? []).map((e) => e.message).filter(Boolean);
    if (messages.length) return redactString(messages.join("; ")).slice(0, 300);
  } catch {
  }
  return redactString(text.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()).slice(0, 300);
}

function syncOf(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { sync?: unknown };
    return typeof parsed.sync === "string" ? parsed.sync : undefined;
  } catch {
    return undefined;
  }
}

export const PROJECT_FIELDS = "name,archived,workspace.name,notes,html_notes,privacy_setting,permalink_url,owner.name,team.name,created_at,modified_at";
export const SETTING_FIELDS =
  "custom_field.name,custom_field.resource_subtype,custom_field.type,custom_field.is_formula_field,custom_field.id_prefix,custom_field.enum_options.name,custom_field.enum_options.enabled,custom_field.enum_options.color,custom_field.precision,custom_field.representation_type,custom_field.format,custom_field.currency_code,custom_field.custom_label,custom_field.custom_label_position,custom_field.is_lookup_field,custom_field.is_value_read_only";
export const FIELD_FIELDS = SETTING_FIELDS.replaceAll("custom_field.", "");
export const TASK_FIELDS = [
  "name,resource_subtype,custom_type.name,custom_type_status_option.name,approval_status,completed,completed_at,created_at,created_by.name,modified_at,start_on,start_at,due_on,due_at,notes,html_notes",
  "assignee.name,assignee.email,parent.name,num_subtasks,num_likes,permalink_url,memberships.project.name,memberships.section.name",
  "followers.name,followers.email,tags.name,dependencies.name,dependents.name",
  "custom_fields.name,custom_fields.resource_subtype,custom_fields.display_value,custom_fields.text_value,custom_fields.number_value,custom_fields.enum_value.name",
  "custom_fields.multi_enum_values.name,custom_fields.date_value,custom_fields.people_value.name,custom_fields.people_value.email,custom_fields.reference_value.name,custom_fields.is_formula_field,custom_fields.id_prefix,custom_fields.representation_type",
].join(",");
export const STORY_FIELDS = "type,resource_subtype,text,html_text,created_at,created_by.name,created_by.email,is_pinned,is_edited,comment_gid,anchor_gid";
export const ATTACHMENT_FIELDS = "name,resource_subtype,host,size,created_at,view_url";

export function peopleIn(value: unknown): [kind: string, id: string][] {
  const parsed = parseValue(value);
  const rows = parsed && typeof parsed === "object" && "personsAndTeams" in parsed ? parsed.personsAndTeams : null;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: { id?: unknown; kind?: unknown }) => (row && row.id !== undefined && row.id !== null ? [[String(row.kind ?? "person"), String(row.id)] as [string, string]] : []));
}

export function tagIdsIn(value: unknown): string[] {
  const parsed = parseValue(value);
  const ids = parsed && typeof parsed === "object" && "tag_ids" in parsed ? parsed.tag_ids : null;
  return Array.isArray(ids) ? ids.map(String) : [];
}

function parseValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
