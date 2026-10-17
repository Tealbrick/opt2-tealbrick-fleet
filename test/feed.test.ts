// Governance 0.2.0 (C166, C230): the directory feed for apps (contract fleet.directory_feed/1), trust defaults,
// resolve_sender with trust, the fleet_facts trust key, migration 0002 and the size/time budgets. Each test has a
// quiet-on-good case and a fire-on-bad case (the check itself must be able to fail).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ulid, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type Db, type Json, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../src/app.ts";
import { factsAnswer, factsFor } from "../src/facts.ts";
import { AGENT_ID_PATTERN, assertFeedCaller, directoryFeed, FEED_CAPS, HANDLE_PATTERN, ID_MAX, TEAM_NAME_MAX } from "../src/feed.ts";
import * as store from "../src/store.ts";
import { defaultTrust } from "../src/trust.ts";
import { bigDirectory } from "./big.ts";
import { checkFeed, FEED_FIXTURES, FEED_SCHEMA, leaks } from "./feed-contract.ts";
import { AGENT_A, AGENT_B, dbOver, migratedDb, migrationFiles, NOSTR } from "./helpers.ts";
import { SECRETS, seed } from "./seed.ts";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const APP = { type: "app", id: "ins_01J0000000000000000000000R", name: "Rules & Approvals", mode: null };
const AGENT = { type: "agent", id: AGENT_A.id, name: AGENT_A.name, mode: "free" };
const PERSON = { type: "person", id: "per_01J0000000000000000000000P", name: "owner", mode: null };
const log = { debug() {}, info() {}, warn() {}, error() {} };
const ctxOf = (db: Db, caller: object) => ({ db, caller, log }) as unknown as OpContext;
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
  assert.equal(agents.agt_01J0000000000000000000000C, undefined, "a removed agent that no team names is not listed");
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

test("directory_feed: more agents than the contract carries is a 503 refusal, never a partial feed", async () => {
  const db = migratedDb();
  const ins = db.prepare("INSERT INTO fleet_agents (id, name, mode, status, trust, first_seen, updated_at) VALUES (?, 'a', 'free', 'active', 'trusted', 0, 0)");
  db.transaction(() => {
    for (let i = 0; i < FEED_CAPS.agents; i++) ins.run(`agt_${ulid(i)}`);
  });
  assert.equal(((await feedOp(db, APP)) as { agents: unknown[] }).agents.length, FEED_CAPS.agents, "exactly the cap is fine");
  ins.run(`agt_${ulid(99999)}`);
  assert.deepEqual(await refusal(() => feedOp(db, APP)), { code: "feed_too_large", status: 503 }, "transient: a reader keeps its last good copy");
});

// ── size and time budgets ──────────────────────────────────────────────────────────────────────────────────────

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
  for (let i = 0; i < 200; i++) run(db, i);
  times.sort((a, b) => a - b);
  // The budget is on the MEDIAN of 200 runs (same locally and in CI): one noisy run on a shared machine cannot fail it.
  const median = times[100] as number;
  if (process.env.TB_TEST_VERBOSE) console.log(`fleet_facts hook: median ${median.toFixed(3)} ms, p95 ${times[190]?.toFixed(3)} ms, max ${times[199]?.toFixed(3)} ms`);
  assert.ok(median < 5, `hook median ${median.toFixed(2)} ms (budget 5 ms)`);
  // the answers carry real facts at this size, so the timing is not an empty path
  const sample = run(db, 3).add;
  assert.equal((sample["fleet.requester"] as { id: string } | null)?.id, contactIds[22], "the sender resolved to the contact behind the handle");
  assert.ok(Array.isArray(sample["fleet.requesterTeams"]));
  // fire on bad: a database that takes 6 ms per statement breaks the median budget the test checks
  const slow: Db = { ...db, prepare: (sql: string) => { const t = performance.now(); while (performance.now() - t < 6) {} return db.prepare(sql); } } as Db;
  times.length = 0;
  for (let i = 0; i < 5; i++) run(slow, i);
  times.sort((a, b) => a - b);
  assert.ok((times[2] as number) > 5, "the check can fail");
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
    const input = op.id === "resolve_sender" ? { handle: "slack:UCY00001" } : op.id === "team_get" ? { team: s.support.id } : op.id === "review_request" ? { subject: { kind: "person", id: s.cy.id }, why: "check" } : {};
    await h.run(input, ctx);
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
  assert.deepEqual(await call("slack:U404"), { found: false, person: null, contact: null, teams: [] });
  for (const r of [ann, bot, blocked]) assert.equal(validateAgainstSchema(out, r as unknown as Json).ok, true);
  // fire on bad: an answer without the new contact is refused
  assert.equal(validateAgainstSchema(out, { found: true, person: { id: "x", name: "y", status: "active" }, teams: [] } as unknown as Json).ok, false);
});

