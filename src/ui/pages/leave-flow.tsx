// A person leaves, or an agent is stopped and removed (DESIGN-C380 §10, C126 StepFlow, C381): one step at a time. A person's change bars that person; their agents keep working.
// The first step holds the reason and, for a person, the choice for each agent: move to a new owner by default, or an explicit stop. It says what it does not change
// before the Confirm, has no last-day field, and the last step reads back what the server knows. For one agent there is no choice to make.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Field, type FlowStep, Notice, Select, StepFlow, Textarea } from "@opt2-tealbrick/ui";
import { useRef, useState } from "react";
import type { ColleagueGetOutput, LifecycleSetInput, LifecycleSetOutput, PlanSendInput } from "#kit";
import { changeError } from "../common.tsx";
import { type Choices, canChoose, choiceOf, choiceSummary, choicesReady, decisionsOf, newKeyEffect, stoppingOf } from "./agent-choice.ts";
import { AgentChoices, defaultsOf, useOwners } from "./agent-choices.tsx";
import { capButton, useCapConfirm } from "./cap-confirm.ts";
import { FEATURES } from "./features.ts";
import { lifecycleError } from "./lifecycle-errors.ts";
import { NotChanged, PlanResult } from "./plan-result.tsx";
import { type Tick, WhatStopsStep } from "./what-stops-step.tsx";
import { beforeChangeText, beforeChangeTone, NOTE_HINT, type Reason, reasonLabel, reasonOptions } from "./words.ts";

type Colleague = ColleagueGetOutput["colleague"];

export function LeaveFlow({ c, portalHref, onClose, onChanged }: { c: Colleague; portalHref?: string; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const [reason, setReason] = useState<Reason | "">("");
  const [note, setNote] = useState("");
  const [choices, setChoices] = useState<Choices>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<Tick[] | null>(null);
  const owners = useOwners(c.id);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<Colleague | null>(null);
  const sent = useRef(false);
  // the mark is made once: a retry after a refused plan goes on from there, and the owner can go back and change a choice
  const mark = useRef<Colleague | null>(null);
  const cap = useCapConfirm();
  const person = c.kind === "person";
  const agents = person ? c.agents.filter(canChoose) : [];
  const defaults = defaultsOf(c, true);
  const canMove = owners === null || owners.length > 0;
  const key = newKeyEffect(agents, choices, defaults, canMove);
  const stopping = stoppingOf(agents, choices, defaults, canMove);

  const send = async (): Promise<boolean | undefined> => {
    if (sent.current || !reason) return undefined;
    setBusy(true);
    setFailure(null);
    const input: LifecycleSetInput = { kind: c.kind, id: c.id, to: "leaving", reason, expectedRev: c.rev };
    if (note.trim()) input.note = note.trim();
    // one press, one number: for the first call of this press only
    const confirm = cap.take();
    if (confirm !== null && !mark.current) input.confirmCount = confirm;
    try {
      const markedBefore = mark.current !== null;
      if (!mark.current) mark.current = (await callOp<LifecycleSetOutput>("lifecycle_set", input)).colleague;
      if (FEATURES.plans) {
        const plan: PlanSendInput = { kind: c.kind, id: c.id };
        const decisions = decisionsOf(agents, choices, defaults, canMove);
        if (decisions.length) plan.decisions = decisions;
        if (selected) plan.items = selected;
        if (confirm !== null && markedBefore) plan.confirmCount = confirm;
        try {
          await callOp("plan_send", plan);
        } catch (e) {
          // nothing_to_stop: no Portal step is needed. Anything else: the stop stands, and the owner can change a choice and send again.
          if ((e as { code?: unknown } | null)?.code !== "nothing_to_stop") {
            cap.note(e);
            setFailure(`The stop is recorded, but the request for Portal is not ready. ${lifecycleError(e, changeError).message}`);
            // the page behind must show the stop, also if the owner closes this now
            await onChanged();
            return false;
          }
        }
      }
      sent.current = true;
      setResult(mark.current);
      await onChanged();
      return undefined;
    } catch (e) {
      cap.note(e);
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
    render: () => (result ? <PlanResult colleague={result} portalHref={portalHref} showNotChanged={false} /> : <p className="tb-soft">Nothing has changed yet.</p>),
  };
  // once sent, only the result is left: going back could not change what was sent
  const steps: FlowStep[] = result ? [resultStep] : [
    {
      name: "Why",
      canNext: Boolean(reason) && choicesReady(agents, choices, defaults, canMove),
      render: () => (
        <div className="tb-stack">
          <p className="tb-soft">{person ? `This marks ${c.name} as leaving. Rules refuses calls by, for and to them, if its hook is on. Messages from their handles are barred in Connect. What they hold in your apps ends. ${agents.length > 0 ? "Their agents keep working: choose a new owner for each. " : ""}It does not end their employment or their own logins.` : `This marks ${c.name} to stop, and lists what to do in Portal to stop it and remove its access in Teal Brick.`}</p>
          <Field label="Reason">
            <Select placeholder="Choose a reason" disabled={Boolean(mark.current)} options={reasonOptions("leaving")} value={reason} onValueChange={(v) => { setReason(v as Reason); cap.clear(); }} />
          </Field>
          <Field label="Note" hint={NOTE_HINT}>
            <Textarea rows={2} maxLength={500} disabled={Boolean(mark.current)} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Notice tone="neutral">The mark takes effect now. There is no last-day date.</Notice>
          {person && agents.length === 0 ? <p>This person owns no agents.</p> : null}
          {agents.length && FEATURES.plans ? <AgentChoices agents={agents} choices={choices} onChange={(next) => { setChoices(next); cap.clear(); }} owners={owners} defaults={defaults} /> : null}
        </div>
      ),
    },
    ...(FEATURES.preview
      ? [
          {
            name: person ? "What ends" : "What stops",
            render: () => <WhatStopsStep kind={c.kind} id={c.id} name={c.name} stopping={stopping} onChange={setSelected} />,
          },
        ]
      : []),
    {
      name: "Confirm",
      nextLabel: cap.count !== null ? capButton(cap.count) : mark.current ? "Send again" : person ? "Mark as leaving" : "Stop",
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
                <dd>{agents.length === 0 ? "None" : FEATURES.plans ? choiceSummary(agents, choices, defaults, canMove) : `${agents.length}`}</dd>
              </div>
            ) : null}
          </dl>
          {agents.length > 0 && FEATURES.plans ? (
            <ul className="ready" aria-label="What happens to each agent">
              {agents.map((a) => {
                const ch = choiceOf(choices, a.id, defaults, canMove);
                return (
                  <li key={a.id}>
                    <span>{a.name}</span>
                    <span className="tb-hint">{ch.choice === "stop" ? "Stops when you approve in Portal" : ch.choice === "later" ? "Keeps running, needs an owner" : `Moves to ${owners?.find((o) => o.value === ch.newOwner)?.label ?? "the new owner"}${ch.newKey ? ", with a new key" : ""}`}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {key ? <Notice tone="needs-you">{key}</Notice> : null}
          <Notice tone={beforeChangeTone(c.floor)}>{beforeChangeText(c.floor, c.kind)}</Notice>
          <NotChanged />
        </div>
      ),
    },
    resultStep,
  ];

  return <StepFlow open size="lg" step={Math.min(step, steps.length - 1)} onStepChange={setStep} title={person ? `${c.name} leaves` : `Stop and remove ${c.name}`} steps={steps} busy={busy} onClose={onClose} onFinish={onClose} />;
}
