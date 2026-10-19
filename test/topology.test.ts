// Governance 0.2.2: the topology answer (`topology_get`, person op). The org layer comes from Governance's own data; the
// contacts and access layers say "unavailable" and carry no edges (G-5, G-2 are not shipped). Each guard has a
// quiet-on-good and a fire-on-bad case with the exact outcome (L34, L27).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ulid, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import type { TopologyGetOutput } from "#kit";
import { handlers, manifest } from "../src/app.ts";
import * as r from "../src/reviews.ts";
import { sameShown } from "../src/shown.ts";
import * as store from "../src/store.ts";
import { assertTopologyCaller, sourceNote, TOPOLOGY_CAPS, topologyGet } from "../src/topology.ts";
import { bigDirectory } from "./big.ts";
import { AGENT_A, AGENT_B, migratedDb } from "./helpers.ts";
import { seed } from "./seed.ts";

type Out = TopologyGetOutput;
const DAY = r.DAY_MS;
const T0 = Date.UTC(2026, 6, 1, 9, 0, 0); // when the seed entries were added (fixed, so due dates are exact)
const NOW = Date.UTC(2026, 9, 20, 9, 0, 0);
const OWNER = "per_01J0000000000000000000000P";
const log = { debug() {}, info() {}, warn() {}, error() {} };
const ctxOf = (db: Db, caller: object) => ({ db, caller, log }) as unknown as OpContext;
const ownerCtx = (db: Db) => ctxOf(db, { type: "person", id: OWNER, name: "owner", mode: null });
const topo = (db: Db, input: object = {}, c: OpContext = ownerCtx(db)) => handlers.topology_get.run(input as never, c) as Promise<Out>;
const op = manifest.operations.find((o) => o.id === "topology_get") as unknown as { audience: string; effect: string; idempotency: string; receipt: boolean; input: Parameters<typeof validateAgainstSchema>[0]; output: Parameters<typeof validateAgainstSchema>[0] };
const validOut = (out: unknown) => validateAgainstSchema(op.output, out as Json).ok;
const validIn = (input: unknown) => validateAgainstSchema(op.input, input as Json).ok;

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

/** The seed with fixed creation dates, so the schedule is exact: 180 days for contacts, 90 for agents. */
function fixedSeed() {
  const db = migratedDb();
  const s = seed(db);
  db.prepare("UPDATE fleet_people SET created_at = ?").run(T0);
  db.prepare("UPDATE fleet_agents SET first_seen = ?").run(T0);
  return { db, ...s };
}
const iso = (ms: number) => new Date(ms).toISOString();
const rows = (o: Out) => o.nodes.map((n) => [n.kind, n.name, n.trust, n.status, n.reviewDueAt, n.changedSinceReview]);
const edgeKey = (o: Out) => o.edges.map((e) => [e.kind, e.from, e.to, e.label, e.state]);

// ── the manifest ────────────────────────────────────────────────────────────────────────────────────────────────

test("topology_get is a person read: no idempotency, no receipt, not an agent tool", () => {
  assert.deepEqual([op.audience, op.effect, op.idempotency, op.receipt], ["person", "read", "none", false]);
  const agentOps = manifest.operations.filter((o) => (o as { audience?: string }).audience === "agent").map((o) => o.id);
  assert.ok(!agentOps.includes("topology_get"), "agents never get it as a tool");
});

test("input: layers are org, contacts, access (at most three); focus at most 64 characters; nothing else", () => {
  assert.equal(validIn({}), true);
  assert.equal(validIn({ layers: ["org", "contacts", "access"], focus: "x".repeat(64) }), true);
  assert.equal(validIn({ layers: ["bogus"] }), false);
  assert.equal(validIn({ layers: ["org", "org", "org", "org"] }), false);
  assert.equal(validIn({ focus: "x".repeat(65) }), false);
  assert.equal(validIn({ extra: 1 }), false);
});

// ── org layer ───────────────────────────────────────────────────────────────────────────────────────────────────

