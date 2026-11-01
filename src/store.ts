// The workspace directory over the app's own tables (migrations/0001_init.sql). Plain functions over the SDK's Db
// handle: handlers and the context hook stay thin, tests run them against the migrated database.
// Harvested from v1 (labs/organization-plane store/types: person + membership subjects "person" | "agent";
// portal Team / Membership / AgentGrant / ExternalIdentity), trimmed to one workspace = one tenant: no companies,
// tenants, roles-per-tenant or license; people are directory entries, never sign-ins (C84).
import { handleChannel, normalizeHandle, ulid } from "@opt2-tealbrick/manifest";
import type { Db, SliceAgent } from "@opt2-tealbrick/miniapp-sdk";
import { appendEvent } from "./lifecycle/events.ts";
import { beforePersonDelete, initPerson, kindChanged, personFloor, setDates, statusRequested } from "./lifecycle/transitions.ts";
import { bump, fail, revision } from "./meta.ts";
import { ownerWithheldFor } from "./plans/guards.ts";
import { endAssignmentsOf } from "./roles/roles.ts";
import { cleanText } from "./text.ts";
import { type ContactKind, defaultTrust, NEW_AGENT_TRUST, type Source, type Trust } from "./trust.ts";

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
  /** owner-side text for an outside agent (the organisation and how you know it); '' when not given */
  org: string;
  relationship: string;
  status: PersonStatus;
  /** owner side only: no agent op reads a Person. Null for an outside agent. */
  lifecycle: "proposed" | "active" | "suspended" | "leaving" | "archived" | null;
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

export { bump, fail, revision };

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────

function handlesOf(db: Db, personId: string): string[] {
  return db
    .prepare("SELECT handle FROM fleet_handles WHERE person_id = ? ORDER BY handle")
    .all(personId)
    .map((r) => String(r.handle));
}

export function teamsOf(db: Db, kind: "person" | "agent", id: string): TeamRef[] {
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
    org: r.org === undefined ? "" : String(r.org),
    relationship: r.relationship === undefined ? "" : String(r.relationship),
    status: r.status as PersonStatus,
    lifecycle: (r.lifecycle ?? null) as Person["lifecycle"],
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
  const h = fleetHandle(handle);
  const r = h
    ? db.prepare("SELECT p.id, p.name, p.status, p.kind, p.trust FROM fleet_handles h JOIN fleet_people p ON p.id = h.person_id WHERE h.handle = ?").get(h)
    : undefined;
  if (!r) return { found: false, person: null, contact: null, teams: [] };
  const contact = toContact(r);
  const person = contact.kind === "person" ? { id: contact.id, name: contact.name, status: contact.status } : null;
  // resolve_sender declares at most 50 teams: the first 50 in the stable order of teamsOf (name, id)
  return { found: true, person, contact, teams: hasTeamFacts(contact) ? teamsOf(db, "person", contact.id).slice(0, MAX_TEAMS_PER_ANSWER) : [] };
}

/** The channels a Governance contact handle may use (the feed schema's handle pattern). manifest 0.1.34+ also knows `email`
 *  (C373 recipients); Governance does not store email handles yet, so person_set refuses them like any other channel. */
export const FLEET_CHANNELS = ["buzz", "slack", "telegram"] as const;
export type FleetChannel = (typeof FLEET_CHANNELS)[number];
/** normalizeHandle limited to FLEET_CHANNELS: the one canonicalizer for every handle Governance stores, matches or accepts. */
export const fleetHandle = (raw: string): string | null => {
  const h = normalizeHandle(raw);
  const c = h === null ? null : handleChannel(h);
  return h !== null && c !== null && (FLEET_CHANNELS as readonly string[]).includes(c) ? h : null;
};

export interface Identities {
  people: { handle: string; channel: FleetChannel; person: Ref }[];
}

export function peopleHandles(db: Db): Identities["people"] {
  return db
    .prepare("SELECT h.handle, p.id, p.name FROM fleet_handles h JOIN fleet_people p ON p.id = h.person_id ORDER BY p.name COLLATE NOCASE, h.handle")
    .all()
    .map((r) => ({ handle: String(r.handle), channel: handleChannel(String(r.handle)) as FleetChannel, person: { id: String(r.id), name: String(r.name) } }));
}

// ── writes (owner, person ops) ─────────────────────────────────────────────────────────────────────────────────

