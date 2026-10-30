// One person or agent (DESIGN-C380 §10): the one-line state, what no longer matches, what is left to do in Portal, the moves
// the server allows (with the reason when one is blocked), and the history. Raw ids and the three axes sit under Details only.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { appName, Button, ButtonLink, EmptyState, Notice, Table, Tag, TextLink } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import type { ColleagueGetOutput } from "#kit";
import { LoadFailed, Loading, PageHead, useLoad } from "../common.tsx";
import { canChoose } from "./agent-choice.ts";
import { ChooseDialog } from "./agent-choices.tsx";
import { ChangeDialog, CloseDialog } from "./change-dialogs.tsx";
import { FEATURES } from "./features.ts";
import { LeaveFlow } from "./leave-flow.tsx";
import { PlanResult } from "./plan-result.tsx";
import { StopNow } from "./stop-now.tsx";
import { StoreRows } from "./store-rows.tsx";
import { openSubject, type SubjectKind, subjectFromUrl, subjectHref } from "./subject-link.ts";
import { loadPreview } from "./what-would-stop.tsx";
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
  const [choosing, setChoosing] = useState(false);
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
          <KeyChoice c={c} onChoose={() => setChoosing(true)} />
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
          {c.plan || (FEATURES.plans && (c.lifecycle === "suspended" || c.lifecycle === "leaving")) ? (
            <section className="tb-stack" aria-label="What happens now">
              <h2 className="sub-head">What happens now</h2>
              <PlanResult colleague={c} portalHref={portalHref} showLine={false} onEnded={() => void reload()} />
            </section>
          ) : null}
          {FEATURES.preview ? <AccessByStore kind={c.kind} id={c.id} name={c.name} /> : null}
          {c.kind === "person" && c.agents.length ? <OwnedAgents agents={c.agents} /> : null}
          {c.grantsBefore?.length ? <GrantsBefore c={c} grants={c.grantsBefore} /> : null}
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
          {choosing ? <ChooseDialog c={c} onClose={() => setChoosing(false)} onChanged={reload} /> : null}
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

/** The second stage (D2): a stopped person's agents wait for a choice; an agent stopped through its owner is chosen on the owner's page. */
function KeyChoice({ c, onChoose }: { c: Colleague; onChoose: () => void }) {
  if (!FEATURES.plans) return null;
  if (c.kind === "person") {
    const stopped = c.lifecycle === "suspended" || c.lifecycle === "leaving";
    if (!stopped || !c.agents.some(canChoose)) return null;
    return (
      <div className="tb-row">
        <Button variant="primary" onClick={onChoose}>
          Choose for their agents
        </Button>
        <span className="tb-hint">An agent with no choice is only paused, when you approve in Portal, and its key still exists.</span>
      </div>
    );
  }
  if (!c.findings.some((f) => f.code === "key_not_decided") || !c.owner || c.lifecycle === "suspended") return null;
  const { owner } = c;
  return (
    <p className="tb-soft">
      {"Choose for this agent on the page of "}
      <TextLink
        href={subjectHref("person", owner.id)}
        onClick={(e) => {
          e.preventDefault();
          openSubject("person", owner.id);
        }}
      >
        {owner.name}
      </TextLink>
      .
    </p>
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

/** A5: what each app reports for this entry, by store, with who reported it and when. */
function AccessByStore({ kind, id, name }: { kind: SubjectKind; id: string; name: string }) {
  const { data, error, loading, reload } = useLoad(useCallback(() => loadPreview(kind, id), [kind, id]));
  return (
    <section className="tb-stack" aria-label="Access">
      <h2 className="sub-head">Access</h2>
      <p className="tb-soft">What each app reports now, and what Stop and remove access would do to it. Stop now ends less.</p>
      {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      {data === null ? error ? null : <Loading what="what each app reports" /> : <StoreRows stores={data.stores} subjectName={name} unlinkedAccounts={data.unlinkedAccounts} />}
    </section>
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

/** The snapshot holds ids: names come from this page, or the row says "An agent". */
function GrantsBefore({ c, grants }: { c: Colleague; grants: NonNullable<Colleague["grantsBefore"]> }) {
  const nameOf = (id: string) => (id === c.id ? c.name : (c.agents.find((a) => a.id === id)?.name ?? "An agent"));
  return (
    <section className="tb-stack" aria-label="What it could use before">
      <h2 className="sub-head">What it could use before</h2>
      <p className="tb-soft">These do not come back by themselves. Grant them again in Portal.</p>
      <ul className="ready">
        {grants.map((g) => (
          <li key={`${g.agent}:${g.product}`}>
            <span>{`${nameOf(g.agent)}: ${appName(g.product)}`}</span>
            <Tag>{g.crud.join(", ")}</Tag>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FROM_TO: Record<string, string> = { proposed: "New, not reviewed", active: "Active", suspended: "Stopped", leaving: "Leaving", archived: "Closed", not_started: "Not started" };
const stateWord = (s: string | null) => (s ? (FROM_TO[s] ?? "another state") : "");
const changeWord = (h: Colleague["history"][number]) => {
  if (h.kind === "moved") return "Owner or team changed";
  if (h.kind === "migrated") return "Set by the update";
  if (h.kind === "restored") return "Restored from a backup";
  if (h.kind !== "transition") return "Changed";
  return h.from ? `${stateWord(h.from)} to ${stateWord(h.to)}` : `Added as ${stateWord(h.to)}`;
};

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
                <td>{changeWord(h)}</td>
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
