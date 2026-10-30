// C380 T2-c: "Cannot hold both". A rule is checked when a role is given, with date overlap, by role pair and by holder against owner; it is flagged as a
// difference when broken later; it never blocks a stop, a transfer or a new owner; an acceptance does not cover a newer clash.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { findingsList, openDifferences, setException } from "../src/access/differences.ts";
import { manifest } from "../src/app.ts";
import { setAgentMoved } from "../src/lifecycle/moved.ts";
import { loadColleagues } from "../src/lifecycle/view.ts";
import { checkExclusions, EXCLUSION_CAPS, exclusionFindings, getExclusion, listExclusions, setExclusion } from "../src/roles/exclusions.ts";
import { assignRole, endAssignment, endAssignmentsOf, setRole } from "../src/roles/roles.ts";
import * as store from "../src/store.ts";
import { AGENT_A, AGENT_B } from "./helpers.ts";
import { refused, set, T0, world } from "./lifecycle-helpers.ts";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const rev = (db: Db) => store.revision(db);
const role = (db: Db, name: string) => setRole(db, { name }, "per_owner", T0);
const give = (db: Db, roleId: string, subject: { kind: "person" | "agent"; id: string }, extra: { validFrom?: string | null; validUntil?: string | null } = {}, now = T0) => assignRole(db, { role: roleId, subject, reason: "project", ...extra }, "per_owner", now);
const rule = (db: Db, kind: "roles" | "holder_owner", roleA: string, roleB: string, now = T0) => setExclusion(db, { kind, roleA, roleB }, "per_owner", now);
const flags = (db: Db, now = T0) => loadColleagues(db, now).rows.flatMap((r) => r.findings.filter((f) => f.code === "cannot_hold_both").map((f) => ({ who: `${r.kind}:${r.name}`, text: f.text })));
const person = (id: string) => ({ kind: "person" as const, id });
const agent = (id: string) => ({ kind: "agent" as const, id });
const count = (db: Db, table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);

test("a role pair: the second role is refused, naming both roles, in either order; nothing is written", () => {
  const { db, ann } = world();
  const approver = role(db, "Approver");
  const payer = role(db, "Payer");
  rule(db, "roles", payer.id, approver.id);
  give(db, approver.id, person(ann.id));
  const r0 = rev(db);
  const n0 = count(db, "fleet_role_assignments");
  const e0 = count(db, "fleet_lifecycle_events");
  assert.throws(() => give(db, payer.id, person(ann.id)), (e: unknown) => {
    refused("cannot_hold_both", 409)(e);
    const m = (e as Error).message;
    assert.match(m, /Ann already has Approver \(with no end date\)/);
    assert.match(m, /no one may have both (Approver and Payer|Payer and Approver)/);
    return true;
  });
  assert.equal(rev(db), r0, "a refusal moves no revision");
  assert.equal(count(db, "fleet_role_assignments"), n0);
  assert.equal(count(db, "fleet_lifecycle_events"), e0, "a refusal leaves no event either");
  // the other order, on an agent
  give(db, payer.id, agent(AGENT_B.id));
  assert.throws(() => give(db, approver.id, agent(AGENT_B.id)), refused("cannot_hold_both", 409));
  // quiet on good: a role the rule does not name, and another subject
  const other = role(db, "Reader");
  assert.equal(give(db, other.id, person(ann.id)).state, "active");
  assert.equal(give(db, payer.id, agent(AGENT_A.id)).state, "active", "another subject may hold the other role");
});

