// C380 T2-d (PR 4): the Join of a new agent is sent as owner, team, review, in that order. The review is last. A step that went through is
// never repeated. A failure stops the steps after it and names the step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentJoin, newAgentRun, sendAgentJoin } from "../src/ui/pages/join-agent-run.ts";
import type { Deps } from "../src/ui/pages/join-run.ts";

interface Call {
  op: string;
  input: any;
  key: string;
}
function world(fail: (op: string, n: number) => Error | null = () => null) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  let members = [{ kind: "person", id: "psn_old", name: "Old", role: "lead" }];
  const deps: Deps = {
    say: (e) => (e instanceof Error ? e.message : "error"),
    async call<T>(op: string, input: any, key: string): Promise<T> {
      calls.push({ op, input, key });
      const n = (counts.get(op) ?? 0) + 1;
      counts.set(op, n);
      const bad = fail(op, n);
      if (bad) throw bad;
      if (op === "overview_get") return { teams: [{ id: "tm_1", name: "Support", members }] } as T;
      if (op === "colleague_get") return { colleague: { rev: 7 } } as T;
      if (op === "members_set") members = [...input.people.map((p: any) => ({ kind: "person", id: p.id, name: "", role: p.role })), ...input.agents.map((a: any) => ({ kind: "agent", id: a.id, name: "", role: a.role }))];
      return {} as T;
    },
  };
  return { deps, calls };
}
const JOIN: AgentJoin = { agent: "agt_a", owner: "psn_new", team: "tm_1", until: "2099-12-31T23:59:59.000Z" };

test("quiet on good: owner, then team (the old members kept), then the review with the revision read just before and the end date", async () => {
  const w = world();
  const run = newAgentRun("b1");
  await sendAgentJoin(run, JOIN, w.deps);
  assert.deepEqual(w.calls.map((c) => c.op), ["agent_set", "overview_get", "members_set", "colleague_get", "lifecycle_set"]);
  assert.deepEqual(w.calls[0]?.input, { agent: "agt_a", owner: "psn_new" });
  assert.deepEqual(w.calls[2]?.input, { team: "tm_1", people: [{ id: "psn_old", role: "lead" }], agents: [{ id: "agt_a", role: "member" }] });
  assert.deepEqual(w.calls[4]?.input, { kind: "agent", id: "agt_a", to: "active", reason: "reviewed", expectedRev: 7, validUntil: "2099-12-31T23:59:59.000Z" });
  assert.deepEqual([...run.done], ["owner", "team", "review"]);
  assert.equal(run.failed, null);
  assert.equal(run.teamName, "Support");
});

test("quiet on good: an owner who does not change, no team and no end date send only the review, with no validUntil", async () => {
  const w = world();
  const run = newAgentRun("b2");
  await sendAgentJoin(run, { agent: "agt_a", owner: null, team: null, until: null }, w.deps);
  assert.deepEqual(w.calls.map((c) => c.op), ["colleague_get", "lifecycle_set"]);
  assert.equal(Object.hasOwn(w.calls[1]?.input ?? {}, "validUntil"), false);
});

test("fire on bad: a failed owner stops everything after it, and nothing is marked as reviewed", async () => {
  const w = world((op) => (op === "agent_set" ? new Error("The new owner must be an active person.") : null));
  const run = newAgentRun("b3");
  await sendAgentJoin(run, JOIN, w.deps);
  assert.deepEqual(w.calls.map((c) => c.op), ["agent_set"]);
  assert.deepEqual(run.failed, { step: "owner", message: "The new owner must be an active person." });
  assert.equal(run.done.size, 0);
});

test("fire on bad: a failed team keeps the owner and does not review; a repeat does not set the owner again, and the review comes last", async () => {
  const w = world((op, n) => (op === "members_set" && n === 1 ? new Error("A team has at most 500 people.") : null));
  const run = newAgentRun("b4");
  await sendAgentJoin(run, JOIN, w.deps);
  assert.deepEqual(run.failed, { step: "team", message: "A team has at most 500 people." });
  assert.deepEqual([...run.done], ["owner"]);
  assert.equal(w.calls.some((c) => c.op === "lifecycle_set"), false, "not reviewed while the team failed");
  await sendAgentJoin(run, JOIN, w.deps);
  assert.equal(run.failed, null);
  assert.equal(w.calls.filter((c) => c.op === "agent_set").length, 1, "the owner is not set twice");
  assert.deepEqual([...run.done], ["owner", "team", "review"]);
  assert.equal(new Set(w.calls.filter((c) => c.op === "members_set").map((c) => c.key)).size, 2, "a new key for the second try");
});

test("fire on bad: a refused review (the entry changed) is named, and a repeat reads the revision again", async () => {
  const w = world((op, n) => (op === "lifecycle_set" && n === 1 ? new Error("This entry changed since you looked. Open it again.") : null));
  const run = newAgentRun("b5");
  await sendAgentJoin(run, { ...JOIN, team: null }, w.deps);
  assert.deepEqual(run.failed, { step: "review", message: "This entry changed since you looked. Open it again." });
  await sendAgentJoin(run, { ...JOIN, team: null }, w.deps);
  assert.equal(w.calls.filter((c) => c.op === "colleague_get").length, 2);
  assert.deepEqual([...run.done], ["owner", "review"]);
});

test("fire on bad: a team that is gone is said, not guessed", async () => {
  const w = world();
  const run = newAgentRun("b6");
  await sendAgentJoin(run, { ...JOIN, team: "tm_gone" }, w.deps);
  assert.deepEqual(run.failed, { step: "team", message: "This team is gone. Choose a team on the People page." });
  assert.equal(w.calls.some((c) => c.op === "members_set" || c.op === "lifecycle_set"), false);
});

test("an agent that has a last day and gets \"no end\": the review sends validUntil null, and only then (it is said in the screen)", async () => {
  const w = world();
  const run = newAgentRun("b7");
  await sendAgentJoin(run, { agent: "agt_a", owner: null, team: null, until: null, clearUntil: true }, w.deps);
  assert.deepEqual(w.calls.at(-1)?.input, { kind: "agent", id: "agt_a", to: "active", reason: "reviewed", expectedRev: 7, validUntil: null });
  const w2 = world();
  await sendAgentJoin(newAgentRun("b8"), { agent: "agt_a", owner: null, team: null, until: "2099-12-31T23:59:59.000Z", clearUntil: true }, w2.deps);
  assert.equal(w2.calls.at(-1)?.input.validUntil, "2099-12-31T23:59:59.000Z", "a new day wins over clearing");
});
