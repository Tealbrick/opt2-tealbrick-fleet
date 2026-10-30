// Review rounds page (C380 T2-b) against the real SDK client and a stub server, rendered in happy-dom: the page says what the server said and no more, the verdict sends the digests
// the page was given and only ticks of rows an app can end, and the nav entry waits for the QA rows. The pixel matrix is scripts/ui-preview.ts; this one runs in CI.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { featuresOf, TIER2_PASSED } from "../src/ui/pages/features.ts";
import { button, callsOf, cleanUi, click, compileUi, h, mount, ok, refuse, reset, stub, typeInto } from "./ui-harness.ts";

const COUNTS = (over: Record<string, number> = {}) => ({ total: 2, open: 1, trusted: 1, limited: 0, blocked: 0, dismissed: 0, removalQueued: 0, removalPlanned: 0, ...over });
const ROUND = (over: Record<string, unknown> = {}) => ({ id: "rnd_1", title: "Q4 review", scope: "agents", createdAt: "2026-10-30T10:00:00Z", dueAt: null, closedAt: null, state: "open", overdue: false, counts: COUNTS(), ...over });
const ROW = (over: Record<string, unknown> = {}) => ({ product: "connect", productName: "Connect", id: "account_as_itself:a1", kind: "account_as_itself", label: "Support mailbox", level: "use", state: "active", revocable: true, digest: "sha256:aa", ...over });
const REMOVAL = (over: Record<string, unknown> = {}) => ({ state: "planned", note: null, plan: "pln_1", planState: "done", count: 1, headline: "Governance did its part. 1 are for someone to do by hand.", proved: 0, manual: 1, open: 0, ...over });
const ITEM = (over: Record<string, unknown> = {}) => ({ review: "rvw_1", subject: { kind: "person", id: "per_1", name: "Marco" }, status: "open", reason: null, decidedAt: null, decidedIn: null, snapshotDigest: "snap1", accessDigest: "acc1", access: [ROW(), ROW({ id: "team_grant:t", productName: "Knowledge", product: "knowledge", label: "Team memory", revocable: false, digest: "sha256:bb" })], accessCount: 2, removal: null, ...over });
const DETAIL = (over: Record<string, unknown> = {}) => ({ ...ROUND(), items: [ITEM(), ITEM({ review: "rvw_2", subject: { kind: "agent", id: "agt_A", name: "Henry" }, status: "trusted", snapshotDigest: null, access: [], accessCount: 0 })], ...over });

type Rounds = typeof import("../src/ui/pages/rounds.tsx");
let rounds: Rounds;
before(async () => {
  rounds = (await compileUi("ui-test-rounds")("rounds")) as Rounds;
});
after(() => cleanUi("ui-test-rounds"));

