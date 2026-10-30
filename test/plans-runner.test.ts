// The plan runner against a fake rail and fake stores (see plans-fakes.ts). Nothing inside the runner is mocked: real SQLite, real lifecycle setter, real port.
// C380 rows: A1 (client side), A7, A7b, A10, A34, A46. The rule under test: nothing is done until proved by its owner.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { proveCoreStep } from "../src/plans/core-rail.ts";
import { MAX_TRIES } from "../src/plans/steps.ts";
import * as store from "../src/store.ts";
import { set } from "./lifecycle-helpers.ts";
import { agentItem, approveAndDeliver, HENRY, leave, makeWorld, runDue, SALES, type World } from "./plans-world.ts";

const account = (w: World, id = "account_as_itself:acc1", agent = HENRY) => w.connect.add(agentItem({ id, kind: "account_as_itself", agent }));
const routine = (w: World, id = "routine:r1", agent = HENRY) => w.evolution.add(agentItem({ id, kind: "routine", agent, paused: false }));

async function leavingPlan(w: World): Promise<string> {
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  return id;
}
const keyOf = (w: World, id: string) => String(w.plan(id).draft_key);

test("a firing: nothing stops at the app until the owner approves; done only after the slice and a fresh list prove it", async () => {
  const w = makeWorld();
  account(w);
  routine(w);
  const id = await leavingPlan(w);

  // asked, never named: the draft says nothing about who or why
  const d = w.core.open()[0];
  assert.ok(d);
  assert.equal(d.title, "Governance: stop request");
  assert.deepEqual(d.steps, [{ opId: "agents.offboard", agt: HENRY }]);
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(w.connect.data.handled.length, 0, "no app step before the approval");
  assert.equal(w.item(id, "account_as_itself:acc1").state, "pending");
  assert.match(String(w.plan(id).plan_digest), /^sha256:[0-9a-f]{64}$/);

  // Core applied, the slice has not arrived: Core's word is not a proof
  w.core.apply(keyOf(w, id));
  await w.tick(id);
  const core = () => w.steps(id).find((s) => s.phase === "core") as Record<string, unknown>;
  assert.equal(core().state, "pending_bridge");
  assert.notEqual(w.plan(id).state, "done");
  assert.equal(w.connect.data.handled.length, 0, "no store step for an agent the slice does not show stopped");

  // The slice arrives at Fleet, not yet at Connect: the store refuses on its own copy and the step waits
  w.core.deliver();
  await w.tick(id);
  assert.equal(core().state, "done");
  assert.equal(w.item(id, "account_as_itself:acc1").state, "not_revocable");
  assert.equal(w.item(id, "account_as_itself:acc1").code, "agent_running");
  assert.equal(w.connect.data.ended.length, 0);

  w.connect.sees(HENRY, "paused");
  w.evolution.sees(HENRY, "paused");
  await w.tick(id);
  assert.equal(w.item(id, "account_as_itself:acc1").state, "done");
  assert.equal(w.item(id, "routine:r1").state, "done");
  assert.equal(w.plan(id).state, "done");
  assert.equal(w.plan(id).receipt_id, `rcp_${w.core.data.drafts[0]?.id}`);
});

test("guard, quiet: the keys meet the contract's patterns", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  assert.match(id, /^pln_[0-9A-Za-z]{1,40}$/);
  assert.match(keyOf(w, id), /^pln_[A-Za-z0-9._:-]{1,124}$/);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  await w.tick(id);
  assert.match(String(w.item(id, "account_as_itself:acc1").key), /^[A-Za-z0-9._:-]{8,128}$/);
  assert.match(String(w.item(id, "account_as_itself:acc1").key), new RegExp(`^${id}:connect:\\d+:\\d+$`));
});

test("A7b: an item `failed` at 200 is not replayed: re-list, new attempt with a new key, no double action", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.connect.revokeScript.push({ kind: "fail_item", code: "provider_error" });
  await w.tick(id);
  const first = w.item(id, "account_as_itself:acc1");
  assert.equal(first.state, "failed");
  assert.equal(first.code, "provider_error");
  assert.notEqual(w.plan(id).state, "done");
  w.clock.t += 60_000;
  await w.tick(id);
  const second = w.item(id, "account_as_itself:acc1");
  assert.equal(second.state, "done");
  assert.notEqual(second.key, first.key, "the same key would replay the failure for 24 hours");
  assert.equal(second.attempt, 2);
  assert.deepEqual(w.connect.data.ended, ["account_as_itself:acc1"]);
  assert.equal(w.plan(id).state, "done");
});

test("A7b: a lost answer: the store ended it, the next list proves it, and no second call goes out", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.connect.revokeScript.push({ kind: "lose_answer" });
  await w.tick(id);
  // The second pass of the same tick already lists: absent proves it.
  assert.equal(w.item(id, "account_as_itself:acc1").state, "done");
  assert.equal(w.connect.data.handled.length, 1);
  assert.equal(w.plan(id).state, "done");
});

test("A7b: the store died mid-revoke with the effect not done: `unknown` under the old key; re-list shows it; new attempt ends it", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.connect.revokeScript.push({ kind: "crash_before" });
  await w.tick(id);
  const after = w.item(id, "account_as_itself:acc1");
  assert.ok(["sending", "failed"].includes(String(after.state)), String(after.state));
  assert.equal(w.connect.data.ended.length, 0);
  // the old key now answers 409 unknown for ever; a new attempt has its own
  const oldKey = String(after.key);
  assert.equal(w.connect.data.idem[oldKey]?.kind, "unknown");
  w.clock.t += 60_000;
  await w.tick(id);
  assert.equal(w.item(id, "account_as_itself:acc1").state, "done");
  assert.notEqual(w.item(id, "account_as_itself:acc1").key, oldKey);
  assert.deepEqual(w.connect.data.ended, ["account_as_itself:acc1"]);
});

test("failure map: idempotency_outcome_unknown and idempotency_in_flight re-list and take a new attempt", async () => {
  for (const code of ["idempotency_outcome_unknown", "idempotency_in_flight"]) {
    const w = makeWorld();
    account(w);
    const id = await leavingPlan(w);
    approveAndDeliver(w, keyOf(w, id), HENRY);
    w.connect.revokeScript.push({ kind: "throw", code, status: 409 });
    await w.tick(id);
    assert.equal(w.item(id, "account_as_itself:acc1").code, code);
    w.clock.t += 60_000;
    await w.tick(id);
    assert.equal(w.item(id, "account_as_itself:acc1").state, "done", code);
    assert.equal(w.item(id, "account_as_itself:acc1").attempt, 2);
  }
});

