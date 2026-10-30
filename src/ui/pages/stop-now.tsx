// Stop now (DESIGN-C380 §5, §10; business F11): one dialog for one agent, a reason from a list, Stop. The result says what the
// server knows: what Rules has confirmed, and what is still to do in Portal. It never says that calls stopped.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Field, Notice, Select, Textarea } from "@opt2-tealbrick/ui";
import { useState } from "react";
import type { ColleagueGetOutput, LifecycleSetInput, LifecycleSetOutput } from "#kit";
import { changeError } from "../common.tsx";
import { FEATURES } from "./features.ts";
import { type LifecycleErrorInfo, lifecycleError, stopCapOf } from "./lifecycle-errors.ts";
import { sendPlan } from "./plan-live.tsx";
import { NotChanged, PlanResult } from "./plan-result.tsx";
import { NOTE_HINT, type Reason, reasonOptions } from "./words.ts";

export function StopNow({ subject, portalHref, onClose, onChanged }: { subject: { kind: "agent" | "person"; id: string; name: string }; portalHref?: string; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const [reason, setReason] = useState<Reason | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<LifecycleErrorInfo | null>(null);
  const [capUsed, setCapUsed] = useState<number | null>(null);
  const [result, setResult] = useState<LifecycleSetOutput["colleague"] | null>(null);
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  const stop = async () => {
    if (!reason) return;
    setBusy(true);
    setFailure(null);
    const input: LifecycleSetInput = { kind: subject.kind, id: subject.id, to: "suspended", reason };
    if (note.trim()) input.note = note.trim();
    if (capUsed !== null) input.confirmCount = capUsed;
    try {
      const out = await callOp<LifecycleSetOutput>("lifecycle_set", input);
      if (FEATURES.plans) setSendFailure(await sendPlan({ kind: subject.kind, id: subject.id }));
      setResult(out.colleague);
      await onChanged();
    } catch (e) {
      // an earlier try went through and its answer was lost: show what the server has, not an error
      if ((e as { code?: unknown } | null)?.code === "already_in_state") {
        try {
          const now = await callOp<ColleagueGetOutput>("colleague_get", { kind: subject.kind, id: subject.id });
          setResult(now.colleague);
          await onChanged();
          return;
        } catch {
          // fall through to the plain message
        }
      }
      const cap = stopCapOf(e);
      if (cap !== null) setCapUsed(cap);
      setFailure(lifecycleError(e, changeError));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={result ? `${subject.name}: what happens now` : `Stop ${subject.name}`}
      onClose={onClose}
      busy={busy}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void stop()} disabled={busy || !reason}>
              {capUsed !== null ? "Stop this one too" : "Stop"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <PlanResult colleague={result} portalHref={portalHref} sendFailure={sendFailure} />
      ) : (
        <div className="tb-stack">
          {failure ? (
            <Notice tone="needs-you" role="alert">
              {failure.message}
            </Notice>
          ) : null}
          <p className="tb-soft">{subject.kind === "agent" ? "Governance records this now. The agent is paused only when you approve in Portal. Scheduled posts due while it is paused are cancelled, not moved." : "Governance records this now, for this person and their agents. Their agents are paused only when you approve in Portal. Scheduled posts due while an agent is paused are cancelled, not moved."}</p>
          <Field label="Reason">
            <Select placeholder="Choose a reason" options={reasonOptions("suspended")} value={reason} onValueChange={(v) => setReason(v as Reason)} />
          </Field>
          <Field label="Note" hint={NOTE_HINT}>
            <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <NotChanged />
        </div>
      )}
    </Dialog>
  );
}
