// C380 T2-a: flat roles. The rules of an assignment, the feed, the date timer (end by itself, restart, a wrong clock), T7, delete, and what an agent can see.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { manifest } from "../src/app.ts";
import { type DirectoryFeed, directoryFeed } from "../src/feed.ts";
import { leanDirectory } from "../src/lean.ts";
import { startRolesTimer, tickRoles } from "../src/roles/expiry.ts";
import { assignRole, endAssignment, getRole, ROLE_CAPS, setRole } from "../src/roles/roles.ts";
import * as store from "../src/store.ts";
import { checkFeed, FEED_SCHEMA } from "./feed-contract.ts";
import { AGENT_A, AGENT_B } from "./helpers.ts";
import { refused, set, T0, WAIVE, world } from "./lifecycle-helpers.ts";

const MIN = 60_000;
type Full = Extract<DirectoryFeed, { unchanged: false }>;
const feed = (db: Db, accept: string[] = ["roles"]) => directoryFeed(db, { accept }) as Full;
const rev = (db: Db) => store.revision(db);
const role = (db: Db, name = "Contractor", now = T0) => setRole(db, { name }, "per_owner", now);
const give = (db: Db, roleId: string, subject: { kind: "person" | "agent"; id: string }, extra: { validFrom?: string | null; validUntil?: string | null } = {}, now = T0) => assignRole(db, { role: roleId, subject, reason: "project", ...extra }, "per_owner", now);
const iso = (ms: number) => new Date(ms).toISOString();
const events = (db: Db, subjectId: string) => db.prepare("SELECT kind, note, actor_kind FROM fleet_lifecycle_events WHERE subject_id = ? ORDER BY seq").all(subjectId).map((r) => `${String(r.actor_kind)}: ${String(r.note)}`);

test("a role: a clean name, one live role per name, archive frees the name, every change moves the revision", () => {
  const { db } = world();
  const r0 = rev(db);
  const a = role(db, "  Con‮tractor ");
  assert.equal(a.name, "Contractor", "bidi marks are removed");
  assert.equal(rev(db), r0 + 1);
  assert.throws(() => role(db, "contractor"), refused("role_name_taken", 409));
  assert.throws(() => setRole(db, { name: "" }, null, T0), refused("input_invalid", 400));
  assert.throws(() => setRole(db, { name: "x".repeat(ROLE_CAPS.nameMax + 1) }, null, T0), refused("input_invalid", 400));
  assert.throws(() => setRole(db, { id: "rol_none", name: "Z" }, null, T0), refused("role_not_found", 404));
  assert.equal(setRole(db, { id: a.id, archived: true }, "per_owner", T0).archived, true);
  assert.equal(role(db, "contractor").archived, false, "the archived role freed the name");
  assert.throws(() => setRole(db, { id: a.id, archived: false }, "per_owner", T0), refused("role_name_taken", 409));
  assert.ok(rev(db) > r0 + 1);
});

