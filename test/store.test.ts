// Directory logic against the migrated table: handles, teams, people, members, agents in sync with the slice, and
// the context-hook facts (tb.onBehalfOf requester, agent owner and teams).
import assert from "node:assert/strict";
import { test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { factsFor } from "../src/facts.ts";
import { isNpub, normalizeHandle, npubFromHex } from "../src/handles.ts";
import * as store from "../src/store.ts";
import { AGENT_A, AGENT_B, migratedDb, NOSTR } from "./helpers.ts";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof TbError ? e.code : `not TbError: ${String(e)}`;
  }
  return "no error";
};

test("handles: shared channel_sender split, Buzz npub checksum, hex → npub, Slack and Telegram ids", () => {
  assert.equal(npubFromHex(NOSTR.hex), NOSTR.npub);
  assert.equal(isNpub(NOSTR.npub), true);
  assert.equal(isNpub(`${NOSTR.npub.slice(0, -1)}q`), false, "bad checksum");
  assert.equal(normalizeHandle(`buzz:${NOSTR.npub}`), `buzz:${NOSTR.npub}`);
  assert.equal(normalizeHandle(NOSTR.npub), `buzz:${NOSTR.npub}`, "bare npub = buzz");
  assert.equal(normalizeHandle(`buzz:${NOSTR.npub.toUpperCase()}`), `buzz:${NOSTR.npub}`);
  assert.equal(normalizeHandle(`buzz:${NOSTR.hex}`), `buzz:${NOSTR.npub}`);
  assert.equal(normalizeHandle("slack:u01abcd2ef"), "slack:U01ABCD2EF");
  assert.equal(normalizeHandle("telegram:123456789"), "telegram:123456789");
  assert.equal(normalizeHandle("telegram:-1001234"), "telegram:-1001234");
  for (const bad of ["", "buzz:npub1xyz", "slack:not an id", "telegram:12a", "email:a@b.c", "U01ABCD2EF", NOSTR.hex, "BUZZ:x"]) assert.equal(normalizeHandle(bad), null, bad);
});

test("teams: create, rename, unique names, tag filter, cursor paging, delete", () => {
  const db = migratedDb();
  const r0 = store.revision(db);
  const sup = store.setTeam(db, { name: "Support", tags: ["eu", "support", "eu"] }, 1000);
  assert.match(sup.id, /^tm_/);
  assert.deepEqual(sup.tags, ["eu", "support"]);
  assert.ok(store.revision(db) > r0, "a change moves the revision");
  assert.equal(code(() => store.setTeam(db, { name: "support" })), "team_name_taken");
  const ops = store.setTeam(db, { name: "Ops" }, 2000);
  store.setTeam(db, { name: "Sales", tags: ["eu"] }, 3000);
  assert.equal(store.setTeam(db, { id: ops.id, name: "Operations" }).name, "Operations");
  assert.deepEqual(
    store.listTeams(db, { tag: "eu" }).teams.map((t) => t.name),
    ["Support", "Sales"],
  );
  const p1 = store.listTeams(db, { limit: 2 });
  assert.equal(p1.teams.length, 2);
  assert.ok(p1.nextCursor);
  const p2 = store.listTeams(db, { limit: 2, cursor: p1.nextCursor ?? "" });
  assert.deepEqual(
    p2.teams.map((t) => t.name),
    ["Sales"],
  );
  assert.equal(p2.nextCursor, null);
  assert.equal(store.getTeam(db, "operations").id, ops.id, "by exact name, case-insensitive");
  assert.equal(code(() => store.getTeam(db, "nope")), "team_not_found");
  assert.equal(store.deleteTeam(db, ops.id), true);
  assert.equal(store.deleteTeam(db, ops.id), false);
});

