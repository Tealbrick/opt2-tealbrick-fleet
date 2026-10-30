// The runner on the real SDK job runner: real boot, real migrations, real jobs table, a real restart. Standalone has no bridge, so this is the rail-off path end to end.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { defineApp, startApp } from "@opt2-tealbrick/miniapp-sdk";
import { definition, manifest } from "../src/app.ts";
import { PLANS_CRON, PLANS_JOB } from "../src/plans/jobs.ts";
import { createPlan, getPlan, stepsOf } from "../src/plans/plan.ts";
import { requestForNewAgents } from "../src/reviews.ts";
import * as store from "../src/store.ts";
import { dbOver } from "./helpers.ts";
import { OWNER, set } from "./lifecycle-helpers.ts";
import { HENRY } from "./plans-world.ts";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });

async function until<T>(fn: () => T | null | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("real SDK: the clock job is there once after a restart; a plan goes on after the restart and ends in Portal link mode, with stores not read, never as done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-sdk-"));
  const boot = async () => {
    const port = await freePort();
    const local = { ...manifest, runtime: { ...manifest.runtime, port } };
    return startApp(defineApp({ ...definition, manifest: local }), { TB_DATA_DIR: dir, TB_STANDALONE: "1", TB_LOG_LEVEL: "error", TB_DATA_EPHEMERAL: "1" }, { jobs: { pollMs: 10 } });
  };
  let running = await boot();
  const clocks = () => running.jobs.list({ kind: PLANS_JOB }).filter((j) => j.cron === PLANS_CRON);
  try {
    assert.equal(clocks().length, 1);
  } finally {
    await running.stop();
  }

  // The owner's stop, written while the app is down: what a plan in the file looks like at the next boot.
  const raw = new DatabaseSync(join(dir, "app.db"));
  const db = dbOver(raw);
  const ann = store.setPerson(db, { name: "Ann" });
  const agents = [{ id: HENRY, name: "Henry", mode: "free", status: "active" }] as never;
  store.syncAgents(db, agents);
  requestForNewAgents(db, agents);
  store.setAgent(db, { agent: HENRY, owner: ann.id });
  set(db, "agent", HENRY, "active");
  set(db, "agent", HENRY, "leaving");
  const id = createPlan(db, { kind: "agent", id: HENRY, actor: OWNER }).ids[0] as string;
  raw.close();

  running = await boot();
  try {
    assert.equal(clocks().length, 1, "a restart does not add a clock");
    const kicked = running.jobs.enqueue(PLANS_JOB, {});
    await until(() => running.jobs.get(kicked.id)?.status === "done");
    const check = new DatabaseSync(join(dir, "app.db"));
    const dbc = dbOver(check);
    const plan = getPlan(dbc, id) as Record<string, unknown>;
    assert.equal(plan.rail, "portal_link");
    assert.equal(plan.state, "waiting");
    const reads = stepsOf(dbc, id).filter((s) => s.phase === "read");
    assert.equal(reads.length, 4);
    // no slice at all: Governance cannot say an app is not there, so it says "could not be read". B9b's rule.
    assert.ok(reads.every((s) => s.state === "not_read"), JSON.stringify(reads.map((s) => s.state)));
    check.close();
  } finally {
    await running.stop();
  }
});
