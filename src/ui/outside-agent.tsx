// The owner form "Add outside agent" (C373 WP-D, Q13), a dialog on the People page. Kept out of App.tsx so a test can mount it.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Field, Notice, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useState } from "react";
import type { PersonSetInput, ReviewGetOutput } from "#kit";
import { changeError } from "./common.tsx";

const lines = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * "Add outside agent" (Q13): an agent that is not in your workspace but that your agents deal with (a partner's agent, a
 * supplier's bot). It is added as UNREVIEWED. The second step offers "Trust" in one click; that records a real review
 * verdict (review_get for the copy of what it is now, then review_record), so trust is always an explicit act with a
 * history entry, never a side effect of adding.
 */
export function OutsideAgentDialog({ onClose, reload }: { onClose: () => void; reload: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [relationship, setRelationship] = useState("");
  const [handles, setHandles] = useState("");
  const [added, setAdded] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const input: PersonSetInput = { name, kind: "outside_agent", org, relationship, handles: lines(handles) };
      const out = await callOp<{ person: { id: string; name: string } }>("person_set", input);
      setAdded({ id: out.person.id, name: out.person.name });
      await reload();
    } catch (e) {
      setError(changeError(e));
    } finally {
      setBusy(false);
    }
  };
  const trust = async () => {
    if (!added) return;
    setBusy(true);
    setError(null);
    try {
      const subject = { kind: "outside_agent" as const, id: added.id };
      const look = await callOp<ReviewGetOutput>("review_get", { subject });
      if (!look.current) throw Object.assign(new Error("gone"), { code: "person_not_found" });
      await callOp("review_record", { subject, verdict: "trusted", reason: "Trusted by the owner right after adding it.", snapshotDigest: look.current.digest });
      await reload();
      onClose();
    } catch (e) {
      setError(changeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={added ? `${added.name} is added` : "Add outside agent"}
      onClose={onClose}
      busy={busy}
      footer={
        added ? (
          <>
            <Button onClick={onClose} disabled={busy}>
              Leave unreviewed
            </Button>
            <Button variant="primary" onClick={() => void trust()} disabled={busy}>
              {`Trust ${added.name}`}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void add()} disabled={busy || !name.trim()}>
              Add outside agent
            </Button>
          </>
        )
      }
    >
      <div className="tb-stack">
        {error ? (
          <Notice tone="needs-you" role="alert">
            {error}
          </Notice>
        ) : null}
        {added ? (
          <>
            <p>{`${added.name} is in the directory. Its trust is unreviewed: your agents treat it as unknown, and Rules can hold what it asks.`}</p>
            <p className="tb-soft">Trust records a review in the Reviews history. You can also review it later with more care, or block it.</p>
          </>
        ) : (
          <>
            <p className="tb-soft">An outside agent is not in your workspace but your agents deal with it, for example a partner’s agent. It starts unreviewed. Nothing is trusted until you say so.</p>
            <Field label="Name">
              <TextInput value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Organisation" hint="Optional, for example Acme Ltd.">
              <TextInput value={org} maxLength={120} onChange={(e) => setOrg(e.target.value)} />
            </Field>
            <Field label="Relationship" hint="Optional, for example Supplier or Partner.">
              <TextInput value={relationship} maxLength={120} onChange={(e) => setRelationship(e.target.value)} />
            </Field>
            <Field label="Channel handles" hint="One per line: buzz:npub1…, slack:U01234ABC, telegram:123456789.">
              <Textarea rows={3} value={handles} onChange={(e) => setHandles(e.target.value)} />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}