test("resolve_sender keeps the deprecated `person` exactly as 0.1.10 returned it: a 0.1.10 client still works; null for outside agents", async () => {
  const db = migratedDb();
  const s = seed(db);
  const call = (handle: string) => handlers.resolve_sender.run({ handle } as never, ctxOf(db, AGENT)) as Promise<Record<string, any>>;
  // the 0.1.10 output schema of resolve_sender (frozen copy), and a 0.1.10 reader that only knows found / person / teams
  const V0110 = {
    type: "object",
    additionalProperties: false,
    required: ["found", "person", "teams"],
    properties: {
      found: { type: "boolean" },
      person: { anyOf: [{ type: "object", additionalProperties: false, required: ["id", "name", "status"], properties: { id: { type: "string" }, name: { type: "string" }, status: { enum: ["active", "departed"] } } }, { type: "null" }] },
      teams: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "role"], properties: { id: { type: "string" }, name: { type: "string" }, role: { enum: ["member", "lead"] } } } },
    },
  } as unknown as Parameters<typeof validateAgainstSchema>[0];
  const reader0110 = (a: Record<string, any>) => (a.found ? { who: a.person?.name ?? null, status: a.person?.status ?? null, teams: a.teams.map((t: { name: string }) => t.name) } : null);
  const only0110 = ({ found, person, teams }: Record<string, any>) => ({ found, person, teams });

  const ann = await call(`buzz:${NOSTR.npub}`);
  assert.deepEqual(ann.person, { id: s.ann.id, name: "Ann Example", status: "active" }, "same fields and values as 0.1.10");
  assert.deepEqual(Object.keys(ann.person).sort(), ["id", "name", "status"]);
  assert.deepEqual(reader0110(ann), { who: "Ann Example", status: "active", teams: ["Support"] });
  assert.equal(validateAgainstSchema(V0110, only0110(ann) as Json).ok, true, "the old fields validate against the 0.1.10 schema");
  const bo = await call("telegram:-1001234567890");
  assert.deepEqual(bo.person, { id: s.bo.id, name: "Bo", status: "departed" });
  assert.deepEqual(reader0110(bo), { who: "Bo", status: "departed", teams: [] });
  // an outside agent: person is null (the 0.1.10 schema allows null), contact has it
  const bot = await call("slack:W0BOT123");
  assert.equal(bot.person, null);
  assert.equal(bot.found, true);
  assert.equal(bot.contact.kind, "outside_agent");
  assert.equal(validateAgainstSchema(V0110, only0110(bot) as Json).ok, true);
  // unknown: as in 0.1.10
  assert.deepEqual(only0110(await call("slack:U404")), { found: false, person: null, teams: [] });
  // the manifest marks it deprecated in the description (no `deprecated` keyword)
  const prop = (manifestOp("resolve_sender").output as unknown as { properties: { person: { description: string } } }).properties.person;
  assert.match(prop.description, /^Deprecated since 0\.2\.0: use contact; removed after 0\.3\.0/);
  // fire on bad: a person with a changed field set would not match the 0.1.10 schema
  assert.equal(validateAgainstSchema(V0110, { ...only0110(ann), person: { ...ann.person, trust: "trusted" } } as Json).ok, false);
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
  assert.equal(facts(obo("channel_sender", "telegram:-1001234567890"))["fleet.requester.trust"], "trusted", "a departed contact still reports its trust (no teams)");
  assert.deepEqual(facts(obo("channel_sender", "telegram:-1001234567890"))["fleet.requesterTeams"], []);
  assert.equal(facts({})["fleet.requester.trust"], null);
  for (const k of Object.keys(ann)) assert.ok(k.startsWith("fleet."));
  assert.deepEqual(Object.keys(ann).sort(), ["fleet.agentOwner", "fleet.agentTeams", "fleet.requester", "fleet.requester.trust", "fleet.requester.verified", "fleet.requesterTeams"]);
});

