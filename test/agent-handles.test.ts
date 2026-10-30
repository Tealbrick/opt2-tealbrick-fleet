// Governance 0.3.0 (C373, RULES-INTERFACE §3): agent handles in the directory feed. The cache is filled by a timer from
// Connect identities_list (outside calls), a change moves the revision, an error keeps the last cache, and only
// `accept: ["agent_handles"]` adds `agents[].handles`: without it the answer is byte-for-byte the old shape.
// Each test has a quiet-on-good case and a fire-on-bad case.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type Db, type Json, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { canonicalAgentHandle, REFRESH_MAX_PAGES, refreshAgentHandles, startAgentHandlesTimer } from "../src/agent-handles.ts";
import { definition, handlers, hooks, manifest } from "../src/app.ts";
import { cachedAgentHandles, directoryFeed } from "../src/feed.ts";
import * as store from "../src/store.ts";
import { checkFeed, FEED_FIXTURES, FEED_SCHEMA, FEED_SCHEMA_AGENT_HANDLES } from "./feed-contract.ts";
import { AGENT_A, AGENT_B, migratedDb, migrationFiles, NOSTR } from "./helpers.ts";
import { seed, seedOldSchema } from "./seed.ts";

const RULES = { type: "app", id: "ins_01J0000000000000000000000R", name: "Rules & Approvals", mode: null, product: "rules", listed: true };
const log = { debug() {}, info() {}, warn() {}, error() {} };
const BUZZ = `buzz:${NOSTR.npub}`;
const SLACK_A = "slack:UAGENTA01";
const SLACK_A2 = "slack:WAGENTA02";
const TG_B = "telegram:7000000001";

type Identity = { agent: unknown; channel?: unknown; identity: unknown };
/** A fake Connect: `pages` are served in order (cursor = page index); `mode` breaks it. Records every call. */
function fakeConnect(pages: Identity[][]) {
  const calls: { product: string; op: string; input: Json }[] = [];
  const c = {
    calls,
    pages,
    mode: "ok" as "ok" | "down" | "held" | "malformed" | "endless" | "no_grant",
    callApp: (async (product: string, op: string, input: Json) => {
      calls.push({ product, op, input });
      if (product !== "connect" || op !== "identities_list") throw new TbError("companion_undeclared", "x", 500);
      if (c.mode === "down") throw new TbError("network_error", "bridge unreachable", 503);
      if (c.mode === "no_grant") throw new TbError("no_grant", "no companion grant", 403);
      if (c.mode === "held") return { status: "held", holdId: "hld_1", expiresAt: "2026-10-27T00:00:00.000Z" };
      if (c.mode === "malformed") return { status: "ok", output: { identities: "nope", nextCursor: null } };
      const i = Number((input as { cursor?: string }).cursor ?? 0);
      if (c.mode === "endless") return { status: "ok", output: { identities: [], nextCursor: String(i + 1) } };
      const next = i + 1 < c.pages.length ? String(i + 1) : null;
      return { status: "ok", output: { identities: (c.pages[i] ?? []).map((r) => ({ channel: "x", ...r })), nextCursor: next } };
    }) as unknown as OpContext["callApp"],
  };
  return c;
}

const feedOp = (db: Db, input: object, callApp?: OpContext["callApp"]) =>
  handlers.directory_feed.run(input as never, { db, caller: RULES, log, callApp } as unknown as OpContext) as Promise<Record<string, any>>;
const manifestOutput = () => (manifest.operations.find((o) => o.id === "directory_feed") as unknown as { output: Parameters<typeof validateAgainstSchema>[0] }).output;
const manifestInput = () => (manifest.operations.find((o) => o.id === "directory_feed") as unknown as { input: Parameters<typeof validateAgainstSchema>[0] }).input;

function seeded() {
  const db = migratedDb();
  seed(db);
  return db;
}

// ── the contract files ────────────────────────────────────────────────────────────────────────────────────────

