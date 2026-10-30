// C380 B9b: the reader side of tb.access/1. Spec fixtures through schema and parser, the failure map, what is "not installed" and what could not be read, the pacing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { BACKOFF_MS, classify, DEFAULT_WAIT_MS, inBackoff, MAX_WAIT_MS, noteRead, noteStop, Pacer, presence, readPage, readStateOf } from "../src/access/client.ts";
import { BadAnswer, itemDigest, type ListIn, onlyAsked, parsePage, personSubject, TARGET_KINDS } from "../src/access/items.ts";
import * as store from "../src/store.ts";
import { AGT, AGT2, accessEnv, answer, fakeStores, wire } from "./access-helpers.ts";
import { migratedDb, NOSTR } from "./helpers.ts";

const file = (n: string) => readFileSync(new URL(`./contracts/${n}`, import.meta.url));
const json = (n: string) => JSON.parse(file(n).toString("utf8"));
type Schema = Parameters<typeof validateAgainstSchema>[0];

test("byte copies match spec-v0.1.89 (sha256 in docs/ACCESS.md and PROVENANCE.md)", () => {
  const shas: Record<string, string> = {
    "access.list_in.1.schema.json": "83f1c2f7c2c399d8e11a93418e469d01c777af5f6c8bfe7cd2643539f3a04fe5",
    "access.list_out.1.schema.json": "571feb6b833d392f8eec3212b21d53aa7e529dfb65a34f8a54b89d07160c7f48",
  };
  for (const [n, sha] of Object.entries(shas)) assert.equal(createHash("sha256").update(file(n)).digest("hex"), sha, n);
  const prov = file("PROVENANCE.md").toString("utf8");
  for (const n of ["access.list_in.1.json", "access.list_out.1.json", "access.digest.1.json"]) assert.ok(prov.includes(createHash("sha256").update(file(n)).digest("hex")), n);
});

test("list_out fixtures: the parser refuses every invalid doc and takes every valid one, the schema agrees", () => {
  const schema = json("access.list_out.1.schema.json") as Schema;
  const fx = json("access.list_out.1.json") as { valid: Json[]; invalid: { why: string; doc: Json }[] };
  for (const doc of fx.valid) {
    assert.equal(validateAgainstSchema(schema, doc).ok, true);
    // the fixture lists kinds of two targets in one document; a real answer has one target's, so parse each target's rows alone
    const rows = (doc as { items: { kind: string }[] }).items;
    for (const target of ["connect", "knowledge"] as const) {
      const own = rows.filter((i) => TARGET_KINDS[target].includes(i.kind));
      assert.equal(parsePage(target, { ...(doc as object), items: own }).items.length, own.length);
    }
  }
  for (const { why, doc } of fx.invalid) {
    assert.equal(validateAgainstSchema(schema, doc).ok, false, why);
    assert.throws(() => parsePage("connect", doc), BadAnswer, why);
  }
});

test("digest fixture: equal when only state, since, label, revocable, direction change; different on resource", () => {
  const fx = json("access.digest.1.json") as { target: string; digest: string; equal: { item: Parameters<typeof itemDigest>[1] }[]; different: { item: Parameters<typeof itemDigest>[1] & { digest: string } }[] };
  for (const e of fx.equal) assert.equal(itemDigest(fx.target, e.item), fx.digest);
  for (const d of fx.different) assert.equal(itemDigest(fx.target, d.item), d.item.digest);
});

test("every list_in Governance sends passes the input schema, and the list_in fixtures still say what they said", () => {
  const schema = json("access.list_in.1.schema.json") as Schema;
  const fx = json("access.list_in.1.json") as { valid: Json[]; invalid: { why: string; doc: Json }[] };
  for (const doc of fx.valid) assert.equal(validateAgainstSchema(schema, doc).ok, true);
  for (const { why, doc } of fx.invalid) assert.equal(validateAgainstSchema(schema, doc).ok, false, why);
  const db = migratedDb();
  const ann = store.setPerson(db, { name: "Ann", handles: [`buzz:${NOSTR.hex}`, "slack:u012abcdef"] });
  const sent: ListIn[] = [
    { v: 1, subjects: [{ kind: "all" }], limit: 200, sweepId: "swp_01J0000000000000000000000A" },
    { v: 1, subjects: [personSubject(db, ann.id), { kind: "agent", id: AGT }, { kind: "unlinked" }], cursor: "c", limit: 200 },
  ];
  for (const doc of sent) assert.equal(validateAgainstSchema(schema, doc as unknown as Json).ok, true, JSON.stringify(doc));
});

test("a person's handle the schema would refuse is left out, so one bad row does not fail the whole call", () => {
  const db = migratedDb();
  const ann = store.setPerson(db, { name: "Ann", handles: ["slack:u012abcdef"] });
  db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES ('slack:lowercase bad', ?, 1)").run(ann.id);
  assert.deepEqual(personSubject(db, ann.id), { kind: "person", id: ann.id, handles: ["slack:U012ABCDEF"] });
});

