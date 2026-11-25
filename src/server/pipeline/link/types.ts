import { type PlakyField } from "../transform/mapping";

export const RATE_LIMITED = "Plaky kept answering 429 (rate limit), so that request was not applied. Re-run to continue.";

export class LinkError extends Error {
  override readonly name = "LinkError";
}

export type MaybePromise<T> = T | Promise<T>;
export type JsonObject = Record<string, unknown>;

export type SeededBoard = {
  plakyBoardId: number;
  asanaBoardId: string;
  fields: PlakyField[];
  seedItemIds: number[];
  seedGroupId: number | null;
};

export type BoardLink = {
  asanaBoardId: string;
  name: string;
  plakyBoardId: number;
  fieldMap: Record<string, string>;
  unmatched: string[];
  warnings: string[];
  skipColumns: string[];
  seedItemIds: number[];
  subitemsOf: string | null;
  nested: boolean;
  asanaIdKey: string | null;
  parentTitleKey: string | null;
  parentIdKey: string | null;
  seedGroupId: number | null;
};

export const isReady = (link: BoardLink): boolean => link.unmatched.length === 0 && link.asanaIdKey !== null;

export type LinkResult = {
  links: BoardLink[];
  missing: [id: string, name: string][];
};
