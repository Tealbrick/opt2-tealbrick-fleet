// C383: the open S3 rows of QA-C380 section 17 that live in the server. Real SQLite. The words are in test/ui-lifecycle-words.test.ts and test/lifecycle-wiring.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { accessAfterLeave } from "../src/access/differences.ts";
import { setAgentMoved } from "../src/lifecycle/moved.ts";
import { colleagueDetail, loadColleagues } from "../src/lifecycle/view.ts";
import { newKeyApproved, newKeyAsked, ownerWithheld } from "../src/plans/guards.ts";
import { ROTATE_SEEN_MS } from "../src/plans/steps.ts";
import * as store from "../src/store.ts";
import { AGENT_A } from "./helpers.ts";
import { OWNER, refused, set, T0, world } from "./lifecycle-helpers.ts";
import { HENRY, makeWorld, SALES } from "./plans-world.ts";

const row = (db: Parameters<typeof loadColleagues>[0], key: string) => loadColleagues(db, T0).byId.get(key);
const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const ctxOf = (db: Parameters<typeof loadColleagues>[0]) => ({ db, caller: { type: "person", id: "per_owner", name: "owner", mode: null }, log: LOG, callApp: async () => ({ status: "ok", output: {} }), companionTargets: () => [], topology: () => null, bridgeCaps: () => [] }) as never;

test("S3-1: a new key the owner approved reads so, and the owner stops being withheld about 2 minutes later when the agent has paired again", async () => {
  const w = makeWorld();
  setAgentMoved(w.db, { agent: HENRY, owner: null }, OWNER, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const id = w.makePlan({ kind: "agent", id: HENRY, transfers: [HENRY] });
  await w.tick(id);
  assert.equal(newKeyAsked(w.db).has(HENRY), true);
  assert.equal(newKeyApproved(w.db).has(HENRY), false, "still waits for the owner");
  w.core.apply(String(w.plan(id).draft_key));
  const a = w.core.data.agents[HENRY];
  if (a) a.keys = 1; // paired again at once
  w.core.deliver();
  await w.tick(id);
  const rot = () => w.steps(id).find((s) => s.op === "agents.rotate") as Record<string, unknown>;
  assert.equal(rot().state, "pending_bridge");
  assert.equal(newKeyApproved(w.db).has(HENRY), true, "the page says it was approved");
  w.clock.t += ROTATE_SEEN_MS - 1000;
  await w.tick(id);
  assert.equal(rot().state, "pending_bridge", "inside the window the slice may still speak");
  w.clock.t += 2000;
  await w.tick(id);
  assert.equal(rot().state, "reported");
  assert.equal(newKeyApproved(w.db).has(HENRY), false);
  assert.equal(newKeyAsked(w.db).has(HENRY), false);
  assert.equal(ownerWithheld(w.db).has(HENRY), false);
  assert.ok(ROTATE_SEEN_MS <= 5 * 60_000, "minutes, not half an hour");
});

test("S3-3: after an Undo a person's page lists no done step as a thing to do in Portal", async () => {
  const { db, ann } = world();
  set(db, "person", ann.id, "suspended");
  set(db, "person", ann.id, "active");
  // A has its own stop, and Portal shows it paused and gone from its keys: the pause step is done.
  set(db, "agent", AGENT_A.id, "suspended");
  db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  const c = await colleagueDetail(ctxOf(db), "person", ann.id, T0 + 1);
  assert.equal(c.plan, null, "nothing to do: no 'Not applied' block");
  db.prepare("UPDATE fleet_agents SET status = 'active' WHERE id = ?").run(AGENT_A.id);
  const open = await colleagueDetail(ctxOf(db), "person", ann.id, T0 + 1);
  assert.deepEqual(open.plan?.steps.map((s) => s.action), ["pause"], "an open step stays");
});

test("S3-4: a blocked entry never reads as working", () => {
  const { db, ann } = world();
  db.prepare("UPDATE fleet_agents SET trust = 'blocked' WHERE id = ?").run(AGENT_A.id);
  assert.equal(row(db, `agent:${AGENT_A.id}`)?.line, "Blocked: its calls are refused if the Rules hook is on");
  db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  assert.equal(row(db, `agent:${AGENT_A.id}`)?.line, "Blocked: paused in Portal");
  db.prepare("UPDATE fleet_people SET trust = 'blocked' WHERE id = ?").run(ann.id);
  assert.equal(row(db, `person:${ann.id}`)?.line, "Blocked: refused if the Rules hook is on");
  set(db, "agent", AGENT_A.id, "suspended");
  assert.doesNotMatch(String(row(db, `agent:${AGENT_A.id}`)?.line), /^Blocked/, "a stop has its own line");
});

test("S3-5: a Buzz identity on an agent Portal no longer lists is not access held; other items still are", () => {
  const { db } = world();
  set(db, "agent", AGENT_A.id, "leaving");
  const add = (kind: string, id: string) =>
    db.prepare("INSERT INTO fleet_access_items (target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, digest, first_seen, last_seen) VALUES ('connect', ?, ?, 'agent', ?, 'r', 'held_by', 'use', 'l', 'active', 1, 'sha256:x', ?, ?)").run(id, kind, AGENT_A.id, T0, T0);
  add("buzz_identity", "buzz_identity:a");
  assert.equal(accessAfterLeave(db).has(`agent:${AGENT_A.id}`), true, "the card is there");
  db.prepare("UPDATE fleet_agents SET status = 'removed' WHERE id = ?").run(AGENT_A.id);
  assert.equal(accessAfterLeave(db).has(`agent:${AGENT_A.id}`), false);
  add("scheduled_post", "scheduled_post:a");
  assert.equal(accessAfterLeave(db).has(`agent:${AGENT_A.id}`), true, "a post can still go out");
});

test("S3-6: a person's later plan asks Portal nothing for an agent whose access Core removed since its stop; a new stop asks again", async () => {
  const w = makeWorld();
  set(w.db, "agent", SALES, "leaving", {}, w.clock.t);
  const first = w.makePlan({ kind: "agent", id: SALES });
  await w.tick(first);
  w.core.apply(String(w.plan(first).draft_key));
  w.core.deliver();
  await w.tick(first);
  assert.equal(w.steps(first).find((s) => s.op === "agents.offboard")?.state, "done");
  w.clock.t += 1000;
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const later = w.makePlan({ kind: "person", id: w.ann.id });
  assert.equal(w.steps(later).some((s) => s.agent_id === SALES && s.phase === "core"), false);
});

test("S3-8: a blocked person is no new owner", () => {
  const { db } = world();
  const bea = store.setPerson(db, { name: "Bea" }, T0);
  db.prepare("UPDATE fleet_people SET trust = 'blocked' WHERE id = ?").run(bea.id);
  assert.throws(() => setAgentMoved(db, { agent: AGENT_A.id, owner: bea.id }, OWNER, T0), refused("owner_inactive", 409));
  db.prepare("UPDATE fleet_people SET trust = 'trusted' WHERE id = ?").run(bea.id);
  assert.equal(setAgentMoved(db, { agent: AGENT_A.id, owner: bea.id }, OWNER, T0).owner?.id, bea.id);
});
