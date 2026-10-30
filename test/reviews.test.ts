// Governance 0.2.1: trust reviews. An agent asks, the owner decides. Each guard has a quiet-on-good and a fire-on-bad
// case with the exact error code and HTTP status. The append-only rule is tested at the database (triggers of 0003).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ulid, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { definition, handlers, manifest } from "../src/app.ts";
import { factsFor } from "../src/facts.ts";
import { directoryFeed } from "../src/feed.ts";
import * as r from "../src/reviews.ts";
import * as store from "../src/store.ts";
import { cleanText } from "../src/text.ts";
import { checkFeed } from "./feed-contract.ts";
import { AGENT_A, AGENT_B, migratedDb, NOSTR } from "./helpers.ts";
import { seed } from "./seed.ts";

const DAY = r.DAY_MS;
const NOW = Date.UTC(2026, 9, 20, 9, 0, 0);
const OWNER = "per_01J0000000000000000000000P";
const log = { debug() {}, info() {}, warn() {}, error() {} };
const ctxOf = (db: Db, caller: object) => ({ db, caller, log }) as unknown as OpContext;
const agentCtx = (db: Db, id: string = AGENT_A.id) => ctxOf(db, { type: "agent", id, name: "A", mode: "free" });
const ownerCtx = (db: Db) => ctxOf(db, { type: "person", id: OWNER, name: "owner", mode: null });
type Run = { run(i: unknown, c: OpContext): Promise<unknown> };
const run = (id: string, input: unknown, c: OpContext) => (handlers as unknown as Record<string, Run>)[id]?.run(input, c) as Promise<Record<string, any>>;
const outputSchema = (id: string) => (manifest.operations.find((o) => o.id === id) as unknown as { output: Parameters<typeof validateAgainstSchema>[0] }).output;
const valid = (id: string, out: unknown) => validateAgainstSchema(outputSchema(id), out as Json).ok;
const audience = (id: string) => (manifest.operations.find((o) => o.id === id) as unknown as { audience: string }).audience;

/** The error of a call as `code status`, or "ok". */
async function outcome(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (e) {
    const x = e as { code?: string; httpStatus?: number };
    return x.code ? `${x.code} ${x.httpStatus}` : `other:${String(e)}`;
  }
}
const trustOf = (db: Db, table: "fleet_people" | "fleet_agents", id: string) => String(db.prepare(`SELECT trust FROM ${table} WHERE id = ?`).get(id)?.trust);
const count = (db: Db, sql: string) => Number(db.prepare(sql).get()?.n);

/** The owner looks (review_get by subject) and records. */
function record(db: Db, s: { kind: r.SubjectKind; id: string }, verdict: r.Verdict, extra: Partial<r.RecordInput> = {}, now = NOW) {
  const { current } = r.getReview(db, { subject: s }, now);
  return r.recordReview(db, OWNER, { subject: s, verdict, reason: "Checked by phone.", snapshotDigest: (current as r.Snapshot).digest, ...extra }, now);
}

// ── review_request (agent) ──────────────────────────────────────────────────────────────────────────────────────