test("failure map: idempotency_conflict is a bug: surfaced, stuck, no retry by the job", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.connect.revokeScript.push({ kind: "throw", code: "idempotency_conflict", status: 409 });
  await w.tick(id);
  assert.equal(w.item(id, "account_as_itself:acc1").code, "idempotency_conflict");
  assert.equal(w.item(id, "account_as_itself:acc1").state, "failed");
  assert.equal(w.plan(id).state, "partial");
  const handled = w.connect.data.handled.length;
  w.clock.t += 60_000;
  await w.tick(id);
  assert.equal(w.connect.data.handled.length, handled, "the job leaves it alone");
  assert.equal(w.plan(id).state, "partial");
});

test("failure map: 429 waits for Retry-After, then goes on", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.connect.revokeScript.push({ kind: "throw", code: "rate_limited", status: 429, details: { retryAfterMs: 600_000 } });
  await w.tick(id);
  const handled = w.connect.data.handled.length;
  w.clock.t += 60_000;
  await w.tick(id);
  assert.equal(w.connect.data.handled.length, handled, "still inside Retry-After");
  w.clock.t += 600_000;
  await w.tick(id);
  assert.equal(w.item(id, "account_as_itself:acc1").state, "done");
});

test("A7: a Rules deny: `refused` with the reason, plan partial, nothing retried until Try again", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.connect.revokeScript.push({ kind: "deny" });
  await w.tick(id);
  const s = w.item(id, "account_as_itself:acc1");
  assert.equal(s.state, "refused");
  assert.equal(s.code, "hook_denied");
  assert.match(String(s.detail), /Refused by a rule/);
  assert.equal(w.plan(id).state, "partial");
  w.clock.t += 60_000;
  await w.tick(id);
  assert.equal(w.item(id, "account_as_itself:acc1").state, "refused", "no retry by itself");
  assert.equal(w.connect.data.ended.length, 0);
});

test("held: the step keeps its key, one hold however many ticks; approve runs under that key; deny is refused", async () => {
  for (const decision of ["approved", "denied"] as const) {
    const w = makeWorld();
    account(w);
    const id = await leavingPlan(w);
    approveAndDeliver(w, keyOf(w, id), HENRY);
    w.connect.revokeScript.push({ kind: "hold" });
    await w.tick(id);
    const held = w.item(id, "account_as_itself:acc1");
    assert.equal(held.state, "waiting");
    for (let i = 0; i < 3; i++) {
      w.clock.t += 301_000;
      await w.tick(id);
    }
    assert.equal(Object.keys(w.connect.data.holds).length, 1, "never a new hold per tick");
    assert.equal(w.item(id, "account_as_itself:acc1").key, held.key);
    assert.equal(w.item(id, "account_as_itself:acc1").state, "waiting");
    w.connect.data.holds.hld_1 = decision;
    w.clock.t += 301_000;
    await w.tick(id);
    if (decision === "approved") {
      assert.equal(w.item(id, "account_as_itself:acc1").state, "done");
      assert.equal(w.item(id, "account_as_itself:acc1").key, held.key);
    } else {
      assert.equal(w.item(id, "account_as_itself:acc1").state, "refused");
      assert.equal(w.item(id, "account_as_itself:acc1").code, "hold_denied");
    }
  }
});

test("a store that lies: 'revoked' but still listed is `failed`, stops after the limit, and the plan never reads done", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  for (let i = 0; i < 20; i++) w.connect.revokeScript.push({ kind: "lie" });
  for (let i = 0; i < 12; i++) {
    await w.tick(id);
    w.clock.t += 60_000;
  }
  const s = w.item(id, "account_as_itself:acc1");
  assert.equal(s.state, "failed");
  assert.equal(s.code, "still_listed");
  assert.equal(s.tries, MAX_TRIES);
  assert.equal(w.connect.data.handled.length, MAX_TRIES, "at most the limit");
  assert.equal(w.plan(id).state, "partial");
});

test("false proof: an account row that reads `paused` because its AGENT is paused is not an ended account", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.connect.revokeScript.push({ kind: "lie" });
  await w.tick(id);
  // The list says `paused` for this row: Connect's item state follows the agent.
  assert.notEqual(w.item(id, "account_as_itself:acc1").state, "done");
  assert.notEqual(w.plan(id).state, "done");
});

test("a routine ends by pause: the row stays, `paused` proves it; one already paused needs no call", async () => {
  const w = makeWorld();
  routine(w, "routine:r1");
  w.evolution.add(agentItem({ id: "routine:r2", kind: "routine", paused: true }));
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  await w.tick(id);
  assert.equal(w.item(id, "routine:r1").state, "done");
  assert.equal(w.item(id, "routine:r2").state, "done");
  assert.equal(w.item(id, "routine:r2").code, "already_gone");
  assert.deepEqual(w.evolution.data.ended, ["routine:r1"]);
});

test("a store not read is never zero: `not_read`, the plan stays open, and it finishes when the store answers", async () => {
  const w = makeWorld();
  account(w);
  const failing = () => {
    throw new TbError("no_grant", "no grant", 403);
  };
  w.connect.listScript.push(failing);
  const id = await leavingPlan(w);
  const read = () => w.steps(id).find((s) => s.phase === "read" && s.target === "connect") as Record<string, unknown>;
  assert.equal(read().state, "not_read");
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.connect.listScript.push(failing);
  await w.tick(id);
  assert.equal(read().state, "not_read");
  assert.equal(w.plan(id).state, "running", "Core is done; a store that was not read keeps the plan open");
  w.clock.t += 60_000;
  await w.tick(id);
  assert.equal(read().state, "done");
  assert.equal(w.item(id, "account_as_itself:acc1").state, "done");
  assert.equal(w.plan(id).state, "done");
});

test("a store that stops answering after the first read is `not_read` again: what it said before does not finish the plan", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  assert.equal((w.steps(id).find((s) => s.phase === "read" && s.target === "connect") as Record<string, unknown>).state, "done");
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.connect.listScript.push(() => {
    throw new TbError("app_error", "down", 500);
  });
  await w.tick(id);
  assert.equal((w.steps(id).find((s) => s.phase === "read" && s.target === "connect") as Record<string, unknown>).state, "not_read");
  assert.notEqual(w.plan(id).state, "done");
});

test("not installed is a plain fact, apart from not read", async () => {
  const w = makeWorld();
  w.installed = ["connect"];
  account(w);
  const id = await leavingPlan(w);
  const read = (t: string) => (w.steps(id).find((s) => s.phase === "read" && s.target === t) as Record<string, unknown>).state;
  assert.equal(read("knowledge"), "not_installed");
  assert.equal(read("connect"), "done");
});