test("date overlap: a handover is fine, an overlap is not; a waiting assignment counts for its dates; an ended one counts for nothing", () => {
  const { db, ann } = world();
  const a = role(db, "Approver");
  const b = role(db, "Payer");
  rule(db, "roles", a.id, b.id);
  const first = give(db, a.id, person(ann.id), { validUntil: iso(T0 + 10 * DAY) });
  // starts the moment the first ends: no overlap (an end date is the first moment the role is gone)
  assert.equal(give(db, b.id, person(ann.id), { validFrom: iso(T0 + 10 * DAY), validUntil: iso(T0 + 20 * DAY) }).state, "scheduled");
  // fire on bad: a payer that starts one second before the approver ends, and one that starts now
  endAssignmentsOf(db, "person", ann.id, "closed", { kind: "system", id: null }, T0);
  give(db, a.id, person(ann.id), { validUntil: iso(T0 + 10 * DAY) });
  assert.throws(() => give(db, b.id, person(ann.id), { validFrom: iso(T0 + 10 * DAY - 1000) }), refused("cannot_hold_both", 409));
  assert.throws(() => give(db, b.id, person(ann.id)), refused("cannot_hold_both", 409));
  // a waiting assignment is checked for its dates, in the message too
  const { db: db2, ann: ann2 } = world();
  const a2 = role(db2, "Approver");
  const b2 = role(db2, "Payer");
  rule(db2, "roles", a2.id, b2.id);
  give(db2, a2.id, person(ann2.id), { validFrom: iso(T0 + 5 * DAY), validUntil: iso(T0 + 8 * DAY) });
  assert.throws(() => give(db2, b2.id, person(ann2.id), { validUntil: iso(T0 + 6 * DAY) }), (e: unknown) => /Ann already has Approver \(from 2026-11-04 until 2026-11-07\)/.test((e as Error).message));
  assert.equal(give(db2, b2.id, person(ann2.id), { validUntil: iso(T0 + 5 * DAY) }).state, "active", "ends the day the other starts: fine");
  // an ended assignment is the record, not a hold
  const { db: db3, ann: ann3 } = world();
  const a3 = role(db3, "Approver");
  const b3 = role(db3, "Payer");
  rule(db3, "roles", a3.id, b3.id);
  const x = give(db3, a3.id, person(ann3.id));
  endAssignment(db3, x.id, "per_owner", T0);
  assert.equal(give(db3, b3.id, person(ann3.id)).state, "active");
  assert.equal(first.state, "active");
});

test("an archived role is not held for a rule, and an archived rule is not checked", () => {
  const { db, ann } = world();
  const a = role(db, "Approver");
  const b = role(db, "Payer");
  const r = rule(db, "roles", a.id, b.id);
  give(db, a.id, person(ann.id));
  setRole(db, { id: a.id, archived: true }, null, T0);
  assert.equal(give(db, b.id, person(ann.id)).state, "active", "an archived role matches no one in Rules, so it is not held here");
  assert.deepEqual(flags(db), []);
  setRole(db, { id: a.id, archived: false }, null, T0);
  assert.equal(flags(db).length, 1, "the role is back: the clash shows");
  // an archived rule
  setExclusion(db, { id: r.id, archived: true }, "per_owner", T0);
  assert.deepEqual(flags(db), []);
  const c = role(db, "Treasurer");
  const d = role(db, "Clerk");
  const r2 = rule(db, "roles", c.id, d.id);
  give(db, c.id, agent(AGENT_B.id));
  setExclusion(db, { id: r2.id, archived: true }, "per_owner", T0);
  assert.equal(give(db, d.id, agent(AGENT_B.id)).state, "active", "an archived rule is not checked");
});

