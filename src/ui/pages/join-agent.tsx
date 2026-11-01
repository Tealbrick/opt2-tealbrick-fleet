// Join for a new agent (C380 T2-d; C126 StepFlow): the agents Portal added that nobody reviewed yet. Which agent, its owner, its team
// and a last day, what apps report for it now, Confirm. The review is recorded last, as "Mark as reviewed": it grants nothing.
// The agent is not made here (Portal makes agents). Sending is in join-agent-run.ts.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, ButtonLink, Choices, EmptyState, Field, type FlowStep, Notice, Select, StepFlow, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useRef, useState } from "react";
import type { ColleaguesListOutput, OverviewGetOutput } from "#kit";
import { changeError, LoadFailed, Loading, useLoad } from "../common.tsx";
import { FEATURES } from "./features.ts";
import { type AgentJoin, type AgentRun, newAgentRun, sendAgentJoin } from "./join-agent-run.ts";
import { deps } from "./join-flow.tsx";
import { lastDayInstant, untilToSend } from "./join-input.ts";
import { StoreRows } from "./store-rows.tsx";
import { loadPreview } from "./what-would-stop.tsx";
import { when } from "./words.ts";

const NO_TEAM = "none";
const list = (kind: "agent" | "person", lifecycle: "proposed" | "active") => callOp<ColleaguesListOutput>("colleagues_list", { kind, lifecycle, limit: 200 });
const STEP_WORD = { owner: "The owner is saved.", team: "The agent is in the team.", review: "The agent is marked as reviewed." } as const;

