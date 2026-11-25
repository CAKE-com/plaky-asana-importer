import { sweepArchiveFiles } from "@/server/pipeline/archive";
import { getDb, type Db } from "@/db/client";
import { sweepInterrupted, type Clients } from "@/server/jobs/runner";
import type { Keys } from "@/server/pipeline/store";

export type Context = {
  db: Db;
  clients?: ((keys: Partial<Keys>, options?: { fresh?: boolean }) => Clients) | undefined;
};

export async function createContext(): Promise<Context> {
  await sweepArchiveFiles();
  const db = await getDb();
  await sweepInterrupted(db);
  return { db };
}
