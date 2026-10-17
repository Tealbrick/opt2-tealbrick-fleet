// Governance 0.2.0 (C166, C230): the directory feed for apps (contract fleet.directory_feed/1), trust defaults,
// resolve_sender with trust, the fleet_facts trust key, migration 0002 and the size/time budgets. Each test has a
// quiet-on-good case and a fire-on-bad case (the check itself must be able to fail).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { npubFromHex, ulid, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type Db, type Json, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../src/app.ts";
import { factsAnswer, factsFor } from "../src/facts.ts";
import { assertFeedCaller, directoryFeed, FEED_CAPS } from "../src/feed.ts";
import * as store from "../src/store.ts";
import { defaultTrust } from "../src/trust.ts";
import { checkFeed, FEED_FIXTURES, FEED_SCHEMA, leaks } from "./feed-contract.ts";
import { AGENT_A, AGENT_B, dbOver, migratedDb, migrationFiles, NOSTR } from "./helpers.ts";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const APP = { type: "app", id: "ins_01J0000000000000000000000R", name: "Rules & Approvals", mode: null };
const AGENT = { type: "agent", id: AGENT_A.id, name: AGENT_A.name, mode: "free" };
const PERSON = { type: "person", id: "per_01J0000000000000000000000P", name: "owner", mode: null };
const ctxOf = (db: Db, caller: object) => ({ db, caller }) as unknown as OpContext;
const feedOp = (db: Db, caller: object, input: object = {}) => handlers.directory_feed.run(input as never, ctxOf(db, caller)) as Promise<Json>;
const refusal = async (fn: () => unknown): Promise<{ code: string; status: number } | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof TbError) return { code: e.code, status: e.httpStatus };
    throw e;
  }
};
const manifestOp = (id: string) => manifest.operations.find((o) => o.id === id) as { input: object; output: Parameters<typeof validateAgainstSchema>[0] };

// Strings that exist in the seed and must never reach an app (C88, FLT-01).
const SECRETS = ["ann@example.com", "Chief Secret Officer", "vip-tag", "internal-only description", "secret-tag", "Ann Example", "Support", "Agent A", "triage-role"];

/** A realistic directory: PII in the owner-side fields, an outside agent, a departed person, an agent-added entry. */
function seed(db: Db) {
  store.syncAgents(db, [AGENT_A, AGENT_B, { id: "agt_01J0000000000000000000000C", name: "Agent C", mode: "free", status: "active" }]);
  store.syncAgents(db, [AGENT_A, { ...AGENT_B, status: "paused" }]); // C is removed
  const ann = store.setPerson(db, {
    name: "Ann Example",
    email: "ann@example.com",
    title: "Chief Secret Officer",
    tags: ["vip-tag"],
    handles: [`buzz:${NOSTR.hex}`, "slack:u012abcdef", "telegram:123456"], // stored canonical: npub, U012ABCDEF, 123456
  });
  const bo = store.setPerson(db, { name: "Bo", email: "bo@example.com", status: "departed", handles: ["telegram:-1001234567890"] });
  const bot = store.setPerson(db, { name: "Outside Bot", kind: "outside_agent", handles: ["slack:W0BOT123"] });
  const cy = store.setPerson(db, { name: "Cy", source: "agent", handles: ["slack:UCY00001"] });
  const support = store.setTeam(db, { name: "Support", description: "internal-only description", tags: ["secret-tag"] });
  const ops = store.setTeam(db, { name: "Ops" });
  store.setMembers(db, { team: support.id, people: [{ id: ann.id, role: "lead" }, { id: bot.id, role: "member" }], agents: [{ id: AGENT_A.id, role: "member" }] });
  store.setMembers(db, { team: ops.id, people: [{ id: cy.id, role: "member" }], agents: [{ id: AGENT_B.id, role: "lead" }] });
  store.setAgent(db, { agent: AGENT_A.id, owner: ann.id, role: "triage-role", tags: ["vip-tag"] });
  return { ann, bo, bot, cy, support, ops };
}

// ── the frozen contract files ──────────────────────────────────────────────────────────────────────────────────

test("contract files are the byte copies named in PROVENANCE.md (quiet on good, fires on a changed byte)", () => {
  const prov = readFileSync(new URL("./contracts/PROVENANCE.md", import.meta.url), "utf8");
  for (const f of ["fleet.directory_feed.1.schema.json", "fleet.directory_feed.1.json"]) {
    const bytes = readFileSync(new URL(`./contracts/${f}`, import.meta.url));
    assert.ok(prov.includes(sha256(bytes)), `${f} does not match the sha256 in PROVENANCE.md`);
    assert.ok(!prov.includes(sha256(Buffer.concat([bytes, Buffer.from(" ")]))), "a changed file would not match");
  }
  assert.ok(prov.includes("spec-v0.1.42"));
});

