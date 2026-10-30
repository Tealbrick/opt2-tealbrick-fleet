// "Stop this person's agents and access in Teal Brick" (DESIGN-C380 §10, C126 StepFlow): one step at a time. It says what it
// does not change before the Confirm, says "This stops now" in place of a last-day field, and the last step reads back what
// the server knows. For one agent the same flow has no "Their agents" step.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Choices, Field, type FlowStep, Notice, Select, StepFlow, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useRef, useState } from "react";
import type { ColleagueGetOutput, ColleaguesListOutput, LifecycleSetInput, LifecycleSetOutput, PlanSendInput } from "#kit";
import { changeError, useLoad } from "../common.tsx";
import { FEATURES } from "./features.ts";
import { lifecycleError, stopCapOf } from "./lifecycle-errors.ts";
import { sendPlan } from "./plan-live.tsx";
import { NotChanged, PlanResult } from "./plan-result.tsx";
import { type Tick, WhatStopsStep } from "./what-stops-step.tsx";
import { beforeChangeText, beforeChangeTone, NOTE_HINT, type Reason, reasonLabel, reasonOptions } from "./words.ts";

type Colleague = ColleagueGetOutput["colleague"];
type Decision = "stop" | "keep" | "transfer";

const KEEP_SENTENCE = "The person who left may still hold this agent's key.";
const TRANSFER_SENTENCE = "A new key is needed. The agent loses this person's personal memory and gains the new owner's.";
type Owner = { value: string; label: string };