test("org layer on the seed: people, outside agent, agents, teams, owner and member edges, trust and due dates", async () => {
  const { db, ann, bo, bot, cy, support, ops } = fixedSeed();
  const out = await topo(db);
  assert.equal(validOut(out), true, "valid against the manifest output schema");
  assert.deepEqual(rows(out), [
    ["person", "Ann Example", "trusted", "active", iso(T0 + 180 * DAY), false],
    ["person", "Bo", "trusted", "departed", null, false], // departed: not scheduled
    ["person", "Cy", "unreviewed", "active", iso(T0), false], // never reviewed and unreviewed: due at once (its creation date)
    ["outside_agent", "Outside Bot", "trusted", "active", iso(T0 + 180 * DAY), false],
    ["agent", "Agent A", "trusted", "active", iso(T0 + 90 * DAY), false],
    ["agent", "Agent B", "trusted", "paused", iso(T0 + 90 * DAY), false],
    ["team", "Ops", null, "active", null, false],
    ["team", "Support", null, "active", null, false],
  ]);
  const ids = Object.fromEntries(out.nodes.map((n) => [n.name, n.id]));
  assert.deepEqual([ids["Ann Example"], ids.Bo, ids.Cy, ids["Outside Bot"], ids["Agent A"], ids["Agent B"], ids.Ops, ids.Support], [ann.id, bo.id, cy.id, bot.id, AGENT_A.id, AGENT_B.id, ops.id, support.id]);
  // the owner edge first; then the members (a paused agent's wire is off, the others live)
  assert.deepEqual(
    edgeKey(out).filter((e) => e[0] === "owner"),
    [["owner", ann.id, AGENT_A.id, "owns", "live"]],
  );
  const members = edgeKey(out).filter((e) => e[0] === "member");
  assert.deepEqual(
    members.sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    [
      ["member", ann.id, support.id, "lead", "live"],
      ["member", AGENT_A.id, support.id, "member", "live"],
      ["member", AGENT_B.id, ops.id, "lead", "off"],
      ["member", bot.id, support.id, "member", "live"],
      ["member", cy.id, ops.id, "member", "live"],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  );
  assert.equal(out.edges.length, 6);
  assert.equal(out.edges[0]?.kind, "owner", "owner edges come first, in a stable order");
  for (const e of out.edges) assert.equal(e.id, `${e.kind}:${e.from}:${e.to}`);
  assert.equal(out.edges.find((e) => e.kind === "owner")?.since, null, "the owner link has no date");
  assert.match(String(out.edges.find((e) => e.kind === "member")?.since), /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.deepEqual(out.sources, { contacts: "unavailable", access: "unavailable", note: out.sources.note });
});

test("a blocked end makes the wire blocked; a departed end makes it off; blocked wins", async () => {
  const { db, ann, bo, support } = fixedSeed();
  store.setMembers(db, { team: support.id, people: [{ id: ann.id, role: "lead" }, { id: bo.id, role: "member" }], agents: [{ id: AGENT_A.id, role: "member" }] });
  db.prepare("UPDATE fleet_people SET trust = 'blocked' WHERE id = ?").run(ann.id);
  const out = await topo(db);
  const wire = (from: string, to: string) => out.edges.find((e) => e.from === from && e.to === to)?.state;
  assert.equal(wire(ann.id, AGENT_A.id), "blocked", "owner wire: the owner is blocked");
  assert.equal(wire(ann.id, support.id), "blocked");
  assert.equal(wire(bo.id, support.id), "off", "Bo departed");
  assert.equal(wire(AGENT_A.id, support.id), "live", "quiet on good");
  db.prepare("UPDATE fleet_people SET trust = 'blocked' WHERE id = ?").run(bo.id);
  assert.equal((await topo(db)).edges.find((e) => e.from === bo.id && e.to === support.id)?.state, "blocked", "blocked wins over off");
});

test("a removed agent is listed only while a team still names it (like directory_feed)", async () => {
  const { db, support } = fixedSeed();
  const C = "agt_01J0000000000000000000000C";
  assert.equal(
    (await topo(db)).nodes.some((n) => n.id === C),
    false,
    "removed and in no team: not listed",
  );
  db.prepare("INSERT INTO fleet_members (team_id, kind, subject_id, role, created_at) VALUES (?, 'agent', ?, 'member', ?)").run(support.id, C, T0);
  const out = await topo(db);
  const c = out.nodes.find((n) => n.id === C);
  assert.deepEqual([c?.kind, c?.name, c?.status, c?.reviewDueAt], ["agent", "Agent C", "removed", null], "a removed agent is not scheduled");
  assert.deepEqual(edgeKey(out).filter((e) => e[1] === C), [["member", C, support.id, "member", "off"]]);
  assert.equal(validOut(out), true);
});

test("a member row that names nobody is left out (no dangling edge)", async () => {
  const { db, support } = fixedSeed();
  db.prepare("INSERT INTO fleet_members (team_id, kind, subject_id, role, created_at) VALUES (?, 'person', 'psn_ghost', 'member', ?)").run(support.id, T0);
  const out = await topo(db);
  assert.equal(out.edges.length, 6);
  assert.ok(!JSON.stringify(out).includes("psn_ghost"));
});

test("an id over 64 characters is left out with one warning, not an invalid answer", () => {
  const { db } = fixedSeed();
  db.prepare("INSERT INTO fleet_agents (id, name, mode, status, trust, first_seen, updated_at) VALUES (?, 'Long', 'free', 'active', 'trusted', ?, ?)").run(`agt_${"X".repeat(70)}`, T0, T0);
  const warnings: string[] = [];
  const out = topologyGet(db, {}, (m, f) => warnings.push(`${m} ${f.what}`));
  assert.equal(validOut(out), true);
  assert.ok(!out.nodes.some((n) => n.name === "Long"));
  assert.match(out.sources.note, / 1 entry left out: id too long\.$/, "L3: the owner is told, not only the log");
  assert.equal(warnings.length, 1);
  // a second one: counted, and quiet on good (the seed alone has no such note)
  db.prepare("INSERT INTO fleet_agents (id, name, mode, status, trust, first_seen, updated_at) VALUES (?, 'Long2', 'free', 'active', 'trusted', ?, ?)").run(`agt_${"Y".repeat(70)}`, T0, T0);
  assert.match(topologyGet(db, {}).sources.note, / 2 entries left out: id too long\.$/);
  assert.match(topologyGet(db, { layers: ["org"] }).sources.note, /^Only people, agents and teams were asked for\. 2 entries left out: id too long\.$/);
  assert.equal(validOut(topologyGet(db, {})), true);
  assert.ok(!/left out/.test(topologyGet(fixedSeed().db, {}).sources.note), "nothing left out: no such sentence");
  topologyGet(db, {}, (m) => warnings.push(m));
  assert.equal(warnings.length, 1, "one warning per id");
});

// ── review fields come from the review logic ────────────────────────────────────────────────────────────────────

test("reviewDueAt follows the verdict's date; changedSinceReview turns on when the picture changes and not when trust does", async () => {
  const { db, ann, cy } = fixedSeed();
  const look = (s: { kind: r.SubjectKind; id: string }) => (r.getReview(db, { subject: s }, NOW).current as r.Snapshot).digest;
  r.recordReview(db, OWNER, { subject: { kind: "person", id: cy.id }, verdict: "limited", reason: "Checked.", snapshotDigest: look({ kind: "person", id: cy.id }), nextReviewDays: 30 }, NOW);
  let out = await topo(db);
  let cyNode = out.nodes.find((n) => n.id === cy.id);
  assert.deepEqual([cyNode?.trust, cyNode?.reviewDueAt, cyNode?.changedSinceReview], ["limited", iso(NOW + 30 * DAY), false], "the verdict moved trust and the date; trust alone is not a change");
  assert.equal(out.nodes.find((n) => n.id === ann.id)?.changedSinceReview, false, "never reviewed: not changed");
  // the picture changes after the verdict: a new name, a new team
  store.setPerson(db, { id: cy.id, name: "Cy Renamed" });
  out = await topo(db);
  cyNode = out.nodes.find((n) => n.id === cy.id);
  assert.deepEqual([cyNode?.name, cyNode?.changedSinceReview], ["Cy Renamed", true]);
  assert.equal(out.nodes.filter((n) => n.changedSinceReview).length, 1, "only Cy");
  // the same answer as review_get: the digests differ too
  const got = r.getReview(db, { subject: { kind: "person", id: cy.id } }, NOW);
  assert.notEqual(got.current?.digest, got.review?.snapshot?.digest);
  // a new verdict looks at the new picture: quiet again
  r.recordReview(db, OWNER, { subject: { kind: "person", id: cy.id }, verdict: "trusted", reason: "Still fine.", snapshotDigest: look({ kind: "person", id: cy.id }) }, NOW + DAY);
  assert.equal((await topo(db)).nodes.find((n) => n.id === cy.id)?.changedSinceReview, false);
});

test("a changed team, owner or handle since the review also counts; a changed email does not (it is not in the picture the owner sees)", async () => {
  const { db, ann, cy, ops } = fixedSeed();
  const agentA = { kind: "agent" as const, id: AGENT_A.id };
  const verdict = (s: { kind: r.SubjectKind; id: string }) => r.recordReview(db, OWNER, { subject: s, verdict: "trusted", reason: "ok", snapshotDigest: (r.getReview(db, { subject: s }, NOW).current as r.Snapshot).digest }, NOW);
  verdict(agentA);
  verdict({ kind: "person", id: ann.id });
  const changed = async () => (await topo(db)).nodes.filter((n) => n.changedSinceReview).map((n) => n.name);
  assert.deepEqual(await changed(), []);
  store.setPerson(db, { id: ann.id, name: "Ann Example", email: "new-address@example.com" });
  assert.deepEqual(await changed(), [], "email is not in the shown picture");
  store.setMembers(db, { team: ops.id, people: [{ id: cy.id, role: "member" }], agents: [{ id: AGENT_B.id, role: "lead" }, { id: AGENT_A.id, role: "member" }] });
  assert.deepEqual(await changed(), ["Agent A"], "Agent A joined a team");
  store.setAgent(db, { agent: AGENT_A.id, owner: cy.id });
  store.setPerson(db, { id: ann.id, name: "Ann Example", handles: ["slack:UANN00001"] });
  assert.deepEqual((await changed()).sort(), ["Agent A", "Ann Example"]);
});

// ── contacts and access ─────────────────────────────────────────────────────────────────────────────────────────

test("contacts and access: an explicit unavailable state with a plain reason and zero edges of those kinds", async () => {
  const { db } = fixedSeed();
  for (const input of [{}, { layers: ["org", "contacts", "access"] }, { layers: ["contacts", "access"] }]) {
    const out = await topo(db, input);
    assert.deepEqual([out.sources.contacts, out.sources.access], ["unavailable", "unavailable"], JSON.stringify(input));
    assert.equal(out.sources.note, "Channel contacts are not shown: the Connect contact book is not available to apps yet. App access is not shown: the copy of access from Portal is not available to apps yet. Change access in Portal.");
    assert.equal(out.edges.filter((e) => e.kind === "contact" || e.kind === "access" || e.kind === "companion").length, 0);
    assert.equal(validOut(out), true);
  }
});

test("a layer that was not asked for says not_requested; asking for contacts alone gives no nodes and no edges, and says why", async () => {
  const { db } = fixedSeed();
  const orgOnly = await topo(db, { layers: ["org"] });
  assert.deepEqual(orgOnly.sources, { contacts: "not_requested", access: "not_requested", note: "Only people, agents and teams were asked for." });
  assert.equal(orgOnly.nodes.length, 8);
  const contactsOnly = await topo(db, { layers: ["contacts"] });
  assert.deepEqual([contactsOnly.nodes, contactsOnly.edges], [[], []]);
  assert.deepEqual([contactsOnly.sources.contacts, contactsOnly.sources.access], ["unavailable", "not_requested"]);
  assert.equal(contactsOnly.sources.note, "Channel contacts are not shown: the Connect contact book is not available to apps yet.");
  const accessOnly = await topo(db, { layers: ["access"] });
  assert.deepEqual([accessOnly.sources.contacts, accessOnly.sources.access], ["not_requested", "unavailable"]);
  assert.match(accessOnly.sources.note, /Change access in Portal\.$/);
  assert.equal(validOut(contactsOnly) && validOut(accessOnly) && validOut(orgOnly), true);
});

test("every note fits the schema (at most 280 characters)", () => {
  for (const c of ["available", "unavailable", "not_requested"] as const)
    for (const a of ["available", "unavailable", "not_requested"] as const) {
      for (const left of [0, 1, 3000]) {
        const note = sourceNote(c, a, left);
        assert.ok(note.length > 0 && note.length <= 280, `${c}/${a}/${left}: ${note.length}`);
      }
    }
});

// ── focus ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("focus: the node, its direct neighbours and the edges between them", async () => {
  const { db, ann, bot, cy, support, ops } = fixedSeed();
  const full = await topo(db);
  // the team Support: Ann, Outside Bot, Agent A are its neighbours; Ann also owns Agent A (an edge between two neighbours)
  const out = await topo(db, { focus: support.id });
  assert.deepEqual(out.nodes.map((n) => n.id).sort(), [ann.id, bot.id, AGENT_A.id, support.id].sort());
  assert.deepEqual(
    out.edges.map((e) => e.id).sort(),
    [`owner:${ann.id}:${AGENT_A.id}`, `member:${ann.id}:${support.id}`, `member:${bot.id}:${support.id}`, `member:${AGENT_A.id}:${support.id}`].sort(),
  );
  assert.equal(validOut(out), true);
  // the node data is the same as in the full answer
  for (const n of out.nodes) assert.deepEqual(n, full.nodes.find((x) => x.id === n.id));
  // a person: Cy sits in Ops only
  const cyOut = await topo(db, { focus: cy.id });
  assert.deepEqual(cyOut.nodes.map((n) => n.id).sort(), [cy.id, ops.id].sort());
  assert.deepEqual(cyOut.edges.map((e) => e.id), [`member:${cy.id}:${ops.id}`]);
  // fire on bad: a node that is not a neighbour is not there
  assert.ok(!cyOut.nodes.some((n) => n.id === support.id));
  // a lone node: Bo has no edge
  const lone = await topo(db, { focus: store.directory(db).people.find((p) => p.name === "Bo")?.id });
  assert.deepEqual([lone.nodes.length, lone.edges.length], [1, 0]);
  assert.equal(lone.sources.contacts, "unavailable", "the sources are still stated");
});