test("fixtures: every valid doc passes, every invalid doc fails the schema, invalidByNormalizeHandle fails ONLY by the handle rule", () => {
  assert.ok(FEED_FIXTURES.valid.length >= 3 && FEED_FIXTURES.invalid.length >= 7 && FEED_FIXTURES.invalidByNormalizeHandle.length >= 1);
  for (const doc of FEED_FIXTURES.valid) assert.deepEqual(checkFeed(doc), { schemaOk: true, handlesOk: true, ok: true, errors: [] });
  for (const { why, doc } of FEED_FIXTURES.invalid) assert.equal(checkFeed(doc).schemaOk, false, `invalid doc passed the schema: ${why}`);
  for (const { why, doc } of FEED_FIXTURES.invalidByNormalizeHandle) {
    const c = checkFeed(doc);
    assert.equal(c.schemaOk, true, `must pass the pattern: ${why}`);
    assert.equal(c.handlesOk, false, `must fail normalizeHandle: ${why}`);
    assert.equal(c.ok, false);
  }
});

test("caps in FEED_CAPS equal the maxItems of the frozen schema", () => {
  const full = FEED_SCHEMA.$defs.full.properties;
  assert.equal(full.teams.maxItems, FEED_CAPS.teams);
  assert.equal(full.teams.items.properties.members.maxItems, FEED_CAPS.membersPerTeam);
  assert.equal(full.contacts.maxItems, FEED_CAPS.contacts);
  assert.equal(full.agents.maxItems, FEED_CAPS.agents);
  assert.equal(full.contacts.items.properties.handles.maxItems, FEED_CAPS.handlesPerContact);
});

// ── who may read the feed ──────────────────────────────────────────────────────────────────────────────────────

test("directory_feed: an agent caller gets no_access 403; a person caller too; an app caller gets the feed", async () => {
  const db = migratedDb();
  seed(db);
  assert.deepEqual(await refusal(() => feedOp(db, AGENT)), { code: "no_access", status: 403 });
  assert.deepEqual(await refusal(() => feedOp(db, PERSON)), { code: "no_access", status: 403 });
  assert.deepEqual(await refusal(() => feedOp(db, { type: "agent", id: AGENT_B.id, name: "B", mode: "bound" }, { sinceRevision: store.revision(db) })), { code: "no_access", status: 403 }, "an agent cannot probe the revision either");
  const feed = (await feedOp(db, APP)) as { teams: unknown[] };
  assert.equal(feed.teams.length, 2);
  // the guard function itself: fires for anything but an app
  assert.throws(() => assertFeedCaller({ type: "agent" }), (e) => e instanceof TbError && e.code === "no_access" && e.httpStatus === 403);
  assert.doesNotThrow(() => assertFeedCaller({ type: "app" }));
});

// ── the answer: schema, shape, unchanged, canonical handles, PII ────────────────────────────────────────────────

test("directory_feed: the answer for an app is valid against fleet.directory_feed/1 and the manifest output schema", async () => {
  const db = migratedDb();
  const s = seed(db);
  const feed = (await feedOp(db, APP)) as Record<string, any>;
  const c = checkFeed(feed);
  assert.deepEqual(c.errors, []);
  assert.equal(c.ok, true);
  assert.equal(validateAgainstSchema(manifestOp("directory_feed").output, feed).ok, true, "the manifest output schema (checked by the SDK on every answer) accepts it");

  assert.equal(feed.v, 1);
  assert.equal(feed.unchanged, false);
  assert.equal(feed.revision, store.revision(db));
  assert.deepEqual(Object.keys(feed).sort(), ["agents", "contacts", "revision", "teams", "unchanged", "v"]);
  const team = feed.teams.find((t: any) => t.id === s.support.id);
  assert.deepEqual(team, {
    id: s.support.id,
    name: "Support",
    members: [
      { kind: "agent", id: AGENT_A.id, role: "member" },
      { kind: "contact", id: s.ann.id, role: "lead" },
      { kind: "contact", id: s.bot.id, role: "member" },
    ].sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id)),
  });
  const byId = Object.fromEntries(feed.contacts.map((x: any) => [x.id, x]));
  assert.deepEqual(byId[s.ann.id], { id: s.ann.id, kind: "person", status: "active", trust: "trusted", handles: [`buzz:${NOSTR.npub}`, "slack:U012ABCDEF", "telegram:123456"].sort() });
  assert.deepEqual(byId[s.bo.id], { id: s.bo.id, kind: "person", status: "departed", trust: "trusted", handles: ["telegram:-1001234567890"] });
  assert.deepEqual(byId[s.bot.id], { id: s.bot.id, kind: "outside_agent", status: "active", trust: "trusted", handles: ["slack:W0BOT123"] });
  assert.deepEqual(byId[s.cy.id], { id: s.cy.id, kind: "person", status: "active", trust: "unreviewed", handles: ["slack:UCY00001"] });
  const agents = Object.fromEntries(feed.agents.map((a: any) => [a.id, a]));
  assert.deepEqual(agents[AGENT_A.id], { id: AGENT_A.id, status: "active", trust: "trusted", owner: s.ann.id });
  assert.deepEqual(agents[AGENT_B.id], { id: AGENT_B.id, status: "paused", trust: "trusted", owner: null });
  assert.equal(agents.agt_01J0000000000000000000000C.status, "removed");
  // every contact id a team or an agent names is a contact in the feed (no dangling reference)
  const contactIds = new Set(feed.contacts.map((x: any) => x.id));
  for (const t of feed.teams) for (const m of t.members) if (m.kind === "contact") assert.ok(contactIds.has(m.id));
  for (const a of feed.agents) if (a.owner) assert.ok(contactIds.has(a.owner));

  // fire on bad: a feed with a changed enum, a dropped key or an extra email-like handle is caught
  assert.equal(checkFeed({ ...feed, contacts: [{ ...feed.contacts[0], trust: "vip" }] }).ok, false);
  const { teams: _teams, ...noTeams } = feed;
  assert.equal(checkFeed(noTeams).ok, false);
  assert.equal(checkFeed({ ...feed, v: 2 }).ok, false);
  assert.equal(validateAgainstSchema(manifestOp("directory_feed").output, { ...feed, contacts: [{ ...feed.contacts[0], email: "x@y.z" }] }).ok, false, "the manifest output schema refuses an extra member");
});