// QA-C373-GV-1 (X-10): owner-typed text is cleaned like agent text (control, bidi and format characters removed), so a
// name can never reorder or hide what the owner, Rules or an agent reads. Cleaned on write; old rows stay as stored.
const own = (s: string): string => cleanText(s);
const ownOpt = (s: string | undefined): string | undefined => (s === undefined ? undefined : cleanText(s));
const cleanTags = (t: readonly string[] | undefined) => (t ? [...new Set(t.map(own).filter((x) => x !== ""))].sort() : undefined);

export function setTeam(db: Db, input: { id?: string; name: string; description?: string; tags?: string[] }, now = Date.now()): Team {
  return db.transaction(() => {
    const name = own(input.name);
    if (!name) fail("input_invalid", "name is empty", 400);
    const clash = db.prepare("SELECT id FROM fleet_teams WHERE name = ? COLLATE NOCASE AND id <> ?").get(name, input.id ?? "");
    if (clash) fail("team_name_taken", "another team has this name", 409);
    let id = input.id;
    if (id) {
      const old = db.prepare("SELECT * FROM fleet_teams WHERE id = ?").get(id) ?? fail("team_not_found", "no team with this id", 404);
      db.prepare("UPDATE fleet_teams SET name = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?").run(
        name,
        ownOpt(input.description) ?? String(old.description),
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
        ownOpt(input.description) ?? "",
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
  /** person_set input since 0.3.1 (the owner form "Add outside agent"). An outside agent the owner adds starts `unreviewed`. */
  kind?: ContactKind;
  org?: string;
  relationship?: string;
  /** Who creates the entry (default owner). Decides the start trust (`defaultTrust`); ignored on update. */
  source?: Source;
  name: string;
  email?: string | null;
  title?: string;
  status?: PersonStatus;
  tags?: string[];
  handles?: string[];
  /** QA D11: the owner read that this name is in the directory, and this is another person. */
  sameName?: boolean;
  /** C383 review: why a handle comes off an entry Rules refuses by its handles. Only a wrong handle: the refusal on that handle ends. It goes on the entry's history. */
  handleFix?: string;
  /** A person's end date (C380 T2-d, a contractor). Saved in the same transaction as the person. A date that has passed is refused; null clears it. Not for an outside agent. */
  validUntil?: string | null;
}

const OWNER = { kind: "owner", id: null } as const;

export function setPerson(db: Db, input: PersonInput, now = Date.now()): Person {
  return db.transaction(() => {
    const name = own(input.name);
    if (!name) fail("input_invalid", "name is empty", 400);
    let handles: string[] | undefined;
    if (input.handles) {
      handles = [];
      for (const raw of input.handles) handles.push(fleetHandle(raw) ?? fail("handle_invalid", `not a buzz, slack or telegram handle: ${raw.slice(0, 60)}`, 400));
      handles = [...new Set(handles)];
      if (handles.length > LIMITS.handlesPerPerson) fail("input_invalid", `at most ${LIMITS.handlesPerPerson} handles per person`, 400);
    }
    let id = input.id;
    if (id) {
      const old = db.prepare("SELECT * FROM fleet_people WHERE id = ?").get(id) ?? fail("person_not_found", "no person with this id", 404);
      // C373e: a person who owns workspace agents cannot become an outside agent (the owner_not_person rule of agent_set)
      if (input.kind && input.kind !== "person" && String(old.kind) === "person" && db.prepare("SELECT 1 FROM fleet_agents WHERE owner_id = ? AND status <> 'removed'").get(id))
        fail("person_owns_agents", "this person owns workspace agents; give the agents another owner first", 409);
      // org and relationship are written only when given (a write without them leaves the stored text alone)
      const extra = input.org !== undefined || input.relationship !== undefined;
      db.prepare(`UPDATE fleet_people SET name = ?, email = ?, title = ?, ${extra ? "org = ?, relationship = ?, " : ""}status = ?, kind = ?, tags = ?, updated_at = ? WHERE id = ?`).run(
        ...([
          name,
          input.email === undefined ? old.email : input.email,
          ownOpt(input.title) ?? String(old.title),
          ...(extra ? [input.org === undefined ? String(old.org) : own(input.org), input.relationship === undefined ? String(old.relationship) : own(input.relationship)] : []),
          // a person's status follows the lifecycle (below); an outside agent has no lifecycle and keeps the plain field
          (input.kind ?? String(old.kind)) === "person" ? String(old.status) : (input.status ?? String(old.status)),
          input.kind ?? String(old.kind),
          JSON.stringify(cleanTags(input.tags) ?? tags(old.tags)),
          now,
          id,
        ] as never[]),
      );
      kindChanged(db, id, name, String(old.kind), input.kind ?? String(old.kind), input.status ?? String(old.status), now);
      if ((input.kind ?? String(old.kind)) === "person" && String(old.kind) === "person" && input.status !== undefined) statusRequested(db, id, input.status, OWNER, now);
    } else {
      const count = Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_people").get()?.n);
      if (count >= LIMITS.people) fail("limit_reached", `a workspace has at most ${LIMITS.people} people`, 409);
      // QA D11: the same name twice made a second person with no word. Two people may share a name, as in Join: different emails say so, or the owner does.
      if ((input.kind ?? "person") === "person" && !input.sameName) {
        const email = input.email?.toLowerCase() ?? null;
        for (const o of db.prepare("SELECT email FROM fleet_people WHERE kind = 'person' AND lower(name) = lower(?)").all(name)) {
          const other = o.email === null ? null : String(o.email).toLowerCase();
          if (email === null || other === null || email === other) fail("person_name_taken", `A person named ${name} is in the directory. To add another person with this name, press Add a second person.`, 409);
        }
      }
      id = `psn_${ulid(now)}`;
      const source = input.source ?? "owner";
      const extra = input.org !== undefined || input.relationship !== undefined;
      db.prepare(`INSERT INTO fleet_people (id, name, email, title, ${extra ? "org, relationship, " : ""}status, kind, trust, source, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ${extra ? "?, ?, " : ""}?, ?, ?, ?, ?, ?, ?)`).run(
        ...([
          id,
          name,
          input.email ?? null,
          ownOpt(input.title) ?? "",
          ...(extra ? [own(input.org ?? ""), own(input.relationship ?? "")] : []),
          (input.kind ?? "person") === "person" ? "active" : (input.status ?? "active"),
          input.kind ?? "person",
          defaultTrust(source, input.kind ?? "person"),
          source,
          JSON.stringify(cleanTags(input.tags) ?? []),
          now,
          now,
        ] as never[]),
      );
      initPerson(db, id, input.kind ?? "person", name, now);
      if ((input.kind ?? "person") === "person" && input.status === "departed") statusRequested(db, id, "departed", OWNER, now);
    }
    if (input.validUntil !== undefined) {
      // After the create or update above, in the same transaction: a refusal leaves no half-added contractor with no end date.
      if (String(db.prepare("SELECT kind FROM fleet_people WHERE id = ?").get(id)?.kind) !== "person") fail("input_invalid", "Only a person has an end date.", 400);
      const ends = input.validUntil === null ? Number.NaN : Date.parse(input.validUntil);
      if (ends <= now) fail("date_in_past", "This end date has passed. Choose a later date.", 409);
      setDates(db, { kind: "person", id, validUntil: input.validUntil, actor: OWNER }, now);
    }
    if (handles) {
      for (const h of handles) {
        const owner = db.prepare("SELECT person_id FROM fleet_handles WHERE handle = ?").get(h);
        if (owner && owner.person_id !== id) fail("handle_taken", `${h} belongs to another person`, 409);
      }
      // C381 lead S3: the floor and the sender bar refuse by handle. Taking one off an entry Rules refuses (a stop, blocked, a start date that has not come) would lift that refusal with no step on record. New handles are welcome.
      // C383 review: a wrong handle may belong to someone who did nothing, and must not wait until the stop ends. The owner says why, and that step is on the record.
      const gone = handlesOf(db, id as string).filter((h) => !(handles as string[]).includes(h));
      if (gone.length > 0 && personFloor(db, id as string)) {
        const why = Array.from(cleanText(input.handleFix ?? "")).slice(0, 200).join("");
        if (why === "") fail("handles_stay", "A handle stays while this person is stopped, leaving, closed, blocked or not started: Rules refuses them by it. If a handle is wrong, say why and save again. You can add a handle without this.", 409);
        const row = db.prepare("SELECT name, kind, lifecycle FROM fleet_people WHERE id = ?").get(id);
        // No handle in the note: the access record lists notes, and it says it lists no handles (N2-T3).
        const channels = [...new Set(gone.map((h) => h.slice(0, h.indexOf(":"))))].join(", ");
        appendEvent(db, { subject: { kind: row?.kind === "person" ? "person" : "outside_agent", id: id as string, name: String(row?.name) }, kind: "changed", from: row?.lifecycle === null ? null : String(row?.lifecycle), to: row?.lifecycle === null ? null : String(row?.lifecycle), actor: OWNER, note: `${gone.length === 1 ? "A wrong handle was" : `${gone.length} wrong handles were`} taken off (${channels}). Why: ${why}`.slice(0, 500), at: now });
      }
      db.prepare("DELETE FROM fleet_handles WHERE person_id = ?").run(id);
      for (const h of handles) db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES (?, ?, ?)").run(h, id, now);
    }
    bump(db);
    return getPerson(db, id);
  });
}

export function deletePerson(db: Db, id: string, now = Date.now()): boolean {
  return db.transaction(() => {
    beforePersonDelete(db, id, OWNER, now);
    endAssignmentsOf(db, "person", id, "deleted", OWNER, now);
    db.prepare("DELETE FROM fleet_members WHERE kind = 'person' AND subject_id = ?").run(id);
    db.prepare("DELETE FROM fleet_handles WHERE person_id = ?").run(id);
    // C381: a delete is an owner change. The record says it, so the key this person may hold shows as a finding, and apps read no later owner until Core replaced the key.
    for (const a of db.prepare("SELECT a.id, a.name, p.name AS owner_name FROM fleet_agents a JOIN fleet_people p ON p.id = a.owner_id WHERE a.owner_id = ? AND a.status <> 'removed'").all(id)) {
      appendEvent(db, { subject: { kind: "agent", id: String(a.id), name: String(a.name) }, kind: "moved", actor: OWNER, note: `Owner changed from ${String(a.owner_name)} to nobody.`.slice(0, 500), snapshot: { before: id, after: null }, at: now });
    }
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
    // only a NEW owner is checked: an unchanged legacy owner (set before 0.3.0) does not block a role or tag edit
    if (input.owner && input.owner !== old.owner_id) {
      const who = db.prepare("SELECT kind FROM fleet_people WHERE id = ?").get(input.owner) ?? fail("person_not_found", "the owner is not in the directory", 404);
      // C373e: an agent's owner is a person; an outside agent cannot own a workspace agent. Rows set before 0.3.0 stay as
      // they are (the feed still carries their owner id; readers check contacts[].kind).
      if (who.kind !== "person") fail("owner_not_person", "the owner must be a person, not an outside agent", 400);
    }
    db.prepare("UPDATE fleet_agents SET owner_id = ?, role = ?, tags = ?, updated_at = ? WHERE id = ?").run(
      input.owner === undefined ? old.owner_id : input.owner,
      ownOpt(input.role) ?? String(old.role),
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
        .run(a.id, a.name, a.mode, a.status, NEW_AGENT_TRUST, now, now).changes;
    }
    for (const r of db.prepare("SELECT id FROM fleet_agents WHERE status <> 'removed'").all()) {
      if (!listed.has(String(r.id))) changed += db.prepare("UPDATE fleet_agents SET status = 'removed', updated_at = ? WHERE id = ?").run(now, r.id).changes;
    }
    if (changed > 0) bump(db);
    return created;
  });
}

// ── facts for the context hook ─────────────────────────────────────────────────────────────────────────────────

/** Owner and teams of an agent that is in the workspace. A removed agent has none; a BLOCKED agent keeps its owner but has no teams (like a blocked contact: facts narrow, never widen). */
export function agentFacts(db: Db, id: string): { owner: Ref | null; teams: TeamRef[] } {
  const r = db.prepare(`${AGENT_SELECT} WHERE a.id = ? AND a.status <> 'removed'`).get(id);
  if (!r) return { owner: null, teams: [] };
  // C381: an old key may run this agent, so no app reads the new owner as its owner yet.
  return { owner: r.owner_id === null || ownerWithheldFor(db, id) ? null : { id: String(r.owner_id), name: String(r.owner_name) }, teams: r.trust === "blocked" ? [] : teamsOf(db, "agent", id).slice(0, MAX_TEAMS_PER_ANSWER) };
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
