// C380 T2-d (PR 1): person_set gets an optional end date (a contractor). It is saved in the same transaction as the person, so a
// refusal leaves no half-added contractor with no end date. Each guard has one quiet-on-good and one fire-on-bad test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../src/app.ts";
import { tickDates } from "../src/lifecycle/validity.ts";
import { colleaguesList } from "../src/lifecycle/view.ts";
import * as store from "../src/store.ts";
import { migratedDb } from "./helpers.ts";
import { refused, T0 } from "./lifecycle-helpers.ts";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const people = (db: Db) => Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_people").get()?.n);
const untilOf = (db: Db, id: string) => db.prepare("SELECT valid_until FROM fleet_people WHERE id = ?").get(id)?.valid_until;
const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const OWNER_CALLER = { type: "person", id: "per_owner", name: "owner", mode: null };
const ctxOf = (db: Db, caller: object) => ({ db, caller, log: LOG, callApp: async () => ({ status: "ok", output: {} }), companionTargets: () => [], topology: () => null, ownerLink: () => null }) as unknown as OpContext;
const personSet = (input: unknown, db: Db, caller: object = OWNER_CALLER) => (handlers as unknown as Record<string, { run(i: unknown, c: OpContext): Promise<{ person: { id: string } }> }>).person_set?.run(input, ctxOf(db, caller)) as Promise<{ person: { id: string } }>;

test("quiet on good: a contractor is saved with an end date in one call, and the date is on the entry", () => {
  const db = migratedDb();
  const p = store.setPerson(db, { name: "Dana", tags: ["contractor"], validUntil: iso(T0 + 30 * DAY) }, T0);
  assert.equal(untilOf(db, p.id), T0 + 30 * DAY);
  assert.equal(db.prepare("SELECT lifecycle FROM fleet_people WHERE id = ?").get(p.id)?.lifecycle, "active");
  const row = colleaguesList(db, { kind: "person" }, T0).items.find((r) => r.id === p.id);
  assert.equal(row?.validUntil, iso(T0 + 30 * DAY));
  const note = db.prepare("SELECT note FROM fleet_lifecycle_events WHERE subject_id = ? AND kind = 'changed'").get(p.id)?.note;
  assert.match(String(note), /End date 2026-11-29/);
});

test("quiet on good: no end date given leaves the date as it was; null clears it", () => {
  const db = migratedDb();
  const p = store.setPerson(db, { name: "Dana", validUntil: iso(T0 + DAY) }, T0);
  store.setPerson(db, { id: p.id, name: "Dana R" }, T0);
  assert.equal(untilOf(db, p.id), T0 + DAY, "an edit with no end date does not touch it");
  store.setPerson(db, { id: p.id, name: "Dana R", validUntil: null }, T0);
  assert.equal(untilOf(db, p.id), null);
});

test("fire on bad: a date that has passed is refused 409 and the person is not created", () => {
  const db = migratedDb();
  const rev = store.revision(db);
  assert.throws(() => store.setPerson(db, { name: "Dana", validUntil: iso(T0 - 1000) }, T0), refused("date_in_past", 409));
  assert.throws(() => store.setPerson(db, { name: "Dana", validUntil: iso(T0) }, T0), refused("date_in_past", 409), "right now has passed");
  assert.equal(people(db), 0);
  assert.equal(store.revision(db), rev);
});

test("fire on bad: text that is not a date is refused 400 and the person is not created", () => {
  const db = migratedDb();
  assert.throws(() => store.setPerson(db, { name: "Dana", validUntil: "next friday" }, T0), refused("input_invalid", 400));
  assert.equal(people(db), 0);
});

test("fire on bad: a handle that belongs to someone else refuses the whole save, with the end date too", () => {
  const db = migratedDb();
  store.setPerson(db, { name: "Ann", handles: ["slack:u012abcdef"] }, T0);
  const rev = store.revision(db);
  assert.throws(() => store.setPerson(db, { name: "Dana", handles: ["slack:u012abcdef"], validUntil: iso(T0 + DAY) }, T0), refused("handle_taken", 409));
  assert.equal(people(db), 1);
  assert.equal(store.revision(db), rev);
});

test("fire on bad: an outside agent has no end date: refused 400 and not created; a person turned into one is refused too", () => {
  const db = migratedDb();
  assert.throws(() => store.setPerson(db, { name: "Bot", kind: "outside_agent", validUntil: iso(T0 + DAY) }, T0), refused("input_invalid", 400));
  assert.equal(people(db), 0);
  const p = store.setPerson(db, { name: "Dana" }, T0);
  assert.throws(() => store.setPerson(db, { id: p.id, name: "Dana", kind: "outside_agent", validUntil: iso(T0 + DAY) }, T0), refused("input_invalid", 400));
  assert.equal(db.prepare("SELECT kind FROM fleet_people WHERE id = ?").get(p.id)?.kind, "person", "still a person: the whole save rolled back");
});

test("the owner's op takes it and stays a person op; the manifest schema takes a string or null and nothing else", async () => {
  const db = migratedDb();
  const out = await personSet({ name: "Dana", validUntil: iso(Date.now() + 30 * DAY) }, db);
  assert.ok(out.person.id.startsWith("psn_"));
  assert.equal(people(db), 1);
  const spec = manifest.operations.find((o) => o.id === "person_set") as unknown as { audience: string; input: Parameters<typeof validateAgainstSchema>[0] };
  assert.equal(spec.audience, "person", "the manifest keeps agents and apps out; the SDK refuses them before the handler");
  const check = (v: Json) => validateAgainstSchema(spec.input, { name: "A", validUntil: v }).ok;
  assert.equal(check("2026-12-31T23:59:59.000Z"), true);
  assert.equal(check(null), true);
  assert.equal(check(20261231), false);
  assert.equal(check("x".repeat(41)), false);
});

test("the end date works as set: two ticks after it, the contractor is stopped with the reason Contract ended", () => {
  const db = migratedDb();
  const p = store.setPerson(db, { name: "Dana", tags: ["contractor"], validUntil: iso(T0 + DAY) }, T0);
  const seen = new Set<string>();
  assert.equal(tickDates(db, seen, T0 + DAY - 1000).stopped, 0, "before the date: nothing");
  assert.equal(tickDates(db, seen, T0 + DAY + 1000).stopped, 0, "the first tick only sees it");
  assert.equal(tickDates(db, seen, T0 + DAY + 61_000).stopped, 1);
  const row = db.prepare("SELECT lifecycle, lifecycle_reason FROM fleet_people WHERE id = ?").get(p.id);
  assert.equal(row?.lifecycle, "suspended");
  assert.equal(row?.lifecycle_reason, "contract_ended");
});
