// The plain logic of the lifecycle pages (C380 B10), without a DOM: a page for an op that is not on stays off, what may be
// said before a change never claims a stop, and the refusals of `lifecycle_set` read as sentences.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NOT_CHANGED as SERVER_NOT_CHANGED } from "../src/plans/portal-link.ts";
import { nextInLoop } from "../src/ui/dialog-focus.ts";
import { type AgentChoice, type Choices, canChoose, choiceOf, choiceSummary, choicesReady, decisionsOf, newKeyEffect, stoppingOf } from "../src/ui/pages/agent-choice.ts";
import { featuresOf } from "../src/ui/pages/features.ts";
import { lifecycleError, stopCapOf } from "../src/ui/pages/lifecycle-errors.ts";
import { currentPlans, liveBanners, pollDelay } from "../src/ui/pages/plan-poll.ts";
import { subjectFromUrl, subjectHref } from "../src/ui/pages/subject-link.ts";
import { afterChangeText, age, beforeChangeText, beforeChangeTone, floorTone, NOT_CHANGED, notChangedOf, REASONS, reasonLabel, when } from "../src/ui/pages/words.ts";
import { withoutIds } from "../src/ui/rule-text.ts";
import { followSystemTheme } from "../src/ui/theme.ts";

describe("features come from the ops of this build", () => {
  it("on when every op is there", () => {
    assert.deepEqual(featuresOf(["summary_get", "colleagues_list", "colleague_get", "lifecycle_set", "plan_preview", "findings_list"]), { lifecycle: true, preview: true, refusals: false, differences: true, plans: false, roles: false, rolesInNav: false, exclusions: false, exclusionsInNav: false, rounds: false, record: false, roundsNav: false, recordNav: false, join: false, joinInNav: false });
  });
  it("off when one op is missing", () => {
    assert.equal(featuresOf(["summary_get", "colleagues_list", "colleague_get"]).lifecycle, false);
    assert.equal(featuresOf(["summary_get"]).preview, false);
    assert.equal(featuresOf(["summary_get"]).differences, false);
    assert.equal(featuresOf(["summary_get"]).refusals, false);
    assert.equal(featuresOf(["refusals_get"]).refusals, true, "the page of who is refused needs refusals_get (C381)");
    assert.equal(featuresOf(["plan_send", "plan_get", "plan_retry"]).plans, false);
    assert.equal(featuresOf(["plan_send", "plan_get", "plan_retry", "plan_cancel"]).plans, true);
  });
});

