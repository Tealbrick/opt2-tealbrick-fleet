// Lean agent views (FLT-01 / APP-06 / C88, DESIGN §3.1): what an AGENT may read of the directory. Names, titles,
// roles, team structure, owner and trust only. Never an email, a channel handle, a tag, an identity, a mode or a
// review reason. Every query here selects the columns it returns, so a new column of a table cannot leak by accident.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { leanPersonStatus } from "./lifecycle/states.ts";
import { type AgentStatus, fail, MAX_TEAMS_PER_ANSWER, type PersonStatus, type Resolved, type Role, resolveSender, revision, teamsOf } from "./store.ts";
import type { ContactKind, Trust } from "./trust.ts";

export type MemberKind = "person" | "outside_agent" | "agent";
export interface LeanMember {
  kind: MemberKind;
  id: string;
  name: string;
  role: Role;
}
export interface LeanTeam {
  id: string;
  name: string;
  description: string;
  people: number;
  agents: number;
  updatedAt: string;
  members: LeanMember[];
}
export interface LeanTeamRef {
  id: string;
  name: string;
  role: Role;
}
export interface LeanPerson {
  id: string;
  name: string;
  kind: ContactKind;
  title: string;
  status: PersonStatus;
  trust: Trust;
  teams: LeanTeamRef[];
  updatedAt: string;
}
export interface LeanAgent {
  id: string;
  name: string;
  status: AgentStatus;
  owner: { id: string; name: string } | null;
  role: string;
  trust: Trust;
  teams: LeanTeamRef[];
  updatedAt: string;
}
export interface LeanDirectory {
  revision: number;
  unchanged: boolean;
  teams: LeanTeam[];
  people: LeanPerson[];
  agents: LeanAgent[];
}

/** Caps of the lean outputs (the manifest declares the same numbers). */
export const LEAN_CAPS = { teams: 500, membersPerTeam: 4000, people: 2000, agents: 2000 } as const;

const iso = (ms: unknown) => new Date(Number(ms)).toISOString();

type Row = Record<string, unknown>;
const MEMBER_SELECT = `SELECT m.team_id, m.kind AS mkind, m.subject_id, m.role, COALESCE(p.name, a.name) AS name, p.kind AS pkind
  FROM fleet_members m
  LEFT JOIN fleet_people p ON m.kind = 'person' AND p.id = m.subject_id
  LEFT JOIN fleet_agents a ON m.kind = 'agent' AND a.id = m.subject_id
  WHERE COALESCE(p.name, a.name) IS NOT NULL`;
const MEMBER_ORDER = "ORDER BY m.team_id, (m.kind = 'agent'), COALESCE(p.name, a.name) COLLATE NOCASE, m.subject_id";

function toMember(r: Row): LeanMember {
  return { kind: r.mkind === "agent" ? "agent" : ((r.pkind as ContactKind | null) ?? "person"), id: String(r.subject_id), name: String(r.name), role: r.role as Role };
}

/** team id → members, from one query (all teams) or for the given ids. */
function membersByTeam(db: Db, teamIds?: readonly string[]): Map<string, LeanMember[]> {
  const out = new Map<string, LeanMember[]>();
  const rows = teamIds
    ? teamIds.length === 0
      ? []
      : db.prepare(`${MEMBER_SELECT} AND m.team_id IN (${teamIds.map(() => "?").join(",")}) ${MEMBER_ORDER}`).all(...teamIds)
    : db.prepare(`${MEMBER_SELECT} ${MEMBER_ORDER}`).all();
  for (const r of rows) {
    const k = String(r.team_id);
    const list = out.get(k) ?? [];
    list.push(toMember(r));
    out.set(k, list);
  }
  return out;
}

function toTeam(r: Row, members: LeanMember[]): LeanTeam {
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description),
    people: members.filter((m) => m.kind !== "agent").length,
    agents: members.filter((m) => m.kind === "agent").length,
    updatedAt: iso(r.updated_at),
    members,
  };
}

/** Teams oldest first (ids are ULIDs); `cursor` = the last id of the previous page. The `tag` filter stays; tags are never shown. */
export function leanTeamsList(db: Db, q: { tag?: string; limit?: number; cursor?: string }): { teams: LeanTeam[]; nextCursor: string | null } {
  const limit = q.limit ?? 100;
  const rows = db
    .prepare(
      `SELECT id, name, description, updated_at FROM fleet_teams WHERE id > ? ${q.tag ? "AND EXISTS (SELECT 1 FROM json_each(fleet_teams.tags) WHERE value = ?)" : ""} ORDER BY id LIMIT ?`,
    )
    .all(...[q.cursor ?? "", ...(q.tag ? [q.tag] : []), limit + 1]);
  const page = rows.slice(0, limit);
  const members = membersByTeam(
    db,
    page.map((r) => String(r.id)),
  );
  return { teams: page.map((r) => toTeam(r, members.get(String(r.id)) ?? [])), nextCursor: rows.length > limit ? String(page[page.length - 1]?.id) : null };
}

