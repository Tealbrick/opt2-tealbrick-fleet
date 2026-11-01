// C380 T2-b: review rounds. Rows R5 (a round over agents, counts by round id, a batched plan) and the guards behind it. The world is the plan runner's:
// a real database and a real runner; only Core and the stores are fakes. A verdict that asks to remove access ends in the plan path and nowhere else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { type AccessTarget, itemDigest, parsePage, storeItems } from "../src/access/items.ts";
import { handlers, manifest } from "../src/app.ts";
import { planView } from "../src/plans/view.ts";
import { recordReview, requestForNewAgents } from "../src/reviews.ts";
import { ACCESS_SHOWN, accessOf, closeRound, countsOf, createRound, decide, listRounds, ROUND_MAX_ITEMS, ROUND_OPEN_PLANS, roundDetail, sendQueued } from "../src/rounds.ts";
import * as store from "../src/store.ts";
import { refused, set } from "./lifecycle-helpers.ts";
import type { FakeStore } from "./plans-fakes.ts";
import { agentId, HENRY, makeWorld, SALES, type World } from "./plans-world.ts";

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
type Run = { run(i: unknown, c: OpContext): Promise<unknown> };
const PERSON = { type: "person", id: "per_owner", name: "owner", mode: null };
const OWNER = "per_owner";
const ctxOf = (w: World, caller: object = PERSON): OpContext =>
  ({ db: w.db, caller, log: LOG, callApp: async () => ({ status: "ok", output: {} }), companionTargets: () => [], topology: () => null, jobs: { enqueue: () => {} }, ownerLink: () => null, ownerLinkFor: () => null }) as unknown as OpContext;
const run = (id: string, input: unknown, c: OpContext) => (handlers as unknown as Record<string, Run>)[id]?.run(input, c) as Promise<Record<string, any>>;
const validOut = (id: string, out: unknown) => {
  const spec = manifest.operations.find((o) => o.id === id) as unknown as { output: Parameters<typeof validateAgainstSchema>[0] };
  const v = validateAgainstSchema(spec.output, out as Json);
  assert.deepEqual(v.ok ? [] : v.errors, [], `${id} output`);
};

