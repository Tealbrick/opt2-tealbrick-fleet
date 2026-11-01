// The plan ops and the lifecycle's use of them, over the same world as the runner tests. Rows: A7, A10, A11, A35 (open plan), A38, A46.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type Json, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../src/app.ts";
import { KEY_STILL_EXISTS } from "../src/findings.ts";
import { DAY_MS } from "../src/lifecycle/transitions.ts";
import { scanPlans } from "../src/plans/control.ts";
import { getPlan } from "../src/plans/plan.ts";
import { noteKeys } from "../src/plans/words.ts";
import * as store from "../src/store.ts";
import { OWNER, refused, SYSTEM, set, stateOf, WAIVE } from "./lifecycle-helpers.ts";
import { agentItem, approveAndDeliver, HENRY, leave, makeWorld, SALES, type World } from "./plans-world.ts";

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
type Run = { run(i: unknown, c: OpContext): Promise<unknown> };
const PERSON = { type: "person", id: "per_owner", name: "owner", mode: null };
const AGENT = { type: "agent", id: HENRY, name: "Henry", mode: "free" };

function ctxOf(w: World, caller: object = PERSON): OpContext {
  return { db: w.db, caller, log: LOG, callApp: async () => ({ status: "ok", output: {} }), companionTargets: () => [], topology: () => null, bridgeCaps: () => ["owner_drafts"], paused: () => ({ workspace: false, instance: false, agent: false }), ownerDrafts: w.core, jobs: { enqueue: () => {} }, ownerLink: () => null, ownerLinkFor: () => null } as unknown as OpContext;
}
const run = (id: string, input: unknown, c: OpContext) => (handlers as unknown as Record<string, Run>)[id]?.run(input, c) as Promise<Record<string, any>>;
const validOut = (id: string, out: unknown) => {
  const spec = manifest.operations.find((o) => o.id === id) as unknown as { output: Parameters<typeof validateAgainstSchema>[0] };
  const v = validateAgainstSchema(spec.output, out as Json);
  assert.deepEqual(v.ok ? [] : v.errors, [], `${id} output`);
};

test("the plan ops are person ops; an agent and an app are refused, and nothing is written", async () => {
  const w = makeWorld();
  leave(w);
  for (const id of ["plan_send", "plan_get", "plan_retry", "plan_cancel"]) {
    const spec = manifest.operations.find((o) => o.id === id) as unknown as { audience: string };
    assert.equal(spec.audience, "person", id);
    for (const caller of [AGENT, { type: "app", id: "ins_x", product: "rules", listed: true }]) await assert.rejects(run(id, { kind: "agent", id: HENRY, plan: "pln_x" }, ctxOf(w, caller)), refused("no_access", 403));
  }
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM fleet_plans").get()?.n, 0);
});

test("plan_send answers at once, with no call out; plan_get reads the same plan; outputs obey the manifest", async () => {
  const w = makeWorld();
  w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
  leave(w);
  const sent = await run("plan_send", { kind: "agent", id: HENRY }, ctxOf(w));
  validOut("plan_send", sent);
  assert.equal(sent.plans[0].state, "preparing");
  assert.equal(w.core.data.drafts.length, 0, "the job calls Core");
  const id = sent.plans[0].id;
  await w.tick(id);
  const got = await run("plan_get", { plan: id }, ctxOf(w));
  validOut("plan_get", got);
  assert.equal(got.plans[0].state, "waiting");
  assert.equal(got.plans[0].headline, "Waiting for you in Portal");
  assert.match(got.plans[0].reviewUrl, /drafts/);
  assert.equal(got.plans[0].steps.find((s: { store: string }) => s.store === "core").text, "Waiting for you in Portal");
  assert.equal(got.plans[0].steps.find((s: { store: string }) => s.store === "core").label, "Stop Henry and remove its access");
  assert.ok(got.plans[0].notChanged.length > 0);
  // one entry, and every open plan, give the same plan
  assert.equal((await run("plan_get", { kind: "agent", id: HENRY }, ctxOf(w))).plans[0].id, id);
  assert.equal((await run("plan_get", {}, ctxOf(w))).plans[0].id, id);
  await assert.rejects(run("plan_get", { plan: "pln_none" }, ctxOf(w)), refused("plan_not_found", 404));
});

test("words: what is only said never reads as done, and the counts keep the two apart", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  w.core.topologyOn = false;
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  await w.tick(id);
  const p = (await run("plan_get", { plan: id }, ctxOf(w))).plans[0];
  assert.equal(p.state, "reported");
  assert.match(p.headline, /Governance could not see 1 of the steps/);
  assert.deepEqual(p.counts, { proved: 0, said: 1, manual: 0, open: 0 });
  assert.match(p.steps[0].text, /Core says removed/);
  assert.doesNotMatch(p.headline, /^Done/);
});

test("A11: T6 before the approval: the draft is withdrawn, then the state moves; the owner cannot apply it any more", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  await run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake" }, ctxOf(w));
  assert.equal(w.plan(id).state, "withdrawn");
  assert.equal(stateOf(w.db, "agent", HENRY), "active");
  assert.equal(w.core.open().length, 0);
  assert.throws(() => w.core.apply(String(w.plan(id).draft_key)), (e: TbError) => e.code === "draft_state");
});

test("A11: T6 racing the apply: Core says applied, so T6 is refused and nothing is silent", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  // the owner applied in another tab, and no tick has read it yet
  w.core.apply(String(w.plan(id).draft_key));
  await assert.rejects(run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake" }, ctxOf(w)), refused("plan_applied", 409));
  assert.equal(stateOf(w.db, "agent", HENRY), "leaving");
  await w.tick(id);
  assert.equal(w.plan(id).draft_state, "applied");
  // after a tick read it, the guard of the setter says the same
  await assert.rejects(run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake" }, ctxOf(w)), refused("plan_applied", 409));
  assert.equal(stateOf(w.db, "agent", HENRY), "leaving");
});

test("T6 with Portal down: refused, because the draft could still be applied", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  w.core.down = true;
  await assert.rejects(run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake" }, ctxOf(w)), refused("portal_unavailable", 503));
  assert.equal(stateOf(w.db, "agent", HENRY), "leaving");
  assert.equal(w.plan(id).state, "waiting");
});

test("T4 with a new end date in the same call: its own date lets it pass; the try-first does not refuse it, and the draft goes", async () => {
  const w = makeWorld();
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t);
  w.db.prepare("UPDATE fleet_agents SET valid_until = ? WHERE id = ?").run(Date.now() - 1000, HENRY);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  await assert.rejects(run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "returned" }, ctxOf(w)), refused("date_passed", 409));
  assert.equal(w.plan(id).state, "waiting", "refused: nothing taken back");
  assert.equal(w.core.open().length, 1);
  const until = new Date(Date.now() + 86_400_000).toISOString();
  await run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "returned", validUntil: until }, ctxOf(w));
  assert.equal(stateOf(w.db, "agent", HENRY), "active");
  assert.equal(w.plan(id).state, "withdrawn");
  assert.equal(w.core.open().length, 0);
});

test("a lifecycle_set whose own check would fail after the withdraw: tried first, nothing is taken back; a bad date, a bad decision", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  const rev = store.revision(w.db);
  await assert.rejects(run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake", validUntil: "not a date" }, ctxOf(w)), refused("input_invalid", 400));
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(w.core.open().length, 1);
  assert.equal(store.revision(w.db), rev, "the try wrote nothing");
  assert.equal(stateOf(w.db, "agent", HENRY), "leaving");
});

test("the entry moves during the call to Portal, so the change fails after the withdraw: the owner reads that the request is gone and the entry did not change", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  const real = w.core.withdraw.bind(w.core);
  w.core.withdraw = async (k) => {
    const a = await real(k);
    w.db.prepare("UPDATE fleet_agents SET trust = 'blocked' WHERE id = ?").run(HENRY); // someone blocked the agent meanwhile (C381: an owner is no guard of a T6 any more)
    return a;
  };
  await assert.rejects(run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake" }, ctxOf(w)), (e: TbError) => {
    assert.equal(e.code, "trust_blocked");
    assert.match(e.message, /taken back already, and this entry did not change/);
    return true;
  });
  assert.equal(stateOf(w.db, "agent", HENRY), "leaving");
  const view = (await run("plan_get", { plan: id }, ctxOf(w))).plans[0];
  assert.equal(view.state, "withdrawn");
  assert.match(view.note, /still marked as stopped/);
});

async function splitWorld() {
  const w = makeWorld();
  const { agentId } = await import("./plans-world.ts");
  const ids = Array.from({ length: 101 }, (_, i) => agentId(i + 10));
  store.syncAgents(w.db, [...w.db.prepare("SELECT id, name, mode, status FROM fleet_agents").all(), ...ids.map((id) => ({ id, name: id, mode: "free", status: "active" }))] as never, w.clock.t);
  for (const id of ids) {
    store.setAgent(w.db, { agent: id, owner: w.ann.id }, w.clock.t);
    w.core.addAgent(id, 0, 0);
  }
  set(w.db, "person", w.ann.id, "leaving", { noCap: true }, w.clock.t);
  // C381: the person leaving has no Core step. Each agent has its own stop, so the person's plan holds a pause for each of the 103
  for (const id of [HENRY, SALES, ...ids]) set(w.db, "agent", id, "suspended", { noCap: true }, w.clock.t);
  const first = w.makePlan({ kind: "person", id: w.ann.id });
  const parts = w.db.prepare("SELECT id FROM fleet_plans WHERE group_id = ? ORDER BY part").all(first).map((r) => String(r.id));
  for (const id of parts) await w.tick(id);
  return { w, parts, first };
}