test("focus on an unknown id is node_not_found 404 (also empty, a layer without org, and a Connect-like id)", async () => {
  const { db, ann } = fixedSeed();
  assert.equal(await outcome(() => topo(db, { focus: "psn_nobody" })), "node_not_found 404");
  assert.equal(await outcome(() => topo(db, { focus: "" })), "node_not_found 404");
  assert.equal(await outcome(() => topo(db, { focus: "slack:UANN00001" })), "node_not_found 404", "a handle is not a node id");
  assert.equal(await outcome(() => topo(db, { focus: ann.id, layers: ["contacts"] })), "node_not_found 404", "no org layer: no such node in this answer");
  assert.equal(await outcome(() => topo(db, { focus: ann.id })), "ok", "quiet on good");
});

// ── caps ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("the caps are the draft's maxItems", () => {
  const maxItems = (field: "nodes" | "edges") => ((op.output as unknown as { properties: Record<string, { maxItems: number }> }).properties[field] as { maxItems: number }).maxItems;
  assert.deepEqual(TOPOLOGY_CAPS, { nodes: maxItems("nodes"), edges: maxItems("edges") });
});

test("at the design size (500 teams, 2000 people, 500 agents) the whole answer fits and is valid; one node more is refused", async () => {
  const { db } = bigDirectory();
  const t0 = performance.now();
  const out = await topo(db);
  const ms = performance.now() - t0;
  assert.equal(out.nodes.length, TOPOLOGY_CAPS.nodes, "exactly at the node cap: not refused");
  assert.equal(out.edges.length, 6500);
  assert.equal(validOut(out), true);
  assert.ok(ms < 500, `the full answer took ${Math.round(ms)} ms`);
  // fire on bad: one more node
  const now = Date.now();
  db.prepare("INSERT INTO fleet_agents (id, name, mode, status, owner_id, trust, first_seen, updated_at) VALUES (?, 'One more', 'free', 'active', NULL, 'trusted', ?, ?)").run(`agt_${ulid(now + 9999)}`, now, now);
  assert.equal(await outcome(() => topo(db)), "topology_too_large 503");
  // never cut silently: with a focus the answer fits, so it is returned whole
  const team = String(db.prepare("SELECT id FROM fleet_teams ORDER BY id LIMIT 1").get()?.id);
  const focused = await topo(db, { focus: team });
  assert.equal(focused.nodes.length, 13, "the team and its 12 members");
  assert.equal(validOut(focused), true);
});

