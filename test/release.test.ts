// Release facts (0.3.0, C373): one version in package.json, the manifest and the newest CHANGELOG entry, and an
// update path from 0.2.3 (stable) and every 0.2.x. tealbrick-ci.json `images[].upgradeFrom` is the semver range the
// registry lets update to this release (default "*"); a narrower range must still contain 0.2.0 to 0.2.x.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { migrationFiles } from "./helpers.ts";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

/** true when the range admits every listed version. Understands "*" and space-joined ">=a.b.c" / "<a.b.c" bounds only; anything else fails closed. */
export function admits(range: string, versions: string[]): boolean {
  const num = (v: string) => v.split(".").map(Number) as [number, number, number];
  const cmp = (a: string, b: string) => {
    const [x, y] = [num(a), num(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
    return 0;
  };
  if (range.trim() === "*") return true;
  const parts = range.trim().split(/\s+/);
  if (!parts.every((p) => /^(>=|<)\d+\.\d+\.\d+$/.test(p))) return false;
  return versions.every((v) => parts.every((p) => (p.startsWith(">=") ? cmp(v, p.slice(2)) >= 0 : cmp(v, p.slice(1)) < 0)));
}

test("one version everywhere: package.json = manifest = the newest CHANGELOG entry", () => {
  const pkg = JSON.parse(read("package.json")) as { version: string };
  const manifest = JSON.parse(read("tealbrick.manifest.json")) as { version: string };
  const top = /^## (\S+)/m.exec(read("CHANGELOG.md"))?.[1];
  assert.equal(pkg.version, "0.3.2");
  assert.equal(manifest.version, pkg.version);
  assert.equal(top, pkg.version);
});

test("requires.bridge 0.2.12: the bridge that validates needsTopology (manifest 0.1.35); an older bridge refused 0.3.1 (schema_invalid)", () => {
  const manifest = JSON.parse(read("tealbrick.manifest.json")) as { requires?: { bridge?: string }; needsTopology?: boolean };
  assert.equal(manifest.needsTopology, true);
  assert.equal(manifest.requires?.bridge, "0.2.12");
});

test("update path: every image admits 0.2.3 (stable) and 0.2.x; the range check fires on a range that does not", () => {
  const ci = JSON.parse(read("tealbrick-ci.json")) as { images: { name: string; upgradeFrom?: string }[] };
  const from = ["0.2.0", "0.2.1", "0.2.2", "0.2.3", "0.2.4", "0.2.99"];
  for (const img of ci.images) assert.ok(admits(img.upgradeFrom ?? "*", from), `${img.name}: upgradeFrom ${img.upgradeFrom ?? "* (default)"} must admit 0.2.x`);
  // the checker itself: quiet on good ranges, fires on bad ones
  assert.equal(admits(">=0.2.0 <0.3.0", from), true);
  assert.equal(admits(">=0.2.3", from), false, "leaves out 0.2.0 to 0.2.2");
  assert.equal(admits("<0.2.3", from), false);
  assert.equal(admits("^0.2.0", from), false, "a form it cannot read fails closed");
});

test("migrations are forward-only and numbered without gaps (0005 agent handles, 0006 team template, 0007 outside agent fields)", () => {
  const names = migrationFiles().map((m) => m.name);
  assert.deepEqual(names, ["0001_init.sql", "0002_governance.sql", "0003_reviews.sql", "0004_proposals.sql", "0005_agent_handles.sql", "0006_proposal_team_template.sql", "0007_outside_agent_fields.sql"]);
  for (const m of migrationFiles()) assert.doesNotMatch(m.sql, /^\s*DROP TABLE (?!fleet_proposals;)/im, `${m.name}: no table is dropped except the 0006 rebuild`);
});
