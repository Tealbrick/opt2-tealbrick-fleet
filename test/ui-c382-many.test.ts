// The bulk editors of Governance (C382 batch 2), against the real SDK client and a stub server, in happy-dom: Teams > Members is one call on a list read just
// before it, a member the page does not show stays; Agents > owner sends only the owner, per agent; a card stays readable at 40 members.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { giveProblem, memberPreview, membersAfter } from "../src/ui/pages/many.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-c382");

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

const PERSON = (id: string, name: string, over: object = {}) => ({ id, name, kind: "person", status: "active", trust: "trusted", email: null, title: "", tags: [], handles: [], teams: [], updatedAt: "2026-10-31T09:00:00Z", org: "", relationship: "", ...over });
const AGENT = (id: string, name: string, over: object = {}) => ({ id, name, status: "active", trust: "trusted", mode: "free", owner: null, role: "Triage", tags: ["eu"], teams: [], updatedAt: "2026-10-31T09:00:00Z", ...over });
const TEAM = (over: object = {}) => ({ id: "tea_1", name: "Support", description: "", tags: [], members: [], ...over });

type Dir = { revision: number; teams: ReturnType<typeof TEAM>[]; people: unknown[]; agents: unknown[] };
const stub = {
  calls: [] as { op: string; input: any }[],
  dir: { revision: 1, teams: [], people: [], agents: [] } as Dir,
  answers: {} as Record<string, (input: any) => { status: number; body: unknown } | undefined>,
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
  const answer = stub.answers[op]?.(body.input);
  if (answer) return json(answer.status, answer.body);
  if (op === "overview_get") return json(200, { status: "ok", output: stub.dir });
  return json(200, { status: "ok", output: {} });
}) as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
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
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text);
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
const pickName = async (host: Element, name: string) => {
  const o = [...host.querySelectorAll('[role="option"]')].find((x) => x.querySelector(".tb-access-pick-name")?.textContent === name);
  assert.ok(o, `option ${name}`);
  await click(o as Element);
};
const sent = (op: string) => stub.calls.filter((c) => c.op === op).map((c) => c.input);
const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

type Directory = typeof import("../src/ui/pages/directory.tsx");
let page: Directory;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  page = (await import(pathToFileURL(join(outDir, "ui", "pages", "directory.js")).href)) as Directory;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const reset = (dir: Partial<Dir>) => {
  stub.calls = [];
  stub.answers = {};
  stub.dir = { revision: 1, teams: [], people: [], agents: [], ...dir };
};
const AGENTS = Array.from({ length: 40 }, (_, i) => AGENT(`agt_${i}`, i === 0 ? "Henry" : `QA agent ${i}`));

describe("many.ts", () => {
  it("membersAfter changes only what the click changes: a member nobody touched stays, whatever the page showed", () => {
    const list = [
      { kind: "agent" as const, id: "gone", role: "member" as const },
      { kind: "person" as const, id: "per_1", role: "lead" as const },
    ];
    assert.deepEqual(
      membersAfter(list, [
        { agent: "person:per_2", scope: "t", level: "member" },
        { agent: "person:per_1", scope: "t", level: null },
        { agent: "agent:agt_1", scope: "t", level: "lead" },
      ]),
      {
        people: [{ id: "per_2", role: "member" }],
        agents: [
          { id: "gone", role: "member" },
          { id: "agt_1", role: "lead" },
        ],
      },
    );
  });
  it("memberPreview: leads first, a few names, how many more", () => {
    const members = Array.from({ length: 40 }, (_, i) => ({ id: String(i), role: i === 39 ? ("lead" as const) : ("member" as const) }));
    const p = memberPreview(members);
    assert.equal(p.tags[0]?.id, "39");
    assert.equal(p.tags.length, 6);
    assert.equal(p.more, 34);
    assert.equal(p.line, "40 members, 1 lead");
    assert.equal(memberPreview([{ role: "member" as const }]).line, "1 member");
  });
  it("giveProblem: a reason is needed; the dates are checked before anything is sent", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    assert.equal(giveProblem({ reason: "", from: "", until: "" }, now), "Choose why.");
    assert.equal(giveProblem({ reason: "other", from: "", until: "" }, now), null);
    assert.equal(giveProblem({ reason: "other", from: "x", until: "" }, now), "Check the start date.");
    assert.equal(giveProblem({ reason: "other", from: "", until: "x" }, now), "Check the end date.");
    assert.match(giveProblem({ reason: "other", from: "", until: "2001-01-01T00:00" }, now) ?? "", /has passed/);
    assert.match(giveProblem({ reason: "other", from: "2099-01-02T00:00", until: "2099-01-01T00:00" }, now) ?? "", /before the end date/);
  });
});