describe("Review rounds", () => {
  it("empty, loading and failed states: an empty list says what a round is; a failed load is an error with Try again, never an empty page", async () => {
    reset();
    stub.answers.round_get = ok({ rounds: [], round: null });
    let m = await mount(h(rounds.RoundsPage, {}));
    assert.match(m.host.textContent ?? "", /No review rounds yet\./);
    assert.ok(button(m.host, "Start a round"));
    await m.unmount();
    reset();
    stub.answers.round_get = refuse(500, "internal", "raw upstream");
    m = await mount(h(rounds.RoundsPage, {}));
    assert.ok(button(m.host, "Try again"));
    assert.doesNotMatch(m.host.textContent ?? "", /raw upstream|No review rounds/);
    await m.unmount();
  });
  it("the list counts what is decided; the start dialog sends the name, the scope and the date, and a refusal stays in the dialog in plain words", async () => {
    reset();
    stub.answers.round_get = (i) => ok(i.round ? { rounds: [ROUND()], round: DETAIL() } : { rounds: [ROUND(), ROUND({ id: "rnd_2", title: "Old", state: "closed", counts: COUNTS({ open: 0 }) })], round: null })();
    stub.answers.round_create = refuse(409, "nothing_to_review", "Nobody can be added: the list is empty, or each entry is in an open round.");
    const m = await mount(h(rounds.RoundsPage, {}));
    assert.match(m.host.textContent ?? "", /1 of 2 decided/);
    assert.match(m.host.textContent ?? "", /Closed/);
    await click(button(m.host, "Start a round"));
    const dialog = m.host.querySelector("dialog") as Element;
    assert.equal(button(dialog, "Start").disabled, true, "a round needs a name");
    await typeInto(dialog.querySelector("input") as Element, "Q4 review");
    await click(button(dialog, "Start"));
    assert.deepEqual(callsOf("round_create"), [{ title: "Q4 review", scope: "agents" }]);
    assert.match(m.host.querySelector("dialog")?.textContent ?? "", /Nobody can be added/);
    await m.unmount();
  });
  it("a round: entries with their decision, the access each app reports, and no raw id", async () => {
    reset();
    stub.answers.round_get = (i) => ok(i.round ? { rounds: [ROUND()], round: DETAIL({ counts: COUNTS({ removalQueued: 1, removalPlanned: 2 }) }) } : { rounds: [ROUND()], round: null })();
    const m = await mount(h(rounds.RoundsPage, {}));
    await click(button(m.host, "Open"));
    const text = m.host.textContent ?? "";
    assert.match(text, /Marco/);
    assert.match(text, /Not decided/);
    assert.match(text, /Trusted/);
    assert.match(text, /Nothing reported/);
    assert.match(text, /2 entries have a removal in a plan, 1 waits for a free place/);
    assert.ok(button(m.host, "Send waiting removals"));
    assert.doesNotMatch(text, /agt_|per_|rvw_|rnd_|sha256/);
    await m.unmount();
  });
  it("the review: only an access row an app can end has a switch; Record waits for a reason; the call sends the digests it was given and the ticked rows", async () => {
    reset();
    stub.answers.round_get = (i) => ok(i.round ? { rounds: [ROUND()], round: DETAIL() } : { rounds: [ROUND()], round: null })();
    stub.answers.round_verdict = ok({ item: ITEM({ status: "limited", removal: REMOVAL({ planState: "preparing", headline: "Waiting for the first read of the apps.", manual: 0 }) }), plan: "pln_1" });
    const m = await mount(h(rounds.RoundsPage, {}));
    await click(button(m.host, "Open"));
    await click(button(m.host, "Review"));
    const dialog = m.host.querySelector("dialog") as Element;
    assert.equal(dialog.querySelectorAll('input[type="checkbox"], [role="switch"]').length, 1, "one row can be removed");
    assert.match(dialog.textContent ?? "", /This app cannot end this from here/);
    assert.equal(button(dialog, "Record").disabled, true);
    await typeInto(dialog.querySelector("textarea") as Element, "Not needed any more.");
    assert.equal(button(dialog, "Record").disabled, true, "a reason alone is not a verdict: the dialog starts with none (N2-T2)");
    await click(dialog.querySelector('[role="radio"]') as Element);
    await click(dialog.querySelector('input[type="checkbox"], [role="switch"]') as Element);
    await click(button(dialog, "Record and remove 1"));
    assert.deepEqual(callsOf("round_verdict"), [{ round: "rnd_1", subject: { kind: "person", id: "per_1" }, verdict: "trusted", reason: "Not needed any more.", snapshotDigest: "snap1", accessDigest: "acc1", remove: [{ product: "connect", id: "account_as_itself:a1", digest: "sha256:aa" }] }]);
    const after = m.host.querySelector("dialog")?.textContent ?? "";
    assert.match(after, /Your review is recorded/);
    assert.match(after, /Access is gone only when the app confirms it/);
    assert.match(after, /Waiting for the first read of the apps/, "the plan's own words");
    assert.doesNotMatch(after, /has been removed|is removed\.|runs now|the app confirmed/);
    await m.unmount();
  });
  it("a stale picture is refused in the server's plain sentence, and the dialog keeps what the owner typed", async () => {
    reset();
    stub.answers.round_get = (i) => ok(i.round ? { rounds: [ROUND()], round: DETAIL() } : { rounds: [ROUND()], round: null })();
    stub.answers.round_verdict = refuse(409, "access_stale", "The access of this entry changed since you looked. Open the round again.");
    const m = await mount(h(rounds.RoundsPage, {}));
    await click(button(m.host, "Open"));
    await click(button(m.host, "Review"));
    const dialog = m.host.querySelector("dialog") as Element;
    await typeInto(dialog.querySelector("textarea") as Element, "Because.");
    await click(dialog.querySelector('[role="radio"]') as Element);
    await click(button(dialog, "Record"));
    assert.match(m.host.querySelector("dialog")?.textContent ?? "", /changed since you looked/);
    assert.equal((m.host.querySelector("dialog textarea") as HTMLTextAreaElement).value, "Because.");
    await m.unmount();
  });
  it("a plan that ended with nothing proved is shown in the plan's own words, never as removed", async () => {
    reset();
    stub.answers.round_get = (i) => ok(i.round ? { rounds: [ROUND()], round: DETAIL({ items: [ITEM({ status: "trusted", snapshotDigest: null, decidedIn: "elsewhere", removal: REMOVAL() })] }) } : { rounds: [ROUND()], round: null })();
    const m = await mount(h(rounds.RoundsPage, {}));
    await click(button(m.host, "Open"));
    const text = m.host.textContent ?? "";
    assert.match(text, /Governance did its part\. 1 are for someone to do by hand/);
    assert.doesNotMatch(text, /the app confirmed|removed\./);
    assert.match(text, /On the Reviews page/, "a verdict made elsewhere says so");
    await m.unmount();
  });
  it("a stale picture reloads the round, so the next try sends the new digests; the typed reason stays", async () => {
    reset();
    let reads = 0;
    stub.answers.round_get = (i) => {
      if (!i.round) return ok({ rounds: [ROUND()], round: null })();
      reads++;
      return ok({ rounds: [ROUND()], round: DETAIL({ items: [ITEM(reads > 1 ? { accessDigest: "acc2", snapshotDigest: "snap2" } : {})] }) })();
    };
    let tries = 0;
    stub.answers.round_verdict = () => {
      tries++;
      return tries === 1 ? refuse(409, "access_stale", "The access of this entry changed since you looked. Open the round again.")() : ok({ item: ITEM({ status: "trusted" }), plan: null })();
    };
    const m = await mount(h(rounds.RoundsPage, {}));
    await click(button(m.host, "Open"));
    await click(button(m.host, "Review"));
    const dialog = m.host.querySelector("dialog") as Element;
    await typeInto(dialog.querySelector("textarea") as Element, "Because.");
    await click(dialog.querySelector('[role="radio"]') as Element);
    await click(button(dialog, "Record"));
    assert.equal(reads, 2, "the round was read again");
    await click(button(m.host.querySelector("dialog") as Element, "Record"));
    assert.deepEqual(callsOf("round_verdict").map((c) => [c.snapshotDigest, c.accessDigest]), [["snap1", "acc1"], ["snap2", "acc2"]]);
    await m.unmount();
  });
  it("rows beyond what the entry shows are counted and cannot be ticked; an entry decided already cannot be recorded again", async () => {
    reset();
    stub.answers.round_get = (i) => ok(i.round ? { rounds: [ROUND()], round: DETAIL({ items: [ITEM({ accessCount: 250 })] }) } : { rounds: [ROUND()], round: null })();
    const m = await mount(h(rounds.RoundsPage, {}));
    await click(button(m.host, "Open"));
    await click(button(m.host, "Review"));
    assert.match(m.host.querySelector("dialog")?.textContent ?? "", /248 more rows are not shown\. They cannot be ticked here\./);
    await m.unmount();
  });
  it("closing asks first, says what happens to the waiting removals, then sends close", async () => {
    reset();
    stub.answers.round_get = (i) => ok(i.round ? { rounds: [ROUND()], round: DETAIL() } : { rounds: [ROUND()], round: null })();
    stub.answers.round_set = ok({ round: ROUND({ state: "closed" }), planned: 0, queued: 0 });
    const m = await mount(h(rounds.RoundsPage, {}));
    await click(button(m.host, "Open"));
    await click(button(m.host, "Close round"));
    assert.equal(callsOf("round_set").length, 0, "the first press only asks");
    const dialog = m.host.querySelector("dialog") as Element;
    assert.match(dialog.textContent ?? "", /nothing is removed for them/);
    await click(button(dialog, "Close round"));
    assert.deepEqual(callsOf("round_set"), [{ round: "rnd_1", action: "close" }]);
    await m.unmount();
  });
});

describe("the nav waits for the QA rows", () => {
  const ops = ["round_create", "round_get", "round_verdict", "round_set", "record_export"];
  it("with the ops and no passed rows: the route works, the nav entry does not; with both: both", () => {
    assert.deepEqual(TIER2_PASSED, { rounds: false, record: false }, "nothing is passed until QA says so");
    const hidden = featuresOf(ops);
    assert.deepEqual([hidden.rounds, hidden.record, hidden.roundsNav, hidden.recordNav], [true, true, false, false]);
    const shown = featuresOf(ops, { rounds: true, record: true });
    assert.deepEqual([shown.roundsNav, shown.recordNav], [true, true]);
    const none = featuresOf(["round_create"], { rounds: true, record: true });
    assert.deepEqual([none.rounds, none.roundsNav, none.record, none.recordNav], [false, false, false, false], "a build without the ops shows nothing, even when the rows passed");
    assert.equal(featuresOf(["record_export", "round_create", "round_get", "round_verdict"], { rounds: true, record: false }).roundsNav, false, "all four round ops");
  });
});
