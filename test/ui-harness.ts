// The page tests of the Tier 2 pages (C380 T2-b): the real SDK client against a stub server, rendered in happy-dom. Importing this file sets up the window and the
// `fetch` stub for the process; each test file runs in its own process. `compileUi` builds the pages once and returns a loader for them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));

const win = new Window({ url: "http://localhost/a/fleet/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "PopStateEvent"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

interface Stub {
  calls: { op: string; input: any }[];
  answers: Record<string, ((input: any) => { status: number; body: unknown }) | undefined>;
}
export const ok = (output: unknown) => () => ({ status: 200, body: { status: "ok", output } });
export const refuse = (status: number, code: string, message: string) => () => ({ status, body: { error: { code, message } } });
export const stub: Stub = { calls: [], answers: {} };
export const reset = () => {
  stub.calls = [];
  stub.answers = {};
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/fleet/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: any };
  stub.calls.push({ op, input: body.input });
  const answer = stub.answers[op];
  if (!answer) return json(404, { error: { code: "unknown_tool", message: op } });
  const a = answer(body.input);
  return json(a.status, a.body);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");
export const h = createElement;

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
export async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "fleet" }, el)));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}
export const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
export const button = (scope: ParentNode, text: string) => {
  const found = [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
export const typeInto = async (el: Element, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};
export const callsOf = (op: string) => stub.calls.filter((c) => c.op === op).map((c) => c.input);

/** Builds the app once into `dist/<name>`, as the build does, and loads a page module from it. The caller removes the folder with `cleanUi`. */
export function compileUi(name: string): (page: string) => Promise<unknown> {
  const outDir = join(root, "dist", name);
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
  return (page) => import(pathToFileURL(join(outDir, "ui", "pages", `${page}.js`)).href);
}
export const cleanUi = (name: string): void => rmSync(join(root, "dist", name), { recursive: true, force: true });