test("split, plan_cancel with Portal down for the second part: part 1 is cancelled, part 2 stays open; each part says its true state; a second cancel finishes it", async () => {
  const { w, parts, first } = await splitWorld();
  const real = w.core.withdraw.bind(w.core);
  let calls = 0;
  w.core.withdraw = async (k) => {
    calls++;
    if (calls === 2) throw new TbError("portal_unavailable", "down", 503);
    return real(k);
  };
  const out = await run("plan_cancel", { plan: first }, ctxOf(w));
  validOut("plan_cancel", out);
  const [a, b] = out.plans;
  assert.equal(a.state, "cancelled");
  assert.match(a.note, /do not all have the same state/);
  assert.match(a.note, /still marked as stopped/);
  assert.equal(out.left, 1);
  assert.equal(b.state, "waiting");
  assert.equal(b.canCancel, true);
  assert.match(b.note, /could still be applied/);
  assert.equal(w.core.open().length, 1, "one part still stands, and the page says so");
  // the next tick reads the draft; what the owner needs to know stays
  await w.tick(parts[1] as string);
  assert.match((await run("plan_get", { plan: parts[1] }, ctxOf(w))).plans[1].note, /could still be applied/);
  w.core.withdraw = real;
  const again = await run("plan_cancel", { plan: first }, ctxOf(w));
  assert.deepEqual(again.plans.map((p: { state: string }) => p.state), ["cancelled", "cancelled"]);
  assert.equal(w.core.open().length, 0);
  assert.equal(parts.length, 2);
});

test("plan_cancel with Portal down for the only part: an error, nothing moved; the note stays after a tick", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  const real = w.core.withdraw.bind(w.core);
  w.core.withdraw = async () => {
    throw new TbError("portal_unavailable", "down", 503);
  };
  await assert.rejects(run("plan_cancel", { plan: id }, ctxOf(w)), refused("portal_unavailable", 503));
  assert.equal(w.plan(id).state, "waiting");
  await w.tick(id);
  assert.match((await run("plan_get", { plan: id }, ctxOf(w))).plans[0].note, /could still be applied/);
  w.core.withdraw = real;
  const out = await run("plan_cancel", { plan: id }, ctxOf(w));
  assert.equal(out.left, 0);
  assert.equal(out.plans[0].state, "cancelled");
  assert.doesNotMatch(String(out.plans[0].note), /could still be applied/);
});

test("the rail is gone and T6 goes on: the error text never says Portal took back what it did not", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  w.core.flag = false;
  const real = w.core.withdraw.bind(w.core);
  w.core.withdraw = async (k) => {
    w.db.prepare("UPDATE fleet_agents SET trust = 'blocked' WHERE id = ?").run(HENRY);
    return real(k);
  };
  await assert.rejects(run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake" }, ctxOf(w)), (e: TbError) => {
    assert.equal(e.code, "trust_blocked");
    assert.doesNotMatch(e.message, /taken back already/);
    return true;
  });
  assert.equal(w.plan(id).code, "not_taken_back");
});

test("split, T6 with Portal down for one part: the state does not move; the error counts what went; the page says the same", async () => {
  const { w, first, parts } = await splitWorld();
  const real = w.core.withdraw.bind(w.core);
  let calls = 0;
  w.core.withdraw = async (k) => {
    calls++;
    if (calls === 2) throw new TbError("portal_unavailable", "down", 503);
    return real(k);
  };
  await assert.rejects(run("lifecycle_set", { kind: "person", id: w.ann.id, to: "active", reason: "mistake" }, ctxOf(w)), (e: TbError) => {
    assert.equal(e.code, "portal_unavailable");
    assert.match(e.message, /1 of 2 open parts were taken back already. Nothing else changed/);
    return true;
  });
  assert.equal(stateOf(w.db, "person", w.ann.id), "leaving");
  assert.equal(w.plan(first).state, "withdrawn");
  assert.equal(w.plan(parts[1] as string).state, "waiting");
  // the owner tries again: the rest goes, and the state moves
  w.core.withdraw = real;
  await run("lifecycle_set", { kind: "person", id: w.ann.id, to: "active", reason: "mistake" }, ctxOf(w));
  assert.equal(stateOf(w.db, "person", w.ann.id), "active");
  assert.equal(w.core.open().length, 0);
});

test("split, plan_retry: all parts or none. A part whose Core step failed refuses the whole Try again, and no part moved", async () => {
  const { w, first, parts } = await splitWorld();
  w.core.failAgent = null;
  const p2 = parts[1] as string;
  w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself", agent: String(w.steps(first).find((s) => s.phase === "core")?.agent_id) }));
  for (const id of parts) await w.tick(id);
  // part 1 refused by Rules on a store step; part 2's Core step failed
  approveAndDeliver(w, String(w.plan(first).draft_key), String(w.steps(first).find((s) => s.phase === "core")?.agent_id));
  w.connect.revokeScript.push({ kind: "deny" });
  await w.tick(first);
  w.core.failStep = "agents.pause";
  w.core.apply(String(w.plan(p2).draft_key));
  await w.tick(p2);
  assert.equal(w.plan(p2).state, "partial");
  const before = String(w.item(first, "account_as_itself:a").state);
  await assert.rejects(run("plan_retry", { plan: first }, ctxOf(w)), refused("apply_in_portal", 409));
  assert.equal(w.item(first, "account_as_itself:a").state, before, "part 1 did not move");
});

test("a T6 refused by its own guard takes nothing back", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  w.db.prepare("UPDATE fleet_agents SET trust = 'blocked' WHERE id = ?").run(HENRY);
  await assert.rejects(run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake" }, ctxOf(w)), refused("trust_blocked", 409));
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(w.core.open().length, 1);
});

test("C381: a T6 of an agent with no owner, or whose owner is stopped, is not refused for it: the draft goes and the agent resumes", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  w.db.prepare("UPDATE fleet_agents SET owner_id = NULL WHERE id = ?").run(HENRY);
  await run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake" }, ctxOf(w));
  assert.equal(stateOf(w.db, "agent", HENRY), "active");
  assert.equal(w.plan(id).state, "withdrawn");
  assert.equal(w.core.open().length, 0);
});

test("T4 after the pause was applied: the plan ends, remaining store steps do not run, the pause stays: the page shows it as paused_outside", async () => {
  const w = makeWorld();
  w.connect.add(agentItem({ id: "scheduled_post:p", kind: "scheduled_post" }));
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  await w.tick(id);
  // not yet proved at this store: its row is held
  w.connect.data.rows.push({ id: "scheduled_post:q", kind: "scheduled_post", subject: { kind: "agent", id: HENRY }, resource: "q", level: "write", label: "Post" });
  await run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "returned" }, ctxOf(w));
  assert.ok(["cancelled", "done"].includes(String(w.plan(id).state)));
  assert.equal(w.core.data.agents[HENRY]?.status, "paused", "a resume is the owner's act in Portal");
});

test("the Core draft expired, or was rejected: plan_retry asks with a new key; the old key would answer the old draft", async () => {
  for (const end of ["expire", "reject"] as const) {
    const w = makeWorld();
    w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
    leave(w);
    const id = w.makePlan({ kind: "agent", id: HENRY, expiresInSec: 120 });
    await w.tick(id);
    const first = String(w.plan(id).draft_key);
    if (end === "expire") w.clock.t += 121_000;
    else w.core.reject(first);
    await w.tick(id);
    assert.equal(w.plan(id).state, end === "expire" ? "expired" : "rejected");
    await run("plan_retry", { plan: id }, ctxOf(w));
    assert.equal(w.plan(id).state, "preparing");
    assert.equal(w.item(id, "account_as_itself:a").state, "pending");
    await w.tick(id);
    assert.equal(w.plan(id).state, "waiting");
    assert.notEqual(w.plan(id).draft_key, first);
    assert.equal(w.core.open().length, 1);
    approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
    await w.tick(id);
    assert.equal(w.plan(id).state, "done");
    assert.deepEqual(w.connect.data.ended, ["account_as_itself:a"]);
  }
});

test("A7: refused, then Try again: new attempt after a list, ok, no double action", async () => {
  const w = makeWorld();
  w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  w.connect.revokeScript.push({ kind: "deny" });
  await w.tick(id);
  assert.equal(w.plan(id).state, "partial");
  const firstKey = w.item(id, "account_as_itself:a").key;
  const view = (await run("plan_get", { plan: id }, ctxOf(w))).plans[0];
  assert.equal(view.canRetry, true);
  assert.match(view.steps.find((s: { store: string }) => s.store === "connect").text, /Connect refused: Refused by a rule/);
  const lists = w.connect.data.lists;
  await run("plan_retry", { plan: id }, ctxOf(w));
  await w.tick(id);
  assert.ok(w.connect.data.lists > lists, "a new attempt only after a fresh list");
  assert.equal(w.item(id, "account_as_itself:a").state, "done");
  assert.notEqual(w.item(id, "account_as_itself:a").key, firstKey);
  assert.deepEqual(w.connect.data.ended, ["account_as_itself:a"]);
  assert.equal(w.plan(id).state, "done");
});