/** A Db that counts the statements it runs (the number of queries is the budget, not the wall clock: L39). */
function counted(db: Db): { db: Db; count: () => number } {
  let n = 0;
  const wrapped: Db = {
    ...db,
    prepare: (sql: string) => {
      const st = db.prepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const run = (k: string) => (...a: unknown[]) => {
        n++;
        return (st[k] as (...a: unknown[]) => unknown).apply(st, a);
      };
      return new Proxy(st, {
        get: (t, k: string) => (k === "all" || k === "get" || k === "run" ? run(k) : typeof t[k] === "function" ? (t[k] as (...a: unknown[]) => unknown).bind(t) : t[k]),
      }) as unknown as ReturnType<Db["prepare"]>;
    },
  };
  return { db: wrapped, count: () => n };
}

test("design size, ALL 2500 subjects reviewed: a few queries, not thousands; the flags equal the per-subject rule; a focus is cheaper still", async () => {
  const { db, contactIds, agentIds, } = bigDirectory();
  const kindOf = new Map(db.prepare("SELECT id, kind FROM fleet_people").all().map((x) => [String(x.id), String(x.kind) as r.SubjectKind]));
  const subjects = [...contactIds.map((id) => ({ kind: kindOf.get(id) as r.SubjectKind, id })), ...agentIds.map((id) => ({ kind: "agent" as const, id }))];
  assert.equal(subjects.length, 2500);
  for (const s of subjects) {
    const digest = (r.getReview(db, { subject: s }, NOW).current as r.Snapshot).digest;
    r.recordReview(db, OWNER, { subject: s, verdict: "trusted", reason: "ok", snapshotDigest: digest }, NOW);
  }
  // after the verdicts: a rename, a new handle, a new team, a new owner, a paused agent
  const some = (xs: string[], from: number) => xs.slice(from, from + 5);
  const people = contactIds.filter((id) => kindOf.get(id));
  for (const id of some(people, 0)) store.setPerson(db, { id, name: `Renamed ${id.slice(-4)}` });
  for (const [i, id] of some(people, 50).entries()) store.setPerson(db, { id, name: String(db.prepare("SELECT name FROM fleet_people WHERE id = ?").get(id)?.name), handles: [`slack:UNEWH${String(i).padStart(5, "0")}`] });
  const team = String(db.prepare("SELECT id FROM fleet_teams ORDER BY id LIMIT 1").get()?.id);
  db.prepare("INSERT OR IGNORE INTO fleet_members (team_id, kind, subject_id, role, created_at) VALUES (?, 'agent', ?, 'member', ?)").run(team, agentIds[300], NOW);
  store.setAgent(db, { agent: agentIds[400] as string, owner: contactIds[1999] as string });
  db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(agentIds[450]);

  // the reference: the per-subject rule, one subject at a time (what the page and review_get do)
  const reference = new Set<string>();
  for (const s of subjects) {
    const entry = r.subjectOf(db, s.kind, s.id) as NonNullable<ReturnType<typeof r.subjectOf>>;
    const was = r.getReview(db, { subject: s }, NOW).review?.snapshot as r.Snapshot;
    if (!sameShown(was, r.snapshotOf(db, entry, NOW))) reference.add(`${s.kind}:${s.id}`);
  }
  assert.equal(reference.size, 13, "5 renames, 5 new handles, a team, an owner, a pause");

  const full = counted(db);
  const t0 = performance.now();
  const out = await topo(full.db);
  const ms = performance.now() - t0;
  const queries = full.count();
  console.log(`# topology at the design size, 2500 reviewed: ${queries} queries, ${Math.round(ms)} ms`);
  assert.deepEqual(new Set(out.nodes.filter((n) => n.changedSinceReview).map((n) => `${n.kind}:${n.id}`)), reference, "the set-based flags equal the per-subject rule");
  assert.ok(queries <= 25, `${queries} queries for the whole answer (it was about 9,500)`);
  assert.ok(ms < 1000, `the answer took ${Math.round(ms)} ms`); // generous: the query count is the real budget
  assert.equal(validOut(out), true);

  // a focus: the flags are computed for the nodes in the answer only
  const focusId = contactIds[0] as string; // renamed above
  const f = counted(db);
  const focused = await topo(f.db, { focus: focusId });
  assert.ok(f.count() <= queries, `${f.count()} queries for a focus`);
  assert.equal(focused.nodes.find((n) => n.id === focusId)?.changedSinceReview, true);
  assert.ok(focused.nodes.length < 40);
  for (const n of focused.nodes) assert.equal(n.changedSinceReview, n.kind === "team" ? false : reference.has(`${n.kind}:${n.id}`), n.name);
  // the changed lookup itself reads only what it is asked for
  const only = counted(db);
  assert.deepEqual([...r.changedSinceReview(only.db, new Set([`${kindOf.get(focusId)}:${focusId}`]))], [`${kindOf.get(focusId)}:${focusId}`]);
  assert.ok(only.count() <= 5, `${only.count()} queries for one subject`);
});

