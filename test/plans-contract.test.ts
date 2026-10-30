// C380 B9c: the shapes the runner sends and reads, against the byte copies of spec-v0.1.89 and its fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { parseRevoke } from "../src/plans/access-port.ts";

const raw = (f: string) => readFileSync(new URL(`./contracts/${f}`, import.meta.url));
const json = (f: string) => JSON.parse(raw(f).toString("utf8"));

test("the revoke schemas are the frozen bytes", () => {
  assert.equal(createHash("sha256").update(raw("access.revoke_in.1.schema.json")).digest("hex"), "edbe7c6b94ffb74e4dff0c3f986ccaa29e83d8d6fd1fa9f1e2986d2802e60c51");
  assert.equal(createHash("sha256").update(raw("access.revoke_out.1.schema.json")).digest("hex"), "b36b1c6474fc858daf93e2a4d9605067113937b984e8b26833fa13eae314d919");
});

test("fixtures: each valid answer parses; each answer the schema refuses is no answer here either, or carries nothing the runner would trust", () => {
  const f = json("access.revoke_out.1.json");
  const asked = { v: 1 as const, plan: "pln_x", attempt: 1, subject: { kind: "agent" as const, id: "a" }, items: [] as { id: string; digest: string }[] };
  const ids = (v: { results?: { id?: unknown }[] }) => (v.results ?? []).filter((r) => typeof r?.id === "string").map((r) => ({ id: r.id as string, digest: "x" }));
  for (const v of f.valid) {
    assert.ok(parseRevoke(v, { ...asked, items: ids(v) }), JSON.stringify(v).slice(0, 200));
    assert.equal(validateAgainstSchema(json("access.revoke_out.1.schema.json"), v).ok, true);
  }
  for (const c of f.invalid) assert.equal(validateAgainstSchema(json("access.revoke_out.1.schema.json"), c.doc).ok, false);
});

test("parseRevoke: fire on a result for an item not asked, an unknown outcome, no results; quiet on good; text is cleaned", () => {
  const input = { v: 1 as const, plan: "pln_x", attempt: 1, subject: { kind: "agent" as const, id: "a" }, items: [{ id: "k:1", digest: "d" }] };
  assert.equal(parseRevoke({ v: 1, results: [{ id: "k:2", outcome: "revoked" }] }, input), null);
  assert.equal(parseRevoke({ v: 1, results: [{ id: "k:1", outcome: "yes" }] }, input), null);
  assert.equal(parseRevoke({ v: 1 }, input), null);
  assert.equal(parseRevoke({ v: 2, results: [] }, input), null);
  assert.deepEqual(parseRevoke({ v: 1, results: [{ id: "k:1", outcome: "failed", detail: "a‮b<script>" }] }, input)?.[0]?.outcome, "failed");
  assert.doesNotMatch(String(parseRevoke({ v: 1, results: [{ id: "k:1", outcome: "failed", detail: "a‮b" }] }, input)?.[0]?.detail), /‮/);
});
