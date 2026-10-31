// The Contact rules page (src/ui/contact-rules.tsx) against the real SDK client and a stub server, rendered in happy-dom:
// the proposals with what Rules says about each, the pointer to Approve in Rules, Send again for a proposal that was not
// sent (exact input), plain messages (L18, no raw codes or upstream text), RUL-14, text shown as text.
// The module is compiled with the build tsconfig into dist/ui-test-contact-rules (JSX needs a compile).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

type Page = typeof import("../src/ui/contact-rules.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-contact-rules");

// ── DOM ────────────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/a/fleet/contact-rules", width: 1280, height: 860 });
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

// ── stub server ──────────────────────────────────────────────────────────────
const P = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  template: "hold_outward_for_agent",
  params: { agent: "agt_01J0000000000000000000000A" },
  text: "Hold every outward action of the agent Front desk (agt_01J0000000000000000000000A) until I approve it.",
  review: "rvw_1",
  rulesDraftId: "drf_1",
  status: "sent",
  error: null,
  rulesStatus: "pending",
  decidedAt: null,
  createdAt: "2026-10-14T09:12:00.000Z",
  ...over,
});
const LIST = () => ({
  proposals: [
    P("prp_6", { template: "deny_on_behalf_of_sender", params: { handle: "slack:UBOT000001" }, text: "Refuse every action an agent takes on behalf of the sender slack:UBOT000001.", rulesDraftId: null, status: "failed", error: "too_many_drafts", rulesStatus: null, review: null }),
    P("prp_5", { rulesDraftId: null, status: "held", error: "held", rulesStatus: null }),
    P("prp_4", { rulesStatus: "unknown" }),
    P("prp_3", { rulesStatus: "gone" }),
    P("prp_2", { rulesStatus: "rejected", decidedAt: "2026-10-16T08:00:00.000Z" }),
    P("prp_1", { rulesStatus: "approved", decidedAt: "2026-10-15T08:00:00.000Z" }),
    P("prp_0", { text: "<b>Hold</b> the agent", rulesStatus: "pending" }),
  ],
  nextCursor: null,
});
const TEAMS = () => [
  { id: "tm_1", name: "Front line", description: "", tags: [], members: [] },
  { id: "tm_2", name: "<i>Ops</i>", description: "", tags: [], members: [] },
];
interface Stub {
  teams: ReturnType<typeof TEAMS>;
  calls: { op: string; input: any }[];
  fail: Record<string, { status: number; code: string } | undefined>;
  list: ReturnType<typeof LIST>;
  send: (input: any) => any;
}
const sent = (input: any) => ({ proposal: P("prp_7", { template: input.template, params: input.params, review: input.review ?? null }), duplicate: false });
const stub: Stub = { teams: TEAMS(), calls: [], fail: {}, list: LIST(), send: sent };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/fleet/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["proposal_send"] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: any };
  stub.calls.push({ op, input: body.input });
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  if (op === "proposals_list") return json(200, { status: "ok", output: stub.list });
  if (op === "proposal_send") return json(200, { status: "ok", output: stub.send(body.input) });
  if (op === "overview_get") return json(200, { status: "ok", output: { revision: 1, teams: stub.teams, people: [], agents: [] } });
  return json(404, { error: { code: "not_found", message: op } });
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
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
const button = (root: ParentNode, text: string) => {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
const alerts = (host: ParentNode) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
const rows = (host: Element) => [...host.querySelectorAll(".item")];

let ui: Page;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  ui = (await import(pathToFileURL(join(outDir, "ui", "contact-rules.js")).href)) as Page;
});
after(() => rmSync(outDir, { recursive: true, force: true }));
const reset = () => {
  stub.teams = TEAMS();
  stub.calls = [];
  stub.fail = {};
  stub.list = LIST();
  stub.send = sent;
};
const head = (row: Element | undefined) => row?.querySelector("h3")?.textContent ?? "";

