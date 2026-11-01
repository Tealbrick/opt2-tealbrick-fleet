// A stop's plan, live (DESIGN-C380 §5, §10): every step in the server's words. Only state `done` reads as proved; a claim stays a claim.
// Governance has no approve button: the owner approves in Portal. Polls while the plan moves: every 2 seconds until the request is ready
// in Portal or the plan ended, then every 30 seconds; it stops when every plan has ended and when the page closes.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, ButtonLink, Notice, type Status, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanGetOutput, PlanSendInput, PlanSendOutput } from "#kit";
import { changeError, LoadFailed, Loading } from "../common.tsx";
import { currentPlans, pollDelay } from "./plan-poll.ts";
import { NotChanged } from "./plan-result.tsx";
import { when } from "./words.ts";

export type Plan = PlanGetOutput["plans"][number];
type Step = Plan["steps"][number];

const STEP_TAG: Record<string, { status: Status; word: string }> = {
  done: { status: "live", word: "Proved" },
  reported: { status: "default", word: "Said, not proved" },
  not_provable: { status: "default", word: "Cannot be checked" },
  pending_bridge: { status: "busy", word: "Not seen yet" },
  manual: { status: "needs-you", word: "Someone must do this" },
  refused: { status: "needs-you", word: "Refused" },
  failed: { status: "needs-you", word: "Failed" },
  changed: { status: "needs-you", word: "Changed" },
  waiting: { status: "busy", word: "Waiting for approval" },
  sending: { status: "busy", word: "Asked" },
  claimed: { status: "busy", word: "Checking" },
  pending: { status: "open", word: "Not done yet" },
  not_revocable: { status: "open", word: "Not done yet" },
  listed: { status: "idle", word: "Stays" },
  not_installed: { status: "idle", word: "Not installed" },
  excepted: { status: "idle", word: "Accepted" },
  cancelled: { status: "idle", word: "Cancelled" },
};
const stepTag = (state: string) => STEP_TAG[state] ?? { status: "open" as const, word: "Not done yet" };


function byStore(steps: Step[]): [string, Step[]][] {
  const groups = new Map<string, Step[]>();
  for (const s of steps) groups.set(s.storeName, [...(groups.get(s.storeName) ?? []), s]);
  return [...groups];
}

