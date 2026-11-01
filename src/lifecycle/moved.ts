// A mover (C380, DESIGN-C380 §2): a team change or an owner change writes one `moved` event with what was before and after, and opens
// one system review. It grants and removes nothing else.
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { fail } from "../meta.ts";
import { stopInOwnersPlan } from "../plans/guards.ts";
import { requestSystemReview } from "../reviews.ts";
import { heldRoleNames } from "../roles/roles.ts";
import * as store from "../store.ts";
import { appendEvent } from "./events.ts";

type Actor = { kind: "owner"; id: string | null };
type Key = `${"person" | "agent"}:${string}`;

function membersOf(db: Db, team: string): Map<Key, string> {
  const out = new Map<Key, string>();
  for (const m of db.prepare("SELECT kind, subject_id, role FROM fleet_members WHERE team_id = ?").all(team)) out.set(`${m.kind as "person" | "agent"}:${String(m.subject_id)}`, String(m.role));
  return out;
}

const agentsIn = (db: Db, team: string): string[] =>
  db.prepare("SELECT a.name FROM fleet_members m JOIN fleet_agents a ON a.id = m.subject_id WHERE m.team_id = ? AND m.kind = 'agent' AND a.status <> 'removed' ORDER BY a.name COLLATE NOCASE, a.id").all(team).map((r) => String(r.name));

const namesLine = (names: readonly string[]): string => (names.length === 0 ? "No agent is in this team." : `Agents in this team: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` and ${names.length - 8} more` : ""}.`);

/** What a person's teams and roles reach (C381): a person's change changes what this list says. Rules decides from it, so it is what they may reach, not what they did. */
export function reachOf(db: Db, personId: string): { kind: "team" | "role"; name: string; agents: string[]; more: number }[] {
  const teams = db.prepare("SELECT t.id, t.name FROM fleet_members m JOIN fleet_teams t ON t.id = m.team_id WHERE m.kind = 'person' AND m.subject_id = ? ORDER BY t.name COLLATE NOCASE, t.id LIMIT 50").all(personId);
  return [
    ...teams.map((t) => {
      const names = agentsIn(db, String(t.id));
      return { kind: "team" as const, name: String(t.name), agents: names.slice(0, 20), more: Math.max(0, names.length - 20) };
    }),
    ...heldRoleNames(db, personId).map((name) => ({ kind: "role" as const, name, agents: [], more: 0 })),
  ];
}

export interface Mover {
  name: string;
  gains: string | null;
  loses: string | null;
}

/** members_set with a `moved` event and a system review per subject whose membership changed. One transaction. A person's row says what they gain and lose (C381). */
export function setMembersMoved(db: Db, input: Parameters<typeof store.setMembers>[1], actor: Actor, now = Date.now()) {
  return db.transaction(() => {
    const before = membersOf(db, input.team);
    const team = store.setMembers(db, input, now);
    const after = membersOf(db, input.team);
    const agents = agentsIn(db, input.team);
    const movers: Mover[] = [];
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(key) ?? null;
      const a = after.get(key) ?? null;
      if (b === a) continue;
      const [kind, id] = key.split(":") as ["person" | "agent", string];
      const row = kind === "agent" ? db.prepare("SELECT name FROM fleet_agents WHERE id = ?").get(id) : db.prepare("SELECT name, kind FROM fleet_people WHERE id = ?").get(id);
      if (!row) continue;
      const subjectKind = kind === "agent" ? "agent" : row.kind === "outside_agent" ? "outside_agent" : "person";
      const place = a === null ? `Left team ${team.name}.` : b === null ? `Joined team ${team.name}.` : `Role in team ${team.name} is now ${a}.`;
      const person = subjectKind === "person";
      const note = person && (a === null || b === null) ? `${place} ${namesLine(agents)}` : place;
      if (person && (a === null || b === null)) movers.push({ name: String(row.name), gains: b === null ? `team ${team.name}. ${namesLine(agents)}` : null, loses: a === null ? `team ${team.name}. ${namesLine(agents)}` : null });
      appendEvent(db, { subject: { kind: subjectKind, id, name: String(row.name) }, kind: "moved", actor, note: note.slice(0, 500), snapshot: { team: team.id, before: b, after: a } as Json, at: now });
      requestSystemReview(db, subjectKind, id, note.slice(0, 500), now);
    }
    return { team, movers };
  });
}

/**
 * agent_set: a new owner must be an active person. An owner change writes a `moved` event and opens a system review. C381: it lifts and starts nothing: an agent's state is its own.
 * N2-1, D16: the old owner may hold this agent's key. So any change from someone raises `key_after_transfer` until Core has replaced the key.
 */
export function setAgentMoved(db: Db, input: Parameters<typeof store.setAgent>[1], actor: Actor, now = Date.now()) {
  return db.transaction(() => {
    const old = db.prepare("SELECT a.owner_id, p.name AS owner_name FROM fleet_agents a LEFT JOIN fleet_people p ON p.id = a.owner_id WHERE a.id = ?").get(input.agent);
    const changing = input.owner !== undefined && old !== undefined && input.owner !== old.owner_id;
    if (changing && input.owner) {
      const who = db.prepare("SELECT kind, lifecycle, trust FROM fleet_people WHERE id = ?").get(input.owner);
      if (who && who.kind === "person" && (who.lifecycle !== "active" || who.trust === "blocked")) fail("owner_inactive", "The new owner must be an active person who is not blocked.", 409);
    }
    // A new plan of the old owner would replace the draft and drop this agent's removal with no word. Same for a new owner: the stop stands in that plan.
    if (changing) {
      const planOf = stopInOwnersPlan(db, input.agent);
      if (planOf !== null) fail("plan_open", `A plan on the page of ${planOf} holds this agent's stop. Cancel that plan first.`, 409);
    }
    const agent = store.setAgent(db, input, now);
    if (changing) {
      const from = old?.owner_name === null || old?.owner_name === undefined ? "nobody" : String(old.owner_name);
      const to = agent.owner?.name ?? "nobody";
      const note = `Owner changed from ${from} to ${to}.`;
      appendEvent(db, { subject: { kind: "agent", id: agent.id, name: agent.name }, kind: "moved", actor, note: note.slice(0, 500), snapshot: { before: old?.owner_id === undefined ? null : (old.owner_id as Json), after: agent.owner?.id ?? null } as Json, at: now });
      requestSystemReview(db, "agent", agent.id, note, now);
    }
    return agent;
  });
}
