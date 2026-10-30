// Trust review ops: an agent or a companion app asks, the owner decides.
// Own file per op group (C380 B9-0): a later lane adds its op here (or in a new file under src/ops/) and registers the map in src/app.ts.
import type { HandlerSpec } from "@opt2-tealbrick/miniapp-sdk";
import {
  OP,
  type OpId,
  type ReviewDismissInput,
  type ReviewDismissOutput,
  type ReviewGetInput,
  type ReviewGetOutput,
  type ReviewPolicySetInput,
  type ReviewPolicySetOutput,
  type ReviewRecordInput,
  type ReviewRecordOutput,
  type ReviewRequestInput,
  type ReviewRequestOutput,
  type ReviewsListInput,
  type ReviewsListOutput,
} from "#kit";
import * as reviews from "../reviews.ts";
import { op } from "./op.ts";

export const reviewOps = {
  [OP.reviewRequest]: op<ReviewRequestInput, ReviewRequestOutput>({
    // An agent asks; it can never set trust. A companion app may ask too (recorded as `system` with its instance id).
    async run(input, ctx) {
      const kind = ctx.caller.type === "agent" ? "agent" : ctx.caller.type === "app" ? "system" : "owner";
      return { review: reviews.requestReview(ctx.db, { kind, id: ctx.caller.id }, input) };
    },
  }),
  [OP.reviewsList]: op<ReviewsListInput, ReviewsListOutput>({
    async run(input, ctx) {
      return reviews.listReviews(ctx.db, input);
    },
  }),
  [OP.reviewGet]: op<ReviewGetInput, ReviewGetOutput>({
    async run(input, ctx) {
      return reviews.getReview(ctx.db, input);
    },
  }),
  [OP.reviewRecord]: op<ReviewRecordInput, ReviewRecordOutput>({
    // Idempotency is required by the manifest: the SDK replays a repeated key instead of recording twice.
    async run(input, ctx) {
      return { review: reviews.recordReview(ctx.db, ctx.caller.id, input) };
    },
  }),
  [OP.reviewDismiss]: op<ReviewDismissInput, ReviewDismissOutput>({
    async run(input, ctx) {
      return { review: reviews.dismissReview(ctx.db, ctx.caller.id, input.id, input.why) };
    },
  }),
  [OP.reviewPolicySet]: op<ReviewPolicySetInput, ReviewPolicySetOutput>({
    async run(input, ctx) {
      return { policy: reviews.setReviewPolicy(ctx.db, input) };
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