test("Try again leaves `changed` alone: the owner did not see the new row, so only a new plan ends it", async () => {
  const w = makeWorld();
  const row = w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY, items: [{ product: "connect", id: row.id, digest: "sha256:old" }] });
  await w.tick(id);
  assert.equal(w.item(id, row.id).state, "changed");
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  await w.tick(id);
  assert.equal(w.plan(id).state, "partial");
  const view = (await run("plan_get", { plan: id }, ctxOf(w))).plans[0];
  assert.equal(view.canRetry, false, "nothing Try again could do");
  assert.match(view.steps.find((s: { store: string }) => s.store === "connect").text, /Make a new plan/);
  await run("plan_retry", { plan: id }, ctxOf(w));
  await w.tick(id);
  assert.equal(w.item(id, row.id).state, "changed");
  assert.equal(w.connect.data.ended.length, 0);
  // the way out: cancel, new plan, new look
  await run("plan_cancel", { plan: id }, ctxOf(w));
  const next = (await run("plan_send", { kind: "agent", id: HENRY, items: [{ product: "connect", id: row.id, digest: w.connect.digestOf(row) }] }, ctxOf(w))).plans[0].id;
  await w.tick(next);
  approveAndDeliver(w, String(w.plan(next).draft_key), HENRY);
  await w.tick(next);
  assert.equal(w.plan(next).state, "done");
});

test("Try again: a failed Core step is for Portal; a finished plan and a moved entry are refused", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  w.core.failStep = "agents.offboard";
  w.core.apply(String(w.plan(id).draft_key));
  await w.tick(id);
  assert.equal((await run("plan_get", { plan: id }, ctxOf(w))).plans[0].canRetry, false);
  await assert.rejects(run("plan_retry", { plan: id }, ctxOf(w)), refused("apply_in_portal", 409));
  w.core.failStep = null;
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  await w.tick(id);
  assert.equal(w.plan(id).state, "done");
  await assert.rejects(run("plan_retry", { plan: id }, ctxOf(w)), refused("plan_finished", 409));

  const v = makeWorld();
  leave(v);
  const pid = v.makePlan({ kind: "agent", id: HENRY });
  await v.tick(pid);
  v.core.reject(String(v.plan(pid).draft_key));
  await v.tick(pid);
  v.db.prepare("UPDATE fleet_agents SET lifecycle_rev = lifecycle_rev + 1 WHERE id = ?").run(HENRY);
  await assert.rejects(run("plan_retry", { plan: pid }, ctxOf(v)), refused("lifecycle_stale", 409));
});

test("plan_cancel: takes the draft back, cancels what has not run; applying is refused; applied stays", async () => {
  const w = makeWorld();
  w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  await run("plan_cancel", { plan: id }, ctxOf(w));
  assert.equal(w.plan(id).state, "cancelled");
  assert.equal(w.core.open().length, 0);
  assert.equal(w.item(id, "account_as_itself:a").state, "cancelled");

  const v = makeWorld();
  leave(v);
  const pid = v.makePlan({ kind: "agent", id: HENRY });
  await v.tick(pid);
  v.core.apply(String(v.plan(pid).draft_key), { stopMidWay: true });
  await v.tick(pid);
  await assert.rejects(run("plan_cancel", { plan: pid }, ctxOf(v)), refused("plan_applying", 409));
});

test("plan_cancel while the first ask is on its way: the draft that lands is taken back, none stays open with no plan", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  const real = w.core.request.bind(w.core);
  // The owner cancels while Core is answering.
  w.core.request = async (b) => {
    const a = await real(b);
    await run("plan_cancel", { plan: id }, ctxOf(w));
    return a;
  };
  await w.tick(id);
  assert.equal(w.plan(id).state, "cancelled");
  assert.equal(w.core.open().length, 0);
});

test("a second plan replaces an open one and takes its draft back; a plan past Core stays", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  const out = await run("plan_send", { kind: "agent", id: HENRY }, ctxOf(w));
  assert.equal(w.plan(id).state, "replaced");
  assert.equal(w.core.open().length, 0);
  const nid = out.plans[0].id;
  await w.tick(nid);
  approveAndDeliver(w, String(w.plan(nid).draft_key), HENRY);
  w.connect.add(agentItem({ id: "account_as_itself:b", kind: "account_as_itself" }));
  w.connect.revokeScript.push({ kind: "deny" });
  await w.tick(nid);
  assert.equal(w.plan(nid).state, "partial");
  await assert.rejects(run("plan_send", { kind: "agent", id: HENRY }, ctxOf(w)), refused("plan_open", 409));
});

test("T7: an open plan blocks Close, quiet when it ended; waiving the cooling period does not skip it", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  w.db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(HENRY);
  assert.throws(() => set(w.db, "agent", HENRY, "archived", { waive: WAIVE }, w.clock.t), refused("plan_open", 409));
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  await w.tick(id);
  assert.equal(w.plan(id).state, "done");
  set(w.db, "agent", HENRY, "archived", { waive: WAIVE }, w.clock.t);
  assert.equal(stateOf(w.db, "agent", HENRY), "archived");
});

test("A38: a date passes: the system plan opens once, its draft waits, the owner is told once; expired re-issues once a day until resolved", async () => {
  const w = makeWorld();
  set(w.db, "agent", HENRY, "suspended", { actor: SYSTEM }, w.clock.t);
  const scan = () => scanPlans(w.db, w.clock.t, () => {});
  scan();
  scan();
  const rows = () => w.db.prepare("SELECT id FROM fleet_plans").all();
  assert.equal(rows().length, 1, "one plan per transition");
  const id = String(rows()[0]?.id);
  assert.equal(w.plan(id).trigger_kind, "system");
  await w.tick(id);
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(w.core.open().length, 1);
  assert.equal(w.inbox.asks.length, 1);
  await w.tick(id);
  assert.equal(w.inbox.asks.length, 1, "once");
  w.clock.t += DAY_MS + 1000; // the draft runs out at 24 h
  await w.tick(id);
  assert.equal(w.plan(id).state, "expired");
  assert.equal(w.inbox.asks.length, 2);
  scan();
  assert.equal(w.plan(id).state, "expired", "not before a day has passed since it expired");
  w.clock.t += DAY_MS + 1000;
  scan();
  assert.equal(w.plan(id).state, "preparing");
  await w.tick(id);
  assert.equal(w.core.open().length, 1, "asked again, with a new key");
  assert.equal(w.inbox.asks.length, 2, "the waiting alert stays once per plan");
  assert.equal(rows().length, 1);
  // the owner took it back: nothing is owed any more
  await run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "returned" }, ctxOf(w));
  scan();
  assert.equal(rows().length, 1);
  assert.equal(w.plan(id).state, "withdrawn");
});

test("an owner plan that expired is not asked again by itself", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY, expiresInSec: 120 });
  await w.tick(id);
  w.clock.t += 121_000;
  await w.tick(id);
  w.clock.t += 3 * DAY_MS;
  scanPlans(w.db, w.clock.t, () => {});
  assert.equal(w.plan(id).state, "expired");
  assert.equal(getPlan(w.db, id)?.trigger_kind, "owner");
});

test("the actor in a plan row is the owner; a person's plan is not stale because an agent in it moved", async () => {
  const w = makeWorld();
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  leave(w); // C381: Henry has its own stop, so the person's plan has a Core step
  const id = w.makePlan({ kind: "person", id: w.ann.id, actor: OWNER });
  assert.equal(w.plan(id).actor_id, OWNER.id);
  await w.tick(id);
  w.db.prepare("UPDATE fleet_agents SET lifecycle_rev = lifecycle_rev + 1 WHERE id = ?").run(SALES);
  await w.tick(id);
  assert.equal(w.plan(id).state, "waiting");
});

test("T7: a person cannot close while a Connect account has no person, until the owner answers with exception_set; a later account counts again", async () => {
  const w = makeWorld();
  w.db.prepare("UPDATE fleet_agents SET owner_id = NULL").run();
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const add = (id: string, seen: number) => w.db.prepare("INSERT INTO fleet_access_items (target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, since, digest, first_seen, last_seen) VALUES ('connect', ?, 'account_as_me', 'unlinked', NULL, ?, 'held_by', 'use', 'Mail', 'active', 0, NULL, 'd', ?, ?)").run(id, id, seen, seen);
  add("account_as_me:acc", w.clock.t);
  assert.throws(() => set(w.db, "person", w.ann.id, "archived", { waive: WAIVE }, w.clock.t), refused("unlinked_accounts", 409));
  // the finding the owner answers, through the real op
  const c = { ...(ctxOf(w) as object) } as OpContext;
  const until = new Date(Date.now() + 86_400_000).toISOString();
  w.clock.t = Date.now();
  await run("exception_set", { code: "unlinked_account", kind: "person", id: w.ann.id, reason: "Not hers: this is the company mailbox", until }, c);
  add("account_as_me:later", Date.now() + 5_000);
  assert.throws(() => set(w.db, "person", w.ann.id, "archived", { waive: WAIVE }, Date.now()), refused("unlinked_accounts", 409));
  w.db.prepare("DELETE FROM fleet_access_items WHERE item_id = 'account_as_me:later'").run();
  set(w.db, "person", w.ann.id, "archived", { waive: WAIVE }, Date.now());
  assert.equal(stateOf(w.db, "person", w.ann.id), "archived");
});

test("findings: leaving with no plan, quiet with a plan; an agent in a person's plan has a plan; expired says so", async () => {
  const { loadColleagues } = await import("../src/lifecycle/view.ts");
  const codes = (w: World, id: string) => loadColleagues(w.db, w.clock.t).byId.get(`agent:${id}`)?.findings.map((f) => f.code) ?? [];
  const w = makeWorld();
  leave(w);
  assert.ok(codes(w, HENRY).includes("leaving_no_plan"));
  const id = w.makePlan({ kind: "agent", id: HENRY, expiresInSec: 120 });
  assert.ok(!codes(w, HENRY).includes("leaving_no_plan"));
  await w.tick(id);
  w.clock.t += 121_000;
  await w.tick(id);
  assert.ok(codes(w, HENRY).includes("plan_expired"));

  const v = makeWorld();
  set(v.db, "agent", SALES, "leaving", {}, v.clock.t);
  set(v.db, "person", v.ann.id, "leaving", {}, v.clock.t);
  v.makePlan({ kind: "person", id: v.ann.id });
  assert.ok(!codes(v, SALES).includes("leaving_no_plan"));
});

