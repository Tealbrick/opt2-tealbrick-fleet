// The Cannot hold both page (src/ui/pages/exclusions.tsx) against the real SDK client and a stub server, rendered in happy-dom (C380 T2-c): it says
// "This checks roles only. Portal grants are not checked.", lists the rules with who breaks them, makes and archives a rule, shows a refusal as one plain
// sentence, uses none of the replaced words, and is in the navigation only after its rows passed. The pixel matrix is scripts/ui-preview.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-exclusions");

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
const ok = (output: unknown) => () => ({ status: 200, body: { status: "ok", output } });
const refuse = (status: number, code: string, message: string, details?: unknown) => () => ({ status, body: { error: { code, message, details } } });
const stub: Stub = { calls: [], answers: {} };
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


const RULE = (over: Record<string, unknown> = {}) => ({
  id: "xcl_A",
  kind: "roles",
  a: { id: "rol_A", name: "Approver" },
  b: { id: "rol_B", name: "Payer" },
  text: "No one may have both Approver and Payer.",
  note: "Finance policy",
  archived: false,
  idle: false,
  clashCount: 0,
  clashes: [],
  createdAt: "2026-10-30T09:00:00Z",
  ...over,
});
const CLASH = { subject: { kind: "person", id: "per_1", name: "Marco" }, text: "Marco has Approver and Payer now. A rule says no one may have both." };
const ROLES = [
  { id: "rol_A", name: "Approver", description: "", archived: false, members: 1, scheduled: 0, createdAt: "2026-10-30T09:00:00Z" },
  { id: "rol_B", name: "Payer", description: "", archived: false, members: 1, scheduled: 0, createdAt: "2026-10-30T09:00:00Z" },
  { id: "rol_C", name: "Old role", description: "", archived: true, members: 0, scheduled: 0, createdAt: "2026-10-30T09:00:00Z" },
];
const list = (rules: unknown[]) => ok({ rules });
const REPLACED = /\b(Exclusions?|Holds)\b/i;

type Page = typeof import("../src/ui/pages/exclusions.tsx");
type Roles = typeof import("../src/ui/pages/roles.tsx");
type Features = typeof import("../src/ui/pages/features.ts");
let page: Page;
let roles: Roles;
let features: Features;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  page = (await import(pathToFileURL(join(outDir, "ui", "pages", "exclusions.js")).href)) as Page;
  roles = (await import(pathToFileURL(join(outDir, "ui", "pages", "roles.js")).href)) as Roles;
  features = (await import(pathToFileURL(join(outDir, "ui", "pages", "features.js")).href)) as Features;
});
after(() => rmSync(outDir, { recursive: true, force: true }));
const reset = () => {
  stub.calls = [];
  stub.answers = {};
  stub.answers.roles_list = ok({ roles: ROLES, assignments: [] });
};
/** The n-th select of a dialog (in the order of the form), then the option with this text. */
const choose = async (scope: ParentNode, index: number, option: string) => {
  const box = scope.querySelectorAll('[role="combobox"]')[index];
  assert.ok(box, `select ${index}`);
  await click(box as Element);
  // two selects offer the same roles: take the option of the listbox this select opened, not the first of the page
  const id = box.getAttribute("aria-controls");
  const scoped = id ? document.getElementById(id) : null;
  const all = [...(scoped ?? document).querySelectorAll('[role="option"]')];
  const opt = all.find((o) => o.textContent?.includes(option));
  assert.ok(opt, `option ${option}`);
  await click(opt as Element);
};

