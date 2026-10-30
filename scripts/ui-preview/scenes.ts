// The scenes of scripts/ui-preview.ts: one path, one set of op answers, optional clicks. Every state a page has
// (loading, empty, error, narrow comes from the matrix itself) gets its own scene. Add a scene with each page.
import type { Page } from "playwright-core";

export type Answer = { kind: "ok"; value: unknown } | { kind: "error"; status: number; code: string; message?: string; details?: unknown } | { kind: "hang" };
export type Fixture = (input: unknown) => Answer;

export const ok =
  (value: unknown): Fixture =>
  () => ({ kind: "ok", value });
export const fail =
  (code: string, status = 500, message?: string): Fixture =>
  () => ({ kind: "error", status, code, message });
export const hang: Fixture = () => ({ kind: "hang" });

export interface Scene {
  name: string;
  /** relative to the app base */
  path: string;
  ops: Record<string, Fixture>;
  /** the app "has" exactly these person ops (the kit's PERSON_OPS in this scene); omit = the built manifest's list */
  personOps?: string[];
  signedOut?: boolean;
  /** text to wait for before the steps */
  ready?: string;
  steps?: (page: Page) => Promise<void>;
  /** fail the run when this is true: no raw id outside Details, no replaced word */
  strict?: boolean;
  /** visible text that must be there / must not be there */
  expect?: string[];
  forbid?: string[];
  /** per-cell state of a fixture */
  reset?: () => void;
  /** checks on the ops the scene called */
  assertCalls?: (calls: { op: string; input: unknown }[]) => string[];
}

const ID = { a: "agt_01J0000000000000000000000A", b: "agt_01J0000000000000000000000B", p: "per_01J00000000000000000000P1", t: "tm_01J00000000000000000000T1" };

export const shell: Record<string, Fixture> = {
  "tb.holds_list": ok({ items: [], nextCursor: null }),
  reviews_list: ok({ reviews: [], nextCursor: null, policy: { intervalDays: 0 } }),
};

const overview = {
  revision: 12,
  teams: [{ id: ID.t, name: "Support", description: "Front line", tags: [], people: 1, agents: 1, updatedAt: "2026-10-30T09:00:00Z", members: [{ kind: "person", id: ID.p, name: "Marco Rossi", role: "lead" }] }],
  people: [{ id: ID.p, name: "Marco Rossi", kind: "person", trust: "trusted", email: null, title: "Support lead", status: "active", tags: [], handles: ["slack:U01234ABC"], teams: [{ id: ID.t, name: "Support", role: "lead" }], updatedAt: "2026-10-30T09:00:00Z", org: "", relationship: "" }],
  agents: [{ id: ID.a, name: "Henry", trust: "unreviewed", mode: "free", status: "active", owner: { id: ID.p, name: "Marco Rossi" }, role: "", tags: [], teams: [], updatedAt: "2026-10-30T09:00:00Z" }],
};

// ── lifecycle pages (C380) ──────────────────────────────────────────────────
/** The server's words (src/lifecycle/floor.ts): a scene must show what the server sends. */
const FLOOR_TEXT = {
  confirmed: "Rules has this change.",
  not_confirmed: "Not confirmed: nothing may stop until you approve in Portal.",
  not_installed: "Rules & Approvals adds an early stop. It is not installed, or it needs an update.",
};
const LIFECYCLE_OPS = ["summary_get", "colleagues_list", "colleague_get", "lifecycle_set", "settings_set", "overview_get", "reviews_list"];
const FLOOR_PENDING = { state: "not_confirmed", text: FLOOR_TEXT.not_confirmed, version: "0.7.0-dev.1", feedRevision: 11, entries: 0, lastGateAt: "2026-10-30T15:58:00Z", gateNote: null };
const FLOOR_CONFIRMED = { ...FLOOR_PENDING, state: "confirmed", text: FLOOR_TEXT.confirmed, feedRevision: 13, entries: 1 };
const FLOOR_ABSENT = { state: "not_installed", text: FLOOR_TEXT.not_installed, version: null, feedRevision: null, entries: null, lastGateAt: null, gateNote: null };
const FLOOR_OLD_GATE = { ...FLOOR_CONFIRMED, lastGateAt: "2026-10-29T08:00:00Z", gateNote: "Rules has not checked a call since 2026-10-29T08:00:00.000Z." };