describe("Teams", () => {
  it("a card with 40 members stays readable: how many, six names, how many more", async () => {
    reset({ agents: AGENTS, teams: [TEAM({ members: AGENTS.map((a) => ({ kind: "agent", id: a.id, name: a.name, role: "member", handles: [] })) })] });
    const m = await mount(h(page.DirectoryPage, { page: "teams" }));
    assert.match(m.host.textContent ?? "", /40 members/);
    assert.match(m.host.textContent ?? "", /and 34 more/);
    assert.ok(m.host.querySelectorAll(".tb-card .tb-tag, .tb-card [class*=tag]").length <= 8);
    await m.unmount();
  });
  it("Members: 'Not in team' once and no dropdown per row; a one-line add is one call on the list read just before it, and it is logged", async () => {
    const kept = { kind: "agent", id: "agt_gone", name: "Left Portal", role: "member", handles: [] };
    reset({
      people: [PERSON("per_1", "Marco")],
      agents: [...AGENTS, AGENT("agt_gone", "Left Portal", { status: "removed" })],
      teams: [TEAM({ members: [kept] })],
    });
    const m = await mount(h(page.DirectoryPage, { page: "teams" }));
    await click(button(m.host, "Members of Support"));
    const text = m.host.textContent ?? "";
    assert.equal([...m.host.querySelectorAll(".tb-access-level")].filter((x) => x.textContent === "Not in team").length, 1, "the default shows once");
    assert.match(text, /42 people and agents\. 1 is in this team\./);
    assert.match(text, /Left Portal/, "a member that left Portal is shown");
    assert.ok(m.host.querySelectorAll('[role="combobox"]').length <= 2);

    // someone else adds a member after this page loaded: the write must not drop them
    const other = { kind: "person", id: "per_1", name: "Marco", role: "lead", handles: [] };
    stub.dir.teams = [TEAM({ members: [kept, other] })];
    stub.answers.members_set = (input) => {
      stub.dir.teams = [TEAM({ members: [kept, other, ...input.agents.filter((a: { id: string }) => a.id === "agt_0").map(() => ({ kind: "agent", id: "agt_0", name: "Henry", role: "member", handles: [] }))] })];
      return undefined;
    };
    await click(button(m.host, "Add or change many"));
    await pickName(m.host, "Henry");
    stub.calls = [];
    await click(button(m.host, "Member"));
    assert.deepEqual(sent("members_set"), [
      {
        team: "tea_1",
        people: [{ id: "per_1", role: "lead" }],
        agents: [
          { id: "agt_gone", role: "member" },
          { id: "agt_0", role: "member" },
        ],
      },
    ]);
    assert.equal(stub.calls[0]?.op, "overview_get", "read first");
    assert.match(m.host.textContent ?? "", /Henry: Member\. 1 set\./);
    await click(button(m.host, "Back to the list"));
    assert.match(m.host.textContent ?? "", /Changes this session \(1\)/);
    await m.unmount();
  });
  it("Members: above 25 changes it asks once, and it is still one call", async () => {
    reset({ agents: AGENTS, teams: [TEAM()] });
    stub.answers.members_set = (input) => {
      stub.dir.teams = [TEAM({ members: input.agents.map((a: { id: string; role: string }) => ({ kind: "agent", id: a.id, name: a.id, role: a.role, handles: [] })) })];
      return undefined;
    };
    const m = await mount(h(page.DirectoryPage, { page: "teams" }));
    await click(button(m.host, "Members of Support"));
    await click(button(m.host, "Add or change many"));
    await click(button(m.host, "Select all shown"));
    await click(button(m.host, "Member"));
    assert.equal(sent("members_set").length, 0, "nothing before the answer");
    assert.match(m.host.textContent ?? "", /This sets 40 people and agents to Member\./);
    await click(button(m.host, "Yes, change them"));
    assert.equal(sent("members_set").length, 1);
    assert.equal(sent("members_set")[0].agents.length, 40);
    assert.match(m.host.textContent ?? "", /40 set/);
    await m.unmount();
  });
  it("Members: a refusal fails each row of the click, and a write the read-back does not show is no success", async () => {
    reset({ people: [PERSON("per_1", "Marco")], teams: [TEAM()] });
    stub.answers.members_set = () => refuse(404, "person_not_found", "no person per_1");
    const m = await mount(h(page.DirectoryPage, { page: "teams" }));
    await click(button(m.host, "Members of Support"));
    await click(button(m.host, "Add or change many"));
    await pickName(m.host, "Marco");
    await click(button(m.host, "Lead"));
    assert.match(m.host.textContent ?? "", /Failed: Marco\. This entry is gone/);
    delete stub.answers.members_set; // accepted, but the list does not change
    await click(button(m.host, "Lead"));
    assert.match(m.host.textContent ?? "", /Failed: Marco\. The app reports another level/);
    assert.doesNotMatch(m.host.textContent ?? "", /Done\./);
    await m.unmount();
  });
});