test("the record: a plan's start, the approval with Core's receipt and its end are in the event chain, and the chain holds", async () => {
  const { verifyChain } = await import("../src/lifecycle/events.ts");
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  await w.tick(id);
  const rows = w.db.prepare("SELECT note, plan_id, draft_id, receipt_id FROM fleet_lifecycle_events WHERE plan_id = ? ORDER BY seq").all(id);
  assert.equal(rows.length, 3);
  assert.match(String(rows[0]?.note), /A plan was made: 1 steps/);
  assert.ok(rows[1]?.receipt_id, "Core's receipt id, copied: SDK receipts live 90 days");
  assert.ok(rows[2]?.draft_id);
  assert.match(String(rows[2]?.note), /ended: done/);
  assert.equal(verifyChain(w.db).ok, true);
  assert.doesNotMatch(JSON.stringify(w.core.data.drafts), /Henry|Ann|left/, "no name and no reason reached Core");
});

test("plan_send that its own check refuses takes no older draft back", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  await assert.rejects(run("plan_send", { kind: "agent", id: HENRY, expectedRev: 0 }, ctxOf(w)), refused("lifecycle_stale", 409));
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(w.core.open().length, 1);
});

test("a slice arrives: open plans become due at once; the event handler starts the job; no open plan, no job", async () => {
  const { definition } = await import("../src/app.ts");
  const w = makeWorld();
  let kicks = 0;
  const ctx = { db: w.db, jobs: { enqueue: () => kicks++ } } as never;
  const agents = [{ id: HENRY, name: "Henry", mode: "free", status: "active" }] as never;
  await definition.events?.agentsChanged?.(agents, ctx);
  assert.equal(kicks, 0);
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  w.db.prepare("UPDATE fleet_plans SET next_at = ? WHERE id = ?").run(w.clock.t + 900_000, id);
  await definition.events?.agentsChanged?.(agents, ctx);
  assert.equal(kicks, 1);
  assert.equal(w.plan(id).next_at, 0);
});

test("an old system date does not open a plan for a stop the owner made later", () => {
  const w = makeWorld();
  set(w.db, "agent", HENRY, "suspended", { actor: SYSTEM }, w.clock.t);
  set(w.db, "agent", HENRY, "active", {}, w.clock.t + 1000);
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t + 2000);
  scanPlans(w.db, w.clock.t + 3000, () => {});
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM fleet_plans").get()?.n, 0);
});

test("canRetry says what plan_retry takes", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  const can = async () => (await run("plan_get", { plan: id }, ctxOf(w))).plans[0].canRetry;
  assert.equal(await can(), false);
  w.core.reject(String(w.plan(id).draft_key));
  await w.tick(id);
  assert.equal(await can(), true);
  await run("plan_retry", { plan: id }, ctxOf(w));
  await w.tick(id);
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  await w.tick(id);
  assert.equal(w.plan(id).state, "done");
  assert.equal(await can(), false);
});

test("the rail went away with a draft in Portal: T6 and cancel still ask to take it back, and say so when they cannot", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  // one read says the rail is off; the draft stands
  w.core.flag = false;
  await w.tick(id);
  assert.equal(w.plan(id).rail, "portal_link");
  // back on: cancel takes it back, whatever the mode says
  w.core.flag = true;
  await run("plan_cancel", { plan: id }, ctxOf(w));
  assert.equal(w.core.open().length, 0);
  assert.equal(w.plan(id).state, "cancelled");

  const v = makeWorld();
  leave(v);
  const pid = v.makePlan({ kind: "agent", id: HENRY });
  await v.tick(pid);
  v.core.flag = false;
  await run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake" }, ctxOf(v));
  assert.equal(v.plan(pid).state, "withdrawn");
  assert.equal(v.plan(pid).code, "not_taken_back");
  const view = (await run("plan_get", { plan: pid }, ctxOf(v))).plans[0];
  assert.match(view.headline, /could not take this request back/);
  assert.equal(v.core.open().length, 1, "it is still there, and the page says it may be");
});

test("lifecycle_set with a stale expectedRev takes nothing back", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  await assert.rejects(run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake", expectedRev: 0 }, ctxOf(w)), refused("lifecycle_stale", 409));
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(w.core.open().length, 1);
});

test("T7: the last plan did not finish: Close needs a new plan or a named reason", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  w.core.reject(String(w.plan(id).draft_key));
  await w.tick(id);
  w.db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(HENRY);
  w.clock.t += 40 * DAY_MS;
  assert.throws(() => set(w.db, "agent", HENRY, "archived", {}, w.clock.t), refused("plan_not_finished", 409));
  set(w.db, "agent", HENRY, "archived", { waive: WAIVE }, w.clock.t);
  assert.equal(stateOf(w.db, "agent", HENRY), "archived");
});

test("Try again in link mode asks Portal again: consent may be on now", async () => {
  const w = makeWorld();
  leave(w);
  w.core.consent = false;
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  assert.equal(w.plan(id).rail, "portal_link");
  assert.equal((await run("plan_get", { plan: id }, ctxOf(w))).plans[0].canRetry, true);
  w.core.consent = true;
  await run("plan_retry", { plan: id }, ctxOf(w));
  await w.tick(id);
  assert.equal(w.plan(id).rail, "draft");
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(w.core.open().length, 1);
});

test("a stale, withdrawn or replaced plan cannot ask again; nor one with a newer plan open; nor a Core that lied", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  const out = await run("plan_send", { kind: "agent", id: HENRY }, ctxOf(w));
  assert.equal(w.plan(id).state, "replaced");
  await assert.rejects(run("plan_retry", { plan: id }, ctxOf(w)), refused("plan_ended", 409));
  await w.tick(out.plans[0].id);
  assert.equal(w.core.open().length, 1);

  const v = makeWorld();
  leave(v);
  const pid = v.makePlan({ kind: "agent", id: HENRY });
  await v.tick(pid);
  await v.tick(pid);
  v.core.lieGet = "digest";
  await v.tick(pid);
  assert.equal(v.plan(pid).code, "core_mismatch");
  await assert.rejects(run("plan_retry", { plan: pid }, ctxOf(v)), refused("plan_ended", 409));
});

test("a system plan that expired while the owner made his own, or while the entry moved: it does not come back as a second plan", async () => {
  const w = makeWorld();
  set(w.db, "agent", HENRY, "suspended", { actor: SYSTEM }, w.clock.t);
  scanPlans(w.db, w.clock.t, () => {});
  const sys = String(w.db.prepare("SELECT id FROM fleet_plans").get()?.id);
  await w.tick(sys);
  w.clock.t += DAY_MS + 1000;
  await w.tick(sys);
  assert.equal(w.plan(sys).state, "expired");
  const own = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(own);
  w.clock.t += DAY_MS + 1000;
  scanPlans(w.db, w.clock.t, () => {});
  assert.equal(w.plan(sys).state, "replaced");

  const v = makeWorld();
  set(v.db, "agent", HENRY, "suspended", { actor: SYSTEM }, v.clock.t);
  scanPlans(v.db, v.clock.t, () => {});
  const s2 = String(v.db.prepare("SELECT id FROM fleet_plans").get()?.id);
  await v.tick(s2);
  v.clock.t += DAY_MS + 1000;
  await v.tick(s2);
  v.db.prepare("UPDATE fleet_agents SET lifecycle_rev = lifecycle_rev + 1 WHERE id = ?").run(HENRY);
  v.clock.t += DAY_MS + 1000;
  scanPlans(v.db, v.clock.t, () => {});
  assert.equal(v.plan(s2).state, "stale");
});

test("a new plan refuses as a whole when any part is past Core: no part is taken back first", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  w.core.apply(String(w.plan(id).draft_key));
  await w.tick(id);
  assert.notEqual(w.plan(id).state, "done");
  await assert.rejects(run("plan_send", { kind: "agent", id: HENRY }, ctxOf(w)), refused("plan_open", 409));
  assert.ok(!["replaced", "withdrawn"].includes(String(w.plan(id).state)));
});

test("T7 reads each part of a split plan: part 1 done and part 2 rejected is not finished", async () => {
  const w = makeWorld();
  const { lastPlanUnfinished } = await import("../src/plans/guards.ts");
  w.db.prepare("INSERT INTO fleet_plans (id, group_id, part, parts, subject_kind, subject_id, subject_name, purpose, trigger_kind, lifecycle_rev, state, plan_digest, expires_in_sec, opened_at, updated_at) VALUES ('pln_a', 'pln_a', 1, 2, 'person', ?, 'Ann', 'leave', 'owner', 1, 'done', 'd', 60, 5, 5), ('pln_b', 'pln_a', 2, 2, 'person', ?, 'Ann', 'leave', 'owner', 1, 'rejected', 'd', 60, 5, 5)").run(w.ann.id, w.ann.id);
  assert.equal(lastPlanUnfinished(w.db, "person", w.ann.id), true);
});

