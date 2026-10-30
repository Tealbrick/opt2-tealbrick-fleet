// The plain logic of the lifecycle pages (C380 B10), without a DOM: a page for an op that is not on stays off, what may be
// said before a change never claims a stop, and the refusals of `lifecycle_set` read as sentences.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { featuresOf } from "../src/ui/pages/features.ts";
import { lifecycleError, stopCapOf } from "../src/ui/pages/lifecycle-errors.ts";
import { subjectFromUrl, subjectHref } from "../src/ui/pages/subject-link.ts";
import { beforeChangeText, beforeChangeTone, floorTone, NOT_CHANGED, REASONS, reasonLabel, when } from "../src/ui/pages/words.ts";

describe("features come from the ops of this build", () => {
  it("on when every op is there", () => {
    assert.deepEqual(featuresOf(["summary_get", "colleagues_list", "colleague_get", "lifecycle_set", "plan_preview", "findings_list"]), { lifecycle: true, preview: true, differences: true });
  });
  it("off when one op is missing", () => {
    assert.equal(featuresOf(["summary_get", "colleagues_list", "colleague_get"]).lifecycle, false);
    assert.equal(featuresOf(["summary_get"]).preview, false);
    assert.equal(featuresOf(["summary_get"]).differences, false);
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
  it("the Not changed block names the owner's limits", () => {
    assert.ok(NOT_CHANGED.some((t) => /own logins/.test(t)));
    assert.ok(NOT_CHANGED.some((t) => /machine/.test(t)));
    assert.ok(NOT_CHANGED.some((t) => /shared Portal login/.test(t)));
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
    assert.deepEqual(subjectFromUrl(href.slice(href.indexOf("?"))), { kind: "agent", id: "agt_1", open: null });
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
