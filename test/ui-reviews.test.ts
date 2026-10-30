// The Trust reviews page (src/ui/reviews.tsx) against the real SDK client and a stub server, rendered in happy-dom:
// the lists, the 4-step review (StepFlow, C126), the exact input of review_record, plain messages for failures
// (L18, no raw upstream text), RUL-14 (a failed load is an error, not an empty state), agent text shown as text.
// The module is compiled with the build tsconfig into dist/ui-test-reviews (JSX needs a compile).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

type Reviews = typeof import("../src/ui/reviews.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-reviews");

// ── DOM ────────────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/a/fleet/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

// ── stub server (the ops of the page under /a/fleet/tb/v1/) ──────────────────
const AGENT = "agt_01J0000000000000000000000A";
const SCOUT = "agt_01J0000000000000000000000B";
const DIGEST = "ab".repeat(32);
const DIGEST2 = "cd".repeat(32);
const snap = (digest: string, over: Record<string, unknown> = {}) => ({
  digest,
  takenAt: "2026-10-20T09:00:00.000Z",
  name: "Brightline intake",
  kind: "outside_agent",
  title: "",
  status: "active",
  trust: "unreviewed",
  handles: ["slack:UBRIGHT01"],
  owner: null,
  ownerName: null,
  access: [],
  policy: null,
  contacts: 0,
  teams: ["Support"],
  source: "directory_only",
  ...over,
});
const review = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  subject: { kind: "outside_agent", id: "psn_bright", name: "Brightline intake" },
  subjectHandle: null,
  status: "requested",
  verdict: null,
  reason: "",
  requestedBy: { kind: "agent", id: SCOUT, why: "It wrote to me on Buzz. <b>Is it real?</b>" },
  reviewer: null,
  snapshot: null,
  createdAt: "2026-10-14T09:12:00.000Z",
  decidedAt: null,
  nextDueAt: null,
  proposal: null,
  ...over,
});
const DIR = {
  revision: 3,
  teams: [],
  people: [
    { id: "psn_bright", name: "Brightline intake", kind: "outside_agent", trust: "unreviewed", email: null, title: "", status: "active", tags: [], handles: ["slack:UBRIGHT01"], teams: [], updatedAt: "2026-10-14T09:12:00.000Z" },
    { id: "psn_ann", name: "Ann", kind: "person", trust: "trusted", email: null, title: "", status: "active", tags: [], handles: [], teams: [], updatedAt: "2026-10-14T09:12:00.000Z" },
  ],
  agents: [
    { id: AGENT, name: "Front desk", trust: "trusted", mode: "free", status: "active", owner: null, role: "", tags: [], teams: [], updatedAt: "2026-10-14T09:12:00.000Z" },
    { id: SCOUT, name: "Scout", trust: "trusted", mode: "free", status: "active", owner: { id: "psn_ann", name: "Ann" }, role: "", tags: [], teams: [], updatedAt: "2026-10-14T09:12:00.000Z" },
  ],
};
const POLICY = { agentDays: 90, contactDays: 180, reviewNewAgents: true, reviewChangedAccess: false };
const LIST = () => ({
  reviews: [
    review("rvw_open1"),
    review("rvw_done1", { status: "done", verdict: "blocked", reason: "Unasked sales messages.", subject: { kind: "outside_agent", id: "psn_promo", name: "PromoBot" }, decidedAt: "2026-10-01T10:00:00.000Z", reviewer: "per_1", snapshot: snap(DIGEST) }),
  ],
  due: [{ subject: { kind: "agent", id: AGENT, name: "Front desk" }, dueAt: "2026-10-12T00:00:00.000Z", lastReview: "rvw_old", lastVerdict: "trusted" }],
  dueCount: 1,
  openCount: 1,
  policy: POLICY,
  nextCursor: null,
});

