import { sameConnectionUser } from "@/server/pipeline/connection-identity";
import { and, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ASANA_TOKEN_REFUSED, PLAKY_KEY_REFUSED } from "@/lib/explain";
import { connections, migrationRuns, migrations, selectMigrationSchema } from "@/db/schema";
import { env, normalizeWebAddress, PLAKY_WEB_ADDRESS, PLAKY_WEB_ADDRESS_HINT } from "@/server/env";
import { activeJob, clientsWith, forgetMigration, rearmResumes, rearmSchedules } from "@/server/jobs/runner";
import { identify, type Identity } from "@/server/pipeline/migration";
import { createMigration, ensureConnection, getMigration, keysFor, saveKeys, type Keys, type Typed } from "@/server/pipeline/store";
import { PreconditionError } from "@/server/errors";
import { AsanaError } from "@/server/clients/asana";
import { PlakyHttpError } from "@/server/clients/plaky";
import type { Context } from "../context";
import { publicProcedure, router } from "../init";
import { migrationProcedure } from "./shared";

const info = z.object({
  account: z.string().nullable(), user: z.string().nullable(), zone: z.string().nullable(), plakyUser: z.string().nullable(), checkedAt: z.number(),
});

const migrationSummary = selectMigrationSchema.pick({ id: true, name: true, status: true, plakySpaceId: true, createdAt: true, updatedAt: true });

async function whose(ctx: Context, keys: Partial<Keys>) {
  const clients = (ctx.clients ?? clientsWith)(keys, { fresh: true });
  try {
    return await identify(clients.asana(), clients.plaky());
  } catch (error) {
    throw refusedKey(error) ?? error;
  }
}

async function record(db: Context["db"], who: Identity, keys: Partial<Typed>) {
  const connectionId = await ensureConnection(db, who.connection);
  await saveKeys(db, connectionId, keys);
  return { account: who.account, user: who.user, zone: who.zone, plakyUser: who.plakyUser, checkedAt: Date.now(), connectionId };
}

export function refusedKey(error: unknown): PreconditionError | null {
  if (error instanceof PlakyHttpError && (error.status === 401 || error.status === 403)) {
    return new PreconditionError(PLAKY_KEY_REFUSED);
  }
  if (error instanceof AsanaError && /\bHTTP 40[13]\b|NOT_AUTHENTICATED|Not authenticated/i.test(error.message)) {
    return new PreconditionError(ASANA_TOKEN_REFUSED);
  }
  return null;
}

const erasedMeanwhile = (migrationId: number) => new TRPCError({ code: "NOT_FOUND", message: `There is no migration ${migrationId}: it was erased.` });

async function connectionOf(db: Context["db"], migration: { id: number; connectionId: number }) {
  const conn = (await db.select({ asanaUserGid: connections.asanaUserGid, asanaUserId: connections.asanaUserId, plakyUserId: connections.plakyUserId }).from(connections).where(eq(connections.id, migration.connectionId)).limit(1))[0];
  if (!conn) throw erasedMeanwhile(migration.id);
  return conn;
}

async function refreshConnection(db: Context["db"], migration: { id: number; connectionId: number }, who: Identity): Promise<void> {
  const written = await db.update(connections).set(who.connection).where(eq(connections.id, migration.connectionId)).returning({ id: connections.id });
  if (!written.length) throw erasedMeanwhile(migration.id);
}

const typedKey = z.string().trim().max(4000).optional().transform((v) => v || null);
const workspaceAddress = z.string().trim().max(200).optional().transform((v) => normalizeWebAddress(v ?? "") || null)
  .refine((v) => v === null || PLAKY_WEB_ADDRESS.test(v), PLAKY_WEB_ADDRESS_HINT);

