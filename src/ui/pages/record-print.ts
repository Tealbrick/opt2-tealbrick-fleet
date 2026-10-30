// The access record as a page for print (C380 T2-b). Built from the same file the owner downloads, so the paper says what the file says. Every value is escaped: a
// label, a name or a reason came from an app or from the owner and is text only. No script in the page.
export interface RecordFile {
  header: string;
  limits: string[];
  period: { from: string; to: string };
  generatedAt: string;
  contents: { includes: string[]; excludes: string[]; decision: string };
  approvers: { line: string };
  sweeps: { lists: { startedAt: string; finishedAt: string; listKept: boolean; stores: { store: string; readThisSweep: boolean; state: string }[]; items: { store: string; label: string; state: string; subject: { kind: string; name?: string | null } }[] | null; ended: { store: string; label: string; endedAt: string }[] }[] };
  findings: { items: { text: string; subject?: { name: string } | null; productName?: string | null }[] };
  exceptions: { code: string; subject: { name: string | null }; reason: string; until: string }[];
  timeToStop: { subject: { name: string | null }; markedAt: string; stoppedAt: string | null; seconds: number | null; note: string | null; steps: { proved: number; total: number } }[];
  appsNotRead: { now: { name: string; text: string }[] };
  integrity: { chain: { ok: boolean }; digest: string | null };
}

export const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const ul = (items: readonly unknown[]): string => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
const table = (head: string[], rows: unknown[][]): string => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

export function recordHtml(r: RecordFile): string {
  const sweeps = r.sweeps.lists.map(
    (s) =>
      `<h3>Sweep finished ${esc(s.finishedAt)}</h3>` +
      `<p>Apps: ${esc(s.stores.map((x) => `${x.store}: ${x.readThisSweep ? "read" : "not read"}`).join("; "))}</p>` +
      (s.items === null ? "<p>The list of this sweep was not kept.</p>" : table(["App", "What it reports", "State", "Whose"], s.items.map((i) => [i.store, i.label, i.state, i.subject.kind === "unlinked" ? "No person or agent" : (i.subject.name ?? "Unknown")]))) +
      (s.ended.length > 0 ? `<p>Ended in this sweep:</p>${table(["App", "What it reported", "Ended"], s.ended.map((e) => [e.store, e.label, e.endedAt]))}` : ""),
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Access record</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:CanvasText}table{border-collapse:collapse;width:100%;margin:.5rem 0}th,td{border:1px solid GrayText;padding:.25rem .5rem;text-align:left;vertical-align:top}h1,h2,h3{break-after:avoid}h2{margin-top:2rem}</style></head><body>
<h1>Access record</h1><p>${esc(r.header)}</p><p>Period: ${esc(r.period.from)} to ${esc(r.period.to)}. Made ${esc(r.generatedAt)}.</p>
<h2>Limits of this record</h2>${ul(r.limits)}
<h2>Who approved</h2><p>${esc(r.approvers.line)}</p>
<h2>What this file holds about people</h2><p>Included:</p>${ul(r.contents.includes)}<p>Not included:</p>${ul(r.contents.excludes)}<p>${esc(r.contents.decision)}</p>
<h2>Time to stop</h2>${r.timeToStop.length === 0 ? "<p>No stop in this period.</p>" : table(["Who", "Marked", "Proved stopped", "Seconds", "Note"], r.timeToStop.map((t) => [t.subject.name ?? "Unknown", t.markedAt, t.stoppedAt ?? "Not proved", t.seconds ?? "", t.note ?? `${t.steps.proved} of ${t.steps.total} steps proved`]))}
<h2>Differences open when this file was made</h2>${r.findings.items.length === 0 ? "<p>None.</p>" : ul((r.findings.items as { text: string }[]).map((f) => f.text))}
<h2>Accepted differences</h2>${r.exceptions.length === 0 ? "<p>None.</p>" : table(["Difference", "Whose", "Reason", "Until"], r.exceptions.map((e) => [e.code, e.subject.name ?? "Unknown", e.reason, e.until]))}
<h2>Apps that were not read</h2>${r.appsNotRead.now.length === 0 ? "<p>Every app was read at the last check.</p>" : ul(r.appsNotRead.now.map((a) => `${a.name}: ${a.text}`))}
<h2>What each app listed, by sweep</h2>${sweeps.join("") || "<p>No sweep in this period.</p>"}
<h2>Integrity</h2><p>Chain of events: ${r.integrity.chain.ok ? "unbroken" : "BROKEN"}. This is not a signature: the owner can change the file. Digest of the file: ${esc(r.integrity.digest)}</p><p>This page is a summary of the file. The file holds every event, plan, verdict and review round.</p>
</body></html>`;
}
