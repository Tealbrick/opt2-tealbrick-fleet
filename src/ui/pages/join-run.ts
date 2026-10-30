// Sends what Join checked (C380 T2-d): one person_set per person, in order, then ONE members_set for the team. No React.
// - Each person_set carries its own idempotency key, kept for a retry: if an answer was lost, the retry gets the old answer and
//   no second person is made. A refused row (a handle that belongs to someone else) is shown with the server's own sentence.
// - The end date goes in the same person_set (src/store.ts): a contractor is never added without the date.
// - The team step reads the team again right before it and adds to it. members_set replaces the whole list, so the team is
//   read in the same call, never from an old page.
// - Three failures in a row stop the run: the rest is "not tried", not "failed". The owner can send again; rows that went through
//   are never sent twice.
import type { OverviewGetOutput, PersonSetInput } from "#kit";
import { CONTRACTOR_TAG, type Row } from "./join-input.ts";

export interface Options {
  /** team id or null */
  team: string | null;
  contractor: boolean;
  /** the end date as an instant (lastDayInstant), or null */
  until: string | null;
}
export type RowState = { state: "added"; id: string } | { state: "failed"; message: string } | { state: "not_tried" };
export interface Deps {
  call<T>(op: string, input: unknown, key: string): Promise<T>;
  /** the plain sentence for an error */
  say(e: unknown): string;
}
export type TeamState = { state: "none" } | { state: "added"; name: string } | { state: "failed"; message: string };
export interface Run {
  batch: string;
  rows: Map<number, RowState>;
  team: TeamState;
  teamTries: number;
}

export const newRun = (batch: string): Run => ({ batch, rows: new Map(), team: { state: "none" }, teamTries: 0 });

const STOP_AFTER = 3;
const keyOf = (run: Run, line: number) => `join-${run.batch}-${line}`;

/** The person_set input of one row. */
export function inputOf(r: Row, o: Options): PersonSetInput {
  const input: PersonSetInput = { name: r.name, handles: r.handles, tags: o.contractor ? [CONTRACTOR_TAG] : [] };
  if (r.email) input.email = r.email;
  if (r.title) input.title = r.title;
  if (o.until) input.validUntil = o.until;
  return input;
}

/** Sends every row that is not added yet. Safe to call again with the same run. */
export async function sendPeople(run: Run, rows: readonly Row[], o: Options, deps: Deps, onProgress?: () => void): Promise<void> {
  let failures = 0;
  for (const r of rows) {
    if (r.problem || r.already) continue;
    if (run.rows.get(r.line)?.state === "added") continue;
    if (failures >= STOP_AFTER) {
      run.rows.set(r.line, { state: "not_tried" });
      continue;
    }
    try {
      const out = await deps.call<{ person: { id: string } }>("person_set", inputOf(r, o), keyOf(run, r.line));
      run.rows.set(r.line, { state: "added", id: out.person.id });
      failures = 0;
    } catch (e) {
      run.rows.set(r.line, { state: "failed", message: deps.say(e) });
      failures++;
    }
    onProgress?.();
  }
}

export const addedIds = (run: Run): string[] => [...run.rows.values()].flatMap((s) => (s.state === "added" ? [s.id] : []));

/** Adds the people who were added to the team. Reads the team first. A failure keeps the people and says so; send again repeats only this. */
export async function sendTeam(run: Run, o: Options, deps: Deps): Promise<void> {
  if (!o.team) {
    run.team = { state: "none" };
    return;
  }
  const ids = addedIds(run);
  if (ids.length === 0) return;
  run.teamTries++;
  try {
    const dir = await deps.call<OverviewGetOutput>("overview_get", {}, `join-${run.batch}-dir-${run.teamTries}`);
    const team = dir.teams.find((t) => t.id === o.team);
    if (!team) {
      run.team = { state: "failed", message: "This team is gone. Choose a team on the People page." };
      return;
    }
    const members = team.members ?? [];
    const people = members.filter((m) => m.kind === "person").map((m) => ({ id: m.id, role: m.role }));
    const agents = members.filter((m) => m.kind === "agent").map((m) => ({ id: m.id, role: m.role }));
    const have = new Set(people.map((p) => p.id));
    for (const id of ids) if (!have.has(id)) people.push({ id, role: "member" as const });
    // a new key per try: the list differs from try to try, and an old answer must not stand in for it
    await deps.call("members_set", { team: team.id, people, agents }, `join-${run.batch}-team-${run.teamTries}`);
    run.team = { state: "added", name: team.name };
  } catch (e) {
    run.team = { state: "failed", message: deps.say(e) };
  }
}

export const counts = (run: Run) => {
  const all = [...run.rows.values()];
  return { added: all.filter((s) => s.state === "added").length, failed: all.filter((s) => s.state === "failed").length, notTried: all.filter((s) => s.state === "not_tried").length };
};
