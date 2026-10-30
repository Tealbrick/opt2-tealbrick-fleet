// Review round ops (C380 T2-b). Person ops only: no agent and no app can call them, and each handler checks that again. A verdict is the existing
// review (src/reviews.ts); the removal it may ask for is a plan by the plan path, and the runner is the only one that calls an app.
import type { HandlerSpec } from "@opt2-tealbrick/miniapp-sdk";
import { OP, type OpId, type RoundCreateInput, type RoundCreateOutput, type RoundVerdictInput, type RoundVerdictOutput, type RoundGetInput, type RoundGetOutput, type RoundSetInput, type RoundSetOutput } from "#kit";
import { kickPlans } from "../plans/jobs.ts";
import { closeRound, createRound, decide, listRounds, roundDetail, roundRow, sendQueued, summaryOf } from "../rounds.ts";
import { assertOwner } from "./lifecycle.ts";
import { op } from "./op.ts";

export const roundOps = {
  [OP.roundCreate]: op<RoundCreateInput, RoundCreateOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      const now = Date.now();
      const made = createRound(ctx.db, ctx.caller.id, input, now);
      return { round: summaryOf(ctx.db, roundRow(ctx.db, made.id) as never, now), skipped: made.skipped } as never;
    },
  }),
  [OP.roundGet]: op<RoundGetInput, RoundGetOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      const now = Date.now();
      return { rounds: listRounds(ctx.db, now), round: input.round ? roundDetail(ctx.db, input.round, now) : null } as never;
    },
  }),
  [OP.roundVerdict]: op<RoundVerdictInput, RoundVerdictOutput>({
    // Idempotency is required by the manifest: a repeated key replays the answer instead of deciding twice.
    async run(input, ctx) {
      assertOwner(ctx.caller);
      const out = decide(ctx.db, ctx.caller.id, input, Date.now());
      if (out.plan !== null) kickPlans(ctx as never);
      return out as never;
    },
  }),
  [OP.roundSet]: op<RoundSetInput, RoundSetOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      const now = Date.now();
      let planned = 0;
      let queued = 0;
      if (input.action === "send") {
        ({ planned, queued } = sendQueued(ctx.db, ctx.caller.id, input.round, now));
        if (planned > 0) kickPlans(ctx as never);
      } else closeRound(ctx.db, ctx.caller.id, input.round, now);
      return { round: summaryOf(ctx.db, roundRow(ctx.db, input.round) as never, now), planned, queued } as never;
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
