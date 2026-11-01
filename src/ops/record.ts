// The access record op (C380 T2-b). A person op: no agent and no app can call it. It reads the evidence tables and the open differences, builds the file
// and writes one event into the chain with the file's digest, so the owner can show that a file is the one that was made. It changes no access.
import { readFileSync } from "node:fs";
import type { HandlerSpec, SdkOpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP, type OpId, type RecordExportInput, type RecordExportOutput } from "#kit";
import { findingsList } from "../access/differences.ts";
import { appendEvent } from "../lifecycle/events.ts";
import { loadColleagues, portalReadState, readTopology } from "../lifecycle/view.ts";
import { buildRecord } from "../record/index.ts";
import { accessShown } from "../topology-slice.ts";
import { assertOwner } from "./lifecycle.ts";
import { op } from "./op.ts";

const VERSION = (JSON.parse(readFileSync(new URL("../../tealbrick.manifest.json", import.meta.url), "utf8")) as { version: string }).version;

export const recordOps = {
  [OP.recordExport]: op<RecordExportInput, RecordExportOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      const now = Date.now();
      const rows = loadColleagues(ctx.db, now, readTopology(ctx as SdkOpContext)).rows.map((r) => ({ kind: r.kind, id: r.id, name: r.name, at: r.at, findings: r.findings }));
      const findings = findingsList(ctx.db, rows, portalReadState(readTopology(ctx as SdkOpContext)), now, accessShown(readTopology(ctx as SdkOpContext)));
      const made = await buildRecord(ctx.db, input, { findings, version: VERSION, now });
      appendEvent(ctx.db, {
        subject: { kind: "workspace", id: "", name: "Governance" },
        kind: "changed",
        actor: { kind: "owner", id: ctx.caller.id },
        note: `Access record made for ${made.record.period.from.slice(0, 10)} to ${made.record.period.to.slice(0, 10)}. ${made.digest}`,
        at: Date.now(),
      });
      return made as never;
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
