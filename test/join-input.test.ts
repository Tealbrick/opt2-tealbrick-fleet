// C380 T2-d (PR 2): the pasted list and the last day, checked before anything is sent. Each guard: one quiet-on-good, one fire-on-bad.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAgainst, LIMITS, lastDayInstant, parsePastedList, problemOf } from "../src/ui/pages/join-input.ts";

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
  assert.deepEqual(lastDayInstant("2026-10-29", NOW), { ok: false, text: "This day has passed. Choose today or a later day." });
  assert.deepEqual(lastDayInstant("2026-02-30", NOW), { ok: false, text: "This date does not exist." });
  assert.deepEqual(lastDayInstant("", NOW), { ok: false, text: "Choose a date." });
  assert.deepEqual(lastDayInstant("31/12/2026", NOW), { ok: false, text: "Choose a date." });
  assert.deepEqual(lastDayInstant("2999-01-01", NOW), { ok: false, text: "Check the year." });
});
