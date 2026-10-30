// What the owner types or pastes for Join (C380 T2-d), checked before anything is sent. No React, no network: one place for the rules of
// one person, the pasted list and the last day, so the single form, the list and the tests agree. The server checks everything again
// (src/store.ts): this only says early, in plain words, what it would refuse.
//
// A pasted line is one person: name, email, title and channel handles in any order, split by tabs (a spreadsheet) or commas. Each
// cell is told by its shape, never by its column: an email has an @, a handle starts with buzz:, slack: or telegram:, the first
// other cell is the name, the next is the title.

export const LIMITS = { rows: 100, name: 120, title: 120, email: 200, handles: 10 } as const;

const HANDLE = /^(buzz|slack|telegram):\S+$/i;
const EMAIL = /^[^@\s]+@[^@\s]+$/;
const HEADER_WORDS = new Set(["name", "email", "e-mail", "title", "handle", "handles", "channel", "channels"]);

export interface Draft {
  /** 1-based line of the paste, 0 for the single form */
  line: number;
  name: string;
  email: string | null;
  title: string;
  handles: string[];
}
export type Row = Draft & {
  /** null = ready to add */
  problem: string | null;
  /** the directory already has this person: not added again, never changed here */
  already: string | null;
};
export interface Parsed {
  rows: Row[];
  /** the first line was a header and was left out */
  header: boolean;
  /** more lines than one paste takes: the rest were not read */
  cut: boolean;
}
export interface Known {
  name: string;
  email: string | null;
  handles: readonly string[];
}

const fold = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const unquote = (s: string) => s.trim().replace(/^"(.*)"$/s, "$1").trim();
const isHandles = (cell: string) => cell.split(/[\s;]+/).filter(Boolean).every((t) => HANDLE.test(t));

/** The problem with one person, in plain words, or null. The server's limits (manifest person_set). */
export function problemOf(d: Pick<Draft, "name" | "email" | "title" | "handles">): string | null {
  if (!d.name) return "There is no name.";
  if (d.name.length > LIMITS.name) return `The name is longer than ${LIMITS.name} characters.`;
  if (d.title.length > LIMITS.title) return `The title is longer than ${LIMITS.title} characters.`;
  if (d.email !== null && (d.email.length > LIMITS.email || !EMAIL.test(d.email))) return "The email does not look right.";
  if (d.handles.length > LIMITS.handles) return `A person has at most ${LIMITS.handles} channel handles.`;
  return null;
}

/** One line. A cell it cannot place makes the line a problem: it is shown and never guessed. */
function parseLine(text: string, line: number): Row {
  const draft: Draft = { line, name: "", email: null, title: "", handles: [] };
  let problem: string | null = null;
  const cells = (text.includes("\t") ? text.split("\t") : text.split(",")).map(unquote).filter(Boolean);
  for (const cell of cells) {
    if (isHandles(cell)) draft.handles.push(...cell.split(/[\s;]+/).filter(Boolean));
    else if (EMAIL.test(cell) && !/\s/.test(cell)) {
      if (draft.email !== null) problem ??= "There is more than one email.";
      else draft.email = cell;
    } else if (/^(buzz|slack|telegram):/i.test(cell)) problem ??= `This handle has a space or no value: ${cell.slice(0, 40)}`;
    else if (!draft.name) draft.name = cell;
    else if (!draft.title) draft.title = cell;
    else problem ??= `This part does not fit a name, email, title or handle: ${cell.slice(0, 40)}`;
  }
  draft.handles = [...new Set(draft.handles.map((h) => h.replace(/^(buzz|slack|telegram):/i, (p) => p.toLowerCase())))];
  return { ...draft, problem: problem ?? problemOf(draft), already: null };
}

export function parsePastedList(text: string): Parsed {
  const lines = text
    .split(/\r?\n/)
    .map((raw, i) => ({ raw, line: i + 1 }))
    .filter((l) => l.raw.replace(/[\s,;"]/g, "") !== ""); // an empty spreadsheet row (",,,") is a blank line, not a person with no name
  let header = false;
  const first = lines[0];
  if (first) {
    const cells = first.raw.split(/\t|,/).map((c) => fold(unquote(c))).filter(Boolean);
    if (cells.length > 0 && cells.every((c) => HEADER_WORDS.has(c))) {
      header = true;
      lines.shift();
    }
  }
  const cut = lines.length > LIMITS.rows;
  return { rows: lines.slice(0, LIMITS.rows).map((l) => parseLine(l.raw, l.line)), header, cut };
}

/**
 * Marks a row `already` when the directory has the same email, the same handle or the same name, and a row after the first of the
 * same person inside the paste a problem. A person who is already there is never changed by a paste: it would be a way to move a
 * handle from one person to another by accident (the server refuses that too: handle_taken).
 */
export function checkAgainst(rows: readonly Row[], known: readonly Known[]): Row[] {
  const names = new Map<string, string>();
  const emails = new Map<string, string>();
  const handles = new Map<string, string>();
  for (const k of known) {
    names.set(fold(k.name), k.name);
    if (k.email) emails.set(fold(k.email), k.name);
    for (const h of k.handles) handles.set(h.toLowerCase(), k.name);
  }
  const seen = { name: new Map<string, number>(), email: new Map<string, number>(), handle: new Map<string, number>() };
  return rows.map((r) => {
    if (r.problem) return { ...r, already: null };
    const same = (r.email && emails.get(fold(r.email))) || r.handles.map((h) => handles.get(h.toLowerCase())).find(Boolean) || names.get(fold(r.name)) || null;
    if (same) return { ...r, already: `${same} is in the directory already.` };
    const twin = (r.email ? seen.email.get(fold(r.email)) : undefined) ?? r.handles.map((h) => seen.handle.get(h.toLowerCase())).find((n) => n !== undefined) ?? seen.name.get(fold(r.name));
    if (twin !== undefined) return { ...r, problem: `Same person as line ${twin}.`, already: null };
    seen.name.set(fold(r.name), r.line);
    if (r.email) seen.email.set(fold(r.email), r.line);
    for (const h of r.handles) seen.handle.set(h.toLowerCase(), r.line);
    return { ...r, already: null };
  });
}

/**
 * The last day a person has access, typed as a date (YYYY-MM-DD, the date input). It ends at the END of that day, UTC: Date.parse of
 * the bare date would be the start of it, and the contractor would lose the last day. A day that has gone is refused here (the
 * server refuses it too), and so is a date that does not exist (2026-02-30).
 */
export function lastDayInstant(day: string, now: number = Date.now()): { ok: true; iso: string } | { ok: false; text: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return { ok: false, text: "Choose a date." };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = new Date(Date.UTC(y, mo - 1, d));
  if (start.getUTCFullYear() !== y || start.getUTCMonth() !== mo - 1 || start.getUTCDate() !== d) return { ok: false, text: "This date does not exist." };
  const end = start.getTime() + 86_400_000 - 1000;
  if (end <= now) return { ok: false, text: "This day has passed. Choose today or a later day." };
  if (y > 2100) return { ok: false, text: "Check the year." };
  return { ok: true, iso: new Date(end).toISOString() };
}

/** `contractor` is a tag the owner can see and edit on the People page. The server does not read it: the end date does the work. */
export const CONTRACTOR_TAG = "contractor";
