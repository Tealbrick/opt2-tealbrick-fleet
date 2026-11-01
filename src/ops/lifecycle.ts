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
  type RefusalsGetInput,
  type RefusalsGetOutput,
  type SettingsSetInput,
  type SettingsSetOutput,
  type SummaryGetInput,
  type SummaryGetOutput,
} from "#kit";
import { refusalsGet } from "../lifecycle/refusals.ts";
import { setSettings } from "../lifecycle/settings.ts";
import { type Actor, assertCap, loadSubject, setDates, transition } from "../lifecycle/transitions.ts";
import { colleagueDetail, colleaguesList, grantsOf, readTopology, summaryGet } from "../lifecycle/view.ts";
import { fail } from "../meta.ts";
import { planCtxOf } from "../plans/context.ts";
import { assertAllClosed, type CloseResult, closeOpenPlans } from "../plans/control.ts";
import { kickBarRun } from "../plans/jobs.ts";
import { openPlansOf } from "../plans/plan.ts";
import { op } from "./op.ts";

/** The manifest says `person`. The handler says it again: a lifecycle is the owner's act, and a wrong manifest must not open it. */
export function assertOwner(caller: { type: string }): void {
  if (caller.type !== "person") throw new TbError("no_access", "Only the owner can do this.", 403);
}

class TriedOnly extends Error {}

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
      const change = () => db.transaction(() => {
        // Checked before anything here moves the revision of this entry.
        if (input.expectedRev !== undefined && (loadSubject(db, input.kind, input.id) ?? fail("not_found", "No such entry.", 404)).rev !== input.expectedRev) fail("lifecycle_stale", "This entry changed since you looked. Open it again.", 409);
        const decide = () => {
          for (const d of input.decisions ?? []) {
            if (input.kind !== "person") fail("input_invalid", "Decisions belong to a person's change.", 400);
            if (!db.prepare("SELECT 1 FROM fleet_agents WHERE id = ? AND owner_id = ?").get(d.agent, input.id)) fail("agent_not_owned", "This agent does not belong to this person.", 409);
            transition(db, { kind: "agent", id: d.agent, to: "leaving", reason: input.reason ?? "other", actor, noCap: true, grants: grantsOf(db, topology, "agent", d.agent) }, now);
          }
        };
        const dates = () => {
          if (input.validFrom === undefined && input.validUntil === undefined) return;
          setDates(db, { kind: input.kind, id: input.id, ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}), ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}), confirmPastDate: input.confirmPastDate, confirmCount: input.confirmCount, noCap: stopping, actor }, now);
        };
        const move = () => (input.to === undefined ? null : transition(db, { kind: input.kind, id: input.id, to: input.to, reason: input.reason ?? "other", note: input.note, actor, confirmCount: input.confirmCount, waive: input.waive, grants: input.to === "leaving" ? grantsOf(db, topology, input.kind, input.id) : [] }, now));
        // One call passes the cap once. A stop goes first and counts for its dates and decisions. Otherwise the dates and decisions go first:
        // a resume can need a new end date, and a close needs the decisions. Stop decisions with no stop of their own pass the cap here.
        const stopping = input.to === "suspended" || input.to === "leaving";
        if (stopping) {
          const out = move();
          dates();
          decide();
          return out;
        }
        dates();
        assertCap(db, input.confirmCount, now, (input.decisions ?? []).filter((d) => d.decision === "stop").map((d) => `agent:${d.agent}`));
        decide();
        const out = move();
        return out;
      });
      // T4, T6 (§2): the draft is taken back first, and only then the state moves. So the whole change is tried first and rolled back: what it would refuse takes nothing back, with its own dates and decisions counted. No await in the try.
      const undoing = input.to === "active" || input.to === "proposed";
      const open = undoing ? openPlansOf(db, input.kind, input.id) : [];
      let closed: CloseResult | null = null;
      if (open.length > 0) {
        try {
          db.transaction(() => {
            change();
            throw new TriedOnly();
          });
        } catch (e) {
          if (!(e instanceof TriedOnly)) throw e;
        }
        closed = await closeOpenPlans(planCtxOf(ctx as never), open, "withdrawn");
        assertAllClosed(closed);
      }
      let made: ReturnType<typeof change>;
      try {
        made = change();
      } catch (e) {
        // The entry moved during the call to Portal. The owner reads what is true: the request is gone, the entry is not changed.
        if (closed && closed.withdrawn > 0 && e instanceof TbError) throw new TbError(e.code, `${e.message} The request in Portal was taken back already, and this entry did not change.`, e.httpStatus);
        throw e;
      }
      if (input.kind === "person" && input.to === "leaving") kickBarRun(ctx as never, now);
      return { colleague: await colleagueDetail(ctx, input.kind, input.id), transition: made ? { from: made.from, to: made.to, event: made.event } : null };
    },
  }),
  [OP.refusalsGet]: op<RefusalsGetInput, RefusalsGetOutput>({
    // Read only. N2-4: what Rules refuses, and what starts to refuse with this update, read before Rules is updated.
    async run(_input, ctx) {
      assertOwner(ctx.caller);
      return refusalsGet(ctx);
    },
  }),
  [OP.settingsSet]: op<SettingsSetInput, SettingsSetOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      return setSettings(ctx.db, input, { kind: "owner", id: ctx.caller.id });
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