describe("Agents: the owner of many", () => {
  it("sends the owner and nothing else, per agent; a refused row says why and stops no other; removed agents and outside agents are not offered", async () => {
    reset({
      people: [PERSON("per_1", "Marco"), PERSON("per_2", "Outside", { kind: "outside_agent" }), PERSON("per_3", "Left", { status: "departed" })],
      agents: [AGENT("agt_1", "Henry"), AGENT("agt_2", "Tempo", { owner: { id: "per_3", name: "Left" } }), AGENT("agt_3", "Old", { status: "removed" })],
    });
    stub.answers.agent_set = (input) => {
      if (input.agent === "agt_2") return refuse(409, "use_transfer", "The owner is stopped, and may hold this agent's key.");
      const a = (stub.dir.agents as { id: string; owner: unknown }[]).find((x) => x.id === input.agent);
      if (a) a.owner = input.owner ? { id: input.owner, name: "Marco" } : null;
      return undefined;
    };
    const m = await mount(h(page.DirectoryPage, { page: "agents" }));
    await click(button(m.host, "Change the owner of many"));
    assert.equal([...m.host.querySelectorAll('[role="option"]')].some((o) => o.textContent?.includes("Old")), false);
    assert.equal([...m.host.querySelectorAll("button")].some((b) => ["Outside", "Left"].includes(b.textContent?.trim() ?? "")), false, "an owner is an active person");
    await pickName(m.host, "Henry");
    await pickName(m.host, "Tempo");
    assert.match(m.host.textContent ?? "", /Owner Left/);
    await click(button(m.host, "Marco"));
    assert.deepEqual(sent("agent_set"), [
      { agent: "agt_1", owner: "per_1" },
      { agent: "agt_2", owner: "per_1" },
    ]);
    const text = m.host.textContent ?? "";
    assert.match(text, /Failed: Tempo\. The owner is stopped/);
    assert.match(text, /1 set, 1 failed/);
    await m.unmount();
  });
  it("No owner is one value, and an agent already at it is not written", async () => {
    reset({ people: [PERSON("per_1", "Marco")], agents: [AGENT("agt_1", "Henry")] });
    const m = await mount(h(page.DirectoryPage, { page: "agents" }));
    await click(button(m.host, "Change the owner of many"));
    await pickName(m.host, "Henry");
    await click(button(m.host, "No owner"));
    assert.deepEqual(sent("agent_set"), []);
    assert.match(m.host.textContent ?? "", /Nothing to change: already No owner\./);
    await m.unmount();
  });
});