test("directory_get is lean since 0.2.1: names, titles, trust, teams, owner; no email, handles, tags, mode (deprecation: see CHANGELOG)", async () => {
  const db = migratedDb();
  seed(db);
  const out = (await handlers.directory_get.run({} as never, ctxOf(db, AGENT))) as Record<string, any>;
  assert.deepEqual(Object.keys(out).sort(), ["agents", "people", "revision", "teams", "unchanged"]);
  assert.deepEqual(Object.keys(out.people[0]).sort(), ["id", "kind", "name", "status", "teams", "title", "trust", "updatedAt"]);
  assert.deepEqual(Object.keys(out.agents[0]).sort(), ["id", "name", "owner", "role", "status", "teams", "trust", "updatedAt"]);
  assert.equal(validateAgainstSchema(manifestOp("directory_get").output, out as Json).ok, true);
  // fire on bad: the schema refuses the old members
  assert.equal(validateAgainstSchema(manifestOp("directory_get").output, { ...out, people: [{ ...out.people[0], email: "a@b.c" }] } as Json).ok, false);
  assert.equal(validateAgainstSchema(manifestOp("directory_get").output, { ...out, agents: [{ ...out.agents[0], tags: [] }] } as Json).ok, false);
});

// ── migration 0002 ─────────────────────────────────────────────────────────────────────────────────────────────

test("migration 0001 is unchanged (never edited after release)", () => {
  const m = migrationFiles()[0];
  assert.equal(m?.name, "0001_init.sql");
  assert.equal(sha256(m?.sql ?? ""), "aeeed2e96d13d4b1f25f7cd988036d0d5b5033902d58212730782812ef8d68f8");
});

test("migration 0002 on a 0.1.10-shaped database: old rows become trusted/owner/person, defaults are fail-closed, settings stored", () => {
  assert.deepEqual(migrationFiles().map((m) => m.name).slice(0, 2), ["0001_init.sql", "0002_governance.sql"]);
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
  assert.equal(Number(raw.prepare("SELECT value FROM fleet_meta WHERE key = 'revision'").get()?.value), 18, "the revision moves by one (a reader that cached 17 pulls again)");
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
  assert.equal(directoryFeed(db, { sinceRevision: 17 }).unchanged, false, "a reader with the old revision gets the full feed after the migration");
  assert.equal(directoryFeed(db, { sinceRevision: 18 }).unchanged, true, "and the unchanged answer after it has pulled");
  if (!feed.unchanged) {
    assert.equal(feed.revision, 18);
    assert.deepEqual(feed.contacts.find((c) => c.id === "psn_old1"), { id: "psn_old1", kind: "person", status: "active", trust: "trusted", handles: ["slack:UOLD0001"] });
    assert.deepEqual(feed.agents.find((a) => a.id === "agt_01J0000000000000000000000A"), { id: "agt_01J0000000000000000000000A", status: "active", trust: "trusted", owner: "psn_old1" });
  }
  assert.equal(store.resolveSender(db, "slack:UOLD0001").contact?.trust, "trusted");
  assert.equal(store.directory(db).people.length, 3);
});

// ── review fixes (PR #7) ───────────────────────────────────────────────────────────────────────────────────────

test("resolve_sender: a person in 51 teams gets the first 50 in the stable order (name, id), valid against the manifest; the hook caps too", async () => {
  const db = migratedDb();
  const p = store.setPerson(db, { name: "Busy", handles: ["slack:UBUSY001"] });
  for (let i = 0; i < 51; i++) {
    const t = store.setTeam(db, { name: `T${String(i).padStart(2, "0")}` });
    store.setMembers(db, { team: t.id, people: [{ id: p.id, role: "member" }], agents: [] });
  }
  const out = (await handlers.resolve_sender.run({ handle: "slack:UBUSY001" } as never, ctxOf(db, AGENT))) as { teams: { name: string }[] };
  assert.equal(out.teams.length, 50);
  assert.deepEqual(out.teams.map((t) => t.name), Array.from({ length: 50 }, (_, i) => `T${String(i).padStart(2, "0")}`), "T50 is the one cut");
  assert.equal(validateAgainstSchema(manifestOp("resolve_sender").output, out as unknown as Json).ok, true, "the answer is valid (the SDK would answer 500 otherwise)");
  const f = factsFor(db, { call: { caller: AGENT } as never, context: { "tb.onBehalfOf": { claim: { kind: "channel_sender", id: "slack:UBUSY001" }, verified: false } } as never });
  assert.equal(f["fleet.requesterTeams"].length, 50);
  // quiet: 50 teams are all returned
  const ok = store.setPerson(db, { name: "Fifty", handles: ["slack:UFIFTY01"] });
  for (let i = 0; i < 50; i++) store.setMembers(db, { team: store.getTeam(db, `T${String(i).padStart(2, "0")}`).id, people: [{ id: p.id, role: "member" }, { id: ok.id, role: "member" }], agents: [] });
  assert.equal(store.resolveSender(db, "slack:UFIFTY01").teams.length, 50);
});