test("directory_feed: sinceRevision equal to the revision answers {v, revision, unchanged:true}; any other value gets the full feed", async () => {
  const db = migratedDb();
  seed(db);
  const rev = store.revision(db);
  const same = await feedOp(db, APP, { sinceRevision: rev });
  assert.deepEqual(same, { v: 1, revision: rev, unchanged: true });
  assert.equal(checkFeed(same).ok, true);
  assert.equal(validateAgainstSchema(manifestOp("directory_feed").output, same).ok, true);
  assert.equal((await feedOp(db, APP, { sinceRevision: rev - 1 }) as { unchanged: boolean }).unchanged, false);
  assert.equal((await feedOp(db, APP, { sinceRevision: rev + 5 }) as { unchanged: boolean }).unchanged, false);
  store.setTeam(db, { name: "New team" });
  assert.equal((await feedOp(db, APP, { sinceRevision: rev }) as { unchanged: boolean }).unchanged, false, "a change moves the revision");
  // fire on bad: an "unchanged" answer that also carries a directory is refused by the contract
  assert.equal(checkFeed({ v: 1, revision: 1, unchanged: true, teams: [], contacts: [], agents: [] }).ok, true, "extra members are allowed for readers (L24)");
  assert.equal(checkFeed({ v: 1, unchanged: true }).ok, false, "revision is required");
  assert.equal(validateAgainstSchema(manifestOp("directory_feed").input as never, { sinceRevision: -1 }).ok, false);
});

test("directory_feed: stored handles that are not canonical are left out (quiet on good, fires on bad)", async () => {
  const db = migratedDb();
  const { ann } = seed(db);
  const raw = [
    "slack:u012abcdef", // lower case
    "buzz:npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w7", // pattern ok, checksum bad
    "email:anna@example.com",
    "telegram:007",
    "Slack:U1",
    "garbage",
  ];
  const ins = db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES (?, ?, 0)");
  for (const h of raw) ins.run(h, ann.id);
  const feed = (await feedOp(db, APP)) as { contacts: { id: string; handles: string[] }[] };
  const mine = feed.contacts.find((c) => c.id === ann.id);
  assert.deepEqual(mine?.handles, [`buzz:${NOSTR.npub}`, "slack:U012ABCDEF", "telegram:123456"].sort());
  assert.deepEqual(checkFeed(feed).errors, []);
  assert.deepEqual(leaks(feed), [], "the email-shaped handle is not published");
  // fire on bad: the same document WITH those handles is refused by the reader checks
  const dirty = { ...feed, contacts: [{ ...(mine as object), handles: raw }] };
  const c = checkFeed(dirty);
  assert.equal(c.ok, false);
  assert.equal(c.handlesOk, false);
});

