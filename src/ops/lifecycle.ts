// Lifecycle ops (C380 B9a). All person ops: no agent and no app can call them, and each handler checks that again. An agent can only ask,
// through review_request, and never about itself. Governance applies nothing to another store: the answer lists what to do in Portal.
import { type HandlerSpec, TbError } from "@opt2-tealbrick/miniapp-sdk";
import {
  type ColleagueGetInput,
  type ColleagueGetOutput,
  type ColleaguesListInput,
  type ColleaguesListOutput,
  type LifecycleSetInput,
  type LifecycleSetOutput,
  OP,
  type OpId,
  type SettingsSetInput,
  type SettingsSetOutput,
  type SummaryGetInput,
  type SummaryGetOutput,
} from "#kit";
import { setSettings } from "../lifecycle/settings.ts";
import { type Actor, assertCap, loadSubject, setDates, setKeepRunning, transition } from "../lifecycle/transitions.ts";
import { colleagueDetail, colleaguesList, grantsOf, readTopology, summaryGet } from "../lifecycle/view.ts";
import { fail } from "../meta.ts";
import { op } from "./op.ts";

/** The manifest says `person`. The handler says it again: a lifecycle is the owner's act, and a wrong manifest must not open it. */
export function assertOwner(caller: { type: string }): void {
  if (caller.type !== "person") throw new TbError("no_access", "Only the owner can do this.", 403);
}

export const lifecycleOps = {
  [OP.summaryGet]: op<SummaryGetInput, SummaryGetOutput>({
    async run(_input, ctx) {
      assertOwner(ctx.caller);
      return summaryGet(ctx);
    },
  }),
  [OP.colleaguesList]: op<ColleaguesListInput, ColleaguesListOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      return colleaguesList(ctx.db, input);
    },
  }),
  [OP.colleagueGet]: op<ColleagueGetInput, ColleagueGetOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      return { colleague: await colleagueDetail(ctx, input.kind, input.id) };
    },
  }),
  [OP.lifecycleSet]: op<LifecycleSetInput, LifecycleSetOutput>({
    // One transaction and no await: the grants are read from the slice before it, and the floor is read from Rules after it.
    async run(input, ctx) {
      assertOwner(ctx.caller);
      const actor: Actor = { kind: "owner", id: ctx.caller.id };
      const nothing = input.to === undefined && input.validFrom === undefined && input.validUntil === undefined && !input.decisions?.length;
      if (nothing) fail("input_invalid", "Say what to change.", 400);
      if (input.to !== undefined && input.reason === undefined) fail("reason_required", "Choose a reason.", 400);
      const now = Date.now();
      const db = ctx.db;
      const topology = readTopology(ctx);
      const made = db.transaction(() => {
        // Checked before anything here moves the revision of this entry.
        if (input.expectedRev !== undefined && (loadSubject(db, input.kind, input.id) ?? fail("not_found", "No such entry.", 404)).rev !== input.expectedRev) fail("lifecycle_stale", "This entry changed since you looked. Open it again.", 409);
        const decide = () => {
          for (const d of input.decisions ?? []) {
            if (input.kind !== "person") fail("input_invalid", "Decisions belong to a person's change.", 400);
            if (!db.prepare("SELECT 1 FROM fleet_agents WHERE id = ? AND owner_id = ?").get(d.agent, input.id)) fail("agent_not_owned", "This agent does not belong to this person.", 409);
            if (d.decision === "keep") setKeepRunning(db, d.agent, d.reason ?? "", actor, now);
            else transition(db, { kind: "agent", id: d.agent, to: "leaving", reason: input.reason ?? "other", actor, noCap: true, grants: grantsOf(db, topology, "agent", d.agent) }, now);
          }
        };
        const dates = () => {
          if (input.validFrom === undefined && input.validUntil === undefined) return;
          setDates(db, { kind: input.kind, id: input.id, ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}), ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}), confirmPastDate: input.confirmPastDate, confirmCount: input.confirmCount, noCap: stopping, actor }, now);
        };
        const change = () => (input.to === undefined ? null : transition(db, { kind: input.kind, id: input.id, to: input.to, reason: input.reason ?? "other", note: input.note, actor, confirmCount: input.confirmCount, waive: input.waive, grants: input.to === "leaving" ? grantsOf(db, topology, input.kind, input.id) : [] }, now));
        // One call passes the cap once. A stop goes first and counts for its dates and decisions. Otherwise the dates and decisions go first:
        // a resume can need a new end date, and a close needs the decisions. Stop decisions with no stop of their own pass the cap here.
        const stopping = input.to === "suspended" || input.to === "leaving";
        if (stopping) {
          const out = change();
          dates();
          decide();
          return out;
        }
        dates();
        if (input.decisions?.some((d) => d.decision === "stop")) assertCap(db, input.confirmCount, now);
        decide();
        const out = change();
        return out;
      });
      return { colleague: await colleagueDetail(ctx, input.kind, input.id), transition: made ? { from: made.from, to: made.to, event: made.event } : null };
    },
  }),
  [OP.settingsSet]: op<SettingsSetInput, SettingsSetOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      return setSettings(ctx.db, input, { kind: "owner", id: ctx.caller.id });
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