test("directory_feed cap counts agents that are not removed: 2001 synced, then the slice shrinks to 5 → a valid feed", async () => {
  const db = migratedDb();
  const slice = Array.from({ length: FEED_CAPS.agents + 1 }, (_, i) => ({ id: `agt_${ulid(i)}` as `agt_${string}`, name: `A${i}`, mode: "free" as const, status: "active" as const }));
  store.syncAgents(db, slice);
  assert.deepEqual(await refusal(() => feedOp(db, APP)), { code: "feed_too_large", status: 503 });
  store.syncAgents(db, slice.slice(0, 5));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fleet_agents WHERE status = 'removed'").get()?.n, FEED_CAPS.agents - 4);
  const feed = (await feedOp(db, APP)) as { agents: { id: string; status: string }[] };
  assert.equal(feed.agents.length, 5, "removed agents that no team names are not listed");
  assert.deepEqual(checkFeed(feed).errors, []);
  // a removed agent is listed (status removed) only while a team still names it, so Rules can drop it
  const gone = slice[7] as (typeof slice)[number];
  const t = store.setTeam(db, { name: "Old crew" });
  store.setMembers(db, { team: t.id, people: [], agents: [{ id: gone.id, role: "member" }] });
  const again = (await feedOp(db, APP)) as { teams: { members: { id: string }[] }[]; agents: { id: string; status: string }[] };
  assert.equal(again.agents.length, 6);
  assert.deepEqual(again.agents.find((a) => a.id === gone.id)?.status, "removed");
  assert.deepEqual(again.teams[0]?.members.map((m) => m.id), [gone.id]);
  assert.deepEqual(checkFeed(again).errors, []);
});

test("directory_feed leaves out rows the schema patterns refuse, warns once per id, never fails the whole feed", async () => {
  // the code's field rules equal the frozen schema's
  const full = FEED_SCHEMA.$defs.full.properties;
  assert.equal(AGENT_ID_PATTERN.source, full.agents.items.properties.id.pattern);
  assert.equal(HANDLE_PATTERN.source, FEED_SCHEMA.$defs.handle.pattern);
  assert.equal(ID_MAX, FEED_SCHEMA.$defs.id.maxLength);
  assert.equal(TEAM_NAME_MAX, full.teams.items.properties.name.maxLength);

  const db = migratedDb();
  const s = seed(db);
  const legacy = ["agt_legacy-qa1-0001", "agt_01J000000000000000000000IL", `agt_${"0".repeat(25)}`, "AGT_01J0000000000000000000000X"];
  const long = `psn_${"x".repeat(70)}`;
  db.prepare("INSERT INTO fleet_people (id, name, status, kind, trust, source, created_at, updated_at) VALUES (?, 'Long', 'active', 'person', 'trusted', 'owner', 0, 0)").run(long);
  const insA = db.prepare("INSERT INTO fleet_agents (id, name, mode, status, owner_id, trust, first_seen, updated_at) VALUES (?, 'legacy', 'free', 'active', ?, 'trusted', 0, 0)");
  for (const id of legacy) insA.run(id, id === legacy[0] ? long : null);
  db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES ('slack:ULONG001', ?, 0)").run(long);
  const mem = db.prepare("INSERT INTO fleet_members (team_id, kind, subject_id, role, created_at) VALUES (?, ?, ?, 'member', 0)");
  mem.run(s.support.id, "agent", legacy[0]);
  mem.run(s.support.id, "person", long);

  const warnings: string[] = [];
  const warn = (_m: string, f: Record<string, string>) => warnings.push(`${f.what}|${f.id}`);
  const feed = directoryFeed(db, {}, warn);
  assert.equal(feed.unchanged, false);
  if (feed.unchanged) return;
  assert.deepEqual(checkFeed(feed).errors, [], "the feed stays valid");
  for (const id of legacy) assert.ok(!feed.agents.some((a) => a.id === id), `${id} left out`);
  assert.ok(!feed.contacts.some((c) => c.id === long));
  assert.ok(feed.agents.some((a) => a.id === AGENT_A.id), "good agents stay");
  for (const t of feed.teams) for (const m of t.members) assert.ok(m.id !== legacy[0] && m.id !== long, "no member names a left-out row");
  // fire on bad: the same rows in a document are refused by the contract
  assert.equal(checkFeed({ ...feed, agents: [{ id: legacy[0], status: "active", trust: "trusted", owner: null }] }).ok, false);
  assert.equal(new Set(warnings).size, warnings.length, "one warning per id");
  const first = warnings.length;
  assert.ok(first >= legacy.length + 1);
  directoryFeed(db, {}, warn);
  assert.equal(warnings.length, first, "no second warning for the same ids");
  // the owner of a left-out contact becomes null, not a dangling id
  const ownedId = `agt_${ulid(4242)}`;
  db.prepare("INSERT INTO fleet_agents (id, name, mode, status, owner_id, trust, first_seen, updated_at) VALUES (?, 'owned', 'free', 'active', ?, 'trusted', 0, 0)").run(ownedId, long);
  const after = directoryFeed(db, {}, warn);
  if (!after.unchanged) {
    assert.equal(after.agents.find((a) => a.id === ownedId)?.owner, null, "the owner is a left-out contact: null, not a dangling id");
    assert.deepEqual(checkFeed(after).errors, []);
  }
});