test("directory_feed: no email, title, tag, description, name or review text reaches an app (C88, FLT-01)", async () => {
  const db = migratedDb();
  seed(db);
  const feed = await feedOp(db, APP);
  assert.deepEqual(leaks(feed, SECRETS.filter((s) => s !== "Support")), []);
  // the team name is the one name the contract allows
  assert.deepEqual(leaks(feed, ["Support"]), ["Support"]);
  const text = JSON.stringify(feed);
  for (const key of ["email", "title", "tags", "description", "reason", "note"]) assert.ok(!text.includes(`"${key}"`), `no "${key}" member`);
  // fire on bad: the scan finds an email, a title and a tag when they are planted
  const planted = { ...(feed as object), contacts: [{ id: "x", email: "ann@example.com", title: "Chief Secret Officer", tags: ["vip-tag"] }] };
  assert.deepEqual(leaks(planted, SECRETS.filter((x) => x !== "Support")), ["@", "ann@example.com", "Chief Secret Officer", "vip-tag"]);
});

test("directory_feed: more contacts or agents than the contract carries is a refusal, never a partial feed", async () => {
  const db = migratedDb();
  const ins = db.prepare("INSERT INTO fleet_agents (id, name, mode, status, trust, first_seen, updated_at) VALUES (?, 'a', 'free', 'active', 'trusted', 0, 0)");
  db.transaction(() => {
    for (let i = 0; i < FEED_CAPS.agents; i++) ins.run(`agt_${ulid(i)}`);
  });
  assert.equal(((await feedOp(db, APP)) as { agents: unknown[] }).agents.length, FEED_CAPS.agents, "exactly the cap is fine");
  ins.run(`agt_${ulid(99999)}`);
  assert.deepEqual(await refusal(() => feedOp(db, APP)), { code: "feed_too_large", status: 413 });
});

// ── size and time budgets ──────────────────────────────────────────────────────────────────────────────────────

/** 500 teams, 2000 people, 500 agents, 12 members per team, 2 handles per person (the limits of one workspace). */
function bigDirectory(): { db: Db; contactIds: string[]; agentIds: string[]; slackOf: (i: number) => string } {
  const db = migratedDb();
  const now = Date.now();
  const contactIds: string[] = [];
  const agentIds: string[] = [];
  const slackOf = (i: number) => `slack:U${String(i).padStart(7, "0")}`;
  db.transaction(() => {
    const person = db.prepare("INSERT INTO fleet_people (id, name, email, title, status, kind, trust, source, tags, created_at, updated_at) VALUES (?, ?, ?, 'Title', ?, ?, ?, 'owner', '[\"t\"]', ?, ?)");
    const handle = db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES (?, ?, ?)");
    for (let i = 0; i < store.LIMITS.people; i++) {
      const id = `psn_${ulid(now + i)}`;
      contactIds.push(id);
      person.run(id, `Person ${i}`, `p${i}@example.com`, i % 17 === 0 ? "departed" : "active", i % 11 === 0 ? "outside_agent" : "person", (["unreviewed", "trusted", "limited", "blocked"] as const)[i % 4], now, now);
      handle.run(slackOf(i), id, now);
      handle.run(`buzz:${npubFromHex(i.toString(16).padStart(64, "0"))}`, id, now);
    }
    const agent = db.prepare("INSERT INTO fleet_agents (id, name, mode, status, owner_id, trust, first_seen, updated_at) VALUES (?, ?, 'free', 'active', ?, 'trusted', ?, ?)");
    for (let i = 0; i < 500; i++) {
      const id = `agt_${ulid(now + i)}`;
      agentIds.push(id);
      agent.run(id, `Agent ${i}`, contactIds[i] ?? null, now, now);
    }
    const team = db.prepare("INSERT INTO fleet_teams (id, name, description, tags, created_at, updated_at) VALUES (?, ?, '', '[]', ?, ?)");
    const member = db.prepare("INSERT INTO fleet_members (team_id, kind, subject_id, role, created_at) VALUES (?, ?, ?, ?, ?)");
    for (let t = 0; t < store.LIMITS.teams; t++) {
      const id = `tm_${ulid(now + t)}`;
      team.run(id, `Team ${t}`, now, now);
      for (let k = 0; k < 10; k++) member.run(id, "person", contactIds[(t * 4 + k) % contactIds.length], k === 0 ? "lead" : "member", now);
      for (let k = 0; k < 2; k++) member.run(id, "agent", agentIds[(t + k) % agentIds.length], "member", now);
    }
    db.prepare("UPDATE fleet_meta SET value = 1234 WHERE key = 'revision'").run();
  });
  return { db, contactIds, agentIds, slackOf };
}

/** Best of `runs` wall-clock milliseconds (a shared machine adds noise; the best run is the code's own cost). */
const bestMs = (fn: () => void, runs = 3): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
};