test("parsePage: quiet on a good row; refuses a wrong digest, another target's kind, a kind that does not match the id, a wrong sweepId", () => {
  const good = wire("evolution", { id: "routine:a", kind: "routine" });
  assert.equal(parsePage("evolution", answer([good]).output).items.length, 1);
  assert.equal(parsePage("evolution", answer([good], { sweepId: "s1" }).output, "s1").items.length, 1);
  assert.throws(() => parsePage("evolution", answer([{ ...good, digest: `sha256:${"0".repeat(64)}` }]).output), /digest/);
  assert.throws(() => parsePage("connect", answer([good]).output), /kind/, "Evolution's kind from Connect");
  assert.throws(() => parsePage("knowledge", answer([wire("connect", { id: "routine:a", kind: "routine" })]).output), /kind/);
  // the digest of another target: an app cannot pass a row off as another app's
  assert.throws(() => parsePage("connect", answer([wire("evolution", { id: "account_as_itself:a", kind: "account_as_itself" })]).output), /digest/);
  assert.throws(() => parsePage("evolution", answer([wire("evolution", { id: "other:a", kind: "routine" })]).output), /kind/);
  assert.throws(() => parsePage("evolution", answer([], { sweepId: "other" }).output, "s1"), /sweepId/);
  assert.throws(() => parsePage("evolution", null), BadAnswer);
});

test("parsePage: label and reason are cleaned, nothing comes out empty", () => {
  const p = parsePage("evolution", answer([wire("evolution", { id: "routine:a", kind: "routine", label: "Nightly‮​ digest" }), wire("evolution", { id: "routine:b", kind: "routine", label: "​" })], { notShown: [{ kind: "held_calls", reason: "Held‮ calls" }] }).output);
  assert.equal(p.items[0]?.label, "Nightly digest");
  assert.equal(p.items[1]?.label, "Unnamed");
  assert.equal(p.notShown[0]?.reason, "Held calls");
});

test("onlyAsked: a row about someone not asked for is dropped; under all nothing is", () => {
  const mine = parsePage("evolution", answer([wire("evolution", { id: "routine:a", kind: "routine" }), wire("evolution", { id: "routine:b", kind: "routine", subject: { kind: "agent", id: AGT2 } }), wire("evolution", { id: "routine:c", kind: "routine", subject: { kind: "unlinked" } })]).output).items;
  assert.deepEqual(onlyAsked(mine, [{ kind: "agent", id: AGT }]).map((i) => i.id), ["routine:a"]);
  assert.deepEqual(onlyAsked(mine, [{ kind: "agent", id: AGT }, { kind: "unlinked" }]).map((i) => i.id), ["routine:a", "routine:c"]);
  assert.equal(onlyAsked(mine, [{ kind: "all" }]).length, 3);
});

test("failure map: each answer has one state, and only the states the table names", () => {
  const cases: [TbError, string, string][] = [
    [new TbError("unknown_tool", "x", 404), "not_read", "unknown_tool"],
    [new TbError("companion_undeclared", "x", 500), "not_read", "companion_undeclared"],
    [new TbError("no_grant", "x", 403), "not_read", "no_grant"],
    [new TbError("no_access", "x", 403), "not_read", "no_access"],
    [new TbError("caller_unverified", "x", 403), "not_read", "caller_unverified"],
    [new TbError("app_error", "x", 503), "not_read", "app_error"],
    [new TbError("hook_denied", "Refused by company policy", 403), "refused", "hook_denied"],
    [new TbError("hold_denied", "denied", 403), "refused", "hold_denied"],
  ];
  for (const [e, state, code] of cases) {
    const a = classify(e);
    assert.ok(!a.ok);
    assert.deepEqual([a.state, a.code], [state, code]);
    assert.equal(a.backoffMs, state === "refused" ? BACKOFF_MS : 0);
    assert.ok(a.text.length > 0);
    assert.ok(!a.text.includes(code), "plain words, no code");
  }
  const plain = classify(new Error("socket hang up"));
  assert.ok(!plain.ok && plain.state === "not_read" && !plain.text.includes("socket"), "an unknown error shows no detail");
});

test("429: fixed wait when the SDK gives no time, the time when it does, never beyond the cap", () => {
  const w = (d?: Record<string, unknown>) => {
    const a = classify(new TbError("rate_limited", "x", 429, d));
    assert.ok(!a.ok);
    return a.waitMs;
  };
  assert.equal(w(), DEFAULT_WAIT_MS);
  assert.equal(w({ retryAfterMs: 1234 }), 1234);
  assert.equal(w({ retryAfterMs: MAX_WAIT_MS * 10 }), MAX_WAIT_MS);
  assert.equal(w({ retryAfterMs: "soon" }), DEFAULT_WAIT_MS);
});

