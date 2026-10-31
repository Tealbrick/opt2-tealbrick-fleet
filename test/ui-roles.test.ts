// The Roles page (src/ui/pages/roles.tsx) against the real SDK client and a stub server, rendered in happy-dom (C380 T2-a): it says a role is a record,
// the forms that give or end a role say "Ending this does not remove a Portal grant.", a refused change shows one plain sentence, the page is in the
// navigation only after its rows passed. The pixel matrix is scripts/ui-preview.ts; this one runs in CI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-roles");

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
g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);

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

const ROLE = (over: Record<string, unknown> = {}) => ({ id: "rol_A", name: "Contractor", description: "Works for a limited time", archived: false, members: 2, scheduled: 1, createdAt: "2026-10-30T09:00:00Z", ...over });
const ASG = (over: Record<string, unknown> = {}) => ({
  id: "ras_1",
  role: { id: "rol_A", name: "Contractor" },
  subject: { kind: "person", id: "per_1", name: "Marco" },
  reason: "contract",
  note: null,
  validFrom: null,
  validUntil: "2026-12-01T09:00:00Z",
  state: "active",
  endedAt: null,
  endReason: null,
  createdAt: "2026-10-30T09:00:00Z",
  ...over,
});
const DIRECTORY = {
  revision: 1,
  teams: [],
  people: [{ id: "per_1", name: "Marco", kind: "person", status: "active", trust: "trusted", email: null, title: "", tags: [], handles: [], teams: [], updatedAt: "2026-10-30T09:00:00Z", org: "", relationship: "" }],
  agents: [{ id: "agt_A", name: "Henry", status: "active", trust: "trusted", mode: "free", owner: null, role: "", tags: [], teams: [], updatedAt: "2026-10-30T09:00:00Z" }],
};
const list = (roles: unknown[]) => ok({ roles, assignments: [] });

type Roles = typeof import("../src/ui/pages/roles.tsx");
type Features = typeof import("../src/ui/pages/features.ts");
let roles: Roles;
let features: Features;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  roles = (await import(pathToFileURL(join(outDir, "ui", "pages", "roles.js")).href)) as Roles;
  features = (await import(pathToFileURL(join(outDir, "ui", "pages", "features.js")).href)) as Features;
});
after(() => rmSync(outDir, { recursive: true, force: true }));
const reset = () => {
  stub.calls = [];
  stub.answers = {};
};
/** The n-th select of a dialog (in the order of the form), then the option with this text. */
const choose = async (scope: ParentNode, index: number, option: string) => {
  const box = scope.querySelectorAll('[role="combobox"]')[index];
  assert.ok(box, `select ${index}`);
  await click(box as Element);
  const opt = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(option));
  assert.ok(opt, `option ${option}`);
  await click(opt as Element);
};

