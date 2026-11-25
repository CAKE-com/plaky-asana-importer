import type { PlakyTeam as ApiTeam, PlakyUser as ApiUser } from "../../clients/plaky";
import type { ExtractedTeam, ExtractedUser } from "../extract";
import { isHeader, isSkipped, parse } from "@/lib/people-entry";
import { TEAM_KEY } from "../config";
import { asId, titleKey, type PersonValue } from "./mapping";
import { pyStrip } from "./pystr";
import { pyRepr, sortedStrings, strOf } from "./pyvalue";

export type DirectoryUser = {
  id: number;
  email: string;
  name: string;
  status: string;
  type: string;
};

export type DirectoryTeam = {
  id: number;
  title: string;
  members: readonly number[];
  allUsers: boolean;
};

export class UserDirectory {
  readonly byEmail = new Map<string, DirectoryUser>();
  readonly byId = new Map<number, DirectoryUser>();
  readonly teamsById = new Map<number, DirectoryTeam>();

  static fromPlaky(users: readonly ApiUser[], teams: readonly ApiTeam[]): UserDirectory {
    const directory = new UserDirectory();
    for (const raw of users) {
      const email = pyStrip(raw.email || "").toLowerCase();
      const id = asId(raw.id);
      if (!email || id === null) continue;
      const user: DirectoryUser = {
        id,
        email,
        name: raw.name || email,
        status: (raw.status || "ACTIVE").toUpperCase(),
        type: (raw.type || "MEMBER").toUpperCase(),
      };
      directory.byEmail.set(email, user);
      directory.byId.set(id, user);
    }
    for (const raw of teams) {
      const id = asId(raw.id);
      if (id === null) continue;
      directory.teamsById.set(id, {
        id,
        title: raw.title || "",
        members: (raw.members || []).map(asId).filter((m): m is number => m !== null),
        allUsers: Boolean(raw.allUsersTeam),
      });
    }
    return directory;
  }

  resolve(email: string | null | undefined): DirectoryUser | null {
    if (!email) return null;
    return this.byEmail.get(pyStrip(email).toLowerCase()) ?? null;
  }

  canAssign(user: DirectoryUser): boolean {
    return (user.status === "ACTIVE" || user.status === "PENDING") && user.type !== "VIEWER";
  }

  assignable(email: string | null | undefined): DirectoryUser | null {
    const user = this.resolve(email);
    return user !== null && this.canAssign(user) ? user : null;
  }

  emailOf(userId: unknown): string | null {
    const id = asId(userId);
    if (id === null) return null;
    return this.byId.get(id)?.email ?? null;
  }

  teamsTitled(title: string): DirectoryTeam[] {
    if (!title?.trim()) return [];
    const wanted = titleKey(title);
    return [...this.teamsById.values()].filter((team) => !team.allUsers && titleKey(team.title) === wanted);
  }
}

export type Resolved = {
  userId: number | null;
  teamId: number | null;
  problem: string | null;
  placeholder: string | null;
  skipped: boolean;
};

export function resolved(fields: Partial<Resolved> = {}): Resolved {
  return { userId: null, teamId: null, problem: null, placeholder: null, skipped: false, ...fields };
}

export function isCarried(r: Resolved): boolean {
  return r.userId !== null || r.teamId !== null;
}

export class People {
  constructor(
    readonly users: Map<string, Resolved> = new Map(),
    readonly teams: Map<string, Resolved> = new Map(),
  ) {}

  value(entries: Iterable<readonly [kind: string, id: string]>, limit: number | null = null): [PersonValue | null, string[]] {
    const users: number[] = [];
    const teams: number[] = [];
    const warnings: string[] = [];
    for (const [kind, asanaId] of entries) {
      const resolvedOne = (kind === "team" ? this.teams : this.users).get(String(asanaId));
      if (resolvedOne?.skipped) continue;
      if (resolvedOne === undefined || !isCarried(resolvedOne)) {
        const reason = resolvedOne ? strOf(resolvedOne.problem) : "not resolved";
        warnings.push(`Asana ${kind} ${asanaId}: ${reason}`);
        continue;
      }
      if (resolvedOne.userId !== null && !users.includes(resolvedOne.userId)) users.push(resolvedOne.userId);
      if (resolvedOne.teamId !== null && !teams.includes(resolvedOne.teamId)) teams.push(resolvedOne.teamId);
    }
    if (limit !== null) {
      for (const [label, chosen] of [["user", users], ["team", teams]] as const) {
        if (chosen.length > limit) {
          warnings.push(`the Plaky field holds at most ${limit} ${label}(s); kept the first ${limit} of ${chosen.length} in Asana's order`);
          chosen.length = limit;
        }
      }
    }
    if (!users.length && !teams.length) return [null, warnings];
    const value: PersonValue = {};
    if (users.length) value.users = users.map((id) => ({ id }));
    if (teams.length) value.teams = teams.map((id) => ({ id }));
    return [value, warnings];
  }

