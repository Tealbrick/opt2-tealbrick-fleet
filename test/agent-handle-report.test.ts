// Governance 0.4.2: Workspace (product `kanban`) reads the directory feed and reports the chat handles it creates for agents
// (`agent_handle_report`). Governance decides which agents exist; Workspace executes and tells Governance. Real SQLite and the real
// handlers; Connect is a fake. Each test has a quiet-on-good case and a fire-on-bad case.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type Db, type Json, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { refreshAgentHandles, reportAgentHandles } from "../src/agent-handles.ts";
import { handlers, manifest } from "../src/app.ts";
import { assertFeedCaller, assertHandleReporter, FEED_CAPS, FEED_READERS, HANDLE_PATTERN, HANDLE_REPORTERS } from "../src/feed.ts";
import { loadColleagues } from "../src/lifecycle/view.ts";
import * as store from "../src/store.ts";
import { checkFeed, FEED_SCHEMA_AGENT_HANDLES } from "./feed-contract.ts";
import { AGENT_A, AGENT_B, migratedDb, migrationFiles, NOSTR } from "./helpers.ts";
import { seed } from "./seed.ts";

const KANBAN = { type: "app", id: "ins_01J0000000000000000000000K", name: "Workspace", mode: null, product: "kanban", listed: true };
const RULES = { type: "app", id: "ins_01J0000000000000000000000R", name: "Rules & Approvals", mode: null, product: "rules", listed: true };
const AGENT = { type: "agent", id: AGENT_A.id, name: AGENT_A.name, mode: "free" };
const PERSON = { type: "person", id: "per_01J0000000000000000000000P", name: "owner", mode: null };
const log = { debug() {}, info() {}, warn() {}, error() {} };
const ctxOf = (db: Db, caller: object) => ({ db, caller, log }) as unknown as OpContext;
type Run = { run(i: unknown, c: OpContext): Promise<any> };
const ops = handlers as unknown as Record<string, Run>;
const feedOp = (db: Db, caller: object, input: object = {}) => ops.directory_feed?.run(input, ctxOf(db, caller)) as Promise<any>;
const report = (db: Db, caller: object, input: object) => ops.agent_handle_report?.run(input, ctxOf(db, caller)) as Promise<{ ok: true; revision: number }>;
const spec = (id: string) => manifest.operations.find((o) => o.id === id) as unknown as { input: Parameters<typeof validateAgainstSchema>[0]; output: Parameters<typeof validateAgainstSchema>[0]; audience: string };
const refusal = async (fn: () => unknown): Promise<{ code: string; status: number } | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof TbError) return { code: e.code, status: e.httpStatus };
    throw e;
  }
};

// not Ann's key from the seed: a person's handle stays the person's
const BUZZ = "buzz:npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";
const BUZZ2 = "buzz:npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m";
const SLACK_A = "slack:UAGENTA01";
const SLACK_A2 = "slack:WAGENTA02";
const feedAgent = async (db: Db, id: string, caller: object = KANBAN) => ((await feedOp(db, caller, { accept: ["agent_handles"] })).agents as { id: string; handles?: string[] }[]).find((a) => a.id === id);
const appRows = (db: Db, agent: string) => db.prepare("SELECT handle, source_product FROM fleet_agent_handles_app WHERE agent_id = ? ORDER BY source_product, handle").all(agent).map((r) => `${r.source_product}:${r.handle}`);

function seeded() {
  const db = migratedDb();
  seed(db);
  return db;
}

// ── who may read the feed and who may report ────────────────────────────────────────────────────────────────────

test("the feed: a listed kanban caller gets the same feed as Rules; an unlisted or unverified one is refused", async () => {
  const db = seeded();
  assert.deepEqual([...FEED_READERS], ["rules", "knowledge", "kanban"]);
  const rules = await feedOp(db, RULES, { accept: ["agent_handles", "lifecycle"] });
  const kanban = await feedOp(db, KANBAN, { accept: ["agent_handles", "lifecycle"] });
  assert.deepEqual(kanban, rules);
  assert.ok(kanban.agents.length > 0);
  assert.doesNotThrow(() => assertFeedCaller({ type: "app", product: "kanban", listed: true }));
  const { product: _p, ...bare } = KANBAN;
  assert.deepEqual(await refusal(() => feedOp(db, { ...KANBAN, listed: false })), { code: "caller_unverified", status: 403 });
  assert.deepEqual(await refusal(() => feedOp(db, { ...KANBAN, listed: "true" })), { code: "caller_unverified", status: 403 });
  assert.deepEqual(await refusal(() => feedOp(db, bare)), { code: "caller_unverified", status: 403 });
  assert.deepEqual(await refusal(() => feedOp(db, { ...KANBAN, product: "Kanban" })), { code: "no_access", status: 403 });
  assert.deepEqual(await refusal(() => feedOp(db, { ...KANBAN, product: "kanban2" })), { code: "no_access", status: 403 });
  assert.deepEqual(await refusal(() => feedOp(db, { ...bare, name: "kanban" })), { code: "caller_unverified", status: 403 });
  assert.deepEqual(await refusal(() => feedOp(db, { ...AGENT, product: "kanban", listed: true })), { code: "no_access", status: 403 });
  assert.deepEqual(await refusal(() => feedOp(db, { ...PERSON, product: "kanban", listed: true })), { code: "no_access", status: 403 });
});