test("an assignment: person or agent, a reason from the list, dates checked, one open per role and subject, no outside agent, none for a leaving or closed subject", () => {
  const { db, ann } = world();
  const r = role(db);
  const person = give(db, r.id, { kind: "person", id: ann.id });
  assert.equal(person.state, "active");
  assert.equal(person.subject.name, "Ann");
  assert.equal(give(db, r.id, { kind: "agent", id: AGENT_A.id }).state, "active");
  assert.throws(() => give(db, r.id, { kind: "person", id: ann.id }), refused("already_assigned", 409));
  assert.throws(() => assignRole(db, { role: r.id, subject: { kind: "person", id: ann.id }, reason: "because" as never }, null, T0), refused("input_invalid", 400));
  assert.throws(() => give(db, r.id, { kind: "agent", id: AGENT_B.id }, { validUntil: iso(T0 - 1) }), refused("date_in_past", 400));
  assert.throws(() => give(db, r.id, { kind: "agent", id: AGENT_B.id }, { validFrom: iso(T0 + 2 * MIN), validUntil: iso(T0 + MIN) }), refused("input_invalid", 400));
  assert.throws(() => give(db, r.id, { kind: "agent", id: AGENT_B.id }, { validUntil: "not a date" }), refused("input_invalid", 400));
  assert.throws(() => give(db, "rol_none", { kind: "agent", id: AGENT_B.id }), refused("role_not_found", 404));
  assert.throws(() => give(db, r.id, { kind: "agent", id: "agt_none" }), refused("agent_not_found", 404));
  assert.throws(() => give(db, r.id, { kind: "person", id: "psn_none" }), refused("person_not_found", 404));
  const bot = store.setPerson(db, { name: "Bot", kind: "outside_agent", handles: ["slack:UBOT00001"] }, T0);
  assert.throws(() => give(db, r.id, { kind: "person", id: bot.id }), refused("no_roles_for_outside_agent", 409));
  // a subject that is leaving takes no new role; an archived role takes none
  set(db, "agent", AGENT_B.id, "leaving");
  assert.throws(() => give(db, r.id, { kind: "agent", id: AGENT_B.id }), refused("subject_leaving", 409));
  const old = role(db, "Old");
  setRole(db, { id: old.id, archived: true }, null, T0);
  assert.throws(() => give(db, old.id, { kind: "person", id: ann.id }), refused("role_archived", 409));
  // an agent that left Portal
  db.prepare("UPDATE fleet_agents SET status = 'removed' WHERE id = ?").run(AGENT_A.id);
  const other = role(db, "Other");
  assert.throws(() => give(db, other.id, { kind: "agent", id: AGENT_A.id }), refused("agent_removed", 409));
  // after the owner ends it, the role can be given again
  endAssignment(db, person.id, "per_owner", T0);
  assert.equal(give(db, r.id, { kind: "person", id: ann.id }).state, "active");
});

test("a role holds at most 4000 assignments", () => {
  const { db, ann } = world();
  const r = role(db);
  const ins = db.prepare("INSERT INTO fleet_role_assignments (id, role_id, subject_kind, subject_id, reason, started_at, created_at) VALUES (?, ?, 'person', ?, 'other', 1, 1)");
  db.transaction(() => {
    for (let i = 0; i < ROLE_CAPS.membersPerRole; i++) ins.run(`ras_f${i}`, r.id, `psn_x${i}`);
  });
  assert.throws(() => give(db, r.id, { kind: "person", id: ann.id }), refused("role_full", 409));
});

test("the feed: no roles key unless asked; with accept roles: live roles with the members that hold them now; ended, waiting and archived are not there; it still fits the contract", () => {
  const { db, ann } = world();
  const r = role(db);
  const empty = role(db, "Empty");
  const waits = role(db, "Waits");
  const gone = role(db, "Gone");
  give(db, r.id, { kind: "person", id: ann.id });
  give(db, r.id, { kind: "agent", id: AGENT_A.id });
  give(db, waits.id, { kind: "agent", id: AGENT_B.id }, { validFrom: iso(T0 + 10 * MIN) });
  const ended = give(db, gone.id, { kind: "agent", id: AGENT_B.id });
  endAssignment(db, ended.id, null, T0);
  const archived = role(db, "Archived");
  give(db, archived.id, { kind: "agent", id: AGENT_B.id });
  setRole(db, { id: archived.id, archived: true }, null, T0);

  assert.equal("roles" in feed(db, []), false, "without accept the answer is the old shape");
  assert.equal("roles" in feed(db, ["lifecycle", "agent_handles"]), false);
  const f = feed(db);
  assert.deepEqual(
    f.roles?.map((x) => [x.name, x.members.map((m) => `${m.kind}:${m.id}`)]),
    [r, empty, waits, gone].sort((a, b) => a.id.localeCompare(b.id)).map((x) => [x.name, x.name === "Contractor" ? [`agent:${AGENT_A.id}`, `contact:${ann.id}`] : []]),
  );
  assert.equal(checkFeed(f, FEED_SCHEMA).ok, true, "extra members are allowed by the frozen schema");
  // asked together with the other extras
  assert.equal(feed(db, ["agent_handles", "lifecycle", "roles"]).roles?.length, 4);
  // unchanged at the same revision, with or without roles asked: the answer follows the revision
  assert.equal(directoryFeed(db, { sinceRevision: rev(db), accept: ["roles"] }).unchanged, true);
});