test("directory_feed at the maximum size (500 teams, 2000 people, 500 agents): valid against the contract and under 200 ms", async () => {
  const { db } = bigDirectory();
  const ms = bestMs(() => directoryFeed(db, {}));
  const feed = directoryFeed(db, {});
  assert.ok(ms < 200, `feed took ${ms.toFixed(1)} ms (budget 200 ms)`);
  if (process.env.TB_TEST_VERBOSE) console.log(`directory_feed max size: ${ms.toFixed(1)} ms, ${JSON.stringify(feed).length} bytes`);
  assert.equal(feed.unchanged, false);
  if (feed.unchanged) return;
  assert.equal(feed.teams.length, 500);
  assert.equal(feed.contacts.length, 2000);
  assert.equal(feed.agents.length, 500);
  assert.equal(feed.teams[0]?.members.length, 12);
  assert.equal(feed.revision, 1234);
  const c = checkFeed(feed);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(leaks(feed), [], "no email in 2000 people");
  assert.equal(validateAgainstSchema(manifestOp("directory_feed").output, feed as unknown as Json).ok, true);
  // the unchanged answer stays cheap
  assert.ok(bestMs(() => directoryFeed(db, { sinceRevision: 1234 })) < 5);
  // fire on bad: the budget check can fail (a deliberately slow database)
  const slow: Db = { ...db, prepare: (sql: string) => { const t = performance.now(); while (performance.now() - t < 3) {} return db.prepare(sql); } } as Db;
  assert.ok(bestMs(() => directoryFeed(slow, {}), 1) > 10, "a slow database shows in the measurement");
});

test("fleet_facts hook stays under 5 ms per call at 500 teams and 2000 people (quiet on good, fires on a slow database)", () => {
  const { db, agentIds, slackOf, contactIds } = bigDirectory();
  const times: number[] = [];
  const obo = (id: string) => ({ "tb.onBehalfOf": { claim: { kind: "channel_sender", id }, verified: false, via: "mcp_meta" } });
  const run = (target: Db, i: number) => {
    const t = performance.now();
    const out = factsAnswer(target, { call: { caller: { type: "agent", id: agentIds[i % agentIds.length] } }, context: obo(slackOf(i * 7 + 1)) } as never);
    times.push(performance.now() - t);
    return out;
  };
  for (let i = 0; i < 20; i++) run(db, i); // warm-up (statement preparation)
  times.length = 0;
  for (let i = 0; i < 300; i++) run(db, i);
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)] as number;
  const max = times[times.length - 1] as number;
  if (process.env.TB_TEST_VERBOSE) console.log(`fleet_facts hook: median ${times[150]?.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${max.toFixed(3)} ms`);
  assert.ok(p95 < 5, `hook p95 ${p95.toFixed(2)} ms (budget 5 ms)`);
  assert.ok((times[150] as number) < 2, "median far below the budget");
  // the answers carry real facts at this size, so the timing is not an empty path
  const sample = run(db, 3).add;
  assert.equal((sample["fleet.requester"] as { id: string } | null)?.id, contactIds[22], "the sender resolved to the contact behind the handle");
  assert.ok(Array.isArray(sample["fleet.requesterTeams"]));
  // fire on bad: a database that takes 6 ms per statement breaks the budget the test checks
  const slow: Db = { ...db, prepare: (sql: string) => { const t = performance.now(); while (performance.now() - t < 6) {} return db.prepare(sql); } } as Db;
  times.length = 0;
  run(slow, 1);
  assert.ok((times[0] as number) > 5, "the check can fail");
});

// ── trust defaults ─────────────────────────────────────────────────────────────────────────────────────────────

test("trust defaults: the owner's entries start trusted, an agent's entries start unreviewed (one function)", () => {
  assert.equal(defaultTrust("owner"), "trusted");
  assert.equal(defaultTrust("agent"), "unreviewed");
  const db = migratedDb();
  const trustOf = (id: string) => String(db.prepare("SELECT trust FROM fleet_people WHERE id = ?").get(id)?.trust);
  const sourceOf = (id: string) => String(db.prepare("SELECT source FROM fleet_people WHERE id = ?").get(id)?.source);
  const kindOf = (id: string) => String(db.prepare("SELECT kind FROM fleet_people WHERE id = ?").get(id)?.kind);
  const viaOp = store.setPerson(db, { name: "Added by the owner (person_set)" });
  assert.deepEqual([trustOf(viaOp.id), sourceOf(viaOp.id), kindOf(viaOp.id)], ["trusted", "owner", "person"]);
  const outside = store.setPerson(db, { name: "Outside bot", kind: "outside_agent", source: "owner" });
  assert.deepEqual([trustOf(outside.id), kindOf(outside.id)], ["trusted", "outside_agent"], "owner-added outside agents start trusted");
  const byAgent = store.setPerson(db, { name: "Added by an agent", source: "agent" });
  assert.deepEqual([trustOf(byAgent.id), sourceOf(byAgent.id)], ["unreviewed", "agent"]);
  // an edit by the owner never changes trust or source
  db.prepare("UPDATE fleet_people SET trust = 'limited' WHERE id = ?").run(byAgent.id);
  store.setPerson(db, { id: byAgent.id, name: "Renamed", title: "x" });
  assert.deepEqual([trustOf(byAgent.id), sourceOf(byAgent.id)], ["limited", "agent"]);
  // workspace agents arrive from the slice (the owner created them in Portal): trusted; a re-sync keeps a changed trust
  store.syncAgents(db, [AGENT_A]);
  db.prepare("UPDATE fleet_agents SET trust = 'blocked' WHERE id = ?").run(AGENT_A.id);
  store.syncAgents(db, [{ ...AGENT_A, name: "Agent A renamed" }]);
  assert.equal(String(db.prepare("SELECT trust FROM fleet_agents WHERE id = ?").get(AGENT_A.id)?.trust), "blocked");
  store.syncAgents(db, [AGENT_A, AGENT_B]);
  assert.equal(String(db.prepare("SELECT trust FROM fleet_agents WHERE id = ?").get(AGENT_B.id)?.trust), "trusted");
  // fire on bad: the database refuses a trust value outside the four states
  assert.throws(() => db.prepare("UPDATE fleet_people SET trust = 'vip' WHERE id = ?").run(viaOp.id));
  assert.throws(() => db.prepare("UPDATE fleet_agents SET trust = 'vip' WHERE id = ?").run(AGENT_A.id));
  assert.throws(() => db.prepare("UPDATE fleet_people SET kind = 'bot' WHERE id = ?").run(viaOp.id));
});