test("D2 (C381), own stops with no choice: one approval stops access, only a pause; the plan, the row, the finding and the summary say the key still exists; a second plan with a choice finishes it", async () => {
  const { loadColleagues, summaryGet } = await import("../src/lifecycle/view.ts");
  const w = makeWorld();
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  // the person leaving has no Core step: the agents with their own stop are the ones a plan pauses
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t);
  set(w.db, "agent", SALES, "suspended", {}, w.clock.t);
  const out = await run("plan_send", { kind: "person", id: w.ann.id }, ctxOf(w));
  const id = out.plans[0].id;
  await w.tick(id);
  assert.deepEqual(w.core.open()[0]?.steps.map((s) => s.opId), ["agents.pause", "agents.pause"]);
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY, SALES);
  await w.tick(id);
  store.syncAgents(w.db, [{ id: HENRY, name: "Henry", mode: "free", status: "paused" }, { id: SALES, name: "Sales", mode: "bound", status: "paused" }] as never, w.clock.t);
  assert.equal(w.core.data.agents[HENRY]?.keys, 1, "the key is still there");
  const view = (await run("plan_get", { plan: id }, ctxOf(w))).plans[0];
  assert.equal(view.state, "done");
  assert.equal(view.steps[0].text, KEY_STILL_EXISTS);
  assert.equal(view.note, noteKeys(2));
  assert.match(view.note, /2 agents you stopped stay paused with the key/);
  const row = () => loadColleagues(w.db, Date.now()).byId.get(`agent:${HENRY}`);
  assert.equal(row()?.line, KEY_STILL_EXISTS);
  assert.ok(row()?.findings.some((f) => f.code === "key_not_decided"));
  const sum = await summaryGet(ctxOf(w));
  assert.deepEqual(sum.keysUndecided?.map((k) => [k.name, k.text]), [["Henry", KEY_STILL_EXISTS], ["Sales", KEY_STILL_EXISTS]]);
  // the second approval: only what is new. Sales was paused already, and no pause goes again
  const again = await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "stop" }] }, ctxOf(w));
  const id2 = again.plans[0].id;
  await w.tick(id2);
  assert.deepEqual(w.core.open()[0]?.steps, [{ opId: "agents.offboard", agt: HENRY }]);
  approveAndDeliver(w, String(w.plan(id2).draft_key), HENRY);
  await w.tick(id2);
  assert.equal(w.core.data.agents[HENRY]?.keys, 0);
  assert.ok(!row()?.findings.some((f) => f.code === "key_not_decided"), "decided: the finding ends");
  assert.ok(loadColleagues(w.db, Date.now()).byId.get(`agent:${SALES}`)?.findings.some((f) => f.code === "key_not_decided"), "Sales is still undecided");
});

test("D2 (C381), choices at the first step: stop and transfer land in one draft with no pause; one approval ends the keys; an agent with no choice keeps working with its key", async () => {
  const { loadColleagues } = await import("../src/lifecycle/view.ts");
  const { agentId } = await import("./plans-world.ts");
  const w = makeWorld();
  const kept = agentId(40);
  store.syncAgents(w.db, [...w.db.prepare("SELECT id, name, mode, status FROM fleet_agents").all(), { id: kept, name: "Kept", mode: "free", status: "active" }] as never, w.clock.t);
  store.setAgent(w.db, { agent: kept, owner: w.ann.id }, w.clock.t);
  w.core.addAgent(kept, 1, 1);
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const out = await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "stop" }, { agent: SALES, decision: "transfer", newOwner: bob.id }] }, ctxOf(w));
  validOut("plan_send", out);
  const id = out.plans[0].id;
  assert.equal(stateOf(w.db, "agent", HENRY), "leaving");
  assert.equal(w.db.prepare("SELECT owner_id FROM fleet_agents WHERE id = ?").get(SALES)?.owner_id, bob.id);
  assert.equal(stateOf(w.db, "agent", SALES), "active", "a transfer pauses nothing");
  await w.tick(id);
  assert.deepEqual(w.core.open()[0]?.steps, [{ opId: "agents.offboard", agt: HENRY }, { opId: "agents.rotate", agt: SALES }]);
  assert.equal(w.core.data.drafts.length, 1, "one approval");
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY, SALES);
  await w.tick(id);
  assert.equal(w.plan(id).state, "done");
  assert.equal(w.core.data.agents[HENRY]?.keys, 0);
  assert.equal(w.core.data.agents[SALES]?.keys, 0);
  assert.equal(w.core.data.agents[kept]?.keys, 1, "no choice: the agent keeps working and keeps its key");
  assert.equal(stateOf(w.db, "agent", kept), "proposed", "its own state did not change");
  const rows = loadColleagues(w.db, w.clock.t).byId;
  for (const a of [HENRY, SALES, kept]) assert.ok(!rows.get(`agent:${a}`)?.findings.some((f) => f.code === "key_not_decided"), a);
  const keptFinding = rows.get(`agent:${kept}`)?.findings.find((f) => f.code === "owner_inactive");
  assert.match(String(keptFinding?.text), /keeps working/, "the agent with no choice says it needs an owner and keeps working");
  const view = (await run("plan_get", { plan: id }, ctxOf(w))).plans[0];
  assert.doesNotMatch(String(view.note), /stay paused with the key/);
  assert.equal(view.steps.find((s: { label: string }) => s.label === "Make a new key for Sales: it must be connected again").text, "Portal shows no old key left. Connect this agent again in Portal.");
  assert.equal(view.steps.some((s: { label: string }) => s.label === "Pause Sales"), false, "no pause step for a transfer");
});

test("D2 (C381), guards: fire on a choice on an entry not stopped, an agent not owned, twice for one agent, a transfer with no owner or to a stopped owner; `keep` is not in the schema; each refuses whole and takes no older draft back", async () => {
  const w = makeWorld();
  const c = ctxOf(w);
  await assert.rejects(run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "stop" }] }, c), refused("decisions_need_stop", 409));
  assert.equal(stateOf(w.db, "agent", HENRY), "active", "plan_send never starts a stop");
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  const gone = store.setPerson(w.db, { name: "Gone" }, w.clock.t);
  set(w.db, "person", gone.id, "leaving", {}, w.clock.t);
  store.setAgent(w.db, { agent: SALES, owner: bob.id }, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  // a plan that waits: Henry has its own stop
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t);
  const id = (await run("plan_send", { kind: "person", id: w.ann.id }, c)).plans[0].id;
  await w.tick(id);
  assert.equal(w.plan(id).state, "waiting");
  const before = w.core.open().length;
  const cases: [unknown[], string, number][] = [
    [[{ agent: SALES, decision: "stop" }], "agent_not_owned", 409],
    [[{ agent: HENRY, decision: "stop" }, { agent: HENRY, decision: "stop" }], "input_invalid", 400],
    [[{ agent: HENRY, decision: "transfer" }], "input_invalid", 400],
    [[{ agent: HENRY, decision: "transfer", newOwner: gone.id }], "owner_inactive", 409],
    [[{ agent: HENRY, decision: "transfer", newOwner: w.ann.id }], "input_invalid", 400],
  ];
  for (const [decisions, code, status] of cases) {
    await assert.rejects(run("plan_send", { kind: "person", id: w.ann.id, decisions }, c), refused(code, status), code);
    assert.equal(w.plan(id).state, "waiting", `${code}: no older draft taken back`);
    assert.equal(w.core.open().length, before);
    assert.equal(stateOf(w.db, "agent", HENRY), "suspended", `${code}: the choice rolled back`);
    assert.equal(w.db.prepare("SELECT owner_id FROM fleet_agents WHERE id = ?").get(HENRY)?.owner_id, w.ann.id, `${code}: no owner change was kept`);
  }
  // the schema takes stop and transfer, and no keep
  const spec = manifest.operations.find((o) => o.id === "plan_send") as unknown as { input: Parameters<typeof validateAgainstSchema>[0] };
  const okInput = (d: unknown) => validateAgainstSchema(spec.input, { kind: "person", id: w.ann.id, decisions: [d] } as Json).ok;
  assert.equal(okInput({ agent: HENRY, decision: "stop" }), true);
  assert.equal(okInput({ agent: HENRY, decision: "transfer", newOwner: bob.id, newKey: false }), true);
  assert.equal(okInput({ agent: HENRY, decision: "keep", reason: "Runs payroll" }), false);
});

test("D2, an agent alone: Stop now with a stop choice is one offboard in one approval; with none it is one pause; a stale revision reads before the choice moves it", async () => {
  const w = makeWorld();
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t);
  const rev = Number(w.db.prepare("SELECT lifecycle_rev AS r FROM fleet_agents WHERE id = ?").get(HENRY)?.r);
  await assert.rejects(run("plan_send", { kind: "agent", id: HENRY, expectedRev: rev - 1, decisions: [{ agent: HENRY, decision: "stop" }] }, ctxOf(w)), refused("lifecycle_stale", 409));
  assert.equal(stateOf(w.db, "agent", HENRY), "suspended");
  const out = await run("plan_send", { kind: "agent", id: HENRY, expectedRev: rev, decisions: [{ agent: HENRY, decision: "stop" }] }, ctxOf(w));
  const id = out.plans[0].id;
  assert.equal(w.plan(id).purpose, "leave");
  assert.notEqual(w.plan(id).lifecycle_rev, rev, "the plan holds the revision after its own choice, so it is not stale at once");
  await w.tick(id);
  assert.notEqual(w.plan(id).state, "stale");
  assert.deepEqual(w.core.open()[0]?.steps, [{ opId: "agents.offboard", agt: HENRY }]);
});

