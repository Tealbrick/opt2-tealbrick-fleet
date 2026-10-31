// Fixture preview of the built UI (C380 B10, CONTRACT row 7): serves dist/ui under /a/fleet/ with the SDK session and
// person ops answered from scenes (scripts/ui-preview/scenes.ts), opens each scene at 1280 and 375, light and dark, and
// writes one PNG per cell, report.json and a contact sheet. Nothing here reaches a workspace: the server binds to
// 127.0.0.1 and answers only from the scene. The checks a screenshot cannot make by eye fail the run (exit 1): sideways
// scroll, console or page errors, an op with no fixture, and on `strict` scenes a raw id outside <details> or a word the
// plain-word table replaced (DESIGN-C380 §10).
//
//   node --run build && node scripts/ui-preview.ts [--out <dir>] [--only <regex>] [--serve <scene>]
//
// --serve keeps one scene running for a manual look. Dark mode: the kit's dark tokens are opt-in by `data-theme="dark"`
// on <html>; the app sets it from prefers-color-scheme (src/ui/theme.ts), and a cell fails if it did not. The Chromium comes from Playwright's cache (`npx playwright-core install
// chromium`), or from env TB_PREVIEW_CHROMIUM. Output defaults to <repo>/.ui-preview (ignored by git).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright-core";
import { type Answer, type Scene, scenes } from "./ui-preview/scenes.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const ui = join(root, "dist", "ui");
const BASE = "/a/fleet/";

const SIZES = [
  { name: "1280", width: 1280, height: 860 },
  { name: "375", width: 375, height: 812 },
] as const;
const THEMES = ["light", "dark"] as const;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

/** Replaced words of the §10 table; a strict scene fails when one is visible. */
const OLD_WORDS = /\b(Colleagues?|Offboard(?:ed|ing)?|Rehire|Trust reviews?|Campaigns?|Topology|Exclusions?|Evidence)\b/i;
/** The name of a page or state, not the verb ("this file holds", "rules you proposed"). */
const OLD_PAGE_WORD = /\b(?:Holds|Proposed)\b/;
/** A raw id of this platform: prefix, underscore, at least 6 id characters. */
const RAW_ID = /\b(?:agt|per|psn|pln|ins|con|lev|rvw|drf|prp|hld|rcp|tm|team|ws|rel|rnd|rol)_[0-9A-Za-z]{6,}\b/;

const { values: args } = parseArgs({ options: { out: { type: "string" }, only: { type: "string" }, serve: { type: "string" } } });
const out = resolve(args.out ?? join(root, ".ui-preview"));
const only = args.only ? new RegExp(args.only) : null;

if (!existsSync(join(ui, "index.html"))) {
  console.error("ui-preview: dist/ui/index.html is missing. Run: node --run build");
  process.exit(2);
}

/** The app's built kit with PERSON_OPS replaced by the scene's list: a scene decides which ops the manifest "has". */
function kitFor(scene: Scene): string {
  const assets = readdirSync(ui).find((d) => /^assets-[0-9a-f]+$/.test(d));
  const file = assets ? join(ui, assets, "vendor", "opt2-tealbrick-fleet", "dist", "kit", "index.js") : "";
  const source = readFileSync(existsSync(file) ? file : join(root, "dist", "kit", "index.js"), "utf8");
  if (!scene.personOps) return source;
  const PERSON_OPS = /export const PERSON_OPS = \[[^\]]*\]/;
  if (!PERSON_OPS.test(source)) throw new Error("ui-preview: the kit has no PERSON_OPS list");
  return source.replace(PERSON_OPS, `export const PERSON_OPS = ${JSON.stringify(scene.personOps)}`);
}

function indexFor(): string {
  const built = readFileSync(join(ui, "index.html"), "utf8");
  if (!built.includes('<html lang="en">') || !built.includes('<script type="importmap">')) throw new Error("ui-preview: index.html changed shape");
  return built.replace(/<script type="importmap">(.*?)<\/script>/s, (_m, json: string) => {
    const map = JSON.parse(json) as { imports: Record<string, string> };
    map.imports["#kit"] = "/__preview/kit.js"; // an override, not a change of the build
    return `<script type="importmap">${JSON.stringify(map)}</script>`;
  });
}