interface Stub {
  calls: { op: string; input: any }[];
  fail: Record<string, { status: number; code: string } | undefined>;
  list: ReturnType<typeof LIST>;
  /** the picture review_get answers (the subject "now") */
  current: ReturnType<typeof snap>;
  networkDown: boolean;
  /** what proposal_send answers (the proposal in the shape of the manifest) */
  proposal: (input: any) => any;
}
const sentProposal = (input: any) => ({
  proposal: { id: "prp_1", template: input.template, params: input.params, text: "Hold every outward action of the agent Front desk.", review: input.review ?? null, rulesDraftId: "drf_1", status: "sent", error: null, rulesStatus: "pending", decidedAt: null, createdAt: "2026-10-20T09:00:00.000Z" },
  duplicate: false,
});
const failedProposal = (code: string) => (input: any) => ({ proposal: { ...sentProposal(input).proposal, rulesDraftId: null, status: "failed", error: code, rulesStatus: null }, duplicate: false });
const stub: Stub = { calls: [], fail: {}, list: LIST(), current: snap(DIGEST), networkDown: false, proposal: sentProposal };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (stub.networkDown) throw new TypeError("fetch failed");
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/fleet/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["review_record"] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: any; idempotencyKey?: string };
  stub.calls.push({ op, input: body.input });
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  if (op === "reviews_list") {
    const want = body.input?.status;
    const reviews = stub.list.reviews.filter((r) => (want === "open" ? r.status === "requested" : want === "done" ? r.status === "done" : true));
    return json(200, { status: "ok", output: { ...stub.list, reviews } });
  }
  if (op === "overview_get") return json(200, { status: "ok", output: DIR });
  if (op === "proposal_send") return json(200, { status: "ok", output: stub.proposal(body.input) });
  if (op === "review_get") return json(200, { status: "ok", output: { review: null, current: stub.current } });
  if (op === "review_record") return json(200, { status: "ok", output: { review: review("rvw_new", { status: "done", verdict: body.input.verdict }) } });
  if (op === "review_dismiss") {
    stub.list = { ...stub.list, reviews: stub.list.reviews.filter((r) => r.id !== body.input.id), openCount: 0 };
    return json(200, { status: "ok", output: { review: review(body.input.id, { status: "dismissed" }) } });
  }
  if (op === "review_policy_set") {
    stub.list = { ...stub.list, policy: { ...POLICY, ...body.input } };
    return json(200, { status: "ok", output: { policy: stub.list.policy } });
  }
  return json(404, { error: { code: "not_found", message: op } });
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "fleet" }, el)));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
/** A StepFlow step change fades with a timer: wait until it is done, then the new step is the current one. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 450)));
/** Clicks a step button (Next, Skip, Previous) and waits for the step change. */
const move = async (root: ParentNode, text: string) => {
  await click(button(root, text));
  await settle();
};
const button = (root: ParentNode, text: string, n = 0) => {
  const found = [...root.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text)[n];
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
const rows = (host: Element) => [...host.querySelectorAll(".item")];
const alerts = (host: ParentNode) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
const dialog = () => document.querySelector("dialog") as HTMLDialogElement;
/** Types into a controlled React input/textarea. */
async function type(el: Element, value: string) {
  await act(async () => {
    const proto = el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    assert.ok(set, "the value setter");
    set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    el.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
  });
}

let ui: Reviews;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  ui = (await import(pathToFileURL(join(outDir, "ui", "reviews.js")).href)) as Reviews;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const reset = () => {
  stub.calls = [];
  stub.fail = {};
  stub.list = LIST();
  stub.current = snap(DIGEST);
  stub.networkDown = false;
  stub.proposal = sentProposal;
  for (const d of document.querySelectorAll("dialog")) d.remove();
};

/** Walks the four steps of a review for the open request and returns the last button state. */
async function fillVerdict(verdict: "Trusted" | "Limited" | "Blocked", why: string) {
  const d = dialog();
  await move(d, "Next"); // 1 → 2
  const choice = [...d.querySelectorAll('[role="radio"]')].find((c) => c.textContent?.startsWith(verdict));
  assert.ok(choice, `choice ${verdict}`);
  await click(choice as Element);
  await type(d.querySelector("textarea") as Element, why);
}

describe("Trust reviews page", () => {
  it("lists the open request, what is due, the history, and the schedule", async () => {
    reset();
    const m = await mount(h(ui.ReviewsPage, {}));
    assert.equal(m.host.querySelector("h1")?.textContent, "Reviews");
    const [open, due] = rows(m.host);
    assert.equal(open?.querySelector("h3")?.textContent?.startsWith("Brightline intake"), true);
    assert.match(open?.textContent ?? "", /Unreviewed/);
    assert.match(open?.textContent ?? "", /agent Scout asks: “It wrote to me on Buzz\./);
    assert.match(open?.textContent ?? "", /Outside agent · asked by agent Scout · 14 Oct 2026/);
    assert.equal(rows(m.host).length, 2);
    assert.ok(button(open as Element, "Review").className.includes("primary"));
    assert.ok(!button(open as Element, "Dismiss").className.includes("primary"));
    assert.match(due?.querySelector("h3")?.textContent ?? "", /Front desk.*Due.*Trusted/);
    assert.match(due?.textContent ?? "", /Last review: Trusted\. It was due on 12 Oct 2026\./);
    assert.match(due?.textContent ?? "", /Agent · every 90 days/);
    assert.equal(due?.querySelector("button")?.textContent, "Review");
    const history = m.host.querySelector('[aria-label="History"]');
    assert.match(history?.textContent ?? "", /1 Oct 2026PromoBotBlockedUnasked sales messages\./);
    const sched = m.host.querySelector('[aria-label="Review schedule"]');
    assert.match(sched?.textContent ?? "", /Every 90 days/);
    assert.match(sched?.textContent ?? "", /Every 180 days/);
    assert.deepEqual(alerts(m.host), []);
    assert.equal(ui.reviewBadge(stub.list as never), 2, "the tab badge counts open + due");
    await m.unmount();
  });

  it("agent text is shown as text, never as markup", async () => {
    reset();
    const m = await mount(h(ui.ReviewsPage, {}));
    assert.equal(m.host.querySelector(".item b"), null, "the <b> of the agent's text is not an element");
    assert.match(rows(m.host)[0]?.textContent ?? "", /<b>Is it real\?<\/b>/);
    await m.unmount();
  });

  it("RUL-14: a failed load is an error with Try again, not an empty state", async () => {
    reset();
    stub.fail.reviews_list = { status: 500, code: "internal_error" };
    const m = await mount(h(ui.ReviewsPage, {}));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.equal(m.host.querySelector(".tb-empty"), null);
    stub.fail.reviews_list = undefined;
    await click(button(m.host, "Try again"));
    assert.equal(rows(m.host).length, 2);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("an empty list says so; the history says no verdicts yet", async () => {
    reset();
    stub.list = { ...stub.list, reviews: [], due: [], dueCount: 0, openCount: 0 };
    const m = await mount(h(ui.ReviewsPage, {}));
    assert.equal(m.host.querySelector(".tb-empty h3")?.textContent, "Nothing waits for a review.");
    assert.match(m.host.textContent ?? "", /No verdicts yet\./);
    assert.equal(ui.reviewBadge(stub.list as never), null);
    await m.unmount();
  });

  it("Dismiss sends review_dismiss and reloads; a failure is a plain message", async () => {
    reset();
    const m = await mount(h(ui.ReviewsPage, {}));
    stub.fail.review_dismiss = { status: 409, code: "review_not_open" };
    await click(button(rows(m.host)[0] as Element, "Dismiss"));
    assert.match(alerts(m.host)[0] ?? "", /already closed/);
    assert.doesNotMatch(alerts(m.host)[0] ?? "", /raw upstream/);
    stub.fail.review_dismiss = undefined;
    await click(button(rows(m.host)[0] as Element, "Dismiss"));
    assert.deepEqual(stub.calls.filter((c) => c.op === "review_dismiss").map((c) => c.input), [{ id: "rvw_open1" }, { id: "rvw_open1" }]);
    assert.ok(!rows(m.host).some((r) => r.querySelector("h3")?.textContent?.startsWith("Brightline")), "the dismissed request is gone");
    await m.unmount();
  });

  it("the review: 4 steps; Next waits for a verdict and a reason; review_record gets the exact input", async () => {
    reset();
    const m = await mount(h(ui.ReviewsPage, {}));
    await click(button(rows(m.host)[0] as Element, "Review"));
    const d = dialog();
    assert.ok(d, "the StepFlow dialog is open");
    assert.deepEqual([...d.querySelectorAll("ol li")].map((li) => li.textContent?.trim()), ["1-Subject", "2-Verdict", "3-Contact rule", "4-Confirm"]);
    const reviewGet = stub.calls.find((c) => c.op === "review_get");
    assert.deepEqual(reviewGet?.input, { subject: { kind: "outside_agent", id: "psn_bright" } });
    assert.match(d.textContent ?? "", /Brightline intake/);
    assert.match(d.textContent ?? "", /slack:UBRIGHT01/);
    assert.match(d.textContent ?? "", /TeamsSupport/);
    assert.match(d.textContent ?? "", /Asked by agent Scout on 14 Oct 2026: “It wrote to me on Buzz\./);
    assert.match(d.textContent ?? "", /This is the asker’s claim, not a fact\./);
    assert.match(d.textContent ?? "", /abab…ab · 20 Oct 2026/);
    // step 2: Next is off until a verdict AND a reason
    await move(d, "Next");
    assert.ok(button(d, "Next").disabled, "no verdict yet");
    const limited = [...d.querySelectorAll('[role="radio"]')].find((c) => c.textContent?.startsWith("Limited")) as Element;
    await click(limited);
    assert.ok(button(d, "Next").disabled, "no reason yet");
    await type(d.querySelector("textarea") as Element, "  Booking bot of the partner clinic.  ");
    assert.ok(!button(d, "Next").disabled);
    await move(d, "Next"); // → 3
    assert.match(d.textContent ?? "", /Nothing applies yet\. This only sends a draft to Rules & Approvals/);
    assert.match(d.textContent ?? "", /Hold what agents do for this sender/, "an outside agent with a handle gets the sender templates");
    assert.doesNotMatch(d.textContent ?? "", /Hold its outward actions/, "not the agent templates");
    await move(d, "Skip, no rule"); // → 4
    assert.match(d.textContent ?? "", /Booking bot of the partner clinic\./);
    assert.match(d.textContent ?? "", /In 180 days/);
    assert.equal(stub.calls.filter((c) => c.op === "review_record").length, 0, "nothing is recorded before the last step");
    await click(button(d, "Record verdict"));
    const rec = stub.calls.filter((c) => c.op === "review_record");
    assert.equal(rec.length, 1);
    assert.deepEqual(rec[0]?.input, {
      subject: { kind: "outside_agent", id: "psn_bright" },
      verdict: "limited",
      reason: "Booking bot of the partner clinic.",
      snapshotDigest: DIGEST,
      nextReviewDays: 180,
      request: "rvw_open1",
    });
    assert.equal(document.querySelector("dialog[open]"), null, "the flow closes after the record");
    assert.ok(stub.calls.filter((c) => c.op === "reviews_list").length >= 2, "the list reloads");
    await m.unmount();
  });

  it("snapshot_stale: a plain message, the flow stays open, nothing else is sent (fires on bad)", async () => {
    reset();
    const m = await mount(h(ui.ReviewsPage, {}));
    await click(button(rows(m.host)[0] as Element, "Review"));
    await fillVerdict("Blocked", "Spam.");
    await move(dialog(), "Next");
    await move(dialog(), "Skip, no rule");
    stub.fail.review_record = { status: 409, code: "snapshot_stale" };
    await click(button(dialog(), "Record verdict"));
    const [message] = alerts(dialog());
    assert.match(message ?? "", /changed after you looked/);
    assert.doesNotMatch(message ?? "", /raw upstream/);
    assert.ok(dialog().hasAttribute("open"), "still open");
    // quiet: with the failure gone, the same Record goes through
    stub.fail.review_record = undefined;
    await click(button(dialog(), "Record verdict"));
    assert.equal(stub.calls.filter((c) => c.op === "review_record").length, 2);
    assert.equal(document.querySelector("dialog[open]"), null);
    await m.unmount();
  });

  it("a due subject starts the review without a request; Review someone lets the owner pick", async () => {
    reset();
    const m = await mount(h(ui.ReviewsPage, {}));
    await click(button(rows(m.host)[1] as Element, "Review"));
    assert.deepEqual(stub.calls.find((c) => c.op === "review_get")?.input, { subject: { kind: "agent", id: AGENT } });
    await fillVerdict("Trusted", "Access matches its job.");
    await move(dialog(), "Next");
    await move(dialog(), "Skip, no rule");
    await click(button(dialog(), "Record verdict"));
    const rec = stub.calls.find((c) => c.op === "review_record")?.input;
    assert.equal("request" in rec, false, "no request id for a due review");
    assert.equal(rec.nextReviewDays, 90, "the agent schedule is the default");
    // pick by hand
    reset();
    await click(button(m.host, "Review someone"));
    assert.ok(button(dialog(), "Next").disabled, "no subject chosen yet");
    assert.equal(stub.calls.filter((c) => c.op === "review_get").length, 0);
    await m.unmount();
  });

  it("the load of the subject fails: a plain message in the step, Next stays off", async () => {
    reset();
    stub.fail.review_get = { status: 404, code: "subject_not_found" };
    const m = await mount(h(ui.ReviewsPage, {}));
    await click(button(rows(m.host)[0] as Element, "Review"));
    assert.match(alerts(dialog())[0] ?? "", /This entry is gone/);
    assert.ok(button(dialog(), "Next").disabled);
    await m.unmount();
  });

  it("Change schedule sends review_policy_set with numbers and shows the new schedule", async () => {
    reset();
    const m = await mount(h(ui.ReviewsPage, {}));
    await click(button(m.host, "Change schedule"));
    const d = dialog();
    const [agentDays] = [...d.querySelectorAll("input")];
    await type(agentDays as Element, "30");
    await click(button(d, "Save"));
    assert.deepEqual(stub.calls.find((c) => c.op === "review_policy_set")?.input, { agentDays: 30, contactDays: 180, reviewNewAgents: true });
    assert.match(m.host.querySelector('[aria-label="Review schedule"]')?.textContent ?? "", /Every 30 days/);
    await m.unmount();
  });
});

describe("Trust reviews: fresh picture, grouped requests, handles not in the directory", () => {
  it("the review shows the picture from the fresh review_get, not the one the page loaded; the verdict binds its digest", async () => {
    reset();
    stub.current = snap(DIGEST2, { name: "Brightline Clinic intake", title: "Intake bot", handles: ["slack:UBRIGHT01", "slack:UBRIGHT02"], teams: ["Ops"], trust: "limited" });
    const m = await mount(h(ui.ReviewsPage, {}));
    assert.match(rows(m.host)[0]?.querySelector("h3")?.textContent ?? "", /^Brightline intake/, "the page loaded the old name");
    await click(button(rows(m.host)[0] as Element, "Review"));
    const d = dialog();
    assert.match(d.textContent ?? "", /NameBrightline Clinic intake/);
    assert.match(d.textContent ?? "", /TitleIntake bot/);
    assert.match(d.textContent ?? "", /slack:UBRIGHT01 · slack:UBRIGHT02/);
    assert.match(d.textContent ?? "", /TeamsOps/);
    assert.match(d.textContent ?? "", /Review Brightline Clinic intake/);
    await fillVerdict("Blocked", "Not the clinic.");
    await move(d, "Next");
    await move(d, "Skip, no rule");
    await click(button(d, "Record verdict"));
    assert.equal(stub.calls.find((c) => c.op === "review_record")?.input.snapshotDigest, DIGEST2, "the digest of the fresh picture, not of the page load");
    await m.unmount();
  });

  it("requests of several agents about one subject are one row; Dismiss closes each of them", async () => {
    reset();
    stub.list = { ...stub.list, reviews: [review("rvw_a1"), review("rvw_a2", { requestedBy: { kind: "agent", id: AGENT, why: "It spams me." }, createdAt: "2026-10-15T08:00:00.000Z" })], openCount: 2 };
    const m = await mount(h(ui.ReviewsPage, {}));
    const [row] = rows(m.host);
    assert.equal(rows(m.host).length, 2, "one row for the subject, one for the due agent");
    assert.match(row?.textContent ?? "", /agent Scout asks: “It wrote to me on Buzz/);
    assert.match(row?.textContent ?? "", /agent Front desk asks: “It spams me\.”/);
    assert.match(row?.textContent ?? "", /asked by agent Scout, agent Front desk · 15 Oct 2026/);
    await click(button(row as Element, "Review"));
    assert.equal(dialog().textContent?.match(/This is the asker’s claim, not a fact\./g)?.length, 2, "each asker's claim is shown as a claim");
    await m.unmount();
    reset();
    stub.list = { ...stub.list, reviews: [review("rvw_a1"), review("rvw_a2", { requestedBy: { kind: "agent", id: AGENT, why: "It spams me." } })], openCount: 2 };
    const m2 = await mount(h(ui.ReviewsPage, {}));
    await click(button(rows(m2.host)[0] as Element, "Dismiss"));
    assert.deepEqual(stub.calls.filter((c) => c.op === "review_dismiss").map((c) => c.input), [{ id: "rvw_a1" }, { id: "rvw_a2" }]);
    await m2.unmount();
  });

  it("a handle that is not in the directory: the owner sees the handle, names the entry and adds it with the verdict", async () => {
    reset();
    stub.list = { ...stub.list, reviews: [review("rvw_p1", { subject: { kind: "person", id: "", name: "slack:UNEW00001" }, subjectHandle: "slack:UNEW00001" })] };
    stub.current = snap(DIGEST2, { status: "pending", name: "slack:UNEW00001", kind: "person", handles: ["slack:UNEW00001"], teams: [], trust: "unreviewed" });
    const m = await mount(h(ui.ReviewsPage, {}));
    const row = rows(m.host)[0] as Element;
    assert.match(row.querySelector("h3")?.textContent ?? "", /Not in the directory/);
    assert.match(row.textContent ?? "", /Person · slack:UNEW00001 · asked by agent Scout/);
    await click(button(row, "Review"));
    assert.deepEqual(stub.calls.find((c) => c.op === "review_get")?.input, { subject: { kind: "person", handle: "slack:UNEW00001" } });
    const d = dialog();
    assert.match(d.textContent ?? "", /This handle is not in your directory/);
    assert.match(d.textContent ?? "", /Trust nowNot in the directory/);
    await type(d.querySelector("input") as Element, "  Partner clinic bot ");
    await fillVerdict("Limited", "Confirmed by phone.");
    await move(d, "Next");
    await move(d, "Skip, no rule");
    assert.match(d.textContent ?? "", /Add to the directory as/);
    assert.match(d.textContent ?? "", /Partner clinic bot/);
    await click(button(d, "Add and record verdict"));
    assert.deepEqual(stub.calls.find((c) => c.op === "review_record")?.input, {
      subject: { kind: "person", handle: "slack:UNEW00001", name: "Partner clinic bot" },
      verdict: "limited",
      reason: "Confirmed by phone.",
      snapshotDigest: DIGEST2,
      nextReviewDays: 180,
      request: "rvw_p1",
    });
    await m.unmount();
  });
});

describe("Trust reviews: step 3, the contact rule", () => {
  /** Opens the review of the due agent and goes to step 3 with a verdict. */
  async function toRuleStep(m: { host: Element }, row = 1) {
    await click(button(rows(m.host)[row] as Element, "Review"));
    await fillVerdict("Limited", "Checked.");
    await move(dialog(), "Next"); // → 3
    return dialog();
  }
  const ruleChoice = (d: Element, title: string) => [...d.querySelectorAll('[role="radio"]')].find((c) => c.textContent?.startsWith(title)) as Element;

  it("an agent is offered the outward templates, a rule is optional, and nothing is sent before Confirm", async () => {
    reset();
    stub.current = snap(DIGEST, { kind: "agent", name: "Front desk", handles: [], teams: [] });
    const m = await mount(h(ui.ReviewsPage, {}));
    const d = await toRuleStep(m);
    const radios = [...d.querySelectorAll('[role="radio"]')].map((c) => c.textContent ?? "");
    assert.ok(radios.some((t) => t.startsWith("No rule")));
    assert.ok(radios.some((t) => t.startsWith("Hold its outward actions")));
    assert.ok(radios.some((t) => t.startsWith("Refuse its outward actions")));
    assert.equal(ruleChoice(d, "Hold what agents do"), undefined, "no sender templates for an agent");
    assert.match(d.textContent ?? "", /Nothing applies yet\. This only sends a draft to Rules & Approvals\. You approve or reject it there, under Drafts\./);
    assert.ok(button(d, "Skip, no rule"), "Skip is there while no rule is chosen");
    await click(ruleChoice(d, "Hold its outward actions"));
    assert.equal(button(d, "Skip").hidden, true, "a chosen rule cannot be skipped by accident; choose No rule to drop it");
    assert.equal(stub.calls.filter((c) => c.op === "proposal_send").length, 0, "choosing sends nothing");
    await move(d, "Next"); // → 4
    assert.match(d.textContent ?? "", /Contact ruleHold its outward actions/);
    assert.equal(stub.calls.filter((c) => c.op === "proposal_send").length, 0, "still nothing before the last button");
    await m.unmount();
  });

  it("Confirm records the verdict, then sends the rule linked to the recorded review: exact inputs, in this order", async () => {
    reset();
    stub.current = snap(DIGEST, { kind: "agent", name: "Front desk", handles: [], teams: [] });
    const m = await mount(h(ui.ReviewsPage, {}));
    const d = await toRuleStep(m);
    await click(ruleChoice(d, "Refuse its outward actions"));
    await move(d, "Next");
    await click(button(d, "Record verdict and send rule"));
    const sent = stub.calls.filter((c) => c.op === "review_record" || c.op === "proposal_send");
    assert.deepEqual(sent.map((c) => c.op), ["review_record", "proposal_send"]);
    assert.deepEqual(sent[1]?.input, { template: "deny_outward_for_agent", params: { agent: AGENT }, review: "rvw_new" });
    assert.equal(document.querySelector("dialog[open]"), null, "closed after both succeeded");
    await m.unmount();
  });

  it("no rule chosen: the verdict is recorded and Rules is not called (quiet on good)", async () => {
    reset();
    stub.current = snap(DIGEST, { kind: "agent", name: "Front desk", handles: [], teams: [] });
    const m = await mount(h(ui.ReviewsPage, {}));
    const d = await toRuleStep(m);
    await move(d, "Skip, no rule");
    await click(button(d, "Record verdict"));
    assert.equal(stub.calls.filter((c) => c.op === "proposal_send").length, 0);
    assert.equal(stub.calls.filter((c) => c.op === "review_record").length, 1);
    await m.unmount();
  });

  it("Rules refuses: the verdict stays recorded, a plain message says the rule was not sent, and Send again does NOT record twice", async () => {
    reset();
    stub.current = snap(DIGEST, { kind: "agent", name: "Front desk", handles: [], teams: [] });
    stub.proposal = failedProposal("too_many_drafts");
    const m = await mount(h(ui.ReviewsPage, {}));
    const d = await toRuleStep(m);
    await click(ruleChoice(d, "Hold its outward actions"));
    await move(d, "Next");
    await click(button(d, "Record verdict and send rule"));
    const [message] = alerts(d);
    assert.match(message ?? "", /^Your verdict is recorded\. The rule was not sent\. Rules already has too many drafts waiting\./);
    assert.doesNotMatch(message ?? "", /too_many_drafts|raw upstream/);
    assert.ok(dialog().hasAttribute("open"), "stays open");
    stub.proposal = sentProposal;
    await click(button(d, "Send the rule again"));
    assert.equal(stub.calls.filter((c) => c.op === "review_record").length, 1, "the verdict is recorded once");
    assert.equal(stub.calls.filter((c) => c.op === "proposal_send").length, 2);
    assert.equal(document.querySelector("dialog[open]"), null);
    await m.unmount();
  });

  it("a transport failure of proposal_send is a plain message too, never a false 'sent'", async () => {
    reset();
    stub.current = snap(DIGEST, { kind: "agent", name: "Front desk", handles: [], teams: [] });
    const m = await mount(h(ui.ReviewsPage, {}));
    const d = await toRuleStep(m);
    await click(ruleChoice(d, "Hold its outward actions"));
    await move(d, "Next");
    stub.fail.proposal_send = { status: 500, code: "internal_error" };
    await click(button(d, "Record verdict and send rule"));
    assert.match(alerts(d)[0] ?? "", /^Your verdict is recorded\. The rule was not sent\. Something went wrong/);
    assert.ok(dialog().hasAttribute("open"));
    await m.unmount();
  });

  it("a person or outside agent gets the sender templates with its handle; with two handles the owner picks one", async () => {
    reset();
    const m = await mount(h(ui.ReviewsPage, {}));
    stub.current = snap(DIGEST, { handles: ["slack:UBRIGHT01", "slack:UBRIGHT02"] });
    await click(button(rows(m.host)[0] as Element, "Review"));
    await fillVerdict("Blocked", "Spam.");
    const d = dialog();
    await move(d, "Next");
    await click(ruleChoice(d, "Refuse what agents do for this sender"));
    assert.ok(d.querySelector("select, [role='combobox']"), "a handle picker");
    await move(d, "Next");
    assert.match(d.textContent ?? "", /Contact ruleRefuse what agents do for this sender \(slack:UBRIGHT01\)/);
    await click(button(d, "Record verdict and send rule"));
    assert.deepEqual(stub.calls.find((c) => c.op === "proposal_send")?.input, { template: "deny_on_behalf_of_sender", params: { handle: "slack:UBRIGHT01" }, review: "rvw_new" });
    await m.unmount();
  });

  it("a contact without a handle gets no rule choices, only the reason", async () => {
    reset();
    stub.current = snap(DIGEST, { handles: [] });
    const m = await mount(h(ui.ReviewsPage, {}));
    await click(button(rows(m.host)[0] as Element, "Review"));
    await fillVerdict("Trusted", "Known.");
    const d = dialog();
    await move(d, "Next");
    assert.match(d.textContent ?? "", /has no channel handle, so a rule cannot name it/);
    assert.equal(ruleChoice(d, "Hold what agents do"), undefined);
    await m.unmount();
  });

  /** Picks who to review in step 1 (the flow was opened with "Review someone"). */
  async function pickWho(d: Element, label: string) {
    await click(d.querySelector('[role="combobox"]') as Element);
    const option = [...d.querySelectorAll('[role="option"]')].find((o) => o.textContent === label);
    assert.ok(option, `who "${label}"`);
    await click(option);
  }

  it("S3-1: the owner picks an agent, chooses an agent template, goes back and picks a person: the template is gone and the person gets only its own templates (fire on bad)", async () => {
    reset();
    const m = await mount(h(ui.ReviewsPage, {}));
    await click(button(m.host, "Review someone"));
    const d = dialog();
    stub.current = snap(DIGEST, { kind: "agent", name: "Front desk", handles: [], teams: [] });
    await pickWho(d, "Front desk (agent)");
    await fillVerdict("Limited", "Checked.");
    await move(d, "Next"); // → 3
    await click(ruleChoice(d, "Hold its outward actions"));
    await move(d, "Previous"); // → 2
    await move(d, "Previous"); // → 1
    stub.current = snap(DIGEST2, { kind: "outside_agent", name: "Brightline intake", handles: ["slack:UBRIGHT01"], teams: [] });
    await pickWho(d, "Brightline intake (outside agent)");
    await move(d, "Next"); // → 2 (the verdict stays)
    await move(d, "Next"); // → 3
    assert.equal(ruleChoice(d, "Hold its outward actions"), undefined, "no agent template for a person");
    assert.ok(ruleChoice(d, "Hold what agents do for this sender"), "its own templates");
    await move(d, "Next"); // → 4
    assert.ok(button(d, "Record verdict"), "no rule is chosen any more");
    await click(button(d, "Record verdict"));
    assert.equal(stub.calls.filter((c) => c.op === "proposal_send").length, 0, "the agent template was not sent for the person");
    assert.deepEqual(stub.calls.filter((c) => c.op === "review_record").map((c) => c.input.subject), [{ kind: "outside_agent", id: "psn_bright" }]);
    await m.unmount();
  });

  it("S3-1: after a failed send the owner goes back and changes who: the new subject records its own verdict and its rule links to that review", async () => {
    reset();
    stub.proposal = failedProposal("too_many_drafts");
    const m = await mount(h(ui.ReviewsPage, {}));
    await click(button(m.host, "Review someone"));
    const d = dialog();
    stub.current = snap(DIGEST, { kind: "agent", name: "Front desk", handles: [], teams: [] });
    await pickWho(d, "Front desk (agent)");
    await fillVerdict("Limited", "Checked.");
    await move(d, "Next"); // → 3
    await click(ruleChoice(d, "Hold its outward actions"));
    await move(d, "Next"); // → 4
    await click(button(d, "Record verdict and send rule"));
    assert.match(alerts(d)[0] ?? "", /^Your verdict is recorded\. The rule was not sent\./);
    for (let i = 0; i < 3; i++) await move(d, "Previous"); // → 1
    stub.proposal = sentProposal;
    stub.current = snap(DIGEST2, { kind: "agent", name: "Scout", handles: [], teams: [] });
    await pickWho(d, "Scout (agent)");
    assert.equal(alerts(d).filter((a) => /verdict is recorded/.test(a)).length, 0, "the old failure is not shown for the new subject");
    await move(d, "Next"); // → 2
    await move(d, "Next"); // → 3
    await click(ruleChoice(d, "Refuse its outward actions"));
    await move(d, "Next"); // → 4
    await click(button(d, "Record verdict and send rule"));
    const records = stub.calls.filter((c) => c.op === "review_record");
    assert.deepEqual(records.map((c) => c.input.subject), [{ kind: "agent", id: AGENT }, { kind: "agent", id: SCOUT }], "each subject records its own verdict");
    assert.deepEqual(stub.calls.filter((c) => c.op === "proposal_send").map((c) => c.input.params), [{ agent: AGENT }, { agent: SCOUT }]);
    assert.equal(document.querySelector("dialog[open]"), null, "closed after both succeeded");
    await m.unmount();
  });
});
