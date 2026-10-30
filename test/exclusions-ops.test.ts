// C380 T2-c: the two "Cannot hold both" ops are person ops, last in the manifest. An agent or an app is refused by the handler and nothing changes; the
// owner's answers fit the manifest; a refused assignment through the op names both roles.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema, validateManifest } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../src/app.ts";
import { AGENT_A } from "./helpers.ts";
import { refused, world } from "./lifecycle-helpers.ts";

const EXCLUSION_OPS = ["exclusions_list", "exclusion_set"];
const AGENT_CALLER = { type: "agent", id: AGENT_A.id, name: AGENT_A.name, mode: "free" };
const APP_CALLER = { type: "app", id: "ins_x", product: "rules", listed: true };
const PERSON_CALLER = { type: "person", id: "per_owner", name: "owner", mode: null };
type Run = { run(i: unknown, c: OpContext): Promise<unknown> };
const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const ctxOf = (db: Db, caller: object) => ({ db, caller, log: LOG, callApp: async () => ({ status: "ok", output: {} }), companionTargets: () => [], topology: () => null, ownerLink: () => null }) as unknown as OpContext;
const run = (id: string, input: unknown, c: OpContext) => (handlers as unknown as Record<string, Run>)[id]?.run(input, c) as Promise<Record<string, any>>;
const specOf = (id: string) => manifest.operations.find((o) => o.id === id) as unknown as { audience: string; effect: string; idempotency: string; description: string; output: Parameters<typeof validateAgainstSchema>[0]; input: Parameters<typeof validateAgainstSchema>[0] };
const validOut = (id: string, out: unknown) => {
  const v = validateAgainstSchema(specOf(id).output, out as Json);
  assert.deepEqual(v.ok ? [] : v.errors, [], `${id} output`);
};
const validIn = (id: string, input: unknown) => validateAgainstSchema(specOf(id).input, input as Json).ok;

test("the two ops are person ops, appended last, with the roles-only line in their words; the agent surface did not change", () => {
  assert.equal(validateManifest(manifest).ok, true);
  const ids = manifest.operations.map((o) => o.id as string);
  assert.deepEqual(ids.slice(-EXCLUSION_OPS.length), EXCLUSION_OPS, "appended after every op of the lanes before");
  for (const id of EXCLUSION_OPS) {
    assert.equal(specOf(id).audience, "person", id);
    assert.match(specOf(id).description, /This checks roles only\. Portal grants are not checked\./, id);
  }
  assert.equal(specOf("exclusion_set").idempotency, "required");
  assert.equal(specOf("exclusions_list").effect, "read");
  assert.deepEqual(
    manifest.operations.filter((o) => (o as { audience?: string }).audience !== "person").map((o) => o.id),
    ["teams_list", "team_get", "directory_get", "resolve_sender", "review_request", "directory_feed"],
  );
});

test("input: a kind outside the list, an extra field and an over-long note are refused by the schema", () => {
  const ok = { kind: "roles", roleA: "rol_1", roleB: "rol_2" };
  assert.equal(validIn("exclusion_set", ok), true);
  assert.equal(validIn("exclusion_set", { ...ok, kind: "anything" }), false);
  assert.equal(validIn("exclusion_set", { ...ok, extra: 1 }), false);
  assert.equal(validIn("exclusion_set", { ...ok, note: "x".repeat(301) }), false);
  assert.equal(validIn("exclusion_set", { id: "xcl_1", archived: true }), true);
  assert.equal(validIn("exclusions_list", { includeArchived: "yes" }), false);
});

test("an agent or an app calling either op is refused by the handler too, and nothing changes; the owner's answers fit the manifest", async () => {
  const { db, ann } = world();
  const inputs: Record<string, unknown> = { exclusions_list: {}, exclusion_set: { kind: "roles", roleA: "rol_1", roleB: "rol_2" } };
  for (const caller of [AGENT_CALLER, APP_CALLER, { ...AGENT_CALLER, mode: "bound", wf: EXCLUSION_OPS }]) {
    for (const id of EXCLUSION_OPS) await assert.rejects(run(id, inputs[id], ctxOf(db, caller)), refused("no_access", 403), `${id} as ${caller.type}`);
  }
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_exclusions").get()?.n), 0);

  const owner = ctxOf(db, PERSON_CALLER);
  const approver = (await run("role_set", { name: "Approver" }, owner)).role.id as string;
  const payer = (await run("role_set", { name: "Payer" }, owner)).role.id as string;
  const made = await run("exclusion_set", { kind: "roles", roleA: approver, roleB: payer, note: "Policy 4" }, owner);
  validOut("exclusion_set", made);
  assert.equal(made.rule.note, "Policy 4");
  await assert.rejects(run("exclusion_set", { kind: "roles", roleA: payer, roleB: approver }, owner), refused("rule_exists", 409));
  await run("role_assign", { role: approver, subject: { kind: "person", id: ann.id }, reason: "project" }, owner);
  // the assignment op refuses with a sentence that names both roles
  await assert.rejects(run("role_assign", { role: payer, subject: { kind: "person", id: ann.id }, reason: "project" }, owner), (e: unknown) => {
    refused("cannot_hold_both", 409)(e);
    assert.match((e as Error).message, /Approver/);
    assert.match((e as Error).message, /Payer/);
    return true;
  });
  const listed = await run("exclusions_list", {}, owner);
  validOut("exclusions_list", listed);
  assert.deepEqual([listed.rules.length, listed.rules[0].clashCount, listed.rules[0].idle], [1, 0, false]);
  const archived = await run("exclusion_set", { id: made.rule.id, archived: true }, owner);
  validOut("exclusion_set", archived);
  assert.deepEqual((await run("exclusions_list", {}, owner)).rules, [], "an archived rule is not listed unless asked");
  const all = await run("exclusions_list", { includeArchived: true }, owner);
  validOut("exclusions_list", all);
  assert.equal(all.rules[0].archived, true);
  // with the rule archived the role can be given
  assert.equal((await run("role_assign", { role: payer, subject: { kind: "person", id: ann.id }, reason: "project" }, owner)).assignment.state, "active");
});