/** Picks a name in the first column of the bulk editor. */
const pickName = async (host: Element, name: string) => {
  const o = [...host.querySelectorAll('[role="option"]')].find((x) => x.querySelector(".tb-access-pick-name")?.textContent === name);
  assert.ok(o, `option ${name}`);
  await click(o as Element);
};
/** Types in the field with this label. */
const setInput = async (host: Element, label: string, value: string) => {
  const l = [...host.querySelectorAll("label")].find((x) => x.textContent?.trim().startsWith(label));
  const input = (l?.querySelector("input") ?? (l?.htmlFor ? host.querySelector(`[id="${l.htmlFor}"]`) : null)) as HTMLInputElement | null;
  assert.ok(input, `field ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor((window as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  });
  await flush();
};

describe("the Roles page", () => {
  it("says a role is a record, lists roles with their holders, and shows no raw id", async () => {
    reset();
    stub.answers.roles_list = list([ROLE(), ROLE({ id: "rol_B", name: "Old", archived: true, members: 0, scheduled: 0 })]);
    const m = await mount(h(roles.RolesPage, {}));
    const text = m.host.textContent ?? "";
    assert.match(text, /A role is a record of who has it\. It allows and stops nothing by itself\./);
    assert.match(text, /Contractor/);
    assert.match(text, /2 holders/);
    assert.match(text, /1 waiting to start/);
    assert.match(text, /Archived/);
    assert.doesNotMatch(text, /rol_|ras_|agt_|per_/);
    assert.deepEqual(stub.calls.map((c) => [c.op, c.input]), [["roles_list", { includeArchived: true }]]);
    await m.unmount();
  });
  it("empty: says what to do first. Failed: an error with Try again, not an empty page", async () => {
    reset();
    stub.answers.roles_list = list([]);
    let m = await mount(h(roles.RolesPage, {}));
    assert.match(m.host.textContent ?? "", /No roles yet\./);
    assert.match(m.host.textContent ?? "", /Nothing changes until a rule uses it\./);
    await m.unmount();
    reset();
    stub.answers.roles_list = refuse(500, "internal", "raw upstream");
    m = await mount(h(roles.RolesPage, {}));
    assert.ok(button(m.host, "Try again"));
    assert.doesNotMatch(m.host.textContent ?? "", /raw upstream|No roles yet/);
    await m.unmount();
  });
  /** Opens Give for the first role, picks these names in the first column and chooses the reason. */
  const openGive = async (host: Element, names: string[], reason?: string) => {
    await click(button(host, "Give"));
    for (const name of names) await pickName(host, name);
    if (reason) await choose(host, 0, reason);
  };
  it("Give: says that ending it removes no Portal grant, sends the subject, reason and dates, and shows a refusal as one sentence per row", async () => {
    reset();
    stub.answers.roles_list = list([ROLE()]);
    stub.answers.overview_get = ok(DIRECTORY);
    stub.answers.role_get = ok({ role: ROLE(), assignments: [] });
    let refuseFirst = true;
    stub.answers.role_assign = () => {
      if (refuseFirst) {
        refuseFirst = false;
        return refuse(409, "already_assigned", "This role is already assigned. End it first to change the dates.")();
      }
      return ok({ assignment: ASG() })();
    };
    const m = await mount(h(roles.RolesPage, {}));
    await openGive(m.host, ["Marco"], "Contract");
    assert.match(m.host.textContent ?? "", /Ending this does not remove a Portal grant\./);
    assert.match(m.host.textContent ?? "", /A role is a record/);
    await click(button(m.host, "Give Contractor"));
    assert.match(m.host.querySelector(".tb-access-failures")?.textContent ?? "", /Failed: Marco\. This role is already assigned/);
    assert.equal(stub.calls.filter((c) => c.op === "role_assign").length, 1);
    assert.deepEqual(stub.calls.find((c) => c.op === "role_assign")?.input, { role: "rol_A", subject: { kind: "person", id: "per_1" }, reason: "contract" });
    await click(button(m.host, "Give Contractor"));
    assert.equal(stub.calls.filter((c) => c.op === "role_assign").length, 2);
    await m.unmount();
  });
  it("Give to several: every give carries the same reason, note and dates; a refused row stops no other; no success for a failed or unconfirmed row", async () => {
    reset();
    stub.answers.roles_list = list([ROLE()]);
    stub.answers.overview_get = ok(DIRECTORY);
    const given: unknown[] = [];
    stub.answers.role_get = () => ok({ role: ROLE(), assignments: given })();
    stub.answers.role_assign = (input) => {
      if (input.subject.id === "agt_A") return refuse(409, "cannot_hold_both", "Henry holds Payer, and a rule says one holder cannot hold both.")();
      given.push(ASG({ subject: { kind: input.subject.kind, id: input.subject.id, name: "Marco" } }));
      return ok({ assignment: ASG() })();
    };
    const m = await mount(h(roles.RolesPage, {}));
    await openGive(m.host, ["Marco", "Henry"], "Project work");
    await setInput(m.host, "Note", "For the launch");
    await setInput(m.host, "Ends", "2099-12-01T09:00");
    await click(button(m.host, "Give Contractor"));
    const sent = stub.calls.filter((c) => c.op === "role_assign").map((c) => c.input);
    assert.equal(sent.length, 2);
    const until = new Date("2099-12-01T09:00").toISOString();
    assert.deepEqual(sent.find((x) => x.subject.id === "per_1"), { role: "rol_A", subject: { kind: "person", id: "per_1" }, reason: "project", note: "For the launch", validUntil: until });
    assert.deepEqual(sent.find((x) => x.subject.id === "agt_A"), { role: "rol_A", subject: { kind: "agent", id: "agt_A" }, reason: "project", note: "For the launch", validUntil: until });
    const text = m.host.textContent ?? "";
    assert.match(text, /1 of 2 changes failed/);
    assert.match(text, /Failed: Henry\. Henry holds Payer/);
    assert.match(text, /1 set, 1 failed/);
    await m.unmount();
  });
  it("Give skips who already has the role, and nothing here ends a role", async () => {
    reset();
    stub.answers.roles_list = list([ROLE()]);
    stub.answers.overview_get = ok(DIRECTORY);
    stub.answers.role_get = ok({ role: ROLE(), assignments: [ASG()] });
    stub.answers.role_assign = ok({ assignment: ASG() });
    const m = await mount(h(roles.RolesPage, {}));
    await openGive(m.host, ["Marco"], "Contract");
    assert.match([...m.host.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes("Marco"))?.textContent ?? "", /Already given/);
    await click(button(m.host, "Give Contractor"));
    assert.equal(stub.calls.filter((c) => c.op === "role_assign").length, 0, "no write");
    assert.match(m.host.textContent ?? "", /Nothing to change: they already have Contractor\./);
    assert.equal([...m.host.querySelectorAll("button")].some((b) => /^End/.test(b.textContent?.trim() ?? "")), false, "ending stays on the list of holders");
    await m.unmount();
  });
  it("Give without a reason, or with an end date that has passed, sends nothing and says why", async () => {
    reset();
    stub.answers.roles_list = list([ROLE()]);
    stub.answers.overview_get = ok(DIRECTORY);
    stub.answers.role_get = ok({ role: ROLE(), assignments: [] });
    const m = await mount(h(roles.RolesPage, {}));
    await openGive(m.host, ["Marco"]);
    assert.match(m.host.textContent ?? "", /Choose why\./);
    assert.equal(button(m.host, "Give Contractor").disabled, true);
    await choose(m.host, 0, "Contract");
    assert.equal(button(m.host, "Give Contractor").disabled, false);
    await setInput(m.host, "Ends", "2001-01-01T09:00");
    assert.match(m.host.textContent ?? "", /The end date has passed/);
    assert.equal(button(m.host, "Give Contractor").disabled, true);
    assert.equal(stub.calls.filter((c) => c.op === "role_assign").length, 0);
    await m.unmount();
  });
  it("Who has it: shows each holder with a plain state; End asks once, says no Portal grant is removed, and ends only what is open", async () => {
    reset();
    stub.answers.roles_list = list([ROLE()]);
    stub.answers.role_get = ok({
      role: ROLE(),
      assignments: [ASG(), ASG({ id: "ras_2", subject: { kind: "agent", id: "agt_A", name: "Henry" }, state: "scheduled", validFrom: "2026-11-05T09:00:00Z", validUntil: null }), ASG({ id: "ras_3", subject: { kind: "person", id: "per_2", name: "Bob" }, state: "ended", endedAt: "2026-10-31T09:00:00Z", endReason: "expired" })],
    });
    stub.answers.role_end = ok({ assignment: ASG({ state: "ended", endedAt: "2026-10-31T10:00:00Z", endReason: "owner" }) });
    const m = await mount(h(roles.RolesPage, {}));
    await click(button(m.host, "Who has it"));
    const rows = [...m.host.querySelectorAll(".holder")];
    assert.equal(rows.length, 3);
    assert.match(rows[0]?.textContent ?? "", /Contract\. Active until 1 Dec 2026, 09:00 UTC/);
    assert.match(rows[1]?.textContent ?? "", /Starts 5 Nov 2026, 09:00 UTC/);
    assert.match(rows[2]?.textContent ?? "", /Ended 31 Oct 2026, 09:00 UTC: the end date passed/);
    assert.deepEqual(rows.map((r) => [...r.querySelectorAll("button")].map((b) => b.textContent)), [["End"], ["End"], []]);
    await click(button(rows[0] as Element, "End"));
    const dlg = m.host.querySelector("dialog") as Element;
    assert.match(dlg.textContent ?? "", /Ending this does not remove a Portal grant\./);
    assert.equal(stub.calls.filter((c) => c.op === "role_end").length, 0, "the first press only asks");
    await click(button(dlg, "End now"));
    assert.deepEqual(stub.calls.filter((c) => c.op === "role_end").map((c) => c.input), [{ assignment: "ras_1" }]);
    await m.unmount();
  });
  it("Archive says a rule that names the role matches no one; Bring back is the way up", async () => {
    reset();
    stub.answers.roles_list = list([ROLE(), ROLE({ id: "rol_B", name: "Old", archived: true })]);
    stub.answers.role_set = ok({ role: ROLE({ archived: true }) });
    const m = await mount(h(roles.RolesPage, {}));
    const card = (name: string) => [...m.host.querySelectorAll("article")].find((c) => c.textContent?.includes(name)) as Element;
    assert.deepEqual([...card("Old").querySelectorAll("button")].map((b) => b.textContent), ["Who has it", "Edit", "Bring back"], "an archived role cannot be given");
    await click(button(card("Contractor"), "Archive"));
    const dlg = m.host.querySelector("dialog") as Element;
    assert.match(dlg.textContent ?? "", /A rule that names an archived role matches no one\. A rule that refuses, or waits for your approval, by this role stops doing so\./);
    assert.match(dlg.textContent ?? "", /Archiving ends no assignment and removes no Portal grant\./);
    assert.doesNotMatch(dlg.textContent ?? "", /Ending this does not remove/, "archiving ends nothing: the sentence for ending is not used here");
    await click(button(dlg, "Save"));
    assert.deepEqual(stub.calls.find((c) => c.op === "role_set")?.input, { id: "rol_A", archived: true });
    await m.unmount();
  });
  it("an archived role shows no count of holders (rules see none); a start the server never made reads plainly", async () => {
    reset();
    stub.answers.roles_list = list([ROLE({ id: "rol_B", name: "Old", archived: true, members: 2, scheduled: 1 })]);
    const m = await mount(h(roles.RolesPage, {}));
    const text = m.host.textContent ?? "";
    assert.match(text, /Archived/);
    assert.doesNotMatch(text, /holders|waiting to start/);
    await m.unmount();
    assert.equal(roles.stateText({ state: "ended", validFrom: null, validUntil: null, endedAt: "2026-10-31T09:00:00Z", endReason: "not_started" }), "Ended 31 Oct 2026, 09:00 UTC: it never started: the entry was leaving, closed or gone");
    assert.equal(roles.stateText({ state: "ended", validFrom: null, validUntil: null, endedAt: "2026-10-31T09:00:00Z", endReason: "kind_changed" }), "Ended 31 Oct 2026, 09:00 UTC: the person became an outside agent");
  });
  it("a value that is not a date reads as undefined (the view then says Check the end date and sends nothing); the open list of holders is read again after Give", async () => {
    reset();
    assert.equal(roles.isoOf(""), null);
    assert.equal(roles.isoOf("10000-01-01T00:00"), undefined, "a six-digit year is not a date");
    assert.equal(roles.isoOf("2026-12-01T09:00"), new Date("2026-12-01T09:00").toISOString());
    stub.answers.roles_list = list([ROLE()]);
    stub.answers.overview_get = ok(DIRECTORY);
    stub.answers.role_get = ok({ role: ROLE(), assignments: [ASG()] });
    stub.answers.role_assign = ok({ assignment: ASG() });
    const m = await mount(h(roles.RolesPage, {}));
    await click(button(m.host, "Who has it"));
    assert.match(m.host.textContent ?? "", /Marco/);
    await click(button(m.host, "Give"));
    await click(button(m.host, "Back to roles"));
    const before = stub.calls.filter((c) => c.op === "role_get").length;
    assert.ok(before >= 2, "the holders and the Give view each read");
    assert.match(m.host.textContent ?? "", /Marco/, "the holders are shown again");
    await m.unmount();
  });
  it("the repeated buttons say which role or person they are for", async () => {
    reset();
    stub.answers.roles_list = list([ROLE()]);
    const m = await mount(h(roles.RolesPage, {}));
    const names = [...m.host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    assert.deepEqual(names.filter(Boolean), ["Give Contractor", "Who has Contractor", "Edit Contractor", "Archive Contractor"]);
    await m.unmount();
  });
  it("a new role sends its name and description; a taken name is a sentence", async () => {
    reset();
    stub.answers.roles_list = list([]);
    stub.answers.role_set = refuse(409, "role_name_taken", "Another role has this name.");
    const m = await mount(h(roles.RolesPage, {}));
    await click(button(m.host, "New role"));
    const dlg = m.host.querySelector("dialog") as Element;
    const [name, description] = [...dlg.querySelectorAll("input")] as HTMLInputElement[];
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set as (v: string) => void;
      set.call(name, "Contractor");
      name?.dispatchEvent((new win.Event("input", { bubbles: true }) as unknown as Event));
      set.call(description, "Short");
      description?.dispatchEvent((new win.Event("input", { bubbles: true }) as unknown as Event));
    });
    await click(button(dlg, "Save"));
    assert.deepEqual(stub.calls.find((c) => c.op === "role_set")?.input, { name: "Contractor", description: "Short" });
    assert.match(dlg.querySelector('[role="alert"]')?.textContent ?? "", /Another role has this name\./);
    await m.unmount();
  });
});

describe("the page stays out of the navigation until its rows pass", () => {
  const ROLE_OPS = ["roles_list", "role_get", "role_set", "role_assign", "role_end"];
  it("ops on and rows not passed: a route, no navigation entry. Both on: in the navigation. An op missing: neither", () => {
    assert.equal(features.ROLES_ROWS_PASSED, true, "R1 to R4 PASS on BOARD");
    assert.deepEqual([features.featuresOf(ROLE_OPS, false).roles, features.featuresOf(ROLE_OPS, false).rolesInNav], [true, false]);
    assert.deepEqual([features.featuresOf(ROLE_OPS, true).roles, features.featuresOf(ROLE_OPS, true).rolesInNav], [true, true]);
    assert.deepEqual([features.featuresOf(ROLE_OPS.slice(1), true).roles, features.featuresOf(ROLE_OPS.slice(1), true).rolesInNav], [false, false]);
    assert.deepEqual([features.featuresOf([], true).roles, features.featuresOf([], true).rolesInNav], [false, false]);
  });
});
