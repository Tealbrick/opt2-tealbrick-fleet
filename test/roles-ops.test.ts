// C380 T2-a: the role ops are person ops, last in the manifest. An agent or an app is refused by the handler and nothing changes; the owner's answers fit the manifest.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema, validateManifest } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../src/app.ts";
import * as store from "../src/store.ts";
import { AGENT_A } from "./helpers.ts";
import { refused, world } from "./lifecycle-helpers.ts";

const ROLE_OPS = ["roles_list", "role_get", "role_set", "role_assign", "role_end"];
const AGENT_CALLER = { type: "agent", id: AGENT_A.id, name: AGENT_A.name, mode: "free" };
const APP_CALLER = { type: "app", id: "ins_x", product: "rules", listed: true };
const PERSON_CALLER = { type: "person", id: "per_owner", name: "owner", mode: null };
type Run = { run(i: unknown, c: OpContext): Promise<unknown> };
const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const ctxOf = (db: Db, caller: object) => ({ db, caller, log: LOG, callApp: async () => ({ status: "ok", output: {} }), companionTargets: () => [], topology: () => null, ownerLink: () => null }) as unknown as OpContext;
const run = (id: string, input: unknown, c: OpContext) => (handlers as unknown as Record<string, Run>)[id]?.run(input, c) as Promise<Record<string, any>>;
const specOf = (id: string) => manifest.operations.find((o) => o.id === id) as unknown as { audience: string; effect: string; idempotency: string; output: Parameters<typeof validateAgainstSchema>[0]; input: Parameters<typeof validateAgainstSchema>[0] };
const validOut = (id: string, out: unknown) => {
  const v = validateAgainstSchema(specOf(id).output, out as Json);
  assert.deepEqual(v.ok ? [] : v.errors, [], `${id} output`);
};
const validIn = (id: string, input: unknown) => validateAgainstSchema(specOf(id).input, input as Json).ok;

test("the role ops are person ops, appended last; the agent surface did not change", () => {
  assert.equal(validateManifest(manifest).ok, true);
  const ids = manifest.operations.map((o) => o.id as string);
  // the block is whole, and after it come only the ops of the Tier 2 lanes that stack on this one ("Cannot hold both", T2-c)
  const at = ids.indexOf("roles_list");
  assert.deepEqual(ids.slice(at, at + ROLE_OPS.length), ROLE_OPS, "appended after every op of the lanes before");
  assert.deepEqual(ids.slice(at + ROLE_OPS.length), ["exclusions_list", "exclusion_set"]);
  for (const id of ROLE_OPS) assert.equal(specOf(id).audience, "person", id);
  assert.deepEqual(manifest.operations.filter((o) => (o as { audience?: string }).audience !== "person").map((o) => o.id), ["teams_list", "team_get", "directory_get", "resolve_sender", "review_request", "directory_feed"]);
  assert.equal(specOf("role_assign").idempotency, "required");
  assert.equal(specOf("role_set").idempotency, "required");
});

test("input: a reason outside the list, a bad subject kind and an extra field are refused by the schema", () => {
  const ok = { role: "rol_1", subject: { kind: "agent", id: "agt_1" }, reason: "project" };
  assert.equal(validIn("role_assign", ok), true);
  assert.equal(validIn("role_assign", { ...ok, reason: "free text" }), false);
  assert.equal(validIn("role_assign", { ...ok, subject: { kind: "outside_agent", id: "x" } }), false);
  assert.equal(validIn("role_assign", { ...ok, extra: 1 }), false);
  assert.equal(validIn("role_set", { name: "" }), false);
});

test("an agent or an app calling a role op is refused by the handler too, and nothing changes; the owner's answers fit the manifest", async () => {
  const { db, ann } = world();
  const rev = store.revision(db);
  const inputs: Record<string, unknown> = {
    roles_list: {},
    role_get: { id: "rol_x" },
    role_set: { name: "Contractor" },
    role_assign: { role: "rol_x", subject: { kind: "agent", id: AGENT_A.id }, reason: "other" },
    role_end: { assignment: "ras_x" },
  };
  for (const caller of [AGENT_CALLER, APP_CALLER, { ...AGENT_CALLER, mode: "bound", wf: ROLE_OPS }]) {
    for (const id of ROLE_OPS) await assert.rejects(run(id, inputs[id], ctxOf(db, caller)), refused("no_access", 403), `${id} as ${caller.type}`);
  }
  assert.equal(store.revision(db), rev);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_roles").get()?.n), 0);

  const owner = ctxOf(db, PERSON_CALLER);
  const made = await run("role_set", { name: "Contractor", description: "Works for a limited time" }, owner);
  validOut("role_set", made);
  const id = made.role.id as string;
  const given = await run("role_assign", { role: id, subject: { kind: "person", id: ann.id }, reason: "contract", validUntil: new Date(Date.now() + 86_400_000).toISOString() }, owner);
  validOut("role_assign", given);
  const listed = await run("roles_list", {}, owner);
  validOut("roles_list", listed);
  assert.deepEqual([listed.roles[0].members, listed.assignments], [1, []]);
  const forAnn = await run("roles_list", { subject: { kind: "person", id: ann.id } }, owner);
  validOut("roles_list", forAnn);
  assert.equal(forAnn.assignments[0].role.name, "Contractor");
  const got = await run("role_get", { id }, owner);
  validOut("role_get", got);
  assert.equal(got.assignments.length, 1);
  const ended = await run("role_end", { assignment: given.assignment.id }, owner);
  validOut("role_end", ended);
  assert.equal(ended.assignment.state, "ended");
  assert.equal((await run("roles_list", { includeArchived: true }, owner)).roles[0].members, 0);
  await assert.rejects(run("role_end", { assignment: given.assignment.id }, owner), refused("already_ended", 409));
  const archived = await run("role_set", { id, archived: true }, owner);
  assert.equal(archived.role.archived, true);
  assert.deepEqual((await run("roles_list", {}, owner)).roles, [], "an archived role is not listed unless asked");
});
