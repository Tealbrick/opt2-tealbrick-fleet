// The workspace directory over the app's own tables (migrations/0001_init.sql). Plain functions over the SDK's Db
// handle: handlers and the context hook stay thin, tests run them against the migrated database.
// Harvested from v1 (labs/organization-plane store/types: person + membership subjects "person" | "agent";
// portal Team / Membership / AgentGrant / ExternalIdentity), trimmed to one workspace = one tenant: no companies,
// tenants, roles-per-tenant or license; people are directory entries, never sign-ins (C84).
import { type HandleChannel, handleChannel, normalizeHandle, ulid } from "@opt2-tealbrick/manifest";
import { type Db, type SliceAgent, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type ContactKind, defaultTrust, type Source, type Trust } from "./trust.ts";

export type Role = "member" | "lead";
export type PersonStatus = "active" | "departed";
export type AgentStatus = "active" | "paused" | "removed";

export interface Ref {
  id: string;
  name: string;
}
export interface TeamRef extends Ref {
  role: Role;
}
export interface Team {
  id: string;
  name: string;
  description: string;
  tags: string[];
  people: number;
  agents: number;
  updatedAt: string;
}
export interface Member {
  kind: "person" | "agent";
  id: string;
  name: string;
  role: Role;
  /** person members only */
  handles?: string[];
}
export interface TeamDetail extends Team {
  members: Member[];
}
export interface Person {
  id: string;
  name: string;
  kind: ContactKind;
  trust: Trust;
  email: string | null;
  title: string;
  status: PersonStatus;
  tags: string[];
  handles: string[];
  teams: TeamRef[];
  updatedAt: string;
}
export interface Agent {
  id: string;
  name: string;
  trust: Trust;
  mode: string;
  status: AgentStatus;
  owner: Ref | null;
  role: string;
  tags: string[];
  teams: TeamRef[];
  updatedAt: string;
}
export interface Directory {
  revision: number;
  teams: TeamDetail[];
  people: Person[];
  agents: Agent[];
}

/** Teams per `teams` list in an agent answer (resolve_sender, hook facts): the manifest declares maxItems 50. */
export const MAX_TEAMS_PER_ANSWER = 50;

/** Size limits of one directory (lean: a workspace, not an enterprise HR system). */
export const LIMITS = { teams: 500, people: 2000, handlesPerPerson: 10 } as const;

type Row = Record<string, unknown>;
const iso = (ms: unknown) => new Date(Number(ms)).toISOString();
const tags = (v: unknown): string[] => JSON.parse(String(v)) as string[];
export const fail = (code: string, message: string, status: number): never => {
  throw new TbError(code, message, status);
};

// ── revision ────────────────────────────────────────────────────────────────────────────────────────────────────

export function revision(db: Db): number {
  return Number(db.prepare("SELECT value FROM fleet_meta WHERE key = 'revision'").get()?.value ?? 0);
}

export function bump(db: Db): void {
  db.prepare("UPDATE fleet_meta SET value = value + 1 WHERE key = 'revision'").run();
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────

function handlesOf(db: Db, personId: string): string[] {
  return db
    .prepare("SELECT handle FROM fleet_handles WHERE person_id = ? ORDER BY handle")
    .all(personId)
    .map((r) => String(r.handle));
}

function teamsOf(db: Db, kind: "person" | "agent", id: string): TeamRef[] {
  return db
    .prepare(
      "SELECT t.id, t.name, m.role FROM fleet_members m JOIN fleet_teams t ON t.id = m.team_id WHERE m.kind = ? AND m.subject_id = ? ORDER BY t.name COLLATE NOCASE, t.id",
    )
    .all(kind, id)
    .map((r) => ({ id: String(r.id), name: String(r.name), role: r.role as Role }));
}

function toTeam(db: Db, r: Row): Team {
  const counts = db
    .prepare("SELECT kind, COUNT(*) AS n FROM fleet_members WHERE team_id = ? GROUP BY kind")
    .all(r.id)
    .reduce<Record<string, number>>((a, c) => Object.assign(a, { [String(c.kind)]: Number(c.n) }), {});
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description),
    tags: tags(r.tags),
    people: counts.person ?? 0,
    agents: counts.agent ?? 0,
    updatedAt: iso(r.updated_at),
  };
}