test("holder against owner: an agent may not have a role while its owner has the other; both ways round; a person with no agent is free", () => {
  const { db, ann } = world();
  const writer = role(db, "Writes invoices");
  const approver = role(db, "Approves invoices");
  rule(db, "holder_owner", writer.id, approver.id);
  // the owner has the owner's role: the agent may not take the agent's role
  give(db, approver.id, person(ann.id));
  assert.throws(() => give(db, writer.id, agent(AGENT_A.id)), (e: unknown) => {
    refused("cannot_hold_both", 409)(e);
    const m = (e as Error).message;
    assert.match(m, new RegExp(`The owner of ${AGENT_A.name}, Ann, already has Approves invoices \\(with no end date\\)`));
    assert.match(m, /an agent may not have Writes invoices while its owner has Approves invoices/);
    return true;
  });
  // an agent with no owner is free; so is an agent whose owner has a different role
  assert.equal(give(db, writer.id, agent(AGENT_B.id)).state, "active");
  // the other way: the agent has the agent's role, the owner may not take the owner's role
  const { db: db2, ann: ann2 } = world();
  const w2 = role(db2, "Writes invoices");
  const a2 = role(db2, "Approves invoices");
  rule(db2, "holder_owner", w2.id, a2.id);
  give(db2, w2.id, agent(AGENT_A.id));
  assert.throws(() => give(db2, a2.id, person(ann2.id)), (e: unknown) => {
    refused("cannot_hold_both", 409)(e);
    assert.match((e as Error).message, new RegExp(`Ann owns the agent ${AGENT_A.name}, which already has Writes invoices`));
    return true;
  });
  const bo = store.setPerson(db2, { name: "Bo" }, T0);
  assert.equal(give(db2, a2.id, person(bo.id)).state, "active", "a person who owns no such agent is free");
  // the rule is directional: the owner with the agent's role and the agent with the owner's role is fine
  assert.equal(give(db2, w2.id, person(bo.id)).state, "active");
  assert.equal(give(db2, a2.id, agent(AGENT_B.id)).state, "active");
});

test("a holder-owner rule may name one role twice: an agent may not have what its owner has", () => {
  const { db, ann } = world();
  const approver = role(db, "Approver");
  rule(db, "holder_owner", approver.id, approver.id);
  give(db, approver.id, person(ann.id));
  assert.throws(() => give(db, approver.id, agent(AGENT_A.id)), refused("cannot_hold_both", 409));
  assert.equal(give(db, approver.id, agent(AGENT_B.id)).state, "active", "no owner: free");
});

test("a rule: two different live roles, one live rule per pair in either order, a note, archive and bring back; it moves no revision", () => {
  const { db } = world();
  const a = role(db, "Approver");
  const b = role(db, "Payer");
  const r0 = rev(db);
  assert.throws(() => rule(db, "roles", a.id, a.id), refused("same_role", 400));
  assert.throws(() => rule(db, "roles", a.id, "rol_none"), refused("role_not_found", 404));
  assert.throws(() => setExclusion(db, { kind: "roles", roleA: a.id }, "per_owner", T0), refused("input_invalid", 400));
  assert.throws(() => setExclusion(db, { kind: "nonsense" as never, roleA: a.id, roleB: b.id }, "per_owner", T0), refused("input_invalid", 400));
  const made = setExclusion(db, { kind: "roles", roleA: b.id, roleB: a.id, note: "  Finance  policy ‮ " }, "per_owner", T0);
  assert.equal(made.note, "Finance policy", "the note is clean text");
  assert.equal(made.text, a.id < b.id ? "No one may have both Approver and Payer." : "No one may have both Payer and Approver.");
  assert.throws(() => rule(db, "roles", a.id, b.id), refused("rule_exists", 409), "the same pair in the other order is the same rule");
  assert.equal(rule(db, "holder_owner", a.id, b.id).kind, "holder_owner", "a holder-owner rule of the same roles is another rule");
  assert.equal(rev(db), r0, "a rule is not in the feed");
  // a rule is not edited
  assert.throws(() => setExclusion(db, { id: made.id, roleA: a.id }, "per_owner", T0), refused("input_invalid", 400));
  assert.throws(() => setExclusion(db, { id: made.id }, "per_owner", T0), refused("input_invalid", 400));
  assert.throws(() => setExclusion(db, { id: "xcl_none", archived: true }, "per_owner", T0), refused("rule_not_found", 404));
  // archive, repeat is a no-op, a new rule of the pair, then the old one cannot come back
  assert.equal(setExclusion(db, { id: made.id, archived: true }, "per_owner", T0).archived, true);
  const events = count(db, "fleet_lifecycle_events");
  assert.equal(setExclusion(db, { id: made.id, archived: true }, "per_owner", T0).archived, true);
  assert.equal(count(db, "fleet_lifecycle_events"), events, "a repeat writes nothing");
  const again = rule(db, "roles", a.id, b.id);
  assert.throws(() => setExclusion(db, { id: made.id, archived: false }, "per_owner", T0), refused("rule_exists", 409));
  setExclusion(db, { id: again.id, archived: true }, "per_owner", T0);
  assert.equal(setExclusion(db, { id: made.id, archived: false }, "per_owner", T0).archived, false);
  // a rule does not name an archived role, and one cannot come back while a role of it is archived
  setRole(db, { id: b.id, archived: true }, null, T0);
  assert.throws(() => rule(db, "roles", a.id, b.id), refused("role_archived", 409));
  assert.deepEqual(listExclusions(db, false, T0).filter((x) => x.idle).length, 2, "a rule with an archived role says it does nothing now");
  // the events name the rule
  const log = db.prepare("SELECT note FROM fleet_lifecycle_events WHERE subject_kind = 'exclusion' ORDER BY seq").all().map((r) => String(r.note));
  assert.match(log[0] as string, /^Rule added: No one may have both/);
  assert.ok(log.some((n) => /^Rule archived: it is no longer checked/.test(n)));
});