const summary = {
  generatedAt: "2026-10-30T16:00:00Z",
  revision: 12,
  agents: { total: 5, running: 3, paused: 1, stopping: 1, notReviewed: 2 },
  people: { total: 6, leaving: 1, suspended: 0 },
  noOwner: 1,
  differences: 3,
  canWriteOrSend: 4,
  stores: [
    { product: "core", name: "Portal", state: "read", text: "Read from your workspace", at: "2026-10-30T15:58:00Z" },
    { product: "connect", name: "Connect", state: "not_read", text: "Connect could not be read.", at: null },
    { product: "kanban", name: "Task Board", state: "not_installed", text: "Not installed.", at: null },
    { product: "knowledge", name: "Knowledge", state: "read", text: "Knowledge was read.", at: "2026-10-30T15:50:00Z" },
  ],
  readiness: [
    { id: "rules", state: "ok", text: "Rules & Approvals can stop a call early.", path: null },
    { id: "consent", state: "missing", text: "See who has access is off for Governance.", path: null },
    { id: "owners", state: "missing", text: "1 agent has no owner.", path: "/people-and-agents" },
    { id: "alerts", state: "fallback", text: "Inbox is not installed. Governance shows a banner here and no message is sent.", path: null },
  ],
  stoppedToday: 0,
  stopCap: { limit: 5, windowMinutes: 10, used: 0 },
  floor: FLOOR_CONFIRMED,
  settings: { coolingDays: 30, defaultOwner: { id: ID.p, name: "Marco Rossi" }, stopCap: 5 },
};
const row = (over: Record<string, unknown>) => ({ kind: "agent", id: ID.a, name: "Henry", lifecycle: "active", effective: "active", runtime: "running", trust: "trusted", owner: { id: ID.p, name: "Marco Rossi" }, line: "Working", findings: [], validFrom: null, validUntil: null, keepRunning: false, at: "2026-10-30T09:00:00Z", ...over });
const rows = [
  row({}),
  row({ id: ID.b, name: "Sales helper with a very long agent name that must wrap on a phone", lifecycle: "proposed", effective: "proposed", trust: "unreviewed", line: "New: working, not reviewed", owner: null, findings: [{ code: "no_owner", text: "Name an owner." }, { code: "running_unapproved", text: "It runs and you have not reviewed it." }] }),
  row({ id: "agt_01J0000000000000000000000C", name: "Night shift", lifecycle: "suspended", effective: "suspended", line: "Marked to stop, still running: approve in Portal", findings: [{ code: "not_stopped", text: "It should be stopped and Core says it is running." }] }),
  row({ id: "agt_01J0000000000000000000000D", name: "Old bot", lifecycle: "leaving", effective: "leaving", runtime: "paused", line: "Paused, removal waits for you" }),
  row({ kind: "person", id: ID.p, name: "Marco Rossi", runtime: null, owner: null, line: "Active" }),
  row({ kind: "person", id: "per_01J00000000000000000000P2", name: "Bob Bianchi", runtime: null, owner: null, lifecycle: "leaving", effective: "leaving", line: "Leaving: 2 agents wait for you in Portal" }),
];
const NOT_CHANGED_SERVER = ["Their own logins, such as Slack, Google or a bank.", "The agent's machine and its native tools.", "Copies of data that were already made.", "Other people with the shared Portal login. Change the Portal login if they had it.", "Engine steps after an agent step.", "Scheduled posts before you approve."];
const plan = {
  mode: "portal_link",
  applied: false,
  headline: "Not applied: do these in Portal",
  portalUrl: "https://portal.example.test/agents",
  steps: [{ id: "s1", agent: { id: ID.a, name: "Henry" }, action: "pause", text: "Pause Henry in Portal.", state: "open", proof: "Core says Henry is running." }],
  openSteps: 1,
  notChanged: NOT_CHANGED_SERVER,
  note: null,
};
const agentDetail = (over: Record<string, unknown> = {}) => ({
  colleague: {
    ...row({}),
    title: "",
    rev: 4,
    reason: null,
    note: null,
    keepReason: null,
    teams: [{ id: ID.t, name: "Support", role: "member" }],
    agents: [],
    actions: [
      { to: "suspended", label: "Stop now", blocked: null, needsWaive: false },
      { to: "leaving", label: "Stop and remove access", blocked: null, needsWaive: false },
    ],
    close: null,
    plan: null,
    floor: FLOOR_PENDING,
    grantsBefore: null,
    notices: [],
    history: [{ id: "lev_01J00000000000000000000H1", kind: "transition", from: "proposed", to: "active", actor: "owner", reason: "reviewed", note: null, at: "2026-10-29T09:00:00Z" }],
    ...over,
  },
});
const personDetail = (over: Record<string, unknown> = {}) =>
  agentDetail({
    ...row({ kind: "person", id: ID.p, name: "Marco Rossi", runtime: null, owner: null, line: "Active" }),
    title: "Support lead",
    agents: [row({}), row({ id: ID.b, name: "Sales helper", lifecycle: "proposed", effective: "proposed", line: "New: working, not reviewed" })],
    actions: [{ to: "leaving", label: "Stop this person's agents and access", blocked: null, needsWaive: false }],
    ...over,
  });