function membersOf(db: Db, teamId: string): Member[] {
  const people = db
    .prepare("SELECT p.id, p.name, m.role FROM fleet_members m JOIN fleet_people p ON p.id = m.subject_id WHERE m.team_id = ? AND m.kind = 'person' ORDER BY p.name COLLATE NOCASE, p.id")
    .all(teamId)
    .map((r): Member => ({ kind: "person", id: String(r.id), name: String(r.name), role: r.role as Role, handles: handlesOf(db, String(r.id)) }));
  const agents = db
    .prepare("SELECT a.id, a.name, m.role FROM fleet_members m JOIN fleet_agents a ON a.id = m.subject_id WHERE m.team_id = ? AND m.kind = 'agent' ORDER BY a.name COLLATE NOCASE, a.id")
    .all(teamId)
    .map((r): Member => ({ kind: "agent", id: String(r.id), name: String(r.name), role: r.role as Role }));
  return [...people, ...agents];
}

const toTeamDetail = (db: Db, r: Row): TeamDetail => ({ ...toTeam(db, r), members: membersOf(db, String(r.id)) });

function toPerson(db: Db, r: Row): Person {
  const id = String(r.id);
  return {
    id,
    name: String(r.name),
    kind: r.kind as ContactKind,
    trust: r.trust as Trust,
    email: r.email === null ? null : String(r.email),
    title: String(r.title),
    status: r.status as PersonStatus,
    tags: tags(r.tags),
    handles: handlesOf(db, id),
    teams: teamsOf(db, "person", id),
    updatedAt: iso(r.updated_at),
  };
}

function toAgent(db: Db, r: Row): Agent {
  const id = String(r.id);
  return {
    id,
    name: String(r.name),
    trust: r.trust as Trust,
    mode: String(r.mode),
    status: r.status as AgentStatus,
    owner: r.owner_id === null ? null : { id: String(r.owner_id), name: String(r.owner_name) },
    role: String(r.role),
    tags: tags(r.tags),
    teams: teamsOf(db, "agent", id),
    updatedAt: iso(r.updated_at),
  };
}

const AGENT_SELECT = "SELECT a.*, p.name AS owner_name FROM fleet_agents a LEFT JOIN fleet_people p ON p.id = a.owner_id";

/** Teams oldest first (ids are ULIDs); `cursor` = the last id of the previous page. */
export function listTeams(db: Db, q: { tag?: string; limit?: number; cursor?: string }): { teams: TeamDetail[]; nextCursor: string | null } {
  const limit = q.limit ?? 100;
  const rows = db
    .prepare(
      `SELECT * FROM fleet_teams WHERE id > ? ${q.tag ? "AND EXISTS (SELECT 1 FROM json_each(fleet_teams.tags) WHERE value = ?)" : ""} ORDER BY id LIMIT ?`,
    )
    .all(...[q.cursor ?? "", ...(q.tag ? [q.tag] : []), limit + 1]);
  const page = rows.slice(0, limit);
  return { teams: page.map((r) => toTeamDetail(db, r)), nextCursor: rows.length > limit ? String(page[page.length - 1]?.id) : null };
}

/** By id, else by exact name (case-insensitive). */
export function getTeam(db: Db, idOrName: string): TeamDetail {
  const r = db.prepare("SELECT * FROM fleet_teams WHERE id = ? OR name = ? COLLATE NOCASE ORDER BY id = ? DESC LIMIT 1").get(idOrName, idOrName, idOrName);
  return r ? toTeamDetail(db, r) : fail("team_not_found", "no team with this id or name", 404);
}

export function getPerson(db: Db, id: string): Person {
  const r = db.prepare("SELECT * FROM fleet_people WHERE id = ?").get(id);
  return r ? toPerson(db, r) : fail("person_not_found", "no person with this id", 404);
}

export function getAgent(db: Db, id: string): Agent {
  const r = db.prepare(`${AGENT_SELECT} WHERE a.id = ?`).get(id);
  return r ? toAgent(db, r) : fail("agent_not_found", "no workspace agent with this id", 404);
}

export function directory(db: Db): Directory {
  return {
    revision: revision(db),
    teams: db.prepare("SELECT * FROM fleet_teams ORDER BY name COLLATE NOCASE, id").all().map((r) => toTeamDetail(db, r)),
    people: db.prepare("SELECT * FROM fleet_people ORDER BY name COLLATE NOCASE, id").all().map((r) => toPerson(db, r)),
    agents: db.prepare(`${AGENT_SELECT} ORDER BY a.name COLLATE NOCASE, a.id`).all().map((r) => toAgent(db, r)),
  };
}