/** What the store lists for one subject enters the shadow copy, as a sweep would put it there. */
function listed(w: World, fake: FakeStore, product: AccessTarget, subject: { kind: "agent" | "person"; id: string }): void {
  let cursor: string | undefined;
  do {
    const out = fake.list({ v: 1, subjects: [{ kind: subject.kind, id: subject.id, ...(subject.kind === "person" ? { handles: [] } : {}) }], ...(cursor ? { cursor } : {}) } as never).output;
    const page = parsePage(product, out);
    storeItems(w.db, product, page.items, "swp_t", w.clock.t);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}
/** One row as an app lists it, for a person, with its own digest. */
const itemWire = (target: AccessTarget, id: string, person: string) => {
  const base = { id, kind: id.split(":")[0] as string, subject: { kind: "person" as const, id: person }, resource: id, direction: "held_by" as const, level: "use" as const, label: `Row ${id}`, state: "active" as const, revocable: true };
  return { ...base, digest: itemDigest(target, base) };
};
const personItem = (w: World, id: string, kind = "team_grant") => ({ id, kind, subject: { kind: "person" as const, id: w.ann.id }, resource: id, level: "read" as const, label: `Grant ${id}` });

/** The owner's view: the digests the page would send. */
function viewOf(w: World, round: string, kind: "agent" | "person", id: string) {
  const item = roundDetail(w.db, round, w.clock.t).items.find((i) => i.subject.id === id);
  assert.ok(item, `${kind} ${id} is in the round`);
  assert.ok(item.snapshotDigest);
  return { snapshotDigest: item.snapshotDigest as string, accessDigest: item.accessDigest, access: item.access };
}
const verdict = (w: World, round: string, kind: "agent" | "person", id: string, over: Record<string, unknown> = {}) => ({ round, subject: { kind, id }, verdict: "trusted" as const, reason: "Looked at it.", ...viewOf(w, round, kind, id), ...over });

test("R5: a round over agents asks once per entry, and the counts are read by round id", () => {
  const w = makeWorld();
  const made = createRound(w.db, OWNER, { title: "Q4 review", scope: "agents" }, w.clock.t);
  assert.equal(made.added, 2);
  assert.deepEqual(countsOf(w.db, made.id), { total: 2, open: 2, trusted: 0, limited: 0, blocked: 0, dismissed: 0, removalQueued: 0, removalPlanned: 0 });
  const asked = w.db.prepare("SELECT requested_by_kind, requested_by_id, requested_why, status FROM fleet_reviews WHERE id IN (SELECT review_id FROM fleet_campaign_items WHERE round_id = ?)").all(made.id);
  assert.deepEqual(asked.map((r) => [r.requested_by_kind, r.requested_by_id, r.status]), [["owner", OWNER, "requested"], ["owner", OWNER, "requested"]]);
  // a verdict in the round
  const out = decide(w.db, OWNER, verdict(w, made.id, "agent", HENRY, { verdict: "limited" }), w.clock.t);
  assert.equal(out.item.status, "limited");
  assert.equal(w.db.prepare("SELECT trust FROM fleet_agents WHERE id = ?").get(HENRY)?.trust, "limited", "the existing review sets the trust");
  assert.deepEqual(countsOf(w.db, made.id), { total: 2, open: 1, trusted: 0, limited: 1, blocked: 0, dismissed: 0, removalQueued: 0, removalPlanned: 0 });
  // a verdict recorded outside the round (the Reviews page) answers the linked request, and the count follows by round id
  recordReview(w.db, OWNER, { subject: { kind: "agent", id: SALES }, verdict: "blocked", reason: "On the Reviews page.", snapshotDigest: viewOf(w, made.id, "agent", SALES).snapshotDigest }, w.clock.t);
  assert.equal(countsOf(w.db, made.id).blocked, 1);
  const done = roundDetail(w.db, made.id, w.clock.t);
  assert.deepEqual(done.items.map((i) => [i.subject.name, i.status]), [["Henry", "limited"], ["Sales", "blocked"]]);
  assert.deepEqual(done.items.map((i) => i.decidedIn), ["round", "elsewhere"], "a verdict from the Reviews page is counted, and said to be from there");
});

test("a person or agent in an open round is left out of another; a closed round frees them; closing dismisses what nobody decided", () => {
  const w = makeWorld();
  const a = createRound(w.db, OWNER, { title: "One", scope: "agents" }, w.clock.t);
  assert.throws(() => createRound(w.db, OWNER, { title: "Two", scope: "agents" }, w.clock.t), refused("nothing_to_review", 409));
  const chosen = createRound(w.db, OWNER, { title: "Ann", scope: "chosen", subjects: [{ kind: "person", id: w.ann.id }, { kind: "agent", id: HENRY }] }, w.clock.t);
  assert.deepEqual([chosen.added, chosen.skipped], [1, 1], "Henry is in round One");
  decide(w.db, OWNER, verdict(w, a.id, "agent", HENRY), w.clock.t);
  closeRound(w.db, OWNER, a.id, w.clock.t + 1);
  const counts = countsOf(w.db, a.id);
  assert.deepEqual([counts.trusted, counts.dismissed, counts.open], [1, 1, 0], "Sales was never decided: dismissed, with a plain reason");
  assert.equal(w.db.prepare("SELECT reason FROM fleet_reviews WHERE status = 'dismissed'").get()?.reason, "Review round closed.");
  assert.equal(listRounds(w.db, w.clock.t).find((r) => r.id === a.id)?.state, "closed");
  assert.throws(() => closeRound(w.db, OWNER, a.id), refused("round_closed", 409));
  assert.throws(() => decide(w.db, OWNER, verdict(w, chosen.id, "person", w.ann.id, { round: a.id }), w.clock.t), refused("round_closed", 409));
  const again = createRound(w.db, OWNER, { title: "Three", scope: "agents" }, w.clock.t);
  assert.equal(again.added, 2, "both are free: Sales was dismissed, and Henry has no open request");
});

test("fire on bad: not in the round, decided twice, stale snapshot, stale access, a row the entry does not hold, a row an app cannot end", () => {
  const w = makeWorld();
  w.connect.add(personItem(w, "channel_sender:s1", "channel_sender"));
  w.knowledge.add({ ...personItem(w, "team_grant:t1"), revocable: false });
  listed(w, w.connect, "connect", { kind: "person", id: w.ann.id });
  listed(w, w.knowledge, "knowledge", { kind: "person", id: w.ann.id });
  const r = createRound(w.db, OWNER, { title: "People", scope: "people" }, w.clock.t);
  const v = viewOf(w, r.id, "person", w.ann.id);
  assert.throws(() => decide(w.db, OWNER, { ...verdict(w, r.id, "person", w.ann.id), subject: { kind: "person", id: "psn_none" } }, w.clock.t), refused("not_in_round", 404));
  assert.throws(() => decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { snapshotDigest: "wrong" }), w.clock.t), refused("snapshot_stale", 409));
  assert.throws(() => decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { accessDigest: "sha256:old" }), w.clock.t), refused("access_stale", 409));
  const sender = v.access.find((x) => x.id === "channel_sender:s1");
  const grant = v.access.find((x) => x.id === "team_grant:t1");
  assert.ok(sender && grant);
  const tick = (x: { product: string; id: string; digest: string }) => ({ product: x.product, id: x.id, digest: x.digest });
  assert.throws(() => decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { remove: [{ product: "connect", id: "channel_sender:none", digest: sender.digest }] }), w.clock.t), refused("access_stale", 409));
  assert.throws(() => decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { remove: [{ ...tick(sender), digest: "sha256:x" }] }), w.clock.t), refused("access_stale", 409));
  assert.throws(() => decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { remove: [tick(grant)] }), w.clock.t), refused("not_removable", 409));
  assert.deepEqual(countsOf(w.db, r.id), { total: 1, open: 1, trusted: 0, limited: 0, blocked: 0, dismissed: 0, removalQueued: 0, removalPlanned: 0 }, "every refusal left nothing behind");
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM fleet_plans").get()?.n, 0);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM fleet_reviews WHERE status = 'done'").get()?.n, 0);
  // quiet on good: the same call with true digests passes
  const ok = decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { remove: [tick(sender)] }), w.clock.t);
  assert.equal(ok.item.status, "trusted");
  assert.throws(() => decide(w.db, OWNER, { round: r.id, subject: { kind: "person", id: w.ann.id }, verdict: "blocked", reason: "Again.", snapshotDigest: v.snapshotDigest, accessDigest: v.accessDigest }, w.clock.t), refused("already_decided", 409));
});