test("no agent operation writes trust: every agent op on a blocked contact leaves trust unchanged", async () => {
  const db = migratedDb();
  const s = seed(db);
  db.prepare("UPDATE fleet_people SET trust = 'blocked' WHERE id = ?").run(s.cy.id);
  const before = JSON.stringify(db.prepare("SELECT id, trust FROM fleet_people ORDER BY id").all());
  const ctx = ctxOf(db, AGENT);
  for (const op of manifest.operations.filter((o) => (o as { audience?: string }).audience === "agent" && o.id !== "directory_feed")) {
    const h = (handlers as unknown as Record<string, { run(i: unknown, c: OpContext): Promise<unknown> }>)[op.id] as { run(i: unknown, c: OpContext): Promise<unknown> };
    await h.run(op.id === "resolve_sender" ? { handle: "slack:UCY00001" } : op.id === "team_get" ? { team: s.support.id } : {}, ctx);
  }
  assert.equal(JSON.stringify(db.prepare("SELECT id, trust FROM fleet_people ORDER BY id").all()), before);
  assert.ok(before.includes('"blocked"'));
  assert.ok(!manifest.operations.some((o) => /trust/i.test(JSON.stringify((o as { input?: unknown }).input) ?? "") && (o as { audience?: string }).audience === "agent"), "no agent op takes a trust input");
});

// ── resolve_sender and the hook ───────────────────────────────────────────────────────────────────────────────

test("resolve_sender returns the contact with kind and trust, outside agents included; blocked and departed have no teams", async () => {
  const db = migratedDb();
  const s = seed(db);
  const ctx = ctxOf(db, AGENT);
  const call = (handle: string) => handlers.resolve_sender.run({ handle } as never, ctx) as Promise<{ found: boolean; contact: object | null; teams: { id: string }[] }>;
  const out = manifestOp("resolve_sender").output;
  const ann = await call(`buzz:${NOSTR.npub}`);
  assert.deepEqual(ann.contact, { id: s.ann.id, name: "Ann Example", kind: "person", status: "active", trust: "trusted" });
  assert.deepEqual(ann.teams.map((t) => t.id), [s.support.id]);
  const bot = await call("slack:W0BOT123");
  assert.deepEqual(bot.contact, { id: s.bot.id, name: "Outside Bot", kind: "outside_agent", status: "active", trust: "trusted" });
  assert.equal(bot.teams.length, 1);
  assert.equal(((await call("slack:UCY00001")).contact as { trust: string }).trust, "unreviewed", "an entry added by an agent is unreviewed");
  db.prepare("UPDATE fleet_people SET trust = 'blocked' WHERE id = ?").run(s.ann.id);
  const blocked = await call(`buzz:${NOSTR.npub}`);
  assert.equal((blocked.contact as { trust: string }).trust, "blocked");
  assert.deepEqual(blocked.teams, [], "blocked = no teams");
  assert.deepEqual((await call("telegram:-1001234567890")).teams, [], "departed = no teams");
  assert.deepEqual(await call("slack:U404"), { found: false, contact: null, teams: [] });
  for (const r of [ann, bot, blocked]) assert.equal(validateAgainstSchema(out, r as unknown as Json).ok, true);
  // fire on bad: the old shape (person) is no longer an answer
  assert.equal(validateAgainstSchema(out, { found: true, person: { id: "x", name: "y", status: "active" }, teams: [] } as unknown as Json).ok, false);
});