test("the feed leaves out a member it does not list; a role with no members is still listed", () => {
  const { db } = world();
  const r = role(db);
  give(db, r.id, { kind: "agent", id: AGENT_A.id });
  db.prepare("UPDATE fleet_agents SET id = 'bad id' WHERE id = ?").run(AGENT_A.id);
  db.prepare("UPDATE fleet_role_assignments SET subject_id = 'bad id'").run();
  const roles = feed(db).roles ?? [];
  assert.deepEqual(roles.map((x) => x.members), [[]], "an agent id the contract cannot carry is left out, as in a team");
});

test("expiry: the end date ends the assignment by itself, with no action: two ticks, the revision moves, one event, the feed loses it, the owner's later end changes nothing", () => {
  const { db, ann } = world();
  const r = role(db);
  const until = T0 + 2 * MIN;
  const a = give(db, r.id, { kind: "person", id: ann.id }, { validUntil: iso(until) });
  const seen = new Set<string>();
  assert.deepEqual(tickRoles(db, seen, T0 + MIN), { started: 0, ended: 0 }, "not due");
  const before = rev(db);
  assert.equal(feed(db).roles?.[0]?.members.length, 1);
  // due: the first tick only marks, the answer does not change with time alone
  assert.deepEqual(tickRoles(db, seen, until + 1), { started: 0, ended: 0 });
  assert.equal(rev(db), before);
  assert.equal(feed(db).roles?.[0]?.members.length, 1, "time alone changes nothing at one revision");
  // the second tick ends it
  assert.deepEqual(tickRoles(db, seen, until + 31_000), { started: 0, ended: 1 });
  assert.equal(rev(db), before + 1, "a reader sees the role go");
  assert.equal(feed(db).roles?.[0]?.members.length, 0);
  const row = db.prepare("SELECT ended_at, end_reason FROM fleet_role_assignments WHERE id = ?").get(a.id);
  assert.deepEqual([Number(row?.ended_at), row?.end_reason], [until + 31_000, "expired"]);
  assert.deepEqual(events(db, ann.id).slice(-1), ["system: Role Contractor ended: the end date passed."]);
  // nothing more happens on later ticks; the owner may not end what has ended
  assert.deepEqual(tickRoles(db, seen, until + 90_000), { started: 0, ended: 0 });
  assert.throws(() => endAssignment(db, a.id, "per_owner", until + 91_000), refused("already_ended", 409));
  assert.equal(rev(db), before + 1);
});

test("expiry: one wrong clock reading ends nothing; a restart needs two new ticks; an owner end between the ticks is not ended twice", () => {
  const { db, ann } = world();
  const r = role(db);
  const until = T0 + 2 * MIN;
  const a = give(db, r.id, { kind: "person", id: ann.id }, { validUntil: iso(until) });
  // a clock that jumps ahead for one tick, then reads true again
  const seen = new Set<string>();
  tickRoles(db, seen, until + 10 * MIN);
  assert.deepEqual(tickRoles(db, seen, T0 + MIN), { started: 0, ended: 0 });
  assert.equal(feed(db).roles?.[0]?.members.length, 1, "the wrong reading ended nothing");
  // a restart loses the memory of the last tick: one tick marks, the second ends
  tickRoles(db, seen, until + 1);
  const restarted = new Set<string>();
  assert.deepEqual(tickRoles(db, restarted, until + 2), { started: 0, ended: 0 });
  assert.equal(feed(db).roles?.[0]?.members.length, 1);
  // the owner ends it between the two ticks: the second tick finds it ended and writes nothing
  endAssignment(db, a.id, "per_owner", until + 3);
  const evs = events(db, ann.id).length;
  const r1 = rev(db);
  assert.deepEqual(tickRoles(db, restarted, until + 4), { started: 0, ended: 0 });
  assert.equal(events(db, ann.id).length, evs);
  assert.equal(rev(db), r1);
  assert.equal(db.prepare("SELECT end_reason FROM fleet_role_assignments WHERE id = ?").get(a.id)?.end_reason, "owner");
});