test("N2-T2: a blocked entry is not in a round, in any scope, and a round cannot lift a block that came later", () => {
  const w = makeWorld();
  w.db.prepare("UPDATE fleet_agents SET trust = 'blocked' WHERE id = ?").run(SALES);
  createRound(w.db, OWNER, { title: "Agents", scope: "agents" }, w.clock.t);
  const open = w.db.prepare("SELECT subject_id FROM fleet_campaign_items").all().map((r) => String(r.subject_id));
  assert.equal(open.includes(SALES), false, "scope agents leaves the blocked entry out");
  const c = createRound(w.db, OWNER, { title: "Chosen", scope: "chosen", subjects: [{ kind: "agent", id: SALES }, { kind: "person", id: w.ann.id }] }, w.clock.t);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM fleet_campaign_items WHERE round_id = ? AND subject_id = ?").get(c.id, SALES)?.n, 0, "scope chosen too");
  // blocked after the round began: a non-blocked verdict is refused, a blocked one is quiet
  const held = verdict(w, c.id, "person", w.ann.id);
  w.db.prepare("UPDATE fleet_people SET trust = 'blocked' WHERE id = ?").run(w.ann.id);
  assert.throws(() => decide(w.db, OWNER, held, w.clock.t), refused("blocked_use_review", 409));
  assert.equal(w.db.prepare("SELECT trust FROM fleet_people WHERE id = ?").get(w.ann.id)?.trust, "blocked", "the block stays");
});

test("a verdict that asks to remove access makes a plan by the plan path, and the runner ends it at the store", async () => {
  const w = makeWorld();
  w.connect.add(personItem(w, "channel_sender:s1", "channel_sender"));
  listed(w, w.connect, "connect", { kind: "person", id: w.ann.id });
  const r = createRound(w.db, OWNER, { title: "People", scope: "people" }, w.clock.t);
  const v = viewOf(w, r.id, "person", w.ann.id);
  const out = decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { verdict: "limited", remove: [{ product: "connect", id: "channel_sender:s1", digest: v.access[0]?.digest }] }), w.clock.t);
  assert.ok(out.plan);
  const plan = w.plan(out.plan as string);
  assert.deepEqual([plan.purpose, plan.trigger_kind, plan.actor_id, plan.rail], ["review", "owner", OWNER, "none"], "an ordinary plan: the owner's confirm is the approval, no Core step");
  assert.equal(out.item.removal?.state, "planned");
  assert.equal(await w.until(out.plan as string, "done"), "done");
  assert.deepEqual(w.connect.data.ended, ["channel_sender:s1"]);
  assert.equal(w.core.data.drafts.length, 0, "no Core draft: a round has no second apply path");
  assert.equal(roundDetail(w.db, r.id, w.clock.t).items[0]?.removal?.planState, "done");
});

