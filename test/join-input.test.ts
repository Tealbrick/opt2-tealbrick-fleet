// C380 T2-d (PR 2): the pasted list and the last day, checked before anything is sent. Each guard: one quiet-on-good, one fire-on-bad.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanText } from "../src/text.ts";
import { checkAgainst, cleanCell, LIMITS, lastDayInstant, parsePastedList, problemOf, splitCells, untilToSend } from "../src/ui/pages/join-input.ts";

const NOW = Date.UTC(2026, 9, 30, 12);

test("quiet on good: cells are told by their shape, in any order, from tabs or commas", () => {
  const p = parsePastedList(["Marco Rossi\tmarco@acme.test\tSupport lead\tslack:U01234ABC buzz:npub1abc", "dana@acme.test, Dana Lee, telegram:123456789", "Eve"].join("\n"));
  assert.equal(p.header, false);
  assert.equal(p.cut, false);
  assert.deepEqual(p.rows.map((r) => [r.line, r.name, r.email, r.title, r.handles, r.problem]), [
    [1, "Marco Rossi", "marco@acme.test", "Support lead", ["slack:U01234ABC", "buzz:npub1abc"], null],
    [2, "Dana Lee", "dana@acme.test", "", ["telegram:123456789"], null],
    [3, "Eve", null, "", [], null],
  ]);
});

test("quiet on good: a header line, blank lines and quotes; line numbers stay those of the paste", () => {
  const p = parsePastedList('Name, Email\n\n"Marco Rossi","marco@acme.test"\n');
  assert.equal(p.header, true);
  assert.deepEqual(p.rows.map((r) => [r.line, r.name, r.email]), [[3, "Marco Rossi", "marco@acme.test"]]);
  assert.equal(parsePastedList("Name").header, true, "a lone header word is a header");
  assert.equal(parsePastedList("Nameless Person").header, false, "a name that starts with a header word is a person");
});

test("fire on bad: a line it cannot read is a problem with a plain sentence, never guessed", () => {
  const rows = parsePastedList(["a@b.test, c@d.test, Ann", "Ann, Lead, Extra part", "slack: U1, Bob", ",,,", `${"x".repeat(LIMITS.name + 1)}`, "Ann, not-an-email@"].join("\n")).rows;
  assert.equal(rows[0]?.problem, "There is more than one email.");
  assert.match(String(rows[1]?.problem), /does not fit a name, email, title or handle: Extra part/);
  assert.match(String(rows[2]?.problem), /handle has a space or no value/);
  assert.equal(rows.some((r) => r.line === 4), false, "a line with only separators is empty");
  assert.match(String(rows[3]?.problem), /longer than 120/);
  assert.equal(rows[4]?.problem, null, "a title is any other text");
  for (const r of rows) assert.ok(r.problem === null || r.problem.length > 0);
});

test("fire on bad: more handles than a person may have, and a line with no name", () => {
  const many = Array.from({ length: LIMITS.handles + 1 }, (_, i) => `slack:U${i}AAAAAAA`).join(" ");
  assert.match(String(parsePastedList(`Ann, ${many}`).rows[0]?.problem), /at most 10 channel handles/);
  assert.equal(parsePastedList("ann@acme.test").rows[0]?.problem, "There is no name.");
  assert.equal(problemOf({ name: "Ann", email: null, title: "", handles: [] }), null);
});

test("the paste is cut at 100 lines and says so", () => {
  const p = parsePastedList(Array.from({ length: LIMITS.rows + 5 }, (_, i) => `Person ${i}`).join("\n"));
  assert.equal(p.rows.length, LIMITS.rows);
  assert.equal(p.cut, true);
  assert.equal(parsePastedList("Person 1\nPerson 2").cut, false);
});

test("quiet on good: people who are not in the directory are ready", () => {
  const rows = checkAgainst(parsePastedList("Ann, ann@acme.test, slack:U1AAAAAAA\nBo").rows, [{ name: "Zed", email: "zed@acme.test", handles: ["slack:UZEDZEDZE"] }]);
  assert.deepEqual(rows.map((r) => [r.problem, r.already]), [[null, null], [null, null]]);
});

test("fire on bad: a person already in the directory (name, email or handle) is not added and not changed; a twin inside the paste is a problem", () => {
  const known = [{ name: "Ann Smith", email: "ann@acme.test", handles: ["slack:U1AAAAAAA"] }];
  const rows = checkAgainst(
    parsePastedList(["ann smith", "Someone, ANN@acme.test", "Another, slack:u1aaaaaaa", "Bo, bo@acme.test", "BO again, bo@acme.test", "Cy", "cy"].join("\n")).rows,
    known,
  );
  assert.match(String(rows[0]?.already), /Ann Smith is in the directory already/);
  assert.match(String(rows[1]?.already), /Ann Smith is in the directory/);
  assert.match(String(rows[2]?.already), /Ann Smith is in the directory/);
  assert.deepEqual([rows[3]?.problem, rows[3]?.already], [null, null]);
  assert.equal(rows[4]?.problem, "Same person as line 4.");
  assert.equal(rows[6]?.problem, "Same person as line 6.");
  assert.equal(rows[5]?.problem, null);
});

test("quiet on good: the last day ends at the END of that day, UTC; today is allowed", () => {
  assert.deepEqual(lastDayInstant("2026-12-31", NOW), { ok: true, iso: "2026-12-31T23:59:59.000Z" });
  assert.deepEqual(lastDayInstant("2026-10-30", NOW), { ok: true, iso: "2026-10-30T23:59:59.000Z" });
});

