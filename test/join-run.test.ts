// C380 T2-d (PR 2): sending what Join checked. A lost answer never makes a second person; the team is read right before it is
// changed; three failures in a row stop the run; a row that went through is never sent twice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAgainst, parsePastedList } from "../src/ui/pages/join-input.ts";
import { addedIds, counts, type Deps, inputOf, newRun, type Options, sendPeople, sendTeam } from "../src/ui/pages/join-run.ts";

interface Call {
  op: string;
  input: any;
  key: string;
}
/** A server that keeps what it did by key (the idempotency replay), so a repeated key has the old answer. */
function world(over: { fail?: (op: string, input: any, n: number) => Error | null; team?: { id: string; name: string; members: { kind: string; id: string; name: string; role: string }[] } | null } = {}) {
  const calls: Call[] = [];
  const done = new Map<string, unknown>();
  const people: { id: string; name: string }[] = [];
  let n = 0;
  const team = over.team === undefined ? { id: "tm_1", name: "Support", members: [{ kind: "person", id: "psn_old", name: "Old", role: "lead" }, { kind: "agent", id: "agt_a", name: "Henry", role: "member" }] } : over.team;
  let members = team ? [...team.members] : [];
  const deps: Deps = {
    say: (e) => (e instanceof Error ? e.message : "error"),
    async call<T>(op: string, input: any, key: string): Promise<T> {
      calls.push({ op, input, key });
      if (done.has(key)) return done.get(key) as T;
      const bad = over.fail?.(op, input, ++n);
      if (bad) throw bad;
      let out: unknown = {};
      if (op === "person_set") {
        const p = { id: `psn_${people.length + 1}`, name: input.name as string };
        people.push(p);
        out = { person: p };
      } else if (op === "overview_get") out = { teams: team ? [{ ...team, members }] : [] };
      else if (op === "members_set") members = [...input.people.map((p: any) => ({ kind: "person", id: p.id, name: "", role: p.role })), ...input.agents.map((a: any) => ({ kind: "agent", id: a.id, name: "", role: a.role }))];
      done.set(key, out);
      return out as T;
    },
  };
  return { deps, calls, people, members: () => members };
}
const OPTS: Options = { team: "tm_1", contractor: false, until: null };
const rowsOf = (text: string) => checkAgainst(parsePastedList(text).rows, []);

test("quiet on good: every ready row is one person_set with its own key, then one members_set that keeps the old members", async () => {
  const w = world();
  const run = newRun("b1");
  const rows = rowsOf("Ann, slack:U1AAAAAAA\nBo, bo@acme.test, Lead");
  await sendPeople(run, rows, OPTS, w.deps);
  await sendTeam(run, OPTS, w.deps);
  assert.deepEqual(counts(run), { added: 2, failed: 0, notTried: 0 });
  assert.deepEqual(w.calls.filter((c) => c.op === "person_set").map((c) => c.key), ["join-b1-1", "join-b1-2"]);
  assert.deepEqual(w.calls.map((c) => c.op), ["person_set", "person_set", "overview_get", "members_set"]);
  const set = w.calls.at(-1)?.input;
  assert.deepEqual(set.people.map((p: any) => [p.id, p.role]), [["psn_old", "lead"], ["psn_1", "member"], ["psn_2", "member"]], "the old lead stays a lead");
  assert.deepEqual(set.agents, [{ id: "agt_a", role: "member" }], "the team's agents are sent back as they were");
  assert.deepEqual(run.team, { state: "added", name: "Support" });
});

test("quiet on good: a contractor carries the tag and the end date in the same person_set", () => {
  const r = rowsOf("Dana, dana@acme.test, Designer, slack:U2AAAAAAA")[0];
  assert.ok(r);
  assert.deepEqual(inputOf(r, { team: null, contractor: true, until: "2026-12-31T23:59:59.000Z" }), { name: "Dana", handles: ["slack:U2AAAAAAA"], tags: ["contractor"], email: "dana@acme.test", title: "Designer", validUntil: "2026-12-31T23:59:59.000Z" });
  assert.deepEqual(inputOf(r, { team: null, contractor: false, until: null }).tags, []);
  assert.equal("validUntil" in inputOf(r, { team: null, contractor: false, until: null }), false);
});

test("fire on bad: rows with a problem, or already in the directory, are never sent", async () => {
  const w = world();
  const run = newRun("b2");
  const rows = checkAgainst(parsePastedList("Ann\nBo, x, y, z\nAnn again\nann").rows, [{ name: "Ann again", email: null, handles: [] }]);
  await sendPeople(run, rows, { ...OPTS, team: null }, w.deps);
  assert.deepEqual(w.calls.map((c) => c.input.name), ["Ann"]);
});