test("an agent that runs is not ended by a verdict: the plan has no Core step, so the row is left to the owner by hand and nothing is removed", async () => {
  const w = makeWorld();
  w.connect.add({ id: "account_as_itself:a1", kind: "account_as_itself", subject: { kind: "agent", id: HENRY }, resource: "a1", level: "use", label: "Mail" });
  listed(w, w.connect, "connect", { kind: "agent", id: HENRY });
  const r = createRound(w.db, OWNER, { title: "Agents", scope: "chosen", subjects: [{ kind: "agent", id: HENRY }] }, w.clock.t);
  const v = viewOf(w, r.id, "agent", HENRY);
  const out = decide(w.db, OWNER, verdict(w, r.id, "agent", HENRY, { remove: [{ product: "connect", id: "account_as_itself:a1", digest: v.access[0]?.digest }] }), w.clock.t);
  await w.until(out.plan as string, "done");
  assert.equal(w.item(out.plan as string, "account_as_itself:a1").state, "manual", "stated as a limit, never as done");
  assert.equal(planView(w.db, out.plan as string).counts.manual, 1);
  assert.equal(planView(w.db, out.plan as string).counts.proved, 0);
  assert.deepEqual(w.connect.data.ended, []);
});

test("batched plans: places for ten open plans; the rest wait, are sent when places free up, and are dropped when the round closes", () => {
  const w = makeWorld();
  const ids: string[] = [];
  const agents = Array.from({ length: 12 }, (_, i) => ({ id: agentId(10 + i), name: `Bot ${i}`, mode: "free", status: "active" }));
  store.syncAgents(w.db, agents as never, w.clock.t);
  requestForNewAgents(w.db, agents as never, w.clock.t);
  for (const a of agents) {
    store.setAgent(w.db, { agent: a.id, owner: w.ann.id }, w.clock.t);
    set(w.db, "agent", a.id, "active");
    w.connect.add({ id: `scheduled_post:${a.id}`, kind: "scheduled_post", subject: { kind: "agent", id: a.id }, resource: a.id, level: "use", label: "Post" });
    listed(w, w.connect, "connect", { kind: "agent", id: a.id });
    ids.push(a.id);
  }
  const r = createRound(w.db, OWNER, { title: "Bots", scope: "chosen", subjects: ids.map((id) => ({ kind: "agent" as const, id })) }, w.clock.t);
  for (const id of ids) {
    const v = viewOf(w, r.id, "agent", id);
    decide(w.db, OWNER, verdict(w, r.id, "agent", id, { remove: [{ product: "connect", id: `scheduled_post:${id}`, digest: v.access[0]?.digest }] }), w.clock.t);
  }
  assert.deepEqual(countsOf(w.db, r.id), { total: 12, open: 0, trusted: 12, limited: 0, blocked: 0, dismissed: 0, removalQueued: 2, removalPlanned: ROUND_OPEN_PLANS });
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM fleet_plans WHERE state IN ('preparing','waiting','applying','running','partial')").get()?.n, ROUND_OPEN_PLANS);
  assert.deepEqual(sendQueued(w.db, OWNER, r.id, w.clock.t), { planned: 0, queued: 2 }, "no place yet: nothing is made twice, nothing is lost");
  // two plans end: their places free up
  const open = w.db.prepare("SELECT id FROM fleet_plans WHERE state = 'preparing' ORDER BY id LIMIT 2").all();
  for (const p of open) w.db.prepare("UPDATE fleet_plans SET state = 'cancelled', closed_at = 1 WHERE id = ?").run(String(p.id));
  assert.deepEqual(sendQueued(w.db, OWNER, r.id, w.clock.t), { planned: 2, queued: 0 });
  assert.equal(countsOf(w.db, r.id).removalPlanned, 12);
});