test("a rule is capped: 200 live rules, 503 never; the 201st is refused and archive frees a place", () => {
  const { db } = world();
  const roles = Array.from({ length: 21 }, (_, i) => role(db, `R${i}`));
  let n = 0;
  outer: for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      if (n === EXCLUSION_CAPS.rules) break outer;
      rule(db, "roles", (roles[i] as { id: string }).id, (roles[j] as { id: string }).id);
      n++;
    }
  }
  assert.equal(n, EXCLUSION_CAPS.rules);
  assert.throws(() => rule(db, "holder_owner", (roles[0] as { id: string }).id, (roles[1] as { id: string }).id), refused("too_many_rules", 409));
  const first = listExclusions(db, false)[0] as { id: string };
  setExclusion(db, { id: first.id, archived: true }, "per_owner", T0);
  assert.equal(rule(db, "holder_owner", (roles[0] as { id: string }).id, (roles[1] as { id: string }).id).kind, "holder_owner");
});

test("flagged on reconcile: a rule made after the roles shows who breaks it, with both roles named; a new owner flags an agent; the rule's list counts them", () => {
  const { db, ann } = world();
  const a = role(db, "Approver");
  const b = role(db, "Payer");
  give(db, a.id, person(ann.id));
  give(db, b.id, person(ann.id));
  assert.deepEqual(flags(db), [], "no rule: no flag");
  const made = rule(db, "roles", a.id, b.id);
  assert.equal(made.clashCount, 1, "the answer counts who already breaks it");
  assert.deepEqual(flags(db).map((f) => f.who), ["person:Ann"]);
  assert.match(flags(db)[0]?.text ?? "", /Ann has Approver and Payer now\. A rule says no one may have both\./);
  assert.deepEqual(made.clashes.map((c) => [c.subject.name, c.subject.kind]), [["Ann", "person"]]);
  // the Differences list carries it with the existing shape, and the open count includes it
  const list = findingsList(db, loadColleagues(db, T0).rows.map((r) => ({ kind: r.kind, id: r.id, name: r.name, at: r.at, findings: r.findings })), { read: true }, T0);
  const item = list.items.find((i) => i.code === "cannot_hold_both");
  assert.equal(item?.subject?.name, "Ann");
  const ok = validateAgainstSchema((manifest.operations.find((o) => o.id === "findings_list") as unknown as { output: Parameters<typeof validateAgainstSchema>[0] }).output, list as unknown as Json);
  assert.deepEqual(ok.ok ? [] : ok.errors, [], "the finding keeps the manifest shape (code and text only)");
  const open = (now = T0) => openDifferences(db, loadColleagues(db, now).rows, now);
  const withRule = open();
  setExclusion(db, { id: made.id, archived: true }, "per_owner", T0);
  assert.equal(withRule - open(), 1, "the open count includes the broken rule, and loses it with the rule");
  setExclusion(db, { id: made.id, archived: false }, "per_owner", T0);
  // holder against owner: allowed while the owner lacks the other role, then flagged on the agent when the owner changes. A change of owner is never refused.
  const w = role(db, "Writes");
  const ap = role(db, "Approves");
  rule(db, "holder_owner", w.id, ap.id);
  const bo = store.setPerson(db, { name: "Bo" }, T0);
  give(db, w.id, agent(AGENT_A.id));
  give(db, ap.id, person(bo.id));
  assert.deepEqual(flags(db).map((f) => f.who), ["person:Ann"]);
  store.setAgent(db, { agent: AGENT_A.id, owner: bo.id }, T0);
  assert.deepEqual(flags(db).map((f) => f.who).sort(), [`agent:${AGENT_A.name}`, "person:Ann"].sort());
  const text = flags(db).find((f) => f.who.startsWith("agent:"))?.text ?? "";
  assert.match(text, new RegExp(`${AGENT_A.name} has Writes, and its owner, Bo, has Approves now\\. A rule says an agent may not have Writes while its owner has Approves\\.`));
  assert.equal(listExclusions(db, false, T0).find((x) => x.kind === "holder_owner")?.clashCount, 1);
});