test("review_request: an agent asks; it never sets trust; answers valid against the manifest", async () => {
  const db = migratedDb();
  const s = seed(db);
  const a = await run("review_request", { subject: { kind: "person", id: s.cy.id }, why: "It wrote to me." }, agentCtx(db));
  assert.deepEqual({ ...a.review, id: "x" }, { id: "x", status: "requested", duplicate: false });
  assert.match(a.review.id, /^rvw_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(valid("review_request", a), true);
  const row = db.prepare("SELECT * FROM fleet_reviews WHERE id = ?").get(a.review.id);
  assert.deepEqual([row?.status, row?.requested_by_kind, row?.requested_by_id, row?.requested_why, row?.subject_name], ["requested", "agent", AGENT_A.id, "It wrote to me.", "Cy"]);
  assert.equal(trustOf(db, "fleet_people", s.cy.id), "unreviewed", "asking leaves trust as it was");
  // an agent asks about itself or another agent
  const b = await run("review_request", { subject: { kind: "agent", id: AGENT_B.id }, why: "Odd replies." }, agentCtx(db));
  assert.equal(b.review.duplicate, false);
  assert.equal(trustOf(db, "fleet_agents", AGENT_B.id), "trusted");
  // fire on bad: the input has no trust member, so an agent has no way to ask for one
  const props = (manifest.operations.find((o) => o.id === "review_request") as unknown as { input: { properties: Record<string, any> } }).input.properties;
  assert.deepEqual(Object.keys(props).sort(), ["subject", "why"]);
  assert.ok(!("trust" in props.subject.properties) && !("verdict" in props));
  assert.equal(audience("review_request"), "agent");
});

test("review_request guards: dedup per requester, 20 open per agent, subject, handle, why, text (exact codes)", async () => {
  const db = migratedDb();
  const s = seed(db);
  const ask = (input: object, c = agentCtx(db)) => run("review_request", input, c);

  // dedup is per (requester, subject): the same agent gets its own request back; another agent gets ITS OWN new request
  const first = await ask({ subject: { kind: "person", id: s.cy.id }, why: "one" });
  const again = await ask({ subject: { kind: "person", id: s.cy.id }, why: "two" });
  const other = await ask({ subject: { kind: "person", id: s.cy.id }, why: "three" }, agentCtx(db, AGENT_B.id));
  assert.deepEqual([again.review.duplicate, again.review.id], [true, first.review.id]);
  assert.deepEqual([other.review.duplicate, other.review.id === first.review.id], [false, false], "no other requester's id or time leaks");
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM fleet_reviews WHERE subject_id = '${s.cy.id}'`), 2);
  assert.equal((await ask({ subject: { kind: "person", id: s.cy.id }, why: "four" }, agentCtx(db, AGENT_B.id))).review.id, other.review.id);

  // a companion app may ask too: recorded as `system` with its instance id (never as an agent); trust is still not touched
  const app = ctxOf(db, { type: "app", id: "ins_01J0000000000000000000000R", name: "r", mode: null });
  assert.equal(await outcome(() => ask({ subject: { kind: "person", id: s.bo.id }, why: "Rules saw odd traffic" }, app)), "ok");
  assert.deepEqual({ ...db.prepare("SELECT requested_by_kind AS k, requested_by_id AS i FROM fleet_reviews WHERE subject_id = ?").get(s.bo.id) }, { k: "system", i: "ins_01J0000000000000000000000R" });
  assert.equal(trustOf(db, "fleet_people", s.bo.id), "trusted");

  // subjects
  assert.equal(await outcome(() => ask({ subject: { kind: "agent", id: "agt_01J0000000000000000000009Z" }, why: "x" })), "subject_not_found 404");
  assert.equal(await outcome(() => ask({ subject: { kind: "agent", id: "agt_01J0000000000000000000000C" }, why: "x" })), "subject_not_found 404", "a removed agent");
  assert.equal(await outcome(() => ask({ subject: { kind: "person", id: "psn_nope" }, why: "x" })), "subject_not_found 404");
  assert.equal(await outcome(() => ask({ subject: { kind: "person", id: s.bot.id }, why: "x" })), "subject_not_found 404", "an outside agent asked about as a person");
  assert.equal(await outcome(() => ask({ subject: { kind: "outside_agent", id: s.bot.id }, why: "x" })), "ok");
  assert.equal(await outcome(() => ask({ subject: { kind: "agent" }, why: "x" })), "input_invalid 400");
  assert.equal(await outcome(() => ask({ subject: { kind: "agent", handle: "slack:UXYZ00001" }, why: "x" })), "input_invalid 400", "a handle is not an agent subject");
  assert.equal(await outcome(() => ask({ subject: { kind: "person" }, why: "x" })), "input_invalid 400");
  assert.equal(await outcome(() => ask({ subject: { kind: "person", handle: "email:a@b.c" }, why: "x" })), "handle_invalid 400");
  assert.equal(await outcome(() => ask({ subject: { kind: "person", handle: "buzz:npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w7" }, why: "x" })), "handle_invalid 400", "a bad checksum");
  assert.equal(await outcome(() => ask({ subject: { kind: "person", id: s.ann.id }, why: "   " })), "input_invalid 400");
  assert.equal(await outcome(() => ask({ subject: { kind: "person", id: s.ann.id }, why: "\u202e\u200b\u0007" })), "input_invalid 400", "only control and bidi characters is empty");

  // cap: 20 open requests per requester
  const b = agentCtx(db, AGENT_B.id);
  const open = (id: string) => count(db, `SELECT COUNT(*) AS n FROM fleet_reviews WHERE requested_by_id = '${id}' AND status = 'requested'`);
  while (open(AGENT_B.id) < r.MAX_OPEN_PER_AGENT) {
    const p = store.setPerson(db, { name: `P${open(AGENT_B.id)}` });
    assert.equal(await outcome(() => ask({ subject: { kind: "person", id: p.id }, why: "fill" }, b)), "ok");
  }
  assert.equal(open(AGENT_B.id), 20);
  const extra = store.setPerson(db, { name: "One too many" });
  assert.equal(await outcome(() => ask({ subject: { kind: "person", id: extra.id }, why: "21st" }, b)), "too_many_requests 429");
  assert.equal(open(AGENT_B.id), 20, "nothing was written");
  assert.equal(await outcome(() => ask({ subject: { kind: "person", handle: "slack:UGHOST001", name: "ghost" }, why: "21st via a handle" }, b)), "too_many_requests 429");
  // quiet: at the cap, asking about a subject that has an own open request still answers (duplicate), and another agent is not blocked
  assert.equal(await outcome(() => ask({ subject: { kind: "person", id: s.cy.id }, why: "dup" }, b)), "ok");
  assert.equal(await outcome(() => ask({ subject: { kind: "person", id: extra.id }, why: "A can" })), "ok");
});

test("review_request stores untrusted text: control and bidi characters are removed from the why and from names", async () => {
  const db = migratedDb();
  const s = seed(db);
  const out = await run("review_request", { subject: { kind: "person", id: s.cy.id }, why: "Pay\u202eevil.exe\u2066 now\u0000\u200b\nplease  \t ok" }, agentCtx(db));
  assert.equal(String(db.prepare("SELECT requested_why AS w FROM fleet_reviews WHERE id = ?").get(out.review.id)?.w), "Payevil.exe now please ok");
  const named = await run("review_request", { subject: { kind: "outside_agent", handle: "slack:UBIDI0001", name: "Bright\u202eline\u2029 intake" }, why: "x" }, agentCtx(db));
  assert.equal(String(db.prepare("SELECT subject_name AS n FROM fleet_reviews WHERE id = ?").get(named.review.id)?.n), "Brightline intake");
  assert.equal(cleanText("a\u202eb\u2066c\ufeffd\u00ade"), "abcde");
  assert.equal(cleanText("emoji \u{1F44D}\ufe0f ok"), "emoji \u{1F44D}\ufe0f ok", "ordinary text and emoji stay");
  // the owner's reason and dismissal text are cleaned the same way
  const rec = record(db, { kind: "person", id: s.cy.id }, "limited", { reason: "ok\u202e\u200b" });
  assert.equal(rec.reason, "ok");
});

// ── deferred creation: an agent never creates a directory entry ───────────────────────────────────────────────────

test("an unknown handle creates NO directory entry; the owner adds it with a verdict (handle leak, squatting, cap fill-up)", async () => {
  const db = migratedDb();
  seed(db);
  const people = () => count(db, "SELECT COUNT(*) AS n FROM fleet_people");
  const handlesN = () => count(db, "SELECT COUNT(*) AS n FROM fleet_handles");
  const rev = store.revision(db);
  const before = [people(), handlesN()];

  // (1) cap fill-up: 20 requests about 20 new handles fill the cap and add nothing to the directory
  for (let i = 0; i < r.MAX_OPEN_PER_AGENT; i++) assert.equal(await outcome(() => run("review_request", { subject: { kind: "person", handle: `slack:UFILL${String(i).padStart(4, "0")}` }, why: "x" }, agentCtx(db))), "ok");
  assert.equal(await outcome(() => run("review_request", { subject: { kind: "person", handle: "slack:UFILL9999" }, why: "21st" }, agentCtx(db))), "too_many_requests 429");
  assert.deepEqual([people(), handlesN()], before, "the directory did not grow");
  assert.equal(store.revision(db), rev, "and the revision did not move");
  assert.equal(directoryFeed(db, {}).unchanged, false);
  const feed = directoryFeed(db, {});
  assert.ok(!feed.unchanged && feed.contacts.every((c) => !c.handles.some((h) => h.startsWith("slack:UFILL"))), "the feed does not carry them");
  assert.equal(checkFeed(feed).ok, true);

  // (2) squatting: the handle stays free; the owner can still give it to the real person
  const squat = await run("review_request", { subject: { kind: "person", handle: "slack:UREAL0001", name: "CEO" }, why: "It is the CEO" }, agentCtx(db, AGENT_B.id));
  assert.equal(db.prepare("SELECT 1 FROM fleet_handles WHERE handle = 'slack:UREAL0001'").get(), undefined);
  const real = store.setPerson(db, { name: "Real person", handles: ["slack:UREAL0001"] });
  assert.equal(store.resolveSender(db, "slack:UREAL0001").contact?.id, real.id, "resolve_sender finds the person the owner added");
  assert.equal(store.resolveSender(db, "slack:UFILL0000").found, false, "an asked-about handle is still unknown to resolve_sender and the hook");
  // the request about the now-known handle resolves to the real entry; the verdict goes to it and answers the request
  const got = await run("review_get", { id: squat.review.id }, ownerCtx(db));
  assert.equal(got.current.name, "Real person");
  assert.match(got.current.digest, /^[0-9a-f]{64}$/);
  const done = await run("review_record", { subject: { kind: "person", handle: "slack:UREAL0001" }, verdict: "trusted", reason: "Known", snapshotDigest: (await run("review_get", { subject: { kind: "person", handle: "slack:UREAL0001" } }, ownerCtx(db))).current.digest }, ownerCtx(db));
  assert.equal(done.review.subject.id, real.id);
  assert.equal(String(db.prepare("SELECT status FROM fleet_reviews WHERE id = ?").get(squat.review.id)?.status), "done", "the pending request is answered");
  assert.equal(trustOf(db, "fleet_people", real.id), "trusted");

  // (3) handle leak: a known and an unknown handle answer the same way, and neither shows anything of the entry
  const known = await run("review_request", { subject: { kind: "person", handle: `buzz:${NOSTR.hex}` }, why: "who" }, agentCtx(db, AGENT_B.id));
  const unknown = await run("review_request", { subject: { kind: "person", handle: "slack:UNKNOWN001" }, why: "who" }, agentCtx(db, AGENT_B.id));
  assert.deepEqual(Object.keys(known.review).sort(), Object.keys(unknown.review).sort());
  assert.deepEqual([known.review.status, known.review.duplicate, unknown.review.status, unknown.review.duplicate], ["requested", false, "requested", false]);
  const knownAgain = await run("review_request", { subject: { kind: "person", handle: `buzz:${NOSTR.hex}` }, why: "again" }, agentCtx(db, AGENT_B.id));
  const unknownAgain = await run("review_request", { subject: { kind: "person", handle: "slack:UNKNOWN001" }, why: "again" }, agentCtx(db, AGENT_B.id));
  assert.deepEqual([knownAgain.review.duplicate, unknownAgain.review.duplicate], [true, true]);
  assert.ok(!JSON.stringify([known, unknown, knownAgain, unknownAgain]).includes("slack:"), "no handle in any answer");
  assert.deepEqual([...people().toString()].length > 0, true);

  // the owner sees the request with the handle, and records "add as limited": the entry is created now
  const list = await run("reviews_list", { status: "open" }, ownerCtx(db));
  const pend = list.reviews.find((x: any) => x.subjectHandle === "slack:UNKNOWN001");
  assert.deepEqual([pend.subject.id, pend.subject.kind, pend.requestedBy.kind], ["", "person", "agent"]);
  assert.equal(valid("reviews_list", list), true);
  const view = await run("review_get", { subject: { kind: "person", handle: "slack:UNKNOWN001" } }, ownerCtx(db));
  assert.deepEqual([view.review, view.current.status, view.current.trust, view.current.handles, view.current.name], [null, "pending", "unreviewed", ["slack:UNKNOWN001"], "slack:UNKNOWN001"]);
  assert.equal(valid("review_get", view), true);
  const n = people();
  const rec = await run("review_record", { subject: { kind: "person", handle: "slack:UNKNOWN001", name: "  Brightline\u202e intake " }, verdict: "limited", reason: "Partner bot.", snapshotDigest: view.current.digest, request: pend.id }, ownerCtx(db));
  assert.equal(valid("review_record", rec), true);
  assert.equal(people(), n + 1);
  const added = db.prepare("SELECT p.id, p.name, p.kind, p.trust, p.source FROM fleet_people p JOIN fleet_handles h ON h.person_id = p.id WHERE h.handle = 'slack:UNKNOWN001'").get();
  assert.deepEqual({ ...added, id: "x" }, { id: "x", name: "Brightline intake", kind: "person", trust: "limited", source: "agent" });
  assert.equal(rec.review.subject.id, added?.id);
  assert.equal(store.resolveSender(db, "slack:UNKNOWN001").contact?.trust, "limited");
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM fleet_reviews WHERE status = 'requested' AND subject_handle = 'slack:UNKNOWN001'"), 0, "both agents' pending requests are closed");
  // recording against a pending handle needs an open request, and a stale picture is refused
  assert.equal(await outcome(() => run("review_get", { subject: { kind: "person", handle: "slack:UNEVER0001" } }, ownerCtx(db))), "subject_not_found 404");
  const view2 = await run("review_get", { subject: { kind: "outside_agent", handle: "slack:UFILL0001" } }, ownerCtx(db));
  await run("review_request", { subject: { kind: "outside_agent", handle: "slack:UFILL0001" }, why: "late" }, agentCtx(db, AGENT_B.id));
  assert.equal(await outcome(() => run("review_record", { subject: { kind: "outside_agent", handle: "slack:UFILL0001" }, verdict: "blocked", reason: "x", snapshotDigest: "0".repeat(64) }, ownerCtx(db))), "snapshot_stale 409");
  assert.equal(view2.current.status, "pending");
});

test("an unknown handle the owner adds: NOT changed since the review right after the first verdict; a real change shows changed (S2-1)", async () => {
  const db = migratedDb();
  seed(db);
  await run("review_request", { subject: { kind: "person", handle: "slack:UPEND00001" }, why: "New sender." }, agentCtx(db));
  const subject = { kind: "person", handle: "slack:UPEND00001" };
  const view = await run("review_get", { subject }, ownerCtx(db));
  assert.equal(view.current.status, "pending");
  const rec = await run("review_record", { subject: { ...subject, name: "Pending Pat" }, verdict: "trusted", reason: "Known.", snapshotDigest: view.current.digest }, ownerCtx(db));
  const entry = String(db.prepare("SELECT person_id FROM fleet_handles WHERE handle = 'slack:UPEND00001'").get()?.person_id);
  const shown = (s: any) => [s.name, s.title, s.status, s.handles, s.owner, s.teams];
  const after = await run("review_get", { subject: { kind: "person", id: entry } }, ownerCtx(db));
  // the kept picture is the entry as created: what review_get computes now
  assert.deepEqual(shown(after.review.snapshot), shown(after.current));
  assert.deepEqual(shown(after.current), ["Pending Pat", "", "active", ["slack:UPEND00001"], null, []]);
  assert.equal(rec.review.snapshot.status, "active", "not the pending picture");
  assert.equal(valid("review_get", after), true);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM fleet_reviews WHERE subject_id = '${entry}' AND snapshot_digest = '${rec.review.snapshot.digest}'`), 1);
  // the page's rule (sameShown in src/ui/reviews.tsx): same name, title, status, handles, owner, teams
  assert.equal(JSON.stringify(shown(after.review.snapshot)) !== JSON.stringify(shown(after.current)), false, "exactly not changed after the first verdict");
  // fire on bad: a real change after the verdict
  store.setPerson(db, { id: entry, name: "Pending Patricia" });
  const changed = await run("review_get", { subject: { kind: "person", id: entry } }, ownerCtx(db));
  assert.equal(JSON.stringify(shown(changed.review.snapshot)) !== JSON.stringify(shown(changed.current)), true, "a rename after the verdict is a change");
  // the stale check still binds what the owner saw: a digest of another picture is refused, and nothing was written
  await run("review_request", { subject: { kind: "person", handle: "slack:UPEND00002" }, why: "Another." }, agentCtx(db));
  const n = count(db, "SELECT COUNT(*) AS n FROM fleet_people");
  assert.equal(await outcome(() => run("review_record", { subject: { kind: "person", handle: "slack:UPEND00002" }, verdict: "trusted", reason: "x", snapshotDigest: view.current.digest }, ownerCtx(db))), "snapshot_stale 409");
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM fleet_people"), n, "no entry was created by the refused call");
});

