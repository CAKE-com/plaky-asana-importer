export const ITEM_TITLE_HEADER = "Name";
export const ASANA_ID_FIELD = "Asana ID";
export const PARENT_TITLE_FIELD = "Parent Item";
export const PARENT_ID_FIELD = "Parent Asana ID";
export const RESERVED_FIELD_NAMES = [ITEM_TITLE_HEADER, ASANA_ID_FIELD, PARENT_TITLE_FIELD, PARENT_ID_FIELD] as const;

const SEED_MARKER_PREFIX = "seed:";
export const seedMarker = (asanaBoardId: string): string => `${SEED_MARKER_PREFIX}${asanaBoardId}`;
export const isSeedMarker = (value: unknown): boolean => typeof value === "string" && value.startsWith(SEED_MARKER_PREFIX);
export const markerBoardId = (marker: string): string => marker.slice(SEED_MARKER_PREFIX.length);

export const SINCE_MARGIN_MS = 10 * 60_000;

export const levelTwoId = (boardId: string): string => `${boardId}:level2`;
export const baseBoardId = (boardId: string): string => boardId.replace(/:level2$/, "");
export const isLevelTwo = (boardId: string): boolean => boardId.endsWith(":level2");
