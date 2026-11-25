import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";

const INSTALL_FILES = ["package.json", "bun.lock"];
const BUILD_FILES = [...INSTALL_FILES, "next.config.ts", "tsconfig.json"];
const BUILD_FOLDERS = ["src", "drizzle"];

function filesUnder(root: string, dir: string): string[] {
  if (!existsSync(join(root, dir))) return [];
  return (readdirSync(join(root, dir), { recursive: true }) as string[])
    .map((name) => `${dir}/${name.split(/[\\/]/).join("/")}`)
    .filter((path) => statSync(join(root, path)).isFile())
    .sort();
}

function hashOf(root: string, paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(`${path}\0`);
    hash.update(existsSync(join(root, path)) ? readFileSync(join(root, path)) : "(absent)");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function isThisApp(health: unknown): boolean {
  if (typeof health !== "object" || health === null) return false;
  const { app, migrations } = health as { app?: unknown; migrations?: unknown };
  return app === pkg.name && typeof migrations === "number";
}

export const installStamp = (root: string): string => hashOf(root, INSTALL_FILES);
export const buildStamp = (root: string): string =>
  hashOf(root, [...BUILD_FILES, ...BUILD_FOLDERS.flatMap((dir) => filesUnder(root, dir))]);

export function openCommand(platform: NodeJS.Platform, url: string): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

export function createEnvFile(root: string): "made" | "narrowed" | "kept" {
  const path = join(root, ".env");
  try {
    writeFileSync(path, readFileSync(join(root, ".env.example")), { mode: 0o600, flag: "wx" });
    return "made";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    chmodSync(path, 0o600);
    return "narrowed";
  }
  return "kept";
}
