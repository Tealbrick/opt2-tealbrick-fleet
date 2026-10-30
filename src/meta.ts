// The feed revision and the one error helper. No imports from the domain files, so src/lifecycle/ and src/store.ts can both use them.
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";

export function revision(db: Db): number {
  return Number(db.prepare("SELECT value FROM fleet_meta WHERE key = 'revision'").get()?.value ?? 0);
}

export function bump(db: Db): void {
  db.prepare("UPDATE fleet_meta SET value = value + 1 WHERE key = 'revision'").run();
}

export const fail = (code: string, message: string, status: number): never => {
  throw new TbError(code, message, status);
};