function PlanCard({ plan, busy, onRetry, onCancel, portalHref }: { plan: Plan; busy: boolean; onRetry: (id: string) => void; onCancel: (id: string) => void; portalHref?: string }) {
  const { counts } = plan;
  const open = plan.closedAt === null;
  const portal = plan.mode === "portal_link" ? portalHref : undefined;
  return (
    <section className="tb-stack plan" aria-label="Plan">
      <h3>{plan.parts > 1 ? `${plan.headline} (part ${plan.part} of ${plan.parts})` : plan.headline}</h3>
      {plan.note ? <p className="tb-soft">{plan.note}</p> : null}
      <p className="tb-hint">{`${counts.proved} proved, ${counts.said} said and not proved, ${counts.manual} for someone to do, ${counts.open} open.`}</p>
      {open && plan.expiresAt && plan.reviewUrl ? <p className="tb-hint">{`The request in Portal ends ${when(plan.expiresAt)}.`}</p> : null}
      {plan.stores.map((s) =>
        s.text ? (
          <p className="tb-hint" key={s.product}>
            {`${s.name}: ${s.text}`}
          </p>
        ) : null,
      )}
      {byStore(plan.steps).map(([store, steps]) => (
        <section className="tb-stack" key={store} aria-label={store}>
          <h4 className="plan-store">{store}</h4>
          <ul className="plan-steps">
            {steps.map((s) => (
              <li key={s.id}>
                <span>
                  {s.label}
                  <span className="tb-hint plan-text">{s.text}</span>
                </span>
                <Tag status={stepTag(s.state).status}>{stepTag(s.state).word}</Tag>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="tb-row">
        {open && plan.reviewUrl ? (
          <ButtonLink variant="primary" href={plan.reviewUrl} target="_blank" rel="noreferrer">
            Open approval in Portal
          </ButtonLink>
        ) : null}
        {open && portal ? (
          <ButtonLink variant="primary" href={portal} target="_blank" rel="noreferrer">
            Open Portal
          </ButtonLink>
        ) : null}
        {plan.canRetry ? (
          <Button disabled={busy} onClick={() => onRetry(plan.id)}>
            Try again
          </Button>
        ) : null}
        {plan.canCancel ? (
          <Button disabled={busy} onClick={() => onCancel(plan.id)}>
            Take the request back
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** Sends the plan after a stop. A refused send is said in words; the mark on the entry stays either way. */
export async function sendPlan(input: PlanSendInput): Promise<string | null> {
  try {
    await callOp<PlanSendOutput>("plan_send", input);
    return null;
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "nothing_to_stop") return null;
    return `Governance marked this, but could not prepare the request in Portal. ${changeError(e)}`;
  }
}

export function PlanLive({ kind, id, since, portalHref, sendFailure, onEnded, removed = false, accessBack = false }: { kind: "person" | "agent"; id: string; since?: string | null; portalHref?: string; sendFailure?: string | null; onEnded?: () => void; removed?: boolean; accessBack?: boolean }) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(sendFailure ?? null);
  const seq = useRef(0);
  // after Try again or Prepare, a loop that stopped at an ended plan starts again
  const restart = useRef<() => void>(() => {});
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const out = await callOp<PlanGetOutput>("plan_get", { kind, id });
      if (mine !== seq.current) return null;
      setPlans(out.plans);
      setError(null);
      return out.plans;
    } catch (e) {
      if (mine === seq.current) setError(changeError(e));
      return null;
    }
  }, [kind, id]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasOpen = false;
    const tick = async () => {
      const got = await load();
      if (stopped) return;
      const delay = got ? pollDelay(got) : 30000;
      if (got?.some((p) => p.closedAt === null)) wasOpen = true;
      else if (wasOpen && got) {
        wasOpen = false;
        ended.current?.();
      }
      if (delay !== null) timer = setTimeout(() => void tick(), delay);
    };
    restart.current = () => {
      if (timer) clearTimeout(timer);
      void tick();
    };
    void tick();
    return () => {
      stopped = true;
      seq.current++;
      if (timer) clearTimeout(timer);
    };
  }, [load]);
  const act = async (op: "plan_retry" | "plan_cancel", plan: string) => {
    setBusy(true);
    setFailure(null);
    try {
      await callOp(op, { plan });
      restart.current();
    } catch (e) {
      setFailure(changeError(e));
    } finally {
      setBusy(false);
    }
  };
  const prepare = async () => {
    setBusy(true);
    const before = plans?.[0]?.id;
    const refused = await sendPlan({ kind, id });
    const out = refused ? null : await callOp<PlanGetOutput>("plan_get", { kind, id }).catch(() => null);
    setFailure(refused ?? (out && out.plans[0]?.id === before ? "This entry has nothing to stop now." : null));
    restart.current();
    setBusy(false);
  };
  const latest = plans ? currentPlans(plans, since) : [];
  return (
    <div className="tb-stack">
      {failure ? (
        <Notice tone="needs-you" role="alert">
          {failure}
        </Notice>
      ) : null}
      {error ? <LoadFailed message={plans ? `This may be old. ${error}` : error} retrying={busy} onRetry={() => void load()} /> : null}
      {plans === null ? (
        error ? null : (
          <Loading what="the plan" />
        )
      ) : latest.length === 0 && removed ? null : latest.length === 0 ? (
        <div className="tb-row">
          <span className="tb-soft">No request has been prepared for this entry.</span>
          <Button disabled={busy} onClick={() => void prepare()}>
            Prepare the request
          </Button>
        </div>
      ) : (
        latest.map((p) => <PlanCard key={p.id} plan={p} busy={busy} onRetry={(pid) => void act("plan_retry", pid)} onCancel={(pid) => void act("plan_cancel", pid)} portalHref={portalHref} />)
      )}
      {accessBack && latest.length > 0 && latest.every((p) => p.closedAt !== null) ? (
        <div className="tb-row">
          <span className="tb-soft">Portal shows a new key or app access for this agent.</span>
          <Button disabled={busy} onClick={() => void prepare()}>
            Ask Portal to remove it again
          </Button>
        </div>
      ) : null}
      {latest[0]?.notChanged.length ? <NotChanged items={latest[0].notChanged} /> : null}
    </div>
  );
}
