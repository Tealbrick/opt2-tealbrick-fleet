// The plain logic of the lifecycle pages (C380 B10), without a DOM: a page for an op that is not on stays off, what may be
// said before a change never claims a stop, and the refusals of `lifecycle_set` read as sentences.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NOT_CHANGED as SERVER_NOT_CHANGED } from "../src/plans/portal-link.ts";
import { canChoose, choiceSummary, choicesReady, decisionsOf, hasOwnStop } from "../src/ui/pages/agent-choice.ts";
import { featuresOf } from "../src/ui/pages/features.ts";
import { lifecycleError, stopCapOf } from "../src/ui/pages/lifecycle-errors.ts";
import { currentPlans, liveBanners, pollDelay } from "../src/ui/pages/plan-poll.ts";
import { subjectFromUrl, subjectHref } from "../src/ui/pages/subject-link.ts";
import { afterChangeText, beforeChangeText, beforeChangeTone, floorTone, NOT_CHANGED, REASONS, reasonLabel, when } from "../src/ui/pages/words.ts";

describe("features come from the ops of this build", () => {
  it("on when every op is there", () => {
    assert.deepEqual(featuresOf(["summary_get", "colleagues_list", "colleague_get", "lifecycle_set", "plan_preview", "findings_list"]), { lifecycle: true, preview: true, differences: true, plans: false });
  });
  it("off when one op is missing", () => {
    assert.equal(featuresOf(["summary_get", "colleagues_list", "colleague_get"]).lifecycle, false);
    assert.equal(featuresOf(["summary_get"]).preview, false);
    assert.equal(featuresOf(["summary_get"]).differences, false);
    assert.equal(featuresOf(["plan_send", "plan_get", "plan_retry"]).plans, false);
    assert.equal(featuresOf(["plan_send", "plan_get", "plan_retry", "plan_cancel"]).plans, true);
  });
});

describe("the choice for each agent (D2)", () => {
  const agents = [{ id: "a", lifecycle: "active" }, { id: "b", lifecycle: "active" }, { id: "c", lifecycle: "active" }, { id: "d", lifecycle: "active" }];
  const later = { choice: "later", reason: "", newOwner: "" } as const;
  it("the default is no choice: nothing goes to plan_send, so the agents are only paused", () => {
    assert.deepEqual(decisionsOf(agents, {}), []);
    assert.deepEqual(decisionsOf(agents, { a: later }), []);
    assert.equal(choicesReady(agents, {}), true);
    assert.equal(choiceSummary(agents, {}), "4 decided later, 0 stop and remove, 0 move to a new owner, 0 keep running");
  });
  it("sends only what was chosen, in the shape of the op", () => {
    assert.deepEqual(decisionsOf(agents, { a: { ...later, choice: "stop" }, b: { ...later, choice: "keep", reason: " on call " }, c: { ...later, choice: "transfer", newOwner: "per_2" } }), [
      { agent: "a", decision: "stop" },
      { agent: "b", decision: "keep", reason: "on call" },
      { agent: "c", decision: "transfer", newOwner: "per_2" },
    ]);
  });
  it("a keep needs a reason and a transfer a new owner", () => {
    assert.equal(choicesReady(agents, { a: { ...later, choice: "keep" } }), false);
    assert.equal(choicesReady(agents, { a: { ...later, choice: "keep", reason: "  " } }), false);
    assert.equal(choicesReady(agents, { a: { ...later, choice: "transfer" } }), false);
    assert.equal(choicesReady(agents, { a: { ...later, choice: "transfer", newOwner: "p" } }), true);
  });
  it("who can choose", () => {
    assert.equal(canChoose({ lifecycle: "leaving" }), false);
    assert.equal(canChoose({ lifecycle: "archived" }), false);
    assert.equal(canChoose({ lifecycle: "suspended" }), true);
    assert.equal(hasOwnStop({ lifecycle: "suspended" }), true);
    assert.equal(hasOwnStop({ lifecycle: "active" }), false);
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
    for (const state of ["not_installed", "older", "not_read"] as const) assert.match(beforeChangeText({ state }), /nothing (stops|may stop) until you approve in Portal/);
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
  it("the Not changed block names the owner's limits", () => {
    assert.ok(NOT_CHANGED.some((t) => /own logins/.test(t)));
    assert.ok(NOT_CHANGED.some((t) => /machine/.test(t)));
    assert.ok(NOT_CHANGED.some((t) => /shared Portal login/.test(t)));
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
    assert.match(lifecycleError(e, fallback).message, /You stopped 5 entries in the last 10 minutes/);
  });
  it("another error is no cap and gets the shared wording", () => {
    assert.equal(stopCapOf({ code: "internal" }), null);
    assert.equal(lifecycleError({ code: "internal" }, fallback).message, "Something went wrong.");
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

describe("when", () => {
  it("reads a time, and nothing for no time", () => {
    assert.equal(when("2026-10-30T15:50:00Z"), "30 Oct 2026, 15:50 UTC");
    assert.equal(when(null), "");
    assert.equal(when("not a date"), "");
  });
});