test("D2 review: after the second plan the first plan no longer says the key exists; an agent brought back with a new key gets the finding again", async () => {
  const { loadColleagues } = await import("../src/lifecycle/view.ts");
  const w = makeWorld();
  store.setAgent(w.db, { agent: SALES, owner: null }, w.clock.t);
  set(w.db, "person", w.ann.id, "suspended", {}, w.clock.t);
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t); // C381: only an agent's own stop pauses it
  const first = (await run("plan_send", { kind: "person", id: w.ann.id }, ctxOf(w))).plans[0].id;
  await w.tick(first);
  approveAndDeliver(w, String(w.plan(first).draft_key), HENRY);
  await w.tick(first);
  const synced = (status: string) => store.syncAgents(w.db, [{ id: HENRY, name: "Henry", mode: "free", status }, { id: SALES, name: "Sales", mode: "bound", status: "active" }] as never, w.clock.t);
  synced("paused");
  const step = async (id: string) => (await run("plan_get", { plan: id }, ctxOf(w))).plans[0];
  assert.equal((await step(first)).steps[0].text, KEY_STILL_EXISTS);
  w.clock.t += 1000;
  const second = (await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "stop" }] }, ctxOf(w))).plans[0].id;
  await w.tick(second);
  approveAndDeliver(w, String(w.plan(second).draft_key), HENRY);
  await w.tick(second);
  const old = await step(first);
  assert.equal(old.steps[0].text, "Stopped at the bridge.");
  assert.doesNotMatch(String(old.note), /stay paused with the key/);
  // brought back later with a new key, then stopped again by its own stop
  w.clock.t += 1000;
  w.db.prepare("UPDATE fleet_agents SET lifecycle = 'active', lifecycle_at = ? WHERE id = ?").run(w.clock.t, HENRY);
  w.clock.t += 1000;
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t);
  const row = loadColleagues(w.db, w.clock.t).byId.get(`agent:${HENRY}`);
  assert.ok(row?.findings.some((f) => f.code === "key_not_decided"), "the old offboard does not speak for the new key");
  assert.equal(row?.line, KEY_STILL_EXISTS);
});

test("D2 review: a transfer to the current owner is refused; a plan with no Core step still says the keys of paused agents; stop choices pass the cap", async () => {
  const w = makeWorld();
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  await assert.rejects(run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: w.ann.id }] }, ctxOf(w)), refused("input_invalid", 400));
  // C381: only agents with their own stop count: the person leaving is not one
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t);
  set(w.db, "agent", SALES, "suspended", {}, w.clock.t);
  store.syncAgents(w.db, [{ id: HENRY, name: "Henry", mode: "free", status: "paused" }, { id: SALES, name: "Sales", mode: "bound", status: "paused" }] as never, w.clock.t);
  const out = await run("plan_send", { kind: "person", id: w.ann.id }, ctxOf(w));
  assert.equal(out.plans[0].mode, "none");
  await w.tick(out.plans[0].id);
  const view = (await run("plan_get", { plan: out.plans[0].id }, ctxOf(w))).plans[0];
  assert.match(view.note, /2 agents you stopped stay paused with the key/);
  assert.doesNotMatch(view.headline, /^Done/);

  // only an entry new in this window needs the confirm: the owner stopped an hour ago, two others just now, the cap is 2
  const v = makeWorld();
  set(v.db, "person", v.ann.id, "suspended", {}, Date.now() - 3_600_000);
  for (const name of ["P1", "P2"]) set(v.db, "person", store.setPerson(v.db, { name }, v.clock.t).id, "suspended", {}, Date.now());
  v.db.prepare("INSERT INTO fleet_settings (key, value) VALUES ('stop_cap', '2') ON CONFLICT (key) DO UPDATE SET value = '2'").run();
  await assert.rejects(run("plan_send", { kind: "person", id: v.ann.id, decisions: [{ agent: HENRY, decision: "stop" }] }, ctxOf(v)), refused("stop_cap_reached", 409));
  assert.equal(stateOf(v.db, "agent", HENRY), "active");
  const ok = await run("plan_send", { kind: "person", id: v.ann.id, decisions: [{ agent: HENRY, decision: "stop" }], confirmCount: 3 }, ctxOf(v));
  assert.equal(ok.plans.length, 1);
  assert.equal(stateOf(v.db, "agent", HENRY), "leaving");
});

test("D2 review: plan_send when the entry moves during the call to Portal: the owner reads that the old request is gone and no new one was made", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  const real = w.core.withdraw.bind(w.core);
  w.core.withdraw = async (k) => {
    const a = await real(k);
    w.db.prepare("UPDATE fleet_agents SET lifecycle_rev = lifecycle_rev + 1 WHERE id = ?").run(HENRY);
    return a;
  };
  const rev = Number(w.db.prepare("SELECT lifecycle_rev AS r FROM fleet_agents WHERE id = ?").get(HENRY)?.r);
  await assert.rejects(run("plan_send", { kind: "agent", id: HENRY, expectedRev: rev }, ctxOf(w)), (e: TbError) => {
    assert.equal(e.code, "lifecycle_stale");
    assert.match(e.message, /taken back already, and no new one was made/);
    return true;
  });
  assert.equal(w.plan(id).state, "replaced");
});

test("N2-3 (C381): the cap counts a person as one, whatever their agents; an agent's own stop counts as its own entry, once; a blocked verdict counts and needs the same confirm; the banner counts them", async () => {
  const { stopsSince } = await import("../src/lifecycle/events.ts");
  const { recordReview } = await import("../src/reviews.ts");
  const w = makeWorld();
  const { agentId } = await import("./plans-world.ts");
  const many = Array.from({ length: 6 }, (_, i) => agentId(i + 50));
  store.syncAgents(w.db, [...w.db.prepare("SELECT id, name, mode, status FROM fleet_agents").all(), ...many.map((id) => ({ id, name: id, mode: "free", status: "active" }))] as never, w.clock.t);
  for (const id of many) store.setAgent(w.db, { agent: id, owner: w.ann.id }, w.clock.t);
  // Ann owns eight agents, cap 5: the person's stop is one entry, and it needs no confirm (it was 9 before C381)
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  assert.equal(stopsSince(w.db, w.clock.t - 1000), 1);
  // an agent's own stop is its own entry; the same entry again counts once
  set(w.db, "agent", HENRY, "leaving", {}, w.clock.t);
  assert.equal(stopsSince(w.db, w.clock.t - 1000), 2);
  set(w.db, "agent", HENRY, "active", {}, w.clock.t);
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t);
  assert.equal(stopsSince(w.db, w.clock.t - 1000), 2, "each entry once");
  // the agents of a person who stops are no part of the count, kept or not
  const v = makeWorld();
  set(v.db, "person", v.ann.id, "leaving", {}, v.clock.t);
  assert.equal(stopsSince(v.db, v.clock.t - 1000), 1);
  // a blocked verdict is a stop in the floor
  const b = makeWorld();
  const people = Array.from({ length: 5 }, (_, i) => store.setPerson(b.db, { name: `P${i}` }, b.clock.t));
  for (const p of people) set(b.db, "person", p.id, "suspended", {}, b.clock.t);
  const digestOf = async (c: OpContext, id: string): Promise<string> => (await run("review_get", { subject: { kind: "agent", id } }, c)).current.digest;
  const input = { subject: { kind: "agent" as const, id: HENRY }, verdict: "blocked" as const, reason: "Security", snapshotDigest: await digestOf(ctxOf(b), HENRY) };
  assert.throws(() => recordReview(b.db, "per_owner", input, b.clock.t), (e: TbError) => e.code === "stop_cap_reached" && e.details?.count === 6);
  assert.notEqual(b.db.prepare("SELECT trust FROM fleet_agents WHERE id = ?").get(HENRY)?.trust, "blocked");
  recordReview(b.db, "per_owner", { ...input, confirmCount: 6 }, b.clock.t);
  assert.equal(b.db.prepare("SELECT trust FROM fleet_agents WHERE id = ?").get(HENRY)?.trust, "blocked");
  assert.equal(stopsSince(b.db, b.clock.t - 1000), 6);
  // a trusted verdict is no stop
  const c = makeWorld();
  recordReview(c.db, "per_owner", { subject: { kind: "agent", id: SALES }, verdict: "trusted", reason: "ok", snapshotDigest: await digestOf(ctxOf(c), SALES) }, c.clock.t);
  assert.equal(stopsSince(c.db, c.clock.t - 1000), 0);
});