function AgentsStep({ agents, decisions, onDecide, keepReasons, onKeepReason, owners, newOwners, onNewOwner }: { agents: Colleague["agents"]; decisions: Record<string, Decision>; onDecide: (id: string, d: Decision) => void; keepReasons: Record<string, string>; onKeepReason: (id: string, v: string) => void; owners: Owner[] | null; newOwners: Record<string, string>; onNewOwner: (id: string, v: string) => void }) {
  if (agents.length === 0) return <p>This person owns no agents.</p>;
  return (
    <div className="tb-stack">
      {agents.map((a) => (
        <div className="tb-stack" key={a.id}>
          <h3 className="flow-agent">
            {a.name}
            <span className="tb-hint">{a.line}</span>
          </h3>
          <Choices<Decision>
            label={a.name}
            value={decisions[a.id] ?? "stop"}
            onChange={(v) => onDecide(a.id, v)}
            options={[
              { value: "stop", title: "Stop and remove", body: "Governance marks it to stop. It is paused and loses its access when you do the steps in Portal." },
              { value: "keep", title: "Keep running", body: KEEP_SENTENCE },
              ...(owners ? [{ value: "transfer" as const, title: "Pause and transfer", body: TRANSFER_SENTENCE }] : []),
            ]}
          />
          {decisions[a.id] === "transfer" ? (
            <Field label={`New owner of ${a.name}`}>
              <Select placeholder="Choose a person" options={owners ?? []} value={newOwners[a.id] ?? ""} onValueChange={(v) => onNewOwner(a.id, v)} />
            </Field>
          ) : null}
          {decisions[a.id] === "keep" ? (
            <Field label={`Why does ${a.name} keep running?`} hint="Required. This is kept in the history.">
              <TextInput value={keepReasons[a.id] ?? ""} maxLength={200} onChange={(e) => onKeepReason(a.id, e.target.value)} />
            </Field>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function LeaveFlow({ c, portalHref, onClose, onChanged }: { c: Colleague; portalHref?: string; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const [reason, setReason] = useState<Reason | "">("");
  const [note, setNote] = useState("");
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => Object.fromEntries(c.agents.filter((a) => a.keepRunning).map((a) => [a.id, "keep" as const])));
  const [keepReasons, setKeepReasons] = useState<Record<string, string>>({});
  const [newOwners, setNewOwners] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<Tick[] | null>(null);
  const people = useLoad(useCallback(() => (FEATURES.plans && c.kind === "person" ? callOp<ColleaguesListOutput>("colleagues_list", { kind: "person", lifecycle: "active", limit: 200 }) : Promise.resolve(null)), [c.kind]));
  const owners = FEATURES.plans && c.kind === "person" && people.data ? people.data.items.filter((p) => p.id !== c.id).map((p) => ({ value: p.id, label: p.name })) : null;
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<Colleague | null>(null);
  const sent = useRef(false);
  const [capCount, setCapCount] = useState<number | null>(null);
  const person = c.kind === "person";
  // an agent already leaving or closed has its own state: no decision to make here
  const agents = person ? c.agents.filter((a) => a.lifecycle === "proposed" || a.lifecycle === "active" || a.lifecycle === "suspended") : [];
  const keeps = agents.filter((a) => decisions[a.id] === "keep");
  const transfers = agents.filter((a) => decisions[a.id] === "transfer");
  const keepsNamed = keeps.every((a) => (keepReasons[a.id] ?? "").trim()) && transfers.every((a) => newOwners[a.id]);

  const send = async (): Promise<boolean | undefined> => {
    if (sent.current || !reason) return undefined;
    setBusy(true);
    setFailure(null);
    const input: LifecycleSetInput = { kind: c.kind, id: c.id, to: "leaving", reason, expectedRev: c.rev };
    if (note.trim()) input.note = note.trim();
    if (capCount !== null) input.confirmCount = capCount;
    const decided = agents.filter((a) => decisions[a.id] !== "transfer");
    if (decided.length) input.decisions = decided.map((a) => (decisions[a.id] === "keep" ? { agent: a.id, decision: "keep" as const, reason: (keepReasons[a.id] ?? "").trim() } : { agent: a.id, decision: "stop" as const }));
    try {
      // the new owner first: an agent that moved is no longer this person's, and agent_set is safe to repeat after a refusal below
      for (const a of transfers) await callOp("agent_set", { agent: a.id, owner: newOwners[a.id] as string });
      const out = await callOp<LifecycleSetOutput>("lifecycle_set", input);
      if (FEATURES.plans) {
        const plan: PlanSendInput = { kind: c.kind, id: c.id };
        if (transfers.length) plan.transfers = transfers.map((a) => a.id);
        if (selected) plan.items = selected;
        setSendFailure(await sendPlan(plan));
      }
      sent.current = true;
      setResult(out.colleague);
      await onChanged();
      return undefined;
    } catch (e) {
      const cap = stopCapOf(e);
      if (cap !== null) setCapCount(cap);
      // the page was old: read it again, so the next try sends the new state
      const code = (e as { code?: unknown } | null)?.code;
      if (code === "lifecycle_stale" || code === "agent_not_owned") await onChanged();
      setFailure(lifecycleError(e, changeError).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const resultStep: FlowStep = {
    name: "Result",
    nextLabel: "Done",
    render: () => (result ? <PlanResult colleague={result} portalHref={portalHref} showNotChanged={false} sendFailure={sendFailure} /> : <p className="tb-soft">Nothing has changed yet.</p>),
  };
  // once sent, only the result is left: going back could not change what was sent
  const steps: FlowStep[] = result ? [resultStep] : [
    {
      name: "Why",
      canNext: Boolean(reason),
      render: () => (
        <div className="tb-stack">
          <p className="tb-soft">{person ? `This marks ${c.name}'s agents to stop, and lists what to do in Portal to stop them and remove their access in Teal Brick. It does not end their employment or their own logins.` : `This marks ${c.name} to stop, and lists what to do in Portal to stop it and remove its access in Teal Brick.`}</p>
          <Field label="Reason">
            <Select placeholder="Choose a reason" options={reasonOptions("leaving")} value={reason} onValueChange={(v) => setReason(v as Reason)} />
          </Field>
          <Field label="Note" hint={NOTE_HINT}>
            <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Notice tone="neutral">The mark takes effect now. There is no last-day date.</Notice>
        </div>
      ),
    },
    ...(person
      ? [
          {
            name: "Their agents",
            canNext: keepsNamed,
            render: () => <AgentsStep agents={agents} decisions={decisions} onDecide={(id, d) => setDecisions((s) => ({ ...s, [id]: d }))} keepReasons={keepReasons} onKeepReason={(id, v) => setKeepReasons((s) => ({ ...s, [id]: v }))} owners={owners} newOwners={newOwners} onNewOwner={(id, v) => setNewOwners((s) => ({ ...s, [id]: v }))} />,
          },
        ]
      : []),
    ...(FEATURES.preview
      ? [
          {
            name: "What stops",
            render: () => <WhatStopsStep kind={c.kind} id={c.id} name={c.name} onChange={setSelected} />,
          },
        ]
      : []),
    {
      name: "Confirm",
      nextLabel: capCount !== null ? "Stop this one too" : "Stop",
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
              <dt>Who</dt>
              <dd>{c.name}</dd>
            </div>
            <div className="kv-row">
              <dt>Reason</dt>
              <dd>{reason ? reasonLabel(reason) : ""}</dd>
            </div>
            {person ? (
              <div className="kv-row">
                <dt>Their agents</dt>
                <dd>{agents.length === 0 ? "None" : `${agents.length - keeps.length - transfers.length} stop, ${keeps.length} keep running, ${transfers.length} move to a new owner`}</dd>
              </div>
            ) : null}
          </dl>
          <Notice tone={beforeChangeTone(c.floor)}>{beforeChangeText(c.floor)}</Notice>
          <NotChanged />
        </div>
      ),
    },
    resultStep,
  ];

  return <StepFlow open size="lg" step={Math.min(step, steps.length - 1)} onStepChange={setStep} title={person ? `Stop ${c.name}'s agents and access` : `Stop and remove ${c.name}`} steps={steps} busy={busy} onClose={onClose} onFinish={onClose} />;
}
