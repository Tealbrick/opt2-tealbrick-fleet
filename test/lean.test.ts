// Governance 0.2.1 (FLT-01 / APP-06 / C88): the agent views are lean. Quiet on good (names, titles, trust, teams, owner),
// fire on bad (the old full views fail the new schemas; the PII scan can fail).
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../src/app.ts";
import { leanDirectory } from "../src/lean.ts";
import * as store from "../src/store.ts";
import { bigDirectory } from "./big.ts";
import { leaks } from "./feed-contract.ts";
import { AGENT_A, migratedDb, NOSTR } from "./helpers.ts";
import { SECRETS, seed } from "./seed.ts";

const AGENT = { type: "agent", id: AGENT_A.id, name: AGENT_A.name, mode: "free" };
const ctx = (db: ReturnType<typeof migratedDb>, caller: object = AGENT) => ({ db, caller, log: { debug() {}, info() {}, warn() {}, error() {} } }) as unknown as OpContext;
const outputSchema = (id: string) => (manifest.operations.find((o) => o.id === id) as unknown as { output: Parameters<typeof validateAgainstSchema>[0] }).output;
const valid = (id: string, out: unknown) => validateAgainstSchema(outputSchema(id), out as Json).ok;
type Run = { run(i: unknown, c: OpContext): Promise<unknown> };
const run = (id: string, input: unknown, c: OpContext) => (handlers as unknown as Record<string, Run>)[id]?.run(input, c) as Promise<Record<string, any>>;

// What no agent output may carry: contact data and everything the owner keeps for herself.
const FORBIDDEN_TEXT = ["@", "npub1", "buzz:", "slack:", "telegram:", "U012ABCDEF", "UCY00001", "W0BOT123", "123456", "-1001234567890", NOSTR.npub, NOSTR.hex];
const FORBIDDEN_KEYS = ["email", "handles", "handle", "tags", "mode", "identity", "identities", "reason"];

function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  return out;
}

test("PII scan: no agent operation output carries an email, a handle, a tag, a mode or an identity (seeded data)", async () => {
  const db = migratedDb();
  const s = seed(db);
  const outputs: Record<string, unknown> = {
    teams_list: await run("teams_list", {}, ctx(db)),
    teams_list_tag: await run("teams_list", { tag: "secret-tag" }, ctx(db)),
    team_get: await run("team_get", { team: s.support.id }, ctx(db)),
    team_get_name: await run("team_get", { team: "ops" }, ctx(db)),
    directory_get: await run("directory_get", {}, ctx(db)),
    resolve_person: await run("resolve_sender", { handle: `buzz:${NOSTR.npub}` }, ctx(db)),
    resolve_outside: await run("resolve_sender", { handle: "slack:W0BOT123" }, ctx(db)),
    review_request: await run("review_request", { subject: { kind: "person", id: s.cy.id }, why: "Looks odd" }, ctx(db)),
  };
  // the fixture is meaningful: it has data to leak
  assert.equal((outputs.teams_list_tag as { teams: unknown[] }).teams.length, 1, "the tag filter still works");
  assert.ok((outputs.directory_get as { people: unknown[] }).people.length >= 4);
  for (const [name, out] of Object.entries(outputs)) {
    const text = JSON.stringify(out);
    for (const bad of FORBIDDEN_TEXT) assert.ok(!text.includes(bad), `${name} contains ${bad}`);
    // names, a title, an agent role and a team description are allowed for agents (DESIGN §3.1); email and tags are not
    assert.deepEqual(leaks(out, SECRETS.filter((x) => !["Support", "Agent A", "Ann Example", "Chief Secret Officer", "internal-only description", "triage-role"].includes(x))), [], `${name} leaks`);
    for (const k of keysOf(out)) assert.ok(!FORBIDDEN_KEYS.includes(k), `${name} has a "${k}" member`);
    const op = name.startsWith("resolve") ? "resolve_sender" : name.replace(/_(tag|name)$/, "");
    assert.equal(valid(op, out), true, `${name} is valid against the manifest output schema`);
  }
  // what stays: names, titles, trust, teams and the owner
  const dir = outputs.directory_get as { people: any[]; agents: any[]; teams: any[] };
  const ann = dir.people.find((p) => p.name === "Ann Example");
  assert.deepEqual(ann && { name: ann.name, title: ann.title, trust: ann.trust, kind: ann.kind }, { name: "Ann Example", title: "Chief Secret Officer", trust: "trusted", kind: "person" });
  assert.deepEqual(dir.agents.find((a) => a.id === AGENT_A.id)?.owner, { id: s.ann.id, name: "Ann Example" });
  assert.deepEqual(dir.teams.find((t) => t.id === s.support.id)?.members.map((m: any) => [m.kind, m.name, m.role]), [
    ["outside_agent", "Outside Bot", "member"],
    ["person", "Ann Example", "lead"],
    ["agent", "Agent A", "member"],
  ].sort((a, b) => (a[0] === "agent" ? 1 : 0) - (b[0] === "agent" ? 1 : 0) || String(a[1]).localeCompare(String(b[1]))));

  // fire on bad: the scan finds a planted email / handle / tag key, and the old full views fail the new schemas
  assert.ok(JSON.stringify({ ...dir, people: [{ ...dir.people[0], email: "ann@example.com" }] }).includes("@"));
  assert.ok(keysOf({ people: [{ tags: [] }] }).has("tags"));
  const full = store.directory(db);
  assert.equal(valid("directory_get", { ...full, unchanged: false }), false, "the 0.2.0 directory_get shape is refused now");
  assert.equal(valid("teams_list", store.listTeams(db, {})), false, "the 0.2.0 teams_list shape is refused now");
  assert.equal(valid("team_get", { team: store.getTeam(db, s.support.id) }), false, "the 0.2.0 team_get shape is refused now");
});

