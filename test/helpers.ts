// Test helpers: a migrated in-memory database shaped like the SDK's Db handle (the SDK gives handlers the same
// interface), with real transactions so a refused write leaves nothing behind.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";

export function migratedDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  let depth = 0;
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql) as unknown as ReturnType<Db["prepare"]>,
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      raw.exec("BEGIN");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
  };
}

/** NIP-19 example key: hex and npub of the same public key. */
export const NOSTR = {
  hex: "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
  npub: "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6",
} as const;

export const AGENT_A = { id: "agt_01J0000000000000000000000A", name: "Agent A", mode: "free", status: "active" } as const;
export const AGENT_B = { id: "agt_01J0000000000000000000000B", name: "Agent B", mode: "bound", status: "active" } as const;
