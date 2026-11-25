import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = import.meta.dirname;
const { version } = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { version: string };

export const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_APP_VERSION: version },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  agentRules: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    root: projectRoot,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