describe("the choice for each agent (D2, C381)", () => {
  const agents = [{ id: "a", lifecycle: "active" }, { id: "b", lifecycle: "active" }, { id: "c", lifecycle: "active" }, { id: "d", lifecycle: "active" }];
  const named = agents.map((x) => ({ ...x, name: x.id.toUpperCase() }));
  const D = { owner: "per_def", newKey: true };
  const pick = (over: Partial<AgentChoice>): AgentChoice => ({ choice: "move", newOwner: "", newKey: true, ...over });
  it("the default is Move to the default owner with a new key: nothing was chosen yet, and plan_send carries the transfers", () => {
    assert.deepEqual(choiceOf({}, "a", D), { choice: "move", newOwner: "per_def", newKey: true });
    assert.deepEqual(decisionsOf(agents, {}, D), agents.map((x) => ({ agent: x.id, decision: "transfer", newOwner: "per_def", newKey: true })));
    assert.equal(choicesReady(agents, {}, D), true);
    assert.deepEqual(stoppingOf(agents, {}, D), []);
  });
  it("with no owner to move to, the only starting point is to name one later: nothing goes to plan_send and each agent keeps running", () => {
    const none = { owner: "", newKey: true };
    assert.equal(choiceOf({}, "a", none, false).choice, "later");
    assert.deepEqual(decisionsOf(agents, {}, none, false), []);
    assert.equal(choicesReady(agents, {}, none, false), true);
    assert.equal(choiceSummary(agents, {}, none, false), "0 move to a new owner, 0 stop and remove, 4 keep this owner for now");
  });
  it("sends only what was chosen, in the shape of the op; a later is left out", () => {
    const all: Choices = { a: pick({ choice: "stop" }), b: pick({ choice: "move", newOwner: "per_2", newKey: false }), c: pick({ choice: "later" }), d: pick({ choice: "move", newOwner: "per_3" }) };
    assert.deepEqual(decisionsOf(agents, all, D), [
      { agent: "a", decision: "stop" },
      { agent: "b", decision: "transfer", newOwner: "per_2", newKey: false },
      { agent: "d", decision: "transfer", newOwner: "per_3", newKey: true },
    ]);
    assert.deepEqual(stoppingOf(agents, all, D), ["a"]);
    assert.equal(choiceSummary(agents, all, D), "2 move to a new owner, 1 of them with a new key, 1 stop and remove, 1 keep this owner for now");
  });
  it("a move needs a new owner; a stop or a later does not", () => {
    assert.equal(choicesReady(agents, { a: pick({ choice: "move", newOwner: "" }) }, { owner: "", newKey: true }), false);
    assert.equal(choicesReady(agents, { a: pick({ choice: "move", newOwner: "p" }) }, { owner: "", newKey: true }), false, "the others still have none");
    assert.equal(choicesReady(agents.slice(0, 1), { a: pick({ choice: "move", newOwner: "p" }) }, { owner: "", newKey: true }), true);
    assert.equal(choicesReady(agents.slice(0, 1), { a: pick({ choice: "stop" }) }, { owner: "", newKey: true }), true);
    assert.equal(choicesReady(agents.slice(0, 1), { a: pick({ choice: "later" }) }, { owner: "", newKey: true }), true);
  });
  it("the new-key sentence: it names the agents, says they keep working until Portal, and is null with no new key", () => {
    const text = newKeyEffect(named, {}, D) ?? "";
    assert.match(text, /^New key: A, B, C, D\. They keep working until you approve in Portal\. Then the old keys stop, and they cannot work until you connect them again\.$/);
    assert.match(newKeyEffect(named.slice(0, 1), {}, D) ?? "", /^New key: A\. It keeps working until you approve in Portal\./);
    assert.equal(newKeyEffect(named, {}, { owner: "per_def", newKey: false }), null);
    assert.equal(newKeyEffect(named, { a: pick({ choice: "stop" }), b: pick({ choice: "later" }), c: pick({ newKey: false }), d: pick({ choice: "stop" }) }, D), null);
  });
  it("who can choose", () => {
    assert.equal(canChoose({ lifecycle: "leaving" }), false);
    assert.equal(canChoose({ lifecycle: "archived" }), false);
    assert.equal(canChoose({ lifecycle: "suspended" }), true);
    assert.equal(canChoose({ lifecycle: "active" }), true);
  });
});

describe("the plan polls only while it moves", () => {
  const plan = (over: Record<string, unknown>) => ({ closedAt: null, reviewUrl: null, mode: "draft", ...over }) as never;
  it("2 s until the request is ready, 30 s after, stops when all ended", () => {
    assert.equal(pollDelay([plan({})]), 2000);
    assert.equal(pollDelay([plan({ reviewUrl: "https://x" })]), 30000);
    assert.equal(pollDelay([plan({ mode: "portal_link" })]), 30000);
    assert.equal(pollDelay([plan({ closedAt: "2026-10-30T00:00:00Z" })]), null);
    assert.equal(pollDelay([]), 30000, "no plan: no fast loop");
  });
  const p = (over: Record<string, unknown>) => ({ closedAt: null, reviewUrl: null, mode: "draft", groupId: "g1", openedAt: "2026-10-30T10:00:00Z", id: "p1", state: "waiting", ...over });
  it("an old ended plan does not stand for this stop; an open one always does; a split stays together", () => {
    const ended = p({ closedAt: "2026-10-30T11:00:00Z" });
    assert.deepEqual(currentPlans([ended], "2026-10-30T12:00:00Z"), []);
    assert.deepEqual(currentPlans([ended], "2026-10-30T09:00:00Z"), [ended]);
    assert.deepEqual(currentPlans([p({})], "2026-10-30T12:00:00Z"), [p({})]);
    assert.equal(currentPlans([p({ id: "a" }), p({ id: "b" }), p({ id: "old", groupId: "g0" })], null).length, 2);
  });
  it("a waiting alert ends when its plan moved on; other alerts stay", () => {
    const b = (kind: string) => ({ plan: "p1", kind, text: "x" });
    assert.equal(liveBanners({ plans: [p({})], banners: [b("waiting")] }).length, 1);
    assert.equal(liveBanners({ plans: [p({ state: "running" })], banners: [b("waiting")] }).length, 0);
    assert.equal(liveBanners({ plans: [], banners: [b("waiting")] }).length, 0);
    assert.equal(liveBanners({ plans: [], banners: [b("expired")] }).length, 1);
  });
});

