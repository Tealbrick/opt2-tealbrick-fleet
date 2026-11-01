// The choice for each of a person's agents, on the first step of Leave and later on the person's page (C381). Move to a new owner is the default and the agent runs on throughout.
// Stop this agent stays an explicit choice. A new key is offered in the move step, and its effect is stated before any approval.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Field, Choices as KitChoices, Notice, Select, Switch } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import type { ColleagueGetOutput, ColleaguesListOutput, PlanSendInput } from "#kit";
import { changeError, useLoad } from "../common.tsx";
import { type Choice, type ChoiceDefaults, type Choices, canChoose, choiceOf, choicesReady, decisionsOf, newKeyEffect } from "./agent-choice.ts";
import { capButton, useCapConfirm } from "./cap-confirm.ts";
import { lifecycleError } from "./lifecycle-errors.ts";
import { apartLabels } from "./many.ts";

type Colleague = ColleagueGetOutput["colleague"];
type Agent = Colleague["agents"][number];
export type Owner = { value: string; label: string };

const MOVE_SENTENCE = "It keeps running. It has its new owner at once. It loses this person's personal memory.";
const MOVE_STOPPED = "It stays stopped, as you chose. It has its new owner at once.";
const STOP_SENTENCE = "It stops when you approve in Portal. Its access and key go. To undo this you must pair it again and grant its access again.";
const LATER_SENTENCE = "It keeps running with this owner. Governance shows that it needs an owner, and this person may still hold its key.";
const KEY_ON = "When you approve in Portal, the old key stops and this agent must be connected again. It cannot work until then. After that it gains the new owner's personal memory.";
const KEY_OFF = "The old key keeps working, and this person may hold it. So this agent does not get the new owner's personal memory. Governance shows this until a new key exists.";
const NO_ONE = "No other active person is in the directory. Add one, then name them here. These agents keep working until then.";

/** The active people who can take an agent, without this person. */
export function useOwners(personId: string): Owner[] | null {
  const people = useLoad(useCallback(() => callOp<ColleaguesListOutput>("colleagues_list", { kind: "person", lifecycle: "active", limit: 200 }), []));
  return people.data ? apartLabels(people.data.items.filter((p) => p.id !== personId).map((p) => ({ value: p.id, label: p.name }))) : null;
}

/** The start of each choice: the workspace default owner when one is set and active, and a new key for a person who leaves. */
export const defaultsOf = (c: Colleague, leaving: boolean): ChoiceDefaults => ({ owner: c.defaultOwner?.id ?? "", newKey: leaving });

export function AgentChoices({ agents, choices, onChange, owners, defaults }: { agents: readonly Agent[]; choices: Choices; onChange: (next: Choices) => void; owners: Owner[] | null; defaults: ChoiceDefaults }) {
  const canMove = owners === null || owners.length > 0;
  const set = (id: string, patch: Partial<Choices[string]>) => onChange({ ...choices, [id]: { ...choiceOf(choices, id, defaults, canMove), ...patch } });
  return (
    <div className="tb-stack">
      {canMove ? null : <Notice tone="needs-you">{NO_ONE}</Notice>}
      {agents.map((a) => {
        const c = choiceOf(choices, a.id, defaults, canMove);
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
                ...(canMove ? [{ value: "move" as const, title: "Move to a new owner", body: a.lifecycle === "suspended" ? MOVE_STOPPED : MOVE_SENTENCE }] : []),
                { value: "later", title: "Name a new owner later", body: LATER_SENTENCE },
                { value: "stop", title: "Stop this agent", body: STOP_SENTENCE },
              ]}
            />
            {c.choice === "move" ? (
              <>
                <Field label={`New owner of ${a.name}`}>
                  <Select placeholder="Choose a person" options={owners ?? []} value={c.newOwner} onValueChange={(v) => set(a.id, { newOwner: v })} />
                </Field>
                <Switch label={`Make a new key for ${a.name}`} checked={c.newKey} onCheckedChange={(on) => set(a.id, { newKey: on })} />
                <p className="tb-hint">{c.newKey ? KEY_ON : KEY_OFF}</p>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The person is marked, and their agents still have them as owner. Sends what was chosen. */
export function ChooseDialog({ c, onClose, onChanged }: { c: Colleague; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const agents = c.agents.filter(canChoose);
  const owners = useOwners(c.id);
  const canMove = owners === null || owners.length > 0;
  const defaults = defaultsOf(c, c.lifecycle === "leaving");
  const [choices, setChoices] = useState<Choices>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const cap = useCapConfirm();
  const decisions = decisionsOf(agents, choices, defaults, canMove);
  const key = newKeyEffect(agents, choices, defaults, canMove);
  const save = async () => {
    setBusy(true);
    setFailure(null);
    const input: PlanSendInput = { kind: "person", id: c.id, decisions };
    const confirm = cap.take();
    if (confirm !== null) input.confirmCount = confirm;
    try {
      await callOp("plan_send", input);
      await onChanged();
      onClose();
    } catch (e) {
      cap.note(e);
      setFailure(lifecycleError(e, changeError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      size="lg"
      title={`New owners for ${c.name}'s agents`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || decisions.length === 0 || !choicesReady(agents, choices, defaults, canMove)}>
            {cap.count !== null ? capButton(cap.count) : "Save"}
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
        <p className="tb-soft">An agent you did not stop keeps working. A new owner applies at once. A new key and a stop wait for your approval in Portal. This takes back an older request for this person, and asks again for any new key in it.</p>
        <AgentChoices agents={agents} choices={choices} onChange={(next) => { setChoices(next); cap.clear(); }} owners={owners} defaults={defaults} />
        {key ? <Notice tone="needs-you">{key}</Notice> : null}
      </div>
    </Dialog>
  );
}