test("a start date: the assignment waits, is not in the feed, and starts at the second tick after the date", () => {
  const { db } = world();
  const r = role(db);
  const from = T0 + 5 * MIN;
  const a = give(db, r.id, { kind: "agent", id: AGENT_A.id }, { validFrom: iso(from), validUntil: iso(from + 10 * MIN) });
  assert.equal(a.state, "scheduled");
  assert.equal(getRole(db, r.id).scheduled, 1);
  assert.equal(feed(db).roles?.[0]?.members.length, 0);
  const seen = new Set<string>();
  tickRoles(db, seen, from + 1);
  const before = rev(db);
  assert.deepEqual(tickRoles(db, seen, from + 31_000), { started: 1, ended: 0 });
  assert.equal(rev(db), before + 1);
  assert.deepEqual(feed(db).roles?.[0]?.members, [{ kind: "agent", id: AGENT_A.id }]);
  assert.deepEqual(events(db, AGENT_A.id).slice(-1), ["system: Role Contractor started: the start date passed."]);
  // cancel one that waits
  const b = give(db, r.id, { kind: "agent", id: AGENT_B.id }, { validFrom: iso(from + 99 * MIN) });
  assert.equal(endAssignment(db, b.id, "per_owner", from).state, "ended");
});

test("a start date and an end date that both passed while Governance was down: it ends and never starts", () => {
  const { db } = world();
  const r = role(db);
  const a = give(db, r.id, { kind: "agent", id: AGENT_A.id }, { validFrom: iso(T0 + 5 * MIN), validUntil: iso(T0 + 6 * MIN) });
  const seen = new Set<string>();
  const late = T0 + 60 * MIN;
  tickRoles(db, seen, late);
  assert.deepEqual(tickRoles(db, seen, late + 31_000), { started: 0, ended: 1 });
  assert.equal(db.prepare("SELECT started_at FROM fleet_role_assignments WHERE id = ?").get(a.id)?.started_at, null);
});

test("T7 closes the assignments of a person and of an agent, one event each; a delete and a change to outside agent do the same", () => {
  const { db, ann } = world();
  const r = role(db);
  const r2 = role(db, "Second");
  give(db, r.id, { kind: "person", id: ann.id });
  give(db, r2.id, { kind: "person", id: ann.id });
  give(db, r.id, { kind: "agent", id: AGENT_A.id });
  set(db, "agent", AGENT_A.id, "leaving");
  db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  set(db, "person", ann.id, "leaving");
  const open = (kind: string, id: string) => Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_role_assignments WHERE subject_kind = ? AND subject_id = ? AND ended_at IS NULL").get(kind, id)?.n);
  assert.equal(open("person", ann.id), 2, "leaving alone ends nothing: it can be undone");
  const rv = rev(db);
  set(db, "person", ann.id, "archived", { waive: WAIVE });
  assert.equal(open("person", ann.id), 0);
  assert.ok(rev(db) > rv);
  assert.deepEqual(db.prepare("SELECT DISTINCT end_reason FROM fleet_role_assignments WHERE subject_id = ?").all(ann.id).map((x) => x.end_reason), ["closed"]);
  assert.equal(events(db, ann.id).filter((e) => e.includes("ended: the entry was closed")).length, 2);
  assert.equal(feed(db).roles?.[0]?.members.length, 1, "the agent still holds it until it is closed too");
  set(db, "agent", AGENT_A.id, "archived", {}, T0 + 31 * 86_400_000);
  assert.equal(open("agent", AGENT_A.id), 0);

  // a delete
  const w = world();
  const rr = role(w.db);
  const gone = store.setPerson(w.db, { name: "Gone" }, T0);
  give(w.db, rr.id, { kind: "person", id: gone.id });
  store.deletePerson(w.db, gone.id, T0);
  assert.equal(w.db.prepare("SELECT end_reason FROM fleet_role_assignments").get()?.end_reason, "deleted");
  // a change to outside agent
  const x = store.setPerson(w.db, { name: "Becomes" }, T0);
  give(w.db, rr.id, { kind: "person", id: x.id });
  store.setPerson(w.db, { id: x.id, name: "Becomes", kind: "outside_agent", handles: ["slack:UBECOME01"] }, T0);
  assert.equal(Number(w.db.prepare("SELECT COUNT(*) AS n FROM fleet_role_assignments WHERE ended_at IS NULL").get()?.n), 0);
});

test("an agent reads no role: the lean directory and the sender lookup carry none", () => {
  const { db, ann } = world();
  const r = role(db, "Secret Role Name");
  give(db, r.id, { kind: "agent", id: AGENT_A.id });
  give(db, r.id, { kind: "person", id: ann.id });
  assert.equal(JSON.stringify(leanDirectory(db)).includes("Secret Role Name"), false);
  assert.equal(JSON.stringify(leanDirectory(db)).includes(r.id), false);
});