test("a lost answer: the retry carries the same key and makes no second person", async () => {
  let lose = true;
  const w = world();
  const real = w.deps.call.bind(w.deps);
  const deps: Deps = {
    ...w.deps,
    async call<T>(op: string, input: unknown, key: string): Promise<T> {
      const out = await real<T>(op, input, key);
      if (lose && op === "person_set") {
        lose = false;
        throw new Error("The answer did not arrive.");
      }
      return out;
    },
  };
  const run = newRun("b3");
  const rows = rowsOf("Ann");
  await sendPeople(run, rows, { ...OPTS, team: null }, deps);
  assert.deepEqual(counts(run), { added: 0, failed: 1, notTried: 0 });
  await sendPeople(run, rows, { ...OPTS, team: null }, deps);
  assert.deepEqual(counts(run), { added: 1, failed: 0, notTried: 0 });
  assert.equal(w.people.length, 1, "one person on the server");
  assert.deepEqual(new Set(w.calls.filter((c) => c.op === "person_set").map((c) => c.key)).size, 1);
});

test("fire on bad: a row refused by the server shows the server's sentence; the others go on; a repeat sends only the failed row", async () => {
  const w = world({ fail: (op, input) => (op === "person_set" && input.name === "Bo" ? new Error("slack:U1AAAAAAA belongs to another person.") : null) });
  const run = newRun("b4");
  const rows = rowsOf("Ann\nBo\nCy");
  await sendPeople(run, rows, { ...OPTS, team: null }, w.deps);
  assert.deepEqual(counts(run), { added: 2, failed: 1, notTried: 0 });
  assert.deepEqual(run.rows.get(2), { state: "failed", message: "slack:U1AAAAAAA belongs to another person." });
  const before = w.calls.length;
  await sendPeople(run, rows, { ...OPTS, team: null }, w.deps);
  assert.deepEqual(w.calls.slice(before).map((c) => c.input.name), ["Bo"], "Ann and Cy are not sent twice");
});

test("three failures in a row stop the run: the rest is not tried, and a repeat finishes it", async () => {
  let broken = true;
  const w = world({ fail: () => (broken ? new Error("The server is not answering.") : null) });
  const run = newRun("b5");
  const rows = rowsOf("A\nB\nC\nD\nE");
  await sendPeople(run, rows, { ...OPTS, team: null }, w.deps);
  assert.deepEqual(counts(run), { added: 0, failed: 3, notTried: 2 });
  assert.equal(w.calls.length, 3);
  broken = false;
  await sendPeople(run, rows, { ...OPTS, team: null }, w.deps);
  assert.deepEqual(counts(run), { added: 5, failed: 0, notTried: 0 });
});

test("the team: read again right before the change; a team that is gone, or a refusal, keeps the people and says so; a repeat adds only to the team", async () => {
  const w = world({ team: null });
  const run = newRun("b6");
  await sendPeople(run, rowsOf("Ann"), OPTS, w.deps);
  await sendTeam(run, OPTS, w.deps);
  assert.deepEqual(run.team, { state: "failed", message: "This team is gone. Choose a team on the People page." });
  assert.equal(w.calls.some((c) => c.op === "members_set"), false);
  assert.deepEqual(addedIds(run), ["psn_1"]);

  let refuse = true;
  const w2 = world({ fail: (op) => (op === "members_set" && refuse ? new Error("A team has at most 500 people.") : null) });
  const run2 = newRun("b7");
  await sendPeople(run2, rowsOf("Ann"), OPTS, w2.deps);
  await sendTeam(run2, OPTS, w2.deps);
  assert.deepEqual(run2.team, { state: "failed", message: "A team has at most 500 people." });
  refuse = false;
  await sendTeam(run2, OPTS, w2.deps);
  assert.deepEqual(run2.team, { state: "added", name: "Support" });
  assert.equal(w2.calls.filter((c) => c.op === "person_set").length, 1, "no person was sent again");
  const keys = w2.calls.filter((c) => c.op === "members_set").map((c) => c.key);
  assert.equal(new Set(keys).size, 2, "a new key per try: an old answer cannot stand in for the new list");
});

test("no team chosen: no read of the directory and no members_set", async () => {
  const w = world();
  const run = newRun("b8");
  await sendPeople(run, rowsOf("Ann"), { ...OPTS, team: null }, w.deps);
  await sendTeam(run, { ...OPTS, team: null }, w.deps);
  assert.deepEqual(w.calls.map((c) => c.op), ["person_set"]);
  assert.deepEqual(run.team, { state: "none" });
});