describe("words before a change", () => {
  const STATES = ["confirmed", "not_confirmed", "not_installed", "older", "not_read"] as const;
  it("never says that anything stopped or that Rules has the change", () => {
    for (const state of STATES) {
      const t = beforeChangeText({ state });
      assert.doesNotMatch(t, /\b(stopped|has this change now|are refused)\b/i, state);
    }
  });
  it("says the Portal step when Rules cannot help", () => {
    for (const state of ["not_installed", "older", "not_read"] as const) assert.match(beforeChangeText({ state }), /stops? (only )?when you approve in Portal/);
  });
  it("names what Governance cannot see when Rules is there", () => {
    for (const state of ["confirmed", "not_confirmed"] as const) assert.match(beforeChangeText({ state }), /cannot see that switch/);
  });
  it("only a confirmed change reads as live", () => {
    assert.equal(floorTone({ state: "confirmed" }), "live");
    for (const state of ["not_confirmed", "older", "not_read"] as const) assert.equal(floorTone({ state }), "needs-you");
    assert.equal(floorTone({ state: "not_installed" }), "neutral");
    assert.equal(beforeChangeTone({ state: "not_read" }), "needs-you");
    assert.equal(beforeChangeTone({ state: "confirmed" }), "neutral");
  });
  it("the page's Not changed block is the server's, word for word (the browser cannot import server code)", () => {
    assert.deepEqual([...NOT_CHANGED], [...SERVER_NOT_CHANGED]);
  });
  it("the first line says that agents keep working; an agent's own block has no such line (C381)", () => {
    assert.match(NOT_CHANGED[0] ?? "", /^Their agents\. Agents keep working when a person leaves/);
    assert.deepEqual([...notChangedOf("person")], [...NOT_CHANGED]);
    // C383 QA S3-11: an agent's block has no line about a person
    assert.ok(notChangedOf("agent").every((t) => !/logins|person|handles|direct message/i.test(t)));
    assert.ok(notChangedOf("agent").some((t) => /machine/.test(t)) && notChangedOf("agent").some((t) => /Its key/.test(t)));
    assert.match(NOT_CHANGED[1] ?? "", /key/);
    assert.ok(notChangedOf("agent").every((t) => !/^Their agents\./.test(t) && !/this person may hold/.test(t)));
  });
  it("the Not changed block names the owner's limits", () => {
    assert.ok(NOT_CHANGED.some((t) => /own logins/.test(t)));
    assert.ok(NOT_CHANGED.some((t) => /machine/.test(t)));
    assert.ok(NOT_CHANGED.some((t) => /shared Portal login/.test(t)));
  });
});

describe("words before and after a person's change (C381)", () => {
  const STATES = ["confirmed", "not_confirmed", "not_installed", "older", "not_read"] as const;
  it("no approval in Portal bars a person: the words never ask for one, and never say that anything stopped", () => {
    for (const state of STATES) {
      const t = beforeChangeText({ state }, "person");
      assert.doesNotMatch(t, /approve/i, state);
      assert.doesNotMatch(t, /\bstopped\b/i, state);
    }
  });
  it("without Rules working, the sender bar in Connect is what still holds; with Rules, the refusal is by, for and to the person", () => {
    for (const state of ["not_installed", "older", "not_read"] as const) assert.match(beforeChangeText({ state }, "person"), /If they have handles in the directory, the sender bar in Connect drops their messages/);
    for (const state of ["confirmed", "not_confirmed"] as const) assert.match(beforeChangeText({ state }, "person"), /calls by, for and to this person are refused/);
  });
  it("an agent's words are the old ones by default", () => {
    assert.equal(beforeChangeText({ state: "confirmed" }), beforeChangeText({ state: "confirmed" }, "agent"));
    assert.match(beforeChangeText({ state: "not_installed" }), /the agent stops only when you approve in Portal/);
  });
  it("after a confirmed change the person's sentence says by, for and to; the agent's says calls stop", () => {
    const floor = { state: "confirmed", text: "Rules has this change.", version: "0.7.0", feedRevision: 2, entries: 1, lastGateAt: null, gateNote: null } as Parameters<typeof afterChangeText>[0];
    assert.match(afterChangeText(floor, "person"), /calls by, for and to this person are refused in about 2 minutes/);
    assert.match(afterChangeText(floor, "agent"), /calls stop in about 2 minutes/);
    assert.match(afterChangeText(floor), /calls stop in about 2 minutes/);
  });
});

