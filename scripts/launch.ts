import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildStamp, createEnvFile, installStamp, isThisApp, openCommand } from "./lib/launch-stamp";

const root = join(import.meta.dir, "..");
const inRoot = (...parts: string[]): string => join(root, ...parts);
const quiet = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };

function step(what: string, command: string[]): void {
  console.log(`\n${what}…`);
  const { status } = spawnSync(command[0]!, command.slice(1), { cwd: root, stdio: "inherit", env: quiet });
  if (status !== 0) {
    console.error(`\nStopped: ${what.toLowerCase()} failed. The lines above say why.`);
    process.exit(1);
  }
}

const stampOf = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null);
const installed = inRoot("node_modules", ".a2p-install");
const built = inRoot(".next", "A2P_BUILD");

async function isOurs(port: number): Promise<boolean> {
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return answer.ok && isThisApp(await answer.json());
  } catch {
    return false;
  }
}

function isFree(port: number): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const [command, ...args] = openCommand(process.platform, url);
  const { status, error } = spawnSync(command!, args, { stdio: "ignore" });
  if (status !== 0 || error) console.log(`Open ${url} in your browser.`);
}

const PORTS = Array.from({ length: 20 }, (_, i) => 3000 + i);

const current = stampOf(installed) === installStamp(root) && stampOf(built) === buildStamp(root);
for (const port of PORTS) {
  if (await isOurs(port)) {
    if (!current) {
      console.error(`An older copy of the app is running at http://localhost:${port}. Stop it (Ctrl+C in its window), then run \`bun run launch\` again.`);
      process.exit(1);
    }
    console.log(`Already running: http://localhost:${port}`);
    openBrowser(`http://localhost:${port}`);
    process.exit(0);
  }
}
if (createEnvFile(root) === "narrowed") console.log(".env was readable by other accounts on this computer; it is now readable by you only.");
const install = installStamp(root);
if (stampOf(installed) !== install) {
  step("Installing", ["bun", "install", "--frozen-lockfile"]);
  writeFileSync(installed, install);
}
const build = buildStamp(root);
if (!existsSync(inRoot(".next", "BUILD_ID")) || stampOf(built) !== build) {
  step("Building (about a minute, the first time and after an update)", ["bun", "run", "build"]);
  mkdirSync(inRoot(".next"), { recursive: true });
  writeFileSync(built, build);
}

const port = PORTS.find(isFree);
if (port === undefined) {
  console.error("Stopped: ports 3000 to 3019 are all in use.");
  process.exit(1);
}
const url = `http://localhost:${port}`;
console.log(`\nStarting on ${url}…`);
const app = Bun.spawn(["bun", "run", "start", "-p", String(port)], { cwd: root, stdio: ["inherit", "inherit", "pipe"], env: { ...quiet, PLAKY_E2E_SPACE_ID: "" } });
let stopped = false;
void (async () => {
  const lines = app.stderr.getReader();
  for (let part = await lines.read(); !part.done; part = await lines.read()) {
    if (!stopped) process.stderr.write(part.value);
  }
})();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopped = true;
    app.kill();
  });
}

for (let tries = 0; app.exitCode === null; tries++) {
  if (await isOurs(port)) {
    openBrowser(url);
    console.log(`\nRunning at ${url}. Keep this window open; press Ctrl+C to stop.`);
    break;
  }
  if (tries === 120) console.log(`\nThe app has not answered at ${url} after a minute. The lines above may say why; it keeps trying. Press Ctrl+C to stop.`);
  await Bun.sleep(500);
}
const code = await app.exited;
process.exit(stopped ? 0 : code);