  subscriberIds(asanaUserIds: Iterable<string>): number[] {
    const ids = new Set<number>();
    for (const uid of asanaUserIds) {
      const userId = this.users.get(String(uid))?.userId;
      if (userId !== undefined && userId !== null) ids.add(userId);
    }
    return [...ids].sort((a, b) => a - b);
  }

  problems(): string[] {
    const out: string[] = [];
    for (const [uid, r] of this.users) if (r.problem) out.push(`Asana user ${uid}: ${r.problem}`);
    for (const [tid, r] of this.teams) if (r.problem) out.push(`Asana team ${tid}: ${r.problem}`);
    return sortedStrings(out);
  }
}

export type AsanaUserRow = Partial<Pick<ExtractedUser, "name" | "email" | "enabled" | "isPending">> & { isDeleted?: boolean | null | undefined };

export type PeopleOverride = Readonly<Record<string, unknown>>;
export type PeopleOverrides = Readonly<Record<string, PeopleOverride>>;

const isEmptyRow = (row: object): boolean => Object.values(row).every((v) => v === undefined);

export function asanaState(row: AsanaUserRow | null | undefined): "active" | "pending" | "inactive" {
  if (!row || isEmptyRow(row)) return "inactive";
  if (row.enabled === false || row.isDeleted) return "inactive";
  if (row.isPending) return "pending";
  return "active";
}

const STAND_IN_SUFFIX = { inactive: "inactive", pending: "pending", active: "not in Plaky" } as const;

const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

const ADDRESS = /(?:"[^"]+"|[^\s@<>"(),;:]+)@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+/g;

export const withoutAddresses = (text: string, uid: string): string =>
  text.replace(ADDRESS, (address) => `${address.slice(0, address.lastIndexOf("@")).replace(/^"|"$/g, "").replace(/\+.*$/, "") || "Asana user"} …${uid.slice(-4)}`);

export function shownName(name: string | null | undefined, uid: string): string {
  const shown = pyStrip(name || "") || `Asana user ${uid}`;
  const display = /^(.*?)\s*<[^<>]*@[^<>]*>$/.exec(shown)?.[1]?.replace(/^"|"$/g, "").trim();
  return display || withoutAddresses(shown, uid);
}

export const notInPlakyTitle = (name: string | null | undefined, uid: string): string => `${shownName(name, uid)} (${STAND_IN_SUFFIX.active})`;
export const notInPlakyTitleNumbered = (name: string | null | undefined, uid: string): string => `${shownName(name, uid)} #${uid} (${STAND_IN_SUFFIX.active})`;