test("closing a round drops the queued removals and says nothing was removed", () => {
  const w = makeWorld();
  w.connect.add(personItem(w, "channel_sender:s1", "channel_sender"));
  listed(w, w.connect, "connect", { kind: "person", id: w.ann.id });
  w.makePlan({ kind: "person", id: w.ann.id, items: [{ product: "connect", id: "channel_sender:s1" }] }); // the entry has an open plan already
  const r = createRound(w.db, OWNER, { title: "People", scope: "people" }, w.clock.t);
  const v = viewOf(w, r.id, "person", w.ann.id);
  const out = decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { remove: [{ product: "connect", id: "channel_sender:s1", digest: v.access[0]?.digest }] }), w.clock.t);
  assert.equal(out.plan, null);
  assert.equal(out.item.removal?.state, "queued");
  assert.match(out.item.removal?.note ?? "", /open/);
  closeRound(w.db, OWNER, r.id, w.clock.t + 1);
  const item = roundDetail(w.db, r.id, w.clock.t).items[0];
  assert.equal(item?.removal?.state, "dropped");
  assert.match(item?.removal?.note ?? "", /Nothing was removed/);
  assert.equal(countsOf(w.db, r.id).removalQueued, 0);
});

test("the round ops are person ops: an agent and an app are refused and nothing is written; outputs obey the manifest", async () => {
  const w = makeWorld();
  for (const id of ["round_create", "round_get", "round_verdict", "round_set"]) {
    assert.equal((manifest.operations.find((o) => o.id === id) as unknown as { audience: string }).audience, "person", id);
    for (const caller of [{ type: "agent", id: HENRY, name: "Henry", mode: "free" }, { type: "app", id: "ins_x", product: "rules", listed: true }]) {
      await assert.rejects(run(id, { title: "x", scope: "agents", round: "rnd_x", action: "close", subject: { kind: "agent", id: HENRY }, verdict: "trusted", reason: "x", snapshotDigest: "x", accessDigest: "x" }, ctxOf(w, caller)), refused("no_access", 403));
    }
  }
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM fleet_rounds").get()?.n, 0);
  const made = await run("round_create", { title: "Q4", scope: "everyone", dueDays: 14 }, ctxOf(w));
  validOut("round_create", made);
  assert.equal(made.round.counts.total, 3, "two agents and Ann");
  const got = await run("round_get", { round: made.round.id }, ctxOf(w));
  validOut("round_get", got);
  assert.equal(got.round.items.length, 3);
  assert.equal(got.rounds.length, 1);
  assert.equal((await run("round_get", {}, ctxOf(w))).round, null);
  const item = got.round.items.find((i: { subject: { id: string } }) => i.subject.id === HENRY);
  const decided = await run("round_verdict", { round: made.round.id, subject: { kind: "agent", id: HENRY }, verdict: "trusted", reason: "Fine.", snapshotDigest: item.snapshotDigest, accessDigest: item.accessDigest }, ctxOf(w));
  validOut("round_verdict", decided);
  assert.equal(decided.plan, null);
  const closed = await run("round_set", { round: made.round.id, action: "close" }, ctxOf(w));
  validOut("round_set", closed);
  assert.equal(closed.round.state, "closed");
  await assert.rejects(run("round_set", { round: made.round.id, action: "send" }, ctxOf(w)), refused("round_closed", 409));
  await assert.rejects(run("round_get", { round: "rnd_none" }, ctxOf(w)), refused("round_not_found", 404));
});

test("every step of a round is in the chain; the accessOf view is the shadow copy and nothing else", () => {
  const w = makeWorld();
  w.connect.add(personItem(w, "channel_sender:s1", "channel_sender"));
  listed(w, w.connect, "connect", { kind: "person", id: w.ann.id });
  assert.deepEqual(accessOf(w.db, "person", w.ann.id).map((r) => [r.product, r.id]), [["connect", "channel_sender:s1"]]);
  assert.deepEqual(accessOf(w.db, "person", "psn_none"), []);
  const r = createRound(w.db, OWNER, { title: "People", scope: "people" }, w.clock.t);
  decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id), w.clock.t);
  closeRound(w.db, OWNER, r.id, w.clock.t + 1);
  const notes = w.db.prepare("SELECT note FROM fleet_lifecycle_events WHERE note LIKE '%Review round%' ORDER BY seq").all().map((e) => String(e.note));
  assert.deepEqual(notes.map((x) => (x.split(":")[0] ?? "").replace(/ rnd_\w+/, "")), ["Review round started", "Review round", "Review round closed"]);
  assert.ok(notes.every((x) => !x.includes("People")), "the owner's name of the round is not copied into the chain: it cannot be erased");
  assert.equal(w.db.prepare("SELECT requested_why FROM fleet_reviews WHERE requested_by_kind = 'owner'").get()?.requested_why, "Review round.", "nor into the request");
});