test("the feed: nothing else changes for the other readers (no accept: the old shape; unknown accept ignored)", async () => {
  const db = seeded();
  const plain = await feedOp(db, RULES);
  assert.ok(plain.agents.every((a: object) => !("handles" in a)));
  assert.deepEqual(await feedOp(db, RULES, { accept: ["future"] }), plain);
  assert.deepEqual(await feedOp(db, KANBAN), plain);
  assert.deepEqual(await refusal(() => feedOp(db, { ...RULES, product: "inbox" })), { code: "no_access", status: 403 });
});

test("agent_handle_report: only a listed kanban app; Rules, Knowledge, agents and people are refused and nothing is written", async () => {
  const db = seeded();
  const input = { v: 1, agent: AGENT_A.id, handles: [SLACK_A] };
  const rev = store.revision(db);
  assert.deepEqual([...HANDLE_REPORTERS], ["kanban"]);
  assert.equal(spec("agent_handle_report").audience, "agent", "the companion rule: an op another app calls is declared with audience agent");
  assert.deepEqual(await refusal(() => report(db, RULES, input)), { code: "no_access", status: 403 });
  assert.deepEqual(await refusal(() => report(db, { ...RULES, product: "knowledge" }, input)), { code: "no_access", status: 403 });
  assert.deepEqual(await refusal(() => report(db, AGENT, input)), { code: "no_access", status: 403 });
  assert.deepEqual(await refusal(() => report(db, { ...AGENT, product: "kanban", listed: true }, input)), { code: "no_access", status: 403 });
  assert.deepEqual(await refusal(() => report(db, PERSON, input)), { code: "no_access", status: 403 });
  assert.deepEqual(await refusal(() => report(db, { ...KANBAN, listed: false }, input)), { code: "caller_unverified", status: 403 });
  const { product: _p, ...bare } = KANBAN;
  assert.deepEqual(await refusal(() => report(db, bare, input)), { code: "caller_unverified", status: 403 });
  assert.deepEqual(await refusal(() => report(db, { ...KANBAN, name: "rules", product: "observer" }, input)), { code: "no_access", status: 403 });
  assert.equal(appRows(db, AGENT_A.id).length, 0);
  assert.equal(store.revision(db), rev);
  assert.doesNotThrow(() => assertHandleReporter({ type: "app", product: "kanban", listed: true }));
  assert.throws(() => assertHandleReporter({ type: "app", product: "rules", listed: true }), (e) => e instanceof TbError && e.code === "no_access");
  // quiet on good
  assert.deepEqual(await report(db, KANBAN, input), { ok: true, revision: rev + 1 });
});

// ── the manifest schemas ────────────────────────────────────────────────────────────────────────────────────────

test("manifest: the input schema takes the contract shape and refuses the rest; its handle pattern is the feed's", () => {
  const input = spec("agent_handle_report").input as unknown as { properties: { handles: { items: { pattern: string } }; agent: { pattern: string } } };
  assert.equal(input.properties.handles.items.pattern, HANDLE_PATTERN.source, "one pattern, like the feed");
  const ok = (doc: object) => validateAgainstSchema(spec("agent_handle_report").input, doc as Json).ok;
  assert.equal(ok({ v: 1, agent: AGENT_A.id, handles: [] }), true);
  assert.equal(ok({ v: 1, agent: AGENT_A.id, handles: [BUZZ, SLACK_A, "telegram:7000000001"] }), true);
  for (const bad of [
    { agent: AGENT_A.id, handles: [] },
    { v: 2, agent: AGENT_A.id, handles: [] },
    { v: 1, agent: "agt_short", handles: [] },
    { v: 1, agent: AGENT_A.id },
    { v: 1, agent: AGENT_A.id, handles: "slack:UAGENTA01" },
    { v: 1, agent: AGENT_A.id, handles: ["slack:lowercase"] },
    { v: 1, agent: AGENT_A.id, handles: ["email:a@example.com"] },
    { v: 1, agent: AGENT_A.id, handles: Array.from({ length: 17 }, (_, i) => `telegram:${7000000000 + i}`) },
    { v: 1, agent: AGENT_A.id, handles: [], extra: 1 },
  ])
    assert.equal(ok(bad), false, JSON.stringify(bad));
  assert.equal(validateAgainstSchema(spec("agent_handle_report").output, { ok: true, revision: 3 }).ok, true);
  assert.equal(validateAgainstSchema(spec("agent_handle_report").output, { ok: false, revision: 3 }).ok, false);
  assert.equal(validateAgainstSchema(spec("agent_handle_report").output, { ok: true }).ok, false);
});

