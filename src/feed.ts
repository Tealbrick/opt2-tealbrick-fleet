// The directory feed for apps: contract fleet.directory_feed/1 (C230, G-3, RUL-02, FLT-02). The frozen schema and its
// fixtures are copied to test/contracts/ (see PROVENANCE.md); every answer in the tests is validated against them.
//
// What the feed carries and what it never carries (C88, FLT-01): team member ids and roles; contact ids with kind, status,
// trust and CANONICAL handles; agent ids with status, trust and the owner's contact id. No email, no title, no tag, no
// description, no person or agent name, no review reason. Names are not data an app needs to decide: Rules matches ids.
// A team's name is the one exception the contract allows (name?, 1-80 chars).
import { normalizeHandle } from "@opt2-tealbrick/manifest";
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type Effective, effectiveAgent, effectivePerson, floorOf, type Lifecycle } from "./lifecycle/states.ts";
import { revision } from "./store.ts";
import type { ContactKind, Trust } from "./trust.ts";

/** Caps of fleet.directory_feed/1 (the schema is the authority; the test reads them from the schema too). */
export const FEED_CAPS = { teams: 500, membersPerTeam: 4000, contacts: 2000, agents: 2000, handlesPerContact: 16 } as const;

export interface FeedMember {
  kind: "agent" | "contact";
  id: string;
  role: "member" | "lead";
}
export interface FeedTeam {
  id: string;
  name?: string;
  members: FeedMember[];
}
export interface FeedContact {
  id: string;
  kind: ContactKind;
  status: "active" | "departed";
  trust: Trust;
  handles: string[];
  /** only with `accept: ["lifecycle"]` (C380): the effective lifecycle; none for an outside agent, which has only trust */
  lifecycle?: Effective;
  /** only with `accept: ["lifecycle"]`: true = Rules refuses by, for and to this entry, before any rule */
  floor?: boolean;
}
export interface FeedAgent {
  id: string;
  status: "active" | "paused" | "removed";
  trust: Trust;
  owner: string | null;
  /** only with `accept: ["agent_handles"]` (C373 §3): canonical handles Connect issued to the agent, sorted, <= 16 */
  handles?: string[];
  /** only with `accept: ["lifecycle"]` (C380): the effective lifecycle, with the owner's stop and the dates in it */
  lifecycle?: Effective;
  /** only with `accept: ["lifecycle"]`: true = Rules refuses it before any rule */
  floor?: boolean;
}

/** The `accept` values this version knows (C373 §3, C380). Unknown values are ignored. */
export const ACCEPT_AGENT_HANDLES = "agent_handles";
export const ACCEPT_LIFECYCLE = "lifecycle";
export interface FeedInput {
  sinceRevision?: number;
  accept?: string[];
}
export type DirectoryFeed =
  | { v: 1; revision: number; unchanged: false; teams: FeedTeam[]; contacts: FeedContact[]; agents: FeedAgent[] }
  | { v: 1; revision: number; unchanged: true };

/** Transient: the directory is larger than the contract carries. 503 so a reader keeps its last good copy and retries. */
const tooLarge = (what: string, cap: number): never => {
  throw new TbError("feed_too_large", `the directory has more than ${cap} ${what}; the feed contract fleet.directory_feed/1 cannot carry it`, 503);
};

// Field rules of the frozen schema (a test compares these with test/contracts/fleet.directory_feed.1.schema.json).
export const AGENT_ID_PATTERN = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;
export const HANDLE_PATTERN = /^(buzz:npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}|slack:[UW][A-Z0-9]{2,30}|telegram:-?[1-9][0-9]{0,19})$/;
export const ID_MAX = 64;
export const TEAM_NAME_MAX = 80;
const validId = (id: string): boolean => id.length >= 1 && id.length <= ID_MAX;

/** The cached Connect handles per agent (table fleet_agent_handles, written only by the timer in agent-handles.ts). */
export function cachedAgentHandles(db: Db): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of db.prepare("SELECT agent_id, handle FROM fleet_agent_handles ORDER BY agent_id, handle").all()) {
    const id = String(r.agent_id);
    const list = out.get(id) ?? [];
    list.push(String(r.handle));
    out.set(id, list);
  }
  return out;
}

/** Warn once per skipped id (bounded memory): one bad legacy row must not flood the log on every pull. */
const warned = new Set<string>();
export type Warn = (msg: string, fields: Record<string, string>) => void;
function skip(warn: Warn | undefined, what: string, id: string): void {
  const key = `${what}:${id}`;
  if (warned.has(key)) return;
  if (warned.size >= 1000) warned.clear();
  warned.add(key);
  warn?.(`directory_feed leaves out ${what} that does not fit the contract fleet.directory_feed/1`, { what, id: id.slice(0, 80) });
}

/**
 * The VERIFIED products allowed to read the feed: Rules (its read model, C243, C373 §2) and Knowledge (C373e, a second
 * reader). Exact product ids only; never a manifest name.
 */