const stoppedAgent = (floor: unknown) => ({ colleague: agentDetail({ lifecycle: "suspended", effective: "suspended", line: "Marked to stop, still running: approve in Portal", plan, floor, reason: "left" }).colleague, transition: { from: "active", to: "suspended", event: "lev_01J00000000000000000000H2" } });
const pageOps = { ...shell, summary_get: ok(summary), colleagues_list: ok({ items: rows, nextCursor: null, total: rows.length }) };
const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name }).first().click();
/** Picks an option in the kit Select named `label`. */
async function pick(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
}
const AGENT = `person-or-agent?kind=agent&id=${ID.a}`;
const PERSON = `person-or-agent?kind=person&id=${ID.p}`;

export const scenes: Scene[] = [
  { name: "summary", path: "", personOps: LIFECYCLE_OPS, strict: true, ops: pageOps, ready: "Ready to stop an agent?", expect: ["Could not be read", "Not installed", "Rules has this change", "cannot see that switch"] },
  { name: "summary-no-stop-open", path: "", personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, summary_get: ok({ ...summary, agents: { ...summary.agents, stopping: 0 }, people: { ...summary.people, leaving: 0 } }) }, ready: "Ready to stop an agent?", forbid: ["Rules has this change"] },
  { name: "summary-empty", path: "", personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, summary_get: ok({ ...summary, agents: { total: 0, running: 0, paused: 0, stopping: 0, notReviewed: 0 }, people: { total: 0, leaving: 0, suspended: 0 } }) }, ready: "Add your first person" },
  { name: "summary-loading", path: "", personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, summary_get: hang }, ready: "Loading the summary" },
  { name: "summary-error", path: "", personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, summary_get: fail("internal") }, ready: "Try again" },
  { name: "summary-no-rules", path: "", personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, summary_get: ok({ ...summary, floor: FLOOR_ABSENT, stoppedToday: 2 }) }, ready: "It is not installed", expect: ["adds an early stop", "2 entries were stopped today"], forbid: ["Rules has this change"] },
  { name: "summary-old-gate", path: "", personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, summary_get: ok({ ...summary, floor: FLOOR_OLD_GATE }) }, ready: "has not checked a call", expect: ["29 Oct 2026, 08:00 UTC"], forbid: ["2026-10-29T"] },
  {
    name: "summary-settings",
    path: "",
    personOps: LIFECYCLE_OPS,
    strict: true,
    ops: pageOps,
    ready: "Ready to stop an agent?",
    steps: (p) => button(p, "Settings"),
    expect: ["Default owner", "Cooling period"],
  },
  { name: "feature-off", path: "", personOps: ["overview_get", "reviews_list"], ops: { ...shell, overview_get: ok(overview) }, ready: "Support", forbid: ["Summary", "People and agents", "Stop now", "See what would stop"] },
  { name: "everyone", path: "people-and-agents", personOps: LIFECYCLE_OPS, strict: true, ops: pageOps, ready: "Marco Rossi", expect: ["New: working, not reviewed", "Stop now", "No owner", "Name an owner. And 1 more."], forbid: ["See what would stop"] },
  { name: "everyone-empty", path: "people-and-agents", personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, colleagues_list: ok({ items: [], nextCursor: null, total: 0 }) }, ready: "Add your first person" },
  { name: "everyone-loading", path: "people-and-agents", personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, colleagues_list: hang }, ready: "Loading people and agents" },
  { name: "everyone-error", path: "people-and-agents", personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, colleagues_list: fail("internal") }, ready: "Try again" },
  {
    name: "stop-now-dialog",
    path: "people-and-agents",
    personOps: LIFECYCLE_OPS,
    strict: true,
    ops: pageOps,
    ready: "Marco Rossi",
    steps: (p) => button(p, "Stop now"),
    expect: ["Not changed", "Their own logins", "Do not write health", "cancelled, not moved"],
    forbid: ["have stopped", "calls stopped"],
  },
  {
    name: "stop-now-result-not-confirmed",
    path: "people-and-agents",
    personOps: LIFECYCLE_OPS,
    strict: true,
    ops: { ...pageOps, lifecycle_set: ok(stoppedAgent(FLOOR_PENDING)) },
    ready: "Marco Rossi",
    steps: async (p) => {
      await button(p, "Stop now");
      await pick(p, "Reason", "They left");
      await p.getByRole("dialog").getByRole("button", { name: "Stop", exact: true }).click();
      await p.getByText("what happens now").waitFor();
    },
    expect: ["Not confirmed", "Not applied: do these in Portal", "Waiting for you in Portal", "Open Portal", "Not changed"],
    forbid: ["Rules has this change"],
    assertCalls: (calls) => {
      const c = calls.find((x) => x.op === "lifecycle_set");
      const i = c?.input as { to?: string; reason?: string } | undefined;
      return i?.to === "suspended" && i.reason === "left" ? [] : [`lifecycle_set input: ${JSON.stringify(c?.input)}`];
    },
  },
  {
    name: "stop-now-result-confirmed",
    path: "people-and-agents",
    personOps: LIFECYCLE_OPS,
    strict: true,
    ops: { ...pageOps, lifecycle_set: ok(stoppedAgent(FLOOR_CONFIRMED)) },
    ready: "Marco Rossi",
    steps: async (p) => {
      await button(p, "Stop now");
      await pick(p, "Reason", "Security");
      await p.getByRole("dialog").getByRole("button", { name: "Stop", exact: true }).click();
      await p.getByText("what happens now").waitFor();
    },
    expect: ["Rules has this change", "Governance cannot see that switch"],
    forbid: ["Not confirmed"],
  },
  {
    name: "stop-now-cap",
    path: "people-and-agents",
    personOps: LIFECYCLE_OPS,
    strict: true,
    ops: { ...pageOps, lifecycle_set: () => ({ kind: "error", status: 409, code: "stop_cap_reached", details: { count: 6 } }) },
    ready: "Marco Rossi",
    steps: async (p) => {
      await button(p, "Stop now");
      await pick(p, "Reason", "Security");
      await p.getByRole("dialog").getByRole("button", { name: "Stop", exact: true }).click();
      await p.getByText("Stop this one too").first().waitFor();
    },
    expect: ["You stopped 5 entries"],
  },
  { name: "agent", path: AGENT, personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, colleague_get: ok(agentDetail()) }, ready: "History", expect: ["Stop now", "Stop and remove access"] },
  { name: "agent-loading", path: AGENT, personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, colleague_get: hang }, ready: "Loading this entry" },
  { name: "agent-error", path: AGENT, personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, colleague_get: fail("internal") }, ready: "Try again" },
  { name: "agent-no-link", path: "person-or-agent", personOps: LIFECYCLE_OPS, strict: true, ops: pageOps, ready: "not in the link" },
  { name: "agent-stopped", path: AGENT, personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, colleague_get: ok(stoppedAgent(FLOOR_PENDING)) }, ready: "History", expect: ["Not applied: do these in Portal", "Not changed"] },
  {
    name: "agent-details-open",
    path: AGENT,
    personOps: LIFECYCLE_OPS,
    strict: true,
    ops: { ...pageOps, colleague_get: ok(agentDetail()) },
    ready: "History",
    steps: async (p) => {
      await p.getByText("Details").click();
    },
  },
  {
    name: "close-before-cooling",
    path: AGENT,
    personOps: LIFECYCLE_OPS,
    strict: true,
    ops: { ...pageOps, colleague_get: ok(agentDetail({ lifecycle: "leaving", effective: "leaving", runtime: "paused", line: "Paused, removal waits for you", reason: "left", actions: [{ to: "archived", label: "Close", blocked: null, needsWaive: true }], close: { coolingDays: 30, coolingEndsAt: "2026-11-29T09:00:00Z", coolingOver: false, limits: ["Connect could not be read.", "No version of Task Board lists project access."] } })) },
    ready: "History",
    steps: (p) => button(p, "Close"),
    expect: ["Nothing closes by itself", "cooling period of 30 days ends", "Why close before the cooling", "Connect could not be read"],
  },
  {
    name: "close-blocked",
    path: AGENT,
    personOps: LIFECYCLE_OPS,
    strict: true,
    ops: { ...pageOps, colleague_get: ok(agentDetail({ lifecycle: "leaving", effective: "leaving", runtime: "running", line: "Leaving: waits for you in Portal", actions: [{ to: "archived", label: "Close", blocked: "Pause this agent in Portal first.", needsWaive: false }], plan })) },
    ready: "History",
    expect: ["Close: Pause this agent in Portal first."],
  },
  {
    name: "mark-reviewed",
    path: AGENT,
    personOps: LIFECYCLE_OPS,
    strict: true,
    ops: { ...pageOps, colleague_get: ok(agentDetail({ lifecycle: "proposed", effective: "proposed", trust: "unreviewed", line: "New: working, not reviewed", actions: [{ to: "active", label: "Mark as reviewed", blocked: null, needsWaive: false }] })) },
    ready: "History",
    steps: (p) => button(p, "Mark as reviewed"),
    expect: ["It grants nothing"],
  },
  {
    name: "bring-back",
    path: PERSON,
    personOps: LIFECYCLE_OPS,
    strict: true,
    ops: { ...pageOps, colleague_get: ok(personDetail({ lifecycle: "archived", effective: "archived", line: "Closed", agents: [], actions: [{ to: "proposed", label: "Bring back", blocked: null, needsWaive: false }], grantsBefore: [{ agent: ID.a, product: "knowledge", crud: ["read", "write"] }] })) },
    ready: "History",
    steps: (p) => button(p, "Bring back"),
    expect: ["This restores nothing"],
  },
  { name: "person", path: PERSON, personOps: LIFECYCLE_OPS, strict: true, ops: { ...pageOps, colleague_get: ok(personDetail()) }, ready: "History", expect: ["Their agents", "Stop this person's agents and access"] },
  ...(["Why", "Their agents", "Confirm", "Result"] as const).map((target, i): Scene => ({
    name: `person-flow-${i + 1}-${target.toLowerCase().replace(" ", "-")}`,
    path: PERSON,
    personOps: LIFECYCLE_OPS,
    strict: true,
    ops: { ...pageOps, colleague_get: ok(personDetail()), lifecycle_set: ok({ colleague: personDetail({ lifecycle: "leaving", effective: "leaving", line: "Leaving: 2 agents wait for you in Portal", plan, reason: "left", actions: [] }).colleague, transition: { from: "active", to: "leaving", event: "lev_01J00000000000000000000H3" } }) },
    ready: "History",
    steps: async (p) => {
      await button(p, "Stop this person's agents and access");
      const dialog = p.getByRole("dialog");
      if (i < 1) return;
      await pick(p, "Reason", "They left");
      await dialog.getByRole("button", { name: "Next" }).click();
      if (i < 2) return;
      await dialog.getByRole("button", { name: "Next" }).click();
      if (i < 3) return;
      await dialog.getByRole("button", { name: "Stop", exact: true }).click();
      await dialog.getByText("Not applied: do these in Portal").waitFor();
    },
    expect: i === 0 ? ["The mark takes effect now"] : i === 2 ? ["Not changed", "Their own logins", "The next screen says"] : i === 3 ? ["Not applied: do these in Portal"] : [],
    forbid: ["last day"],
  })),
  { name: "people-old", path: "people", ops: { ...shell, overview_get: ok(overview) }, ready: "Marco Rossi" },
  { name: "people-old-empty", path: "people", ops: { ...shell, overview_get: ok({ revision: 0, teams: [], people: [], agents: [] }) }, ready: "No people yet" },
  { name: "people-old-loading", path: "people", ops: { ...shell, overview_get: hang }, ready: "Loading the directory" },
  { name: "people-old-error", path: "people", ops: { ...shell, overview_get: fail("internal") }, ready: "Try again" },
  { name: "signed-out", path: "people", ops: {}, signedOut: true, ready: "Open this app from Portal" },
];
