// Workspace settings of the lifecycle (table fleet_settings) and the default owner. An unowned agent takes the default owner
// (shown, editable, one event per agent); it is never paused for having no owner.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { bump, fail } from "../meta.ts";
import { appendEvent } from "./events.ts";

const read = (db: Db, key: string): string | null => {
  const v = db.prepare("SELECT value FROM fleet_settings WHERE key = ?").get(key)?.value;
  return v === undefined || v === null ? null : String(v);
};
const write = (db: Db, key: string, value: string): void => {
  db.prepare("INSERT INTO fleet_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
};

export const coolingDays = (db: Db): number => Number(read(db, "cooling_days") ?? 30);
export const stopCap = (db: Db): number => Number(read(db, "stop_cap") ?? 5);

export interface Settings {
  coolingDays: number;
  defaultOwner: { id: string; name: string } | null;
  stopCap: number;
}

export function getSettings(db: Db): Settings {
  const id = read(db, "default_owner");
  const p = id ? db.prepare("SELECT id, name FROM fleet_people WHERE id = ?").get(id) : undefined;
  return { coolingDays: coolingDays(db), defaultOwner: p ? { id: String(p.id), name: String(p.name) } : null, stopCap: stopCap(db) };
}

function activeDefaultOwner(db: Db): { id: string; name: string } | null {
  const id = read(db, "default_owner");
  if (!id) return null;
  const p = db.prepare("SELECT id, name FROM fleet_people WHERE id = ? AND kind = 'person' AND lifecycle = 'active'").get(id);
  return p ? { id: String(p.id), name: String(p.name) } : null;
}

/** Unowned agents with a card take the default owner. Skipped while that person is not active. Returns how many. */
export function assignDefaultOwner(db: Db, actor: { kind: "owner" | "system"; id: string | null }, now = Date.now()): number {
  return db.transaction(() => {
    const owner = activeDefaultOwner(db);
    if (!owner) return 0;
    const rows = db.prepare("SELECT id, name FROM fleet_agents WHERE owner_id IS NULL AND status <> 'removed' AND lifecycle <> 'archived' ORDER BY id").all();
    for (const a of rows) {
      db.prepare("UPDATE fleet_agents SET owner_id = ?, updated_at = ? WHERE id = ?").run(owner.id, now, a.id);
      appendEvent(db, { subject: { kind: "agent", id: String(a.id), name: String(a.name) }, kind: "moved", actor, note: `Default owner: ${owner.name}.`.slice(0, 500), at: now });
    }
    if (rows.length > 0) bump(db);
    return rows.length;
  });
}

export function setSettings(db: Db, input: { coolingDays?: number | undefined; defaultOwner?: string | null | undefined }, actor: { kind: "owner"; id: string }, now = Date.now()): { settings: Settings; assigned: number } {
  return db.transaction(() => {
    if (input.coolingDays !== undefined) {
      if (!Number.isInteger(input.coolingDays) || input.coolingDays < 1 || input.coolingDays > 365) fail("input_invalid", "The cooling period must be 1 to 365 days.", 400);
      write(db, "cooling_days", String(input.coolingDays));
    }
    if (input.defaultOwner === null) db.prepare("DELETE FROM fleet_settings WHERE key = 'default_owner'").run();
    else if (input.defaultOwner !== undefined) {
      const p = db.prepare("SELECT kind, lifecycle FROM fleet_people WHERE id = ?").get(input.defaultOwner) ?? fail("person_not_found", "The default owner is not in the directory.", 404);
      if (p.kind !== "person") fail("owner_not_person", "The owner must be a person, not an outside agent.", 400);
      if (p.lifecycle !== "active") fail("owner_inactive", "The default owner must be an active person.", 409);
      write(db, "default_owner", input.defaultOwner);
    }
    const assigned = input.defaultOwner ? assignDefaultOwner(db, actor, now) : 0;
    return { settings: getSettings(db), assigned };
  });
}