type Cell = { scene: string; size: string; theme: string; shot: string; problems: string[] };

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** One server per run; `current` is the scene being shot. */
function startServer(state: { current: Scene; theme: string; unknownOps: Set<string>; unexpected: Set<string>; calls: { op: string; input: unknown }[] }): Promise<Server> {
  const answer = (res: ServerResponse, a: Answer) => {
    if (a.kind === "hang") return; // stays open until the run closes all connections
    if (a.kind === "error") return json(res, a.status, { error: { code: a.code, message: a.message ?? a.code, details: a.details } });
    json(res, 200, { status: "ok", output: a.value });
  };
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/__preview/kit.js") {
        res.writeHead(200, { "content-type": TYPES[".js"] as string });
        res.end(kitFor(state.current));
        return;
      }
      if (!path.startsWith(BASE)) {
        res.writeHead(404).end();
        return;
      }
      const rest = path.slice(BASE.length);
      if (rest === "tb/v1/session") {
        if (state.current.signedOut) return json(res, 401, { error: { code: "session_required", message: "no session" } });
        return json(res, 200, { csrf: "preview", idempotencyRequired: [], principal: { kind: "person", id: "preview", name: "Preview owner" } });
      }
      const op = /^tb\/v1\/ops\/([^/]+)$/.exec(rest)?.[1];
      if (op) {
        const name = decodeURIComponent(op);
        const body = (await readBody(req)) || "{}";
        const input = (JSON.parse(body) as { input?: unknown }).input ?? {};
        state.calls.push({ op: name, input });
        const fixture = Object.hasOwn(state.current.ops, name) ? state.current.ops[name] : undefined;
        if (!fixture) {
          state.unknownOps.add(name);
          return json(res, 404, { error: { code: "unknown_tool", message: name } });
        }
        return answer(res, fixture(input));
      }
      if (rest.startsWith("tb/")) {
        state.unexpected.add(`route with no answer: ${rest}`);
        return json(res, 404, { error: { code: "not_found", message: rest } });
      }
      const file = normalize(join(ui, rest));
      if (file.startsWith(ui + sep) && existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
        res.end(readFileSync(file));
        return;
      }
      if (extname(rest)) {
        state.unexpected.add(`missing file: ${rest}`);
        res.writeHead(404).end();
        return;
      }
      // every other path under the base is a page of the app (SDK-API §14)
      res.writeHead(200, { "content-type": TYPES[".html"] as string });
      res.end(indexFor());
    })().catch((e: unknown) => {
      state.unexpected.add(`server error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

/** Visible text of the page without the Details block (`details.details`: the one place for raw ids). */
const visibleText = (page: Page) =>
  page.evaluate(() => {
    const copy = document.body.cloneNode(true) as HTMLElement;
    for (const d of copy.querySelectorAll("details.details, script, style")) d.remove();
    // one space between text nodes, or two cells would join into one word and the \b of the checks would not fire
    const parts: string[] = [];
    const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? "");
    return parts.join(" ");
  });

async function shoot(page: Page, baseUrl: string, scene: Scene, state: { unknownOps: Set<string>; unexpected: Set<string> }, file: string): Promise<string[]> {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    // a scene that answers an op with an error makes the browser log a failed request: that is the scene, not a defect
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  await page.goto(new URL(scene.path, baseUrl).href, { waitUntil: "load" });
  if (scene.ready) await page.getByText(scene.ready, { exact: false }).first().waitFor({ timeout: 8000 });
  if (scene.steps) await scene.steps(page);
  await page.waitForTimeout(200);
  await page.screenshot({ path: file, fullPage: true });
  // QA D8: the app itself follows the system setting; the preview only sets that setting
  const dark = await page.evaluate(() => document.documentElement.dataset.theme === "dark");
  if (dark !== file.endsWith("-dark.png")) problems.push(`theme: data-theme ${dark ? "dark" : "not dark"}`);
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  if (width.scroll > width.inner) problems.push(`sideways scroll: ${width.scroll} > ${width.inner}`);
  for (const op of state.unknownOps) problems.push(`op with no fixture: ${op}`);
  problems.push(...state.unexpected);
  if (scene.strict) {
    const text = await visibleText(page);
    const id = RAW_ID.exec(text)?.[0];
    if (id) problems.push(`raw id outside Details: ${id}`);
    const word = OLD_WORDS.exec(text)?.[0] ?? OLD_PAGE_WORD.exec(text)?.[0];
    if (word) problems.push(`replaced word: ${word}`);
  }
  if (scene.expect) for (const t of scene.expect) if (!(await visibleText(page)).includes(t)) problems.push(`missing text: ${t}`);
  if (scene.forbid) for (const t of scene.forbid) if ((await visibleText(page)).includes(t)) problems.push(`text that must not appear: ${t}`);
  return problems;
}

function contactSheet(cells: Cell[]): string {
  const byScene = new Map<string, Cell[]>();
  for (const c of cells) byScene.set(c.scene, [...(byScene.get(c.scene) ?? []), c]);
  const rows = [...byScene].map(
    ([name, list]) =>
      `<section><h2>${name}</h2><div class="row">${list
        .map((c) => `<figure class="${c.problems.length ? "bad" : ""}"><img src="${c.shot}" alt="" loading="eager"/><figcaption>${c.size} ${c.theme}${c.problems.length ? ` | ${c.problems.join("; ").replaceAll("<", "&lt;")}` : ""}</figcaption></figure>`)
        .join("")}</div></section>`,
  );
  return `<!doctype html><meta charset="utf-8"><title>Fleet UI matrix</title><style>
  body{font:13px system-ui;margin:16px;background:#fff;color:#111}h2{font-size:14px;margin:16px 0 6px}
  .row{display:flex;gap:10px;align-items:flex-start}figure{margin:0}img{display:block;border:1px solid #bbb;width:auto;max-height:520px}
  figcaption{padding:3px 0;max-width:420px}.bad figcaption{color:#b00;font-weight:700}</style>${rows.join("")}`;
}

const chosen = args.serve ? scenes.filter((s) => s.name === args.serve) : scenes.filter((s) => !only || only.test(s.name));
if (chosen.length === 0) {
  console.error(`ui-preview: no scene matches. Scenes: ${scenes.map((s) => s.name).join(", ")}`);
  process.exit(2);
}
const state = { current: chosen[0] as Scene, theme: "light", unknownOps: new Set<string>(), unexpected: new Set<string>(), calls: [] as { op: string; input: unknown }[] };
const server = await startServer(state);
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${BASE}`;

if (args.serve) {
  console.log(`ui-preview: scene ${args.serve} at ${new URL((chosen[0] as Scene).path, baseUrl).href} (Ctrl-C stops)`);
} else {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch(process.env.TB_PREVIEW_CHROMIUM ? { executablePath: process.env.TB_PREVIEW_CHROMIUM } : {});
  const cells: Cell[] = [];
  try {
    for (const scene of chosen) {
      for (const size of SIZES) {
        for (const theme of THEMES) {
          state.current = scene;
          state.theme = theme;
          state.unknownOps = new Set();
          state.unexpected = new Set();
          state.calls = [];
          scene.reset?.();
          const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, reducedMotion: "reduce", colorScheme: theme });
          const page = await context.newPage();
          const shot = `${scene.name}-${size.name}-${theme}.png`;
          let problems: string[];
          try {
            problems = await shoot(page, baseUrl, scene, state, join(out, shot));
          } catch (e) {
            problems = [`scene failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`];
          }
          if (scene.assertCalls) problems.push(...scene.assertCalls(state.calls));
          cells.push({ scene: scene.name, size: size.name, theme, shot, problems });
          await context.close();
          server.closeAllConnections();
        }
      }
    }
    const html = join(out, "index.html");
    writeFileSync(html, contactSheet(cells));
    const sheet = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
    const page = await sheet.newPage();
    await page.goto(`file://${html}`, { waitUntil: "load" });
    await page.screenshot({ path: join(out, "contact-sheet.jpg"), fullPage: true, type: "jpeg", quality: 60 });
    await sheet.close();
  } finally {
    await browser.close();
  }
  const failed = cells.filter((c) => c.problems.length);
  writeFileSync(join(out, "report.json"), `${JSON.stringify({ cells: cells.length, failed: failed.length, results: cells }, null, 2)}\n`);
  for (const c of failed) console.log(`FAIL ${c.scene} ${c.size} ${c.theme}: ${c.problems.join("; ")}`);
  console.log(`ui-preview: ${chosen.length} scenes, ${cells.length} cells, ${failed.length} failed. Output: ${relative(process.cwd(), out) || dirname(out)}`);
  server.close();
  process.exit(failed.length ? 1 : 0);
}