describe("words after a change", () => {
  const floor = (over: Record<string, unknown>) => ({ state: "confirmed", text: "Rules has this change.", version: "0.7.0", feedRevision: 2, entries: 1, lastGateAt: null, gateNote: null, ...over }) as Parameters<typeof afterChangeText>[0];
  it("a confirmed change still says what Governance cannot see, and not that calls stopped", () => {
    const t = afterChangeText(floor({}));
    assert.match(t, /^Rules has this change\. If its hook is on/);
    assert.match(t, /cannot see that switch/);
    assert.doesNotMatch(t, /calls (have )?stopped/);
  });
  it("a change that is not confirmed gets no hook sentence", () => {
    assert.doesNotMatch(afterChangeText(floor({ state: "not_confirmed", text: "Not confirmed." })), /hook/);
  });
  it("the gate note reads as a time, never as a raw timestamp", () => {
    const t = afterChangeText(floor({ lastGateAt: "2026-10-29T08:00:00Z", gateNote: "Rules has not checked a call since 2026-10-29T08:00:00.000Z." }));
    assert.match(t, /since 29 Oct 2026, 08:00 UTC/);
    assert.doesNotMatch(t, /2026-10-29T/);
  });
});

describe("reasons", () => {
  it("a stop offers the list of §10 and no back reason", () => {
    assert.deepEqual(REASONS.suspended, ["left", "contract_ended", "role_changed", "security", "other"]);
    assert.ok(!REASONS.suspended.includes("mistake"));
  });
  it("an unknown stored reason reads as Other, not as a code", () => {
    assert.equal(reasonLabel("not_a_reason"), "Other");
    assert.equal(reasonLabel("migrated"), "Marked as departed before this version");
    assert.equal(reasonLabel("contract_ended"), "Contract ended");
  });
});