test("a page that never ends is no read: a store cannot answer nextCursor for ever", async () => {
  const w = makeWorld();
  const real = w.connect.list.bind(w.connect);
  w.connect.list = (input) => {
    const out = real(input);
    (out.output as { nextCursor: string | null }).nextCursor = "0";
    return out;
  };
  account(w);
  const id = await leavingPlan(w);
  const read = w.steps(id).find((s) => s.phase === "read" && s.target === "connect") as Record<string, unknown>;
  assert.equal(read.state, "not_read");
  assert.equal(read.code, "too_many_pages");
});

test("items of someone we did not ask about are dropped", async () => {
  const w = makeWorld();
  const real = w.connect.list.bind(w.connect);
  w.connect.list = (i) => {
    real(i);
    return real({ subjects: [{ kind: "agent", id: SALES }] });
  };
  account(w, "account_as_itself:other", SALES);
  const id = await leavingPlan(w);
  assert.equal(w.item(id, "account_as_itself:other"), undefined);
});

test("A10: the digest changed since the preview: `changed`, no call; a change after the first read also stops it", async () => {
  const w = makeWorld();
  const row = account(w);
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY, items: [{ product: "connect", id: row.id, digest: "sha256:seen-before" }] });
  await w.tick(id);
  assert.equal(w.item(id, row.id).state, "changed");
  assert.equal(w.item(id, row.id).code, "changed_since_preview");

  const v = makeWorld();
  const row2 = account(v);
  const pid = await leavingPlan(v);
  row2.resource = "another_account"; // same id, other identity
  approveAndDeliver(v, keyOf(v, pid), HENRY);
  await v.tick(pid);
  assert.equal(v.item(pid, row2.id).state, "changed");
  assert.equal(v.connect.data.ended.length, 0);
  assert.equal(v.plan(pid).state, "partial");
});

test("ticks: `about` is off by default; a suspension keeps accounts and ends routines and posts; the owner's ticks win", async () => {
  const w = makeWorld();
  account(w);
  routine(w);
  w.connect.add(agentItem({ id: "scheduled_post:p1", kind: "scheduled_post" }));
  w.knowledge.add(agentItem({ id: "team_grant:t1", kind: "team_grant", direction: "about" }));
  w.connect.add(agentItem({ id: "buzz_identity:b1", kind: "buzz_identity", level: "info", revocable: false }));
  w.evolution.add(agentItem({ id: "workflow_agent_step:s1", kind: "workflow_agent_step", revocable: false }));
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  assert.deepEqual(w.core.open()[0]?.steps, [{ opId: "agents.pause", agt: HENRY }]);
  const state = (i: string) => w.item(id, i).state;
  assert.equal(state("account_as_itself:acc1"), "listed");
  assert.equal(state("team_grant:t1"), "listed");
  assert.equal(state("routine:r1"), "pending");
  assert.equal(state("scheduled_post:p1"), "pending");
  assert.equal(state("buzz_identity:b1"), "listed");
  assert.equal(state("workflow_agent_step:s1"), "manual", "someone acts by hand");
});

test("stale: the subject moved after the owner confirmed: no app step, the draft is withdrawn, the plan says so", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  assert.equal(w.core.open().length, 1);
  set(w.db, "agent", HENRY, "active", {}, w.clock.t);
  await w.tick(id);
  assert.equal(w.plan(id).state, "stale");
  assert.equal(w.core.open().length, 0);
  assert.equal(w.item(id, "account_as_itself:acc1").state, "cancelled");
  assert.equal(w.connect.data.handled.length, 0);
});

test("stale after apply: Core's stop stays, no app step runs", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.db.prepare("UPDATE fleet_agents SET lifecycle_rev = lifecycle_rev + 1 WHERE id = ?").run(HENRY);
  await w.tick(id);
  assert.equal(w.plan(id).state, "stale");
  assert.equal(w.connect.data.handled.length, 0);
});

test("A10: expiry: Core refuses the apply, the plan expires, steps are cancelled, the owner is told once", async () => {
  const w = makeWorld();
  account(w);
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY, expiresInSec: 120 });
  await w.tick(id);
  w.clock.t += 121_000;
  assert.throws(() => w.core.apply(keyOf(w, id)), (e: TbError) => e.code === "draft_state" && e.details?.reason === "expired");
  await w.tick(id);
  assert.equal(w.plan(id).state, "expired");
  assert.equal(w.item(id, "account_as_itself:acc1").state, "cancelled");
  assert.equal(w.inbox.asks.length, 1);
  assert.match(w.inbox.asks[0]?.title ?? "", /expired/);
  assert.equal((await w.tick(id)).open, false);
  assert.equal(w.inbox.asks.length, 1);
});

test("rejected in Portal: nothing runs after it", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  w.core.reject(keyOf(w, id));
  await w.tick(id);
  assert.equal(w.plan(id).state, "rejected");
  assert.equal(w.item(id, "account_as_itself:acc1").state, "cancelled");
  assert.equal(w.connect.data.handled.length, 0);
});

test("Core answers about other steps, or with another digest: the plan stops and proves nothing", async () => {
  for (const lie of ["digest", "steps"] as const) {
    const w = makeWorld();
    account(w);
    const id = await leavingPlan(w);
    await w.tick(id); // first read stores Core's digest
    approveAndDeliver(w, keyOf(w, id), HENRY);
    w.core.lieGet = lie;
    await w.tick(id);
    assert.equal(w.plan(id).state, "failed", lie);
    assert.equal(w.plan(id).code, "core_mismatch");
    assert.equal(w.connect.data.handled.length, 0);
  }
});

test("S2-5: no topology or a cut one: Core's word stays `reported`, never done; the plan says so and can end", async () => {
  for (const off of ["none", "cut"] as const) {
    const w = makeWorld();
    const id = await leavingPlan(w);
    if (off === "none") w.core.topologyOn = false;
    else w.core.truncated = true;
    approveAndDeliver(w, keyOf(w, id), HENRY);
    await w.tick(id);
    const core = w.steps(id).find((s) => s.phase === "core") as Record<string, unknown>;
    assert.equal(core.state, "reported", off);
    assert.match(String(core.detail), /Core says removed 2 app access and 1 connections/);
    assert.equal(w.plan(id).state, "reported");
  }
});

