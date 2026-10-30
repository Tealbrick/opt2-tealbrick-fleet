// One person or agent (DESIGN-C380 §10): the one-line state, what no longer matches, what is left to do in Portal, the moves
// the server allows (with the reason when one is blocked), and the history. Raw ids and the three axes sit under Details only.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, ButtonLink, EmptyState, Notice, Table, Tag, TextLink } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import type { ColleagueGetOutput } from "#kit";
import { LoadFailed, Loading, PageHead, useLoad } from "../common.tsx";
import { ChangeDialog, CloseDialog } from "./change-dialogs.tsx";
import { LeaveFlow } from "./leave-flow.tsx";
import { PlanResult } from "./plan-result.tsx";
import { StopNow } from "./stop-now.tsx";
import { openSubject, type SubjectKind, subjectFromUrl, subjectHref } from "./subject-link.ts";
import { type Lifecycle, reasonLabel, when } from "./words.ts";

type Colleague = ColleagueGetOutput["colleague"];
type Action = Colleague["actions"][number];

function useSubject() {
  const [at, setAt] = useState(() => subjectFromUrl(globalThis.location.search));
  useEffect(() => {
    const onPop = () => setAt(subjectFromUrl(globalThis.location.search));
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);
  return at;
}

export function SubjectPage({ portalHref }: { portalHref?: string }) {
  const at = useSubject();
  if (!at)
    return (
      <section className="app-page" aria-label="Person or agent">
        <EmptyState title="This entry is not in the link." action={<ButtonLink href="./people-and-agents">People and agents</ButtonLink>}>
          Open it from People and agents.
        </EmptyState>
      </section>
    );
  return <Subject key={`${at.kind}:${at.id}`} kind={at.kind} id={at.id} portalHref={portalHref} />;
}

function Subject({ kind, id, portalHref }: { kind: SubjectKind; id: string; portalHref?: string }) {
  const load = useCallback(() => callOp<ColleagueGetOutput>("colleague_get", { kind, id }), [kind, id]);
  const { data, error, loading, reload } = useLoad(load);
  const [doing, setDoing] = useState<Action | null>(null);
  const c = data?.colleague;
  const gone = error !== null && !data;
  return (
    <section className="app-page" aria-label="Person or agent">
      <span>
        <TextLink href="./people-and-agents">Back to People and agents</TextLink>
      </span>
      {gone ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      {c ? (
        <>
          <PageHead title={c.name} lede={c.line} />
          {error ? <LoadFailed message={`This page may be old. ${error}`} retrying={loading} onRetry={() => void reload()} /> : null}
          <Actions actions={c.actions} onChoose={setDoing} />
          <Facts c={c} />
          {c.findings.length ? (
            <section className="tb-stack" aria-label="Differences">
              <h2 className="sub-head">What no longer matches</h2>
              {c.findings.map((f) => (
                <Notice key={f.code} tone="needs-you">
                  {f.text}
                </Notice>
              ))}
            </section>
          ) : null}
          {c.plan || c.lifecycle !== "active" ? (
            <section className="tb-stack" aria-label="What happens now">
              <h2 className="sub-head">What happens now</h2>
              <PlanResult colleague={c} portalHref={portalHref} showLine={false} />
            </section>
          ) : null}
          {c.kind === "person" && c.agents.length ? <OwnedAgents agents={c.agents} /> : null}
          {c.grantsBefore?.length ? <GrantsBefore grants={c.grantsBefore} /> : null}
          <History items={c.history} />
          <details className="details">
            <summary>Details</summary>
            <dl className="kv mono">
              <dt>Id</dt>
              <dd>{c.id}</dd>
              <dt>Lifecycle</dt>
              <dd>{c.lifecycle}</dd>
              <dt>Effective</dt>
              <dd>{c.effective}</dd>
              <dt>Runtime</dt>
              <dd>{c.runtime ?? "none"}</dd>
              <dt>Trust</dt>
              <dd>{c.trust}</dd>
              <dt>Revision</dt>
              <dd>{c.rev}</dd>
            </dl>
          </details>
          {doing ? <Doing c={c} action={doing} portalHref={portalHref} onClose={() => setDoing(null)} onChanged={reload} /> : null}
        </>
      ) : !gone ? (
        <Loading what="this entry" />
      ) : null}
    </section>
  );
}

const PRIMARY: Partial<Record<Lifecycle, boolean>> = { active: true };

function Actions({ actions, onChoose }: { actions: Action[]; onChoose: (a: Action) => void }) {
  if (actions.length === 0) return null;
  return (
    <div className="tb-stack">
      <div className="tb-row">
        {actions.map((a) => (
          <Button key={a.to} variant={a.to === "suspended" || a.to === "leaving" ? "danger" : PRIMARY[a.to] ? "primary" : "secondary"} disabled={a.blocked !== null} onClick={() => onChoose(a)}>
            {a.label}
          </Button>
        ))}
      </div>
      {actions
        .filter((a) => a.blocked)
        .map((a) => (
          <p className="tb-hint" key={a.to}>{`${a.label}: ${a.blocked}`}</p>
        ))}
    </div>
  );
}

function Doing({ c, action, portalHref, onClose, onChanged }: { c: Colleague; action: Action; portalHref?: string; onClose: () => void; onChanged: () => Promise<void> }) {
  if (action.to === "suspended") return <StopNow subject={c} portalHref={portalHref} onClose={onClose} onChanged={onChanged} />;
  if (action.to === "leaving") return <LeaveFlow c={c} portalHref={portalHref} onClose={onClose} onChanged={onChanged} />;
  if (action.to === "archived") return <CloseDialog c={c} action={action} onClose={onClose} onChanged={onChanged} />;
  return <ChangeDialog c={c} action={action} onClose={onClose} onChanged={onChanged} />;
}

function Facts({ c }: { c: Colleague }) {
  const rows: [string, string][] = [];
  if (c.title) rows.push(["Title", c.title]);
  if (c.kind === "agent") rows.push(["Owner", c.owner?.name ?? "No owner"]);
  if (c.teams.length) rows.push(["Teams", c.teams.map((t) => t.name).join(", ")]);
  if (c.reason) rows.push(["Reason", reasonLabel(c.reason)]);
  if (c.note) rows.push(["Note", c.note]);
  if (c.keepRunning) rows.push(["Kept running", c.keepReason ?? "Yes"]);
  if (c.validFrom) rows.push(["Starts", when(c.validFrom)]);
  if (c.validUntil) rows.push(["Ends", when(c.validUntil)]);
  if (rows.length === 0) return null;
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div className="kv-row" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function OwnedAgents({ agents }: { agents: Colleague["agents"] }) {
  return (
    <section className="tb-stack" aria-label="Their agents">
      <h2 className="sub-head">Their agents</h2>
      <ul className="ready">
        {agents.map((a) => (
          <li key={a.id}>
            <TextLink
              href={subjectHref("agent", a.id)}
              onClick={(e) => {
                e.preventDefault();
                openSubject("agent", a.id);
              }}
            >
              {a.name}
            </TextLink>
            <span>{a.line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GrantsBefore({ grants }: { grants: NonNullable<Colleague["grantsBefore"]> }) {
  return (
    <section className="tb-stack" aria-label="What it could use before">
      <h2 className="sub-head">What it could use before</h2>
      <p className="tb-soft">These do not come back by themselves. Grant them again in Portal.</p>
      <ul className="ready">
        {grants.map((g) => (
          <li key={`${g.agent}:${g.product}`}>
            <span>{`${g.agent}: ${g.product}`}</span>
            <Tag>{g.crud.join(", ")}</Tag>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FROM_TO: Record<string, string> = { proposed: "New, not reviewed", active: "Active", suspended: "Stopped", leaving: "Leaving", archived: "Closed", not_started: "Not started" };
const stateWord = (s: string | null) => (s ? (FROM_TO[s] ?? s) : "");

function History({ items }: { items: Colleague["history"] }) {
  return (
    <section className="tb-stack" aria-label="History">
      <h2 className="sub-head">History</h2>
      {items.length === 0 ? (
        <p className="tb-soft">Nothing has changed yet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>When</th>
              <th>Change</th>
              <th>Who</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {items.map((h) => (
              <tr key={h.id}>
                <td>{when(h.at)}</td>
                <td>{h.kind === "transition" ? `${stateWord(h.from)} to ${stateWord(h.to)}` : h.kind === "moved" ? "Owner or team changed" : h.kind === "migrated" ? "Set by the update" : h.kind === "restored" ? "Restored from a backup" : "Changed"}</td>
                <td>{h.actor === "owner" ? "You" : "Governance"}</td>
                <td>
                  {h.reason ? reasonLabel(h.reason) : ""}
                  {h.note ? ` (${h.note})` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
