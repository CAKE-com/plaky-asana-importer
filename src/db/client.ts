import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { env } from "@/server/env";
import * as schema from "./schema";

export type Db = LibSQLDatabase<typeof schema> & { $client: Client };

const BUSY_TIMEOUT_MS = 5000;

export async function openDb(url: string = env.DATABASE_URL): Promise<Db> {
  if (url.startsWith("file:") && !url.includes(":memory:")) {
    const path = url.slice("file:".length);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const own = basename(path);
    if (readdirSync(dir).every((entry) => entry.startsWith(own))) {
      try {
        chmodSync(dir, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    }
  }
  const client = createClient({ url, timeout: BUSY_TIMEOUT_MS, concurrency: 1 });
  if (url.startsWith("file:")) {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA secure_delete = ON");
    await client.execute("PRAGMA journal_size_limit = 0");
    if (!url.includes(":memory:")) ownerOnly(url.slice("file:".length));
  }
  await client.execute("PRAGMA foreign_keys = ON");
  return drizzle(client, { schema });
}

function ownerOnly(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(f, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const globalForDb = globalThis as unknown as { __a2pDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!globalForDb.__a2pDb) {
    const opening = openDb();
    opening.catch(() => {
      if (globalForDb.__a2pDb === opening) delete globalForDb.__a2pDb;
    });
    globalForDb.__a2pDb = opening;
  }
  return globalForDb.__a2pDb;
}