test("proof: paused comes from the slice alone; an offboard with the agent not paused in the slice is not proved even by a clean topology", () => {
  const view = (paused: boolean, edges: number, rev: number | null) => ({
    paused: () => paused,
    revision: () => rev,
    topology: () => ({ instances: [], companions: [], connections: [], edges: Array.from({ length: edges }, () => ({ agent: "a", ins: "i", product: "p", crud: [], mode: "free" as const, held: [] })) }),
  });
  assert.equal(proveCoreStep("agents.pause", "a", { configRevision: 9 }, view(true, 5, null)).state, "done");
  assert.equal(proveCoreStep("agents.pause", "a", { configRevision: 9 }, view(false, 0, 99)).state, "pending_bridge");
  assert.equal(proveCoreStep("agents.offboard", "a", { configRevision: 9 }, view(false, 0, 99)).state, "pending_bridge");
  assert.equal(proveCoreStep("agents.offboard", "a", { configRevision: 9 }, view(true, 1, null)).state, "pending_bridge");
  assert.equal(proveCoreStep("agents.offboard", "a", { configRevision: 9 }, view(true, 0, null)).state, "done");
  // a slice revision at or above the step's is the delivery proof, when the SDK can read it
  assert.equal(proveCoreStep("agents.offboard", "a", { configRevision: 9 }, view(true, 1, 9)).state, "done");
  assert.equal(proveCoreStep("agents.offboard", "a", { configRevision: 9 }, view(true, 1, 8)).state, "pending_bridge");
  // no output: Portal link mode. Core said nothing
  assert.equal(proveCoreStep("agents.offboard", "a", undefined, view(false, 0, null)).state, "pending");
});

test("S2-11: an apply stuck in `applying`: Portal stopped mid-way is said, then Core's sweep fails it, the owner re-applies, steps that ran stay", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  w.core.apply(keyOf(w, id), { stopMidWay: true });
  await w.tick(id);
  assert.equal(w.plan(id).state, "applying");
  assert.equal(w.connect.data.handled.length, 0);
  w.clock.t += 121_000;
  await w.tick(id);
  assert.equal(w.plan(id).state, "partial");
  assert.equal(w.plan(id).code, "core_failed");
  assert.equal(w.connect.data.handled.length, 0, "failed is not applied");
  approveAndDeliver(w, keyOf(w, id), HENRY);
  await w.tick(id);
  assert.equal(w.item(id, "account_as_itself:acc1").state, "done");
  assert.equal(w.plan(id).state, "done");
});

test("a Core step failed for one agent: the others ran; partial, named, no app step; the owner re-applies", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  w.core.failStep = "agents.offboard";
  w.core.apply(keyOf(w, id));
  await w.tick(id);
  const core = () => w.steps(id).find((s) => s.phase === "core") as Record<string, unknown>;
  assert.equal(core().state, "failed");
  assert.equal(core().code, "agent_offboarded");
  assert.equal(w.plan(id).state, "partial");
  assert.equal(w.connect.data.handled.length, 0);
  w.core.failStep = null;
  approveAndDeliver(w, keyOf(w, id), HENRY);
  await w.tick(id);
  assert.equal(core().state, "done");
  assert.equal(w.plan(id).state, "done");
});

test("the rail is off (no flag, no cap, no SDK member) or no consent: Portal link mode; proof from the slice; Core's word never appears", async () => {
  const cases: [string, (w: World) => void, string][] = [
    ["flag off", (w) => { w.core.flag = false; }, "rail_off"],
    ["no consent", (w) => { w.core.consent = false; }, "topology_consent"],
    ["no sdk member", (w) => { w.pc.rail = null; }, "no_sdk"],
  ];
  for (const [name, setup, code] of cases) {
    const w = makeWorld();
    account(w);
    leave(w);
    setup(w);
    const id = w.makePlan({ kind: "agent", id: HENRY });
    await w.tick(id);
    assert.equal(w.plan(id).rail, "portal_link", name);
    assert.equal(w.plan(id).rail_code, code);
    assert.equal(w.plan(id).state, "waiting");
    assert.equal(w.core.data.drafts.length, 0);
    assert.equal(w.connect.data.handled.length, 0, "no store step while the agent runs");
    // the owner acts in Portal
    w.core.pauseInPortal(HENRY);
    const a = w.core.data.agents[HENRY];
    if (a) { a.edges = 0; a.keys = 0; }
    w.core.deliver();
    w.connect.sees(HENRY, "paused");
    await w.tick(id);
    assert.equal((w.steps(id).find((s) => s.phase === "core") as Record<string, unknown>).state, "done");
    assert.equal(w.item(id, "account_as_itself:acc1").state, "done");
    assert.equal(w.plan(id).state, "done");
  }
});

test("Portal link mode with no topology: the pause is seen, the removal is `not_provable`, never done", async () => {
  const w = makeWorld();
  leave(w);
  w.core.consent = false;
  w.core.topologyOn = false;
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  await w.tick(id);
  assert.equal((w.steps(id).find((s) => s.phase === "core") as Record<string, unknown>).state, "pending");
  w.core.pauseInPortal(HENRY);
  w.core.deliver();
  await w.tick(id);
  assert.equal((w.steps(id).find((s) => s.phase === "core") as Record<string, unknown>).state, "not_provable");
  assert.equal(w.plan(id).state, "reported");
});

test("owner_drafts_full and an outage wait: the plan stays preparing with the key kept, and a later tick asks again", async () => {
  const w = makeWorld();
  leave(w);
  w.core.down = true;
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  assert.equal(w.plan(id).state, "preparing");
  assert.equal(w.plan(id).code, "portal_unavailable");
  const key = keyOf(w, id);
  w.core.down = false;
  w.clock.t += 60_000;
  await w.tick(id);
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(keyOf(w, id), key);
});

test("a lost answer to the draft request: the same key answers the same draft, no second draft", async () => {
  const w = makeWorld();
  leave(w);
  w.core.loseNextAnswer = true;
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  assert.equal(w.plan(id).state, "preparing");
  assert.equal(w.core.data.requests, 1);
  w.clock.t += 60_000;
  await w.tick(id);
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(w.core.data.requests, 1, "one draft for the owner to read");
  assert.equal(w.core.open().length, 1);
});