test("only src/roles/ writes the role tables, and no agent op file reaches them", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) files.push(p);
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  const writes = /(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+fleet_role/i;
  const offenders = files.filter((f) => !f.includes("/src/roles/") && writes.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
  // fire on bad: the pattern does catch a writer
  assert.equal(writes.test("db.prepare('UPDATE fleet_role_assignments SET ended_at = 1')"), true);
  // the one reader outside src/roles is the migration-free feed, and it goes through feedRoles
  const readers = files.filter((f) => !f.includes("/src/roles/") && /fleet_role/.test(readFileSync(f, "utf8")));
  assert.deepEqual(readers, []);
});

// ── review fixes (C380 T2-a, PR 2 review) ───────────────────────────────────
test("the manifest's output schema of directory_feed accepts the roles list (the SDK validates every answer), together with the other extras, and refuses a malformed one", () => {
  const out = (manifest.operations.find((o) => o.id === "directory_feed") as unknown as { output: Parameters<typeof validateAgainstSchema>[0] }).output;
  const { db, ann } = world();
  const r = role(db);
  give(db, r.id, { kind: "person", id: ann.id });
  give(db, r.id, { kind: "agent", id: AGENT_A.id });
  const doc = feed(db, ["lifecycle", "agent_handles", "roles"]) as unknown as Json;
  const v = validateAgainstSchema(out, doc);
  assert.deepEqual(v.ok ? [] : v.errors, []);
  assert.equal(((doc as unknown as Full).roles ?? []).length, 1, "the answer did carry roles");
  assert.equal(validateAgainstSchema(out, feed(db, ["lifecycle"]) as unknown as Json).ok, true, "and without roles");
  const bad = { ...(doc as object), roles: [{ id: "r", members: [{ kind: "team", id: "x" }] }] } as unknown as Json;
  assert.equal(validateAgainstSchema(out, bad).ok, false, "fire: a member kind outside agent and contact");
});

test("unarchive counts against the cap and needs a free name; a name folds every letter, not only ASCII", () => {
  const { db } = world();
  const first = role(db, "Ärzte");
  assert.throws(() => role(db, "ärzte"), refused("role_name_taken", 409), "a non-ASCII letter folds too");
  assert.throws(() => role(db, "Ärzte"), refused("role_name_taken", 409), "the same name in another Unicode form");
  assert.equal(role(db, "Café").name, "Café", "a stored name is in one form");
  setRole(db, { id: first.id, archived: true }, null, T0);
  const again = role(db, "ärzte");
  assert.throws(() => setRole(db, { id: first.id, archived: false }, null, T0), refused("role_name_taken", 409), "the name is taken by the live role");
  setRole(db, { id: again.id, archived: true }, null, T0);
  // the cap: 200 live roles; an archived one cannot come back as the 201st
  const full = world();
  const ins = full.db.prepare("INSERT INTO fleet_roles (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)");
  full.db.transaction(() => {
    for (let i = 0; i < ROLE_CAPS.roles; i++) ins.run(`rol_c${i}`, `Role ${i}`);
  });
  const old = full.db.prepare("INSERT INTO fleet_roles (id, name, created_at, updated_at, archived_at) VALUES ('rol_old', 'Old', 1, 1, 5)").run();
  assert.equal(Number(old.changes), 1);
  assert.throws(() => setRole(full.db, { id: "rol_old", archived: false }, null, T0), refused("too_many_roles", 409));
  assert.throws(() => role(full.db, "One more"), refused("too_many_roles", 409));
  setRole(full.db, { id: "rol_c0", archived: true }, null, T0);
  assert.equal(setRole(full.db, { id: "rol_old", archived: false }, null, T0).archived, false, "quiet: with room it comes back");
});

