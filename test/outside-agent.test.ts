// The owner form "Add outside agent" (C373 WP-D, Q13): person_set takes kind, org and relationship. Coordinator rule: an
// outside agent the owner adds starts `unreviewed`; trust is an explicit act, a real review verdict (review_get → review_record).
// A person the owner adds keeps the default (`trusted`). Quiet on good / fire on bad.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../src/app.ts";
import { AGENT_A, migratedDb } from "./helpers.ts";
import { SECRETS, seed } from "./seed.ts";

const log = { debug() {}, info() {}, warn() {}, error() {} };
const OWNER = { type: "person", id: "per_01J0000000000000000000000P", name: "owner", mode: null };
const ctx = (db: ReturnType<typeof migratedDb>, caller: object = OWNER) => ({ db, caller, log }) as unknown as OpContext;
type Run = { run(i: unknown, c: OpContext): Promise<unknown> };
const run = (id: string, input: unknown, c: OpContext) => (handlers as unknown as Record<string, Run>)[id]?.run(input, c) as Promise<Record<string, any>>;
const schemas = (id: string) => manifest.operations.find((o) => o.id === id) as unknown as { input: Parameters<typeof validateAgainstSchema>[0]; output: Parameters<typeof validateAgainstSchema>[0] };
const okIn = (id: string, v: unknown) => validateAgainstSchema(schemas(id).input, v as Json).ok;
const okOut = (id: string, v: unknown) => validateAgainstSchema(schemas(id).output, v as Json).ok;

test("input: kind is person or outside_agent; org and relationship are text up to 120; trust and source cannot be sent", () => {
  assert.equal(okIn("person_set", { name: "Partner Bot", kind: "outside_agent", org: "Acme", relationship: "Supplier's agent", handles: ["slack:W0BOT999"] }), true);
  for (const bad of [{ name: "x", kind: "agent" }, { name: "x", org: "o".repeat(121) }, { name: "x", relationship: 5 }, { name: "x", trust: "trusted" }, { name: "x", source: "owner" }]) assert.equal(okIn("person_set", bad), false, JSON.stringify(bad));
});

test("an outside agent the owner adds starts unreviewed, with org and relationship; a person the owner adds starts trusted", async () => {
  const db = migratedDb();
  const o = ctx(db);
  const bot = await run("person_set", { name: "Partner Bot", kind: "outside_agent", org: " Acme Ltd ", relationship: "Supplier", handles: ["slack:W0BOT999"] }, o);
  assert.equal(okOut("person_set", bot), true);
  assert.deepEqual([bot.person.kind, bot.person.trust, bot.person.org, bot.person.relationship, bot.person.handles], ["outside_agent", "unreviewed", "Acme Ltd", "Supplier", ["slack:W0BOT999"]]);
  const ann = await run("person_set", { name: "Ann" }, o);
  assert.deepEqual([ann.person.kind, ann.person.trust, ann.person.org, ann.person.relationship], ["person", "trusted", "", ""]);
  const ov = await run("overview_get", {}, o);
  assert.equal(okOut("overview_get", ov), true);
  assert.equal(ov.people.find((p: any) => p.id === bot.person.id).org, "Acme Ltd");
  // it is in the topology as an outside agent, unreviewed
  const topo = await run("topology_get", { layers: ["org"] }, o);
  assert.deepEqual(topo.nodes.filter((n: any) => n.kind === "outside_agent").map((n: any) => [n.name, n.trust]), [["Partner Bot", "unreviewed"]]);
});

test("an edit without org or relationship keeps them; an edit with them replaces them (even with empty text)", async () => {
  const db = migratedDb();
  const o = ctx(db);
  const bot = (await run("person_set", { name: "Bot", kind: "outside_agent", org: "Acme", relationship: "Supplier" }, o)).person;
  const renamed = (await run("person_set", { id: bot.id, name: "Bot 2" }, o)).person;
  assert.deepEqual([renamed.name, renamed.org, renamed.relationship, renamed.kind, renamed.trust], ["Bot 2", "Acme", "Supplier", "outside_agent", "unreviewed"]);
  const only = (await run("person_set", { id: bot.id, name: "Bot 2", org: "" }, o)).person;
  assert.deepEqual([only.org, only.relationship], ["", "Supplier"]);
  // trust is not touched by an edit: a recorded verdict stays
  const digest = (await run("review_get", { subject: { kind: "outside_agent", id: bot.id } }, o)).current.digest;
  await run("review_record", { subject: { kind: "outside_agent", id: bot.id }, verdict: "trusted", reason: "Known supplier", snapshotDigest: digest }, o);
  const after = (await run("person_set", { id: bot.id, name: "Bot 3", relationship: "Partner" }, o)).person;
  assert.deepEqual([after.trust, after.relationship], ["trusted", "Partner"]);
});

test("Trust is an explicit act: review_get then review_record makes it trusted; a stale digest is refused and trust stays unreviewed", async () => {
  const db = migratedDb();
  const o = ctx(db);
  const bot = (await run("person_set", { name: "Bot", kind: "outside_agent", handles: ["slack:W0BOT999"] }, o)).person;
  const subject = { kind: "outside_agent", id: bot.id };
  const view = await run("review_get", { subject }, o);
  assert.equal(view.review, null, "no verdict yet");
  // fire on bad: a digest of something else
  await assert.rejects(run("review_record", { subject, verdict: "trusted", reason: "x", snapshotDigest: "0".repeat(64) }, o), (e: any) => e.code === "snapshot_stale" && e.httpStatus === 409);
  assert.equal((await run("overview_get", {}, o)).people.find((p: any) => p.id === bot.id).trust, "unreviewed");
  // quiet on good
  const done = await run("review_record", { subject, verdict: "trusted", reason: "Trusted by the owner when added.", snapshotDigest: view.current.digest }, o);
  assert.equal(done.review.verdict, "trusted");
  assert.equal((await run("overview_get", {}, o)).people.find((p: any) => p.id === bot.id).trust, "trusted");
  // the verdict is in the history with its snapshot
  const list = await run("reviews_list", { status: "done" }, o);
  assert.ok(JSON.stringify(list).includes(bot.id));
});

test("C88: org and relationship are owner-side text: no agent op, hook fact or feed answer carries them", async () => {
  const db = migratedDb();
  seed(db);
  const agent = { type: "agent", id: AGENT_A.id, name: AGENT_A.name, mode: "free" };
  const outs = [
    await run("directory_get", {}, ctx(db, agent)),
    await run("teams_list", {}, ctx(db, agent)),
    await run("team_get", { team: "Support" }, ctx(db, agent)),
    await run("resolve_sender", { handle: "slack:W0BOT123" }, ctx(db, agent)),
    await run("directory_feed", {}, ctx(db, { type: "app", id: "ins_rules", product: "rules", listed: true })),
  ];
  const text = JSON.stringify(outs);
  for (const secret of ["Partner Org Ltd", "secret-relationship"]) assert.ok(!text.includes(secret), secret);
  assert.ok(SECRETS.includes("Partner Org Ltd"));
  // and the owner's own view has them (the scan is not vacuous)
  assert.ok(JSON.stringify(await run("overview_get", {}, ctx(db))).includes("Partner Org Ltd"));
});