export function JoinAgentFlow({ portalHref, onClose, onChanged }: { portalHref?: string; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const agents = useLoad(useCallback(() => list("agent", "proposed"), []));
  const people = useLoad(useCallback(() => list("person", "active"), []));
  const dir = useLoad(useCallback(() => callOp<OverviewGetOutput>("overview_get", {}), []));
  const [agentId, setAgentId] = useState("");
  const [ownerPick, setOwnerPick] = useState<string | null>(null);
  const [team, setTeam] = useState(NO_TEAM);
  const [kind, setKind] = useState<"keep" | "ends">("keep");
  const [day, setDay] = useState("");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const run = useRef<AgentRun | null>(null);
  /** what the first send used: a repeat sends the same */
  const frozen = useRef<AgentJoin | null>(null);
  const agent = agents.data?.items.find((a) => a.id === agentId) ?? null;
  const ownerId = ownerPick ?? agent?.owner?.id ?? "";
  const owner = people.data?.items.find((p) => p.id === ownerId) ?? null;
  const teams = dir.data?.teams ?? [];
  const teamId = team !== NO_TEAM ? team : null;
  const teamName = teams.find((t) => t.id === teamId)?.name;
  const last = kind === "ends" && day ? lastDayInstant(day) : null;
  const until = last?.ok ? last.iso : null;
  const dayOk = kind === "keep" || until !== null;
  const preview = useLoad(useCallback(() => (FEATURES.preview && agentId ? loadPreview("agent", agentId) : Promise.resolve(null)), [agentId]));

  const send = async (): Promise<boolean | undefined> => {
    if (!agent || !owner) return false;
    if (!frozen.current) {
      const end = untilToSend(kind === "ends", day);
      if (!end.ok) {
        setFailure(`${end.text} Nothing was changed.`);
        return false;
      }
      frozen.current = { agent: agent.id, owner: owner.id !== agent.owner?.id ? owner.id : null, team: teamId, until: end.until, clearUntil: end.until === null && agent.validUntil !== null };
    }
    setBusy(true);
    setFailure(null);
    try {
      run.current ??= newAgentRun(globalThis.crypto.randomUUID());
      await sendAgentJoin(run.current, frozen.current, deps);
      setSent(true);
      await Promise.resolve(onChanged());
      return undefined;
    } catch (e) {
      setFailure(changeError(e));
      return false;
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  };
  const again = async () => {
    if (!run.current || !frozen.current) return;
    setBusy(true);
    try {
      await sendAgentJoin(run.current, frozen.current, deps);
      await Promise.resolve(onChanged());
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  };

  const whichStep: FlowStep = {
    name: "Which agent",
    canNext: agent !== null,
    render: () =>
      agents.error && !agents.data ? (
        <LoadFailed message={agents.error} retrying={agents.loading} onRetry={() => void agents.reload()} />
      ) : !agents.data ? (
        <Loading what="the new agents" />
      ) : agents.data.items.length === 0 ? (
        <EmptyState title="No new agent waits for a review.">Agents appear here when you add them in Portal.</EmptyState>
      ) : (
        <div className="tb-stack">
          <p className="tb-soft">These agents were added in Portal and are not reviewed yet. This records who owns one and that you looked at it. It grants nothing.</p>
          <Field label="Agent">
            <Select placeholder="Choose an agent" options={agents.data.items.map((a) => ({ value: a.id, label: a.name }))} value={agentId} onValueChange={(v) => {
                setAgentId(v);
                setOwnerPick(null);
              }} />
          </Field>
        </div>
      ),
  };
  const whoStep: FlowStep = {
    name: "Owner, team and last day",
    canNext: owner !== null && dayOk,
    render: () => (
      <div className="tb-stack">
        {people.error && !people.data ? <LoadFailed message={people.error} retrying={people.loading} onRetry={() => void people.reload()} /> : null}
        {people.data && people.data.total > people.data.items.length ? <p className="tb-hint">{`This list shows ${people.data.items.length} of ${people.data.total} people. Add the owner on the People page if the person is not here.`}</p> : null}
        <Field label="Owner" hint="A person who is active. They answer for this agent." error={agent && !owner && people.data ? "Choose an owner." : undefined}>
          <Select placeholder="Choose a person" options={(people.data?.items ?? []).filter((p) => p.trust !== "blocked").map((p) => ({ value: p.id, label: p.name }))} value={ownerId} onValueChange={setOwnerPick} />
        </Field>
        <Field label="Team" hint="Optional.">
          <Select placeholder="No team" options={[{ value: NO_TEAM, label: "No team" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} value={team} onValueChange={setTeam} />
        </Field>
        {agent?.validUntil ? <Notice tone="neutral">{`This agent has a last day already: ${when(agent.validUntil)}. Choose "Has a last day" to change it. Choose "Has no end" to remove it.`}</Notice> : null}
        <Choices<"keep" | "ends">
          label="This agent"
          value={kind}
          onChange={setKind}
          options={[
            { value: "keep", title: "Has no end", body: "It works until you stop it." },
            { value: "ends", title: "Has a last day", body: "Governance marks it as stopped at the end of that day." },
          ]}
        />
        {kind === "ends" ? (
          <Field label="Last day" hint="Governance marks the agent as stopped at the end of this day, UTC." error={last && !last.ok ? last.text : undefined}>
            <TextInput type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
        ) : null}
      </div>
    ),
  };
  const reachStep: FlowStep = {
    name: "What it can reach",
    render: () => (
      <div className="tb-stack">
        <p className="tb-soft">What each app reports for this agent now. Reviewing it changes none of this. To change access, use Portal.</p>
        {!FEATURES.preview ? <Notice tone="neutral">This version cannot list what the apps report.</Notice> : null}
        {preview.error ? <LoadFailed message={preview.error} retrying={preview.loading} onRetry={() => void preview.reload()} /> : null}
        {FEATURES.preview && preview.data === null && !preview.error ? <Loading what="what each app reports" /> : null}
        {preview.data ? <StoreRows stores={preview.data.stores} subjectName={agent?.name ?? ""} unlinkedAccounts={0} bare /> : null}
        {portalHref ? (
          <span>
            <ButtonLink href={portalHref} target="_blank" rel="noreferrer">
              Open Portal
            </ButtonLink>
          </span>
        ) : null}
      </div>
    ),
  };
  const confirmStep: FlowStep = {
    name: "Confirm",
    nextLabel: "Mark as reviewed",
    canNext: agent !== null && owner !== null && dayOk,
    onNext: send,
    render: () => (
      <div className="tb-stack">
        {failure ? (
          <Notice tone="needs-you" role="alert">
            {failure}
          </Notice>
        ) : null}
        <dl className="kv">
          <div className="kv-row">
            <dt>Agent</dt>
            <dd>{agent?.name ?? ""}</dd>
          </div>
          <div className="kv-row">
            <dt>Owner</dt>
            <dd>{owner?.name ?? ""}</dd>
          </div>
          <div className="kv-row">
            <dt>Team</dt>
            <dd>{teamName ?? "None"}</dd>
          </div>
          <div className="kv-row">
            <dt>Last day</dt>
            <dd>{until ? day : agent?.validUntil ? "None. The last day it has now is removed." : "None"}</dd>
          </div>
        </dl>
        <Notice tone="neutral">This records the owner, the team and that you reviewed the agent. It grants no access and changes nothing in Portal.</Notice>
        {until ? <Notice tone="neutral">{`At the end of ${day} (UTC), Governance marks this agent as stopped, and the steps to stop it in Portal wait for you. This needs Governance to be running then.`}</Notice> : null}
      </div>
    ),
  };
  const resultStep: FlowStep = {
    name: "Result",
    nextLabel: "Done",
    render: () => {
      const r = run.current;
      if (!r) return <p className="tb-soft">Nothing has changed yet.</p>;
      return (
        <div className="tb-stack" role="status">
          {r.done.has("review") ? <p>{`${agent?.name} is marked as reviewed.`}</p> : null}
          {(["owner", "team", "review"] as const).filter((s) => r.done.has(s)).map((s) => (
            <p className="tb-soft" key={s}>
              {s === "team" && r.teamName ? `The agent is in the team ${r.teamName}.` : STEP_WORD[s]}
            </p>
          ))}
          {r.failed ? (
            <Notice tone="needs-you" role="alert">
              {`${r.failed.step === "review" ? "The agent was not marked as reviewed." : r.failed.step === "team" ? "The agent was not put in the team, so it is not marked as reviewed yet." : "The owner was not saved, so nothing else was done."} ${r.failed.message} What went through is kept: Send again repeats only the rest.`}
              <span>
                <Button size="sm" onClick={() => void again()} disabled={busy}>
                  Send again
                </Button>
              </span>
            </Notice>
          ) : null}
          {r.done.has("review") && until ? <p>{`Last day saved: ${day} (UTC).`}</p> : null}
        </div>
      );
    },
  };
  const steps: FlowStep[] = sent ? [resultStep] : [whichStep, whoStep, reachStep, confirmStep, resultStep];
  return <StepFlow open size="lg" step={Math.min(step, steps.length - 1)} onStepChange={setStep} title="Review a new agent" steps={steps} busy={busy} onClose={onClose} onFinish={onClose} />;
}
