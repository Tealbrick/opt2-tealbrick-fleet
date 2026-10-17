// A directory at the limits of one workspace, for the size and time budgets (feed, lean views, hook).
import { npubFromHex, ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import * as store from "../src/store.ts";
import { migratedDb } from "./helpers.ts";

/** 500 teams, 2000 people, 500 agents, 12 members per team, 2 handles per person (the limits of one workspace). */
export function bigDirectory(): { db: Db; contactIds: string[]; agentIds: string[]; slackOf: (i: number) => string } {
  const db = migratedDb();
  const now = Date.now();
  const contactIds: string[] = [];
  const agentIds: string[] = [];
  const slackOf = (i: number) => `slack:U${String(i).padStart(7, "0")}`;
  db.transaction(() => {
    const person = db.prepare("INSERT INTO fleet_people (id, name, email, title, status, kind, trust, source, tags, created_at, updated_at) VALUES (?, ?, ?, 'Title', ?, ?, ?, 'owner', '[\"t\"]', ?, ?)");
    const handle = db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES (?, ?, ?)");
    for (let i = 0; i < store.LIMITS.people; i++) {
      const id = `psn_${ulid(now + i)}`;
      contactIds.push(id);
      person.run(id, `Person ${i}`, `p${i}@example.com`, i % 17 === 0 ? "departed" : "active", i % 11 === 0 ? "outside_agent" : "person", (["unreviewed", "trusted", "limited", "blocked"] as const)[i % 4], now, now);
      handle.run(slackOf(i), id, now);
      handle.run(`buzz:${npubFromHex(i.toString(16).padStart(64, "0"))}`, id, now);
    }
    const agent = db.prepare("INSERT INTO fleet_agents (id, name, mode, status, owner_id, trust, first_seen, updated_at) VALUES (?, ?, 'free', 'active', ?, 'trusted', ?, ?)");
    for (let i = 0; i < 500; i++) {
      const id = `agt_${ulid(now + i)}`;
      agentIds.push(id);
      agent.run(id, `Agent ${i}`, contactIds[i] ?? null, now, now);
    }
    const team = db.prepare("INSERT INTO fleet_teams (id, name, description, tags, created_at, updated_at) VALUES (?, ?, '', '[]', ?, ?)");
    const member = db.prepare("INSERT INTO fleet_members (team_id, kind, subject_id, role, created_at) VALUES (?, ?, ?, ?, ?)");
    for (let t = 0; t < store.LIMITS.teams; t++) {
      const id = `tm_${ulid(now + t)}`;
      team.run(id, `Team ${t}`, now, now);
      for (let k = 0; k < 10; k++) member.run(id, "person", contactIds[(t * 4 + k) % contactIds.length], k === 0 ? "lead" : "member", now);
      for (let k = 0; k < 2; k++) member.run(id, "agent", agentIds[(t + k) % agentIds.length], "member", now);
    }
    db.prepare("UPDATE fleet_meta SET value = 1234 WHERE key = 'revision'").run();
  });
  return { db, contactIds, agentIds, slackOf };
}

