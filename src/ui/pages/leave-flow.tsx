// "Stop this person's agents and access in Teal Brick" (DESIGN-C380 §10, C126 StepFlow): one step at a time. It says what it
// does not change before the Confirm, says "This stops now" in place of a last-day field, and the last step reads back what
// the server knows. For one agent the same flow has no "Their agents" step.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Choices, Field, type FlowStep, Notice, Select, StepFlow, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useRef, useState } from "react";
import type { ColleagueGetOutput, LifecycleSetInput, LifecycleSetOutput } from "#kit";
import { changeError } from "../common.tsx";
import { lifecycleError, stopCapOf } from "./lifecycle-errors.ts";
import { NotChanged, PlanResult } from "./plan-result.tsx";
import { beforeChangeText, beforeChangeTone, NOTE_HINT, type Reason, reasonLabel, reasonOptions } from "./words.ts";

type Colleague = ColleagueGetOutput["colleague"];
type Decision = "stop" | "keep";

const KEEP_SENTENCE = "The person who left may still hold this agent's key.";

function AgentsStep({ agents, decisions, onDecide, keepReasons, onKeepReason }: { agents: Colleague["agents"]; decisions: Record<string, Decision>; onDecide: (id: string, d: Decision) => void; keepReasons: Record<string, string>; onKeepReason: (id: string, v: string) => void }) {
  if (agents.length === 0) return <p>This person owns no agents.</p>;
  return (
    <div className="tb-stack">
      {agents.map((a) => (
        <div className="tb-stack" key={a.id}>
          <Choices<Decision>
            label={a.name}
            value={decisions[a.id] ?? "stop"}
            onChange={(v) => onDecide(a.id, v)}
            options={[
              { value: "stop", title: "Stop and remove", body: "The agent stops. Its access goes when you approve in Portal." },
              { value: "keep", title: "Keep running", body: KEEP_SENTENCE },
            ]}
          />
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
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [keepReasons, setKeepReasons] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Colleague | null>(null);
  const sent = useRef(false);
  const [capCount, setCapCount] = useState<number | null>(null);
  const person = c.kind === "person";
  const agents = person ? c.agents : [];
  const keeps = agents.filter((a) => decisions[a.id] === "keep");
  const keepsNamed = keeps.every((a) => (keepReasons[a.id] ?? "").trim());

  const send = async (): Promise<boolean | undefined> => {
    if (sent.current || !reason) return undefined;
    setBusy(true);
    setFailure(null);
    const input: LifecycleSetInput = { kind: c.kind, id: c.id, to: "leaving", reason, expectedRev: c.rev };
    if (note.trim()) input.note = note.trim();
    if (capCount !== null) input.confirmCount = capCount;
    if (agents.length) input.decisions = agents.map((a) => (decisions[a.id] === "keep" ? { agent: a.id, decision: "keep" as const, reason: (keepReasons[a.id] ?? "").trim() } : { agent: a.id, decision: "stop" as const }));
    try {
      const out = await callOp<LifecycleSetOutput>("lifecycle_set", input);
      sent.current = true;
      setResult(out.colleague);
      await onChanged();
      return undefined;
    } catch (e) {
      const cap = stopCapOf(e);
      if (cap !== null) setCapCount(cap);
      setFailure(lifecycleError(e, changeError).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const steps: FlowStep[] = [
    {
      name: "Why",
      canNext: Boolean(reason),
      render: () => (
        <div className="tb-stack">
          <p className="tb-soft">{person ? `This stops ${c.name}'s agents and access in Teal Brick. It does not end their employment or their own logins.` : `This stops ${c.name} and removes its access in Teal Brick.`}</p>
          <Field label="Reason">
            <Select placeholder="Choose a reason" options={reasonOptions("leaving")} value={reason} onValueChange={(v) => setReason(v as Reason)} />
          </Field>
          <Field label="Note" hint={NOTE_HINT}>
            <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Notice tone="neutral">This stops now. There is no last-day date.</Notice>
        </div>
      ),
    },
    ...(person
      ? [
          {
            name: "Their agents",
            canNext: keepsNamed,
            render: () => <AgentsStep agents={agents} decisions={decisions} onDecide={(id, d) => setDecisions((s) => ({ ...s, [id]: d }))} keepReasons={keepReasons} onKeepReason={(id, v) => setKeepReasons((s) => ({ ...s, [id]: v }))} />,
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
                <dd>{agents.length === 0 ? "None" : `${agents.length - keeps.length} stop, ${keeps.length} keep running`}</dd>
              </div>
            ) : null}
          </dl>
          <Notice tone={beforeChangeTone(c.floor)}>{beforeChangeText(c.floor)}</Notice>
          <NotChanged />
        </div>
      ),
    },
    {
      name: "Result",
      nextLabel: "Done",
      render: () => (result ? <PlanResult colleague={result} portalHref={portalHref} showNotChanged={false} /> : <p className="tb-soft">Nothing has changed yet.</p>),
    },
  ];

  return <StepFlow open size="lg" title={person ? `Stop ${c.name}'s agents and access` : `Stop and remove ${c.name}`} steps={steps} busy={busy} onClose={onClose} onFinish={onClose} />;
}