test("people: handles are unique per person, normalized, replaced as a set; invalid handle refused with no write", () => {
  const db = migratedDb();
  const ann = store.setPerson(db, { name: "Ann", handles: [NOSTR.npub, "slack:u01abcd2ef"] });
  assert.match(ann.id, /^psn_/);
  assert.deepEqual(ann.handles, [`buzz:${NOSTR.npub}`, "slack:U01ABCD2EF"]);
  assert.equal(code(() => store.setPerson(db, { name: "Bob", handles: [`buzz:${NOSTR.hex}`] })), "handle_taken");
  assert.equal(store.directory(db).people.length, 1, "the refused create left no row");
  assert.equal(code(() => store.setPerson(db, { name: "Bob", handles: ["slack:bad id"] })), "handle_invalid");
  const ann2 = store.setPerson(db, { id: ann.id, name: "Ann", handles: ["telegram:42"] });
  assert.deepEqual(ann2.handles, ["telegram:42"]);
  assert.equal(store.resolveSender(db, NOSTR.npub).found, false, "the old handle is free again");
});

test("members, agent owner and resolve_sender for a Buzz npub (J3 sender → person → teams)", () => {
  const db = migratedDb();
  store.syncAgents(db, [AGENT_A]);
  const ann = store.setPerson(db, { name: "Ann", handles: [`buzz:${NOSTR.npub}`] });
  const sup = store.setTeam(db, { name: "Support" });
  const team = store.setMembers(db, { team: sup.id, people: [{ id: ann.id, role: "lead" }], agents: [{ id: AGENT_A.id, role: "member" }] });
  assert.deepEqual(
    team.members.map((m) => [m.kind, m.name, m.role, m.handles]),
    [
      ["person", "Ann", "lead", [`buzz:${NOSTR.npub}`]],
      ["agent", "Agent A", "member", undefined],
    ],
  );
  assert.equal(code(() => store.setMembers(db, { team: sup.id, people: [{ id: "psn_x", role: "member" }], agents: [] })), "person_not_found");
  assert.equal(store.getTeam(db, sup.id).members.length, 2, "a refused members_set changes nothing");

  const r = store.resolveSender(db, `buzz:${NOSTR.hex}`);
  assert.deepEqual(r, { found: true, person: { id: ann.id, name: "Ann", status: "active" }, teams: [{ id: sup.id, name: "Support", role: "lead" }] });
  assert.deepEqual(store.resolveSender(db, "slack:U999"), { found: false, person: null, teams: [] });
  assert.deepEqual(store.resolveSender(db, "garbage"), { found: false, person: null, teams: [] });

  const a = store.setAgent(db, { agent: AGENT_A.id, owner: ann.id, role: "triage" });
  assert.deepEqual(a.owner, { id: ann.id, name: "Ann" });
  assert.equal(code(() => store.setAgent(db, { agent: AGENT_A.id, owner: "psn_missing" })), "person_not_found");

  // departed: still found, no team facts (narrow, never widen)
  store.setPerson(db, { id: ann.id, name: "Ann", status: "departed" });
  assert.deepEqual(store.resolveSender(db, NOSTR.npub).teams, []);
  // deleting the person clears ownership and memberships
  assert.equal(store.deletePerson(db, ann.id), true);
  assert.equal(store.getAgent(db, AGENT_A.id).owner, null);
  assert.equal(store.getTeam(db, sup.id).people, 0);
  assert.equal(store.resolveSender(db, NOSTR.npub).found, false);
});