test("more than 10000 edges is refused with topology_too_large 503, 10000 is not", async () => {
  const { db, contactIds } = bigDirectory();
  const now = Date.now();
  const teams = db.prepare("SELECT id FROM fleet_teams ORDER BY id").all().map((t) => String(t.id));
  const add = db.prepare("INSERT OR IGNORE INTO fleet_members (team_id, kind, subject_id, role, created_at) VALUES (?, 'person', ?, 'member', ?)");
  let edges = 6500;
  // fill up to exactly the cap
  outer: for (let i = 0; i < contactIds.length; i++) {
    for (const t of teams) {
      if (edges === TOPOLOGY_CAPS.edges) break outer;
      if (add.run(t, contactIds[i], now).changes > 0) edges++;
    }
  }
  const out = await topo(db);
  assert.equal(out.edges.length, TOPOLOGY_CAPS.edges);
  assert.equal(validOut(out), true);
  add.run(teams[0], "psn_extra", now); // a dangling row is not an edge: still at the cap
  assert.equal((await topo(db)).edges.length, TOPOLOGY_CAPS.edges);
  db.prepare("INSERT INTO fleet_people (id, name, kind, trust, status, source, tags, created_at, updated_at) VALUES ('psn_extra', 'Extra', 'person', 'trusted', 'active', 'owner', '[]', ?, ?)").run(now, now);
  assert.equal(await outcome(() => topo(db)), "topology_too_large 503");
});