test("N2-3: nobody can confirm for the timer or the old form: a person with many agents still stops while the window has room; past it the timer waits and the form names the page", async () => {
  const { tickDates } = await import("../src/lifecycle/validity.ts");
  const { agentId } = await import("./plans-world.ts");
  const w = makeWorld();
  const many = Array.from({ length: 6 }, (_, i) => agentId(i + 60));
  store.syncAgents(w.db, [...w.db.prepare("SELECT id, name, mode, status FROM fleet_agents").all(), ...many.map((id) => ({ id, name: id, mode: "free", status: "active" }))] as never, w.clock.t);
  for (const id of many) store.setAgent(w.db, { agent: id, owner: w.ann.id }, w.clock.t);
  w.db.prepare("UPDATE fleet_people SET valid_until = ? WHERE id = ?").run(w.clock.t - 1000, w.ann.id);
  const seen = new Set<string>();
  tickDates(w.db, seen, w.clock.t);
  assert.equal(tickDates(w.db, seen, w.clock.t + 60_000).stopped, 1);
  assert.equal(stateOf(w.db, "person", w.ann.id), "suspended");

  const v = makeWorld();
  for (const id of many) {
    store.syncAgents(v.db, [...v.db.prepare("SELECT id, name, mode, status FROM fleet_agents").all(), { id, name: id, mode: "free", status: "active" }] as never, v.clock.t);
    store.setAgent(v.db, { agent: id, owner: v.ann.id }, v.clock.t);
  }
  store.setPerson(v.db, { id: v.ann.id, name: "Ann", status: "departed" }, v.clock.t);
  assert.equal(stateOf(v.db, "person", v.ann.id), "leaving");

  const full = makeWorld();
  for (const name of ["A", "B", "C", "D", "E"]) set(full.db, "person", store.setPerson(full.db, { name }, full.clock.t).id, "suspended", {}, full.clock.t);
  assert.throws(() => store.setPerson(full.db, { id: full.ann.id, name: "Ann", status: "departed" }, full.clock.t), (e: TbError) => e.code === "stop_cap_reached" && /this person's page/.test(e.message));
  assert.equal(stateOf(full.db, "person", full.ann.id), "active");
});

test("N2-1 (C381): a plain owner change from a stopped owner is allowed and shows a finding until the key is replaced; the plan's transfer replaces it with no pause", async () => {
  const { loadColleagues } = await import("../src/lifecycle/view.ts");
  const codes = (w: World, id: string) => loadColleagues(w.db, w.clock.t).byId.get(`agent:${id}`)?.findings.map((f) => f.code) ?? [];
  const w = makeWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  await run("agent_set", { agent: HENRY, owner: bob.id }, ctxOf(w));
  assert.equal(w.db.prepare("SELECT owner_id FROM fleet_agents WHERE id = ?").get(HENRY)?.owner_id, bob.id, "no use_transfer refusal any more");
  assert.equal(stateOf(w.db, "agent", HENRY), "active");
  assert.ok(codes(w, HENRY).includes("key_after_transfer"), "until Core replaced the key");
  // the key goes by a plan on the agent: a rotate, and no pause
  const out = await run("plan_send", { kind: "agent", id: HENRY, transfers: [HENRY] }, ctxOf(w));
  const id = out.plans[0].id;
  w.clock.t = Date.now() + 1000; // the op stamped the change with the real clock
  await w.tick(id);
  assert.deepEqual(w.core.open()[0]?.steps, [{ opId: "agents.rotate", agt: HENRY }]);
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY, SALES);
  await w.tick(id);
  assert.ok(!codes(w, HENRY).includes("key_after_transfer"));
  assert.equal(stateOf(w.db, "agent", HENRY), "active", "the agent worked through it");

  // quiet: first owner, and a change between active owners is allowed, with the finding
  const v = makeWorld();
  const carol = store.setPerson(v.db, { name: "Carol" }, v.clock.t);
  await run("agent_set", { agent: HENRY, owner: carol.id }, ctxOf(v));
  assert.ok(codes(v, HENRY).includes("key_after_transfer"));
  assert.ok(!codes(v, SALES).includes("key_after_transfer"));
  const fresh = makeWorld();
  store.setAgent(fresh.db, { agent: SALES, owner: null }, fresh.clock.t);
  await run("agent_set", { agent: SALES, owner: fresh.ann.id }, ctxOf(fresh));
  assert.ok(!codes(fresh, SALES).includes("key_after_transfer"), "from nobody: no old key holder");
});

test("N3-3: a transferred agent's things stay, ticked or not; N3-9: bringing a person back says the bar stays", async () => {
  const { colleagueDetail } = await import("../src/lifecycle/view.ts");
  const w = makeWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const id = (await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id }], items: [{ product: "connect", id: "account_as_itself:a" }] }, ctxOf(w))).plans[0].id;
  await w.tick(id);
  assert.equal(w.item(id, "account_as_itself:a").state, "listed");
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  await w.tick(id);
  assert.equal(w.connect.data.handled.length, 0);

  const v = makeWorld();
  v.db.prepare("UPDATE fleet_agents SET owner_id = NULL").run();
  v.db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES ('slack:UANN', ?, 1)").run(v.ann.id);
  v.connect.add({ id: "channel_sender:slack:UANN", kind: "channel_sender", subject: { kind: "person", id: v.ann.id }, resource: "slack:UANN", level: "use", label: "Sender" });
  set(v.db, "person", v.ann.id, "leaving", {}, v.clock.t);
  const pid = v.makePlan({ kind: "person", id: v.ann.id });
  await v.tick(pid);
  await run("lifecycle_set", { kind: "person", id: v.ann.id, to: "active", reason: "mistake" }, ctxOf(v));
  const d = await colleagueDetail(ctxOf(v), "person", v.ann.id);
  assert.ok(d.notices.some((n: string) => /sender bar in Connect/.test(n)));
});

test("N2-1 review (C381): a transfer pauses nothing: the agent keeps working and its floor stays false; an agent with its own stop can find an active owner by agent_set", async () => {
  const { directoryFeed } = await import("../src/feed.ts");
  const w = makeWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id }] }, ctxOf(w));
  assert.equal(stateOf(w.db, "agent", HENRY), "active");
  const feed = directoryFeed(w.db, { accept: ["lifecycle"] }) as { agents: { id: string; lifecycle?: string; floor?: boolean }[] };
  assert.deepEqual([feed.agents.find((a) => a.id === HENRY)?.lifecycle, feed.agents.find((a) => a.id === HENRY)?.floor], ["active", false], "not refused: only its key changes");

  const v = makeWorld();
  const carol = store.setPerson(v.db, { name: "Carol" }, v.clock.t);
  set(v.db, "agent", HENRY, "leaving", {}, v.clock.t);
  set(v.db, "person", v.ann.id, "leaving", {}, v.clock.t);
  await run("agent_set", { agent: HENRY, owner: carol.id }, ctxOf(v));
  assert.equal(stateOf(v.db, "agent", HENRY), "leaving", "its own stop stands");
});

test("N3-3 review: an agent both offboarded and rotated is closing: its items end", async () => {
  const w = makeWorld();
  w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY, transfers: [HENRY] });
  await w.tick(id);
  assert.equal(w.item(id, "account_as_itself:a").state, "pending");
});

function withSender(w: World) {
  w.db.prepare("UPDATE fleet_agents SET owner_id = NULL").run();
  w.db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES ('slack:UANN', ?, 1)").run(w.ann.id);
  w.connect.add({ id: "channel_sender:slack:UANN", kind: "channel_sender", subject: { kind: "person", id: w.ann.id }, resource: "slack:UANN", level: "use", label: "Slack sender" });
}

const barPlan = (w: World) => w.db.prepare("SELECT id FROM fleet_plans WHERE purpose = 'bar'").get()?.id as string | undefined;

test("N2-6: the old People form makes no plan: the bar still goes, by the job, with no Core step; the finding shows until Connect proves it", async () => {
  const { loadColleagues } = await import("../src/lifecycle/view.ts");
  const codes = (w: World) => loadColleagues(w.db, w.clock.t).byId.get(`person:${w.ann.id}`)?.findings.map((f) => f.code) ?? [];
  const w = makeWorld();
  withSender(w);
  store.setPerson(w.db, { id: w.ann.id, name: "Ann", status: "departed" }, w.clock.t);
  assert.equal(stateOf(w.db, "person", w.ann.id), "leaving");
  assert.ok(codes(w).includes("sender_bar_open"));
  scanPlans(w.db, w.clock.t, () => {});
  assert.equal(barPlan(w), undefined, "the normal flow has its time first");
  w.clock.t += 21_000;
  scanPlans(w.db, w.clock.t, () => {});
  scanPlans(w.db, w.clock.t, () => {});
  const id = barPlan(w) as string;
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM fleet_plans").get()?.n, 1, "one plan");
  assert.equal(w.plan(id).rail, "none");
  // Connect does not answer: no claim, the finding stays, Close is refused
  w.connect.listScript.push(() => {
    throw new TbError("app_error", "down", 500);
  });
  await w.tick(id);
  assert.ok(codes(w).includes("sender_bar_open"));
  assert.equal(w.plan(id).state, "running");
  w.clock.t += 60_000;
  await w.tick(id);
  assert.deepEqual(w.connect.data.ended, ["channel_sender:slack:UANN"]);
  assert.equal(w.plan(id).state, "done");
  assert.ok(!codes(w).includes("sender_bar_open"), "proved by a fresh list");
  assert.ok(codes(w).includes("leaving_no_plan"), "the bar is not the plan for the agents");
  assert.equal(w.core.data.drafts.length, 0, "nothing in Portal");
});

test("N2-6: a failed plan_send, or a plan the owner made: no second plan; the normal flow bars through its own plan; a plan_send replaces an open bar plan", async () => {
  const w = makeWorld();
  withSender(w);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const own = w.makePlan({ kind: "person", id: w.ann.id });
  w.clock.t += 21_000;
  scanPlans(w.db, w.clock.t, () => {});
  assert.equal(barPlan(w), undefined);
  await w.tick(own);
  assert.deepEqual(w.connect.data.ended, ["channel_sender:slack:UANN"]);

  const v = makeWorld();
  withSender(v);
  set(v.db, "person", v.ann.id, "leaving", {}, v.clock.t);
  v.clock.t += 21_000;
  scanPlans(v.db, v.clock.t, () => {});
  const bar = barPlan(v) as string;
  const out = await run("plan_send", { kind: "person", id: v.ann.id }, ctxOf(v));
  assert.equal(v.plan(bar).state, "replaced");
  assert.equal(out.plans.length, 1);
});