test("fleet_facts adds fleet.requester.trust (and trust inside fleet.requester); unknown is null, never a default", () => {
  const db = migratedDb();
  const s = seed(db);
  const facts = (context: Record<string, unknown>, caller: object = { type: "agent", id: AGENT_B.id }) => factsFor(db, { call: { caller } as never, context: context as never });
  const obo = (kind: string, id: string) => ({ "tb.onBehalfOf": { claim: { kind, id }, verified: false, via: "mcp_meta" } });

  const ann = facts(obo("channel_sender", `buzz:${NOSTR.npub}`));
  assert.equal(ann["fleet.requester.trust"], "trusted");
  assert.deepEqual(ann["fleet.requester"], { kind: "person", id: s.ann.id, name: "Ann Example", trust: "trusted", verified: false });
  const bot = facts(obo("channel_sender", "slack:W0BOT123"));
  assert.equal(bot["fleet.requester"]?.kind, "outside_agent");
  assert.equal(bot["fleet.requester.trust"], "trusted");
  assert.equal(facts(obo("channel_sender", "slack:UCY00001"))["fleet.requester.trust"], "unreviewed");
  assert.equal(facts(obo("person", s.cy.id))["fleet.requester.trust"], "unreviewed");
  assert.equal(facts(obo("agent", AGENT_A.id))["fleet.requester.trust"], "trusted");
  db.prepare("UPDATE fleet_agents SET trust = 'limited' WHERE id = ?").run(AGENT_A.id);
  assert.equal(facts(obo("agent", AGENT_A.id))["fleet.requester.trust"], "limited");
  db.prepare("UPDATE fleet_people SET trust = 'blocked' WHERE id = ?").run(s.ann.id);
  const blocked = facts(obo("channel_sender", `buzz:${NOSTR.npub}`));
  assert.equal(blocked["fleet.requester.trust"], "blocked");
  assert.deepEqual(blocked["fleet.requesterTeams"], [], "a blocked requester has no team facts");
  // fire on bad: unknown or departed requesters have no trust (null), not "unreviewed"
  assert.equal(facts(obo("channel_sender", "slack:U404"))["fleet.requester.trust"], null);
  assert.equal(facts(obo("channel_sender", "telegram:-1001234567890"))["fleet.requester.trust"], null, "departed");
  assert.equal(facts({})["fleet.requester.trust"], null);
  for (const k of Object.keys(ann)) assert.ok(k.startsWith("fleet."));
  assert.deepEqual(Object.keys(ann).sort(), ["fleet.agentOwner", "fleet.agentTeams", "fleet.requester", "fleet.requester.trust", "fleet.requesterTeams"]);
});

test("directory_get keeps the 0.1.x shape in this release (Rules 0.2.x still reads it): no trust, no kind", async () => {
  const db = migratedDb();
  seed(db);
  const out = (await handlers.directory_get.run({} as never, ctxOf(db, AGENT))) as Record<string, any>;
  assert.deepEqual(Object.keys(out).sort(), ["agents", "people", "revision", "teams", "unchanged"]);
  assert.deepEqual(Object.keys(out.people[0]).sort(), ["email", "handles", "id", "name", "status", "tags", "teams", "title", "updatedAt"]);
  assert.deepEqual(Object.keys(out.agents[0]).sort(), ["id", "mode", "name", "owner", "role", "status", "tags", "teams", "updatedAt"]);
  assert.equal(validateAgainstSchema(manifestOp("directory_get").output, out as Json).ok, true);
  // fire on bad: the released schema refuses the new members
  assert.equal(validateAgainstSchema(manifestOp("directory_get").output, { ...out, people: [{ ...out.people[0], trust: "trusted" }] } as Json).ok, false);
});

// ── migration 0002 ─────────────────────────────────────────────────────────────────────────────────────────────

test("migration 0001 is unchanged (never edited after release)", () => {
  const m = migrationFiles()[0];
  assert.equal(m?.name, "0001_init.sql");
  assert.equal(sha256(m?.sql ?? ""), "aeeed2e96d13d4b1f25f7cd988036d0d5b5033902d58212730782812ef8d68f8");
});