// ── replace, idempotent, revision ───────────────────────────────────────────────────────────────────────────────

test("the full list replaces this app's rows for the agent; an empty list removes them; other agents and other apps stay", async () => {
  const db = seeded();
  await report(db, KANBAN, { v: 1, agent: AGENT_B.id, handles: [SLACK_A2] });
  await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [SLACK_A, BUZZ] });
  assert.deepEqual(appRows(db, AGENT_A.id), [`kanban:${BUZZ}`, `kanban:${SLACK_A}`].sort());
  // a row of another reporting app (a later version may allow one) is not touched by a kanban report
  db.prepare("INSERT INTO fleet_agent_handles_app (agent_id, handle, source_product, updated_at) VALUES (?, ?, 'other', 1)").run(AGENT_A.id, BUZZ2);
  await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [SLACK_A] });
  assert.deepEqual(appRows(db, AGENT_A.id), [`kanban:${SLACK_A}`, `other:${BUZZ2}`]);
  assert.deepEqual(appRows(db, AGENT_B.id), [`kanban:${SLACK_A2}`], "another agent is untouched");
  await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [] });
  assert.deepEqual(appRows(db, AGENT_A.id), [`other:${BUZZ2}`], "empty removes only kanban's rows");
  assert.deepEqual(await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [] }), { ok: true, revision: store.revision(db) }, "removing nothing is fine");
});

test("idempotent: the same list again, in any order or with a duplicate, changes nothing and keeps the revision; a change moves it", async () => {
  const db = seeded();
  const r0 = store.revision(db);
  assert.deepEqual(await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [SLACK_A, BUZZ] }), { ok: true, revision: r0 + 1 });
  const stamp = db.prepare("SELECT updated_at FROM fleet_agent_handles_app WHERE agent_id = ? LIMIT 1").get(AGENT_A.id)?.updated_at;
  assert.deepEqual(await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [SLACK_A, BUZZ] }), { ok: true, revision: r0 + 1 });
  assert.deepEqual(await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [BUZZ, SLACK_A, BUZZ] }), { ok: true, revision: r0 + 1 });
  assert.equal(store.revision(db), r0 + 1);
  assert.equal(db.prepare("SELECT updated_at FROM fleet_agent_handles_app WHERE agent_id = ? LIMIT 1").get(AGENT_A.id)?.updated_at, stamp, "rows are not rewritten");
  assert.deepEqual(await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [SLACK_A] }), { ok: true, revision: r0 + 2 });
  assert.deepEqual(await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [] }), { ok: true, revision: r0 + 3 });
  assert.equal(validateAgainstSchema(spec("agent_handle_report").output, (await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [] })) as unknown as Json).ok, true);
});