export interface Contact {
  id: string;
  name: string;
  kind: ContactKind;
  status: PersonStatus;
  trust: Trust;
}

export interface Resolved {
  found: boolean;
  /** Deprecated since 0.2.0 (use `contact`; removed after 0.3.0): the 0.1.10 shape, only for kind person; null for outside agents. */
  person: { id: string; name: string; status: PersonStatus } | null;
  contact: Contact | null;
  teams: TeamRef[];
}

const toContact = (r: Row): Contact => ({ id: String(r.id), name: String(r.name), kind: r.kind as ContactKind, status: r.status as PersonStatus, trust: r.trust as Trust });

/** A contact has team facts only while it is active and not blocked (facts narrow, never widen). */
export const hasTeamFacts = (c: Pick<Contact, "status" | "trust">): boolean => c.status === "active" && c.trust !== "blocked";

/** Handle → contact (a person or an outside agent) with its trust + teams. A departed or blocked contact is found but has no teams. */
export function resolveSender(db: Db, handle: string): Resolved {
  const h = normalizeHandle(handle);
  const r = h
    ? db.prepare("SELECT p.id, p.name, p.status, p.kind, p.trust FROM fleet_handles h JOIN fleet_people p ON p.id = h.person_id WHERE h.handle = ?").get(h)
    : undefined;
  if (!r) return { found: false, person: null, contact: null, teams: [] };
  const contact = toContact(r);
  const person = contact.kind === "person" ? { id: contact.id, name: contact.name, status: contact.status } : null;
  // resolve_sender declares at most 50 teams: the first 50 in the stable order of teamsOf (name, id)
  return { found: true, person, contact, teams: hasTeamFacts(contact) ? teamsOf(db, "person", contact.id).slice(0, MAX_TEAMS_PER_ANSWER) : [] };
}

export interface Identities {
  people: { handle: string; channel: HandleChannel; person: Ref }[];
}

export function peopleHandles(db: Db): Identities["people"] {
  return db
    .prepare("SELECT h.handle, p.id, p.name FROM fleet_handles h JOIN fleet_people p ON p.id = h.person_id ORDER BY p.name COLLATE NOCASE, h.handle")
    .all()
    .map((r) => ({ handle: String(r.handle), channel: handleChannel(String(r.handle)) as HandleChannel, person: { id: String(r.id), name: String(r.name) } }));
}

// ── writes (owner, person ops) ─────────────────────────────────────────────────────────────────────────────────

const cleanTags = (t: readonly string[] | undefined) => (t ? [...new Set(t)].sort() : undefined);

export function setTeam(db: Db, input: { id?: string; name: string; description?: string; tags?: string[] }, now = Date.now()): Team {
  return db.transaction(() => {
    const name = input.name.trim();
    if (!name) fail("input_invalid", "name is empty", 400);
    const clash = db.prepare("SELECT id FROM fleet_teams WHERE name = ? COLLATE NOCASE AND id <> ?").get(name, input.id ?? "");
    if (clash) fail("team_name_taken", "another team has this name", 409);
    let id = input.id;
    if (id) {
      const old = db.prepare("SELECT * FROM fleet_teams WHERE id = ?").get(id) ?? fail("team_not_found", "no team with this id", 404);
      db.prepare("UPDATE fleet_teams SET name = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?").run(
        name,
        input.description ?? String(old.description),
        JSON.stringify(cleanTags(input.tags) ?? tags(old.tags)),
        now,
        id,
      );
    } else {
      const count = Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_teams").get()?.n);
      if (count >= LIMITS.teams) fail("limit_reached", `a workspace has at most ${LIMITS.teams} teams`, 409);
      id = `tm_${ulid(now)}`;
      db.prepare("INSERT INTO fleet_teams (id, name, description, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        name,
        input.description ?? "",
        JSON.stringify(cleanTags(input.tags) ?? []),
        now,
        now,
      );
    }
    bump(db);
    return toTeam(db, db.prepare("SELECT * FROM fleet_teams WHERE id = ?").get(id) as Row);
  });
}

export function deleteTeam(db: Db, id: string): boolean {
  return db.transaction(() => {
    db.prepare("DELETE FROM fleet_members WHERE team_id = ?").run(id);
    const gone = db.prepare("DELETE FROM fleet_teams WHERE id = ?").run(id).changes > 0;
    if (gone) bump(db);
    return gone;
  });
}

