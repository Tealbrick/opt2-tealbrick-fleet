// Shared helpers of the lifecycle tests (C380 B9a).
import assert from "node:assert/strict";
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type TransitionInput, transition } from "../src/lifecycle/transitions.ts";
import { requestForNewAgents } from "../src/reviews.ts";
import * as store from "../src/store.ts";
import { AGENT_A, AGENT_B, migratedDb } from "./helpers.ts";

export const OWNER = { kind: "owner", id: "per_owner" } as const;
export const SYSTEM = { kind: "system", id: null } as const;
export const T0 = Date.UTC(2026, 9, 30, 12);
export const WAIVE = "Named by the owner";

export const refused = (code: string, status: number) => (e: unknown) => {
  assert.ok(e instanceof TbError, String(e));
  assert.equal(e.code, code);
  assert.equal(e.httpStatus, status);
  return true;
};
export const set = (db: Db, kind: "person" | "agent", id: string, to: TransitionInput["to"], extra: Partial<TransitionInput> = {}, now = T0) => transition(db, { kind, id, to, reason: "other", actor: OWNER, ...extra }, now);
export const stateOf = (db: Db, kind: "person" | "agent", id: string) => db.prepare(`SELECT lifecycle FROM ${kind === "agent" ? "fleet_agents" : "fleet_people"} WHERE id = ?`).get(id)?.lifecycle;

/** One active owner with one reviewed agent (A) and one new agent with no owner (B). */
export function world() {
  const db = migratedDb();
  const ann = store.setPerson(db, { name: "Ann" }, T0);
  store.syncAgents(db, [AGENT_A, AGENT_B], T0);
  requestForNewAgents(db, [AGENT_A, AGENT_B], T0);
  store.setAgent(db, { agent: AGENT_A.id, owner: ann.id }, T0);
  set(db, "agent", AGENT_A.id, "active");
  return { db, ann };
}