test("readPage: a page, a hold, a malformed answer and a hanging store each read as what they are", async () => {
  const good = answer([wire("kanban", { id: "assignment:a", kind: "assignment" })]);
  const f = fakeStores({ kanban: () => good, connect: () => ({ status: "held", holdId: "h" }), knowledge: () => ({ status: "ok", output: { v: 2 } }), evolution: () => new Promise(() => {}) });
  const env = accessEnv(f.callApp);
  const input: ListIn = { v: 1, subjects: [{ kind: "all" }] };
  const page = await readPage(env, "kanban", input);
  assert.ok(page.ok && page.page.items.length === 1);
  const held = await readPage(env, "connect", input);
  assert.ok(!held.ok && held.state === "waiting" && held.backoffMs === BACKOFF_MS);
  const malformed = await readPage(env, "knowledge", input);
  assert.ok(!malformed.ok && malformed.state === "not_read" && malformed.code === "bad_answer");
  const hung = await readPage(env, "evolution", input, 20);
  assert.ok(!hung.ok && hung.state === "not_read" && hung.code === "timeout");
});

test("presence: installed, not installed and not known are three answers, and no answer calls the store", () => {
  const f = fakeStores({});
  const env = (targets: string[], over: Partial<ReturnType<typeof accessEnv>> = {}) => ({ ...accessEnv(f.callApp, targets), declared: new Set(["connect", "kanban"]), ...over });
  assert.equal(presence(env(["connect"]), "connect"), "present");
  assert.equal(presence(env(["connect"]), "kanban"), "not_installed", "declared, no grant, the slice is current");
  assert.equal(presence(env(["connect"]), "evolution"), "not_installed", "not in the manifest, the slice is current");
  assert.equal(presence(env(["connect"], { bridgeCaps: () => [] }), "kanban"), "not_read", "no current workspace copy says nothing about what is installed");
  assert.equal(presence(env(["evolution"]), "evolution"), "not_read", "a grant but not in this version's manifest: it is installed");
  assert.equal(presence(env(["connect"], { topology: () => ({ instances: [["ins_1", "evolution", "Evolving Workflows", "0.4.3"]] }) }), "evolution"), "not_read", "the owner's picture lists it: never 'not installed'");
  assert.equal(presence(env(["connect"], { topology: () => { throw new Error("bad"); } }), "kanban"), "not_installed", "a bad picture is no picture");
  assert.equal(f.calls.length, 0);
});

test("backoff: a refused read holds, a manual check may repeat it, a held read never repeats early; a full read ends it", () => {
  const db = migratedDb();
  noteStop(db, "connect", { state: "refused", code: "hook_denied", text: "No", backoffMs: 1000 }, 5000);
  assert.ok(inBackoff(db, "connect", 5999));
  assert.equal(inBackoff(db, "connect", 6000), null, "it ends");
  assert.equal(inBackoff(db, "connect", 5999, true), null, "manual");
  noteStop(db, "connect", { state: "waiting", code: "held", text: "Wait", backoffMs: 1000 }, 7000);
  assert.ok(inBackoff(db, "connect", 7999, true), "manual does not make a new hold");
  noteRead(db, "connect", [{ kind: "held_calls", reason: "r" }], 9000);
  assert.equal(inBackoff(db, "connect", 9000), null);
  assert.deepEqual(readStateOf(db, "connect")?.notShown, [{ kind: "held_calls", reason: "r" }]);
  noteStop(db, "connect", { state: "not_read", code: "timeout", text: "Late" }, 10_000);
  const s = readStateOf(db, "connect");
  assert.equal(s?.readAt, 9000, "the old list keeps its time");
  assert.deepEqual(s?.notShown, [{ kind: "held_calls", reason: "r" }]);
});

test("Pacer: two at a time, first come first served; a hanging call frees its place at the timeout", async () => {
  const p = new Pacer(0, 0);
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  const job = (i: number) => async () => {
    active++;
    peak = Math.max(peak, active);
    order.push(i);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return i;
  };
  assert.deepEqual(await Promise.all([0, 1, 2, 3, 4].map((i) => p.run(job(i), 1000))), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
  const hang = () => new Promise<number>(() => {});
  await assert.rejects(p.run(hang, 10));
  await assert.rejects(p.run(hang, 10));
  assert.equal(await p.run(async () => 7, 1000), 7, "two calls that never end stop nothing");
});

test("Pacer: the gap holds between starts", async () => {
  const p = new Pacer(30, 0);
  const at: number[] = [];
  await Promise.all([0, 1, 2].map(() => p.run(async () => at.push(Date.now()), 1000)));
  assert.ok((at[2] as number) - (at[0] as number) >= 55, `${at[2]} - ${at[0]}`);
});