export interface PersonInput {
  id?: string;
  /** Not an operation input yet (person_set stays as released); the store is ready for outside agents. */
  kind?: ContactKind;
  /** Who creates the entry (default owner). Decides the start trust (`defaultTrust`); ignored on update. */
  source?: Source;
  name: string;
  email?: string | null;
  title?: string;
  status?: PersonStatus;
  tags?: string[];
  handles?: string[];
}

export function setPerson(db: Db, input: PersonInput, now = Date.now()): Person {
  return db.transaction(() => {
    const name = input.name.trim();
    if (!name) fail("input_invalid", "name is empty", 400);
    let handles: string[] | undefined;
    if (input.handles) {
      handles = [];
      for (const raw of input.handles) handles.push(normalizeHandle(raw) ?? fail("handle_invalid", `not a buzz, slack or telegram handle: ${raw.slice(0, 60)}`, 400));
      handles = [...new Set(handles)];
      if (handles.length > LIMITS.handlesPerPerson) fail("input_invalid", `at most ${LIMITS.handlesPerPerson} handles per person`, 400);
    }
    let id = input.id;
    if (id) {
      const old = db.prepare("SELECT * FROM fleet_people WHERE id = ?").get(id) ?? fail("person_not_found", "no person with this id", 404);
      db.prepare("UPDATE fleet_people SET name = ?, email = ?, title = ?, status = ?, kind = ?, tags = ?, updated_at = ? WHERE id = ?").run(
        name,
        input.email === undefined ? old.email : input.email,
        input.title ?? String(old.title),
        input.status ?? String(old.status),
        input.kind ?? String(old.kind),
        JSON.stringify(cleanTags(input.tags) ?? tags(old.tags)),
        now,
        id,
      );
    } else {
      const count = Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_people").get()?.n);
      if (count >= LIMITS.people) fail("limit_reached", `a workspace has at most ${LIMITS.people} people`, 409);
      id = `psn_${ulid(now)}`;
      const source = input.source ?? "owner";
      db.prepare("INSERT INTO fleet_people (id, name, email, title, status, kind, trust, source, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        name,
        input.email ?? null,
        input.title ?? "",
        input.status ?? "active",
        input.kind ?? "person",
        defaultTrust(source),
        source,
        JSON.stringify(cleanTags(input.tags) ?? []),
        now,
        now,
      );
    }
    if (handles) {
      for (const h of handles) {
        const owner = db.prepare("SELECT person_id FROM fleet_handles WHERE handle = ?").get(h);
        if (owner && owner.person_id !== id) fail("handle_taken", `${h} belongs to another person`, 409);
      }
      db.prepare("DELETE FROM fleet_handles WHERE person_id = ?").run(id);
      for (const h of handles) db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES (?, ?, ?)").run(h, id, now);
    }
    bump(db);
    return getPerson(db, id);
  });
}

export function deletePerson(db: Db, id: string): boolean {
  return db.transaction(() => {
    db.prepare("DELETE FROM fleet_members WHERE kind = 'person' AND subject_id = ?").run(id);
    db.prepare("DELETE FROM fleet_handles WHERE person_id = ?").run(id);
    db.prepare("UPDATE fleet_agents SET owner_id = NULL WHERE owner_id = ?").run(id);
    const gone = db.prepare("DELETE FROM fleet_people WHERE id = ?").run(id).changes > 0;
    if (gone) bump(db);
    return gone;
  });
}

export function setMembers(
  db: Db,
  input: { team: string; people: { id: string; role: Role }[]; agents: { id: string; role: Role }[] },
  now = Date.now(),
): TeamDetail {
  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM fleet_teams WHERE id = ?").get(input.team)) fail("team_not_found", "no team with this id", 404);
    for (const p of input.people) if (!db.prepare("SELECT 1 FROM fleet_people WHERE id = ?").get(p.id)) fail("person_not_found", `no person ${p.id}`, 404);
    for (const a of input.agents) if (!db.prepare("SELECT 1 FROM fleet_agents WHERE id = ?").get(a.id)) fail("agent_not_found", `no workspace agent ${a.id}`, 404);
    db.prepare("DELETE FROM fleet_members WHERE team_id = ?").run(input.team);
    const add = db.prepare("INSERT OR REPLACE INTO fleet_members (team_id, kind, subject_id, role, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const p of input.people) add.run(input.team, "person", p.id, p.role, now);
    for (const a of input.agents) add.run(input.team, "agent", a.id, a.role, now);
    db.prepare("UPDATE fleet_teams SET updated_at = ? WHERE id = ?").run(now, input.team);
    bump(db);
    return getTeam(db, input.team);
  });
}