test("refusals: an unknown agent is 404, a handle off the contract is 400, too many is 400; each leaves the stored list as it was", async () => {
  const db = seeded();
  await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [SLACK_A] });
  const rev = store.revision(db);
  const unknown = "agt_01J00000000000000000000ZZZ";
  assert.deepEqual(await refusal(() => report(db, KANBAN, { v: 1, agent: "agt_01J0000000000000000000009Z", handles: [] })), { code: "agent_not_found", status: 404 });
  assert.deepEqual(await refusal(() => report(db, KANBAN, { v: 1, agent: unknown, handles: [SLACK_A] })), { code: "agent_not_found", status: 404 });
  assert.deepEqual(await refusal(() => report(db, KANBAN, { v: 1, agent: "not-an-id", handles: [] })), { code: "agent_not_found", status: 404 });
  for (const bad of ["slack:lowercase", "email:a@example.com", `buzz:${NOSTR.hex}`, "telegram:0", ""])
    assert.deepEqual(await refusal(() => report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [SLACK_A2, bad] })), { code: "invalid_handle", status: 400 }, bad);
  const many = Array.from({ length: FEED_CAPS.handlesPerContact + 1 }, (_, i) => `telegram:${7000000000 + i}`);
  assert.deepEqual(await refusal(() => report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: many })), { code: "too_many_handles", status: 400 });
  assert.deepEqual(appRows(db, AGENT_A.id), [`kanban:${SLACK_A}`]);
  assert.equal(store.revision(db), rev);
  assert.equal(db.prepare("SELECT count(*) AS n FROM fleet_agent_handles_app").get()?.n, 1);
  // quiet on good: exactly the cap passes
  assert.deepEqual((await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: many.slice(0, FEED_CAPS.handlesPerContact) })).ok, true);
  // a failed write inside the transaction rolls back (the delete is undone)
  assert.throws(() => reportAgentHandles(db, "kanban", { agent: "agt_01J00000000000000000000ZZZ", handles: [] }), (e) => e instanceof TbError && e.code === "agent_not_found");
});

// ── the feed carries the reported handles; the Connect timer never wipes them ────────────────────────────────────

test("the feed merges Connect handles and reported handles (once each, sorted, valid against the contract) only with accept: agent_handles", async () => {
  const db = seeded();
  const connect = async (...rows: [string, string][]) =>
    refreshAgentHandles(db, (async () => ({ status: "ok", output: { identities: rows.map(([agent, identity]) => ({ agent, channel: "x", identity })), nextCursor: null } })) as unknown as OpContext["callApp"]);
  await connect([AGENT_A.id, SLACK_A]);
  await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [BUZZ, SLACK_A] }); // SLACK_A is also Connect's
  await report(db, KANBAN, { v: 1, agent: AGENT_B.id, handles: [SLACK_A2] });
  assert.deepEqual((await feedAgent(db, AGENT_A.id))?.handles, [BUZZ, SLACK_A].sort());
  assert.deepEqual((await feedAgent(db, AGENT_B.id))?.handles, [SLACK_A2]);
  assert.deepEqual((await feedAgent(db, AGENT_A.id, RULES))?.handles, [BUZZ, SLACK_A].sort(), "every reader gets the same list");
  const full = await feedOp(db, KANBAN, { accept: ["agent_handles"] });
  assert.equal(checkFeed(full, FEED_SCHEMA_AGENT_HANDLES).ok, true);
  const plain = await feedOp(db, KANBAN, {});
  assert.ok(plain.agents.every((a: object) => !("handles" in a)), "without accept the old shape: no handles");
  assert.ok(!JSON.stringify(plain).includes(SLACK_A2));
  // the revision moved with the report, so a reader that holds the old one reads again; the same revision is unchanged
  assert.deepEqual(await feedOp(db, KANBAN, { sinceRevision: full.revision, accept: ["agent_handles"] }), { v: 1, revision: full.revision, unchanged: true });
  await report(db, KANBAN, { v: 1, agent: AGENT_B.id, handles: [] });
  const after = await feedOp(db, KANBAN, { sinceRevision: full.revision, accept: ["agent_handles"] });
  assert.equal(after.unchanged, false);
  assert.deepEqual((await feedAgent(db, AGENT_B.id))?.handles, []);
});

test("the cap: Connect's handles come first, the feed carries at most 16 for one agent, sorted", async () => {
  const db = seeded();
  const connectHandles = Array.from({ length: 10 }, (_, i) => `telegram:${7100000000 + i}`);
  const reported = Array.from({ length: 10 }, (_, i) => `telegram:${7000000000 + i}`); // sort before Connect's
  await refreshAgentHandles(db, (async () => ({ status: "ok", output: { identities: connectHandles.map((identity) => ({ agent: AGENT_A.id, channel: "x", identity })), nextCursor: null } })) as unknown as OpContext["callApp"]);
  await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: reported });
  const list = (await feedAgent(db, AGENT_A.id))?.handles ?? [];
  assert.equal(list.length, 16);
  assert.deepEqual(list, [...list].sort());
  for (const h of connectHandles) assert.ok(list.includes(h), `Connect's ${h} is kept`);
  assert.equal(list.filter((h) => reported.includes(h)).length, 6);
});

test("a person's handle stays the person's: the feed leaves a reported handle out of the agent when a person holds it", async () => {
  const db = seeded();
  await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: ["slack:UCY00001", SLACK_A] }); // Cy's handle in the seed
  assert.deepEqual((await feedAgent(db, AGENT_A.id))?.handles, [SLACK_A]);
});