export const FEED_READERS: readonly string[] = Object.freeze(["rules", "knowledge"]);

/** Refusal text for an app caller the SDK could not verify (same words as the SDK's own `caller_unverified`). */
export const FEED_UNVERIFIED_MESSAGE = "the calling app is not verified for this workspace yet: update the bridge, or retry after the workspace config refreshes";

/**
 * Only the reader apps in FEED_READERS read the feed (C243, C373 RULES-INTERFACE §2, C373e). The check uses ONLY the
 * verified caller fields the SDK sets (SDK-CALLER-PRODUCT, spec `Caller`):
 *  - `caller.type` must be `app`; an agent, a person or anything else gets `no_access` 403;
 *  - `caller.product` is the VERIFIED product (the signed grant `prd`, else the signed slice `companionCallers` entry);
 *    it must be exactly one of FEED_READERS. Never the display `name` or any self-claimed string;
 *  - `caller.listed` must be `true`: the caller instance is in the CURRENT signed slice `companionCallers` under that
 *    product (the spec asks apps that share data with a calling app to re-check it at use time; false when the slice is
 *    expired or the companion edge was removed after the grant was minted).
 * An app caller with no verified product, or one that is not listed, gets `caller_unverified` 403 (retryable: a newer
 * slice or bridge fixes it), like the SDK's central guard (SDK 0.1.35, C261) when the slice flag `appCallers: "verified"`
 * is set. A verified app of another product gets `no_access` 403. No refusal carries feed data.
 */
export function assertFeedCaller(caller: { type: string; product?: unknown; listed?: unknown }): void {
  if (caller.type !== "app") throw new TbError("no_access", "directory_feed is for apps only", 403);
  const product = caller.product;
  if (product === undefined || product === null || product === "") throw new TbError("caller_unverified", FEED_UNVERIFIED_MESSAGE, 403, { retryable: true });
  if (typeof product !== "string" || !FEED_READERS.includes(product)) throw new TbError("no_access", "directory_feed is for the reader apps only (Rules, Knowledge)", 403);
  if (caller.listed !== true) throw new TbError("caller_unverified", FEED_UNVERIFIED_MESSAGE, 403, { retryable: true });
}

/**
 * The feed, or `{v, revision, unchanged:true}` when `sinceRevision` equals the current revision. Four indexed reads,
 * independent of the number of teams (no query per team or per person).
 *
 * Rows the contract cannot carry are left out (with one warning per id), never the whole feed: a handle that is not
 * canonical (`normalizeHandle(h) !== h` or off the schema pattern), an agent id that is not `agt_<26 Crockford>`, an
 * id of 0 or over 64 characters. A member or owner that names a left-out row is left out too. Removed agents are
 * listed only while a team still names them (so a reader can drop the member); they do not count against the cap.
 *
 * `accept: ["agent_handles"]` (C373 §3, additive): every agents[] entry also carries `handles` (the cached Connect
 * handles, canonical, sorted, <= 16; [] when none). One more indexed read; nothing is called. Without it (or with only
 * unknown values) the answer is byte-for-byte the fleet.directory_feed/1 shape of 0.2.x.
 *
 * `accept: ["lifecycle"]` (C380, spec 0.1.89): agents[] and person contacts[] carry the effective lifecycle, and agents[] and contacts[]
 * carry `floor`. A reader replaces its floor entries from a full read, so a stopped row stays listed. Time changes `not_started` only with a
 * revision bump (the date timer ends the date), so `unchanged` stays true to its word.
 */