test("a verdict plan has no Portal step: an entry that is stopped, or whose agent has its own stop, is refused with its verdict undone; an owner who leaves is not a stop of the agent (C381); a queued removal is dropped when the entry is stopped later", () => {
  const w = makeWorld();
  w.connect.add(personItem(w, "channel_sender:s1", "channel_sender"));
  listed(w, w.connect, "connect", { kind: "person", id: w.ann.id });
  const r = createRound(w.db, OWNER, { title: "Ann", scope: "chosen", subjects: [{ kind: "person", id: w.ann.id }] }, w.clock.t);
  const v = viewOf(w, r.id, "person", w.ann.id);
  const tick = [{ product: "connect", id: "channel_sender:s1", digest: v.access[0]?.digest }];
  // Ann owns Henry, and Henry has its own stop: a plan for Ann would have a Portal step (C381: Ann leaving alone has none, see below)
  set(w.db, "agent", HENRY, "leaving", {}, w.clock.t);
  const stale = viewOf(w, r.id, "person", w.ann.id);
  assert.throws(() => decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { remove: [{ product: "connect", id: "channel_sender:s1", digest: stale.access[0]?.digest }], snapshotDigest: stale.snapshotDigest, accessDigest: stale.accessDigest }), w.clock.t), refused("plan_needs_portal", 409));
  assert.deepEqual([countsOf(w.db, r.id).open, w.db.prepare("SELECT COUNT(*) AS n FROM fleet_plans").get()?.n, w.db.prepare("SELECT COUNT(*) AS n FROM fleet_reviews WHERE status = 'done'").get()?.n], [1, 0, 0], "no verdict, no plan");
  void tick;
  // quiet on good: without the stop the same call passes (Henry comes back)
  set(w.db, "agent", HENRY, "active", {}, w.clock.t + 1);
  const again = viewOf(w, r.id, "person", w.ann.id);
  assert.ok(decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { remove: [{ product: "connect", id: "channel_sender:s1", digest: again.access[0]?.digest }] }), w.clock.t).plan);
  // C381: the owner leaving is no stop of Henry, so it adds no Portal step: the same call passes while Ann is leaving
  const x = makeWorld();
  x.connect.add(personItem(x, "channel_sender:s1", "channel_sender"));
  listed(x, x.connect, "connect", { kind: "person", id: x.ann.id });
  const rx = createRound(x.db, OWNER, { title: "Ann", scope: "chosen", subjects: [{ kind: "person", id: x.ann.id }] }, x.clock.t);
  set(x.db, "person", x.ann.id, "leaving", {}, x.clock.t);
  const vx = viewOf(x, rx.id, "person", x.ann.id);
  assert.ok(decide(x.db, OWNER, verdict(x, rx.id, "person", x.ann.id, { remove: [{ product: "connect", id: "channel_sender:s1", digest: vx.access[0]?.digest }], snapshotDigest: vx.snapshotDigest, accessDigest: vx.accessDigest }), x.clock.t).plan, "no Core step for a person marked leaving");
});

test("a queued removal whose entry is stopped by the time it is sent is dropped, and says so", () => {
  const w = makeWorld();
  w.connect.add(personItem(w, "channel_sender:s1", "channel_sender"));
  listed(w, w.connect, "connect", { kind: "person", id: w.ann.id });
  const blocker = w.makePlan({ kind: "person", id: w.ann.id, items: [{ product: "connect", id: "channel_sender:s1" }] });
  const r = createRound(w.db, OWNER, { title: "Ann", scope: "people" }, w.clock.t);
  const v = viewOf(w, r.id, "person", w.ann.id);
  decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { remove: [{ product: "connect", id: "channel_sender:s1", digest: v.access[0]?.digest }] }), w.clock.t);
  assert.equal(countsOf(w.db, r.id).removalQueued, 1);
  w.db.prepare("UPDATE fleet_plans SET state = 'cancelled', closed_at = 1 WHERE id = ?").run(blocker);
  set(w.db, "agent", HENRY, "leaving", {}, w.clock.t + 1);
  assert.deepEqual(sendQueued(w.db, OWNER, r.id, w.clock.t), { planned: 0, queued: 0 });
  const item = roundDetail(w.db, r.id, w.clock.t).items[0];
  assert.equal(item?.removal?.state, "dropped");
  assert.match(item?.removal?.note ?? "", /Nothing was removed/);
});