test("the agent-handles schema is the v1 byte copy plus ONLY the optional agents[].handles (fires on any other difference)", () => {
  const derived = structuredClone(FEED_SCHEMA_AGENT_HANDLES) as Record<string, any>;
  const handles = derived.$defs.full.properties.agents.items.properties.handles;
  assert.deepEqual({ ...handles, description: undefined }, { type: "array", maxItems: 16, uniqueItems: true, items: { $ref: "#/$defs/handle" }, description: undefined });
  assert.ok(!derived.$defs.full.properties.agents.items.required.includes("handles"), "handles is optional");
  delete derived.$defs.full.properties.agents.items.properties.handles;
  assert.deepEqual(derived, FEED_SCHEMA, "nothing else differs");
  // fire on bad: one more change would be seen
  const tampered = structuredClone(derived);
  tampered.$defs.full.properties.agents.maxItems = 2001;
  assert.notDeepEqual(tampered, FEED_SCHEMA);
});

test("old-shape fixtures still validate against the v1 schema AND the agent-handles copy; the copy refuses bad agent handles", () => {
  for (const doc of FEED_FIXTURES.valid) {
    assert.equal(checkFeed(doc).ok, true);
    assert.equal(checkFeed(doc, FEED_SCHEMA_AGENT_HANDLES).ok, true, "an answer without handles is valid in the new copy too");
  }
  for (const { why, doc } of FEED_FIXTURES.invalid) assert.equal(checkFeed(doc, FEED_SCHEMA_AGENT_HANDLES).schemaOk, false, why);
  const base = (FEED_FIXTURES.valid as Record<string, any>[]).find((d) => Array.isArray(d.agents) && d.agents.length > 0);
  assert.ok(base, "a valid fixture with agents");
  const withHandles = (handles: unknown) => ({ ...base, agents: base.agents.map((a: object) => ({ ...a, handles })) });
  // quiet on good
  assert.deepEqual(checkFeed(withHandles([BUZZ, SLACK_A]), FEED_SCHEMA_AGENT_HANDLES).errors, []);
  assert.equal(checkFeed(withHandles([]), FEED_SCHEMA_AGENT_HANDLES).ok, true);
  // fire on bad
  assert.equal(checkFeed(withHandles(["email:a@example.com"]), FEED_SCHEMA_AGENT_HANDLES).schemaOk, false, "off the handle pattern");
  assert.equal(checkFeed(withHandles([SLACK_A, SLACK_A]), FEED_SCHEMA_AGENT_HANDLES).schemaOk, false, "duplicates");
  assert.equal(checkFeed(withHandles(Array.from({ length: 17 }, (_, i) => `slack:U${String(i).padStart(4, "0")}AB`)), FEED_SCHEMA_AGENT_HANDLES).schemaOk, false, "more than 16");
  assert.equal(checkFeed(withHandles("slack:UAGENTA01"), FEED_SCHEMA_AGENT_HANDLES).schemaOk, false, "not an array");
  const badChecksum = `buzz:${NOSTR.npub.slice(0, -1)}${NOSTR.npub.endsWith("q") ? "p" : "q"}`;
  const c = checkFeed(withHandles([badChecksum]), FEED_SCHEMA_AGENT_HANDLES);
  assert.equal(c.schemaOk, true, "passes the pattern");
  assert.equal(c.handlesOk, false, "the reader rule normalizeHandle(h) === h covers agent handles too");
});

test("manifest: accept is an optional array of short strings; handles is optional on agents", () => {
  const input = manifestInput();
  for (const ok of [{}, { accept: [] }, { accept: ["agent_handles"] }, { accept: ["agent_handles", "future_thing"] }, { sinceRevision: 3, accept: ["x"] }]) assert.equal(validateAgainstSchema(input, ok as Json).ok, true, JSON.stringify(ok));
  for (const bad of [{ accept: "agent_handles" }, { accept: [42] }, { accept: [""] }, { accept: Array(9).fill("x") }, { accept: ["x".repeat(65)] }, { other: 1 }]) assert.equal(validateAgainstSchema(input, bad as unknown as Json).ok, false, JSON.stringify(bad));
});

// ── the canonical form ──────────────────────────────────────────────────────────────────────────────────────────

test("canonicalAgentHandle: canonical feed handles pass, anything the feed cannot carry is null", () => {
  for (const h of [BUZZ, SLACK_A, SLACK_A2, TG_B]) assert.equal(canonicalAgentHandle(h), h);
  for (const bad of ["email:a@example.com", "slack:", "teams:abc", "discord:123", "", 42, null, {}, `slack:U${"A".repeat(400)}`]) assert.equal(canonicalAgentHandle(bad), null, String(bad));
});