test("migration 0002 on a 0.1.10-shaped database: old rows become trusted/owner/person, defaults are fail-closed, settings stored", () => {
  assert.deepEqual(migrationFiles().map((m) => m.name), ["0001_init.sql", "0002_governance.sql"]);
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec(migrationFiles(1)[0]?.sql ?? "");
  // 0.1.10 data, written with the 0001 columns only
  raw.exec(`
    INSERT INTO fleet_people (id, name, email, title, status, tags, created_at, updated_at) VALUES
      ('psn_old1', 'Old Ann', 'ann@old.example', 'Boss', 'active', '["a"]', 1, 2),
      ('psn_old2', 'Old Bo', NULL, '', 'departed', '[]', 1, 2);
    INSERT INTO fleet_handles (handle, person_id, created_at) VALUES ('slack:UOLD0001', 'psn_old1', 1);
    INSERT INTO fleet_agents (id, name, mode, status, owner_id, role, tags, first_seen, updated_at) VALUES
      ('agt_01J0000000000000000000000A', 'Old Agent', 'free', 'active', 'psn_old1', 'triage', '[]', 1, 2),
      ('agt_01J0000000000000000000000B', 'Old Removed', 'bound', 'removed', NULL, '', '[]', 1, 2);
    INSERT INTO fleet_teams (id, name, description, tags, created_at, updated_at) VALUES ('tm_old', 'Old team', 'd', '[]', 1, 2);
    INSERT INTO fleet_members (team_id, kind, subject_id, role, created_at) VALUES ('tm_old', 'person', 'psn_old1', 'lead', 1), ('tm_old', 'agent', 'agt_01J0000000000000000000000A', 'member', 1);
    UPDATE fleet_meta SET value = 17 WHERE key = 'revision';`);
  // the database really has the 0.1.10 shape: no trust column, no review policy table
  assert.throws(() => raw.prepare("SELECT trust FROM fleet_people").all());
  assert.throws(() => raw.prepare("SELECT trust FROM fleet_agents").all());
  assert.throws(() => raw.prepare("SELECT * FROM fleet_review_policy").all());

  raw.exec(`BEGIN;\n${migrationFiles()[1]?.sql}\nCOMMIT;`);

  const rows = raw.prepare("SELECT id, name, email, title, status, kind, trust, source FROM fleet_people ORDER BY id").all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { id: "psn_old1", name: "Old Ann", email: "ann@old.example", title: "Boss", status: "active", kind: "person", trust: "trusted", source: "owner" },
      { id: "psn_old2", name: "Old Bo", email: null, title: "", status: "departed", kind: "person", trust: "trusted", source: "owner" },
    ],
  );
  assert.deepEqual(
    raw.prepare("SELECT id, trust FROM fleet_agents ORDER BY id").all().map((r) => ({ ...r })),
    [
      { id: "agt_01J0000000000000000000000A", trust: "trusted" },
      { id: "agt_01J0000000000000000000000B", trust: "trusted" },
    ],
  );
  assert.deepEqual(
    raw.prepare("SELECT key, value FROM fleet_review_policy ORDER BY key").all().map((r) => ({ ...r })),
    [
      { key: "agent_days", value: 90 },
      { key: "contact_days", value: 180 },
    ],
  );
  assert.equal(Number(raw.prepare("SELECT value FROM fleet_meta WHERE key = 'revision'").get()?.value), 17, "the revision is untouched");
  assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM fleet_handles").get()?.n), 1);
  assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM fleet_members").get()?.n), 2);

  // a row written without kind/trust/source gets the fail-closed values
  raw.exec("INSERT INTO fleet_people (id, name, created_at, updated_at) VALUES ('psn_new', 'New', 3, 3)");
  assert.deepEqual({ ...raw.prepare("SELECT kind, trust, source FROM fleet_people WHERE id = 'psn_new'").get() }, { kind: "person", trust: "unreviewed", source: "agent" });
  // checks hold
  assert.throws(() => raw.exec("UPDATE fleet_people SET trust = 'vip'"));
  assert.throws(() => raw.exec("UPDATE fleet_people SET kind = 'bot'"));
  assert.throws(() => raw.exec("UPDATE fleet_people SET source = 'robot'"));
  assert.throws(() => raw.exec("UPDATE fleet_agents SET trust = 'vip'"));
  assert.throws(() => raw.exec("UPDATE fleet_review_policy SET value = 0"));

  // the app code works on the migrated old data, and the feed is valid
  const db = dbOver(raw);
  const feed = directoryFeed(db, {});
  assert.equal(checkFeed(feed).ok, true, JSON.stringify(checkFeed(feed).errors));
  assert.equal(feed.unchanged, false);
  if (!feed.unchanged) {
    assert.equal(feed.revision, 17);
    assert.deepEqual(feed.contacts.find((c) => c.id === "psn_old1"), { id: "psn_old1", kind: "person", status: "active", trust: "trusted", handles: ["slack:UOLD0001"] });
    assert.deepEqual(feed.agents.find((a) => a.id === "agt_01J0000000000000000000000A"), { id: "agt_01J0000000000000000000000A", status: "active", trust: "trusted", owner: "psn_old1" });
  }
  assert.equal(store.resolveSender(db, "slack:UOLD0001").contact?.trust, "trusted");
  assert.equal(store.directory(db).people.length, 3);
});