describe("Contact rules page", () => {
  it("lists the proposals with what Rules says about each, and where to approve", async () => {
    reset();
    const m = await mount(h(ui.ContactRulesPage, {}));
    assert.deepEqual(
      stub.calls.sort((a, b) => a.op.localeCompare(b.op)),
      [
        { op: "overview_get", input: {} },
        { op: "proposals_list", input: { limit: 100 } },
      ],
    );
    assert.equal(m.host.querySelector("h1")?.textContent, "Contact rules");
    assert.match(m.host.textContent ?? "", /Approve or reject a draft in Rules & Approvals, under Drafts\. Nothing applies yet\./);
    const r = rows(m.host);
    assert.deepEqual(r.map(head), [
      "Refuse what agents do for this senderNot sent",
      "Hold its outward actionsHeld, not sent",
      "Hold its outward actionsStatus not known: Rules did not answer",
      "Hold its outward actionsRules no longer has this draft",
      "Hold its outward actionsRejected in Rules",
      "Hold its outward actionsApproved in Rules",
      "Hold its outward actionsWaiting for you in Rules",
    ]);
    assert.match(r[0]?.textContent ?? "", /Rules already has too many drafts waiting\. Approve or reject some in Rules, then send it again\./);
    assert.doesNotMatch(r[0]?.textContent ?? "", /too_many_drafts|raw upstream/);
    assert.match(r[1]?.textContent ?? "", /Rules asked you to approve this call first/);
    assert.match(r[4]?.textContent ?? "", /Made 14 Oct 2026 · decided in Rules 16 Oct 2026/);
    assert.deepEqual(
      r.map((x) => [...x.querySelectorAll("button")].map((b) => b.textContent)),
      [["Send again"], ["Send again"], [], [], [], [], []],
      "only a proposal that was not sent can be sent again; there is no Approve button",
    );
    assert.ok(!/Approve\b/.test([...m.host.querySelectorAll("button")].map((b) => b.textContent).join()), "Governance has no approve path");
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("text is shown as text, never as markup", async () => {
    reset();
    const m = await mount(h(ui.ContactRulesPage, {}));
    assert.equal(m.host.querySelector(".item b"), null);
    assert.match(m.host.textContent ?? "", /<b>Hold<\/b> the agent/);
    await m.unmount();
  });

  it("Send again sends the same template, parameter and review; a sent answer reloads the list", async () => {
    reset();
    const m = await mount(h(ui.ContactRulesPage, {}));
    await click(button(rows(m.host)[0] as Element, "Send again"));
    assert.deepEqual(stub.calls.filter((c) => c.op === "proposal_send").map((c) => c.input), [{ template: "deny_on_behalf_of_sender", params: { handle: "slack:UBOT000001" } }]);
    assert.equal(stub.calls.filter((c) => c.op === "proposals_list").length, 2, "reloaded");
    assert.deepEqual(alerts(m.host), []);
    await click(button(rows(m.host)[1] as Element, "Send again"));
    assert.deepEqual(stub.calls.filter((c) => c.op === "proposal_send").at(-1)?.input, { template: "hold_outward_for_agent", params: { agent: "agt_01J0000000000000000000000A" }, review: "rvw_1" });
    await m.unmount();
  });

  it("Send again that Rules refuses again: a plain message, no false success", async () => {
    reset();
    stub.send = (input) => ({ proposal: P("prp_6", { template: input.template, params: input.params, rulesDraftId: null, status: "failed", error: "no_grant", rulesStatus: null }), duplicate: false });
    const m = await mount(h(ui.ContactRulesPage, {}));
    await click(button(rows(m.host)[0] as Element, "Send again"));
    assert.match(alerts(m.host)[0] ?? "", /^The rule was not sent\. This app has no access to Rules & Approvals\. Deploy Rules in this workspace/);
    stub.send = sent;
    stub.fail.proposal_send = { status: 500, code: "internal_error" };
    await click(button(rows(m.host)[0] as Element, "Send again"));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.doesNotMatch(alerts(m.host).join(), /raw upstream/);
    await m.unmount();
  });

  it("an empty list says how to propose one", async () => {
    reset();
    stub.list = { proposals: [], nextCursor: null };
    const m = await mount(h(ui.ContactRulesPage, {}));
    assert.equal(m.host.querySelector(".tb-empty h3")?.textContent, "No contact rules proposed yet.");
    assert.match(m.host.textContent ?? "", /Open a review and use the Contact rule step/);
    await m.unmount();
  });

  it("RUL-14: a failed load is an error with Try again, not an empty state", async () => {
    reset();
    stub.fail.proposals_list = { status: 500, code: "internal_error" };
    const m = await mount(h(ui.ContactRulesPage, {}));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.equal(m.host.querySelector(".tb-empty"), null);
    stub.fail.proposals_list = undefined;
    await click(button(m.host, "Try again"));
    assert.equal(rows(m.host).length, 7);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("team rules: one explicit click per team proposes hold_outward_for_team with exactly that team id", async () => {
    reset();
    const m = await mount(h(ui.ContactRulesPage, {}));
    const list = m.host.querySelector('ul[aria-label="Team rules"]');
    assert.ok(list, "the team list");
    assert.deepEqual([...(list as Element).querySelectorAll("li > span")].map((x) => x.textContent), ["Front line", "<i>Ops</i>"], "names as text");
    assert.equal((list as Element).querySelector("i"), null);
    assert.equal(stub.calls.filter((c) => c.op === "proposal_send").length, 0, "nothing is sent without a click");
    const btn = [...(list as Element).querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Hold the outward actions of the team Front line");
    assert.ok(btn);
    await click(btn as Element);
    assert.deepEqual(stub.calls.filter((c) => c.op === "proposal_send").map((c) => c.input), [{ template: "hold_outward_for_team", params: { team: "tm_1" } }]);
    assert.equal(stub.calls.filter((c) => c.op === "proposals_list").length, 2, "reloaded");
    assert.deepEqual(alerts(m.host), []);
    assert.match(m.host.textContent ?? "", /Every message, email or post that an agent of this team sends outside the workspace waits for your approval/);
    await m.unmount();
  });

  it("team rules: a gone team or a refused send is a plain message; a failed team load hides only the team list", async () => {
    reset();
    stub.fail.proposal_send = { status: 404, code: "team_not_found" };
    const m = await mount(h(ui.ContactRulesPage, {}));
    await click(button(m.host.querySelector('ul[aria-label="Team rules"]') as Element, "Hold outward actions"));
    assert.match(alerts(m.host)[0] ?? "", /This entry is gone\. Reload the page and try again\./);
    assert.doesNotMatch(alerts(m.host).join(), /team_not_found|raw upstream/);
    stub.fail.proposal_send = undefined;
    stub.send = (input) => ({ proposal: P("prp_8", { template: input.template, params: input.params, rulesDraftId: null, status: "failed", error: "too_many_drafts", rulesStatus: null }), duplicate: false });
    await click(button(m.host.querySelector('ul[aria-label="Team rules"]') as Element, "Hold outward actions"));
    assert.match(alerts(m.host)[0] ?? "", /^The rule was not sent\. Rules already has too many drafts waiting/);
    await m.unmount();
    reset();
    stub.fail.overview_get = { status: 500, code: "internal_error" };
    const m2 = await mount(h(ui.ContactRulesPage, {}));
    assert.equal(m2.host.querySelector('ul[aria-label="Team rules"]'), null);
    assert.match(m2.host.textContent ?? "", /The teams could not be loaded/);
    assert.equal(rows(m2.host).length, 7, "the proposals still show");
    assert.deepEqual(alerts(m2.host), []);
    await m2.unmount();
    reset();
    stub.teams = [];
    const m3 = await mount(h(ui.ContactRulesPage, {}));
    assert.match(m3.host.textContent ?? "", /Make a team first to propose a team rule\./);
    await m3.unmount();
  });
});