// ── review_record (owner) ───────────────────────────────────────────────────────────────────────────────────────

test("review_record: the verdict sets trust, closes the open requests, keeps the snapshot; answers valid against the manifest", async () => {
  const db = migratedDb();
  const s = seed(db);
  const ask = await run("review_request", { subject: { kind: "person", id: s.cy.id }, why: "It wrote to me." }, agentCtx(db));
  const askB = await run("review_request", { subject: { kind: "person", id: s.cy.id }, why: "me too" }, agentCtx(db, AGENT_B.id));
  assert.equal(askB.review.duplicate, false, "another requester gets its own request");
  const rev = store.revision(db);
  const got = await run("review_get", { subject: { kind: "person", id: s.cy.id } }, ownerCtx(db));
  assert.equal(got.review, null, "never reviewed");
  assert.equal(valid("review_get", got), true);

  const out = await run("review_record", { subject: { kind: "person", id: s.cy.id }, verdict: "limited", reason: "  Real partner, no patient data.  ", snapshotDigest: got.current.digest, request: ask.review.id, nextReviewDays: 30 }, ownerCtx(db));
  assert.equal(valid("review_record", out), true);
  const rv = out.review;
  assert.deepEqual([rv.status, rv.verdict, rv.reason, rv.reviewer, rv.subject], ["done", "limited", "Real partner, no patient data.", OWNER, { kind: "person", id: s.cy.id, name: "Cy" }]);
  assert.deepEqual(rv.requestedBy, { kind: "agent", id: AGENT_A.id, why: "It wrote to me." }, "the record keeps who asked");
  assert.equal(rv.snapshot.digest, got.current.digest);
  assert.equal(rv.snapshot.source, "directory_only");
  assert.equal(rv.proposal, null);
  assert.ok(Math.abs(Date.parse(rv.nextDueAt) - Date.parse(rv.decidedAt) - 30 * DAY) < 1000);
  assert.equal(trustOf(db, "fleet_people", s.cy.id), "limited");
  assert.ok(store.revision(db) > rev, "trust is in the feed: the revision moves");
  const feed = directoryFeed(db, {});
  assert.equal(!feed.unchanged && feed.contacts.find((c) => c.id === s.cy.id)?.trust, "limited");
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM fleet_reviews WHERE status = 'requested'"), 0, "every open request of the subject (both agents') is closed in the same write");
  for (const id of [ask.review.id, askB.review.id]) {
    const answered = db.prepare("SELECT status, verdict, answered_by, snapshot_digest FROM fleet_reviews WHERE id = ?").get(id);
    assert.deepEqual({ ...answered }, { status: "done", verdict: "limited", answered_by: rv.id, snapshot_digest: got.current.digest });
  }
  // history shows the verdict row once
  const list = await run("reviews_list", { status: "done" }, ownerCtx(db));
  assert.deepEqual(list.reviews.map((x: any) => x.id), [rv.id]);
  assert.equal(valid("reviews_list", list), true);
  assert.equal(valid("reviews_list", await run("reviews_list", {}, ownerCtx(db))), true);
  // an agent: the trust of an AGENT subject is set the same way
  const ag = record(db, { kind: "agent", id: AGENT_A.id }, "blocked");
  assert.equal(trustOf(db, "fleet_agents", AGENT_A.id), "blocked");
  assert.equal(ag.reviewer, OWNER);
  assert.equal(valid("review_record", { review: ag }), true);
});

test("review_record guards: snapshot_stale 409, unknown subject 404, wrong kind 404, empty reason 400, wrong request 404, days 400", async () => {
  const db = migratedDb();
  const s = seed(db);
  const subject = { kind: "person" as const, id: s.cy.id };
  const looked = r.getReview(db, { subject }, NOW).current as r.Snapshot;
  const rec = (over: Partial<r.RecordInput> = {}) => outcome(() => r.recordReview(db, OWNER, { subject, verdict: "trusted", reason: "ok", snapshotDigest: looked.digest, ...over }, NOW));

  // the subject changes after the owner looked → stale, and nothing was written
  const team = store.setTeam(db, { name: "Late team" });
  store.setMembers(db, { team: team.id, people: [{ id: s.cy.id, role: "member" }], agents: [] });
  const before = JSON.stringify([db.prepare("SELECT * FROM fleet_reviews").all(), db.prepare("SELECT trust FROM fleet_people ORDER BY id").all()]);
  assert.equal(await rec(), "snapshot_stale 409");
  assert.equal(JSON.stringify([db.prepare("SELECT * FROM fleet_reviews").all(), db.prepare("SELECT trust FROM fleet_people ORDER BY id").all()]), before);
  assert.equal(trustOf(db, "fleet_people", s.cy.id), "unreviewed");
  // quiet: after looking again the same verdict goes through
  const fresh = r.getReview(db, { subject }, NOW).current as r.Snapshot;
  assert.notEqual(fresh.digest, looked.digest);
  assert.equal(await rec({ snapshotDigest: fresh.digest }), "ok");
  // each kind of change makes the picture stale: a rename, a status change, an owner change (agent), a handle
  const d = (kind: r.SubjectKind, id: string) => (r.getReview(db, { subject: { kind, id } }, NOW).current as r.Snapshot).digest;
  const d0 = d("person", s.ann.id);
  store.setPerson(db, { id: s.ann.id, name: "Ann Renamed" });
  assert.notEqual(d("person", s.ann.id), d0, "rename");
  const d1 = d("person", s.ann.id);
  store.setPerson(db, { id: s.ann.id, name: "Ann Renamed", handles: ["slack:UANN00002"] });
  assert.notEqual(d("person", s.ann.id), d1, "handles");
  const d2 = d("agent", AGENT_B.id);
  store.setAgent(db, { agent: AGENT_B.id, owner: s.ann.id });
  assert.notEqual(d("agent", AGENT_B.id), d2, "owner");
  assert.equal(d("agent", AGENT_B.id), d("agent", AGENT_B.id), "stable when nothing changed");

  assert.equal(await rec({ snapshotDigest: fresh.digest, subject: { kind: "person", id: "psn_nope" } }), "subject_not_found 404");
  assert.equal(await rec({ snapshotDigest: fresh.digest, subject: { kind: "outside_agent", id: s.cy.id } }), "subject_not_found 404");
  assert.equal(await rec({ snapshotDigest: d("agent", AGENT_B.id), subject: { kind: "agent", id: AGENT_B.id }, reason: "   " }), "input_invalid 400");
  assert.equal(await rec({ snapshotDigest: d("agent", AGENT_B.id), subject: { kind: "agent", id: AGENT_B.id }, request: "rvw_nope" }), "request_not_found 404");
  assert.equal(await rec({ snapshotDigest: d("agent", AGENT_B.id), subject: { kind: "agent", id: AGENT_B.id }, nextReviewDays: 6 }), "input_invalid 400");
  assert.equal(await rec({ snapshotDigest: d("agent", AGENT_B.id), subject: { kind: "agent", id: AGENT_B.id }, nextReviewDays: 731 }), "input_invalid 400");
  // a request of ANOTHER subject cannot be used
  const other = await run("review_request", { subject: { kind: "person", id: s.ann.id }, why: "x" }, agentCtx(db));
  assert.equal(await rec({ snapshotDigest: d("agent", AGENT_B.id), subject: { kind: "agent", id: AGENT_B.id }, request: other.review.id }), "request_not_found 404");
  // a closed request cannot be used again
  const done = db.prepare("SELECT id FROM fleet_reviews WHERE status = 'done' AND answered_by IS NULL").get();
  assert.equal(await rec({ snapshotDigest: d("agent", AGENT_B.id), subject: { kind: "agent", id: AGENT_B.id }, request: String(done?.id) }), "request_not_found 404");
  assert.equal(await rec({ snapshotDigest: d("agent", AGENT_B.id), subject: { kind: "agent", id: AGENT_B.id } }), "ok");
  // only the owner records: the operations are person operations
  for (const id of ["reviews_list", "review_get", "review_record", "review_dismiss", "review_policy_set"]) assert.equal(audience(id), "person", id);
  assert.equal(((manifest.operations.find((o) => o.id === "review_record") as unknown as { idempotency: string }).idempotency), "required");
  // the verdict enum has no `unreviewed`: an owner cannot record a return to unreviewed
  const verdicts = (manifest.operations.find((o) => o.id === "review_record") as unknown as { input: { properties: { verdict: { enum: string[] } } } }).input.properties.verdict.enum;
  assert.deepEqual(verdicts, ["trusted", "limited", "blocked"]);
});

test("review_get: by id (with the snapshot now), by subject, unknown id 404, subject gone", async () => {
  const db = migratedDb();
  const s = seed(db);
  const ask = await run("review_request", { subject: { kind: "person", id: s.cy.id }, why: "x" }, agentCtx(db));
  const byId = await run("review_get", { id: ask.review.id }, ownerCtx(db));
  assert.equal(valid("review_get", byId), true);
  assert.deepEqual([byId.review.status, byId.review.verdict, byId.review.snapshot], ["requested", null, null]);
  assert.match(byId.current.digest, /^[0-9a-f]{64}$/);
  assert.equal(await outcome(() => run("review_get", { id: "rvw_nope" }, ownerCtx(db))), "review_not_found 404");
  assert.equal(await outcome(() => run("review_get", {}, ownerCtx(db))), "input_invalid 400");
  assert.equal(await outcome(() => run("review_get", { subject: { kind: "agent", id: "agt_nope" } }, ownerCtx(db))), "subject_not_found 404");
  const rec = record(db, { kind: "person", id: s.cy.id }, "trusted");
  store.setTeam(db, { name: "T" });
  store.setMembers(db, { team: store.getTeam(db, "T").id, people: [{ id: s.cy.id, role: "lead" }], agents: [] });
  const after = await run("review_get", { id: rec.id }, ownerCtx(db));
  assert.notEqual(after.current.digest, after.review.snapshot.digest, "changed since the review: the digests differ");
  assert.deepEqual(after.current.teams, ["Ops", "T"]);
  store.deletePerson(db, s.cy.id);
  const gone = await run("review_get", { id: rec.id }, ownerCtx(db));
  assert.equal(gone.current, null);
  assert.equal(gone.review.subject.name, "Cy", "the review keeps the name after person_delete");
  assert.equal(valid("review_get", gone), true);
});

// ── review_dismiss ──────────────────────────────────────────────────────────────────────────────────────────────

test("review_dismiss: closes an open request; review_not_found 404; review_not_open 409; a dismissed subject can be asked about again", async () => {
  const db = migratedDb();
  const s = seed(db);
  const ask = await run("review_request", { subject: { kind: "person", id: s.cy.id }, why: "spam" }, agentCtx(db));
  assert.equal(await outcome(() => run("review_dismiss", { id: "rvw_nope" }, ownerCtx(db))), "review_not_found 404");
  const out = await run("review_dismiss", { id: ask.review.id, why: "duplicate of a known contact" }, ownerCtx(db));
  assert.equal(valid("review_dismiss", out), true);
  assert.deepEqual([out.review.status, out.review.reason, out.review.reviewer, out.review.verdict], ["dismissed", "duplicate of a known contact", OWNER, null]);
  assert.equal(trustOf(db, "fleet_people", s.cy.id), "unreviewed", "dismissing never changes trust");
  assert.equal(await outcome(() => run("review_dismiss", { id: ask.review.id }, ownerCtx(db))), "review_not_open 409");
  const rec = record(db, { kind: "person", id: s.ann.id }, "trusted");
  assert.equal(await outcome(() => run("review_dismiss", { id: rec.id }, ownerCtx(db))), "review_not_open 409", "a verdict cannot be dismissed");
  const again = await run("review_request", { subject: { kind: "person", id: s.cy.id }, why: "again" }, agentCtx(db));
  assert.deepEqual([again.review.duplicate, again.review.id === ask.review.id], [false, false]);
});

// ── append-only (database) ──────────────────────────────────────────────────────────────────────────────────────

test("reviews are append-only: triggers refuse any change to a closed review, any delete, any replace (review_append_only)", async () => {
  const db = migratedDb();
  const s = seed(db);
  const open = await run("review_request", { subject: { kind: "person", id: s.cy.id }, why: "x" }, agentCtx(db));
  const dismissedReq = await run("review_request", { subject: { kind: "person", id: s.bo.id }, why: "y" }, agentCtx(db));
  await run("review_dismiss", { id: dismissedReq.review.id }, ownerCtx(db));
  const done = record(db, { kind: "person", id: s.ann.id }, "trusted");
  const fails = (sql: string, ...args: (string | number | null)[]) => {
    try {
      db.prepare(sql).run(...args);
      return "no error";
    } catch (e) {
      return String((e as Error).message);
    }
  };
  // closed rows: every column
  for (const id of [done.id, dismissedReq.review.id]) {
    for (const set of ["reason = 'edited'", "verdict = 'blocked'", "status = 'requested'", "next_due_at = 0", "snapshot_json = '{}'", "subject_name = 'x'", "reviewer = 'per_x'"])
      assert.match(fails(`UPDATE fleet_reviews SET ${set} WHERE id = '${id}'`), /review_append_only/, `${id} ${set}`);
    assert.match(fails(`DELETE FROM fleet_reviews WHERE id = '${id}'`), /review_append_only/);
  }
  // INSERT OR REPLACE / REPLACE INTO (they delete the old row without a delete trigger) and a plain duplicate id
  const copy = (id: string, verb: string) =>
    fails(
      `${verb} INTO fleet_reviews (id, subject_kind, subject_id, subject_name, status, verdict, reason, requested_by_kind, reviewer, snapshot_digest, created_at, decided_at) VALUES ('${id}', 'person', 'psn_x', 'x', 'done', 'trusted', 'forged', 'owner', 'per_x', '${"a".repeat(64)}', 0, 0)`,
    );
  for (const id of [done.id, dismissedReq.review.id, open.review.id]) {
    assert.match(copy(id, "INSERT OR REPLACE"), /review_append_only/, `replace ${id}`);
    assert.match(copy(id, "REPLACE"), /review_append_only/, `replace ${id}`);
    assert.match(copy(id, "INSERT"), /review_append_only/, `insert ${id}`);
  }
  assert.equal(String(db.prepare("SELECT reason FROM fleet_reviews WHERE id = ?").get(done.id)?.reason), "Checked by phone.", "the evidence is intact");
  // an open request: who/what/when cannot change, it cannot be edited in place, and it cannot be deleted
  for (const set of ["subject_id = 'psn_other'", "subject_name = 'x'", "subject_handle = 'slack:UX'", "requested_why = 'changed'", "requested_by_kind = 'owner'", "requested_by_id = 'agt_x'", "created_at = 0", "id = 'rvw_other'", "reason = 'edited'", "status = 'requested'"])
    assert.match(fails(`UPDATE fleet_reviews SET ${set} WHERE id = '${open.review.id}'`), /review_append_only|CHECK/, set);
  assert.match(fails(`DELETE FROM fleet_reviews WHERE id = '${open.review.id}'`), /review_append_only/);
  // transitions: requested -> done only with a verdict, the digest and the answering row; requested -> dismissed only without a verdict
  const to = (set: string) => fails(`UPDATE fleet_reviews SET ${set} WHERE id = '${open.review.id}'`);
  assert.match(to("status = 'done', decided_at = 1, reviewer = 'per_x'"), /review_append_only|CHECK/, "done without verdict and digest");
  assert.match(to("status = 'done', verdict = 'trusted', decided_at = 1, reviewer = 'per_x', answered_by = 'rvw_x'"), /review_append_only|CHECK/, "done without a digest");
  assert.match(to(`status = 'done', verdict = 'trusted', snapshot_digest = '${"b".repeat(64)}', decided_at = 1, reviewer = 'per_x'`), /review_append_only|CHECK/, "done without the answering row");
  assert.match(to(`status = 'done', verdict = 'unreviewed', snapshot_digest = '${"b".repeat(64)}', decided_at = 1, reviewer = 'per_x', answered_by = 'rvw_x'`), /review_append_only|CHECK/, "a verdict is never unreviewed");
  assert.match(to("status = 'dismissed', verdict = 'trusted', decided_at = 1"), /review_append_only|CHECK/, "dismissed with a verdict");
  assert.match(to("status = 'dismissed'"), /review_append_only|CHECK/, "dismissed without a date");
  assert.match(to("status = 'bogus'"), /CHECK/);
  assert.equal(String(db.prepare("SELECT status FROM fleet_reviews WHERE id = ?").get(open.review.id)?.status), "requested", "every refused probe left the request open");
  // status and verdict agree (CHECK) on a fresh insert too
  const ins = (cols: string) => fails(`INSERT INTO fleet_reviews (id, subject_kind, subject_id, subject_name, requested_by_kind, created_at, ${cols.split("|")[0]}) VALUES ('rvw_p${Math.random().toString(36).slice(2, 8)}', 'person', 'psn_y', 'y', 'agent', 0, ${cols.split("|")[1]})`);
  assert.match(ins("status|'done'"), /CHECK/, "done without verdict");
  assert.match(ins("status, verdict|'requested', 'trusted'"), /CHECK/, "requested with a verdict");
  assert.match(ins("status, decided_at|'requested', 5"), /CHECK/, "requested with a decision date");
  assert.match(ins("status, verdict, snapshot_digest, decided_at, reviewer|'done', 'unreviewed', 'd', 1, 'p'"), /CHECK/, "done with unreviewed");
  assert.match(ins("status, answered_by|'requested', 'rvw_z'"), /CHECK/, "answered_by on a request");
  assert.match(fails("INSERT INTO fleet_reviews (id, subject_kind, subject_id, subject_name, status, requested_by_kind, created_at) VALUES ('rvw_pn', 'person', '', 'n', 'requested', 'agent', 0)"), /CHECK/, "an empty subject id needs a handle");
  // quiet on good: the one allowed move of an open request is to dismissed or done (through the operations)
  assert.equal(await outcome(() => run("review_dismiss", { id: open.review.id }, ownerCtx(db))), "ok");
  // a database check: bad enums are refused
  assert.match(fails("INSERT INTO fleet_reviews (id, subject_kind, subject_id, subject_name, status, requested_by_kind, created_at) VALUES ('rvw_x', 'robot', 'a', 'a', 'requested', 'agent', 0)"), /CHECK/);
  assert.match(fails(`INSERT INTO fleet_reviews (id, subject_kind, subject_id, subject_name, status, requested_by_kind, created_at, reason) VALUES ('rvw_y', 'agent', 'a', 'a', 'requested', 'agent', 0, '${"x".repeat(2001)}')`), /CHECK/);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM fleet_reviews"), 3, "nothing was lost");
});

// ── policy and due dates ────────────────────────────────────────────────────────────────────────────────────────

test("review_policy_set: defaults 90/180, partial update, range guard 400, flags; valid against the manifest", async () => {
  const db = migratedDb();
  assert.deepEqual(r.reviewPolicy(db), { agentDays: 90, contactDays: 180, reviewNewAgents: true, reviewChangedAccess: false });
  const out = await run("review_policy_set", { agentDays: 30 }, ownerCtx(db));
  assert.equal(valid("review_policy_set", out), true);
  assert.deepEqual(out.policy, { agentDays: 30, contactDays: 180, reviewNewAgents: true, reviewChangedAccess: false });
  assert.deepEqual((await run("review_policy_set", { reviewNewAgents: false, reviewChangedAccess: true, contactDays: 365 }, ownerCtx(db))).policy, { agentDays: 30, contactDays: 365, reviewNewAgents: false, reviewChangedAccess: true });
  assert.deepEqual((await run("review_policy_set", {}, ownerCtx(db))).policy.agentDays, 30, "an empty update changes nothing");
  for (const bad of [{ agentDays: 6 }, { agentDays: 731 }, { contactDays: 0 }, { contactDays: 1.5 }])
    assert.equal(await outcome(() => run("review_policy_set", bad, ownerCtx(db))), "input_invalid 400", JSON.stringify(bad));
  assert.equal(r.reviewPolicy(db).agentDays, 30, "a refused update changes nothing");
  // the list shows the policy
  assert.equal((await run("reviews_list", {}, ownerCtx(db))).policy.agentDays, 30);
});

test("due dates: from the policy (90/180); never reviewed = created + days; unreviewed = at once; a verdict sets the next date", async () => {
  const db = migratedDb();
  const s = seed(db);
  const T0 = Date.now();
  // everything seeded was created "now": nothing trusted is due yet; the unreviewed contact (added by an agent) is
  db.prepare("UPDATE fleet_people SET created_at = ?").run(T0);
  db.prepare("UPDATE fleet_agents SET first_seen = ?").run(T0);
  const names = (now: number) => r.dueSubjects(db, now).items.map((i) => i.subject.name).sort();
  assert.deepEqual(names(T0 + DAY), ["Cy"], "unreviewed is due at once");
  assert.deepEqual(names(T0 + 91 * DAY), ["Agent A", "Agent B", "Cy"].sort(), "agents after 90 days; people not yet");
  assert.deepEqual(names(T0 + 181 * DAY), ["Agent A", "Agent B", "Ann Example", "Cy", "Outside Bot"].sort(), "contacts after 180 days; a departed person and a removed agent are never due");
  // the schedule is the owner's: shorter agent days bring the date forward
  r.setReviewPolicy(db, { agentDays: 30 });
  assert.deepEqual(names(T0 + 31 * DAY), ["Agent A", "Agent B", "Cy"].sort());
  // a verdict sets the next date (policy days by default, or the owner's choice)
  record(db, { kind: "agent", id: AGENT_A.id }, "trusted", {}, T0 + 40 * DAY);
  record(db, { kind: "person", id: s.cy.id }, "limited", { nextReviewDays: 10 }, T0 + 40 * DAY);
  assert.deepEqual(names(T0 + 41 * DAY), ["Agent B"], "reviewed ones leave the list");
  assert.deepEqual(names(T0 + 71 * DAY), ["Agent A", "Agent B", "Cy"].sort(), "agentDays 30 after the verdict; Cy 10 days");
  assert.deepEqual(names(T0 + 51 * DAY), ["Agent B", "Cy"].sort(), "Cy: 10 days");
  // open requests are not repeated in the due list; a due item has the snapshot to record against
  await run("review_request", { subject: { kind: "agent", id: AGENT_B.id }, why: "x" }, agentCtx(db));
  const due = r.dueSubjects(db, T0 + 71 * DAY);
  assert.ok(!due.items.some((i) => i.subject.id === AGENT_B.id));
  assert.deepEqual(Object.keys(due.items[0] ?? {}).sort(), ["dueAt", "lastReview", "lastVerdict", "subject"], "a due item has no snapshot: the review fetches a fresh one");
  const list = r.listReviews(db, {}, T0 + 71 * DAY);
  assert.equal(list.dueCount, due.count);
  assert.equal(list.openCount, 1);
  assert.equal(valid("reviews_list", JSON.parse(JSON.stringify(list))), true);
});

test("reviews_list: filters, paging by cursor, newest first", async () => {
  const db = migratedDb();
  const s = seed(db);
  const subjects = [s.ann, s.bo, s.bot, s.cy];
  const ids: string[] = [];
  for (const [i, p] of subjects.entries()) ids.push(record(db, { kind: p.kind === "outside_agent" ? "outside_agent" : "person", id: p.id }, "trusted", {}, NOW + i * 1000).id);
  const q = await run("review_request", { subject: { kind: "agent", id: AGENT_B.id }, why: "x" }, agentCtx(db)); // C380: about another agent, never itself
  const all = await run("reviews_list", {}, ownerCtx(db));
  assert.deepEqual(all.reviews.map((x: any) => x.id), [...[...ids].reverse(), q.review.id].sort().reverse(), "newest first");
  assert.deepEqual((await run("reviews_list", { status: "open" }, ownerCtx(db))).reviews.map((x: any) => x.id), [q.review.id]);
  assert.equal((await run("reviews_list", { status: "done" }, ownerCtx(db))).reviews.length, 4);
  assert.deepEqual((await run("reviews_list", { status: "due" }, ownerCtx(db))).reviews, [], "due subjects are in `due`, not in `reviews`");
  assert.equal((await run("reviews_list", { subject: s.ann.id }, ownerCtx(db))).reviews.length, 1);
  const p1 = await run("reviews_list", { limit: 2 }, ownerCtx(db));
  const p2 = await run("reviews_list", { limit: 2, cursor: p1.nextCursor }, ownerCtx(db));
  const p3 = await run("reviews_list", { limit: 2, cursor: p2.nextCursor }, ownerCtx(db));
  assert.deepEqual([p1.reviews.length, p2.reviews.length, p3.reviews.length, p3.nextCursor], [2, 2, 1, null]);
  assert.deepEqual([...p1.reviews, ...p2.reviews, ...p3.reviews].map((x: any) => x.id), all.reviews.map((x: any) => x.id));
  for (const out of [all, p1, p2, p3]) assert.equal(valid("reviews_list", out), true);
});

// ── new agents ──────────────────────────────────────────────────────────────────────────────────────────────────

test("agentsChanged: a NEW agent opens one system review request when reviewNewAgents is on; a re-add or a second sync does not", async () => {
  const db = migratedDb();
  const sync = async (agents: object[]) => definition.events?.agentsChanged?.(agents as never, { db } as never);
  await sync([AGENT_A, AGENT_B]);
  const sys = () => db.prepare("SELECT subject_id, requested_by_kind, requested_by_id, requested_why, status FROM fleet_reviews ORDER BY subject_id").all().map((x) => ({ ...x }));
  assert.deepEqual(sys(), [
    { subject_id: AGENT_A.id, requested_by_kind: "system", requested_by_id: null, requested_why: "New agent in this workspace.", status: "requested" },
    { subject_id: AGENT_B.id, requested_by_kind: "system", requested_by_id: null, requested_why: "New agent in this workspace.", status: "requested" },
  ]);
  await sync([AGENT_A, AGENT_B]);
  assert.equal(sys().length, 2, "a second sync: no duplicate");
  // dismiss one, remove it from the slice and re-add it: a re-add is not new
  const dis = db.prepare("SELECT id FROM fleet_reviews WHERE subject_id = ?").get(AGENT_B.id);
  r.dismissReview(db, OWNER, String(dis?.id), "known", NOW);
  await sync([AGENT_A]);
  await sync([AGENT_A, AGENT_B]);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM fleet_reviews"), 2, "re-add: no new request");
  // a brand new agent after that: yes
  const c = { id: "agt_01J0000000000000000000000C", name: "Agent C", mode: "free", status: "active" };
  await sync([AGENT_A, AGENT_B, c]);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM fleet_reviews WHERE subject_id = '${c.id}'`), 1);
  // off: the policy says no
  r.setReviewPolicy(db, { reviewNewAgents: false });
  const d = { ...c, id: "agt_01J0000000000000000000000D", name: "Agent D" };
  await sync([AGENT_A, AGENT_B, c, d]);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM fleet_reviews WHERE subject_id = '${d.id}'`), 0, "reviewNewAgents off: no request");
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM fleet_agents WHERE id = '${d.id}'`), 1, "the agent itself is stored");
  // the open count counts system requests; the per-agent cap counts only agent requests
  assert.equal(r.listReviews(db, {}, NOW).openCount, 2);
});

// ── the picture the owner looks at, and what it binds to ──────────────────────────────────────────────────────────

test("the snapshot is what the owner sees (name, title, kind, trust, handles, owner name, teams); the digest also covers email, trust and the last verdict", async () => {
  const db = migratedDb();
  const s = seed(db);
  const look = async (kind: r.SubjectKind, id: string) => (await run("review_get", { subject: { kind, id } }, ownerCtx(db))).current as r.Snapshot;
  const ann = await look("person", s.ann.id);
  assert.deepEqual(
    { name: ann.name, kind: ann.kind, title: ann.title, status: ann.status, trust: ann.trust, handles: ann.handles, owner: ann.owner, ownerName: ann.ownerName, teams: ann.teams, source: ann.source, access: ann.access, policy: ann.policy, contacts: ann.contacts },
    { name: "Ann Example", kind: "person", title: "Chief Secret Officer", status: "active", trust: "trusted", handles: [`buzz:${NOSTR.npub}`, "slack:U012ABCDEF", "telegram:123456"].sort(), owner: null, ownerName: null, teams: ["Support"], source: "directory_only", access: [], policy: null, contacts: 0 },
  );
  const agent = await look("agent", AGENT_A.id);
  assert.deepEqual([agent.ownerName, agent.owner, agent.title, agent.kind, agent.teams], ["Ann Example", s.ann.id, "triage-role", "agent", ["Support"]]);
  assert.equal(valid("review_get", { review: null, current: ann }), true);
  assert.ok(!JSON.stringify(ann).includes("@"), "the stored copy has no email; the email is only in the digest");
  // each of these changes the digest (the owner would be deciding on an older picture)
  const changes: [string, () => void][] = [
    ["email", () => store.setPerson(db, { id: s.ann.id, name: "Ann Example", email: "ann@new.example" })],
    ["title", () => store.setPerson(db, { id: s.ann.id, name: "Ann Example", title: "Boss" })],
    ["trust", () => db.prepare("UPDATE fleet_people SET trust = 'limited' WHERE id = ?").run(s.ann.id)],
    ["status", () => store.setPerson(db, { id: s.ann.id, name: "Ann Example", status: "departed" })],
    ["team", () => store.setMembers(db, { team: s.ops.id, people: [{ id: s.ann.id, role: "lead" }], agents: [] })],
    ["handle", () => store.setPerson(db, { id: s.ann.id, name: "Ann Example", handles: ["slack:UANN00009"] })],
  ];
  for (const [what, change] of changes) {
    const before = (await look("person", s.ann.id)).digest;
    change();
    assert.notEqual((await look("person", s.ann.id)).digest, before, `a change of ${what} changes the digest`);
  }
});

test("two tabs: the second verdict made from the pre-verdict picture is snapshot_stale (fires on bad), a fresh picture goes through", async () => {
  const db = migratedDb();
  const s = seed(db);
  const subject = { kind: "person" as const, id: s.cy.id };
  const tabA = (await run("review_get", { subject }, ownerCtx(db))).current.digest;
  const tabB = (await run("review_get", { subject }, ownerCtx(db))).current.digest;
  assert.equal(tabA, tabB, "both tabs see the same picture");
  const rec = (digest: string, verdict: r.Verdict) => outcome(() => run("review_record", { subject, verdict, reason: "x", snapshotDigest: digest }, ownerCtx(db)));
  assert.equal(await rec(tabA, "blocked"), "ok");
  assert.equal(trustOf(db, "fleet_people", s.cy.id), "blocked");
  const rows = count(db, "SELECT COUNT(*) AS n FROM fleet_reviews");
  assert.equal(await rec(tabB, "trusted"), "snapshot_stale 409", "the other tab still holds the pre-block picture");
  assert.equal(trustOf(db, "fleet_people", s.cy.id), "blocked", "the block stands");
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM fleet_reviews"), rows, "nothing was written");
  // quiet: after looking again, the second verdict is accepted (and it sees the block)
  const fresh = await run("review_get", { subject }, ownerCtx(db));
  assert.equal(fresh.current.trust, "blocked");
  assert.equal(fresh.review.verdict, "blocked");
  assert.equal(await rec(fresh.current.digest, "limited"), "ok");
  // the same holds for the page-load picture: the subject changed after the page loaded → stale
  const loaded = (await run("review_get", { subject: { kind: "agent", id: AGENT_B.id } }, ownerCtx(db))).current.digest;
  store.setAgent(db, { agent: AGENT_B.id, owner: s.ann.id });
  assert.equal(await outcome(() => run("review_record", { subject: { kind: "agent", id: AGENT_B.id }, verdict: "trusted", reason: "x", snapshotDigest: loaded }, ownerCtx(db))), "snapshot_stale 409");
});

// ── blocked agents, new agents, caps ─────────────────────────────────────────────────────────────────────────────

test("a BLOCKED agent has no team facts: fleet.agentTeams (as caller) and fleet.requesterTeams (as claim); the owner is kept", () => {
  const db = migratedDb();
  const s = seed(db);
  const facts = (caller: { type: "agent"; id: string }, context: Record<string, unknown> = {}) => factsFor(db, { call: { caller } as never, context: context as never });
  const claim = { "tb.onBehalfOf": { claim: { kind: "agent", id: AGENT_A.id }, verified: false } };
  assert.deepEqual(facts({ type: "agent", id: AGENT_A.id })["fleet.agentTeams"].map((t) => t.name), ["Support"]);
  assert.deepEqual(facts({ type: "agent", id: AGENT_B.id }, claim)["fleet.requesterTeams"].map((t) => t.name), ["Support"]);
  record(db, { kind: "agent", id: AGENT_A.id }, "blocked");
  const asCaller = facts({ type: "agent", id: AGENT_A.id });
  assert.deepEqual(asCaller["fleet.agentTeams"], [], "blocked caller: no teams");
  assert.deepEqual(asCaller["fleet.agentOwner"], { id: s.ann.id, name: "Ann Example" }, "the owner is still reported");
  const asClaim = facts({ type: "agent", id: AGENT_B.id }, claim);
  assert.deepEqual(asClaim["fleet.requesterTeams"], [], "blocked requester: no teams");
  assert.equal(asClaim["fleet.requester.trust"], "blocked");
  assert.deepEqual(store.agentFacts(db, AGENT_A.id).teams, []);
  // quiet: an unblocked (limited) agent has its teams again
  record(db, { kind: "agent", id: AGENT_A.id }, "limited");
  assert.deepEqual(facts({ type: "agent", id: AGENT_A.id })["fleet.agentTeams"].map((t) => t.name), ["Support"]);
});

test("a NEW slice agent starts unreviewed (fail closed); agents that existed before keep trusted (migration 0002)", async () => {
  const db = migratedDb();
  store.syncAgents(db, [AGENT_A]);
  assert.equal(trustOf(db, "fleet_agents", AGENT_A.id), "unreviewed");
  assert.equal(store.agentTrust(db, AGENT_A.id), "unreviewed");
  const feed = directoryFeed(db, {});
  assert.equal(!feed.unchanged && feed.agents[0]?.trust, "unreviewed");
  // the due list says so at once, and a review request exists for it
  assert.equal(r.listReviews(db, {}).openCount, 0, "no request until agentsChanged opens one");
  await definition.events?.agentsChanged?.([AGENT_A, AGENT_B] as never, { db } as never);
  assert.equal(r.listReviews(db, {}).openCount, 1, "agentsChanged: B is new, A is not");
});

test("system requests (new agents) stop at 100 open; dueSubjects reads the directory with ONE query", async () => {
  const db = migratedDb();
  const agents = Array.from({ length: 130 }, (_, i) => ({ id: `agt_${ulid(i)}` as `agt_${string}`, name: `A${i}`, mode: "free" as const, status: "active" as const }));
  await definition.events?.agentsChanged?.(agents as never, { db } as never);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM fleet_reviews WHERE requested_by_kind = 'system' AND requested_by_id IS NULL"), r.MAX_OPEN_SYSTEM);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM fleet_agents"), 130, "all agents are stored");
  // an agent's own requests are not counted against the system cap
  assert.equal(await outcome(() => run("review_request", { subject: { kind: "agent", id: agents[120]?.id }, why: "x" }, agentCtx(db))), "ok");
  // one statement per call, whatever the number of subjects
  let prepared = 0;
  const spy: Db = { ...db, prepare: (sql: string) => { prepared++; return db.prepare(sql); } } as Db;
  const due = r.dueSubjects(spy, Date.now());
  assert.equal(due.count, 29, "the 130 agents minus 100 system requests and 1 agent request are due (unreviewed)");
  assert.equal(prepared, 3, "the policy (2 reads) and ONE query for every subject, not one per subject");
});