test("a core key Core no longer knows (Core restored): `lost`, not done; after an apply we saw, the slice proves the rest", async () => {
  const w = makeWorld();
  const id = await leavingPlan(w);
  w.core.data.drafts = [];
  await w.tick(id);
  assert.equal(w.plan(id).state, "lost");

  const v = makeWorld();
  const pid = await leavingPlan(v);
  v.core.apply(keyOf(v, pid));
  await v.tick(pid);
  assert.equal((v.steps(pid).find((s) => s.phase === "core") as Record<string, unknown>).state, "pending_bridge");
  v.core.data.drafts = [];
  await v.tick(pid);
  assert.equal(v.plan(pid).rail, "portal_link");
  assert.notEqual(v.plan(pid).state, "done");
  v.core.deliver();
  await v.tick(pid);
  assert.equal(v.plan(pid).state, "done");
});

test("the rail goes off after the draft: link mode, no claim", async () => {
  const w = makeWorld();
  const id = await leavingPlan(w);
  w.core.flag = false;
  await w.tick(id);
  assert.equal(w.plan(id).rail, "portal_link");
  assert.notEqual(w.plan(id).state, "done");
});

test("A34: no Core step: a person with no agents: the owner's confirm is the approval, it runs at once with no draft", async () => {
  const w = makeWorld();
  w.db.prepare("UPDATE fleet_agents SET owner_id = NULL").run();
  w.db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES ('slack:UANN', ?, 1)").run(w.ann.id);
  w.connect.add({ id: "channel_sender:slack:UANN", kind: "channel_sender", subject: { kind: "person", id: w.ann.id }, resource: "slack:UANN", level: "use", label: "Slack sender" });
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const id = w.makePlan({ kind: "person", id: w.ann.id });
  assert.equal(w.plan(id).rail, "none");
  await w.tick(id);
  assert.equal(w.core.data.drafts.length, 0);
  assert.deepEqual(w.connect.data.ended, ["channel_sender:slack:UANN"]);
  assert.equal(w.item(id, "channel_sender:slack:UANN").state, "done");
  assert.equal(w.plan(id).state, "done");
});

test("A34: a person with agents: the sender bar runs at once, before the owner approves the agents' stop", async () => {
  const w = makeWorld();
  w.db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES ('slack:UANN', ?, 1)").run(w.ann.id);
  w.connect.add({ id: "channel_sender:slack:UANN", kind: "channel_sender", subject: { kind: "person", id: w.ann.id }, resource: "slack:UANN", level: "use", label: "Slack sender" });
  account(w);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const id = w.makePlan({ kind: "person", id: w.ann.id });
  await w.tick(id);
  assert.deepEqual(w.connect.data.ended, ["channel_sender:slack:UANN"]);
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(w.item(id, "account_as_itself:acc1").state, "pending", "it waits for Core");
  assert.deepEqual(w.core.open()[0]?.steps.map((s) => s.agt).sort(), [HENRY, SALES].sort());
  assert.deepEqual(w.core.open()[0]?.steps.map((s) => s.opId), ["agents.pause", "agents.pause"], "undecided agents are effectively suspended: pause, not offboard");
});

test("A34: a review plan: a Knowledge item ends on the owner's confirm; on a running agent a bound item becomes manual, not a wait for ever", async () => {
  const w = makeWorld();
  w.knowledge.add({ id: "team_grant:t1", kind: "team_grant", subject: { kind: "person", id: w.ann.id }, resource: "t1", level: "read", label: "Team reads", direction: "about" });
  const id = w.makePlan({ kind: "person", id: w.ann.id, items: [{ product: "knowledge", id: "team_grant:t1" }] });
  assert.equal(w.plan(id).purpose, "review");
  await w.tick(id);
  assert.equal(w.item(id, "team_grant:t1").state, "done");
  assert.equal(w.plan(id).state, "done");

  const v = makeWorld();
  account(v);
  const pid = v.makePlan({ kind: "agent", id: HENRY, items: [{ product: "connect", id: "account_as_itself:acc1" }] });
  await v.tick(pid);
  assert.equal(v.item(pid, "account_as_itself:acc1").state, "manual");
  assert.equal(v.plan(pid).state, "done");
});

test("guard: nothing to stop is refused; so is a second open plan", () => {
  const w = makeWorld();
  assert.throws(() => w.makePlan({ kind: "agent", id: HENRY }), (e: TbError) => e.code === "nothing_to_stop" && e.httpStatus === 409);
  leave(w);
  w.makePlan({ kind: "agent", id: HENRY });
  assert.throws(() => w.makePlan({ kind: "agent", id: HENRY }), (e: TbError) => e.code === "plan_open" && e.httpStatus === 409);
});

test("guard: a stale expectedRev is refused, and quiet with the right one", () => {
  const w = makeWorld();
  leave(w);
  const rev = Number(w.db.prepare("SELECT lifecycle_rev AS r FROM fleet_agents WHERE id = ?").get(HENRY)?.r);
  assert.throws(() => w.makePlan({ kind: "agent", id: HENRY, expectedRev: rev - 1 }), (e: TbError) => e.code === "lifecycle_stale");
  assert.ok(w.makePlan({ kind: "agent", id: HENRY, expectedRev: rev }));
});

test("a keep-running agent gets no Core step; a transfer gets a pause and a new key", () => {
  const w = makeWorld();
  w.db.prepare("UPDATE fleet_agents SET keep_running = 1, keep_reason = 'x' WHERE id = ?").run(SALES);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const id = w.makePlan({ kind: "person", id: w.ann.id, transfers: [SALES] });
  const core = w.steps(id).filter((s) => s.phase === "core").map((s) => `${String(s.op)} ${String(s.agent_id)}`);
  assert.deepEqual(core, [`agents.pause ${HENRY}`, `agents.pause ${SALES}`, `agents.rotate ${SALES}`]);
});

test("split: above 100 Core steps, numbered plans, each under the limit, an agent's steps together; a plan's items wait for its own part", async () => {
  const w = makeWorld();
  const { agentId } = await import("./plans-world.ts");
  const ids = Array.from({ length: 101 }, (_, i) => agentId(i + 10));
  store.syncAgents(w.db, [...w.db.prepare("SELECT id, name, mode, status FROM fleet_agents").all(), ...ids.map((id) => ({ id, name: id, mode: "free", status: "active" }))] as never, w.clock.t);
  for (const id of ids) {
    store.setAgent(w.db, { agent: id, owner: w.ann.id }, w.clock.t);
    w.core.addAgent(id, 0, 0);
  }
  set(w.db, "person", w.ann.id, "leaving", { noCap: true }, w.clock.t);
  const made = w.makePlan({ kind: "person", id: w.ann.id });
  const parts = w.db.prepare("SELECT id, part, parts FROM fleet_plans WHERE group_id = ? ORDER BY part").all(made);
  assert.equal(parts.length, 2);
  assert.equal(parts[1]?.parts, 2);
  const counts = parts.map((p) => w.steps(String(p.id)).filter((s) => s.phase === "core").length);
  assert.deepEqual(counts, [100, 3]);
  await w.tick(String(parts[1]?.id));
  assert.match(w.core.open()[0]?.title ?? "", /part 2 of 2/);
});

