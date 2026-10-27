// QA fleet 0.3.0 S3 fixes (C373): an unchanged legacy owner never blocks a role edit; a person who owns agents cannot
// become an outside agent; draft text is clipped by code point; variation selectors and tag characters are removed.
// Each fix has a fire-on-bad and a quiet-on-good case.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import * as p from "../src/proposals.ts";
import * as store from "../src/store.ts";
import { cleanText } from "../src/text.ts";
import { AGENT_A, migratedDb } from "./helpers.ts";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof TbError ? e.code : `not TbError: ${String(e)}`;
  }
  return "no error";
};

test("agent_set: an unchanged legacy owner (outside agent) does not block a role edit; a new non-person owner is refused", () => {
  const db = migratedDb();
  store.syncAgents(db, [AGENT_A]);
  const outside = store.setPerson(db, { name: "Bot X", kind: "outside_agent" });
  // a row from before 0.3.0: the owner is an outside agent
  db.prepare("UPDATE fleet_agents SET owner_id = ? WHERE id = ?").run(outside.id, AGENT_A.id);
  assert.equal(code(() => store.setAgent(db, { agent: AGENT_A.id, owner: outside.id, role: "ops" })), "no error");
  const other = store.setPerson(db, { name: "Bot Y", kind: "outside_agent" });
  assert.equal(code(() => store.setAgent(db, { agent: AGENT_A.id, owner: other.id })), "owner_not_person");
  const ann = store.setPerson(db, { name: "Ann" });
  assert.equal(code(() => store.setAgent(db, { agent: AGENT_A.id, owner: ann.id })), "no error");
});

test("person_set: a person who owns an agent cannot become an outside agent; one who owns none can", () => {
  const db = migratedDb();
  store.syncAgents(db, [AGENT_A]);
  const ann = store.setPerson(db, { name: "Ann" });
  store.setAgent(db, { agent: AGENT_A.id, owner: ann.id });
  assert.equal(code(() => store.setPerson(db, { id: ann.id, name: "Ann", kind: "outside_agent" })), "person_owns_agents");
  assert.equal(code(() => store.setPerson(db, { id: ann.id, name: "Ann B" })), "no error", "a rename without kind stays allowed");
  const bob = store.setPerson(db, { name: "Bob" });
  assert.equal(code(() => store.setPerson(db, { id: bob.id, name: "Bob", kind: "outside_agent" })), "no error");
});

test("draft text is clipped by code point: no lone surrogate", () => {
  const name = "\u{1F600}".repeat(100);
  const payload = p.buildPayload("hold_outward_for_agent", { agent: AGENT_A.id, name });
  for (const s of [payload.text, ...payload.rules.map((r) => r.title)]) assert.equal(s.isWellFormed(), true, s.slice(-8));
  const short = p.buildPayload("hold_outward_for_agent", { agent: AGENT_A.id, name: "Agent A" });
  assert.match(short.text, /Agent A/);
});

test("cleanText removes tag characters and supplementary variation selectors, keeps emoji presentation (VS16)", () => {
  assert.equal(cleanText("A\u{E0100}B"), "AB");
  assert.equal(cleanText("ok \u{1F44D}\u{FE0F}"), "ok \u{1F44D}\u{FE0F}");
  assert.equal(cleanText("A\u{E0041}B"), "AB");
  assert.equal(cleanText("Ann Novak"), "Ann Novak");
});

test("owner-typed names, titles, roles, org, relationship and tags are cleaned (QA-C373-GV-1, X-10)", () => {
  const db = migratedDb();
  store.syncAgents(db, [AGENT_A]);
  const bad = (s: string) => `Ann\u{202E}exe.png\u{2066} B\u{200B}x\u{0001}${s}`;
  const team = store.setTeam(db, { name: bad("team"), description: bad("d"), tags: [bad("t"), "\u{202E}"] });
  assert.equal(team.name, "Annexe.png Bxteam");
  const person = store.setPerson(db, { name: bad("p"), title: bad("title"), kind: "outside_agent", org: bad("o"), relationship: bad("r") });
  for (const v of [person.name, person.title]) assert.doesNotMatch(v, /[\p{Cc}\p{Cf}]/u);
  const row = db.prepare("SELECT name, title, org, relationship FROM fleet_people WHERE id = ?").get(person.id) as Record<string, string>;
  for (const v of Object.values(row)) assert.doesNotMatch(String(v), /[\p{Cc}\p{Cf}]/u);
  const agent = store.setAgent(db, { agent: AGENT_A.id, role: bad("ops") });
  assert.equal(agent.role, "Annexe.png Bxops");
  const tagRow = db.prepare("SELECT tags FROM fleet_teams WHERE id = ?").get(team.id) as { tags: string };
  assert.deepEqual(JSON.parse(tagRow.tags), ["Annexe.png Bxt"], "a tag that is only invisible characters is dropped");
  // a name that is ONLY invisible characters is empty after cleaning → refused
  assert.equal(code(() => store.setTeam(db, { name: "\u{202E}\u{200D}" })), "input_invalid");
  // ordinary text and emoji stay
  assert.equal(store.setTeam(db, { name: "Support \u{1F44D}\u{FE0F}" }).name, "Support \u{1F44D}\u{FE0F}");
});
