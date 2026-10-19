// Boot smoke of the BUILT output (0.2.2 QA-GOV022-1: unit tests on src passed while `node dist/main.js` crashed with
// ERR_MODULE_NOT_FOUND). Runs `node --run build`, starts `node dist/main.js` exactly as the image CMD does (standalone,
// no bridge), and passes only when the health path answers 200 with this build's version AND a healthy status twice (the
// SDK's failed mode answers 200 too, with status "failed") and the UI import map is complete. Exit 1 on a crash, a non-200
// or no answer within the timeout. CI: tealbrick-ci.json preReleaseChecks (runs before a release can be tagged).
// Usage: node scripts/boot-smoke.ts [--no-build] [--data <dir>]  (--data: boot on an existing data dir, e.g. a copy of
// an older version's data; without it a fresh ephemeral dir under the OS temp dir is used). TB_RESTORE_FROM in the
// environment is passed on (E3: boot an older version on the restored pre-update snapshot).
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
  // E3 rollback proof: the platform names the pre-update snapshot of the failed version in TB_RESTORE_FROM
  ...(process.env.TB_RESTORE_FROM ? { TB_RESTORE_FROM: process.env.TB_RESTORE_FROM } : {}),
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
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
/** Health states of a booted app (standalone: no claim). The SDK's failed mode ALSO answers 200, with status "failed". */
const HEALTHY = new Set(["ok", "needs_keys"]);
let lastBody = "";
/**
 * 200 only when the answer is OURS and HEALTHY: the body names this build's version (another process on the port fails)
 * and a healthy status (the SDK's failed mode answers 200 with `status: "failed"` and a `failure` code; `restoring` is not
 * done yet).
 */
async function healthOf(url: string): Promise<number> {
  const r = await fetch(url);
  if (r.status !== 200) return r.status;
  const body = (await r.json().catch(() => null)) as { version?: unknown; status?: unknown; failure?: unknown } | null;
  lastBody = JSON.stringify({ version: body?.version, status: body?.status, failure: body?.failure }).slice(0, 400);
  if (body?.version !== version) return -1;
  return typeof body.status === "string" && HEALTHY.has(body.status) ? 200 : -2;
}
const deadline = Date.now() + TIMEOUT_MS;
let health = 0;
while (Date.now() < deadline) {
  if (exited !== undefined) fail(`the app exited ${exited} before it was healthy\n${stderr.slice(-2000)}`);
  try {
    health = await healthOf(base + manifest.runtime.healthPath);
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
  fail(`no 200 with version ${version} from ${manifest.runtime.healthPath} within ${TIMEOUT_MS / 1000} s (last ${health === -1 ? "200 from another version or process" : health === -2 ? `200 but not healthy: ${lastBody}` : health || "no answer"})`);
}
// still alive a moment after the first 200 (a crash right after listen would otherwise pass)
await new Promise((r) => setTimeout(r, 1500));
if (exited !== undefined) fail(`the app exited ${exited} right after the first health answer\n${stderr.slice(-2000)}`);
const again = await healthOf(base + manifest.runtime.healthPath).catch(() => 0);
stop();
if (again !== 200) fail(`second health read ${again} ${lastBody}`);
// The UI the SDK serves (behind owner auth at /a/<product>/): its index and every module URL in the import map exist.
const uiDir = join(root, "dist", "ui");
const html = readFileSync(join(uiDir, "index.html"), "utf8");
const map = /<script[^>]+type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? fail("dist/ui/index.html has no import map");
const urls = Object.values((JSON.parse(map) as { imports: Record<string, string> }).imports);
const missing = urls.filter((u) => u.startsWith("./") && !existsSync(join(uiDir, u)));
if (missing.length) fail(`import map URLs with no file: ${missing.join(", ")}`);
console.log(`boot-smoke: OK ${exact ? "node dist/main.js" : "dist/app.js"} healthy on ${manifest.runtime.healthPath} (twice, ${lastBody}), UI import map complete (${urls.length} URLs); data ${dataArg ?? "fresh, ephemeral"}`);