test("runDue: two runs at once tick one plan once: one revoke call", async () => {
  const w = makeWorld();
  account(w);
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await runDue(w.pc);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.clock.t += 60_000;
  await Promise.all([runDue(w.pc), runDue(w.pc)]);
  assert.equal(w.connect.data.handled.length, 1);
  assert.equal(w.plan(id).state, "done");
  assert.equal(await runDue(w.pc), 0, "a done plan takes no tick");
});

test("cadence: every minute for 30 minutes, then every 15", async () => {
  const w = makeWorld();
  const id = await leavingPlan(w);
  assert.equal((await w.tick(id)).afterMs, 60_000);
  w.clock.t += 31 * 60_000;
  assert.equal((await w.tick(id)).afterMs, 15 * 60_000);
});

test("§4 re-reads: an open plan reads its stores every 60 s for 30 minutes, then every 15; each read updates the owner's copy; a proved end removes the row", async () => {
  const w = makeWorld();
  account(w);
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await runDue(w.pc);
  const start = w.connect.data.lists;
  const shadow = () => w.db.prepare("SELECT item_id, state FROM fleet_access_items WHERE item_id = 'account_as_itself:acc1'").get();
  assert.ok(shadow(), "the first read reached the owner's copy");
  // 30 minutes: one list a minute
  for (let i = 0; i < 30; i++) {
    w.clock.t += 60_000;
    await runDue(w.pc);
  }
  const fast = w.connect.data.lists - start;
  assert.ok(fast >= 29 && fast <= 31, `about 30 reads in the first 30 minutes, got ${fast}`);
  // the next hour: one list each 15 minutes
  const before = w.connect.data.lists;
  for (let i = 0; i < 60; i++) {
    w.clock.t += 60_000;
    await runDue(w.pc);
  }
  const slow = w.connect.data.lists - before;
  assert.ok(slow >= 3 && slow <= 5, `about 4 reads in the next hour, got ${slow}`);
  // a read sees a change in the store: Differences has it at the next tick
  w.connect.sees(HENRY, "paused");
  w.clock.t += 15 * 60_000;
  await runDue(w.pc);
  assert.equal(shadow()?.state, "paused");
  // the end, proved by a fresh list, removes the row at once
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.clock.t += 15 * 60_000;
  await runDue(w.pc);
  assert.equal(w.plan(id).state, "done");
  assert.equal(shadow(), undefined);
});

test("§4 re-reads: with 3 open plans one sweep serves them all, at the same pace; a tick reads a store only when that decides a step", async () => {
  const w = makeWorld();
  account(w);
  const { agentId } = await import("./plans-world.ts");
  const ids = [agentId(31), agentId(32)];
  store.syncAgents(w.db, [...w.db.prepare("SELECT id, name, mode, status FROM fleet_agents").all(), ...ids.map((id) => ({ id, name: id, mode: "free", status: "active" }))] as never, w.clock.t);
  for (const id of ids) {
    store.setAgent(w.db, { agent: id, owner: w.ann.id }, w.clock.t);
    w.core.addAgent(id, 0, 0);
    set(w.db, "agent", id, "active", {}, w.clock.t);
    set(w.db, "agent", id, "leaving", {}, w.clock.t);
    w.makePlan({ kind: "agent", id });
  }
  leave(w);
  w.makePlan({ kind: "agent", id: HENRY });
  let sweeps = 0;
  w.pc.startSweep = () => {
    sweeps++;
    w.db.prepare("INSERT INTO fleet_sweeps (id, started_by, started_at, finished_at) VALUES (?, 'schedule', ?, ?)").run(`swp_${sweeps}`, w.clock.t, w.clock.t);
  };
  await runDue(w.pc); // first read of each store: it decides what the steps are
  const first = w.connect.data.lists;
  assert.equal(sweeps, 1);
  for (let i = 0; i < 5; i++) {
    w.clock.t += 60_000;
    await runDue(w.pc);
  }
  assert.equal(w.connect.data.lists, first, "no list per plan");
  assert.equal(sweeps, 6);
  w.clock.t += 40 * 60_000;
  await runDue(w.pc);
  const at = sweeps;
  w.clock.t += 60_000;
  await runDue(w.pc);
  assert.equal(sweeps, at, "past the window, not each minute");
});

test("system plan alert: once with an Inbox; banner with none; a restart with an unanswered alert asks with the same key", async () => {
  const { bannerAlerts } = await import("../src/plans/alerts.ts");
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY, actor: { kind: "system", id: null } });
  w.inbox.down = true;
  await w.tick(id);
  assert.equal(w.inbox.asks.length, 0);
  w.inbox.down = false;
  await runDue(w.pc);
  assert.equal(w.inbox.asks.length, 1);
  await w.tick(id);
  await runDue(w.pc);
  assert.equal(w.inbox.asks.length, 1, "once");
  assert.doesNotMatch(JSON.stringify(w.inbox.asks), /Henry|Ann|left/, "no name and no reason");

  const v = makeWorld();
  v.installed = [];
  v.pc.alerts = { ask: async () => ({ kind: "no_inbox", code: "not_installed" }) };
  leave(v);
  const pid = v.makePlan({ kind: "agent", id: HENRY, actor: { kind: "system", id: null } });
  await v.tick(pid);
  assert.deepEqual(bannerAlerts(v.db).map((b) => b.text), ["A stop request waits for your approval. No message was sent."]);
});

test("Portal stopped mid-way: `applying` for 30 minutes is said; no store step runs", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  w.core.apply(keyOf(w, id), { stopMidWay: true });
  const stuck = w.core.data.drafts[0];
  await w.tick(id);
  for (const at of [31 * 60_000]) {
    w.clock.t += at;
    if (stuck) stuck.appliedSince = w.clock.t; // this Core has not swept yet
    await w.tick(id);
  }
  assert.equal(w.plan(id).state, "applying");
  assert.equal(w.plan(id).code, "portal_stopped");
  assert.equal(w.connect.data.handled.length, 0);
});

test("a system plan with no draft to wait for: the owner still hears that the date passed", async () => {
  const w = makeWorld();
  w.db.prepare("UPDATE fleet_agents SET owner_id = NULL").run();
  set(w.db, "person", w.ann.id, "suspended", {}, w.clock.t);
  const id = w.makePlan({ kind: "person", id: w.ann.id, actor: { kind: "system", id: null } });
  await w.tick(id);
  assert.equal(w.plan(id).rail, "none");
  assert.deepEqual(w.inbox.asks.map((a) => a.title), ["An end date passed."]);
});