export function placeholderTitles(asanaUsers: Readonly<Record<string, AsanaUserRow>>, ids: Iterable<string>): Map<string, string> {
  const wanted = new Map<string, [name: string, state: string]>();
  for (const uid of ids) {
    const row = own(asanaUsers, String(uid));
    const state = STAND_IN_SUFFIX[asanaState(row)];
    wanted.set(String(uid), [shownName(row?.name, String(uid)), state]);
  }
  const counts = new Map<string, number>();
  for (const [name, state] of wanted.values()) {
    const key = titleKey(`${name} ${state}`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const titles = new Map<string, string>();
  for (const [uid, [name, state]] of wanted) {
    const clash = (counts.get(titleKey(`${name} ${state}`)) ?? 0) > 1;
    titles.set(uid, clash ? `${name} #${uid} (${state})` : `${name} (${state})`);
  }
  return titles;
}

export function resolvePeople(args: {
  userIds: Iterable<string>;
  teamIds: Iterable<string>;
  asanaUsers: Readonly<Record<string, AsanaUserRow>>;
  asanaTeams: Readonly<Record<string, Pick<ExtractedTeam, "name" | "users">>>;
  directory: UserDirectory;
  overrides?: PeopleOverrides | null;
}): People {
  const { asanaUsers, asanaTeams, directory } = args;
  const overrides = args.overrides ?? {};
  const people = new People();
  const userIds = [...new Set([...args.userIds].map(String))];
  const placeholders = placeholderTitles(asanaUsers, userIds);

  for (const uid of userIds) {
    const row = own(asanaUsers, uid) ?? {};
    const override = own(overrides, uid);
    const recorded = parse(override).standIn;
    if (override && Object.keys(override).length && recorded === null) {
      const gone = asanaState(row) !== "active";
      people.users.set(uid, fromOverride(override, directory, gone ? placeholders.get(uid)! : null));
      continue;
    }
    const user = directory.assignable(row.email);
    if (user !== null) {
      people.users.set(uid, resolved({ userId: user.id }));
      continue;
    }
    const team = directory.teamsById.get(asId(recorded) || -1);
    if (team === undefined) {
      people.users.set(uid, placeholder(placeholders.get(uid)!, directory));
    } else if (team.members.length) {
      people.users.set(uid, busy(team.title));
    } else {
      people.users.set(uid, resolved({ teamId: team.id, placeholder: team.title }));
    }
  }

  for (const tid of new Set([...args.teamIds].map(String))) {
    const teamOverride = own(overrides, `${TEAM_KEY}${tid}`);
    if (teamOverride !== undefined) {
      people.teams.set(tid, fromOverride(teamOverride, directory, null));
      continue;
    }
    people.teams.set(tid, matchTeam(own(asanaTeams, tid) ?? {}, tid, directory));
  }
  return people;
}

function placeholder(title: string, directory: UserDirectory): Resolved {
  const teams = directory.teamsTitled(title);
  if (teams.length > 1) return resolved({ problem: namesakes(title, teams), placeholder: title });
  const only = teams[0];
  if (only === undefined) {
    return resolved({
      problem: `create an empty Plaky team named exactly '${title}' (Teams -> +, rename, then remove yourself), then re-run`,
      placeholder: title,
    });
  }
  if (only.members.length) return busy(title);
  return resolved({ teamId: only.id, placeholder: title });
}

export function standInUsable(title: string, directory: UserDirectory): boolean {
  return placeholder(title, directory).teamId !== null;
}

function namesakes(title: string, teams: readonly DirectoryTeam[]): string {
  const ids = teams.map((team) => team.id).sort((a, b) => a - b).join(", ");
  return `${teams.length} Plaky teams are named '${title}' (ids ${ids}); keep one: delete or rename the others, then re-run`;
}

function busy(title: string): Resolved {
  return resolved({
    problem:
      `Plaky team '${title}' stands in for someone Plaky cannot assign but has members; remove them ` +
      "(the team's creator is added automatically), or every item assigned to it notifies them",
    placeholder: title,
  });
}

function fromOverride(override: PeopleOverride, directory: UserDirectory, placeholderTitle: string | null): Resolved {
  const has = (key: string): boolean => Object.hasOwn(override, key);
  if (isSkipped(override) || isHeader(override)) return resolved({ skipped: true });
  if (has("user_id")) {
    const user = directory.byId.get(asId(override.user_id) || -1);
    if (user === undefined) return resolved({ problem: `'people' maps to Plaky user ${strOf(override.user_id)}, not found` });
    return resolved({ userId: user.id });
  }
  if (has("email")) {
    const user = directory.assignable(strOf(override.email));
    if (user === null) return resolved({ problem: `'people' maps to ${strOf(override.email)}, which has no active Plaky account` });
    return resolved({ userId: user.id });
  }
  if (has("team_id") || has("team")) {
    let team: DirectoryTeam | undefined;
    if (has("team_id")) {
      team = directory.teamsById.get(asId(override.team_id) || -1);
    } else {
      const named = directory.teamsTitled(strOf(override.team));
      if (named.length > 1) return resolved({ problem: namesakes(strOf(override.team), named) });
      team = named[0];
    }
    if (team === undefined) {
      const wanted = has("team_id") ? override.team_id : override.team;
      return resolved({ problem: `'people' maps to Plaky team ${pyRepr(wanted)}, not found` });
    }
    if (placeholderTitle !== null && team.members.length) return busy(team.title);
    return resolved({ teamId: team.id, placeholder: placeholderTitle });
  }
  return resolved({ problem: `'people' entry ${pyRepr(override)} is not a recognised form` });
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function matchTeam(team: Partial<Pick<ExtractedTeam, "name" | "users">>, tid: string, directory: UserDirectory): Resolved {
  const name = pyStrip(team.name || "");
  const named = directory.teamsTitled(name);
  if (named.length === 1) return resolved({ teamId: named[0]!.id });
  const emails = new Set<string>();
  for (const member of team.users || []) if (member && member.email) emails.add(pyStrip(member.email).toLowerCase());
  if (emails.size) {
    const members = new Set<number>();
    for (const [teamId, candidate] of directory.teamsById) {
      if (!candidate.allUsers && sameSet(new Set(candidate.members.map((m) => directory.emailOf(m))), emails)) members.add(teamId);
    }
    if (members.size === 1) return resolved({ teamId: [...members][0]! });
  }
  if (named.length > 1) return resolved({ problem: namesakes(name, named) });
  const who = emails.size ? sortedStrings(emails).join(", ") : "no members listed";
  const label = name ? `'${name}'` : tid;
  return resolved({ problem: `no Plaky team matches Asana team ${label}; create one with that name (${who}), then re-run` });
}