// ── person only ─────────────────────────────────────────────────────────────────────────────────────────────────

test("an agent caller is refused (no_access 403); so is an app; the owner is served", async () => {
  const { db } = fixedSeed();
  assert.equal(await outcome(() => topo(db, {}, ctxOf(db, { type: "agent", id: AGENT_A.id, name: "A", mode: "free" }))), "no_access 403");
  assert.equal(await outcome(() => topo(db, {}, ctxOf(db, { type: "agent", id: AGENT_B.id, name: "B", mode: "bound" }))), "no_access 403");
  assert.equal(await outcome(() => topo(db, { focus: "anything" }, ctxOf(db, { type: "agent", id: AGENT_A.id }))), "no_access 403", "an agent cannot probe for ids either");
  assert.equal(await outcome(() => topo(db, {}, ctxOf(db, { type: "app", id: "ins_rules" }))), "no_access 403");
  assert.equal(await outcome(() => topo(db, {}, ownerCtx(db))), "ok");
  assert.throws(() => assertTopologyCaller({ type: "agent" }), (e) => (e as { code?: string }).code === "no_access");
});

// ── nothing private in the answer ───────────────────────────────────────────────────────────────────────────────

test("the answer carries no email, handle, tag, title, description, role text or review reason", async () => {
  const { db, ann, cy } = fixedSeed();
  // markers built at run time, so a hit cannot be a coincidence
  const mark = randomUUID().slice(0, 8);
  const email = `mail-${mark}@example.org`;
  const title = `title-${mark}`;
  const tag = `tag-${mark}`;
  const reason = `reason-${mark}`;
  const why = `why-${mark}`;
  const handle = `slack:UMARK${mark.slice(0, 4).toUpperCase()}1`;
  store.setPerson(db, { id: ann.id, name: "Ann Example", email, title, tags: [tag], handles: [handle] });
  store.setAgent(db, { agent: AGENT_A.id, role: `role-${mark}`, tags: [tag] });
  r.requestReview(db, { kind: "agent", id: AGENT_A.id }, { subject: { kind: "person", id: cy.id }, why }, NOW);
  const look = (r.getReview(db, { subject: { kind: "person", id: cy.id } }, NOW).current as r.Snapshot).digest;
  r.recordReview(db, OWNER, { subject: { kind: "person", id: cy.id }, verdict: "limited", reason, snapshotDigest: look }, NOW);
  // the markers do reach the places they belong to (quiet-on-good is not a vacuous scan)
  assert.ok(JSON.stringify(store.directory(db)).includes(email), "overview_get has the email");
  assert.ok(JSON.stringify(r.getReview(db, { subject: { kind: "person", id: cy.id } }, NOW)).includes(reason), "review_get has the reason");
  for (const input of [{}, { focus: ann.id }, { focus: cy.id }, { layers: ["org"] }]) {
    const text = JSON.stringify(await topo(db, input));
    for (const secret of [email, title, tag, reason, why, handle, `role-${mark}`, "ann@example.com", "Chief Secret Officer", "vip-tag", "internal-only description", "secret-tag", "triage-role"]) assert.ok(!text.includes(secret), `${JSON.stringify(input)} must not carry ${secret}`);
    assert.ok(!/@|npub1|buzz:|slack:|telegram:/.test(text), `${JSON.stringify(input)}: no address-like text`);
  }
  // fire on bad: the scan would catch a leak
  assert.ok(/@|slack:/.test(JSON.stringify({ leak: `${email} ${handle}` })));
});

test("only the manifest keys: a node and an edge have exactly the declared members", async () => {
  const { db } = fixedSeed();
  const out = await topo(db);
  for (const n of out.nodes) assert.deepEqual(Object.keys(n).sort(), ["changedSinceReview", "id", "kind", "name", "reviewDueAt", "status", "trust"]);
  for (const e of out.edges) assert.deepEqual(Object.keys(e).sort(), ["from", "id", "kind", "label", "since", "state", "to"]);
  assert.deepEqual(Object.keys(out).sort(), ["edges", "nodes", "sources"]);
});

test("a long name is clipped to the schema's 200 characters, not refused", async () => {
  const { db } = fixedSeed();
  db.prepare("UPDATE fleet_agents SET name = ? WHERE id = ?").run("N".repeat(300), AGENT_A.id);
  const out = await topo(db);
  assert.equal(out.nodes.find((n) => n.id === AGENT_A.id)?.name.length, 200);
  assert.equal(validOut(out), true);
});

test("an empty directory answers with no nodes and no edges", async () => {
  const db = migratedDb();
  const out = await topo(db);
  assert.deepEqual([out.nodes, out.edges], [[], []]);
  assert.equal(validOut(out), true);
});
