// Access record page and its print page (C380 T2-b) against the real SDK client and a stub server, rendered in happy-dom: the page says what it is not before it makes the file,
// shows a broken chain, uses the server's plain sentence for a refusal, and the print page escapes every value an app or the owner wrote.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { esc, type RecordFile, recordHtml } from "../src/ui/pages/record-print.ts";
import { button, callsOf, cleanUi, click, compileUi, h, mount, ok, refuse, reset, stub } from "./ui-harness.ts";

type Record_ = typeof import("../src/ui/pages/record.tsx");
let record: Record_;
before(async () => {
  record = (await compileUi("ui-test-record")("record")) as Record_;
});
after(() => cleanUi("ui-test-record"));

describe("Access record", () => {
  const FILE = (over: Record<string, unknown> = {}): RecordFile =>
    ({
      header: "What each app reported and what the Portal slice showed, in Teal Brick stores only. Not proof of compliance.",
      limits: ["Our own apps report this data.", "This record makes no claim about any law, standard or audit."],
      period: { from: "2026-08-01T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z" },
      generatedAt: "2026-10-30T12:00:00.000Z",
      contents: { includes: ["Names and ids."], excludes: ["Email addresses."], decision: "Nobody checked this against a law." },
      approvers: { line: "One person approved all items." },
      sweeps: { lists: [{ startedAt: "a", finishedAt: "2026-10-29T10:00:00.000Z", listKept: true, stores: [{ store: "Connect", readThisSweep: false, state: "not_read" }], items: [{ store: "Connect", label: "<script>alert(1)</script> Mail", state: "active", subject: { kind: "agent", name: "Henry" } }], ended: [{ store: "Evolving Workflows", label: "Routine r1", endedAt: "x" }] }] },
      findings: { items: [{ text: "This agent has no owner. Name an owner." }] },
      exceptions: [{ code: "no_owner", subject: { name: "Henry" }, reason: "On leave.", until: "2026-11-30" }],
      timeToStop: [{ subject: { name: "Marco" }, markedAt: "m", stoppedAt: "s", seconds: 42, note: null, steps: { proved: 2, total: 2 } }],
      appsNotRead: { now: [{ name: "Connect", text: "Could not be read." }] },
      integrity: { chain: { ok: true }, digest: "sha256:abc" },
      ...over,
    }) as RecordFile;

  it("makes the file for the dates, says first what it is not, and offers the file and a print; the chain break is shown, not hidden", async () => {
    reset();
    stub.answers.record_export = (i) => ok({ record: { ...FILE({ integrity: { chain: { ok: false }, digest: "sha256:abc" } }), sweeps: { lists: [] } }, digest: "sha256:abc", seen: i })();
    const m = await mount(h(record.RecordPage, {}));
    const text = m.host.textContent ?? "";
    assert.match(text, /Our own apps report this data/);
    assert.match(text, /no claim about any law or standard/);
    assert.doesNotMatch(text, /compliance|[Ee]vidence/, "it is a record, not a claim");
    await click(button(m.host, "Make the record"));
    const sent = callsOf("record_export")[0];
    assert.match(sent.from, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
    assert.match(sent.to, /^\d{4}-\d{2}-\d{2}T23:59:59Z$/);
    const after = m.host.textContent ?? "";
    assert.match(after, /The file is ready/);
    assert.match(after, /The chain of events is broken/);
    assert.match(after, /Not read: Connect/);
    assert.ok(button(m.host, "Download the file"));
    assert.ok(button(m.host, "Print"));
    await m.unmount();
  });
  it("a period that is too long, or too big, is the server's plain sentence", async () => {
    reset();
    stub.answers.record_export = refuse(409, "record_too_big", "This period has too many rows for one file. Choose a shorter period.");
    const m = await mount(h(record.RecordPage, {}));
    await click(button(m.host, "Make the record"));
    assert.match(m.host.textContent ?? "", /Choose a shorter period/);
    assert.doesNotMatch(m.host.textContent ?? "", /The file is ready/);
    await m.unmount();
  });
  it("the print page escapes every value, whatever field it is in; it has a content policy and no script; and it says what the file says about itself", () => {
    const evil = (name: string) => `<img src=x onerror=alert('${name}')>"&`;
    const hostile = FILE({
      header: evil("header"),
      limits: [evil("limit")],
      period: { from: evil("from"), to: evil("to") },
      generatedAt: evil("made"),
      contents: { includes: [evil("in")], excludes: [evil("out")], decision: evil("decision") },
      approvers: { line: evil("line") },
      sweeps: { lists: [{ startedAt: evil("start"), finishedAt: evil("finish"), listKept: true, stores: [{ store: evil("store"), readThisSweep: false, state: "x" }], items: [{ store: evil("istore"), label: evil("label"), state: evil("state"), subject: { kind: "agent", name: evil("who") } }], ended: [{ store: evil("estore"), label: evil("elabel"), endedAt: evil("ended") }] }] },
      findings: { items: [{ text: evil("finding") }] },
      exceptions: [{ code: evil("code"), subject: { name: evil("exwho") }, reason: evil("reason"), until: evil("until") }],
      timeToStop: [{ subject: { name: evil("stopwho") }, markedAt: evil("marked"), stoppedAt: evil("stopped"), seconds: 1, note: evil("note"), steps: { proved: 1, total: 1 } }],
      appsNotRead: { now: [{ name: evil("app"), text: evil("apptext") }] },
      integrity: { chain: { ok: true }, digest: evil("digest") },
    });
    const html = recordHtml(hostile);
    // outside the page's own tags no raw `<` is left: removing the escape on any field would leave one
    const text = html.replace(/<!doctype html>|<\/?(?:html|head|body|meta|title|style|h1|h2|h3|p|ul|li|table|thead|tbody|tr|th|td)\b[^>]*>/g, "");
    assert.ok(!text.includes("<"), "a raw < is left in a value");
    assert.ok(!/<img/i.test(html));
    assert.ok(html.includes("&lt;img src=x onerror=alert(&#39;header&#39;)&gt;&quot;&amp;"));
    for (const name of ["limit", "from", "to", "made", "in", "out", "decision", "line", "finish", "store", "istore", "label", "state", "who", "estore", "elabel", "ended", "finding", "code", "exwho", "reason", "until", "stopwho", "marked", "stopped", "note", "app", "apptext", "digest"]) assert.ok(html.includes(`alert(&#39;${name}&#39;)`), `${name} is escaped and printed`);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
    assert.doesNotMatch(html, /<script/i);
    const plain = recordHtml(FILE());
    for (const t of ["Limits of this record", "Our own apps report this data", "One person approved all items", "Nobody checked this against a law", "Ended in this sweep", "Not proof of compliance", "sha256:abc", "not a signature", "summary of the file"]) assert.match(plain, new RegExp(t), t);
    assert.equal(esc(`"'<&>`), "&quot;&#39;&lt;&amp;&gt;");
    assert.match(recordHtml(FILE({ integrity: { chain: { ok: false }, digest: null } })), /BROKEN/);
    assert.match(recordHtml(FILE({ sweeps: { lists: [{ startedAt: "a", finishedAt: "b", listKept: false, stores: [], items: null, ended: [] }] } })), /was not kept/);
  });
  it("a file the page cannot read is not offered", async () => {
    reset();
    stub.answers.record_export = ok({ record: { format: "other" }, digest: "x" });
    const m = await mount(h(record.RecordPage, {}));
    await click(button(m.host, "Make the record"));
    assert.match(m.host.textContent ?? "", /form this page cannot read/);
    assert.doesNotMatch(m.host.textContent ?? "", /Download the file/);
    await m.unmount();
  });
});