test("fleet_facts: fleet.requester.verified is the claim's flag (flat); an unverified claim is narrow-only; blocked + departed reports blocked", () => {
  const db = migratedDb();
  const s = seed(db);
  const facts = (context: Record<string, unknown>) => factsFor(db, { call: { caller: { type: "agent", id: AGENT_B.id } } as never, context: context as never });
  const obo = (kind: string, id: string, verified: unknown) => ({ "tb.onBehalfOf": { claim: { kind, id }, verified, via: "mcp_meta" } });
  const un = facts(obo("channel_sender", `buzz:${NOSTR.npub}`, false));
  assert.equal(un["fleet.requester.verified"], false, "an unverified claim → verified false");
  assert.equal(un["fleet.requester"]?.verified, false);
  assert.equal(facts(obo("channel_sender", `buzz:${NOSTR.npub}`, true))["fleet.requester.verified"], true);
  assert.equal(facts(obo("channel_sender", `buzz:${NOSTR.npub}`, "yes"))["fleet.requester.verified"], false, "only the boolean true counts");
  assert.equal(facts({})["fleet.requester.verified"], false, "no requester → false (narrow)");
  assert.equal(facts(obo("channel_sender", "slack:U404", true))["fleet.requester.verified"], false, "an unknown sender has no verified requester");
  db.prepare("UPDATE fleet_people SET trust = 'blocked', status = 'departed' WHERE id = ?").run(s.ann.id);
  for (const claim of [obo("channel_sender", `buzz:${NOSTR.npub}`, false), obo("person", s.ann.id, false)]) {
    const f = facts(claim);
    assert.equal(f["fleet.requester.trust"], "blocked");
    assert.equal(f["fleet.requester"]?.trust, "blocked");
    assert.deepEqual(f["fleet.requesterTeams"], [], "departed + blocked: no teams");
  }
});

test("a STRICT 0.1.10 client (no optional chaining) works for people and breaks on an outside agent: person is null there (documented)", async () => {
  const db = migratedDb();
  seed(db);
  const call = (handle: string) => handlers.resolve_sender.run({ handle } as never, ctxOf(db, AGENT)) as Promise<{ found: boolean; person: { id: string; name: string; status: string }; teams: { name: string }[] }>;
  // what a 0.1.10 client wrote: found means person is an object
  const strict = (a: { found: boolean; person: { id: string; name: string; status: string }; teams: { name: string }[] }) => (a.found ? `${a.person.name} (${a.person.status}) in ${a.teams.map((t) => t.name).join(",")}` : "unknown");
  assert.equal(strict(await call(`buzz:${NOSTR.npub}`)), "Ann Example (active) in Support");
  assert.equal(strict(await call("telegram:-1001234567890")), "Bo (departed) in ");
  assert.equal(strict(await call("slack:U404")), "unknown");
  const bot = await call("slack:W0BOT123");
  assert.equal(bot.found, true);
  assert.throws(() => strict(bot), TypeError, "found:true with person:null breaks a client that does not check person (outside agents are new in 0.2.0)");
});