export function setAgent(db: Db, input: { agent: string; owner?: string | null; role?: string; tags?: string[] }, now = Date.now()): Agent {
  return db.transaction(() => {
    const old = db.prepare("SELECT * FROM fleet_agents WHERE id = ?").get(input.agent) ?? fail("agent_not_found", "no workspace agent with this id", 404);
    if (input.owner && !db.prepare("SELECT 1 FROM fleet_people WHERE id = ?").get(input.owner)) fail("person_not_found", "the owner is not in the directory", 404);
    db.prepare("UPDATE fleet_agents SET owner_id = ?, role = ?, tags = ?, updated_at = ? WHERE id = ?").run(
      input.owner === undefined ? old.owner_id : input.owner,
      input.role ?? String(old.role),
      JSON.stringify(cleanTags(input.tags) ?? tags(old.tags)),
      now,
      input.agent,
    );
    bump(db);
    return getAgent(db, input.agent);
  });
}

// ── agents from the instance slice (events.agentsChanged) ──────────────────────────────────────────────────────

/**
 * events.agentsChanged (SDK 0.1.13): the FULL slice agent list (needsAgentDirectory = every workspace agent), once
 * after boot and on every slice whose agents differ. Listed agents are inserted or updated (re-add, rename, pause);
 * agents no longer listed are kept (owner, role, teams stay for a re-add) but marked removed. The revision moves only
 * when something changed. Returns the agents that were never listed before (a re-add is not new).
 */
export function syncAgents(db: Db, agents: readonly Pick<SliceAgent, "id" | "name" | "mode" | "status">[], now = Date.now()): { id: string; name: string }[] {
  return db.transaction(() => {
    let changed = 0;
    const known = new Set(db.prepare("SELECT id FROM fleet_agents").all().map((r) => String(r.id)));
    const created: { id: string; name: string }[] = [];
    const listed = new Set<string>();
    for (const a of agents) {
      listed.add(a.id);
      if (!known.has(a.id)) {
        known.add(a.id);
        created.push({ id: a.id, name: a.name });
      }
      changed += db
        .prepare(
          `INSERT INTO fleet_agents (id, name, mode, status, trust, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, mode = excluded.mode, status = excluded.status, updated_at = excluded.updated_at
           WHERE fleet_agents.name <> excluded.name OR fleet_agents.mode <> excluded.mode OR fleet_agents.status <> excluded.status`,
        )
        .run(a.id, a.name, a.mode, a.status, defaultTrust("owner"), now, now).changes;
    }
    for (const r of db.prepare("SELECT id FROM fleet_agents WHERE status <> 'removed'").all()) {
      if (!listed.has(String(r.id))) changed += db.prepare("UPDATE fleet_agents SET status = 'removed', updated_at = ? WHERE id = ?").run(now, r.id).changes;
    }
    if (changed > 0) bump(db);
    return created;
  });
}

// ── facts for the context hook ─────────────────────────────────────────────────────────────────────────────────

/** Teams of an agent that is in the workspace (a removed agent has none). */
export function agentFacts(db: Db, id: string): { owner: Ref | null; teams: TeamRef[] } {
  const r = db.prepare(`${AGENT_SELECT} WHERE a.id = ? AND a.status <> 'removed'`).get(id);
  if (!r) return { owner: null, teams: [] };
  return { owner: r.owner_id === null ? null : { id: String(r.owner_id), name: String(r.owner_name) }, teams: teamsOf(db, "agent", id) };
}

/** The trust of a workspace agent that is not removed; null for an unknown or removed agent. */
export function agentTrust(db: Db, id: string): Trust | null {
  const r = db.prepare("SELECT trust FROM fleet_agents WHERE id = ? AND status <> 'removed'").get(id);
  return r ? (r.trust as Trust) : null;
}

/** A directory contact by Fleet id → trust + teams (none while departed or blocked); unknown → null. A departed contact still reports its trust. */
export function personFacts(db: Db, id: string): { contact: Contact; teams: TeamRef[] } | null {
  const r = db.prepare("SELECT id, name, status, kind, trust FROM fleet_people WHERE id = ?").get(id);
  if (!r) return null;
  const contact = toContact(r);
  return { contact, teams: hasTeamFacts(contact) ? teamsOf(db, "person", id) : [] };
}