test("fire on bad: a day that has gone, a date that does not exist, no date, a wrong year", () => {
  assert.deepEqual(lastDayInstant("2026-10-29", NOW), { ok: false, text: "This day has passed in UTC. Choose a later day." });
  assert.deepEqual(lastDayInstant("2026-02-30", NOW), { ok: false, text: "This date does not exist." });
  assert.deepEqual(lastDayInstant("", NOW), { ok: false, text: "Choose a date." });
  assert.deepEqual(lastDayInstant("31/12/2026", NOW), { ok: false, text: "Choose a date." });
  assert.deepEqual(lastDayInstant("2999-01-01", NOW), { ok: false, text: "Check the year." });
  assert.deepEqual(lastDayInstant("2100-06-01", NOW), { ok: false, text: "Check the year." }, "the server refuses a date from 2100-01-01 on");
  assert.equal(lastDayInstant("2099-12-31", NOW).ok, true);
});

test("the browser copy of cleanText gives the server's answer on the edge of every range, so a name is compared as it will be stored", () => {
  const edges = [0x00, 0x1f, 0x7f, 0x9f, 0xad, 0x61c, 0x180e, 0x200b, 0x200f, 0x2028, 0x202e, 0x2060, 0x206f, 0xfeff, 0xfff9, 0xfffb, 0xe0000, 0xe007f, 0xe0100, 0xe01ef];
  for (const c of [...edges, ...edges.map((e) => e - 1), ...edges.map((e) => e + 1)].filter((c) => c >= 0)) {
    const sample = `  A${String.fromCodePoint(c)}b  c\td\n `;
    assert.equal(cleanCell(sample), cleanText(sample), `U+${c.toString(16)}`);
  }
  assert.equal(cleanCell("Ann\u200B"), "Ann");
  assert.equal(cleanCell("\u202Eevil"), "evil");
});

test("fire on bad: an invisible character does not hide a duplicate (the server removes it before it stores the name)", () => {
  const rows = checkAgainst(parsePastedList("Ann\u200B\nBo\u202E Bell\nBo Bell").rows, [{ name: "Ann", email: null, handles: [] }]);
  assert.match(String(rows[0]?.already), /Ann is in the directory already/);
  assert.equal(rows[0]?.name, "Ann", "and the preview shows the cleaned name");
  assert.equal(rows[1]?.name, "Bo Bell");
  assert.equal(rows[2]?.problem, "Same person as line 2.");
});

test("two people may share a name when each has an email of their own; a name alone, or one email, still says the same person", () => {
  const known = [{ name: "John Smith", email: "john1@acme.test", handles: [] }, { name: "Cy Cole", email: null, handles: [] }];
  const rows = checkAgainst(parsePastedList(["John Smith, john2@acme.test", "John Smith, john2b@acme.test", "John Smith, john1@acme.test", "Cy Cole, cy@acme.test", "Jo Jay", "Jo Jay, jo@acme.test", "Jo Jay"].join("\n")).rows, known);
  assert.deepEqual(rows.map((r) => [r.already ? "already" : r.problem ? "problem" : "ready"]), [["ready"], ["ready"], ["already"], ["already"], ["ready"], ["problem"], ["problem"]]);
  assert.match(String(rows[5]?.problem), /Same person as line 5/);
});

test("quiet on good: common spreadsheet shapes: a quoted name with a comma, a semicolon file, Name <email>", () => {
  const rows = parsePastedList(['"Rossi, Marco",marco@acme.test', "Marco Rossi;marco2@acme.test;CTO", "Marco Three <marco3@acme.test>", '"Four, Marco" <m4@acme.test>'].join("\n")).rows;
  assert.deepEqual(rows.map((r) => [r.name, r.email, r.title, r.problem]), [["Rossi, Marco", "marco@acme.test", "", null], ["Marco Rossi", "marco2@acme.test", "CTO", null], ["Marco Three", "marco3@acme.test", "", null], ["Four, Marco", "m4@acme.test", "", null]]);
  assert.deepEqual(splitCells('a,"b,c",d'), ["a", '"b,c"', "d"]);
  assert.deepEqual(splitCells("a;b"), ["a", "b"]);
});

test("fire on bad: an email in the name, an empty name column, and a handle with no channel are problems", () => {
  const rows = parsePastedList(["Marco Rossi marco@x.test extra", "\tmarco@acme.test\tSupport lead", "Ann, slack:U1AAAAAAA, buzz:"].join("\n")).rows;
  assert.equal(rows[0]?.problem === null, false);
  assert.equal(rows[1]?.problem, "There is no name.");
  assert.equal(rows[1]?.title, "Support lead", "the title stays a title");
  assert.match(String(rows[2]?.problem), /handle has a space or no value/);
  assert.match(String(problemOf({ name: "Ann", email: null, title: "", handles: ["U1234"] })), /needs buzz:, slack: or telegram: in front/);
  assert.match(String(problemOf({ name: "Ann marco@x.test", email: null, title: "", handles: [] })), /name has an email address in it/);
});

test("a contractor never goes out with no end date: the day is read again when it is sent, and a day that ended in between is refused", () => {
  assert.deepEqual(untilToSend(true, "2026-10-30", NOW), { ok: true, until: "2026-10-30T23:59:59.000Z" });
  const late = Date.UTC(2026, 9, 31, 0, 0, 1);
  const out = untilToSend(true, "2026-10-30", late);
  assert.equal(out.ok, false);
  assert.match(out.ok ? "" : out.text, /The last day is not right\. This day has passed in UTC/);
  assert.equal(untilToSend(true, "", NOW).ok, false, "a contractor with no day");
  assert.deepEqual(untilToSend(false, "", NOW), { ok: true, until: null }, "a person who stays may have none");
  assert.equal(untilToSend(false, "2026-10-30", late).ok, false, "a day typed and gone is never dropped quietly");
});