test("overlap: a wake during a tick does not start a second tick: one revoke call, and the plan goes on after it", async () => {
  const { wakePlans } = await import("../src/plans/control.ts");
  const w = makeWorld();
  account(w);
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await runDue(w.pc);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.clock.t += 60_000;
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const real = w.pc.access.revoke.bind(w.pc.access);
  let calls = 0;
  w.pc.access.revoke = async (...a) => {
    calls++;
    await gate;
    return real(...a);
  };
  const first = runDue(w.pc);
  while (calls === 0) await new Promise((r) => setTimeout(r, 1));
  assert.equal(wakePlans(w.db), 1, "the slice arrived");
  w.clock.t += 60_000;
  const second = await runDue(w.pc);
  assert.equal(second, 0, "the lease holds");
  assert.equal(calls, 1);
  open();
  await first;
  assert.equal(calls, 1);
  assert.equal(w.plan(id).state, "done");
  assert.deepEqual(w.connect.data.ended, ["account_as_itself:acc1"]);
});

test("a crash holds the lease until the next boot, which frees it", async () => {
  const { releaseTicks } = await import("../src/plans/runner.ts");
  const w = makeWorld();
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  w.db.prepare("UPDATE fleet_plans SET ticking_until = ? WHERE id = ?").run(w.clock.t + 300_000, id);
  assert.equal(await runDue(w.pc), 0);
  releaseTicks(w.db);
  assert.equal(await runDue(w.pc), 1);
});

test("a failed draft that then expires or is rejected: what Core did stays on the record; the page does not say nothing was applied", async () => {
  for (const end of ["expire", "reject"] as const) {
    const w = makeWorld();
    set(w.db, "agent", HENRY, "leaving", {}, w.clock.t);
    set(w.db, "agent", SALES, "leaving", {}, w.clock.t);
    set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
    const id = w.makePlan({ kind: "person", id: w.ann.id, expiresInSec: 120 });
    await w.tick(id);
    w.core.failAgent = SALES;
    w.core.apply(keyOf(w, id));
    w.core.deliver();
    if (end === "expire") w.clock.t += 121_000;
    else w.core.reject(keyOf(w, id));
    await w.tick(id);
    const core = w.steps(id).filter((s) => s.phase === "core");
    assert.equal(core.find((s) => s.agent_id === HENRY)?.state, "done", end);
    assert.equal(w.plan(id).code, "partly_applied");
    const { hasAppliedStop } = await import("../src/plans/guards.ts");
    assert.equal(hasAppliedStop(w.db, "person", w.ann.id), true, "T6 cannot pretend it did not happen");
  }
});

test("a part with more agents than one list call may name: each is read, in chunks of the contract's limit", async () => {
  const w = makeWorld();
  const { agentId } = await import("./plans-world.ts");
  const ids = Array.from({ length: 40 }, (_, i) => agentId(i + 10));
  store.syncAgents(w.db, [...w.db.prepare("SELECT id, name, mode, status FROM fleet_agents").all(), ...ids.map((id) => ({ id, name: id, mode: "free", status: "active" }))] as never, w.clock.t);
  for (const id of ids) {
    store.setAgent(w.db, { agent: id, owner: w.ann.id }, w.clock.t);
    w.core.addAgent(id, 0, 0);
  }
  const last = ids[39] as string;
  w.connect.add(agentItem({ id: "account_as_itself:last", kind: "account_as_itself", agent: last }));
  set(w.db, "person", w.ann.id, "leaving", { noCap: true }, w.clock.t);
  set(w.db, "agent", last, "leaving", {}, w.clock.t);
  const id = w.makePlan({ kind: "person", id: w.ann.id });
  await w.tick(id);
  assert.equal((w.steps(id).find((s) => s.phase === "read" && s.target === "connect") as Record<string, unknown>).state, "done");
  assert.ok(w.item(id, "account_as_itself:last"), "the 40th agent's item was read");
});

test("a person with more than 16 handles: each handle is asked about", async () => {
  const w = makeWorld();
  w.db.prepare("UPDATE fleet_agents SET owner_id = NULL").run();
  for (let i = 0; i < 20; i++) {
    const h = `slack:U${String(i).padStart(4, "0")}`;
    w.db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES (?, ?, 1)").run(h, w.ann.id);
    w.connect.add({ id: `channel_sender:${h}`, kind: "channel_sender", subject: { kind: "person", id: w.ann.id }, resource: h, level: "use", label: "Sender" });
  }
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const id = w.makePlan({ kind: "person", id: w.ann.id });
  await w.tick(id);
  await w.tick(id);
  assert.equal(w.connect.data.ended.length, 20);
  assert.equal(w.plan(id).state, "done");
});

test("a store that never sees the agent stopped: not retried for ever; it goes to the owner", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  w.core.apply(keyOf(w, id));
  w.core.deliver();
  for (let i = 0; i < 10; i++) {
    await w.tick(id);
    w.clock.t += 60_000;
  }
  const s = w.item(id, "account_as_itself:acc1");
  assert.equal(s.state, "not_revocable");
  assert.equal(s.tries, MAX_TRIES);
  assert.equal(w.plan(id).state, "partial");
  assert.equal(w.connect.data.handled.length, MAX_TRIES);
});

test("link mode: a pause in Portal with no view of the access: what stands on the removal is not run; someone acts by hand; the words do not quote Portal", async () => {
  const w = makeWorld();
  account(w);
  leave(w);
  w.core.consent = false;
  w.core.topologyOn = false;
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  w.core.pauseInPortal(HENRY);
  w.core.deliver();
  w.connect.sees(HENRY, "paused");
  await w.tick(id);
  assert.equal(w.item(id, "account_as_itself:acc1").state, "manual");
  assert.equal(w.item(id, "account_as_itself:acc1").code, "not_approved");
  assert.equal(w.connect.data.handled.length, 0);
  assert.equal(w.plan(id).state, "reported");
  const { planView } = await import("../src/plans/view.ts");
  assert.doesNotMatch(planView(w.db, id).headline, /Portal says/);
});

