// A real sweep over a fake store, for tests that need the history a sweep leaves (C380 T2-b): the job context writes the job state and the app's rows in one transaction.
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessEnv } from "../src/access/client.ts";
import { type SweepEnv, sweepTick } from "../src/access/sweep.ts";
import { accessEnv, fakeStores } from "./access-helpers.ts";

export const NONE = { status: "ok", output: { v: 1, asOf: "2026-10-30T16:00:00Z", items: [], nextCursor: null, notShown: [], complete: true } };
export const quiet = { connect: () => NONE, knowledge: () => NONE, kanban: () => NONE, evolution: () => NONE };

export function jobEnv(db: Db, base: AccessEnv, clock: { now: number }): SweepEnv {
  const held: { state: Json | null } = { state: null };
  return {
    ...base,
    db,
    now: () => clock.now++,
    job: { input: { by: "schedule" }, get state() { return held.state; } } as unknown as SweepEnv["job"],
    checkpoint: ((state: Json, write?: (d: Db) => unknown) =>
      db.transaction(() => {
        const out = write?.(db);
        held.state = state;
        return out;
      })) as SweepEnv["checkpoint"],
  };
}

/** One whole sweep. A reply that throws is a store that cannot be read. */
export async function runSweep(db: Db, replies: Parameters<typeof fakeStores>[0], clock: { now: number }): Promise<void> {
  const env = jobEnv(db, accessEnv(fakeStores({ ...quiet, ...replies }).callApp), clock);
  for (let i = 0; i < 400; i++) if ((await sweepTick({}, env))?.status === "done") return;
  throw new Error("the sweep did not end");
}
