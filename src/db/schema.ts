import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import { createSelectSchema } from "drizzle-zod";

const id = () => integer("id").primaryKey({ autoIncrement: true });
const ts = (name: string) => integer(name, { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch('subsec') * 1000)`);
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const connections = sqliteTable("connections", {
  id: id(),
  label: text("label").notNull(),
  asanaAccountId: text("asana_account_id").notNull(),
  asanaUserId: text("asana_user_id").notNull(),
  asanaUserGid: text("asana_user_gid"),
  asanaTimeZone: text("asana_time_zone"),
  asanaAccountSlug: text("asana_account_slug"),
  asanaTier: text("asana_tier"),
  plakyUserId: integer("plaky_user_id").notNull(),
  plakyWebBase: text("plaky_web_base"),
});

export const migrations = sqliteTable("migrations", {
  id: id(),
  connectionId: integer("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status", { enum: ["draft", "discovered", "linked", "planned",
    "running", "interrupted", "completed", "failed"] }).notNull().default("draft"),
  plakySpaceId: integer("plaky_space_id"),
  options: json<{ syncComments: boolean; syncFiles: boolean; syncSubscribers: boolean; syncGroups: boolean;
    withCreated: boolean; withLink: boolean; prune: boolean; recreateDrifted: boolean;
    allowDuplicateImport: boolean;
    paidAsana?: boolean;
    pick?: string[];
    subitems?: "auto" | "board" | "nested" }>("options").notNull(),
  people: json<Record<string, Record<string, unknown>>>("people").notNull().default({}),
  manifest: json<Record<string, unknown>>("manifest"),
  readinessTicks: json<string[]>("readiness_ticks").notNull().default([]),
  resume: json<{ at: number; since: string | null; reset?: number; tries?: number }>("resume"),
  schedule: json<{ at: number; everyHours: number | null }>("schedule"),
  seedFailures: json<string[]>("seed_failures").notNull().default([]),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const migrationBoards = sqliteTable("migration_boards", {
  id: id(),
  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),
  asanaBoardId: text("asana_board_id").notNull(),
  asanaBoardName: text("asana_board_name").notNull(),
  hierarchyType: text("hierarchy_type").notNull().default("classic"),
  itemsCount: integer("items_count").notNull().default(0),
  subitemsOf: text("subitems_of"),
  plakyBoardId: integer("plaky_board_id"),
  plakySpaceId: integer("plaky_space_id"),
  linkPosition: integer("link_position"),
  nested: integer("nested", { mode: "boolean" }).notNull().default(false),
  syncGroups: integer("sync_groups", { mode: "boolean" }).notNull().default(true),
  syncSubscribers: integer("sync_subscribers", { mode: "boolean" }).notNull().default(false),
  syncComments: integer("sync_comments", { mode: "boolean" }).notNull().default(false),
  syncFiles: integer("sync_files", { mode: "boolean" }).notNull().default(false),
  fieldMap: json<Record<string, string>>("field_map").notNull().default({}),
  skipColumns: json<string[]>("skip_columns").notNull().default([]),
  labelMap: json<Record<string, Record<string, string>>>("label_map").notNull().default({}),
  asanaIdFieldKey: text("asana_id_field_key"),
  parentTitleFieldKey: text("parent_title_field_key"),
  parentIdFieldKey: text("parent_id_field_key"),
  seedGroupId: integer("seed_group_id"),
  applied: integer("applied", { mode: "boolean" }).notNull().default(false),
  syncedReadAt: integer("synced_read_at", { mode: "timestamp_ms" }),
  eventToken: text("event_token"),
  byHand: json<string[]>("by_hand").notNull().default([]),
  warnings: json<string[]>("warnings").notNull().default([]),
}, (t) => [
  uniqueIndex("mb_migration_asana").on(t.migrationId, t.asanaBoardId),
  index("mb_migration_plaky").on(t.migrationId, t.plakyBoardId),
]);

export const migrationColumns = sqliteTable("migration_columns", {
  id: id(),
  migrationBoardId: integer("migration_board_id").notNull().references(() => migrationBoards.id, { onDelete: "cascade" }),
  asanaColumnId: text("asana_column_id").notNull(),
  title: text("title").notNull(),
  asanaType: text("asana_type").notNull(),
  fieldName: text("field_name").notNull(),
  plakyType: text("plaky_type", { enum: ["STRING", "RICH_TEXT", "NUMBER", "DATE_TIME", "TIMELINE",
    "STATUS", "TAG", "PERSON", "LINK"] }),
  reason: text("reason"),
  labels: json<string[]>("labels").notNull().default([]),
  labelCollisions: json<string[]>("label_collisions").notNull().default([]),
  position: integer("position").notNull(),
}, (t) => [uniqueIndex("mc_board_column").on(t.migrationBoardId, t.asanaColumnId)]);

export const entityMappings = sqliteTable("entity_mappings", {
  id: id(),
  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),
  entityType: text("entity_type", { enum: ["group", "item", "subitem", "comment", "file"] }).notNull(),
  asanaId: text("asana_id").notNull(),
  scope: text("scope").notNull().default(""),
  occurrence: integer("occurrence").notNull().default(0),
  plakyId: integer("plaky_id"),
  plakyParentId: integer("plaky_parent_id"),
  createdPlakyId: integer("created_plaky_id"),
  status: text("status", { enum: ["dispatched", "committed", "ambiguous", "failed"] }).notNull(),
  lastError: text("last_error"),
  updatedAt: ts("updated_at"),
}, (t) => [
  uniqueIndex("em_unique").on(t.migrationId, t.entityType, t.scope, t.asanaId, t.occurrence),
  index("em_plaky").on(t.entityType, t.plakyId),
  index("em_status").on(t.migrationId, t.status),
]);

export const writtenValues = sqliteTable("written_values", {
  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),
  plakyBoardId: integer("plaky_board_id").notNull(),
  subject: text("subject").notNull(),
  key: text("key").notNull(),
  hash: text("hash").notNull(),
  updatedAt: ts("updated_at"),
}, (t) => [primaryKey({ columns: [t.migrationId, t.plakyBoardId, t.subject, t.key] })]);

export const boardLocks = sqliteTable("board_locks", {
  plakySpaceId: integer("plaky_space_id").notNull(),
  plakyBoardId: integer("plaky_board_id").notNull(),
  owner: text("owner").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [primaryKey({ columns: [t.plakySpaceId, t.plakyBoardId] })]);

export const migrationRuns = sqliteTable("migration_runs", {
  id: id(),
  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["plan", "apply", "verify", "undo"] }).notNull(),
  status: text("status", { enum: ["running", "succeeded", "failed", "interrupted", "rate_limited", "plaky_rate_limited"] }).notNull(),
  plannedWrites: integer("planned_writes"),
  counts: json<Record<string, number>>("counts"),
  receipt: json<unknown>("receipt"),
  startedAt: ts("started_at"),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }),
  ownerHost: text("owner_host"),
  ownerPid: integer("owner_pid"),
  ownerToken: text("owner_token"),
}, (t) => [index("runs_migration").on(t.migrationId, t.startedAt)]);

export const migrationLogs = sqliteTable("migration_logs", {
  id: id(),
  runId: integer("run_id").notNull().references(() => migrationRuns.id, { onDelete: "cascade" }),
  migrationBoardId: integer("migration_board_id").references(() => migrationBoards.id, { onDelete: "set null" }),
  ts: ts("ts"),
  level: text("level", { enum: ["info", "warn", "error", "ambiguous", "progress"] }).notNull(),
  code: text("code").notNull(),
  message: text("message").notNull(),
  data: json<Record<string, unknown>>("data"),
}, (t) => [
  index("logs_run_id").on(t.runId, t.id),
  index("logs_board").on(t.migrationBoardId),
  index("logs_run_code").on(t.runId, t.code),
]);

export const asanaUsage = sqliteTable("asana_usage", {
  day: text("day").primaryKey(),
  calls: integer("calls").notNull().default(0),
});

export const selectMigrationSchema = createSelectSchema(migrations);
