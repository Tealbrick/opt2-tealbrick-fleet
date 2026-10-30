// Access record (C380 T2-b, DESIGN-C380 §7, §15 D7): one file for a period. The page makes it, shows what it says about itself first (our own apps report this data, one
// person approves, no claim about any law), and offers the file and a print. It never offers "compliance" or "evidence": it is a record.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Card, Field, Notice, TextInput } from "@opt2-tealbrick/ui";
import { useState } from "react";
import type { RecordExportOutput } from "#kit";
import { changeError, PageHead } from "../common.tsx";
import { type RecordFile, recordHtml } from "./record-print.ts";

const DAY = 86_400_000;
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const CODES = new Set(["period_invalid", "record_too_big"]);
const recordError = (e: unknown): string => {
  const err = (e ?? {}) as { code?: unknown; message?: unknown };
  return typeof err.code === "string" && CODES.has(err.code) && typeof err.message === "string" ? err.message : changeError(e);
};

/** Saves the file as the owner sees it: the whole answer, formatted. */
function download(file: RecordFile, from: string, to: string): void {
  const blob = new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `access-record-${from}-${to}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** A hidden frame prints the page; a frame the browser blocks leaves the file as the way to read it. */
function printFile(file: RecordFile): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-modals allow-same-origin");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0";
  frame.srcdoc = recordHtml(file);
  frame.onload = () => {
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}

export function RecordPage() {
  const today = Date.now();
  const [from, setFrom] = useState(ymd(today - 90 * DAY));
  const [to, setTo] = useState(ymd(today));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [made, setMade] = useState<{ file: RecordFile; from: string; to: string } | null>(null);
  const make = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const out = await callOp<RecordExportOutput>("record_export", { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` });
      setMade({ file: out.record as unknown as RecordFile, from, to });
    } catch (e) {
      setFailure(recordError(e));
    } finally {
      setBusy(false);
    }
  };
  const file = made?.file ?? null;
  return (
    <section className="app-page" aria-label="Access record">
      <PageHead title="Access record" lede="One file about who and what had access to your agents' apps, for a period you choose." />
      <Notice tone="neutral">
        Our own apps report this data. The file shows what each app reported and what the Portal slice showed. It does not prove that nothing else had access, and it makes no claim about any law or standard. Governance has one owner login today, so the owner approves each item.
      </Notice>
      {failure ? (
        <Notice tone="needs-you" role="alert">
          {failure}
        </Notice>
      ) : null}
      <Card>
        <div className="tb-stack">
          <div className="tb-row">
            <Field label="From">
              <TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <p className="tb-soft">At most one year. Making the file writes one line into the history, with the digest of the file.</p>
          <div className="tb-row">
            <Button variant="primary" onClick={() => void make()} disabled={busy || !from || !to}>
              {busy ? "Making the file" : "Make the record"}
            </Button>
          </div>
        </div>
      </Card>
      {file && made ? (
        <Card>
          <div className="tb-stack" role="status">
            <h2 className="sub-head">The file is ready</h2>
            <p>{`${count(file.sweeps.lists.length, "sweep", "sweeps")}, ${count(file.timeToStop.length, "stop", "stops")}, ${count(file.findings.items.length, "open difference", "open differences")}, ${file.exceptions.length} accepted. ${file.approvers.line}`}</p>
            {file.integrity.chain.ok ? null : (
              <Notice tone="needs-you" role="alert">
                The chain of events is broken. A row of the history was changed. The file says where.
              </Notice>
            )}
            {file.appsNotRead.now.length > 0 ? <p>{`Not read: ${file.appsNotRead.now.map((a) => a.name).join(", ")}.`}</p> : null}
            <details>
              <summary>What the file says about itself</summary>
              <ul>
                {file.limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p>Included about people: {file.contents.includes.join(" ")}</p>
              <p>Not included: {file.contents.excludes.join(" ")}</p>
              <p>{file.contents.decision}</p>
            </details>
            <div className="tb-row">
              <Button variant="primary" onClick={() => download(file, made.from, made.to)}>
                Download the file
              </Button>
              <Button onClick={() => printFile(file)}>Print</Button>
            </div>
          </div>
        </Card>
      ) : null}
    </section>
  );
}