// ── the refresh (timer side) ────────────────────────────────────────────────────────────────────────────────────

test("refresh: a complete Connect answer fills the cache once and moves the revision; the same answer again does not", async () => {
  const db = seeded();
  const connect = fakeConnect([
    [
      { agent: AGENT_A.id, identity: SLACK_A2 },
      { agent: AGENT_A.id, identity: SLACK_A },
    ],
    [
      { agent: AGENT_A.id, identity: BUZZ },
      { agent: AGENT_B.id, identity: TG_B },
      { agent: AGENT_B.id, identity: TG_B }, // a duplicate row
      { agent: AGENT_B.id, identity: "email:b@example.com" }, // a kind the feed cannot carry
      { agent: "agt_bad", identity: SLACK_A }, // an id the feed cannot carry
      { agent: AGENT_B.id, identity: 7 },
    ],
  ]);
  const r0 = store.revision(db);
  assert.deepEqual(await refreshAgentHandles(db, connect.callApp, 1000), { status: "updated", agents: 2, handles: 4 });
  assert.equal(store.revision(db), r0 + 1);
  assert.deepEqual(Object.fromEntries(cachedAgentHandles(db)), { [AGENT_A.id]: [BUZZ, SLACK_A, SLACK_A2], [AGENT_B.id]: [TG_B] });
  assert.equal(connect.calls.length, 2, "followed the cursor");
  assert.deepEqual(connect.calls[1]?.input, { cursor: "1" });
  // quiet: the same answer is no change
  assert.equal((await refreshAgentHandles(db, connect.callApp)).status, "unchanged");
  assert.equal(store.revision(db), r0 + 1);
  // fire: a changed handle set moves the revision again
  connect.pages[1] = [{ agent: AGENT_B.id, identity: TG_B }];
  assert.equal((await refreshAgentHandles(db, connect.callApp)).status, "updated");
  assert.equal(store.revision(db), r0 + 2);
  assert.deepEqual(Object.fromEntries(cachedAgentHandles(db)), { [AGENT_A.id]: [SLACK_A, SLACK_A2], [AGENT_B.id]: [TG_B] });
  // a complete EMPTY answer is real: the cache is cleared (and the revision moves)
  connect.pages.splice(0, connect.pages.length, []);
  assert.equal((await refreshAgentHandles(db, connect.callApp)).status, "updated");
  assert.equal(cachedAgentHandles(db).size, 0);
  assert.equal(store.revision(db), r0 + 3);
});

test("refresh: Connect down, not granted, held, malformed or endless paging keeps the LAST cache and the revision", async () => {
  const db = seeded();
  const connect = fakeConnect([[{ agent: AGENT_A.id, identity: SLACK_A }]]);
  await refreshAgentHandles(db, connect.callApp);
  const before = Object.fromEntries(cachedAgentHandles(db));
  const rev = store.revision(db);
  for (const mode of ["down", "no_grant", "held", "malformed", "endless"] as const) {
    connect.mode = mode;
    connect.calls.length = 0;
    const r = await refreshAgentHandles(db, connect.callApp);
    assert.equal(r.status, "kept", mode);
    assert.deepEqual(Object.fromEntries(cachedAgentHandles(db)), before, `${mode}: never cleared on an error`);
    assert.equal(store.revision(db), rev, `${mode}: the revision stays`);
    if (mode === "endless") assert.equal(connect.calls.length, REFRESH_MAX_PAGES, "the paging guard stops");
  }
  assert.deepEqual((await refreshAgentHandles(db, async () => Promise.reject(new Error("boom")))) as unknown, { status: "kept", reason: "error" });
  // quiet: Connect back → normal again
  connect.mode = "ok";
  assert.equal((await refreshAgentHandles(db, connect.callApp)).status, "unchanged");
});

test("refresh: at most 16 handles per agent (the sorted first ones)", async () => {
  const db = seeded();
  const many = Array.from({ length: 20 }, (_, i) => ({ agent: AGENT_A.id, identity: `slack:U${String(19 - i).padStart(4, "0")}AB` }));
  await refreshAgentHandles(db, fakeConnect([many]).callApp);
  const list = cachedAgentHandles(db).get(AGENT_A.id) ?? [];
  assert.equal(list.length, 16);
  assert.deepEqual(list, [...list].sort());
  assert.equal(list[0], "slack:U0000AB");
});