test("a role that starts later shows as 'from <date>', not 'now'; a clash that has not started yet is still named", () => {
  const { db, ann } = world();
  const a = role(db, "Approver");
  const b = role(db, "Payer");
  give(db, a.id, person(ann.id));
  give(db, b.id, person(ann.id), { validFrom: iso(T0 + 3 * DAY) });
  rule(db, "roles", a.id, b.id);
  assert.match(flags(db)[0]?.text ?? "", /Ann has Approver and Payer from 2026-11-02\./);
  assert.match(flags(db, T0 + 4 * DAY)[0]?.text ?? "", /Ann has Approver and Payer now\./, "once the overlap has begun it is 'now'");
});

test("an acceptance covers what the owner saw: a newer clash for the same entry shows again; T7 and an ended role clear the flag", () => {
  const { db, ann } = world();
  const a = role(db, "Approver");
  const b = role(db, "Payer");
  const c = role(db, "Treasurer");
  give(db, a.id, person(ann.id));
  give(db, b.id, person(ann.id));
  rule(db, "roles", a.id, b.id, T0 + 1000);
  const subjects = (now: number) => loadColleagues(db, now).rows.map((r) => ({ kind: r.kind, id: r.id, name: r.name, at: r.at, findings: r.findings }));
  const accept = (now: number) => {
    const row = subjects(now).find((s) => s.name === "Ann");
    return setException(db, { kind: "person", id: ann.id, code: "cannot_hold_both", reason: "Finance policy allows it this quarter", until: iso(now + 30 * DAY) }, row ?? null, "per_owner", now);
  };
  const shown = (now: number) => findingsList(db, subjects(now), { read: true }, now).items.find((i) => i.code === "cannot_hold_both")?.exception ?? null;
  const T1 = T0 + 2000;
  accept(T1);
  assert.equal(shown(T1 + 1)?.reason, "Finance policy allows it this quarter");
  const open = (now: number) => openDifferences(db, loadColleagues(db, now).rows, now);
  const covered = open(T1 + 1);
  // a second rule that Ann also breaks, made after the acceptance: news
  give(db, c.id, person(ann.id), {}, T1 + 4000);
  rule(db, "roles", a.id, c.id, T1 + 5000);
  assert.equal(shown(T1 + 7000), null, "a clash newer than the acceptance is not covered by it");
  assert.equal(open(T1 + 7000), covered + 1);
  // an ended role clears what it caused; T7 clears all
  const ras = db.prepare("SELECT id FROM fleet_role_assignments WHERE role_id = ?").get(c.id);
  endAssignment(db, String(ras?.id), "per_owner", T1 + 8000);
  assert.equal(flags(db, T1 + 8001).length, 1, "the first pair still stands");
  endAssignmentsOf(db, "person", ann.id, "closed", { kind: "system", id: null }, T1 + 9000);
  assert.deepEqual(flags(db, T1 + 9001), []);
});