export const connectionRouter = router({
  env: publicProcedure.output(z.object({ asanaToken: z.boolean(), plakyKey: z.boolean(), defaultSpaceId: z.number().nullable(), plakyWebBase: z.string().nullable() })).query(() => ({
    asanaToken: Boolean(env.ASANA_ACCESS_TOKEN), plakyKey: Boolean(env.PLAKY_API_KEY), defaultSpaceId: env.PLAKY_E2E_SPACE_ID ?? null, plakyWebBase: env.PLAKY_WEB_BASE_URL ?? null,
  })),

  list: publicProcedure.output(z.array(migrationSummary)).query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(migrations).orderBy(desc(migrations.id));
    return rows.map((r) => migrationSummary.parse(r));
  }),

  create: publicProcedure.input(z.object({ name: z.string().trim().min(1).max(80).default("Asana to Plaky"), asanaToken: typedKey, plakyKey: typedKey, plakyWebBase: workspaceAddress }))
    .output(z.object({ migrationId: z.number() }).extend(info.shape)).mutation(async ({ ctx, input }) => {
      const keys = { asanaToken: input.asanaToken, plakyKey: input.plakyKey, plakyWebBase: input.plakyWebBase };
      const who = await whose(ctx, keys);
      const c = await record(ctx.db, who, keys);
      await rearmResumes(ctx.db, undefined, c.connectionId);
      await rearmSchedules(ctx.db, undefined, c.connectionId);
      const migrationId = await createMigration(ctx.db, { connectionId: c.connectionId, name: input.name, plakySpaceId: env.PLAKY_E2E_SPACE_ID ?? null });
      return { migrationId, ...info.parse(c) };
    }),

  forget: migrationProcedure.input(z.object({ confirm: z.string().max(300) })).output(z.object({ erased: z.literal(true) })).mutation(async ({ ctx, input }) => {
    const { name } = await getMigration(ctx.db, input.migrationId);
    if (input.confirm.trim() !== name.trim()) throw new PreconditionError(`type the migration's name, "${name}", to confirm`);
    await forgetMigration(ctx.db, input.migrationId);
    return { erased: true as const };
  }),

  close: migrationProcedure.input(z.object({ confirm: z.string().max(300), newestRunId: z.number().int().positive().nullable() })).output(z.object({ closed: z.literal(true), keysDropped: z.boolean() })).mutation(async ({ ctx, input }) => {
    const { name, connectionId } = await getMigration(ctx.db, input.migrationId);
    if (input.confirm.trim() !== name.trim()) throw new PreconditionError(`type the migration's name, "${name}", to confirm`);
    const newest = (await ctx.db.select({ id: migrationRuns.id, status: migrationRuns.status }).from(migrationRuns)
      .where(and(eq(migrationRuns.migrationId, input.migrationId), inArray(migrationRuns.kind, ["apply", "verify"]))).orderBy(desc(migrationRuns.id)).limit(1))[0];
    if (activeJob(input.migrationId) !== undefined || newest?.status === "running" || (newest?.id ?? null) !== input.newestRunId) {
      throw new PreconditionError("A run finished or started since this page last read it; check the result first.");
    }
    const typed = await keysFor(ctx.db, input.migrationId);
    await forgetMigration(ctx.db, input.migrationId);
    const kept = await ctx.db.select({ id: connections.id }).from(connections).where(eq(connections.id, connectionId)).limit(1);
    return { closed: true as const, keysDropped: kept.length === 0 && (typed.asanaToken !== null || typed.plakyKey !== null) };
  }),

  rekey: migrationProcedure.input(z.object({ asanaToken: typedKey, plakyKey: typedKey })).output(info).mutation(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const held = await keysFor(ctx.db, input.migrationId);
    const who = await whose(ctx, { asanaToken: input.asanaToken ?? held.asanaToken, plakyKey: input.plakyKey ?? held.plakyKey, paidAsana: held.paidAsana === true });
    const keys = { ...(input.asanaToken ? { asanaToken: input.asanaToken } : {}), ...(input.plakyKey ? { plakyKey: input.plakyKey } : {}) };
    const conn = await connectionOf(ctx.db, migration);
    if (!sameConnectionUser(conn, who.connection)) {
      throw new PreconditionError("These keys answer for a different Asana account or Plaky user than this migration was connected with.");
    }
    await refreshConnection(ctx.db, migration, who);
    await saveKeys(ctx.db, migration.connectionId, keys);
    await rearmResumes(ctx.db);
    await rearmSchedules(ctx.db);
    return info.parse({ account: who.account, user: who.user, zone: who.zone, plakyUser: who.plakyUser, checkedAt: Date.now() });
  }),

  check: migrationProcedure.output(info).mutation(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const who = await whose(ctx, await keysFor(ctx.db, input.migrationId));
    const conn = await connectionOf(ctx.db, migration);
    if (!sameConnectionUser(conn, who.connection)) {
      throw new PreconditionError("the keys now answer for a different Asana account or Plaky user than this migration was connected with");
    }
    await refreshConnection(ctx.db, migration, who);
    return info.parse({ account: who.account, user: who.user, zone: who.zone, plakyUser: who.plakyUser, checkedAt: Date.now() });
  }),

  get: migrationProcedure.output(z.object({ migration: migrationSummary.extend({ options: selectMigrationSchema.shape.options }), keysHeld: z.object({ asana: z.boolean(), plaky: z.boolean() }), connection: z.object({ account: z.string(), user: z.string(), zone: z.string().nullable(), plakyUserId: z.number(), typedPlakyKey: z.boolean(), plakyWebBase: z.string().nullable() }) })).query(async ({ ctx, input }) => {
    const migration = await getMigration(ctx.db, input.migrationId);
    const conn = (await ctx.db.select().from(connections).where(eq(connections.id, migration.connectionId)).limit(1))[0]!;
    const held = await keysFor(ctx.db, input.migrationId);
    return {
      migration: { ...migrationSummary.parse(migration), options: migration.options },
      keysHeld: { asana: held.asanaToken !== null, plaky: held.plakyKey !== null },
      connection: { account: conn.asanaAccountId, user: conn.asanaUserId, zone: conn.asanaTimeZone, plakyUserId: conn.plakyUserId, typedPlakyKey: held.plakyKey !== null, plakyWebBase: conn.plakyWebBase },
    };
  }),
});
