// Shared helpers of the tb.access/1 tests (C380 B9b): a fake store behind `callApp`, and a job context with real transactions.
import { type Json, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type AccessEnv, Pacer } from "../src/access/client.ts";
import { type AccessItem, type AccessTarget, itemDigest, type ListIn } from "../src/access/items.ts";

export const AGT = "agt_01M4TNVDHPXJGTHATZV5SVJHX9";
export const AGT2 = "agt_01M4TNVDHPXJGTHATZV5SVJHXA";
export const fastPacer = () => new Pacer(0, 0);

type Wire = Omit<AccessItem, "digest" | "since"> & { digest?: string; since?: string };

export function wire(target: AccessTarget, over: Partial<Wire> & Pick<Wire, "id" | "kind">): Wire & { digest: string } {
  const base: Wire = { subject: { kind: "agent", id: AGT }, resource: "r1", direction: "held_by", level: "use", label: "A thing", state: "active", revocable: true, ...over };
  return { ...base, digest: over.digest ?? itemDigest(target, base) };
}

export const answer = (items: unknown[], extra: { nextCursor?: string | null; notShown?: { kind: string; reason: string }[]; sweepId?: string } = {}) => {
  const nextCursor = extra.nextCursor ?? null;
  const notShown = extra.notShown ?? [];
  return { status: "ok" as const, output: { v: 1, asOf: "2026-10-30T16:00:00Z", ...(extra.sweepId ? { sweepId: extra.sweepId } : {}), items, nextCursor, notShown, complete: nextCursor === null && notShown.length === 0 } };
};

export type Call = { target: string; op: string; input: ListIn };
export type Reply = (input: ListIn, call: number) => unknown;

/** A fake `callApp`: one reply function per target; a thrown error is the bridge's refusal; every call is recorded. */
export function fakeStores(replies: Partial<Record<AccessTarget, Reply>>) {
  const calls: Call[] = [];
  const callApp = (async (target: string, op: string, input: Json) => {
    calls.push({ target, op, input: input as unknown as ListIn });
    const reply = replies[target as AccessTarget];
    if (!reply) throw new TbError("unknown_tool", "no reply set", 404);
    return await reply(input as unknown as ListIn, calls.filter((c) => c.target === target).length);
  }) as OpContext["callApp"];
  return { calls, callApp };
}

export function accessEnv(callApp: OpContext["callApp"], targets: string[] = ["connect", "knowledge", "kanban", "evolution"]): AccessEnv {
  return { callApp, companionTargets: () => targets, topology: () => ({ instances: targets.map((t) => [`ins_${t}`, t, t, "1.0.0"]) }), pacer: fastPacer(), declared: new Set(targets) };
}
