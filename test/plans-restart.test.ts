// A46, restart mid-plan: a real process, killed for real at each point where a crash could lose or repeat something. Then a new process goes on from the file. Each case ends with: the plan
// finished, the store ended each item exactly once, one draft in Portal.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getPlan, stepsOf } from "../src/plans/plan.ts";
import { T0 } from "./lifecycle-helpers.ts";
import { agentItem, approveAndDeliver, HENRY, leave, makeWorld, openDb, type World } from "./plans-world.ts";

const CHILD = fileURLToPath(new URL("./plans-crash-child.ts", import.meta.url));

function setup(): { w: World; dbFile: string; stateFile: string; id: string } {
  const dir = mkdtempSync(join(tmpdir(), "plans-restart-"));
  const dbFile = join(dir, "app.db");
  const w = makeWorld(openDb(dbFile, true));
  w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ core: w.core.data, connect: w.connect.data }));
  return { w, dbFile, stateFile, id };
}
/** Runs one tick in a child process. True when the process was killed. */
function tickIn(c: ReturnType<typeof setup>, crashAt: string, at: number, script = ""): boolean {
  const r = spawnSync(process.execPath, ["--no-warnings", CHILD, c.dbFile, c.stateFile, c.id, crashAt, String(at), script], { encoding: "utf8", timeout: 30_000 });
  if (r.signal !== "SIGKILL" && r.status !== 0) throw new Error(`child failed: ${r.stderr.slice(0, 2000)}`);
  return r.signal === "SIGKILL";
}
const load = (c: ReturnType<typeof setup>) => JSON.parse(readFileSync(c.stateFile, "utf8")) as { core: World["core"]["data"]; connect: World["connect"]["data"] };
const store = (c: ReturnType<typeof setup>, s: ReturnType<typeof load>) => writeFileSync(c.stateFile, JSON.stringify(s));
const planOf = (c: ReturnType<typeof setup>) => {
  const db = openDb(c.dbFile, false);
  return { plan: getPlan(db, c.id) as Record<string, unknown>, steps: stepsOf(db, c.id) };
};

test("killed after Core stored the draft, before the answer was saved: the next process gets the same draft; one draft for the owner", () => {
  const c = setup();
  assert.equal(tickIn(c, "core_request_stored", T0), true, "the process really died");
  const before = planOf(c);
  assert.equal(before.plan.state, "preparing");
  assert.ok(before.plan.draft_key, "the key was persisted before the call");
  assert.equal(load(c).core.drafts.length, 1);
  assert.equal(tickIn(c, "", T0 + 60_000), false);
  assert.equal(planOf(c).plan.state, "waiting");
  assert.equal(planOf(c).plan.draft_key, before.plan.draft_key);
  assert.equal(load(c).core.drafts.length, 1);
  assert.equal(load(c).core.requests, 1);
});

function approved(): ReturnType<typeof setup> {
  const c = setup();
  assert.equal(tickIn(c, "", T0), false);
  const s = load(c);
  const w = makeWorld();
  w.core.data = s.core;
  w.connect.data = s.connect;
  approveAndDeliver(w, String(planOf(c).plan.draft_key), HENRY);
  store(c, { core: w.core.data, connect: w.connect.data });
  return c;
}

for (const [point, script, ended] of [
  ["store_after_effect", { kind: "crash_after" }, "the store ended it, nobody heard"],
  ["store_answered", {}, "the store answered, nobody saved it"],
  ["store_before_effect", { kind: "crash_before" }, "the store died before the effect"],
] as const) {
  test(`killed mid-revoke, ${ended}: the next process lists first; the item ends exactly once`, () => {
    const c = approved();
    assert.equal(tickIn(c, point, T0 + 60_000, JSON.stringify(script)), true, "the process really died");
    const mid = planOf(c);
    const step = mid.steps.find((s) => s.item_id === "account_as_itself:a") as Record<string, unknown>;
    assert.equal(step.state, "sending", "attempt and key were persisted before the call");
    assert.equal(step.attempt, 1);
    assert.ok(step.key);
    assert.notEqual(mid.plan.state, "done", "a crash never reads as done");
    assert.equal(tickIn(c, "", T0 + 120_000), false);
    const end = planOf(c);
    assert.equal(end.plan.state, "done");
    assert.equal((end.steps.find((s) => s.item_id === "account_as_itself:a") as Record<string, unknown>).state, "done");
    assert.deepEqual(load(c).connect.ended, ["account_as_itself:a"]);
  });
}

test("killed with the plan waiting: nothing is lost and the draft stays one", () => {
  const c = setup();
  assert.equal(tickIn(c, "", T0), false);
  assert.equal(tickIn(c, "", T0 + 60_000), false);
  assert.equal(planOf(c).plan.state, "waiting");
  assert.equal(load(c).core.drafts.length, 1);
});

test("restore: Fleet comes back from an older copy with the plan `waiting`; Core has applied meanwhile: Core is read first, then the store is listed, then it goes on once", () => {
  const c = setup();
  assert.equal(tickIn(c, "", T0), false);
  const s = load(c);
  const w = makeWorld();
  w.core.data = s.core;
  w.connect.data = s.connect;
  approveAndDeliver(w, String(planOf(c).plan.draft_key), HENRY);
  // the store had already ended it before the restore dropped that from Governance's memory
  w.connect.data.rows = [];
  w.connect.data.ended = ["account_as_itself:a"];
  store(c, { core: w.core.data, connect: w.connect.data });
  assert.equal(tickIn(c, "", T0 + 60_000), false);
  const end = planOf(c);
  assert.equal(end.plan.state, "done");
  assert.equal((end.steps.find((x) => x.item_id === "account_as_itself:a") as Record<string, unknown>).code, "already_gone");
  assert.equal(load(c).connect.handled.length, 0, "no call for what is gone");
});

test("boot with Core down: a plan that Core may have applied runs no store step until Core has answered", async () => {
  const w = makeWorld();
  w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
  leave(w);
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  w.core.down = true;
  await w.tick(id);
  assert.equal(w.connect.data.handled.length, 0);
  assert.equal(w.plan(id).state, "waiting");
  w.core.down = false;
  await w.tick(id);
  assert.equal(w.plan(id).state, "done");
});