describe("the Cannot hold both page", () => {
  it("the roles-only line of the page is the line of the server's words", async () => {
    const server = await import("../src/roles/exclusions.ts");
    assert.equal(page.ROLES_ONLY_LINE, server.EXCLUSION_LINE);
  });
  it("says it checks roles only, lists rules with who breaks them, and shows no raw id and no replaced word", async () => {
    reset();
    stub.answers.exclusions_list = list([
      RULE({ clashCount: 1, clashes: [CLASH] }),
      RULE({ id: "xcl_B", kind: "holder_owner", text: "An agent may not have Writes while its owner has Approves.", note: null }),
      RULE({ id: "xcl_C", archived: true, text: "No one may have both Treasurer and Clerk." }),
      RULE({ id: "xcl_D", idle: true, text: "No one may have both Old role and Payer." }),
    ]);
    const m = await mount(h(page.CannotHoldBothPage, {}));
    const text = m.host.textContent ?? "";
    assert.match(text, /Cannot hold both/);
    assert.match(text, /This checks roles only\. Portal grants are not checked\./);
    assert.match(text, /A rule is checked when you give a role, with its dates\./);
    assert.match(text, /No one may have both Approver and Payer\./);
    assert.match(text, /Broken by 1/);
    assert.match(text, /Marco Person/);
    assert.match(text, /Marco has Approver and Payer now\./);
    assert.match(text, /Why: Finance policy/);
    assert.match(text, /Agent and owner/);
    assert.match(text, /The owner of an agent is its owner now\./);
    assert.match(text, /Not broken/);
    assert.match(text, /Archived/);
    assert.match(text, /A role of this rule is archived\. The rule does nothing until the role is back\./);
    assert.doesNotMatch(text, /xcl_|rol_|per_|agt_/);
    assert.doesNotMatch(text, REPLACED);
    assert.deepEqual(stub.calls.map((c) => [c.op, c.input]), [["exclusions_list", { includeArchived: true }]]);
    await m.unmount();
  });
  it("many who break a rule: the first ten are named and the rest are counted", async () => {
    reset();
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...CLASH, subject: { kind: "person", id: `per_${i}`, name: `Person ${i}` } }));
    stub.answers.exclusions_list = list([RULE({ clashCount: 14, clashes: ten })]);
    const m = await mount(h(page.CannotHoldBothPage, {}));
    assert.match(m.host.textContent ?? "", /Broken by 14/);
    assert.match(m.host.textContent ?? "", /Person 9/);
    assert.match(m.host.textContent ?? "", /And 4 more\. See them in Access, under Differences\./);
    await m.unmount();
  });
  it("empty: says what a rule is. Failed: an error with Try again, not an empty page", async () => {
    reset();
    stub.answers.exclusions_list = list([]);
    let m = await mount(h(page.CannotHoldBothPage, {}));
    assert.match(m.host.textContent ?? "", /No rules yet\./);
    assert.match(m.host.textContent ?? "", /Nothing is checked until you add one\./);
    assert.match(m.host.textContent ?? "", /This checks roles only\./);
    await m.unmount();
    reset();
    stub.answers.exclusions_list = refuse(500, "internal", "raw upstream");
    m = await mount(h(page.CannotHoldBothPage, {}));
    assert.ok(button(m.host, "Try again"));
    assert.doesNotMatch(m.host.textContent ?? "", /raw upstream|No rules yet/);
    await m.unmount();
  });
  it("New rule: the form carries the roles-only line, lists live roles only, sends kind and roles, shows a refusal as one sentence, then saves", async () => {
    reset();
    stub.answers.exclusions_list = list([]);
    let refuseFirst = true;
    stub.answers.exclusion_set = () => {
      if (refuseFirst) {
        refuseFirst = false;
        return refuse(409, "rule_exists", "A rule for these roles exists.")();
      }
      return ok({ rule: RULE() })();
    };
    const m = await mount(h(page.CannotHoldBothPage, {}));
    await click(button(m.host, "New rule"));
    const dlg = m.host.querySelector("dialog") as Element;
    assert.match(dlg.textContent ?? "", /This checks roles only\. Portal grants are not checked\./);
    assert.match(dlg.textContent ?? "", /No one may have both roles/);
    assert.match(dlg.textContent ?? "", /First role/);
    await choose(dlg, 1, "Approver");
    assert.equal([...document.querySelectorAll('[role="option"]')].some((o) => o.textContent?.includes("Old role")), false, "an archived role is not offered");
    await choose(dlg, 2, "Payer");
    await click(button(dlg, "Save"));
    assert.match(dlg.querySelector('[role="alert"]')?.textContent ?? "", /A rule for these roles exists\./);
    assert.deepEqual(stub.calls.find((c) => c.op === "exclusion_set")?.input, { kind: "roles", roleA: "rol_A", roleB: "rol_B" });
    await click(button(dlg, "Save"));
    assert.equal(stub.calls.filter((c) => c.op === "exclusion_set").length, 2);
    await m.unmount();
  });
  it("New rule: no roles chosen sends nothing; the same role twice for a pair sends nothing; an agent and its owner may name one role twice", async () => {
    reset();
    stub.answers.exclusions_list = list([]);
    stub.answers.exclusion_set = ok({ rule: RULE({ kind: "holder_owner" }) });
    const m = await mount(h(page.CannotHoldBothPage, {}));
    await click(button(m.host, "New rule"));
    const dlg = m.host.querySelector("dialog") as Element;
    await click(button(dlg, "Save"));
    assert.match(dlg.querySelector('[role="alert"]')?.textContent ?? "", /Choose two roles\./);
    await choose(dlg, 1, "Approver");
    await choose(dlg, 2, "Approver");
    await click(button(dlg, "Save"));
    assert.match(dlg.querySelector('[role="alert"]')?.textContent ?? "", /Choose two different roles\./);
    assert.equal(stub.calls.filter((c) => c.op === "exclusion_set").length, 0);
    // the other kind: the labels change, the same role is allowed
    await choose(dlg, 0, "An agent may not have a role its owner has");
    assert.match(dlg.textContent ?? "", /The agent has/);
    assert.match(dlg.textContent ?? "", /Its owner has/);
    assert.match(dlg.textContent ?? "", /The owner of an agent is its owner now\./);
    await click(button(dlg, "Save"));
    assert.deepEqual(stub.calls.find((c) => c.op === "exclusion_set")?.input, { kind: "holder_owner", roleA: "rol_A", roleB: "rol_A" });
    await m.unmount();
  });
  it("Archive says the rule is no longer checked and changes no role and no grant; Bring back asks the same way", async () => {
    reset();
    stub.answers.exclusions_list = list([RULE(), RULE({ id: "xcl_C", archived: true, text: "No one may have both Treasurer and Clerk." })]);
    stub.answers.exclusion_set = ok({ rule: RULE() });
    const m = await mount(h(page.CannotHoldBothPage, {}));
    const archive = [...m.host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Archive: No one may have both Approver and Payer.") as HTMLButtonElement;
    assert.ok(archive, "the button names its rule");
    await click(archive);
    const dlg = m.host.querySelector("dialog") as Element;
    assert.match(dlg.textContent ?? "", /The rule is no longer checked\. Roles already given stay as they are\. No Portal grant changes\./);
    assert.match(dlg.textContent ?? "", /This checks roles only\./);
    await click(button(dlg, "Save"));
    assert.deepEqual(stub.calls.find((c) => c.op === "exclusion_set")?.input, { id: "xcl_A", archived: true });
    const back = [...m.host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.startsWith("Bring back:")) as HTMLButtonElement;
    await click(back);
    const dlg2 = m.host.querySelector("dialog") as Element;
    assert.match(dlg2.textContent ?? "", /The rule is checked again\./);
    await m.unmount();
  });
});