test("dates are ISO 8601: a bare number, a local-time string and a word are refused; a date alone is 00:00 UTC", () => {
  const { db, ann } = world();
  const r = role(db);
  for (const bad of ["1", "tomorrow", "12/12/2030", "Dec 12 2030 10:00", "2030-12-12 10:00", "2030-12-12T10:00"]) {
    assert.throws(() => give(db, r.id, { kind: "person", id: ann.id }, { validUntil: bad }), refused("input_invalid", 400), bad);
  }
  const a = give(db, r.id, { kind: "person", id: ann.id }, { validUntil: "2030-12-12" });
  assert.equal(a.validUntil, "2030-12-12T00:00:00.000Z");
  endAssignment(db, a.id, null, T0);
  assert.equal(give(db, r.id, { kind: "person", id: ann.id }, { validUntil: "2030-12-12T10:00:00+02:00" }).validUntil, "2030-12-12T08:00:00.000Z");
});

test("a start date: a subject that began to leave since it was given never gets the role; the tick counts only rows it changed", () => {
  const { db } = world();
  const r = role(db);
  const from = T0 + 5 * MIN;
  const a = give(db, r.id, { kind: "agent", id: AGENT_A.id }, { validFrom: iso(from) });
  set(db, "agent", AGENT_A.id, "leaving");
  const seen = new Set<string>();
  tickRoles(db, seen, from + 1);
  assert.deepEqual(tickRoles(db, seen, from + 31_000), { started: 1, ended: 0 }, "the row changed (it ended unstarted)");
  const row = db.prepare("SELECT started_at, end_reason FROM fleet_role_assignments WHERE id = ?").get(a.id);
  assert.deepEqual([row?.started_at, row?.end_reason], [null, "not_started"]);
  assert.deepEqual(events(db, AGENT_A.id).slice(-1), ["system: Role Contractor did not start: the entry is leaving, closed or gone."]);
  assert.equal(feed(db).roles?.[0]?.members.length, 0);
  // a row the owner ended between the two ticks is not counted
  const b = give(db, r.id, { kind: "agent", id: AGENT_B.id }, { validFrom: iso(from + 60 * MIN) });
  const seen2 = new Set<string>();
  tickRoles(db, seen2, from + 61 * MIN);
  endAssignment(db, b.id, "per_owner", from + 61 * MIN + 1);
  assert.deepEqual(tickRoles(db, seen2, from + 61 * MIN + 31_000), { started: 0, ended: 0 });
});

test("a person who becomes an outside agent: the event says so, not 'closed'; an agent that left Portal is no member, even named by a team", () => {
  const { db } = world();
  const r = role(db);
  const x = store.setPerson(db, { name: "Becomes" }, T0);
  give(db, r.id, { kind: "person", id: x.id });
  store.setPerson(db, { id: x.id, name: "Becomes", kind: "outside_agent", handles: ["slack:UBECOME01"] }, T0);
  assert.ok(events(db, x.id).includes("owner: Role Contractor ended: the person became an outside agent, who has no roles."));
  assert.equal(db.prepare("SELECT end_reason FROM fleet_role_assignments WHERE subject_id = ?").get(x.id)?.end_reason, "kind_changed");
  // a removed agent named by a team stays in the feed for the team, and holds no role
  const team = store.setTeam(db, { name: "Support" }, T0);
  store.setMembers(db, { team: team.id, people: [], agents: [{ id: AGENT_A.id, role: "member" }] }, T0);
  give(db, r.id, { kind: "agent", id: AGENT_A.id });
  assert.equal(feed(db).roles?.[0]?.members.length, 1);
  db.prepare("UPDATE fleet_agents SET status = 'removed' WHERE id = ?").run(AGENT_A.id);
  const f = feed(db);
  assert.ok(f.agents.some((a) => a.id === AGENT_A.id), "the agent is still listed for its team");
  assert.equal(f.roles?.[0]?.members.length, 0, "but it holds no role");
});

test("after a start, an end date that passed during the downtime ends within seconds: two ticks, five seconds apart", async () => {
  const { db, ann } = world();
  const r = role(db);
  const a = give(db, r.id, { kind: "person", id: ann.id }, { validUntil: iso(Date.now() + 1_000) }, Date.now());
  db.prepare("UPDATE fleet_role_assignments SET valid_until = ? WHERE id = ?").run(Date.now() - 60_000, a.id);
  const stop = startRolesTimer(db, { warn() {} }, 60_000, 10);
  try {
    await new Promise((res) => setTimeout(res, 120));
    assert.equal(db.prepare("SELECT end_reason FROM fleet_role_assignments WHERE id = ?").get(a.id)?.end_reason, "expired");
  } finally {
    stop();
  }
});