test("timer: refreshes outside calls, first after a short delay, and stops on onStop", async () => {
  const db = seeded();
  const connect = fakeConnect([[{ agent: AGENT_A.id, identity: SLACK_A }]]);
  const stop = startAgentHandlesTimer(db, connect.callApp, log, 15, 5);
  await new Promise((r) => setTimeout(r, 60));
  stop();
  const n = connect.calls.length;
  assert.ok(n >= 2, `the timer ran (${n})`);
  assert.deepEqual([...new Set(connect.calls.map((c) => `${c.product}.${c.op}`))], ["connect.identities_list"], "reads only");
  assert.deepEqual(cachedAgentHandles(db).get(AGENT_A.id), [SLACK_A]);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(connect.calls.length, n, "stopped");
  // a Connect outage warns once per reason, not on every tick
  const warns: string[] = [];
  connect.mode = "down";
  const stop2 = startAgentHandlesTimer(db, connect.callApp, { warn: (m) => warns.push(m) }, 10, 1);
  await new Promise((r) => setTimeout(r, 60));
  stop2();
  assert.equal(warns.length, 1);
  assert.deepEqual(cachedAgentHandles(db).get(AGENT_A.id), [SLACK_A], "kept while down");
  // onStart wires it, onStop stops it (no Connect call before the first delay)
  const c3 = fakeConnect([]);
  await definition.onStart?.({ db, callApp: c3.callApp, log } as never);
  await definition.onStop?.({} as never);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c3.calls.length, 0);
});

// ── the feed (read side) ────────────────────────────────────────────────────────────────────────────────────────

test("feed: without accept the answer is byte-for-byte the old shape; with accept every agent carries handles", async () => {
  const db = seeded();
  const oldShape = JSON.stringify(await feedOp(db, {})); // before any handle exists
  await refreshAgentHandles(db, fakeConnect([[{ agent: AGENT_A.id, identity: SLACK_A }, { agent: AGENT_A.id, identity: BUZZ }]]).callApp);
  const plain = await feedOp(db, {});
  // the cache moved the revision only; everything else is the same bytes as before
  assert.equal(JSON.stringify({ ...plain, revision: 0 }), JSON.stringify({ ...JSON.parse(oldShape), revision: 0 }));
  assert.ok(!JSON.stringify(plain).includes(SLACK_A), "no agent handle without accept");
  assert.ok(plain.agents.every((a: object) => !("handles" in a)));
  for (const accept of [[], ["future_thing"], ["AGENT_HANDLES"]]) assert.equal(JSON.stringify(await feedOp(db, { accept })), JSON.stringify(plain), `accept ${JSON.stringify(accept)} = old shape`);
  assert.equal(checkFeed(plain).ok, true);
  assert.equal(validateAgainstSchema(manifestOutput(), plain as Json).ok, true);

  const rich = await feedOp(db, { accept: ["future_thing", "agent_handles"] });
  assert.equal(rich.revision, plain.revision);
  const a = rich.agents.find((x: { id: string }) => x.id === AGENT_A.id);
  const b = rich.agents.find((x: { id: string }) => x.id === AGENT_B.id);
  assert.deepEqual(a.handles, [BUZZ, SLACK_A]);
  assert.deepEqual(b.handles, [], "an agent with no identity: []");
  assert.ok(rich.agents.every((x: object) => Array.isArray((x as { handles?: unknown }).handles)));
  assert.deepEqual(checkFeed(rich, FEED_SCHEMA_AGENT_HANDLES).errors, []);
  assert.equal(validateAgainstSchema(manifestOutput(), rich as Json).ok, true, "the manifest output schema (checked by the SDK) accepts it");
  // stripping handles gives exactly the plain answer (nothing else changes with accept)
  assert.equal(JSON.stringify({ ...rich, agents: rich.agents.map(({ handles: _h, ...rest }: { handles: unknown }) => rest) }), JSON.stringify(plain));
  // fire on bad: the manifest output schema refuses a handle the feed must not carry
  const broken = structuredClone(rich);
  broken.agents[0].handles = ["email:a@example.com"];
  assert.equal(validateAgainstSchema(manifestOutput(), broken as Json).ok, false);
  // sinceRevision still answers unchanged with accept (handles never change without a revision move)
  assert.deepEqual(await feedOp(db, { accept: ["agent_handles"], sinceRevision: rich.revision }), { v: 1, revision: rich.revision, unchanged: true });
});