describe("a refused role shows both roles in one plain sentence on the Roles page", () => {
  it("Give: cannot_hold_both is shown as its own sentence, not the shared wording", async () => {
    reset();
    stub.answers.roles_list = ok({ roles: [{ ...ROLES[1], members: 0 }], assignments: [] });
    stub.answers.overview_get = ok({
      revision: 1,
      teams: [],
      people: [{ id: "per_1", name: "Marco", kind: "person", status: "active", trust: "trusted", email: null, title: "", tags: [], handles: [], teams: [], updatedAt: "2026-10-30T09:00:00Z", org: "", relationship: "" }],
      agents: [],
    });
    const sentence = "Marco already has Approver (with no end date). A rule says no one may have both Approver and Payer. Choose dates that do not overlap, or end the other role first.";
    stub.answers.role_assign = refuse(409, "cannot_hold_both", sentence);
    const m = await mount(h(roles.RolesPage, {}));
    await click(button(m.host, "Give"));
    const dlg = m.host.querySelector("dialog") as Element;
    await choose(dlg, 0, "Marco (person)");
    await choose(dlg, 1, "Contract");
    await click(button(dlg, "Save"));
    assert.equal(dlg.querySelector('[role="alert"]')?.textContent, sentence);
    assert.doesNotMatch(dlg.textContent ?? "", REPLACED);
    await m.unmount();
  });
});

describe("the page stays out of the navigation until its rows pass", () => {
  const ROLE_OPS = ["roles_list", "role_get", "role_set", "role_assign", "role_end"];
  const RULE_OPS = ["exclusions_list", "exclusion_set"];
  const both = [...ROLE_OPS, ...RULE_OPS];
  const at = (ops: string[], rows = false) => [features.featuresOf(ops, true, rows).exclusions, features.featuresOf(ops, true, rows).exclusionsInNav];
  it("ops on and rows not passed: a route, no navigation entry. Both on: in the navigation. An op missing: neither", () => {
    assert.equal(features.EXCLUSION_ROWS_PASSED, false, "flip this constant only in the PR that carries the BOARD line with R9 to R11 PASS");
    assert.deepEqual(at(both), [true, false]);
    assert.deepEqual(at(both, true), [true, true]);
    assert.deepEqual(at(RULE_OPS, true), [false, false], "the page lists roles, so the role ops are needed too");
    assert.deepEqual(at([...ROLE_OPS, "exclusions_list"], true), [false, false]);
    assert.deepEqual(at([], true), [false, false]);
    // the rule page does not move the Roles page
    assert.deepEqual([features.featuresOf(both).roles, features.featuresOf(both).rolesInNav], [true, false]);
  });
});
