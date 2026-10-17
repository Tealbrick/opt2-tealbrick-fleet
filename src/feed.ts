// The directory feed for apps: contract fleet.directory_feed/1 (C230, G-3, RUL-02, FLT-02). The frozen schema and its
// fixtures are copied to test/contracts/ (see PROVENANCE.md); every answer in the tests is validated against them.
//
// What the feed carries and what it never carries (C88, FLT-01): team member ids and roles; contact ids with kind, status,
// trust and CANONICAL handles; agent ids with status, trust and the owner's contact id. No email, no title, no tag, no
// description, no person or agent name, no review reason. Names are not data an app needs to decide: Rules matches ids.
// A team's name is the one exception the contract allows (name?, 1-80 chars).
import { normalizeHandle } from "@opt2-tealbrick/manifest";
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
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
  name: string;
  members: FeedMember[];
}
export interface FeedContact {
  id: string;
  kind: ContactKind;
  status: "active" | "departed";
  trust: Trust;
  handles: string[];
}
export interface FeedAgent {
  id: string;
  status: "active" | "paused" | "removed";
  trust: Trust;
  owner: string | null;
}
export type DirectoryFeed =
  | { v: 1; revision: number; unchanged: false; teams: FeedTeam[]; contacts: FeedContact[]; agents: FeedAgent[] }
  | { v: 1; revision: number; unchanged: true };

const tooLarge = (what: string, cap: number): never => {
  throw new TbError("feed_too_large", `the directory has more than ${cap} ${what}; the feed contract fleet.directory_feed/1 cannot carry it`, 413);
};

/** Only app callers (companions such as Rules) read the feed. An agent, a person or anything else gets `no_access`. */
export function assertFeedCaller(caller: { type: string }): void {
  if (caller.type !== "app") throw new TbError("no_access", "directory_feed is for apps only", 403);
}

/**
 * The feed, or `{v, revision, unchanged:true}` when `sinceRevision` equals the current revision. Four indexed reads,
 * independent of the number of teams (no query per team or per person). A stored handle that is not canonical
 * (`normalizeHandle(h) !== h`) is left out: a reader refuses the whole answer for one such handle.
 */
export function directoryFeed(db: Db, input: { sinceRevision?: number }): DirectoryFeed {
  const rev = revision(db);
  if (input.sinceRevision !== undefined && input.sinceRevision === rev) return { v: 1, revision: rev, unchanged: true };

  const members = new Map<string, FeedMember[]>();
  // join the subject table so a dangling member (no foreign key on subject_id) is never published
  for (const r of db
    .prepare(
      `SELECT m.team_id, m.kind, m.subject_id, m.role FROM fleet_members m
       WHERE (m.kind = 'person' AND EXISTS (SELECT 1 FROM fleet_people p WHERE p.id = m.subject_id))
          OR (m.kind = 'agent' AND EXISTS (SELECT 1 FROM fleet_agents a WHERE a.id = m.subject_id))
       ORDER BY m.team_id, m.kind, m.subject_id`,
    )
    .all()) {
    const key = String(r.team_id);
    const list = members.get(key) ?? [];
    list.push({ kind: r.kind === "agent" ? "agent" : "contact", id: String(r.subject_id), role: r.role as FeedMember["role"] });
    members.set(key, list);
  }
  const teams = db
    .prepare("SELECT id, name FROM fleet_teams ORDER BY id")
    .all()
    .map((t): FeedTeam => ({ id: String(t.id), name: String(t.name), members: members.get(String(t.id)) ?? [] }));
  if (teams.length > FEED_CAPS.teams) tooLarge("teams", FEED_CAPS.teams);
  for (const t of teams) if (t.members.length > FEED_CAPS.membersPerTeam) tooLarge("members in one team", FEED_CAPS.membersPerTeam);

  const handles = new Map<string, string[]>();
  for (const r of db.prepare("SELECT person_id, handle FROM fleet_handles ORDER BY person_id, handle").all()) {
    const h = String(r.handle);
    if (normalizeHandle(h) !== h) continue;
    const key = String(r.person_id);
    const list = handles.get(key) ?? [];
    list.push(h);
    handles.set(key, list);
  }
  const contacts = db
    .prepare("SELECT id, kind, status, trust FROM fleet_people ORDER BY id")
    .all()
    .map(
      (c): FeedContact => ({
        id: String(c.id),
        kind: c.kind as ContactKind,
        status: c.status as FeedContact["status"],
        trust: c.trust as Trust,
        handles: (handles.get(String(c.id)) ?? []).slice(0, FEED_CAPS.handlesPerContact),
      }),
    );
  if (contacts.length > FEED_CAPS.contacts) tooLarge("contacts", FEED_CAPS.contacts);

  const agents = db
    .prepare("SELECT id, status, trust, owner_id FROM fleet_agents ORDER BY id")
    .all()
    .map((a): FeedAgent => ({ id: String(a.id), status: a.status as FeedAgent["status"], trust: a.trust as Trust, owner: a.owner_id === null ? null : String(a.owner_id) }));
  if (agents.length > FEED_CAPS.agents) tooLarge("agents", FEED_CAPS.agents);

  return { v: 1, revision: rev, unchanged: false, teams, contacts, agents };
}
