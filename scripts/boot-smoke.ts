// Boot smoke of the BUILT output (0.2.2 QA-GOV022-1: unit tests on src passed while `node dist/main.js` crashed with
// ERR_MODULE_NOT_FOUND). Runs `node --run build`, starts `node dist/main.js` exactly as the image CMD does (standalone,
// no bridge), and passes only when the health path answers 200 twice and the UI import map is complete. Exit 1 on a crash, a non-200
// or no answer within the timeout. CI: tealbrick-ci.json preReleaseChecks (runs before a release can be tagged).
// Usage: node scripts/boot-smoke.ts [--no-build] [--data <dir>]  (--data: boot on an existing data dir, e.g. a copy of
// an older version's data; without it a fresh ephemeral dir under the OS temp dir is used).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const dataArg = args.includes("--data") ? args[args.indexOf("--data") + 1] : undefined;
if (args.includes("--data") && !dataArg) throw new Error("--data needs a directory");
const TIMEOUT_MS = 60_000;

const fail = (msg: string): never => {
  console.error(`boot-smoke: FAIL ${msg}`);
  process.exit(1);
};

if (!args.includes("--no-build")) {
  const b = spawnSync(process.execPath, ["--run", "build"], { cwd: root, stdio: "inherit" });
  if (b.status !== 0) fail(`build exited ${b.status}`);
}

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as { runtime: { port: number; healthPath: string } };
/** Listens on `want` (0 = any free port) for a moment; the port, or null when it is taken. */
const probeOn = (want: number, host?: string) =>
  new Promise<number | null>((res) => {
    const s = createServer();
    s.once("error", () => res(null));
    const done = () => {
      const a = s.address();
      s.close(() => res(a && typeof a === "object" ? a.port : null));
    };
    if (host) s.listen(want, host, done);
    else s.listen(want, done);
  });
/** Free on the loopback address the smoke calls AND on the wildcard address the SDK binds. */
const probe = async (want: number) => {
  const p = await probeOn(want, "127.0.0.1");
  return p !== null && (await probeOn(p)) !== null ? p : null;
};
// The SDK listens on manifest runtime.port (as in the image). When that port is free (CI), run `node dist/main.js` exactly
// like the image CMD. When it is taken on a dev machine, start the same built module graph (dist/app.js, which dist/main.js
// imports) through startApp with a free port, like conformance.start.ts does.
const exact = (await probe(manifest.runtime.port)) !== null;
const port = exact ? manifest.runtime.port : ((await probe(0)) ?? fail("no free port"));
const dataDir = dataArg ?? mkdtempSync(join(tmpdir(), "fleet-boot-smoke-"));
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  NODE_ENV: "production",
  TB_STANDALONE: "1",
  TB_DATA_DIR: dataDir,
  TB_BACKUP_DIR: join(dataDir, "backup"),
  TB_LOG_LEVEL: "error",
  ...(dataArg ? {} : { TB_DATA_EPHEMERAL: "1" }),
};
const wrapper = `import { startApp } from "@opt2-tealbrick/miniapp-sdk"; import { app } from "./dist/app.js"; await startApp(app, process.env, { port: ${port} });`;
const argv = exact ? ["dist/main.js"] : ["--input-type=module", "-e", wrapper];
console.log(`boot-smoke: starting ${exact ? "node dist/main.js" : `dist/app.js on port ${port} (port ${manifest.runtime.port} is taken here)`}`);
const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (d: Buffer) => {
  stderr += d.toString();
  process.stderr.write(d);
});
let exited: number | null | undefined;
child.on("exit", (code) => {
  exited = code;
});

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + TIMEOUT_MS;
let health = 0;
while (Date.now() < deadline) {
  if (exited !== undefined) fail(`the app exited ${exited} before it was healthy\n${stderr.slice(-2000)}`);
  try {
    health = (await fetch(base + manifest.runtime.healthPath)).status;
    if (health === 200) break;
  } catch {
    // not listening yet
  }
  await new Promise((r) => setTimeout(r, 250));
}
const stop = () => {
  if (exited === undefined) child.kill("SIGTERM");
};
if (health !== 200) {
  stop();
  fail(`no 200 from ${manifest.runtime.healthPath} within ${TIMEOUT_MS / 1000} s (last ${health || "no answer"})`);
}
// still alive a moment after the first 200 (a crash right after listen would otherwise pass)
await new Promise((r) => setTimeout(r, 1500));
if (exited !== undefined) fail(`the app exited ${exited} right after the first health answer\n${stderr.slice(-2000)}`);
const again = (await fetch(base + manifest.runtime.healthPath)).status;
stop();
if (again !== 200) fail(`second health read ${again}`);
// The UI the SDK serves (behind owner auth at /a/<product>/): its index and every module URL in the import map exist.
const uiDir = join(root, "dist", "ui");
const html = readFileSync(join(uiDir, "index.html"), "utf8");
const map = /<script[^>]+type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? fail("dist/ui/index.html has no import map");
const urls = Object.values((JSON.parse(map) as { imports: Record<string, string> }).imports);
const missing = urls.filter((u) => u.startsWith("./") && !existsSync(join(uiDir, u)));
if (missing.length) fail(`import map URLs with no file: ${missing.join(", ")}`);
console.log(`boot-smoke: OK ${exact ? "node dist/main.js" : "dist/app.js"} healthy on ${manifest.runtime.healthPath} (twice), UI import map complete (${urls.length} URLs); data ${dataArg ?? "fresh, ephemeral"}`);
