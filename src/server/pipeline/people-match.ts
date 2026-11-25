import { eq } from "drizzle-orm";
import { parse, type PeopleChoice, type PeopleTarget } from "@/lib/people-entry";
import type { Db } from "@/db/client";
import { migrations } from "@/db/schema";
import { PreconditionError } from "../errors";
import type { PeopleMap } from "./config";
import { manifestPeople, peopleWithStandIns } from "./link";
import type { Manifest } from "./manifest";
import { withNameFields } from "./name-fields";
import { getMigration, loadLinkConfig, loadManifest, saveLinkConfig, saveManifest } from "./store";
import { standInUsable, type DirectoryUser, type UserDirectory } from "./transform/people";

export type PeopleRow = {
  asanaUserId: string;
  name: string;
  email: string | null;
  state: string;
  plakyUserId: number | null;
  standIn: string | null;
  placeholder: string | null;
  teamExists: boolean;
  problem: string | null;
  other: string | null;
  choice: PeopleChoice;
};

export type { PeopleChoice, PeopleTarget } from "@/lib/people-entry";

export const assignableUsers = (directory: UserDirectory): DirectoryUser[] =>
  [...directory.byId.values()].filter((u) => directory.canAssign(u)).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

export function unmatchedPeople(manifest: Manifest, directory: UserDirectory, people: PeopleMap): PeopleRow[] {
  const resolved = manifestPeople(manifest, directory, people).users;
  const assignable = new Set(assignableUsers(directory).map((u) => u.id));
  const rows: PeopleRow[] = [];
  for (const person of manifest.people) {
    if (person.kind !== "person") continue;
    const { byHand: handWritten, userId, skipped, header, choice } = parse(Object.hasOwn(people, person.id) ? people[person.id]! : null);
    if (!handWritten && directory.assignable(person.email)) continue;
    const r = resolved.get(person.id);
    const gone = userId !== null && !assignable.has(userId);
    rows.push({
      asanaUserId: person.id, name: person.name, email: person.email, state: person.state,
      plakyUserId: userId !== null && Number.isFinite(userId) ? userId : null,
      standIn: r?.teamId != null ? r.placeholder : null,
      placeholder: person.placeholder,
      teamExists: person.placeholder !== null && standInUsable(person.placeholder, directory),
      problem: gone ? `Plaky user ${userId} can no longer be assigned (deactivated, or a viewer): pick another, or no match` : skipped || header ? null : (r?.problem ?? null),
      other: handWritten && userId === null && !skipped && !header ? JSON.stringify(handWritten) : null,
      choice,
    });
  }
  return rows;
}

export async function currentPeople(db: Db, migrationId: number): Promise<{ people: PeopleMap; linked: boolean }> {
  const loaded = await loadLinkConfig(db, migrationId);
  if (loaded) return { people: { ...loaded.config.people }, linked: true };
  return { people: { ...((await getMigration(db, migrationId)).people as PeopleMap) }, linked: false };
}

const entryFor = (target: Exclude<PeopleTarget, "team">): Record<string, unknown> => (target === "unassigned" ? { skip: true } : target === "header" ? { header: true } : { user_id: target });

async function savePeople(db: Db, migrationId: number, manifest: Manifest, directory: UserDirectory, people: PeopleMap): Promise<PeopleMap> {
  const next = peopleWithStandIns(manifest, directory, people);
  const loaded = await loadLinkConfig(db, migrationId);
  if (loaded) {
    await saveLinkConfig(db, migrationId, { ...loaded.config, people: next as PeopleMap });
  } else {
    await db.update(migrations).set({ people: next as Record<string, Record<string, unknown>>, updatedAt: new Date() }).where(eq(migrations.id, migrationId));
  }
  await syncNameFields(db, migrationId);
  return next;
}

export async function savePeopleMatch(db: Db, migrationId: number, manifest: Manifest, directory: UserDirectory, asanaUserId: string, target: PeopleTarget): Promise<PeopleMap> {
  if (!manifest.people.some((p) => p.kind === "person" && p.id === asanaUserId)) throw new PreconditionError(`Asana user ${asanaUserId} is not assigned on the discovered boards`);
  if (typeof target === "number" && !assignableUsers(directory).some((u) => u.id === target)) {
    throw new PreconditionError(`Plaky user ${target} cannot be assigned: not an active member of this workspace (or a viewer)`);
  }
  const { people, linked } = await currentPeople(db, migrationId);
  if (target === "team" && linked) {
    const title = manifest.people.find((p) => p.kind === "person" && p.id === asanaUserId)?.placeholder ?? null;
    if (title === null || !standInUsable(title, directory)) throw new PreconditionError(`the placeholder team '${title ?? "(none)"}' is not ready: it needs to be one empty Plaky team of exactly that name`);
  }
  if (target === "team") delete people[asanaUserId];
  else people[asanaUserId] = entryFor(target);
  return savePeople(db, migrationId, manifest, directory, people);
}

export async function saveEveryoneUnmatched(db: Db, migrationId: number, manifest: Manifest, directory: UserDirectory, target: "header" | "team" | "unassigned"): Promise<number> {
  const { people, linked } = await currentPeople(db, migrationId);
  const rows = unmatchedPeople(manifest, directory, people).filter((r) => r.choice !== "user" && r.choice !== target && !(target === "team" && linked && !r.teamExists));
  if (!rows.length) return 0;
  for (const r of rows) {
    if (target === "team") delete people[r.asanaUserId];
    else people[r.asanaUserId] = entryFor(target);
  }
  await savePeople(db, migrationId, manifest, directory, people);
  return rows.length;
}

export async function syncNameFields(db: Db, migrationId: number): Promise<void> {
  const manifest = await loadManifest(db, migrationId);
  if (!manifest) return;
  const next = withNameFields(manifest, (await currentPeople(db, migrationId)).people);
  if (JSON.stringify(next) !== JSON.stringify(manifest)) await saveManifest(db, migrationId, next);
}

export async function defaultChoices(db: Db, migrationId: number, manifest: Manifest, directory: UserDirectory, o: { seen?: ReadonlySet<string> } = {}): Promise<number> {
  const { people, linked } = await currentPeople(db, migrationId);
  const left = linked && !o.seen ? [] : unmatchedPeople(manifest, directory, people).filter((r) => r.choice === "team" && !o.seen?.has(r.asanaUserId));
  if (left.length) {
    for (const r of left) people[r.asanaUserId] = { header: true };
    if (linked) await savePeople(db, migrationId, manifest, directory, people);
    else await db.update(migrations).set({ people: people as Record<string, Record<string, unknown>>, updatedAt: new Date() }).where(eq(migrations.id, migrationId));
  }
  await syncNameFields(db, migrationId);
  return left.length;
}