export function directoryFeed(db: Db, input: FeedInput, warn?: Warn, now = Date.now()): DirectoryFeed {
  const rev = revision(db);
  if (input.sinceRevision !== undefined && input.sinceRevision === rev) return { v: 1, revision: rev, unchanged: true };
  // C373 §3: agent handles only when the reader asks for them; without `accept` the answer is exactly the old shape
  const agentHandles = Array.isArray(input.accept) && input.accept.includes(ACCEPT_AGENT_HANDLES) ? cachedAgentHandles(db) : null;
  // C380: lifecycle and floor only when the reader asks; without `accept` the answer is exactly the old shape
  const lifecycle = Array.isArray(input.accept) && input.accept.includes(ACCEPT_LIFECYCLE);

  const handles = new Map<string, string[]>();
  const personHandles = new Set<string>();
  for (const r of db.prepare("SELECT person_id, handle FROM fleet_handles ORDER BY person_id, handle").all()) {
    const h = String(r.handle);
    personHandles.add(h);
    if (normalizeHandle(h) !== h || !HANDLE_PATTERN.test(h)) {
      skip(warn, "a handle", h);
      continue;
    }
    const key = String(r.person_id);
    const list = handles.get(key) ?? [];
    list.push(h);
    handles.set(key, list);
  }
  const contacts: FeedContact[] = [];
  const contactIds = new Set<string>();
  const ownerLifecycle = new Map<string, string | null>();
  for (const c of db.prepare(`SELECT id, kind, status, trust${lifecycle ? ", lifecycle, valid_from" : ""} FROM fleet_people ORDER BY id`).all()) {
    const id = String(c.id);
    if (!validId(id)) {
      skip(warn, "a contact id", id);
      continue;
    }
    contactIds.add(id);
    const contact: FeedContact = { id, kind: c.kind as ContactKind, status: c.status as FeedContact["status"], trust: c.trust as Trust, handles: (handles.get(id) ?? []).slice(0, FEED_CAPS.handlesPerContact) };
    if (lifecycle) {
      const own = (c.lifecycle ?? null) as Lifecycle | null;
      ownerLifecycle.set(id, own);
      const effective = own === null ? null : effectivePerson({ lifecycle: own, validFrom: c.valid_from === null ? null : Number(c.valid_from) }, now);
      if (effective !== null) contact.lifecycle = effective;
      contact.floor = floorOf(effective, contact.trust);
    }
    contacts.push(contact);
  }
  if (contacts.length > FEED_CAPS.contacts) tooLarge("contacts", FEED_CAPS.contacts);

  const agents: FeedAgent[] = [];
  const agentIds = new Set<string>();
  for (const a of db
    // C380: a reader drops a floor entry when its row leaves a full feed, so a stopped or blocked agent stays listed after its card is gone
    .prepare(`SELECT id, status, trust, owner_id${lifecycle ? ", lifecycle, valid_from, keep_running, migrated_note" : ""} FROM fleet_agents WHERE status <> 'removed' OR id IN (SELECT subject_id FROM fleet_members WHERE kind = 'agent')${lifecycle ? " OR trust = 'blocked' OR (lifecycle IN ('suspended', 'leaving', 'archived') AND migrated_note IS NULL)" : ""} ORDER BY id`)
    .all()) {
    const id = String(a.id);
    if (!AGENT_ID_PATTERN.test(id)) {
      skip(warn, "an agent id", id);
      continue;
    }
    agentIds.add(id);
    const owner = a.owner_id === null ? null : String(a.owner_id);
    const agent: FeedAgent = { id, status: a.status as FeedAgent["status"], trust: a.trust as Trust, owner: owner !== null && contactIds.has(owner) ? owner : null };
    if (agentHandles) {
      const list: string[] = [];
      for (const h of agentHandles.get(id) ?? []) {
        if (normalizeHandle(h) !== h || !HANDLE_PATTERN.test(h)) {
          skip(warn, "an agent handle", h);
          continue;
        }
        // S3-15: a handle a person also holds stays the person's. A compromised Connect cannot make the floor refuse that person. Finding agent_handle_conflict.
        if (personHandles.has(h)) continue;
        if (list.length < FEED_CAPS.handlesPerContact) list.push(h);
      }
      agent.handles = list;
    }
    if (lifecycle) {
      const effective = effectiveAgent({ lifecycle: a.lifecycle as Lifecycle, validFrom: a.valid_from === null ? null : Number(a.valid_from), keepRunning: Number(a.keep_running) === 1 }, a.owner_id === null ? null : (ownerLifecycle.get(String(a.owner_id)) ?? null), now);
      agent.lifecycle = effective;
      agent.floor = floorOf(effective, agent.trust, a.migrated_note === "no_card");
    }
    agents.push(agent);
  }
  if (agents.length > FEED_CAPS.agents) tooLarge("agents", FEED_CAPS.agents);

  const members = new Map<string, FeedMember[]>();
  for (const r of db.prepare("SELECT team_id, kind, subject_id, role FROM fleet_members ORDER BY team_id, kind, subject_id").all()) {
    const id = String(r.subject_id);
    const isAgent = r.kind === "agent";
    if (!(isAgent ? agentIds : contactIds).has(id)) continue; // dangling or left out above
    const key = String(r.team_id);
    const list = members.get(key) ?? [];
    list.push({ kind: isAgent ? "agent" : "contact", id, role: r.role as FeedMember["role"] });
    members.set(key, list);
  }
  const teams: FeedTeam[] = [];
  for (const t of db.prepare("SELECT id, name FROM fleet_teams ORDER BY id").all()) {
    const id = String(t.id);
    if (!validId(id)) {
      skip(warn, "a team id", id);
      continue;
    }
    const name = String(t.name);
    const fits = name.length >= 1 && name.length <= TEAM_NAME_MAX;
    if (!fits) skip(warn, "a team name", id); // the name is optional in the contract: leave only the name out
    teams.push({ id, ...(fits ? { name } : {}), members: members.get(id) ?? [] });
  }
  if (teams.length > FEED_CAPS.teams) tooLarge("teams", FEED_CAPS.teams);
  for (const t of teams) if (t.members.length > FEED_CAPS.membersPerTeam) tooLarge("members in one team", FEED_CAPS.membersPerTeam);

  return { v: 1, revision: rev, unchanged: false, teams, contacts, agents };
}