test("agents stay in sync with the slice (agentsChanged): add, remove (kept), re-add, rename, pause; no-op keeps the revision", () => {
  const db = migratedDb();
  store.syncAgents(db, [AGENT_A, AGENT_B]);
  const sup = store.setTeam(db, { name: "Support" });
  store.setMembers(db, { team: sup.id, people: [], agents: [{ id: AGENT_B.id, role: "member" }] });
  const rev = store.revision(db);
  store.syncAgents(db, [AGENT_A, AGENT_B]);
  assert.equal(store.revision(db), rev, "the same list changes nothing");

  store.syncAgents(db, [AGENT_A]);
  assert.equal(store.getAgent(db, AGENT_B.id).status, "removed");
  assert.ok(store.revision(db) > rev);
  assert.deepEqual(store.agentFacts(db, AGENT_B.id), { owner: null, teams: [] }, "a removed agent gives no facts");

  store.syncAgents(db, [AGENT_A, AGENT_B]);
  assert.equal(store.getAgent(db, AGENT_B.id).status, "active", "re-add");
  assert.deepEqual(
    store.agentFacts(db, AGENT_B.id).teams.map((t) => t.name),
    ["Support"],
    "owner/teams survive the round trip",
  );
  store.syncAgents(db, [{ ...AGENT_A, name: "Agent A2", status: "paused" }, AGENT_B]);
  assert.deepEqual(
    store.directory(db).agents.map((a) => [a.name, a.status]),
    [
      ["Agent A2", "paused"],
      ["Agent B", "active"],
    ],
  );
});

test("fleet_facts: agent owner/teams, requester from tb.onBehalfOf (channel_sender, person, agent), unknown → null", () => {
  const db = migratedDb();
  store.syncAgents(db, [AGENT_A, AGENT_B]);
  const ann = store.setPerson(db, { name: "Ann", handles: [NOSTR.npub] });
  const sup = store.setTeam(db, { name: "Support" });
  const ops = store.setTeam(db, { name: "Ops" });
  store.setMembers(db, { team: sup.id, people: [{ id: ann.id, role: "member" }], agents: [{ id: AGENT_A.id, role: "lead" }] });
  store.setMembers(db, { team: ops.id, people: [], agents: [{ id: AGENT_B.id, role: "member" }] });
  store.setAgent(db, { agent: AGENT_A.id, owner: ann.id });

  const call = (caller: { type: "agent" | "app"; id: string }, context: Record<string, unknown> = {}) =>
    factsFor(db, { call: { caller } as never, context: context as never });
  const obo = (kind: string, id: string, verified = false) => ({ "tb.onBehalfOf": { claim: { kind, id }, verified, via: "mcp_meta" } });

  const plain = call({ type: "agent", id: AGENT_A.id });
  assert.deepEqual(plain, {
    "fleet.requester": null,
    "fleet.requesterTeams": [],
    "fleet.agentOwner": { id: ann.id, name: "Ann" },
    "fleet.agentTeams": [{ id: sup.id, name: "Support", role: "lead" }],
  });
  const viaBuzz = call({ type: "agent", id: AGENT_B.id }, obo("channel_sender", `buzz:${NOSTR.npub}`));
  assert.deepEqual(viaBuzz["fleet.requester"], { kind: "person", id: ann.id, name: "Ann", verified: false });
  assert.deepEqual(viaBuzz["fleet.requesterTeams"], [{ id: sup.id, name: "Support", role: "member" }]);
  assert.deepEqual(viaBuzz["fleet.agentTeams"], [{ id: ops.id, name: "Ops", role: "member" }]);
  assert.equal(call({ type: "agent", id: AGENT_B.id }, obo("person", ann.id, true))["fleet.requester"]?.verified, true);
  assert.deepEqual(call({ type: "agent", id: AGENT_B.id }, obo("agent", AGENT_A.id))["fleet.requesterTeams"], [{ id: sup.id, name: "Support", role: "lead" }]);
  for (const bad of [obo("channel_sender", "slack:U404"), obo("person", "psn_nope"), obo("robot", "x"), { "tb.onBehalfOf": "nope" }, { "tb.onBehalfOf": { claim: { kind: "person", id: 7 } } }])
    assert.equal(call({ type: "agent", id: AGENT_B.id }, bad)["fleet.requester"], null);
  const app = call({ type: "app", id: "ins_01J0000000000000000000000C" });
  assert.equal(app["fleet.agentOwner"], null);
  assert.deepEqual(app["fleet.agentTeams"], []);
  // every key is namespaced fleet. (the bridge refuses any other prefix)
  for (const k of Object.keys(plain)) assert.ok(k.startsWith("fleet."));
});
