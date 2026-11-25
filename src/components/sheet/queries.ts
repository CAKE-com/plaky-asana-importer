"use client";

import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";

export function runKey(status: { run: { id: number; status: string } | null } | undefined): string | null | undefined {
  return status === undefined ? undefined : status.run ? `${status.run.id}:${status.run.status}` : null;
}

type TrpcKey = readonly [path: unknown, args?: Readonly<Record<string, unknown>>];
const withoutPart = ([path, args]: TrpcKey): TrpcKey => {
  const rest = { ...args };
  delete rest.part;
  return [path, rest];
};

export function readAgainOn<O extends { queryKey: QueryKey }>(options: O, part: string | number | null | undefined, queryClient: QueryClient): O {
  const [path, args] = options.queryKey as unknown as TrpcKey;
  const base = hashKey(options.queryKey);
  const newest = (): unknown => {
    let found: { at: number; data: unknown } | null = null;
    for (const q of queryClient.getQueryCache().findAll({ queryKey: options.queryKey })) {
      if (q.state.data === undefined || hashKey(withoutPart(q.queryKey as unknown as TrpcKey)) !== base) continue;
      if (!found || q.state.dataUpdatedAt > found.at) found = { at: q.state.dataUpdatedAt, data: q.state.data };
    }
    return found?.data;
  };
  return { ...options, queryKey: [path, { ...args, part: part ?? null }], initialData: newest, initialDataUpdatedAt: 0 } as unknown as O;
}
