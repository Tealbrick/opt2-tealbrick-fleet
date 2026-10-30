// The short changes (DESIGN-C380 §10): Mark as reviewed, Resume, undo Leaving, Bring back, and Close. Each takes a reason from a
// list; the server's guards answer in words. Close never runs by itself: it shows the cooling period and what was not read,
// and a waive needs a named reason.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Field, Notice, Select, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useState } from "react";
import type { ColleagueGetOutput, LifecycleSetInput, LifecycleSetOutput } from "#kit";
import { changeError } from "../common.tsx";
import { lifecycleError } from "./lifecycle-errors.ts";
import { NOTE_HINT, type Reason, reasonOptions, when } from "./words.ts";

type Colleague = ColleagueGetOutput["colleague"];
type Action = Colleague["actions"][number];

/** Words for what a change does. Only what the state table in DESIGN-C380 §2 proves. */
function explain(c: Colleague, action: Action): string {
  if (action.to === "proposed") return "This restores nothing. Teams and access do not come back: grant them again in Portal.";
  if (c.lifecycle === "proposed") return "This records that you reviewed it. It grants nothing.";
  if (c.lifecycle === "suspended") return c.kind === "agent" ? "Governance marks it as active. If it is paused, resume it in Portal." : "Governance marks this person as active. Resume any paused agents in Portal.";
  if (c.lifecycle === "leaving") return "This cancels the stop. Do it only if nothing was approved in Portal.";
  return "Governance records this change.";
}

function useChange(c: Colleague, onDone: () => void, onChanged: () => void | Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (extra: Pick<LifecycleSetInput, "to" | "reason" | "note" | "waive">) => {
    setBusy(true);
    setFailure(null);
    try {
      const input: LifecycleSetInput = { kind: c.kind, id: c.id, expectedRev: c.rev, ...extra };
      await callOp<LifecycleSetOutput>("lifecycle_set", input);
      await onChanged();
      onDone();
    } catch (e) {
      setFailure(lifecycleError(e, changeError).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, failure, run };
}

function Failure({ message }: { message: string | null }) {
  return message ? (
    <Notice tone="needs-you" role="alert">
      {message}
    </Notice>
  ) : null;
}

export function ChangeDialog({ c, action, onClose, onChanged }: { c: Colleague; action: Action; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const review = c.lifecycle === "proposed" && action.to === "active";
  const [reason, setReason] = useState<Reason | "">(review ? "reviewed" : "");
  const [note, setNote] = useState("");
  const { busy, failure, run } = useChange(c, onClose, onChanged);
  return (
    <Dialog
      open
      title={`${action.label}: ${c.name}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !reason} onClick={() => void run({ to: action.to, reason: reason as Reason, ...(note.trim() ? { note: note.trim() } : {}) })}>
            {action.label}
          </Button>
        </>
      }
    >
      <div className="tb-stack">
        <Failure message={failure} />
        <p className="tb-soft">{explain(c, action)}</p>
        {review ? null : (
          <Field label="Reason">
            <Select placeholder="Choose a reason" options={reasonOptions(action.to)} value={reason} onValueChange={(v) => setReason(v as Reason)} />
          </Field>
        )}
        <Field label="Note" hint={NOTE_HINT}>
          <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

export function CloseDialog({ c, action, onClose, onChanged }: { c: Colleague; action: Action; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const [reason, setReason] = useState<Reason | "">((c.reason as Reason | null) ?? "");
  const [waive, setWaive] = useState("");
  const { busy, failure, run } = useChange(c, onClose, onChanged);
  const needsWaive = action.needsWaive;
  const ready = Boolean(reason) && (!needsWaive || waive.trim().length > 0);
  return (
    <Dialog
      open
      title={`Close ${c.name}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || !ready} onClick={() => void run({ to: "archived", reason: reason as Reason, ...(needsWaive ? { waive: waive.trim() } : {}) })}>
            Close this entry
          </Button>
        </>
      }
    >
      <div className="tb-stack">
        <Failure message={failure} />
        <p className="tb-soft">Close ends team memberships and keeps the record. No documents, issues or messages are deleted. Nothing closes by itself.</p>
        {c.close ? (
          <Notice tone={c.close.coolingOver ? "neutral" : "needs-you"} role="status">
            {c.close.coolingOver ? `The ${c.close.coolingDays}-day waiting period is over.` : `The ${c.close.coolingDays}-day waiting period ends ${when(c.close.coolingEndsAt) || "later"}.`}
          </Notice>
        ) : null}
        {c.close?.limits.length ? (
          <section className="not-changed" aria-label="What this does not show">
            <h3>What Governance could not check</h3>
            <ul>
              {c.close.limits.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </section>
        ) : null}
        <Field label="Reason">
          <Select placeholder="Choose a reason" options={reasonOptions("archived")} value={reason} onValueChange={(v) => setReason(v as Reason)} />
        </Field>
        {needsWaive ? (
          <Field label="Why close before the waiting period ends?" hint="Required. This is kept in the history.">
            <TextInput value={waive} maxLength={200} onChange={(e) => setWaive(e.target.value)} />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}