test("feed: a cache row the feed cannot carry is left out on read; a removed agent not on a team is not listed", async () => {
  const db = seeded();
  db.prepare("INSERT INTO fleet_agent_handles (agent_id, handle) VALUES (?, ?), (?, ?), (?, ?)").run(AGENT_A.id, SLACK_A, AGENT_A.id, "slack:lowercase", "agt_01J00000000000000000000ZZZ", SLACK_A2);
  const warns: string[] = [];
  const f = directoryFeed(db, { accept: ["agent_handles"] }, (m) => warns.push(m));
  assert.deepEqual(f.unchanged === false && f.agents.find((x) => x.id === AGENT_A.id)?.handles, [SLACK_A]);
  assert.ok(warns.some((w) => w.includes("an agent handle")));
  assert.ok(!JSON.stringify(f).includes(SLACK_A2), "a handle of an agent Governance does not list is not in the feed");
  assert.equal(checkFeed(f, FEED_SCHEMA_AGENT_HANDLES).ok, true);
});

test("C88: directory_feed and the fleet_facts hook never call Connect; no agent op carries an agent handle", async () => {
  const db = seeded();
  await refreshAgentHandles(db, fakeConnect([[{ agent: AGENT_A.id, identity: SLACK_A }]]).callApp);
  const watch = fakeConnect([[{ agent: AGENT_A.id, identity: SLACK_A2 }]]);
  await feedOp(db, { accept: ["agent_handles"] }, watch.callApp);
  await feedOp(db, {}, watch.callApp);
  await hooks.fleet_facts?.({ phase: "context", call: { caller: { type: "agent", id: AGENT_A.id } }, context: {} } as never, { db, callApp: watch.callApp, log } as never);
  assert.equal(watch.calls.length, 0, "a feed read or a hook is a local read only");
  const agent = { db, caller: { type: "agent", id: AGENT_A.id, name: "A", mode: "free" }, log, callApp: watch.callApp } as unknown as OpContext;
  type Run = { run(i: unknown, c: OpContext): Promise<unknown> };
  const ops = handlers as unknown as Record<string, Run>;
  const answers = [
    await ops.teams_list?.run({}, agent),
    await ops.team_get?.run({ team: "Support" }, agent),
    await ops.directory_get?.run({}, agent),
    await ops.resolve_sender?.run({ handle: SLACK_A }, agent),
  ];
  assert.ok(!JSON.stringify(answers).includes(SLACK_A), "the cached agent handle stays out of agent answers");
  assert.equal(watch.calls.length, 0);
  // fire on bad: an agent asking the feed with accept is still refused
  await assert.rejects(handlers.directory_feed.run({ accept: ["agent_handles"] } as never, agent) as Promise<unknown>, (e) => e instanceof TbError && e.code === "no_access");
});

test("migration 0005 applies on a 0.2.x database with data and keeps it", () => {
  const db = migratedDb(4);
  seedOldSchema(db);
  const rev = store.revision(db);
  const teams = db.prepare("SELECT count(*) AS n FROM fleet_teams").get()?.n;
  // apply 0005 like the SDK does
  const full = migratedDb();
  assert.ok(full.prepare("SELECT name FROM sqlite_master WHERE name = 'fleet_agent_handles'").get(), "the table exists after all migrations");
  for (const m of migrationFiles().slice(4, 7)) db.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
  assert.equal(store.revision(db), rev, "the migration does not move the revision");
  assert.equal(db.prepare("SELECT count(*) AS n FROM fleet_teams").get()?.n, teams);
  assert.equal(db.prepare("SELECT value FROM fleet_meta WHERE key = 'agent_handles_at'").get()?.value, 0);
  // fire on bad: the table refuses an empty handle
  assert.throws(() => db.prepare("INSERT INTO fleet_agent_handles (agent_id, handle) VALUES (?, '')").run(AGENT_A.id));
});
