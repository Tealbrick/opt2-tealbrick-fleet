// The scenes of scripts/ui-preview.ts: one path, one set of op answers, optional clicks. Every state a page has
// (loading, empty, error, narrow comes from the matrix itself) gets its own scene. Add a scene with each page.
import type { Page } from "playwright-core";

export type Answer = { kind: "ok"; value: unknown } | { kind: "error"; status: number; code: string; message?: string } | { kind: "hang" };
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

export const scenes: Scene[] = [
  { name: "people-old", path: "people", ops: { ...shell, overview_get: ok(overview) }, ready: "Marco Rossi" },
  { name: "people-old-empty", path: "people", ops: { ...shell, overview_get: ok({ revision: 0, teams: [], people: [], agents: [] }) }, ready: "No people yet" },
  { name: "people-old-loading", path: "people", ops: { ...shell, overview_get: hang }, ready: "Loading the directory" },
  { name: "people-old-error", path: "people", ops: { ...shell, overview_get: fail("internal") }, ready: "Try again" },
  { name: "waiting-for-approval", path: "holds", strict: true, ops: shell, ready: "No calls wait", expect: ["Waiting for approval"] },
  { name: "reviews-words", path: "reviews", strict: true, ops: { ...shell, overview_get: ok(overview), reviews_list: ok({ reviews: [], due: [], nextCursor: null, policy: { enabled: false, intervalDays: 90 } }) }, ready: "Review someone", expect: ["Reviews"] },
  { name: "access-words", path: "access", strict: true, ops: { ...shell, access_get: ok({ status: "unavailable", reason: "not_consented", note: "App access is not shown. Turn on 'See who has access' for Governance in the Portal (app settings) to show this." }) }, ready: "App access is not shown", expect: ["does not find agents you do not know about"] },
  { name: "who-owns-what", path: "topology", strict: true, ops: { ...shell, access_get: ok({ status: "unavailable", reason: "not_consented", note: "App access is not shown." }), topology_get: ok({ revision: 1, nodes: [], edges: [], sources: { contacts: { status: "unavailable", note: "Connect is not available." } } }) }, ready: "Who owns what" },
  { name: "signed-out", path: "people", ops: {}, signedOut: true, ready: "Open this app from Portal" },
];
