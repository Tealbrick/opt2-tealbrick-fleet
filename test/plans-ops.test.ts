// The plan ops and the lifecycle's use of them, over the same world as the runner tests. Rows: A7, A10, A11, A35 (open plan), A38, A46.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json, OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../src/app.ts";
import { DAY_MS } from "../src/lifecycle/transitions.ts";
import { scanPlans } from "../src/plans/control.ts";
import { getPlan } from "../src/plans/plan.ts";
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

test("a T6 refused by its own guard takes nothing back", async () => {
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  w.db.prepare("UPDATE fleet_agents SET owner_id = NULL WHERE id = ?").run(HENRY);
  await assert.rejects(run("lifecycle_set", { kind: "agent", id: HENRY, to: "active", reason: "mistake" }, ctxOf(w)), refused("owner_required", 409));
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(w.core.open().length, 1);
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
  const id = w.makePlan({ kind: "person", id: w.ann.id, actor: OWNER });
  assert.equal(w.plan(id).actor_id, OWNER.id);
  await w.tick(id);
  w.db.prepare("UPDATE fleet_agents SET lifecycle_rev = lifecycle_rev + 1 WHERE id = ?").run(SALES);
  await w.tick(id);
  assert.equal(w.plan(id).state, "waiting");
});

test("T7: a person cannot close while a Connect account has no person, until the owner names it", async () => {
  const w = makeWorld();
  w.db.prepare("UPDATE fleet_agents SET owner_id = NULL").run();
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  w.db.prepare("INSERT INTO fleet_access_items (target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, since, digest, first_seen, last_seen) VALUES ('connect', 'account_as_me:acc', 'account_as_me', 'unlinked', NULL, 'acc', 'held_by', 'use', 'Mail', 'active', 0, NULL, 'd', 1, 1)").run();
  assert.throws(() => set(w.db, "person", w.ann.id, "archived", { waive: WAIVE }, w.clock.t), refused("unlinked_accounts", 409));
  w.db.prepare("INSERT INTO fleet_exceptions (code, subject_kind, subject_id, reason, until, by_id, at) VALUES ('unlinked_account', 'item', 'connect:account_as_me:acc', 'Mine, not hers', ?, NULL, 1)").run(w.clock.t + 1000);
  set(w.db, "person", w.ann.id, "archived", { waive: WAIVE }, w.clock.t);
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
