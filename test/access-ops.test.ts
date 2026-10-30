// C380 B9b: plan_preview, findings_list, exception_set, the Summary's stores. Shapes from B10's pages, checked against the manifest.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema, validateCompanions } from "@opt2-tealbrick/manifest";
import { type Db, type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { noteRead, noteStop } from "../src/access/client.ts";
import { findingsList, openDifferences, setException, type unreadOf } from "../src/access/differences.ts";
import { type AccessItem, itemDigest, storeItems } from "../src/access/items.ts";
import { planPreview } from "../src/access/preview.ts";
import { handlers, manifest } from "../src/app.ts";
import { type TransitionInput, transition } from "../src/lifecycle/transitions.ts";
import { loadColleagues, portalReadState } from "../src/lifecycle/view.ts";
import { revision } from "../src/meta.ts";
import * as store from "../src/store.ts";
import type { DecodedTopology } from "../src/topology-slice.ts";
import { accessEnv, answer, fakeStores, wire } from "./access-helpers.ts";
import { AGENT_A, AGENT_B, migratedDb } from "./helpers.ts";
import { OWNER, refused, T0, world } from "./lifecycle-helpers.ts";

type OpSpec = { id: string; output: Parameters<typeof validateAgainstSchema>[0] };
const outputOf = (id: string) => (manifest.operations as unknown as OpSpec[]).find((o) => o.id === id)?.output as OpSpec["output"];
const validOut = (id: string, doc: unknown) => {
  const r = validateAgainstSchema(outputOf(id), doc as Json);
  assert.equal(r.ok, true, JSON.stringify(r));
};
const NONE = () => answer([]);
const quiet = { connect: NONE, knowledge: NONE, kanban: NONE, evolution: NONE };
const held = (over: Partial<AccessItem> & Pick<AccessItem, "id" | "kind">, target = "evolution"): AccessItem => {
  const base = { subject: { kind: "agent", id: AGENT_A.id }, resource: over.id, direction: "held_by", level: "use", label: "A thing", state: "active", revocable: true, since: null, ...over } as Omit<AccessItem, "digest">;
  return { ...base, digest: itemDigest(target, base) };
};
const leave = (db: Db, kind: "person" | "agent", id: string, to: TransitionInput["to"] = "leaving") => transition(db, { kind, id, to, reason: "left", actor: OWNER }, T0);
const NOW = T0 + 1000;
const PICTURE = (over: Partial<DecodedTopology> = {}): DecodedTopology => ({ instances: [], edges: [{ agent: AGENT_A.id, ins: "ins_1", product: "knowledge", crud: ["read"], mode: "free", held: [] }], companions: [], connections: [{ con: "con_1", agt: AGENT_A.id, method: "k", status: "active" }], truncated: false, ...over }) as unknown as DecodedTopology;
const storeOf = (out: Awaited<ReturnType<typeof planPreview>>, p: string) => {
  const s = out.stores.find((x) => x.product === p);
  assert.ok(s, p);
  return s;
};

test("A39: a preview keeps no state and moves no feed revision; every store has its row, in the manifest's shape", async () => {
  const { db } = world();
  storeItems(db, "evolution", [held({ id: "routine:old", kind: "routine" })], "s", 1);
  const dump = () => JSON.stringify([db.prepare("SELECT * FROM fleet_access_items").all(), db.prepare("SELECT * FROM fleet_read_state").all(), db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events").get(), db.prepare("SELECT * FROM fleet_agents").all()]);
  const before = dump();
  const rev = revision(db);
  const f = fakeStores({ ...quiet, evolution: () => answer([wire("evolution", { id: "routine:a", kind: "routine", subject: { kind: "agent", id: AGENT_A.id } })]) });
  const out = await planPreview(accessEnv(f.callApp), db, "agent", AGENT_A.id, PICTURE(), NOW);
  validOut("plan_preview", out);
  assert.equal(dump(), before);
  assert.equal(revision(db), rev);
  assert.deepEqual(out.stores.map((s) => s.product), ["core", "connect", "knowledge", "kanban", "evolution"]);
  assert.deepEqual(out.subject, { kind: "agent", id: AGENT_A.id, name: AGENT_A.name });
  assert.deepEqual(storeOf(out, "evolution").items.map((i) => [i.id, i.effect]), [["routine:a", "stops"]]);
  assert.equal(storeOf(out, "evolution").state, "read");
  assert.ok(f.calls.every((c) => c.op === "access_list"), "reads only");
  assert.deepEqual(f.calls[0]?.input.subjects, [{ kind: "agent", id: AGENT_A.id }]);
});

test("not installed, could not be read, refused, waiting and reports nothing are five answers; a hanging store has its own row", async () => {
  const { db } = world();
  storeItems(db, "kanban", [held({ id: "assignment:a", kind: "assignment", level: "info", revocable: false }, "kanban")], "s", 1);
  noteRead(db, "kanban", [], T0 - 86_400_000);
  const f = fakeStores({ connect: NONE, knowledge: () => new Promise(() => {}), kanban: () => { throw new TbError("app_error", "secret detail", 503); }, evolution: () => { throw new TbError("hook_denied", "Refused by company policy", 403); } });
  const env = { ...accessEnv(f.callApp, ["connect", "knowledge", "kanban", "evolution"]), declared: new Set(["connect", "knowledge", "kanban", "evolution"]) };
  const out = await planPreview(env, db, "agent", AGENT_A.id, PICTURE(), NOW, 30);
  validOut("plan_preview", out);
  const connect = storeOf(out, "connect");
  assert.deepEqual([connect.state, connect.items.length], ["read", 0], "reports nothing");
  const hung = storeOf(out, "knowledge");
  assert.deepEqual([hung.state, hung.text], ["not_read", "The app did not answer in time."]);
  const down = storeOf(out, "kanban");
  assert.equal(down.state, "not_read");
  assert.match(String(down.text), /The last list, from \d{4}-\d{2}-\d{2}, had 1 item\./);
  assert.ok(!String(down.text).includes("secret"), "no detail of the error");
  assert.equal(down.items.length, 1, "the last list, never a zero");
  assert.ok(down.at);
  const denied = storeOf(out, "evolution");
  assert.deepEqual([denied.state, denied.text], ["refused", "Refused by company policy"]);
  const absent = await planPreview(accessEnv(f.callApp, ["connect"]), db, "agent", AGENT_A.id, PICTURE({ instances: [{ ins: "i", product: "connect", name: "Connect", version: "1" }] }), NOW);
  assert.equal(storeOf(absent, "evolution").state, "not_installed");
  assert.equal(storeOf(absent, "evolution").items.length, 0);
});

test("refused and held: the backoff is written, the next look makes no call and no new hold, and only that row changes", async () => {
  const { db } = world();
  const f = fakeStores({ ...quiet, knowledge: () => ({ status: "held", holdId: "h" }), evolution: () => { throw new TbError("hook_denied", "No", 403); } });
  const env = accessEnv(f.callApp);
  const rev = revision(db);
  const first = await planPreview(env, db, "agent", AGENT_A.id, null, Date.now());
  assert.equal(storeOf(first, "knowledge").state, "waiting");
  const n = f.calls.length;
  const again = await planPreview(env, db, "agent", AGENT_A.id, null, Date.now());
  assert.deepEqual(f.calls.slice(n).map((c) => c.target).sort(), ["connect", "kanban"]);
  assert.equal(storeOf(again, "knowledge").state, "waiting");
  assert.equal(storeOf(again, "evolution").state, "refused");
  assert.equal(revision(db), rev);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_access_items").get()?.n), 0);
});

test("effect: revocable stops; about is about; info stays; not revocable is manual; a kept agent's items stay", async () => {
  const { db, ann } = world();
  db.prepare("UPDATE fleet_agents SET keep_running = 1 WHERE id = ?").run(AGENT_B.id);
  db.prepare("UPDATE fleet_agents SET owner_id = ? WHERE id = ?").run(ann.id, AGENT_B.id);
  const a = { kind: "agent" as const, id: AGENT_A.id };
  const f = fakeStores({
    ...quiet,
    knowledge: () => answer([wire("knowledge", { id: "agent_area:a", kind: "agent_area", subject: a, level: "write", revocable: false }), wire("knowledge", { id: "team_grant:g", kind: "team_grant", subject: { kind: "person", id: ann.id }, direction: "about", level: "read" })]),
    connect: () => answer([wire("connect", { id: "account_as_itself:x", kind: "account_as_itself", subject: a, resource: "x" }), wire("connect", { id: "first_contacts:y", kind: "first_contacts", subject: a, resource: "y", level: "info", revocable: false }), wire("connect", { id: "account_as_itself:k", kind: "account_as_itself", subject: { kind: "agent", id: AGENT_B.id }, resource: "k" }), wire("connect", { id: "account_as_me:u", kind: "account_as_me", subject: { kind: "unlinked" }, resource: "u", revocable: false })]),
  });
  const out = await planPreview(accessEnv(f.callApp), db, "person", ann.id, null, NOW);
  validOut("plan_preview", out);
  const effects = Object.fromEntries(out.stores.flatMap((s) => s.items).map((i) => [i.id, [i.effect, i.label]]));
  assert.deepEqual(effects["agent_area:a"], ["manual", `${AGENT_A.name}: A thing`], "the words name the agent");
  assert.deepEqual(effects["team_grant:g"], ["about", "A thing"]);
  assert.deepEqual(effects["account_as_itself:x"], ["stops", `${AGENT_A.name}: A thing`]);
  assert.deepEqual(effects["first_contacts:y"], ["stays", `${AGENT_A.name}: A thing`]);
  assert.deepEqual(effects["account_as_itself:k"], ["stays", `${AGENT_B.name}: A thing`], "keep running");
  assert.equal(effects["runtime:" + AGENT_B.id]?.[0], "stays", "keep running: Portal too");
  assert.equal(out.unlinkedAccounts, 1);
  assert.equal(effects["account_as_me:u"], undefined, "an account with no person is a count, not an item of this person");
});

test("a person's read: the person with handles, unlinked, each owned agent; 32 per call; a row about someone else is dropped", async () => {
  const db = migratedDb();
  const ann = store.setPerson(db, { name: "Ann", handles: ["slack:u012abcdef"] }, T0);
  const ids = Array.from({ length: 35 }, (_, i) => `agt_01J00000000000000000000${String(i).padStart(3, "0")}`.replace(/I|L|O|U/g, "0"));
  store.syncAgents(db, ids.map((id) => ({ id: id as `agt_${string}`, name: `A${id.slice(-3)}`, mode: "free", status: "active" })), T0);
  for (const id of ids) db.prepare("UPDATE fleet_agents SET owner_id = ? WHERE id = ?").run(ann.id, id);
  const stranger = wire("evolution", { id: "routine:z", kind: "routine", subject: { kind: "agent", id: "agt_01J0000000000000000000000Z" } });
  const f = fakeStores({ ...quiet, evolution: () => answer([stranger]) });
  const out = await planPreview(accessEnv(f.callApp), db, "person", ann.id, null, NOW);
  const calls = f.calls.filter((c) => c.target === "evolution");
  assert.deepEqual(calls.map((c) => c.input.subjects.length), [32, 5]);
  assert.deepEqual(calls[0]?.input.subjects.slice(0, 2), [{ kind: "person", id: ann.id, handles: ["slack:U012ABCDEF"] }, { kind: "unlinked" }]);
  assert.equal(storeOf(out, "evolution").items.length, 0);
  assert.equal(storeOf(out, "core").items.length, 35);
});

test("Portal's row: what runs, from the slice; who can use what when the owner allowed it; the limit is stated when not", async () => {
  const { db } = world();
  const f = fakeStores(quiet);
  const seen = await planPreview(accessEnv(f.callApp), db, "agent", AGENT_A.id, PICTURE(), NOW);
  const core = storeOf(seen, "core");
  assert.deepEqual(core.items.map((i) => i.kind), ["agent_runtime", "app_access", "connection"]);
  assert.ok(core.items.every((i) => i.effect === "stops"));
  assert.deepEqual(core.notShown, []);
  assert.equal(JSON.stringify(core.items.map((i) => i.label)).includes("agt_"), false, "no raw id in the words");
  assert.equal(core.items[1]?.label, "Can use an app", "no product code when the picture has no name");
  const named = await planPreview(accessEnv(f.callApp), db, "agent", AGENT_A.id, PICTURE({ instances: [{ ins: "ins_1", product: "knowledge", name: "Knowledge base", version: "1" }] }), NOW);
  assert.equal(storeOf(named, "core").items[1]?.label, "Can use Knowledge base");
  const off = storeOf(await planPreview(accessEnv(f.callApp), db, "agent", AGENT_A.id, null, NOW), "core");
  assert.deepEqual([off.state, off.items.map((i) => i.kind), off.notShown[0]?.kind], ["read", ["agent_runtime"], "app_access"]);
  const cut = storeOf(await planPreview(accessEnv(f.callApp), db, "agent", AGENT_A.id, PICTURE({ truncated: true }), NOW), "core");
  assert.match(String(cut.notShown[0]?.reason), /too long/);
  db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  const paused = storeOf(await planPreview(accessEnv(f.callApp), db, "agent", AGENT_A.id, null, NOW), "core");
  assert.deepEqual([paused.items[0]?.label, paused.items[0]?.effect], ["Paused in Portal", "stays"]);
  const pausedSeen = storeOf(await planPreview(accessEnv(f.callApp), db, "agent", AGENT_A.id, PICTURE(), NOW), "core");
  assert.ok(pausedSeen.items.every((i) => i.effect === "stays"), "nothing to stop on a paused agent");
  db.prepare("UPDATE fleet_agents SET status = 'removed' WHERE id = ?").run(AGENT_A.id);
  const gone = storeOf(await planPreview(accessEnv(f.callApp), db, "agent", AGENT_A.id, null, NOW), "core");
  assert.deepEqual([gone.items[0]?.label, gone.items[0]?.state], ["Not listed in Portal", "dormant"]);
});

test("a person's read covers an owned card that is gone: an app may still list what it held; Portal's row leaves it out", async () => {
  const { db, ann } = world();
  db.prepare("UPDATE fleet_agents SET status = 'removed' WHERE id = ?").run(AGENT_A.id);
  const f = fakeStores({ ...quiet, evolution: () => answer([wire("evolution", { id: "routine:a", kind: "routine", subject: { kind: "agent", id: AGENT_A.id } })]) });
  const out = await planPreview(accessEnv(f.callApp), db, "person", ann.id, null, NOW);
  assert.equal(storeOf(out, "evolution").items.length, 1);
  assert.equal(storeOf(out, "core").items.length, 0);
});

test("plan_preview: an unknown entry is 404; an outside agent is no person", async () => {
  const { db } = world();
  const bot = store.setPerson(db, { name: "Bot", kind: "outside_agent" }, T0);
  const f = fakeStores(quiet);
  await assert.rejects(planPreview(accessEnv(f.callApp), db, "agent", "agt_01J0000000000000000000000Z", null, NOW), refused("agent_not_found", 404));
  await assert.rejects(planPreview(accessEnv(f.callApp), db, "person", bot.id, null, NOW), refused("person_not_found", 404));
  assert.equal(f.calls.length, 0);
});

test("A16: an agent or an app calling a new op is refused by the handler too", async () => {
  const { db } = world();
  const h = handlers as unknown as Record<string, { run: (i: unknown, c: unknown) => Promise<unknown> }>;
  for (const type of ["agent", "app"]) {
    for (const id of ["plan_preview", "findings_list", "exception_set", "reconcile_now"]) await assert.rejects(h[id]?.run({ kind: "agent", id: AGENT_A.id, code: "no_owner", reason: "x", until: "2030-01-01" }, { db, caller: { type, id: "x" } }) as Promise<unknown>, refused("no_access", 403), `${id} as ${type}`);
  }
});

const list = (db: Db, portal: Parameters<typeof unreadOf>[1] = { read: true }, now = NOW) => {
  const out = findingsList(db, loadColleagues(db, now).rows.map((r) => ({ kind: r.kind, id: r.id, name: r.name, at: r.at, findings: r.findings })), portal, now);
  validOut("findings_list", out);
  return out;
};
const codes = (o: ReturnType<typeof list>) => o.items.map((i) => i.code);

test("findings_list: before the first read it says so; the first rows name an owner", () => {
  const { db } = world();
  const out = list(db);
  assert.equal(out.lastSweepAt, null);
  assert.equal(out.storesRead, 0);
  assert.equal(codes(out)[0], "no_owner", AGENT_B.name);
  db.exec("INSERT INTO fleet_sweeps (id, started_by, started_at, finished_at) VALUES ('swp_1', 'schedule', 1, 2000)");
  noteRead(db, "connect", [], 2000);
  noteStop(db, "knowledge", { state: "not_installed", code: "not_installed", text: "Not there." }, 2000);
  noteStop(db, "evolution", { state: "refused", code: "hook_denied", text: "No." }, 2000);
  noteStop(db, "kanban", { state: "not_read", code: "timeout", text: "Late." }, 2000);
  const after = list(db);
  assert.equal(after.lastSweepAt, new Date(2000).toISOString());
  assert.equal(after.storesRead, 1);
  assert.deepEqual(after.unread, [{ product: "evolution", name: "Evolving Workflows", text: "No." }, { product: "kanban", name: "Task Board", text: "Late." }], "'not installed' is no problem to read");
  assert.deepEqual(list(db, portalReadState(null)).unread[0]?.product, "core", "no consent is a stated limit");
});

test("access_after_leave: only a leaving or closed subject, only access held; a paused item counts until it is revoked", () => {
  const { db, ann } = world();
  const held1 = [held({ id: "routine:a", kind: "routine" })];
  storeItems(db, "evolution", held1, "s", 1);
  assert.ok(!codes(list(db)).includes("access_after_leave"), "active subject");
  leave(db, "agent", AGENT_A.id);
  const row = list(db).items.find((i) => i.code === "access_after_leave");
  assert.deepEqual([row?.subject?.id, row?.productName], [AGENT_A.id, "Evolving Workflows"]);
  assert.ok(row?.since);
  storeItems(db, "evolution", [held({ id: "routine:a", kind: "routine", state: "paused" })], "s", 2);
  assert.ok(codes(list(db)).includes("access_after_leave"), "paused still counts");
  storeItems(db, "connect", [held({ id: "first_contacts:f", kind: "first_contacts", level: "info", revocable: false }, "connect")], "s", 2);
  assert.equal(list(db).items.find((i) => i.code === "access_after_leave")?.productName, "Evolving Workflows", "info is no access");
  db.exec("DELETE FROM fleet_access_items WHERE item_id = 'routine:a'");
  assert.ok(!codes(list(db)).includes("access_after_leave"));
  // A person: others reading the person's things (about) is the owner's own choice; a sender is access.
  leave(db, "person", ann.id);
  const person = { kind: "person", id: ann.id } as const;
  storeItems(db, "knowledge", [held({ id: "team_grant:g", kind: "team_grant", subject: person, direction: "about", level: "read" }, "knowledge")], "s", 3);
  assert.ok(!list(db).items.some((i) => i.code === "access_after_leave" && i.subject?.id === ann.id));
  storeItems(db, "connect", [held({ id: "channel_sender:slack:U1", kind: "channel_sender", subject: person }, "connect"), held({ id: "account_as_itself:d", kind: "account_as_itself", subject: person, state: "dormant" }, "connect")], "s", 3);
  assert.equal(list(db).items.find((i) => i.code === "access_after_leave" && i.subject?.id === ann.id)?.productName, "Connect");
  assert.ok(loadColleagues(db, NOW).byId.get(`person:${ann.id}`)?.findings.some((f) => f.code === "access_after_leave"), "the entry's own row says it too");
});

test("orphan and unlinked: one row per store, no raw id in the text", () => {
  const db = migratedDb();
  store.syncAgents(db, [AGENT_A], T0);
  const unknownPerson = { kind: "person", id: "psn_gone" } as const;
  storeItems(db, "connect", [held({ id: "channel_sender:slack:U1", kind: "channel_sender", subject: unknownPerson }, "connect"), held({ id: "account_as_me:a", kind: "account_as_me", subject: { kind: "unlinked" } }, "connect"), held({ id: "account_as_me:b", kind: "account_as_me", subject: { kind: "unlinked" } }, "connect")], "s", 1);
  storeItems(db, "evolution", [held({ id: "routine:a", kind: "routine", subject: { kind: "agent", id: "agt_01J0000000000000000000000Z" } })], "s", 1);
  const out = list(db);
  assert.deepEqual(out.items.filter((i) => i.code === "orphan").map((i) => [i.productName, i.subject]), [["Connect", null], ["Evolving Workflows", null]]);
  const un = out.items.find((i) => i.code === "unlinked_account");
  assert.deepEqual([un?.text, un?.productName, un?.subject], ["2 accounts have no person. Check them in Connect.", "Connect", null]);
  assert.ok(!JSON.stringify(out.items.map((i) => i.text)).includes("psn_"));
});

test("exception_set: accepted, shown with its reason, recorded; it comes back on the date; the Summary count follows", () => {
  const { db } = world();
  const subject = () => {
    const r = loadColleagues(db, NOW).byId.get(`agent:${AGENT_B.id}`);
    assert.ok(r);
    return { kind: r.kind, id: r.id, name: r.name, at: r.at, findings: r.findings };
  };
  const events = () => Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events").get()?.n);
  const open = () => openDifferences(db, loadColleagues(db, NOW).rows, NOW);
  const before = open();
  const seen = events();
  const until = new Date(NOW + 86_400_000).toISOString();
  const rev = revision(db);
  const out = setException(db, { code: "no_owner", kind: "agent", id: AGENT_B.id, reason: " Test agent\u202e ", until }, subject(), "per_owner", NOW);
  assert.deepEqual(out, { exception: { code: "no_owner", reason: "Test agent", until } });
  validOut("exception_set", out);
  assert.equal(events(), seen + 1);
  assert.equal(revision(db), rev, "the feed does not move");
  assert.equal(open(), before - 1);
  const row = list(db).items.find((i) => i.code === "no_owner" && i.subject?.id === AGENT_B.id);
  assert.deepEqual(row?.exception, { reason: "Test agent", until });
  const later = NOW + 2 * 86_400_000;
  assert.equal(list(db, { read: true }, later).items.find((i) => i.code === "no_owner" && i.subject?.id === AGENT_B.id)?.exception, null);
});

test("an acceptance covers what the owner saw: a new item or a new lifecycle change shows the difference again", () => {
  const { db } = world();
  storeItems(db, "evolution", [held({ id: "routine:a", kind: "routine" })], "s", T0);
  leave(db, "agent", AGENT_A.id);
  const row = () => {
    const r = loadColleagues(db, NOW).byId.get(`agent:${AGENT_A.id}`);
    assert.ok(r);
    return { kind: r.kind, id: r.id, name: r.name, at: r.at, findings: r.findings };
  };
  const until = new Date(NOW + 86_400_000).toISOString();
  setException(db, { code: "access_after_leave", kind: "agent", id: AGENT_A.id, reason: "Known", until }, row(), "o", NOW);
  const accepted = () => list(db).items.find((i) => i.code === "access_after_leave")?.exception;
  assert.ok(accepted());
  const note = db.prepare("SELECT note FROM fleet_lifecycle_events ORDER BY seq DESC LIMIT 1").get()?.note;
  assert.ok(!String(note).includes("access_after_leave") && String(note).includes("Known"), "the history reads in words");
  storeItems(db, "evolution", [held({ id: "routine:b", kind: "routine" })], "s", NOW + 5);
  assert.equal(accepted(), null, "a new item");
  db.exec("DELETE FROM fleet_access_items WHERE item_id = 'routine:b'");
  assert.ok(accepted());
  db.prepare("UPDATE fleet_agents SET lifecycle_at = ? WHERE id = ?").run(NOW + 5, AGENT_A.id);
  assert.equal(accepted(), null, "a new change");
});

test("exception_set refuses: no such entry, a finding that is gone, a date past or too far, an empty reason; nothing is written", () => {
  const { db } = world();
  const r = loadColleagues(db, NOW).byId.get(`agent:${AGENT_B.id}`);
  assert.ok(r);
  const s = { kind: r.kind, id: r.id, name: r.name, at: r.at, findings: r.findings };
  const until = new Date(NOW + 1000).toISOString();
  const base = { code: "no_owner", kind: "agent" as const, id: AGENT_B.id, reason: "ok", until };
  assert.throws(() => setException(db, base, null, "o", NOW), refused("agent_not_found", 404));
  assert.throws(() => setException(db, { ...base, code: "not_stopped" }, s, "o", NOW), refused("finding_gone", 409));
  assert.throws(() => setException(db, { ...base, until: new Date(NOW - 1).toISOString() }, s, "o", NOW), refused("until_invalid", 400));
  assert.throws(() => setException(db, { ...base, until: "soon" }, s, "o", NOW), refused("until_invalid", 400));
  assert.throws(() => setException(db, { ...base, until: new Date(NOW + 400 * 86_400_000).toISOString() }, s, "o", NOW), refused("until_invalid", 400));
  assert.throws(() => setException(db, { ...base, reason: "\u200b " }, s, "o", NOW), refused("reason_required", 400));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_exceptions").get()?.n), 0);
});

test("G5: access_list only on targets that are on qa1; access_revoke only on those that end anything (plan lane); M-CP-2 passes with the ops and fails without them", () => {
  const stores = (manifest.companions ?? []).filter((c) => (c.operations as readonly string[]).includes("access_list"));
  assert.deepEqual(stores.map((c) => c.product).sort(), ["evolution", "kanban", "knowledge"]);
  for (const c of stores) {
    const ends = c.product !== "kanban"; // Task Board is list-only
    assert.deepEqual(c.operations, ends ? ["access_list", "access_revoke"] : ["access_list"]);
    assert.deepEqual(c.crud, ends ? ["read", "update"] : ["read"]);
    const op = { id: "access_list", title: "List", description: "List.", crud: ["read"], effect: "read", idempotency: "none", receipt: false, audience: "agent", listing: "workflow", input: { type: "object" }, output: { type: "object" } };
    const only = { ...manifest, companions: [c] };
    const ops = ends ? [op, { ...op, id: "access_revoke", crud: ["update"], effect: "write", idempotency: "required", receipt: true }] : [op];
    assert.equal(validateCompanions(only as never, [{ id: c.product, operations: ops }] as never).ok, true, c.product);
    assert.equal(validateCompanions(only as never, [{ id: c.product, operations: [] }] as never).ok, false, c.product);
  }
});
