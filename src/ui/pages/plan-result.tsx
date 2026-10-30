// The two blocks every stop shows: "Not changed" (§9, on the screen, not only in docs) and the result: what Rules has confirmed
// and the steps left in Portal. Governance does not apply these steps: the server says so ("Not applied") and proves a step
// done only from what Core reports.
import { ButtonLink, Notice, Tag } from "@opt2-tealbrick/ui";
import type { LifecycleSetOutput } from "#kit";
import { afterChangeText, floorTone, NOT_CHANGED } from "./words.ts";

export function NotChanged({ items = NOT_CHANGED }: { items?: readonly string[] }) {
  return (
    <section className="not-changed" aria-label="Not changed">
      <h3>Not changed</h3>
      <ul>
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </section>
  );
}

type Colleague = LifecycleSetOutput["colleague"];
const STEP_TAG = { open: { status: "needs-you", word: "Waiting for you in Portal" }, done: { status: "live", word: "Core reports this done" }, not_provable: { status: "default", word: "Cannot be checked" } } as const;

export function PlanResult({ colleague, portalHref, showLine = true, showNotChanged = true }: { colleague: Colleague; portalHref?: string; showLine?: boolean; showNotChanged?: boolean }) {
  const { plan, floor, notices } = colleague;
  const portal = plan?.portalUrl ?? portalHref;
  return (
    <div className="tb-stack">
      {showLine ? <p>{colleague.line}</p> : null}
      <Notice tone={floorTone(floor)} role="status">
        {afterChangeText(floor)}
      </Notice>
      {notices.map((n) => (
        <Notice key={n} tone="neutral">
          {n}
        </Notice>
      ))}
      {plan ? (
        <section className="tb-stack plan" aria-label="Steps in Portal">
          <h3>{plan.headline}</h3>
          <ol className="plan-steps">
            {plan.steps.map((s) => (
              <li key={s.id}>
                <span>{s.text}</span>
                <Tag status={STEP_TAG[s.state].status} title={s.proof}>
                  {STEP_TAG[s.state].word}
                </Tag>
              </li>
            ))}
          </ol>
          {plan.note ? <p className="tb-hint">{plan.note}</p> : null}
          {plan.openSteps > 0 && portal ? (
            <span>
              <ButtonLink variant="primary" href={portal} target="_blank" rel="noreferrer">
                Open Portal
              </ButtonLink>
            </span>
          ) : null}
        </section>
      ) : null}
      {showNotChanged ? <NotChanged items={plan?.notChanged.length ? plan.notChanged : NOT_CHANGED} /> : null}
    </div>
  );
}
