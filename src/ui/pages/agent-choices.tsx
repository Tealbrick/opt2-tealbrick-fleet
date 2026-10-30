// The choice for each of a person's agents, on the first step of a stop and later on the person's page (C380 D2). "Decide later" is the
// default and only pauses the agent; the sentence that says so is the server's own.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Field, Choices as KitChoices, Notice, Select, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import type { ColleagueGetOutput, ColleaguesListOutput, PlanSendInput } from "#kit";
import { changeError, useLoad } from "../common.tsx";
import { type Choice, type Choices, canChoose, choiceOf, choicesReady, decisionsOf, hasOwnStop } from "./agent-choice.ts";
import { lifecycleError, stopCapOf } from "./lifecycle-errors.ts";
import { KEY_SENTENCE } from "./words.ts";

type Colleague = ColleagueGetOutput["colleague"];
type Agent = Colleague["agents"][number];
export type Owner = { value: string; label: string };

const STOP_SENTENCE = "Its access and key go when you approve in Portal. To undo this you must pair it again and grant its access again.";
const KEEP_SENTENCE = "The person who left may still hold this agent's key.";
const TRANSFER_SENTENCE = "A new key is needed. The agent loses this person's personal memory and gains the new owner's.";

/** The active people who can take an agent, without this person. */
export function useOwners(personId: string): Owner[] | null {
  const people = useLoad(useCallback(() => callOp<ColleaguesListOutput>("colleagues_list", { kind: "person", lifecycle: "active", limit: 200 }), []));
  return people.data ? people.data.items.filter((p) => p.id !== personId).map((p) => ({ value: p.id, label: p.name })) : null;
}

export function AgentChoices({ agents, choices, onChange, owners }: { agents: readonly Agent[]; choices: Choices; onChange: (next: Choices) => void; owners: Owner[] | null }) {
  const set = (id: string, patch: Partial<(typeof choices)[string]>) => onChange({ ...choices, [id]: { ...choiceOf(choices, id), ...patch } });
  return (
    <div className="tb-stack">
      {agents.map((a) => {
        const c = choiceOf(choices, a.id);
        const own = hasOwnStop(a);
        return (
          <div className="tb-stack" key={a.id}>
            <h3 className="flow-agent">
              {a.name}
              <span className="tb-hint">{a.line}</span>
            </h3>
            <KitChoices<Choice>
              label={a.name}
              value={c.choice}
              onChange={(v) => set(a.id, { choice: v })}
              options={[
                { value: "later", title: "Decide later", body: KEY_SENTENCE },
                { value: "stop", title: "Stop and remove", body: STOP_SENTENCE },
                ...(own || !owners ? [] : [{ value: "transfer" as const, title: "Pause and move to a new owner", body: TRANSFER_SENTENCE }]),
                ...(own ? [] : [{ value: "keep" as const, title: "Keep running", body: KEEP_SENTENCE }]),
              ]}
            />
            {c.choice === "transfer" ? (
              <Field label={`New owner of ${a.name}`}>
                <Select placeholder="Choose a person" options={owners ?? []} value={c.newOwner} onValueChange={(v) => set(a.id, { newOwner: v })} />
              </Field>
            ) : null}
            {c.choice === "keep" ? (
              <Field label={`Why does ${a.name} keep running?`} hint="Required. This is kept in the history.">
                <TextInput value={c.reason} maxLength={200} onChange={(e) => set(a.id, { reason: e.target.value })} />
              </Field>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The second stage: the person is stopped and their agents wait for a choice. Sends only what was chosen. */
export function ChooseDialog({ c, onClose, onChanged }: { c: Colleague; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const agents = c.agents.filter(canChoose);
  const owners = useOwners(c.id);
  const [choices, setChoices] = useState<Choices>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [capCount, setCapCount] = useState<number | null>(null);
  const decisions = decisionsOf(agents, choices);
  const save = async () => {
    setBusy(true);
    setFailure(null);
    const input: PlanSendInput = { kind: "person", id: c.id, decisions };
    if (capCount !== null) input.confirmCount = capCount;
    try {
      await callOp("plan_send", input);
      await onChanged();
      onClose();
    } catch (e) {
      const cap = stopCapOf(e);
      if (cap !== null) setCapCount(cap);
      setFailure(lifecycleError(e, changeError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      size="lg"
      title={`Choose for ${c.name}'s agents`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || decisions.length === 0 || !choicesReady(agents, choices)}>
            {capCount !== null ? "Send this too" : "Send to Portal"}
          </Button>
        </>
      }
    >
      <div className="tb-stack">
        {failure ? (
          <Notice tone="needs-you" role="alert">
            {failure}
          </Notice>
        ) : null}
        <p className="tb-soft">This prepares a request in Portal. It replaces an older request for this person. Nothing changes until you approve it there.</p>
        <AgentChoices agents={agents} choices={choices} onChange={setChoices} owners={owners} />
      </div>
    </Dialog>
  );
}