describe("refusals of lifecycle_set", () => {
  const fallback = () => "Something went wrong.";
  it("the stop cap names the count and hands it back for the confirm", () => {
    const e = { code: "stop_cap_reached", details: { count: 6 } };
    assert.equal(stopCapOf(e), 6);
    assert.match(lifecycleError(e, fallback).message, /^This makes 6 people and agents stopped in the last 10 minutes/);
    assert.match(lifecycleError(e, fallback).message, /This limit catches mistakes\. It does not stop a program that runs in this browser\.$/);
    assert.doesNotMatch(lifecycleError(e, fallback).message, /You stopped/, "the count holds explicit stops and verdicts, not only what this owner pressed");
  });
  it("a cap with no count (the old People form) shows the server's sentence and offers no number", () => {
    const e = { code: "stop_cap_reached", message: "5 were stopped in the last 10 minutes. Open this person's page to confirm this stop." };
    assert.equal(stopCapOf(e), null);
    assert.match(lifecycleError(e, fallback).message, /Open this person's page/);
  });
  it("another error is no cap and gets the shared wording", () => {
    assert.equal(stopCapOf({ code: "internal" }), null);
    assert.equal(lifecycleError({ code: "internal" }, fallback).message, "Something went wrong.");
  });
  it("the codes of the owner cascade are gone: they get the shared wording (C381)", () => {
    for (const code of ["owner_stopped", "use_transfer", "agent_stopped_itself"]) assert.equal(lifecycleError({ code, message: "old sentence" }, fallback).message, "Something went wrong.", code);
    assert.equal(lifecycleError({ code: "agents_undecided", message: "Name a new owner for these agents first, or stop them: Henry." }, fallback).message, "Name a new owner for these agents first, or stop them: Henry.");
  });
  it("a guard shows the server's sentence; an unknown code never shows its own text", () => {
    assert.equal(lifecycleError({ code: "lifecycle_stale", message: "This entry changed since you looked. Open it again." }, fallback).message, "This entry changed since you looked. Open it again.");
    assert.equal(lifecycleError({ code: "boom", message: "stack at x.ts" }, fallback).message, "Something went wrong.");
  });
});

describe("the subject link", () => {
  it("round trip", () => {
    const href = subjectHref("agent", "agt_1");
    assert.deepEqual(subjectFromUrl(href.slice(href.indexOf("?"))), { kind: "agent", id: "agt_1" });
  });
  it("refuses a bad kind or no id", () => {
    assert.equal(subjectFromUrl("?kind=team&id=x"), null);
    assert.equal(subjectFromUrl("?kind=agent"), null);
  });
});

describe("age (D10) and the theme (D8)", () => {
  const T = Date.parse("2026-10-31T12:00:00Z");
  it("reads the age of a read", () => {
    assert.equal(age("2026-10-31T11:59:40Z", T), "just now");
    assert.equal(age("2026-10-31T11:59:00Z", T), "1 minute ago");
    assert.equal(age("2026-10-31T11:15:00Z", T), "45 minutes ago");
    assert.equal(age("2026-10-31T10:00:00Z", T), "2 hours ago");
    assert.equal(age("2026-10-29T12:00:00Z", T), "2 days ago");
    assert.equal(age(null, T), "");
    assert.equal(age("not a date", T), "");
  });
  it("follows the system: dark sets data-theme, light clears it, a change is followed, paper is light", () => {
    const root = { dataset: {} as Record<string, string | undefined> };
    let change = () => {};
    const handlers: Record<string, () => void> = {};
    const media = { matches: true, addEventListener: (_: string, f: () => void) => { change = f; } };
    followSystemTheme(root, media as never, { addEventListener: (n: string, f: () => void) => { handlers[n] = f; } } as never);
    assert.equal(root.dataset.theme, "dark");
    handlers.beforeprint?.();
    assert.equal(root.dataset.theme, undefined);
    handlers.afterprint?.();
    assert.equal(root.dataset.theme, "dark");
    media.matches = false;
    change();
    assert.equal(root.dataset.theme, undefined);
    followSystemTheme(root, undefined);
    assert.equal(root.dataset.theme, undefined);
  });
});

describe("no id on the face of Contact rules (D9)", () => {
  it("takes the id out and keeps the sentence", () => {
    assert.equal(withoutIds("Hold the team Support (tm_01J00000000000000000T1) until I approve."), "Hold the team Support until I approve.");
    assert.equal(withoutIds("Hold every outward action of the agent Front desk (agt_01J0000000000000000000000A)."), "Hold every outward action of the agent Front desk.");
    assert.equal(withoutIds("Refuse for the sender slack:UBOT000001."), "Refuse for the sender slack:UBOT000001.");
  });
});

describe("Tab stays in the dialog (D12)", () => {
  it("wraps at both ends, comes back from outside, and leaves the middle to the browser", () => {
    const l = ["a", "b", "c"];
    assert.equal(nextInLoop(l, "c", false), "a");
    assert.equal(nextInLoop(l, "a", true), "c");
    assert.equal(nextInLoop(l, "b", false), null);
    assert.equal(nextInLoop(l, "b", true), null);
    assert.equal(nextInLoop(l, "outside", false), "a");
    assert.equal(nextInLoop(l, "outside", true), "c");
    assert.equal(nextInLoop(l, null, false), "a");
    assert.equal(nextInLoop([], "a", false), null);
  });
});

describe("when", () => {
  it("reads a time, and nothing for no time", () => {
    assert.equal(when("2026-10-30T15:50:00Z"), "30 Oct 2026, 15:50 UTC");
    assert.equal(when(null), "");
    assert.equal(when("not a date"), "");
  });
});