test("N2-6: fire on Close while the bar is open, a named reason passes; quiet: no handles, a migrated person, Connect not installed, an owner who unticked it", async () => {
  const { senderBarOpen } = await import("../src/plans/guards.ts");
  const w = makeWorld();
  withSender(w);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  assert.throws(() => set(w.db, "person", w.ann.id, "archived", { waive: undefined }, w.clock.t + 40 * DAY_MS), refused("sender_bar_open", 409));
  set(w.db, "person", w.ann.id, "archived", { waive: WAIVE }, w.clock.t);
  assert.equal(stateOf(w.db, "person", w.ann.id), "archived");

  const none = makeWorld();
  none.db.prepare("UPDATE fleet_agents SET owner_id = NULL").run();
  set(none.db, "person", none.ann.id, "leaving", {}, none.clock.t);
  none.clock.t += 21_000;
  scanPlans(none.db, none.clock.t, () => {});
  assert.equal(barPlan(none), undefined, "no handle, nothing to bar");
  assert.equal(senderBarOpen(none.db, none.ann.id), false);

  const old = makeWorld();
  withSender(old);
  set(old.db, "person", old.ann.id, "leaving", { reason: "other" }, old.clock.t);
  old.db.prepare("UPDATE fleet_people SET lifecycle_reason = 'migrated' WHERE id = ?").run(old.ann.id);
  old.clock.t += 21_000;
  scanPlans(old.db, old.clock.t, () => {});
  assert.equal(barPlan(old), undefined, "marked before this version: the owner confirms it in a plan");
  assert.equal(senderBarOpen(old.db, old.ann.id), true);

  const gone = makeWorld();
  withSender(gone);
  gone.installed = [];
  set(gone.db, "person", gone.ann.id, "leaving", {}, gone.clock.t);
  await gone.tick(gone.makePlan({ kind: "person", id: gone.ann.id }));
  assert.equal(senderBarOpen(gone.db, gone.ann.id), false, "not installed: nothing reaches an agent through it");

  const un = makeWorld();
  withSender(un);
  set(un.db, "person", un.ann.id, "leaving", {}, un.clock.t);
  await un.tick(un.makePlan({ kind: "person", id: un.ann.id, items: [] }));
  assert.equal(senderBarOpen(un.db, un.ann.id), false, "his choice, and the step says it stays");
});

test("N2-6 review: a sender step that cannot be ended keeps the finding; a stale bar plan is made again; the record says the system made it, with no alert about a date", async () => {
  const { senderBarOpen } = await import("../src/plans/guards.ts");
  const w = makeWorld();
  withSender(w);
  (w.connect.data.rows[0] as { revocable?: boolean }).revocable = false;
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  w.clock.t += 21_000;
  scanPlans(w.db, w.clock.t, () => {});
  const id = barPlan(w) as string;
  await w.tick(id);
  assert.equal(w.item(id, "channel_sender:slack:UANN").state, "manual");
  assert.equal(senderBarOpen(w.db, w.ann.id), true, "a step someone must do by hand bars nobody yet");
  assert.equal(w.inbox.asks.length, 0, "the bar plan is no date alert");
  const row = w.db.prepare("SELECT actor_kind, note FROM fleet_lifecycle_events WHERE plan_id = ? ORDER BY seq LIMIT 1").get(id);
  assert.equal(row?.actor_kind, "system");
  assert.match(String(row?.note), /sender bar only/);

  const v = makeWorld();
  withSender(v);
  set(v.db, "person", v.ann.id, "leaving", {}, v.clock.t);
  v.clock.t += 21_000;
  scanPlans(v.db, v.clock.t, () => {});
  const first = barPlan(v) as string;
  v.db.prepare("UPDATE fleet_people SET lifecycle_rev = lifecycle_rev + 1 WHERE id = ?").run(v.ann.id);
  await v.tick(first);
  assert.equal(v.plan(first).state, "stale");
  v.clock.t += 60_000;
  scanPlans(v.db, v.clock.t, () => {});
  assert.equal(v.db.prepare("SELECT COUNT(*) AS n FROM fleet_plans WHERE purpose = 'bar'").get()?.n, 2);
});

test("B10: a second plan_send carries the earlier new-key step: the agent already moved, so only the older plan knew; the draft asks for it again", async () => {
  const w = makeWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const first = (await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id }] }, ctxOf(w))).plans[0].id;
  await w.tick(first);
  const out = await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: SALES, decision: "stop" }] }, ctxOf(w));
  assert.equal(w.plan(first).state, "replaced");
  await w.tick(out.plans[0].id);
  const steps = w.core.open()[0]?.steps.map((s) => `${s.opId} ${s.agt}`).sort();
  assert.deepEqual(steps, [`agents.offboard ${SALES}`, `agents.rotate ${HENRY}`].sort(), "C381: the transfer has no pause");
  // a rotate already done is not asked for again
  const v = makeWorld();
  const carol = store.setPerson(v.db, { name: "Carol" }, v.clock.t);
  set(v.db, "person", v.ann.id, "leaving", {}, v.clock.t);
  const p1 = (await run("plan_send", { kind: "person", id: v.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: carol.id }] }, ctxOf(v))).plans[0].id;
  await v.tick(p1);
  approveAndDeliver(v, String(v.plan(p1).draft_key), HENRY, SALES);
  await v.tick(p1);
  assert.equal(v.plan(p1).state, "done");
  const p2 = (await run("plan_send", { kind: "person", id: v.ann.id, decisions: [{ agent: SALES, decision: "stop" }] }, ctxOf(v))).plans[0].id;
  await v.tick(p2);
  assert.deepEqual(v.core.open()[0]?.steps, [{ opId: "agents.offboard", agt: SALES }]);
});

test("N2-2: the feed sends one epoch to a reader of the lifecycle, on full, unchanged and empty answers; a restore replaces it; a fresh install has its own; a reader that does not ask gets none", async () => {
  const { directoryFeed } = await import("../src/feed.ts");
  const { migratedDb } = await import("./helpers.ts");
  const w = makeWorld();
  const full = directoryFeed(w.db, { accept: ["lifecycle"] }) as { epoch: string; revision: number };
  assert.match(full.epoch, /^[A-Za-z0-9_-]{1,64}$/);
  const same = directoryFeed(w.db, { accept: ["lifecycle"], sinceRevision: full.revision }) as { epoch: string; unchanged: boolean };
  assert.equal(same.unchanged, true);
  assert.equal(same.epoch, full.epoch);
  assert.equal("epoch" in directoryFeed(w.db, {}), false);
  const other = migratedDb();
  const empty = directoryFeed(other, { accept: ["lifecycle"] }) as { epoch: string; agents: unknown[] };
  assert.equal(empty.agents.length, 0);
  assert.notEqual(empty.epoch, full.epoch, "a fresh install is another origin");
  // the output schema of the op takes it
  const spec = manifest.operations.find((o) => o.id === "directory_feed") as unknown as { output: Parameters<typeof validateAgainstSchema>[0] };
  assert.deepEqual(validateAgainstSchema(spec.output, full as never).ok, true);
  assert.deepEqual(validateAgainstSchema(spec.output, same as never).ok, true);
  // a restore: the SDK's mark is new. The first read after it, before any boot code, has a new epoch. The file's revision can be the same
  w.db.exec("CREATE TABLE IF NOT EXISTS tb_meta (key TEXT PRIMARY KEY, value TEXT)");
  w.db.prepare("INSERT INTO tb_meta (key, value) VALUES ('restore_applied', 'archive-1')").run();
  const after = directoryFeed(w.db, { accept: ["lifecycle"], sinceRevision: full.revision }) as { epoch: string };
  assert.notEqual(after.epoch, full.epoch);
  const stable = directoryFeed(w.db, { accept: ["lifecycle"] }) as { epoch: string };
  assert.equal(stable.epoch, after.epoch, "once per restore");
  // restoring the same archive again brings back the older restore_seen, so it counts again
  w.db.prepare("DELETE FROM fleet_settings WHERE key = 'restore_seen'").run();
  assert.notEqual((directoryFeed(w.db, { accept: ["lifecycle"] }) as { epoch: string }).epoch, after.epoch);
});

test("N2-2: after a Governance that went back, the page says what Rules still holds", async () => {
  const { floorView } = await import("../src/lifecycle/floor.ts");
  const read = { version: "0.7.0-dev.3", feedRevision: 9, entries: 3, lastGateAt: null };
  assert.match(String(floorView({ ...read, unlisted: 2 }, 1, 0, false).rulesHolds), /Rules still holds 2 entries Governance does not list\. They still refuse calls\. Clear them on the Rules page\./);
  assert.equal(floorView({ ...read, unlisted: 2 }, 1, 0, false).gateNote, null, "not the gate's sentence: the page reads that one as a stale gate");
  assert.equal(floorView({ ...read, unlisted: 0 }, 1, 0, false).rulesHolds, null);
  assert.equal(floorView(read, 1, 0, false).rulesHolds, null);
});

test("the owed new key: from a plan that ended too; not for a closed or removed card, which must not block the entry", async () => {
  const w = makeWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const first = (await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id }] }, ctxOf(w))).plans[0].id;
  await w.tick(first);
  w.core.reject(String(w.plan(first).draft_key));
  await w.tick(first);
  assert.equal(w.plan(first).state, "rejected");
  const next = (await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: SALES, decision: "stop" }] }, ctxOf(w))).plans[0].id;
  await w.tick(next);
  assert.deepEqual(w.core.open()[0]?.steps.map((s) => `${s.opId} ${s.agt}`).sort(), [`agents.offboard ${SALES}`, `agents.rotate ${HENRY}`].sort());
  // the card is gone: the entry can still make a plan, and no step names it
  await run("plan_cancel", { plan: next }, ctxOf(w));
  w.db.prepare("UPDATE fleet_agents SET status = 'removed' WHERE id = ?").run(HENRY);
  const third = (await run("plan_send", { kind: "person", id: w.ann.id }, ctxOf(w))).plans[0].id;
  assert.ok(!w.steps(third).some((s) => s.agent_id === HENRY));
});