test("a stale slice is not a missing rail: the plan waits, it does not fall to link mode", async () => {
  const w = makeWorld();
  leave(w);
  const real = w.core.request.bind(w.core);
  w.core.request = async () => {
    throw new TbError("bridge_cap_missing", "stale", 409, { cap: "owner_drafts", reason: "slice_stale" });
  };
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  assert.equal(w.plan(id).rail, "draft");
  assert.equal(w.plan(id).state, "preparing");
  w.core.request = real;
  await w.tick(id);
  assert.equal(w.plan(id).state, "waiting");
});

test("a draft that fails read: an unreadable step in Core's answer moves nothing, and throws nothing", async () => {
  const w = makeWorld();
  const id = await leavingPlan(w);
  const real = w.core.get.bind(w.core);
  w.core.get = async (k) => ({ ...(await real(k)), steps: [null as never] });
  await w.tick(id);
  assert.equal(w.plan(id).state, "waiting");
  assert.equal(w.plan(id).code, "bad_answer");
});

test("a rotate that stays open: a new key may be paired already, so after the window it reads as said, not seen; a slice revision proves it when the SDK has one", async () => {
  const w = makeWorld();
  w.db.prepare("UPDATE fleet_agents SET owner_id = NULL WHERE id = ?").run(SALES);
  const id = w.makePlan({ kind: "agent", id: HENRY, transfers: [HENRY] });
  await w.tick(id);
  w.core.apply(keyOf(w, id));
  const a = w.core.data.agents[HENRY];
  if (a) a.keys = 1; // paired again already
  w.core.deliver();
  await w.tick(id);
  const rot = () => w.steps(id).find((s) => s.op === "agents.rotate") as Record<string, unknown>;
  assert.equal(rot().state, "pending_bridge");
  w.clock.t += 31 * 60_000;
  w.db.prepare("UPDATE fleet_plan_steps SET updated_at = ? WHERE op = 'agents.rotate'").run(w.clock.t - 31 * 60_000);
  await w.tick(id);
  assert.equal(rot().state, "reported");
  assert.equal(w.plan(id).state, "reported");
});

test("a store's `revoked` for a kind this version cannot list is said, not proved", async () => {
  const w = makeWorld();
  w.connect.add(agentItem({ id: "scheduled_post:p", kind: "scheduled_post" }));
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.connect.notShown = [{ kind: "scheduled_post", reason: "Not listed." }];
  await w.tick(id);
  assert.equal(w.item(id, "scheduled_post:p").state, "reported");
  assert.equal(w.plan(id).state, "reported");
});

test("a handler that throws frees the key: the store ran nothing; re-list, new attempt", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY);
  w.connect.revokeScript.push({ kind: "handler_throw", code: "app_error", status: 500 });
  await w.tick(id);
  assert.equal(w.connect.data.ended.length, 0);
  assert.notEqual(w.plan(id).state, "done");
  w.clock.t += 60_000;
  await w.tick(id);
  assert.equal(w.plan(id).state, "done");
  assert.deepEqual(w.connect.data.ended, ["account_as_itself:acc1"]);
});

test("a system plan: nothing that needs the owner's confirm runs; what stands on his approval in Portal does", async () => {
  const w = makeWorld();
  w.db.prepare("UPDATE fleet_agents SET owner_id = NULL").run();
  w.db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES ('slack:UANN', ?, 1)").run(w.ann.id);
  w.connect.add({ id: "channel_sender:slack:UANN", kind: "channel_sender", subject: { kind: "person", id: w.ann.id }, resource: "slack:UANN", level: "use", label: "Slack sender" });
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const id = w.makePlan({ kind: "person", id: w.ann.id, actor: { kind: "system", id: null } });
  await w.tick(id);
  assert.equal(w.item(id, "channel_sender:slack:UANN").state, "listed");
  assert.equal(w.connect.data.handled.length, 0);
});

test("stale, and the owner had approved already: what Core did goes on the record first; T6 sees it; no Core step reads as not done", async () => {
  const { hasAppliedStop } = await import("../src/plans/guards.ts");
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  approveAndDeliver(w, keyOf(w, id), HENRY); // no tick read it
  w.db.prepare("UPDATE fleet_agents SET lifecycle_rev = lifecycle_rev + 1 WHERE id = ?").run(HENRY);
  await w.tick(id);
  assert.equal(w.plan(id).state, "stale");
  assert.equal(w.plan(id).draft_state, "applied");
  assert.equal((w.steps(id).find((s) => s.phase === "core") as Record<string, unknown>).state, "done");
  assert.equal(hasAppliedStop(w.db, "agent", HENRY), true);
  assert.equal(w.connect.data.handled.length, 0);
});

test("stale with Portal down: the plan ends, and says the draft may stand", async () => {
  const w = makeWorld();
  const id = await leavingPlan(w);
  w.db.prepare("UPDATE fleet_agents SET lifecycle_rev = lifecycle_rev + 1 WHERE id = ?").run(HENRY);
  w.core.down = true;
  await w.tick(id);
  assert.equal(w.plan(id).state, "stale");
  assert.equal(w.plan(id).code, "not_taken_back");
  const { planView } = await import("../src/plans/view.ts");
  assert.match(String(planView(w.db, id).note), /could not take this request back/);
});

test("the rail comes back in link mode: the draft is read again, and an approval there goes on as usual", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  w.core.flag = false;
  await w.tick(id);
  assert.equal(w.plan(id).rail, "portal_link");
  w.core.flag = true;
  approveAndDeliver(w, keyOf(w, id), HENRY);
  await w.tick(id);
  assert.equal(w.plan(id).rail, "draft");
  assert.equal(w.plan(id).state, "done");
});

test("ended plans leave no step that reads as waiting: lost, failed", async () => {
  const w = makeWorld();
  account(w);
  const id = await leavingPlan(w);
  w.core.data.drafts = [];
  await w.tick(id);
  assert.equal(w.plan(id).state, "lost");
  assert.equal((w.steps(id).find((s) => s.phase === "core") as Record<string, unknown>).state, "cancelled");
  assert.equal(w.item(id, "account_as_itself:acc1").state, "cancelled");
});

test("a handle Connect would refuse is not sent, also for a person with many", async () => {
  const w = makeWorld();
  w.db.prepare("UPDATE fleet_agents SET owner_id = NULL").run();
  for (let i = 0; i < 20; i++) w.db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES (?, ?, 1)").run(`slack:U${String(i).padStart(4, "0")}`, w.ann.id);
  w.db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES ('NOT A HANDLE', ?, 1)").run(w.ann.id);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const id = w.makePlan({ kind: "person", id: w.ann.id });
  await w.tick(id);
  assert.equal((w.steps(id).find((s) => s.phase === "read" && s.target === "connect") as Record<string, unknown>).state, "done");
});
