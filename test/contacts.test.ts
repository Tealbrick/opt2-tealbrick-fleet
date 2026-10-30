// The Topology contacts layer (C373 WP-D, G-5): Connect's `contacts_list` read on demand by the person op `topology_get`.
// Quiet on good / fire on bad for every guard; C88: nothing reaches an agent op, a hook, the feed or storage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateAgainstSchema, validateCompanions } from "@opt2-tealbrick/manifest";
import { type Db, type Json, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { TopologyGetOutput } from "#kit";
import { handlers, manifest } from "../src/app.ts";
import { readContacts } from "../src/contacts.ts";
import { MAX_PAGES } from "../src/identities.ts";
import { outsideId, topologyGet } from "../src/topology.ts";
import { AGENT_A, AGENT_B, migratedDb, NOSTR } from "./helpers.ts";
import { seed } from "./seed.ts";

type Out = TopologyGetOutput;
const log = { debug() {}, info() {}, warn() {}, error() {} };
const OWNER = { type: "person", id: "per_01J0000000000000000000000P", name: "owner", mode: null };
const connect = JSON.parse(readFileSync(new URL("./contracts/connect.0.7.11.manifest.json", import.meta.url), "utf8")) as { operations: { id: string; audience: string; crud: string[]; output: Json }[] };
const contactsOut = connect.operations.find((o) => o.id === "contacts_list")?.output as Json;
const topoOp = manifest.operations.find((o) => o.id === "topology_get") as unknown as { output: Parameters<typeof validateAgainstSchema>[0] };
const validOut = (o: unknown) => validateAgainstSchema(topoOp.output, o as Json).ok;

type Row = { agent: string | null; channel: string; handle: string; account?: string; firstContactAt: number };
const SLACK_ANN = "slack:U012ABCDEF";
const ROWS: Row[] = [
  { agent: AGENT_A.id, channel: "slack", handle: SLACK_ANN, account: "Support bot", firstContactAt: Date.UTC(2026, 9, 2) },
  { agent: AGENT_A.id, channel: "buzz", handle: `buzz:${NOSTR.npub}`, firstContactAt: Date.UTC(2026, 9, 1) }, // Ann again, other channel
  { agent: AGENT_A.id, channel: "slack", handle: "slack:UOUTSIDER1", firstContactAt: Date.UTC(2026, 9, 3) }, // nobody in the directory
  { agent: AGENT_B.id, channel: "tool", handle: "someone@elsewhere.example", firstContactAt: Date.UTC(2026, 9, 4) },
  { agent: null, channel: "buzz", handle: "buzz:npub1workspacesender", firstContactAt: 1 }, // the workspace sender: not an agent's
];

/** A Connect that answers contacts_list in pages of `size`, validating its own answers against the Connect manifest schema. */
interface FakeConnect {
  calls: { product: string; op: string; input: Json }[];
  fail: TbError | null;
  held: boolean;
  bad: Json | null;
  callApp: OpContext["callApp"];
}
function fakeConnect(rows: Row[], size = 200): FakeConnect {
  const calls: { product: string; op: string; input: Json }[] = [];
  const s: FakeConnect = {
    calls,
    fail: null as TbError | null,
    held: false,
    bad: null as Json | null,
    callApp: (async (product: string, op: string, input: Json) => {
      calls.push({ product, op, input });
      if (s.fail) throw s.fail;
      if (s.held) return { status: "held", holdId: "h" };
      if (s.bad) return { status: "ok", output: s.bad };
      const at = typeof (input as { cursor?: string }).cursor === "string" ? Number((input as { cursor: string }).cursor) : 0;
      const out = { contacts: rows.slice(at, at + size), nextCursor: at + size < rows.length ? String(at + size) : null };
      assert.equal(validateAgainstSchema(contactsOut as never, out as Json).ok, true, "the fake answers in Connect's own shape");
      return { status: "ok", output: out };
    }) as OpContext["callApp"],
  };
  return s;
}
function fixed() {
  const db = migratedDb();
  const s = seed(db);
  return { db, ...s };
}
const ctxOf = (db: Db, callApp?: OpContext["callApp"], caller: object = OWNER) => ({ db, caller, log, callApp }) as unknown as OpContext;
const topo = (input: object, c: OpContext) => handlers.topology_get.run(input as never, c) as Promise<Out>;

// ── the companion ────────────────────────────────────────────────────────────────────────────────────────────────

test("M-CP-2: the companion needs Connect 0.7.14 (tb.access/1 on top of contacts_list, identities_list); a Connect without one of them fails the check, so G5 stays the rule", () => {
  // access_list and access_revoke as Connect 0.7.14-dev.1 declares them: the fixture manifest here is older
  const access = [
    { id: "access_list", audience: "agent", crud: ["read"] },
    { id: "access_revoke", audience: "agent", crud: ["update"] },
  ];
  const target = (ops: string[], extra = access) => [{ id: "connect", operations: [...connect.operations.filter((o) => ops.includes(o.id)).map((o) => ({ id: o.id, audience: o.audience, crud: o.crud })), ...extra] }];
  const ok = validateCompanions(manifest as never, target(["identities_list", "contacts_list"]) as never);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const old = validateCompanions(manifest as never, target(["identities_list"]) as never);
  assert.equal(old.ok, false, "an older Connect without contacts_list is refused by the check");
  assert.equal(validateCompanions(manifest as never, target(["identities_list", "contacts_list"], []) as never).ok, false, "Connect 0.7.13 has no tb.access/1: an update to this version is refused there");
  assert.equal(validateCompanions(manifest as never, []).ok, true, "no Connect deployed: nothing to check");
  const c = manifest.companions?.find((x) => x.product === "connect");
  assert.deepEqual([c?.operations, c?.crud], [["identities_list", "contacts_list", "access_list", "access_revoke"], ["read", "update"]]);
});

test("the contacts_list guard is Connect's: the op is for Governance only, and Governance reads it only from topology_get", () => {
  const readers = Object.entries(handlers)
    .filter(([, h]) => String((h as { run: unknown }).run).includes("contacts"))
    .map(([id]: [string, unknown]) => id);
  assert.deepEqual(readers, ["topology_get"]);
});

// ── reading Connect ──────────────────────────────────────────────────────────────────────────────────────────────

test("readContacts: pages through nextCursor, keeps agent rows only, canonical handles, no control characters", async () => {
  const c = fakeConnect(ROWS, 2);
  const r = await readContacts(c.callApp);
  assert.equal(r.status, "available");
  if (r.status !== "available") return;
  assert.deepEqual(c.calls.map((x) => [x.product, x.op, x.input]), [
    ["connect", "contacts_list", {}],
    ["connect", "contacts_list", { cursor: "2" }],
    ["connect", "contacts_list", { cursor: "4" }],
  ]);
  assert.equal(r.rows.length, 4, "the workspace sender (agent null) is not an agent's contact");
  assert.equal(r.note, "");
  const dirty = await readContacts(fakeConnect([{ agent: AGENT_A.id, channel: "sl\u0000ack", handle: "  slack:u012abcdef‮ ", firstContactAt: 5 }]).callApp);
  assert.deepEqual(dirty.status === "available" ? dirty.rows[0] : null, { agent: AGENT_A.id, channel: "slack", handle: "slack:U012ABCDEF", firstContactAt: 5 });
  // fire on bad: rows with an agent that is no agt_ id, or with no handle, are left out
  const rawJunk = fakeConnect([]);
  rawJunk.bad = { contacts: [{ agent: "psn_x", channel: "slack", handle: "slack:U1" }, { agent: AGENT_A.id, channel: "slack", handle: "" }, "x", null], nextCursor: null } as Json;
  const junk = await readContacts(rawJunk.callApp);
  assert.deepEqual(junk.status === "available" ? junk.rows : "unavailable", []);
});

test("readContacts: every failure is `unavailable` with a plain sentence, never a throw, never upstream text", async () => {
  const cases: [string, (c: FakeConnect) => void, RegExp][] = [
    ["unknown_op", (c) => (c.fail = new TbError("unknown_op", "RAW upstream text", 404)), /^Connect does not offer contacts yet; update Connect\.$/],
    ["no_grant", (c) => (c.fail = new TbError("no_grant", "RAW", 403)), /^Connect does not offer contacts yet; update Connect\.$/],
    ["no_access", (c) => (c.fail = new TbError("no_access", "RAW", 403)), /^Connect does not offer contacts yet/],
    ["paused", (c) => (c.fail = new TbError("paused", "RAW", 409)), /^This app is paused/],
    ["other", (c) => (c.fail = new TbError("boom", "RAW SECRET", 500)), /^Connect did not answer \(boom\)\. Try again later\.$/],
    ["held", (c) => (c.held = true), /^Connect held the request/],
    ["malformed", (c) => (c.bad = { nope: 1 } as Json), /^Connect answered something unexpected; update Connect\.$/],
  ];
  for (const [name, arrange, note] of cases) {
    const c = fakeConnect(ROWS);
    arrange(c);
    const r = await readContacts(c.callApp);
    assert.equal(r.status, "unavailable", name);
    assert.match(r.note, note, name);
    assert.doesNotMatch(r.note, /RAW|SECRET/, name);
  }
  assert.equal((await readContacts(undefined)).status, "unavailable");
});

test("paging guard: a Connect that never ends is cut at MAX_PAGES pages and says so", async () => {
  const c: { n: number; callApp: OpContext["callApp"] } = {
    n: 0,
    callApp: (async () => ({ status: "ok", output: { contacts: [{ agent: AGENT_A.id, channel: "slack", handle: `slack:U${++c.n}AAAAA`, firstContactAt: 1 }], nextCursor: "again" } })) as OpContext["callApp"],
  };
  const r = await readContacts(c.callApp);
  assert.equal(r.status, "available");
  assert.equal(c.n, MAX_PAGES);
  assert.equal(r.note, `Showing the first ${MAX_PAGES} contacts.`);
});

// ── the layer ────────────────────────────────────────────────────────────────────────────────────────────────────

test("contact edges: agent → the directory entry that owns the handle, or an outside node named by the handle; one edge per pair", async () => {
  const { db, ann } = fixed();
  const c = fakeConnect(ROWS);
  const out = await topo({ layers: ["org", "contacts"] }, ctxOf(db, c.callApp));
  assert.equal(out.sources.contacts, "available");
  assert.equal(validOut(out), true);
  const contact = out.edges.filter((e) => e.kind === "contact");
  assert.deepEqual(contact.map((e) => [e.from, e.to, e.label, e.state, e.since]).sort(), [
    [AGENT_A.id, ann.id, "buzz, slack", "live", "2026-10-01T00:00:00.000Z"],
    [AGENT_A.id, outsideId("slack:UOUTSIDER1"), "slack", "live", "2026-10-03T00:00:00.000Z"],
    [AGENT_B.id, outsideId("someone@elsewhere.example"), "tool", "off", "2026-10-04T00:00:00.000Z"],
  ].sort());
  const ext = out.nodes.filter((n) => n.id.startsWith("ext_"));
  assert.deepEqual(ext.map((n) => [n.kind, n.name, n.trust]).sort(), [["outside_agent", "slack:UOUTSIDER1", null], ["outside_agent", "someone@elsewhere.example", null]].sort());
  assert.ok(ext.every((n) => n.id.length === 28 && n.reviewDueAt === null && n.changedSinceReview === false));
  // B is paused in the seed: its contact wire is off. Ann is trusted and active: live.
  assert.equal(out.sources.note, "Channel contacts are shown.", "nothing is left out, nothing is cut");
  assert.equal(c.calls.length, 1);
});

test("a blocked end makes the contact wire blocked; a contact of an agent that is not in the directory is left out and counted", async () => {
  const { db, ann } = fixed();
  db.prepare("UPDATE fleet_people SET trust = 'blocked' WHERE id = ?").run(ann.id);
  const c = fakeConnect([...ROWS, { agent: "agt_01J0000000000000000000000G", channel: "slack", handle: "slack:UGONE0001", firstContactAt: 1 }]);
  const out = await topo({ layers: ["org", "contacts"] }, ctxOf(db, c.callApp));
  assert.equal(out.edges.find((e) => e.kind === "contact" && e.to === ann.id)?.state, "blocked");
  assert.equal(out.edges.filter((e) => e.kind === "contact").length, 3);
  assert.equal(out.sources.note, "Channel contacts are shown. 1 contact left out: not a workspace agent.");
  assert.ok(!out.nodes.some((n) => n.name === "slack:UGONE0001"));
  assert.equal(validOut(out), true);
});

test("contacts alone: only the agents and the entries the contacts name, and the contact edges", async () => {
  const { db, ann } = fixed();
  const out = await topo({ layers: ["contacts"] }, ctxOf(db, fakeConnect(ROWS).callApp));
  assert.deepEqual([out.sources.contacts, out.sources.access], ["available", "not_requested"]);
  assert.ok(out.edges.every((e) => e.kind === "contact"));
  assert.deepEqual(out.nodes.map((n) => n.kind).sort(), ["agent", "agent", "outside_agent", "outside_agent", "person"]);
  assert.ok(out.nodes.some((n) => n.id === ann.id));
  assert.equal(validOut(out), true);
});

test("unavailable: the layer has no edges, the org layer still answers, and the note says why in plain words", async () => {
  const { db } = fixed();
  const c = fakeConnect(ROWS);
  c.fail = new TbError("unknown_op", "x", 404);
  const out = await topo({ layers: ["org", "contacts"] }, ctxOf(db, c.callApp));
  assert.equal(out.sources.contacts, "unavailable");
  assert.equal(out.edges.filter((e) => e.kind === "contact").length, 0);
  assert.ok(out.nodes.length > 0 && out.edges.some((e) => e.kind === "owner"));
  assert.match(out.sources.note, /^Channel contacts are not shown\. Connect does not offer contacts yet; update Connect\./);
  assert.ok(out.sources.note.length <= 280);
  assert.equal(validOut(out), true);
});

test("quiet on good: a topology asked without the contacts layer never calls Connect; nothing is cached between calls", async () => {
  const { db } = fixed();
  const c = fakeConnect(ROWS);
  await topo({ layers: ["org"] }, ctxOf(db, c.callApp));
  assert.equal(c.calls.length, 0);
  await topo({ layers: ["org", "contacts"] }, ctxOf(db, c.callApp));
  await topo({ layers: ["org", "contacts"] }, ctxOf(db, c.callApp));
  assert.equal(c.calls.length, 2, "every call reads Connect again");
  // nothing is stored: no table holds a contact
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name));
  assert.ok(!tables.some((t) => /contact/i.test(t)), tables.join(","));
});

test("C88: agents and apps are refused before Connect is asked; no agent op, hook or feed answer carries a contact handle", async () => {
  const { db } = fixed();
  for (const caller of [{ type: "agent", id: AGENT_A.id, name: "A", mode: "free" }, { type: "app", id: "ins_rules", product: "rules", listed: true }]) {
    const c = fakeConnect(ROWS);
    await assert.rejects(topo({}, ctxOf(db, c.callApp, caller)), (e: TbError) => e.code === "no_access" && e.httpStatus === 403);
    assert.equal(c.calls.length, 0, "Connect was not asked");
  }
  // the org-only answer and the agent-facing answers carry no outside handle
  const orgOnly = JSON.stringify(topologyGet(db, { layers: ["org"] }));
  assert.doesNotMatch(orgOnly, /UOUTSIDER1|elsewhere\.example/);
  for (const id of ["teams_list", "directory_get", "resolve_sender"]) {
    const o = manifest.operations.find((x) => x.id === id) as unknown as { audience: string };
    assert.equal(o.audience, "agent");
  }
});