test("lean views: unchanged answer, unknown team (exact code), paging, caps", async () => {
  const db = migratedDb();
  seed(db);
  const rev = store.revision(db);
  assert.deepEqual(await run("directory_get", { sinceRevision: rev }, ctx(db)), { revision: rev, unchanged: true, teams: [], people: [], agents: [] });
  assert.equal((await run("directory_get", { sinceRevision: rev - 1 }, ctx(db))).unchanged, false);
  try {
    await run("team_get", { team: "no such team" }, ctx(db));
    assert.fail("must refuse");
  } catch (e) {
    assert.equal((e as { code: string }).code, "team_not_found");
    assert.equal((e as { httpStatus: number }).httpStatus, 404);
  }
  for (let i = 0; i < 4; i++) store.setTeam(db, { name: `Extra ${i}` });
  const p1 = await run("teams_list", { limit: 3 }, ctx(db));
  assert.equal(p1.teams.length, 3);
  assert.ok(p1.nextCursor);
  const p2 = await run("teams_list", { limit: 3, cursor: p1.nextCursor }, ctx(db));
  assert.equal(p2.teams.length, 3);
  assert.equal(new Set([...p1.teams, ...p2.teams].map((t: any) => t.id)).size, 6, "no team twice");
  // a person in 51 teams: directory_get lists the first 50 (valid against the manifest)
  const busy = store.setPerson(db, { name: "Busy" });
  for (let i = 0; i < 51; i++) store.setMembers(db, { team: store.setTeam(db, { name: `Z${String(i).padStart(2, "0")}` }).id, people: [{ id: busy.id, role: "member" }], agents: [] });
  const dir = await run("directory_get", {}, ctx(db));
  assert.equal(dir.people.find((p: any) => p.id === busy.id).teams.length, 50);
  assert.equal(valid("directory_get", dir), true);
});

test("lean directory_get at the maximum size (500 teams, 2000 people, 500 agents) is valid and under 200 ms", () => {
  const { db } = bigDirectory();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    leanDirectory(db);
    best = Math.min(best, performance.now() - t);
  }
  assert.ok(best < 200, `lean directory took ${best.toFixed(1)} ms (budget 200 ms)`);
  const dir = leanDirectory(db);
  assert.equal(dir.people.length, 2000);
  assert.equal(valid("directory_get", dir), true);
  assert.deepEqual(leaks(dir), [], "no email in 2000 people");
  assert.ok(!JSON.stringify(dir).includes("slack:"));
});

test("owner view (overview_get) shows kind and trust; person_set and agent_set answers carry them", async () => {
  const db = migratedDb();
  const s = seed(db);
  const owner = ctx(db, { type: "person", id: "per_01J0000000000000000000000P", name: "o", mode: null });
  const ov = await run("overview_get", {}, owner);
  assert.equal(valid("overview_get", ov), true);
  assert.equal(ov.people.find((p: any) => p.id === s.bot.id).kind, "outside_agent");
  assert.equal(ov.people.find((p: any) => p.id === s.cy.id).trust, "unreviewed");
  assert.equal(ov.agents.find((a: any) => a.id === AGENT_A.id).trust, "trusted");
  const set = await run("person_set", { id: s.ann.id, name: "Ann Example" }, owner);
  assert.equal(valid("person_set", set), true);
  assert.equal(set.person.trust, "trusted");
  const ag = await run("agent_set", { agent: AGENT_A.id, role: "x" }, owner);
  assert.equal(valid("agent_set", ag), true);
  assert.equal(ag.agent.trust, "trusted");
  // the owner's person_set cannot set trust: the input schema has no such member
  const inputProps = (manifest.operations.find((o) => o.id === "person_set") as unknown as { input: { properties: object } }).input.properties;
  assert.ok(!("trust" in inputProps) && !("kind" in inputProps));
});