test("the round says what the plan says: a plan that ended with nothing proved reads as such, never as removed", async () => {
  const w = makeWorld();
  w.connect.add({ id: "account_as_itself:a1", kind: "account_as_itself", subject: { kind: "agent", id: HENRY }, resource: "a1", level: "use", label: "Mail" });
  listed(w, w.connect, "connect", { kind: "agent", id: HENRY });
  const r = createRound(w.db, OWNER, { title: "Agents", scope: "chosen", subjects: [{ kind: "agent", id: HENRY }] }, w.clock.t);
  const v = viewOf(w, r.id, "agent", HENRY);
  const out = decide(w.db, OWNER, verdict(w, r.id, "agent", HENRY, { remove: [{ product: "connect", id: "account_as_itself:a1", digest: v.access[0]?.digest }] }), w.clock.t);
  await w.until(out.plan as string, "done");
  const removal = roundDetail(w.db, r.id, w.clock.t).items.find((i) => i.subject.id === HENRY)?.removal;
  assert.equal(removal?.planState, "done");
  assert.deepEqual([removal?.proved, removal?.manual, removal?.open], [0, 1, 0], "done is the plan's state; nothing was proved, one is for someone to do by hand");
  assert.ok(removal?.headline && !/removed|confirmed/i.test(removal.headline), String(removal?.headline));
});

test("a round holds at most 200 entries and refuses the 201st with nothing written; access beyond what the entry shows cannot be ticked; who decided where is told", () => {
  const w = makeWorld();
  const many = Array.from({ length: ROUND_MAX_ITEMS + 1 }, (_, i) => ({ id: agentId(100 + i), name: `Bulk ${i}`, mode: "free", status: "active" }));
  store.syncAgents(w.db, many as never, w.clock.t);
  requestForNewAgents(w.db, many as never, w.clock.t);
  const subjects = many.map((a) => ({ kind: "agent" as const, id: a.id }));
  assert.throws(() => createRound(w.db, OWNER, { title: "Too many", scope: "chosen", subjects }, w.clock.t), refused("round_too_big", 409));
  assert.equal(Number(w.db.prepare("SELECT COUNT(*) AS n FROM fleet_rounds").get()?.n), 0, "nothing written");
  assert.equal(Number(w.db.prepare("SELECT COUNT(*) AS n FROM fleet_reviews WHERE requested_by_kind = 'owner'").get()?.n), 0);
  assert.equal(createRound(w.db, OWNER, { title: "Just enough", scope: "chosen", subjects: subjects.slice(0, ROUND_MAX_ITEMS) }, w.clock.t).added, ROUND_MAX_ITEMS);
  // access beyond the rows shown
  for (let i = 0; i < ACCESS_SHOWN + 1; i++) storeItems(w.db, "connect", [parsePage("connect", { v: 1, asOf: "2026-10-30T16:00:00Z", items: [{ ...itemWire("connect", `channel_sender:z${String(i).padStart(3, "0")}`, w.ann.id) }], nextCursor: null, notShown: [], complete: true }).items[0] as never], "swp_t", w.clock.t);
  const r = createRound(w.db, OWNER, { title: "Ann", scope: "chosen", subjects: [{ kind: "person", id: w.ann.id }] }, w.clock.t);
  const item = roundDetail(w.db, r.id, w.clock.t).items[0];
  assert.deepEqual([item?.accessCount, item?.access.length], [ACCESS_SHOWN + 1, ACCESS_SHOWN]);
  const last = accessOf(w.db, "person", w.ann.id).at(-1);
  assert.throws(() => decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id, { remove: [{ product: last?.product, id: last?.id, digest: last?.digest }] }), w.clock.t), refused("access_stale", 409), "a row the owner was not shown");
  assert.equal(item?.decidedIn, null);
  const done = decide(w.db, OWNER, verdict(w, r.id, "person", w.ann.id), w.clock.t);
  assert.equal(done.item.decidedIn, "round");
});