/** By id, else by exact name (case-insensitive). */
export function leanTeamGet(db: Db, idOrName: string): LeanTeam {
  const r = db.prepare("SELECT id, name, description, updated_at FROM fleet_teams WHERE id = ? OR name = ? COLLATE NOCASE ORDER BY id = ? DESC LIMIT 1").get(idOrName, idOrName, idOrName);
  if (!r) return fail("team_not_found", "no team with this id or name", 404);
  return toTeam(r, membersByTeam(db, [String(r.id)]).get(String(r.id)) ?? []);
}

/** Teams of every subject in one query: `kind:id` → refs ordered by team name (at most 50 each, as the manifest declares). */
function teamRefs(db: Db): Map<string, LeanTeamRef[]> {
  const out = new Map<string, LeanTeamRef[]>();
  for (const r of db
    .prepare("SELECT m.kind, m.subject_id, t.id, t.name, m.role FROM fleet_members m JOIN fleet_teams t ON t.id = m.team_id ORDER BY t.name COLLATE NOCASE, t.id")
    .all()) {
    const k = `${r.kind}:${r.subject_id}`;
    const list = out.get(k) ?? [];
    if (list.length < MAX_TEAMS_PER_ANSWER) list.push({ id: String(r.id), name: String(r.name), role: r.role as Role });
    out.set(k, list);
  }
  return out;
}

export function leanDirectory(db: Db): LeanDirectory {
  const members = membersByTeam(db);
  const refs = teamRefs(db);
  return {
    revision: revision(db),
    unchanged: false,
    teams: db
      .prepare("SELECT id, name, description, updated_at FROM fleet_teams ORDER BY name COLLATE NOCASE, id")
      .all()
      .map((r) => toTeam(r, members.get(String(r.id)) ?? [])),
    people: db
      .prepare("SELECT id, name, kind, title, status, lifecycle, trust, updated_at FROM fleet_people ORDER BY name COLLATE NOCASE, id")
      .all()
      .map(
        (r): LeanPerson => ({
          id: String(r.id),
          name: String(r.name),
          kind: r.kind as ContactKind,
          title: String(r.title),
          status: leanPersonStatus(r.status as PersonStatus, r.lifecycle as string | null),
          trust: r.trust as Trust,
          teams: refs.get(`person:${r.id}`) ?? [],
          updatedAt: iso(r.updated_at),
        }),
      ),
    agents: db
      .prepare("SELECT a.id, a.name, a.status, a.role, a.trust, a.updated_at, a.owner_id, p.name AS owner_name FROM fleet_agents a LEFT JOIN fleet_people p ON p.id = a.owner_id ORDER BY a.name COLLATE NOCASE, a.id")
      .all()
      .map(
        (r): LeanAgent => ({
          id: String(r.id),
          name: String(r.name),
          status: r.status as AgentStatus,
          owner: r.owner_id === null ? null : { id: String(r.owner_id), name: String(r.owner_name) },
          role: String(r.role),
          trust: r.trust as Trust,
          teams: refs.get(`agent:${r.id}`) ?? [],
          updatedAt: iso(r.updated_at),
        }),
      ),
  };
}

/**
 * resolve_sender as an agent reads it (C380, S2-8): `departed` from `archived` only, so no agent learns of a leaver before the person
 * knows. The teams follow what the agent is told. The hook facts and the feed keep the real status: they narrow what Rules allows.
 */
export function leanResolveSender(db: Db, handle: string): Resolved {
  const found = resolveSender(db, handle);
  const c = found.contact;
  if (!c) return found;
  const lifecycle = db.prepare("SELECT lifecycle FROM fleet_people WHERE id = ?").get(c.id)?.lifecycle as string | null | undefined;
  const status = leanPersonStatus(c.status, lifecycle ?? null);
  if (status === c.status) return found;
  return {
    found: true,
    person: found.person ? { ...found.person, status } : null,
    contact: { ...c, status },
    teams: status === "active" && c.trust !== "blocked" ? teamsOf(db, "person", c.id).slice(0, MAX_TEAMS_PER_ANSWER) : [],
  };
}
