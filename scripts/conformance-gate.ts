// Conformance gate (C89 waiver). The suite runs with --allow-not-run only because conformance 0.1.8 reports
// A4.mark_after_failed as not_run for an app with no agent receipt op (no fixture can make it run).
// This gate reads the JSON report and fails on any `fail`, and on any not_run other than the waived id, so a new
// not_run cannot slip through.
// TODO remove at conformance 0.1.9 (drop --allow-not-run and this gate; see coordination/specs/REQUESTS.md
// "fleet → specs/conformance (2026-10-12, conformance 0.1.8): A4.mark_after_failed is `not_run`").
import { readFileSync } from "node:fs";

const WAIVED = new Set(["A4.mark_after_failed"]);
const file = process.argv[2] ?? ".conformance/app.json";

interface Check {
  id: string;
  status: string;
  asserted?: string;
}
const report = JSON.parse(readFileSync(file, "utf8")) as { checks: Check[] };
if (!Array.isArray(report.checks) || report.checks.length === 0) throw new Error(`conformance-gate: no checks in ${file}`);

const failed = report.checks.filter((c) => c.status === "fail");
const notRun = report.checks.filter((c) => c.status === "not_run");
const unwaived = notRun.filter((c) => !WAIVED.has(c.id));
for (const c of [...failed, ...unwaived]) console.error(`conformance-gate: ${c.status} ${c.id}: ${c.asserted ?? ""}`);
for (const c of notRun.filter((c) => WAIVED.has(c.id))) console.log(`conformance-gate: waived not_run ${c.id} (C89, until conformance 0.1.9)`);
if (failed.length > 0 || unwaived.length > 0) process.exit(1);
console.log(`conformance-gate: OK (${report.checks.filter((c) => c.status === "pass").length} pass, ${notRun.length} waived not_run)`);