test("a rule never blocks a stop, a transfer or a new owner", () => {
  const { db, ann } = world();
  const w = role(db, "Writes");
  const ap = role(db, "Approves");
  const bo = store.setPerson(db, { name: "Bo" }, T0);
  give(db, w.id, agent(AGENT_A.id));
  give(db, ap.id, person(bo.id));
  rule(db, "holder_owner", w.id, ap.id);
  store.setAgent(db, { agent: AGENT_A.id, owner: bo.id }, T0);
  assert.equal(flags(db).length, 1);
  set(db, "agent", AGENT_A.id, "suspended");
  set(db, "agent", AGENT_A.id, "leaving");
  assert.equal(String(db.prepare("SELECT lifecycle FROM fleet_agents WHERE id = ?").get(AGENT_A.id)?.lifecycle), "leaving", "the stop went through with the rule broken");
  assert.equal(ann.name, "Ann");
});

test("checkExclusions with no rule reads nothing and changes nothing; the flags cost no query without a rule", () => {
  const { db, ann } = world();
  const a = role(db, "Approver");
  const reads: string[] = [];
  const spy = {
    ...db,
    prepare: (sql: string) => {
      reads.push(sql);
      return db.prepare(sql);
    },
  } as Db;
  checkExclusions(spy, { role: { id: a.id, name: "Approver" }, subject: { kind: "person", id: ann.id, name: "Ann" }, from: T0, until: null }, T0);
  assert.equal(reads.length, 1, "one read of the live rules, and no more");
  reads.length = 0;
  assert.equal(exclusionFindings(spy, T0).size, 0);
  assert.equal(reads.length, 1);
  assert.equal(getExclusion(db, rule(db, "roles", a.id, role(db, "Payer").id).id, T0).clashCount, 0);
});

test("an acceptance under one owner does not cover the clash that a new owner brings", () => {
  const { db, ann } = world();
  const w = role(db, "Writes");
  const ap = role(db, "Approves");
  const bo = store.setPerson(db, { name: "Bo" }, T0);
  give(db, w.id, agent(AGENT_A.id));
  give(db, ap.id, person(bo.id));
  give(db, ap.id, person(ann.id));
  rule(db, "holder_owner", w.id, ap.id, T0 + 1000);
  const subjects = (now: number) => loadColleagues(db, now).rows.map((r) => ({ kind: r.kind, id: r.id, name: r.name, at: r.at, findings: r.findings }));
  const shown = (now: number) => findingsList(db, subjects(now), { read: true }, now).items.find((i) => i.code === "cannot_hold_both" && i.subject?.kind === "agent")?.exception ?? null;
  // the agent's owner Ann has Approves: the clash exists, the owner accepts it
  const T1 = T0 + 5000;
  const row = subjects(T1).find((s) => s.kind === "agent" && s.id === AGENT_A.id);
  setException(db, { kind: "agent", id: AGENT_A.id, code: "cannot_hold_both", reason: "Known, the quarter ends soon", until: iso(T1 + 30 * DAY) }, row ?? null, "per_owner", T1);
  assert.equal(shown(T1 + 1)?.reason, "Known, the quarter ends soon");
  // the owner changes to Bo, who also has Approves: a different clash, shown again
  setAgentMoved(db, { agent: AGENT_A.id, owner: bo.id }, { kind: "owner", id: "per_owner" }, T1 + 2000);
  assert.equal(shown(T1 + 3000), null, "a new owner is news");
  assert.equal(flags(db, T1 + 3000).filter((f) => f.who.startsWith("agent:")).length, 1);
});