test("the Connect timer never wipes reported handles: a changed answer, an empty complete answer and an error all leave them", async () => {
  const db = seeded();
  const answer = (rows: { agent: string; identity: string }[]) => (async () => ({ status: "ok", output: { identities: rows.map((r) => ({ channel: "x", ...r })), nextCursor: null } })) as unknown as OpContext["callApp"];
  await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [BUZZ] });
  assert.equal((await refreshAgentHandles(db, answer([{ agent: AGENT_A.id, identity: SLACK_A }]))).status, "updated");
  assert.deepEqual((await feedAgent(db, AGENT_A.id))?.handles, [BUZZ, SLACK_A].sort());
  assert.equal((await refreshAgentHandles(db, answer([{ agent: AGENT_B.id, identity: SLACK_A2 }]))).status, "updated"); // Connect replaced its own rows
  assert.deepEqual((await feedAgent(db, AGENT_A.id))?.handles, [BUZZ], "Connect's handle of A is gone, the reported one stays");
  assert.equal((await refreshAgentHandles(db, answer([]))).status, "updated"); // a real "no identities" clears the Connect cache
  assert.equal(db.prepare("SELECT count(*) AS n FROM fleet_agent_handles").get()?.n, 0);
  assert.deepEqual(appRows(db, AGENT_A.id), [`kanban:${BUZZ}`]);
  assert.deepEqual((await feedAgent(db, AGENT_A.id))?.handles, [BUZZ]);
  const down = (async () => {
    throw new TbError("network_error", "x", 503);
  }) as unknown as OpContext["callApp"];
  assert.equal((await refreshAgentHandles(db, down)).status, "kept");
  assert.deepEqual(appRows(db, AGENT_A.id), [`kanban:${BUZZ}`]);
  // and the other way round: a report does not touch the Connect cache
  await refreshAgentHandles(db, answer([{ agent: AGENT_A.id, identity: SLACK_A }]));
  await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: [] });
  assert.deepEqual(db.prepare("SELECT handle FROM fleet_agent_handles WHERE agent_id = ?").all(AGENT_A.id).map((r) => String(r.handle)), [SLACK_A]);
});

test("a reported handle counts like a Connect handle in Governance's own checks (the view fleet_agent_handles_all)", async () => {
  const db = seeded();
  const ann = db.prepare("SELECT id FROM fleet_people WHERE name = 'Ann Example'").get()?.id as string;
  store.setPerson(db, { id: ann, name: "Ann Example", handles: ["slack:UANN00001"] });
  assert.equal(loadColleagues(db, Date.now()).byId.get(`agent:${AGENT_A.id}`)?.findings.some((f) => f.code === "agent_handle_conflict"), false);
  await report(db, KANBAN, { v: 1, agent: AGENT_A.id, handles: ["slack:UANN00001"] });
  assert.equal(loadColleagues(db, Date.now()).byId.get(`agent:${AGENT_A.id}`)?.findings.some((f) => f.code === "agent_handle_conflict"), true);
  assert.deepEqual(db.prepare("SELECT agent_id, handle FROM fleet_agent_handles_all").all().map((r) => `${r.agent_id}:${r.handle}`), [`${AGENT_A.id}:slack:UANN00001`]);
});

test("migration 0015 adds the table and the view, changes no row and does not move the revision", () => {
  const db = migratedDb(14);
  const rev = store.revision(db);
  const meta = JSON.stringify(db.prepare("SELECT key, value FROM fleet_meta ORDER BY key").all());
  const full = migratedDb();
  for (const name of ["fleet_agent_handles_app", "fleet_agent_handles_all"]) assert.ok(full.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name), name);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'fleet_agent_handles_app'").get(), undefined);
  const m = migrationFiles()[14];
  assert.equal(m?.name, "0015_agent_handles_app.sql");
  db.exec(`BEGIN;\n${m?.sql}\nCOMMIT;`);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'fleet_agent_handles_app'").get());
  assert.equal(store.revision(db), rev);
  assert.equal(JSON.stringify(db.prepare("SELECT key, value FROM fleet_meta ORDER BY key").all()), meta);
  assert.throws(() => full.prepare("INSERT INTO fleet_agent_handles_app (agent_id, handle, source_product, updated_at) VALUES (?, '', 'kanban', 1)").run(AGENT_A.id));
  assert.throws(() => full.prepare("INSERT INTO fleet_agent_handles_app (agent_id, handle, source_product, updated_at) VALUES (?, 'slack:UAGENTA01', '', 1)").run(AGENT_A.id));
});
