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

// The browser copy of src/text.ts cleanText: the server removes these characters from every name and title it stores, so a name is
// compared and shown the way it will be stored. test/join-input.test.ts keeps the two equal on every range.
const STRIP_RANGES: readonly [number, number][] = [[0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0000, 0xe007f], [0xe0100, 0xe01ef]];
const STRIP = new RegExp(`[${STRIP_RANGES.map(([a, b]) => `\\u{${a.toString(16).padStart(4, "0")}}-\\u{${b.toString(16).padStart(4, "0")}}`).join("")}]`, "gu");
export const cleanCell = (s: string): string => s.replace(/[\t\n\r]/g, " ").replace(STRIP, "").replace(/ {2,}/g, " ").trim();

const fold = (s: string) => cleanCell(s).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const unquote = (s: string) => cleanCell(s.trim().replace(/^"(.*)"$/s, "$1"));
const isHandles = (cell: string) => cell.split(/[\s;]+/).filter(Boolean).every((t) => HANDLE.test(t));

/** The problem with one person, in plain words, or null. The server's limits (manifest person_set). */
export function problemOf(d: Pick<Draft, "name" | "email" | "title" | "handles">): string | null {
  if (!d.name) return "There is no name.";
  if (d.name.length > LIMITS.name) return `The name is longer than ${LIMITS.name} characters.`;
  if (d.name.includes("@")) return "The name has an email address in it. Put the email in its own part.";
  if (d.title.length > LIMITS.title) return `The title is longer than ${LIMITS.title} characters.`;
  if (d.email !== null && (d.email.length > LIMITS.email || !EMAIL.test(d.email))) return "The email does not look right.";
  const odd = d.handles.find((h) => !HANDLE.test(h));
  if (odd) return `This handle needs buzz:, slack: or telegram: in front: ${odd.slice(0, 40)}`;
  if (d.handles.length > LIMITS.handles) return `A person has at most ${LIMITS.handles} channel handles.`;
  return null;
}

/** Splits one line at the delimiter, keeping a quoted cell whole (it may hold the delimiter). A tab wins over a comma, a comma over a semicolon. */
export function splitCells(text: string): string[] {
  const delim = text.includes("\t") ? "\t" : text.includes(",") ? "," : text.includes(";") ? ";" : null;
  if (delim === null) return [text];
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted;
      cur += ch;
    } else if (ch === delim && !quoted) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

const NAMED_EMAIL = /^(.*?)\s*<([^<>\s@]+@[^<>\s@]+)>$/;

/** One line. A cell it cannot place makes the line a problem: it is shown and never guessed. */
function parseLine(text: string, line: number): Row {
  const draft: Draft = { line, name: "", email: null, title: "", handles: [] };
  let problem: string | null = null;
  const raw = splitCells(text);
  // an empty first cell is an empty name: the next text cell is the title, not the name
  const noName = raw.length > 1 && unquote(raw[0] ?? "") === "";
  const setEmail = (e: string) => {
    if (draft.email !== null) problem ??= "There is more than one email.";
    else draft.email = e;
  };
  for (const cell of raw.map(unquote).filter(Boolean)) {
    const named = NAMED_EMAIL.exec(cell);
    if (isHandles(cell)) draft.handles.push(...cell.split(/[\s;]+/).filter(Boolean));
    else if (named) {
      setEmail(named[2] as string);
      if (named[1] && !draft.name && !noName) draft.name = named[1].replace(/^"|"$/g, "").trim();
    } else if (EMAIL.test(cell) && !/\s/.test(cell)) setEmail(cell);
    else if (/^(buzz|slack|telegram):/i.test(cell)) problem ??= `This handle has a space or no value: ${cell.slice(0, 40)}`;
    else if (!draft.name && !noName) draft.name = cell;
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
    .filter((l) => cleanCell(l.raw).replace(/[\s,;"]/g, "") !== ""); // an empty spreadsheet row (",,,") is a blank line, not a person with no name
  let header = false;
  const first = lines[0];
  if (first) {
    const cells = splitCells(first.raw).map((c) => fold(unquote(c))).filter(Boolean);
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
  // A name alone says "the same person" only while an email does not say "another": two people may share a name (two John Smiths with their own emails).
  const names = new Map<string, { name: string; email: string | null }>();
  const emails = new Map<string, string>();
  const handles = new Map<string, string>();
  for (const k of known) {
    names.set(fold(k.name), { name: k.name, email: k.email ? fold(k.email) : null });
    if (k.email) emails.set(fold(k.email), k.name);
    for (const h of k.handles) handles.set(h.toLowerCase(), k.name);
  }
  const seen = { name: new Map<string, { line: number; email: string | null }>(), email: new Map<string, number>(), handle: new Map<string, number>() };
  const sameName = (email: string | null, other: { email: string | null } | undefined) => other !== undefined && (email === null || other.email === null || email === other.email);
  return rows.map((r) => {
    if (r.problem) return { ...r, already: null };
    const email = r.email ? fold(r.email) : null;
    const byName = names.get(fold(r.name));
    const same = (email && emails.get(email)) || r.handles.map((h) => handles.get(h.toLowerCase())).find(Boolean) || (sameName(email, byName) ? byName?.name : null) || null;
    if (same) return { ...r, already: `${same} is in the directory already.` };
    const twinName = seen.name.get(fold(r.name));
    const twin = (email ? seen.email.get(email) : undefined) ?? r.handles.map((h) => seen.handle.get(h.toLowerCase())).find((n) => n !== undefined) ?? (sameName(email, twinName) ? twinName?.line : undefined);
    if (twin !== undefined) return { ...r, problem: `Same person as line ${twin}.`, already: null };
    seen.name.set(fold(r.name), { line: r.line, email });
    if (email) seen.email.set(email, r.line);
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
  if (y >= 2100) return { ok: false, text: "Check the year." };
  if (end <= now) return { ok: false, text: "This day has passed in UTC. Choose a later day." };
  return { ok: true, iso: new Date(end).toISOString() };
}

/**
 * The end date to SEND, decided at the moment of sending. A contractor never goes out without one: a day that ended while the dialog was open
 * (it is read again from the clock) is refused here, never sent as "no end date".
 */
export function untilToSend(contractor: boolean, day: string, now: number = Date.now()): { ok: true; until: string | null } | { ok: false; text: string } {
  if (!contractor && day === "") return { ok: true, until: null };
  const last = lastDayInstant(day, now);
  return last.ok ? { ok: true, until: last.iso } : { ok: false, text: contractor ? `The last day is not right. ${last.text}` : last.text };
}

/** `contractor` is a tag the owner can see and edit on the People page. The server does not read it: the end date does the work. */
export const CONTRACTOR_TAG = "contractor";
