// A mover (C380, DESIGN-C380 §2): a team change or an owner change writes one `moved` event with what was before and after, and opens
// one system review. It grants and removes nothing else.
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { fail } from "../meta.ts";
import { requestSystemReview } from "../reviews.ts";
import * as store from "../store.ts";
import { appendEvent } from "./events.ts";
import { clearAgentKeep } from "./transitions.ts";

type Actor = { kind: "owner"; id: string | null };
type Key = `${"person" | "agent"}:${string}`;

function membersOf(db: Db, team: string): Map<Key, string> {
  const out = new Map<Key, string>();
  for (const m of db.prepare("SELECT kind, subject_id, role FROM fleet_members WHERE team_id = ?").all(team)) out.set(`${m.kind as "person" | "agent"}:${String(m.subject_id)}`, String(m.role));
  return out;
}

/** members_set with a `moved` event and a system review per subject whose membership changed. One transaction. */
export function setMembersMoved(db: Db, input: Parameters<typeof store.setMembers>[1], actor: Actor, now = Date.now()) {
  return db.transaction(() => {
    const before = membersOf(db, input.team);
    const team = store.setMembers(db, input, now);
    const after = membersOf(db, input.team);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(key) ?? null;
      const a = after.get(key) ?? null;
      if (b === a) continue;
      const [kind, id] = key.split(":") as ["person" | "agent", string];
      const row = kind === "agent" ? db.prepare("SELECT name FROM fleet_agents WHERE id = ?").get(id) : db.prepare("SELECT name, kind FROM fleet_people WHERE id = ?").get(id);
      if (!row) continue;
      const subjectKind = kind === "agent" ? "agent" : row.kind === "outside_agent" ? "outside_agent" : "person";
      const note = a === null ? `Left team ${team.name}.` : b === null ? `Joined team ${team.name}.` : `Role in team ${team.name} is now ${a}.`;
      appendEvent(db, { subject: { kind: subjectKind, id, name: String(row.name) }, kind: "moved", actor, note: note.slice(0, 500), snapshot: { team: team.id, before: b, after: a } as Json, at: now });
      requestSystemReview(db, subjectKind, id, note, now);
    }
    return team;
  });
}

/**
 * agent_set: a new owner must be an active person. An owner change writes a `moved` event, ends the keep-running tick and opens a system review.
 * From an owner who is stopped it is a transfer, or nothing (N2-1): it lifts the stop, and the leaver may hold the agent's key. Only the plan's choice passes `transfer: true`, because that draft replaces the key.
 */
export function setAgentMoved(db: Db, input: Parameters<typeof store.setAgent>[1], actor: Actor, now = Date.now(), opts: { transfer?: boolean } = {}) {
  return db.transaction(() => {
    const old = db.prepare("SELECT a.owner_id, p.name AS owner_name FROM fleet_agents a LEFT JOIN fleet_people p ON p.id = a.owner_id WHERE a.id = ?").get(input.agent);
    const changing = input.owner !== undefined && old !== undefined && input.owner !== old.owner_id;
    if (changing && input.owner) {
      const who = db.prepare("SELECT kind, lifecycle FROM fleet_people WHERE id = ?").get(input.owner);
      if (who && who.kind === "person" && who.lifecycle !== "active") fail("owner_inactive", "The new owner must be an active person.", 409);
    }
    // Taking the owner away would lift the stop that comes from a stopped owner, with no guard. A transfer names an active owner instead.
    if (changing && input.owner === null && old?.owner_id !== null) {
      const cur = db.prepare("SELECT lifecycle FROM fleet_people WHERE id = ?").get(old?.owner_id as string)?.lifecycle;
      if (cur === "suspended" || cur === "leaving" || cur === "archived") fail("owner_stopped", "The owner is stopped. Name an active owner: taking the owner away would end the stop.", 409);
    }
    if (changing && input.owner && old?.owner_id !== null && !opts.transfer) {
      const cur = db.prepare("SELECT lifecycle FROM fleet_people WHERE id = ?").get(old?.owner_id as string)?.lifecycle;
      // An agent with its own stop stays stopped under any owner: this lifts nothing, and it is how such an agent finds an active owner.
      const own = db.prepare("SELECT lifecycle FROM fleet_agents WHERE id = ?").get(input.agent)?.lifecycle;
      const ownStop = own === "suspended" || own === "leaving" || own === "archived";
      if (!ownStop && (cur === "suspended" || cur === "leaving" || cur === "archived")) fail("use_transfer", "The owner is stopped, and may hold this agent's key. Use Stop and remove access, and choose Move to a new owner: it replaces the key.", 409);
    }
    const agent = store.setAgent(db, input, now);
    if (changing) {
      clearAgentKeep(db, agent.id);
      const from = old?.owner_name === null || old?.owner_name === undefined ? "nobody" : String(old.owner_name);
      const to = agent.owner?.name ?? "nobody";
      const note = `Owner changed from ${from} to ${to}.`;
      appendEvent(db, { subject: { kind: "agent", id: agent.id, name: agent.name }, kind: "moved", actor, note: note.slice(0, 500), snapshot: { before: old?.owner_id === undefined ? null : (old.owner_id as Json), after: agent.owner?.id ?? null } as Json, at: now });
      requestSystemReview(db, "agent", agent.id, note, now);
    }
    return agent;
  });
}
