// From an SDK context to what the runner needs. The one place that reads the optional SDK members, so an older SDK reads as "the rail is off", never as a crash.
import { readFileSync } from "node:fs";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessEnv } from "../access/client.ts";
import { readTopology } from "../lifecycle/view.ts";
import { clientPort } from "./access-port.ts";
import type { AlertPort, AskAnswer } from "./alerts.ts";
import type { OwnerDraftsApi } from "./core-rail.ts";
import type { PlanCtx } from "./runner.ts";

const manifest = JSON.parse(readFileSync(new URL("../../tealbrick.manifest.json", import.meta.url), "utf8")) as { companions?: { product: string }[] };
/** The stores of this version: an absent one reads "Not installed" (ACCESS.md). */
const DECLARED: ReadonlySet<string> = new Set((manifest.companions ?? []).map((c) => c.product));
type CallApp = <O>(product: string, op: string, input: never, opts?: { idempotencyKey?: string }) => Promise<{ status: string; output?: O }>;

const NO_INBOX = new Set(["no_grant", "companion_undeclared", "unknown_tool", "unknown_op", "no_access", "hook_denied", "hold_denied", "bridge_cap_missing"]);

export function alertPortOver(ctx: { callApp: CallApp; companionTargets(): string[] }): AlertPort {
  return {
    async ask(input): Promise<AskAnswer> {
      if (!ctx.companionTargets().includes("inbox")) return { kind: "no_inbox", code: "not_installed" };
      try {
        const out = await ctx.callApp("inbox", "inbox_ask", { title: input.title, kind: "question", context: input.context, responses: ["answer"], priority: "high", open: { path: "/" } } as never, { idempotencyKey: input.key });
        return out.status === "ok" ? { kind: "sent" } : { kind: "no_inbox", code: "held" };
      } catch (e) {
        if (e instanceof TbError && NO_INBOX.has(e.code)) return { kind: "no_inbox", code: e.code };
        return { kind: "retry", code: e instanceof TbError ? e.code : "no_answer" };
      }
    },
  };
}

type SdkCtx = Parameters<typeof readTopology>[0] & {
  callApp: unknown;
  companionTargets(): string[];
  topology(): { instances: readonly (readonly unknown[])[]; truncated?: boolean } | null;
  paused(agent?: string | null): { agent: boolean };
  log: { warn(msg: string, f?: Record<string, string>): void };
  signal?: AbortSignal;
};

/** Over a job's or an op's context. `ownerDrafts` and `sliceRevision` are optional until the pin carries them. */
export function planCtxOf(ctx: SdkCtx): PlanCtx {
  const extra = ctx as unknown as { ownerDrafts?: OwnerDraftsApi; sliceRevision?: () => number | null };
  const callApp = ctx.callApp as AccessEnv["callApp"];
  return {
    db: ctx.db,
    rail: extra.ownerDrafts ?? null,
    access: clientPort({ callApp: (p, o, i, opts) => callApp(p, o, i, opts), companionTargets: () => ctx.companionTargets(), topology: () => ctx.topology(), declared: DECLARED }),
    alerts: alertPortOver({ callApp: (p, o, i, opts) => callApp(p, o, i as never, opts) as never, companionTargets: () => ctx.companionTargets() }),
    slice: {
      paused: (agent) => ctx.paused(agent).agent,
      topology: () => readTopology(ctx),
      revision: () => extra.sliceRevision?.() ?? null,
    },
    now: () => Date.now(),
    signal: ctx.signal,
    warn: (msg, fields) => ctx.log.warn(msg, fields),
  };
}
