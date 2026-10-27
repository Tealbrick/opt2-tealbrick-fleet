// The owner form "Add outside agent" (src/ui/outside-agent.tsx, C373 WP-D, Q13) against the real SDK client and a stub
// server, rendered in happy-dom: the form sends person_set with kind outside_agent (and no trust), the result step says
// the entry is unreviewed, and "Trust" is a real review: review_get for the copy, then review_record with its digest.
// "Leave unreviewed" and Cancel record nothing. Plain messages for failures (L18). The module is compiled with the build
// tsconfig into dist/ui-test-outside-agent (JSX needs a compile).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

type Ui = typeof import("../src/ui/outside-agent.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-outside-agent");

const win = new Window({ url: "http://localhost/a/fleet/people", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const DIGEST = "a".repeat(64);
interface Stub {
  calls: { op: string; input: any }[];
  /** op → error to answer with */
  fail: Record<string, { status: number; code: string; message?: string }>;
}
const stub: Stub = { calls: [], fail: {} };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/fleet/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["person_set", "review_record"] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: any };
  stub.calls.push({ op, input: body.input });
  const f = stub.fail[op];
  if (f) return json(f.status, { error: { code: f.code, message: f.message ?? `raw upstream text for ${f.code}`, requestId: "req_1" } });
  if (op === "person_set") return json(200, { status: "ok", output: { person: { id: "psn_01J0000000000000000000BOT1", name: body.input.name, kind: "outside_agent", trust: "unreviewed" } } });
  if (op === "review_get") return json(200, { status: "ok", output: { review: null, current: { digest: DIGEST } } });
  if (op === "review_record") return json(200, { status: "ok", output: { review: { id: "rvw_1", verdict: "trusted" } } });
  return json(404, { error: { code: "not_found", message: op } });
}) as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function mount(el: ReactElement) {
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
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const dialog = () => document.querySelector("dialog") as HTMLDialogElement;
const button = (root: ParentNode, text: string) => {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
async function type(el: Element, value: string) {
  await act(async () => {
    const proto = el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    assert.ok(set, "the value setter");
    set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    el.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
  });
}
const field = (label: string) => {
  const l = [...dialog().querySelectorAll("label")].find((x) => x.textContent?.startsWith(label));
  assert.ok(l, `field ${label}`);
  return (l as HTMLElement).querySelector("input, textarea") as Element;
};
const alerts = (host: ParentNode) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");

let ui: Ui;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  ui = (await import(pathToFileURL(join(outDir, "ui", "outside-agent.js")).href)) as Ui;
});
after(() => rmSync(outDir, { recursive: true, force: true }));
const reset = () => {
  stub.calls = [];
  stub.fail = {};
  for (const d of document.querySelectorAll("dialog")) d.remove();
};
const ops = () => stub.calls.map((c) => c.op);

describe("Add outside agent", () => {
  it("the form sends person_set with kind outside_agent, org, relationship and handles, and never a trust", async () => {
    reset();
    let reloaded = 0;
    const m = await mount(h(ui.OutsideAgentDialog, { onClose() {}, reload: async () => void reloaded++ }));
    assert.match(dialog().textContent ?? "", /It starts unreviewed\. Nothing is trusted until you say so\./);
    assert.equal(button(dialog(), "Add outside agent").disabled, true, "a name is needed first");
    await type(field("Name"), "Partner Bot");
    await type(field("Organisation"), "Acme Ltd");
    await type(field("Relationship"), "Supplier");
    await type(field("Channel handles"), "slack:W0BOT999\nbuzz:npub1abc");
    await click(button(dialog(), "Add outside agent"));
    assert.deepEqual(stub.calls, [{ op: "person_set", input: { name: "Partner Bot", kind: "outside_agent", org: "Acme Ltd", relationship: "Supplier", handles: ["slack:W0BOT999", "buzz:npub1abc"] } }]);
    assert.ok(!("trust" in (stub.calls[0]?.input ?? {})), "trust is never sent");
    assert.equal(reloaded, 1, "the list behind the dialog reloads");
    // the second step says what it is, and offers both ways
    assert.match(dialog().textContent ?? "", /Partner Bot is added/);
    assert.match(dialog().textContent ?? "", /Its trust is unreviewed/);
    assert.ok(button(dialog(), "Leave unreviewed"));
    assert.ok(button(dialog(), "Trust Partner Bot").className.includes("primary"));
    await m.unmount();
  });

  it("Trust records a real review: review_get for the copy, then review_record with its digest and a reason; then it closes", async () => {
    reset();
    let closed = 0;
    let reloaded = 0;
    const m = await mount(h(ui.OutsideAgentDialog, { onClose: () => void closed++, reload: async () => void reloaded++ }));
    await type(field("Name"), "Partner Bot");
    await click(button(dialog(), "Add outside agent"));
    stub.calls = [];
    await click(button(dialog(), "Trust Partner Bot"));
    const subject = { kind: "outside_agent", id: "psn_01J0000000000000000000BOT1" };
    assert.deepEqual(ops(), ["review_get", "review_record"]);
    assert.deepEqual(stub.calls[0]?.input, { subject });
    assert.deepEqual(stub.calls[1]?.input, { subject, verdict: "trusted", reason: "Trusted by the owner right after adding it.", snapshotDigest: DIGEST });
    assert.equal(closed, 1);
    assert.equal(reloaded, 2, "once after adding, once after the verdict");
    await m.unmount();
  });

  it("Leave unreviewed and Cancel record nothing (quiet on good: trust is not a side effect of adding)", async () => {
    reset();
    let closed = 0;
    const m = await mount(h(ui.OutsideAgentDialog, { onClose: () => void closed++, reload: async () => {} }));
    await type(field("Name"), "Partner Bot");
    await click(button(dialog(), "Add outside agent"));
    await click(button(dialog(), "Leave unreviewed"));
    assert.deepEqual(ops(), ["person_set"], "no review was read or recorded");
    assert.equal(closed, 1);
    await m.unmount();
    reset();
    const again = await mount(h(ui.OutsideAgentDialog, { onClose: () => void closed++, reload: async () => {} }));
    await click(button(dialog(), "Cancel"));
    assert.deepEqual(ops(), []);
    await again.unmount();
  });

  it("failures are plain sentences in the dialog: a refused add stays on the form; a stale copy at Trust stays on the second step", async () => {
    reset();
    stub.fail.person_set = { status: 409, code: "handle_taken", message: "slack:W0BOT999 belongs to another person" };
    const m = await mount(h(ui.OutsideAgentDialog, { onClose() {}, reload: async () => {} }));
    await type(field("Name"), "Partner Bot");
    await click(button(dialog(), "Add outside agent"));
    assert.deepEqual(alerts(dialog()), ["Slack:W0BOT999 belongs to another person."]);
    assert.ok(button(dialog(), "Add outside agent"), "still on the form");
    delete stub.fail.person_set;
    await click(button(dialog(), "Add outside agent"));
    stub.fail.review_record = { status: 409, code: "snapshot_stale" };
    await click(button(dialog(), "Trust Partner Bot"));
    assert.deepEqual(alerts(dialog()), ["The subject changed after you looked. Close this and open the review again."]);
    assert.doesNotMatch(dialog().textContent ?? "", /raw upstream/);
    assert.ok(button(dialog(), "Trust Partner Bot"), "still on the second step, can try again");
    await m.unmount();
  });
});
