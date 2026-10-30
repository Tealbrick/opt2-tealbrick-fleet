// The seeded directory of the Governance tests: PII in the owner-side fields, an outside agent, a departed person,
// an entry an agent added. Used by the feed, lean-view and review tests.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import * as store from "../src/store.ts";
import { AGENT_A, AGENT_B, NOSTR } from "./helpers.ts";

// Strings that exist in the seed and must never reach an app (C88, FLT-01).
export const SECRETS = ["ann@example.com", "Chief Secret Officer", "vip-tag", "internal-only description", "secret-tag", "Ann Example", "Support", "Agent A", "triage-role", "Partner Org Ltd", "secret-relationship"];

/** A realistic directory: PII in the owner-side fields, an outside agent, a departed person, an agent-added entry. */
export function seed(db: Db) {
  store.syncAgents(db, [AGENT_A, AGENT_B, { id: "agt_01J0000000000000000000000C", name: "Agent C", mode: "free", status: "active" }]);
  store.syncAgents(db, [AGENT_A, { ...AGENT_B, status: "paused" }]); // C is removed
  db.exec("UPDATE fleet_agents SET trust = 'trusted'"); // the owner has accepted these agents (a new slice agent starts unreviewed)
  const ann = store.setPerson(db, {
    name: "Ann Example",
    email: "ann@example.com",
    title: "Chief Secret Officer",
    tags: ["vip-tag"],
    handles: [`buzz:${NOSTR.hex}`, "slack:u012abcdef", "telegram:123456"], // stored canonical: npub, U012ABCDEF, 123456
  });
  const bo = store.setPerson(db, { name: "Bo", email: "bo@example.com", status: "departed", handles: ["telegram:-1001234567890"] });
  // a database as 0.3.0 left it (migrations before 0007) has no org column
  const hasOrg = db.prepare("PRAGMA table_info(fleet_people)").all().some((c) => c.name === "org");
  const bot = store.setPerson(db, { name: "Outside Bot", kind: "outside_agent", ...(hasOrg ? { org: "Partner Org Ltd", relationship: "secret-relationship" } : {}), handles: ["slack:W0BOT123"] });
  db.prepare("UPDATE fleet_people SET trust = 'trusted' WHERE id = ?").run(bot.id); // the owner reviewed it (an owner-added outside agent starts unreviewed since 0.3.1)
  const cy = store.setPerson(db, { name: "Cy", source: "agent", handles: ["slack:UCY00001"] });
  const support = store.setTeam(db, { name: "Support", description: "internal-only description", tags: ["secret-tag"] });
  const ops = store.setTeam(db, { name: "Ops" });
  store.setMembers(db, { team: support.id, people: [{ id: ann.id, role: "lead" }, { id: bot.id, role: "member" }], agents: [{ id: AGENT_A.id, role: "member" }] });
  store.setMembers(db, { team: ops.id, people: [{ id: cy.id, role: "member" }], agents: [{ id: AGENT_B.id, role: "lead" }] });
  store.setAgent(db, { agent: AGENT_A.id, owner: ann.id, role: "triage-role", tags: ["vip-tag"] });
  return { ann, bo, bot, cy, support, ops };
}

/**
 * Rows for a database of an EARLIER schema (a migration test): raw SQL, because src/store.ts writes the current schema. The columns of migrations 0001 and 0002 only.
 */
export function seedOldSchema(db: Db): void {
  db.exec(`
    INSERT INTO fleet_people (id, name, email, title, status, kind, trust, source, tags, created_at, updated_at) VALUES ('psn_ann', 'Ann Example', 'ann@example.com', '', 'active', 'person', 'trusted', 'owner', '[]', 1, 2);
    INSERT INTO fleet_handles (handle, person_id, created_at) VALUES ('slack:U012ABCDEF', 'psn_ann', 1);
    INSERT INTO fleet_agents (id, name, mode, status, owner_id, role, tags, trust, first_seen, updated_at) VALUES ('${AGENT_A.id}', 'Agent A', 'free', 'active', 'psn_ann', '', '[]', 'trusted', 1, 2), ('${AGENT_B.id}', 'Agent B', 'bound', 'paused', NULL, '', '[]', 'trusted', 1, 2);
    INSERT INTO fleet_teams (id, name, description, tags, created_at, updated_at) VALUES ('tm_support', 'Support', '', '[]', 1, 2);
    INSERT INTO fleet_members (team_id, kind, subject_id, role, created_at) VALUES ('tm_support', 'person', 'psn_ann', 'lead', 1);
    UPDATE fleet_meta SET value = value + 5 WHERE key = 'revision';`);
}
