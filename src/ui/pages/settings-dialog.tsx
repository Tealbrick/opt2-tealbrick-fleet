// Workspace settings of the lifecycle (DESIGN-C380 §2): the default owner and the cooling period before a Close. The default owner
// takes every agent with no owner: the dialog says so, and says how many it took.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Field, Notice, Select, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import type { ColleaguesListOutput, SettingsSetInput, SettingsSetOutput, SummaryGetOutput } from "#kit";
import { changeError, LoadFailed, useLoad } from "../common.tsx";
import { lifecycleError } from "./lifecycle-errors.ts";

const NONE = "";

export function SettingsDialog({ settings, onClose, onChanged }: { settings: SummaryGetOutput["settings"]; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const people = useLoad(useCallback(() => callOp<ColleaguesListOutput>("colleagues_list", { kind: "person", lifecycle: "active", limit: 200 }), []));
  const [owner, setOwner] = useState(settings.defaultOwner?.id ?? NONE);
  const [days, setDays] = useState(String(settings.coolingDays));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<number | null>(null);
  const dayCount = Number(days);
  const validDays = Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 365;
  const options = [{ value: NONE, label: "No default owner" }, ...(people.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))];
  // the current owner stays selectable when the list cannot be read or no longer has them
  if (settings.defaultOwner && !options.some((o) => o.value === settings.defaultOwner?.id)) options.push({ value: settings.defaultOwner.id, label: settings.defaultOwner.name });
  const save = async () => {
    setBusy(true);
    setFailure(null);
    const input: SettingsSetInput = { coolingDays: dayCount, defaultOwner: owner === NONE ? null : owner };
    try {
      const out = await callOp<SettingsSetOutput>("settings_set", input);
      await onChanged();
      if (out.assigned > 0) setAssigned(out.assigned);
      else onClose();
    } catch (e) {
      setFailure(lifecycleError(e, changeError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Settings"
      onClose={onClose}
      busy={busy}
      footer={
        assigned !== null ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy || !validDays}>
              Save
            </Button>
          </>
        )
      }
    >
      {assigned !== null ? (
        <Notice tone="live" role="status">
          {assigned === 1 ? "1 agent with no owner now has the default owner." : `${assigned} agents with no owner now have the default owner.`} Each change is in the history.
        </Notice>
      ) : (
        <div className="tb-stack">
          {failure ? (
            <Notice tone="needs-you" role="alert">
              {failure}
            </Notice>
          ) : null}
          {people.error ? <LoadFailed message={people.error} retrying={people.loading} onRetry={() => void people.reload()} /> : null}
          <Field label="Default owner" hint="This person takes every agent with no owner now, and each new agent. You can change the owner of one agent later.">
            <Select options={options} value={owner} onValueChange={setOwner} />
          </Field>
          <Field label="Cooling period, in days" hint="From 1 to 365. You can close an entry after this time, or earlier with a named reason." error={validDays ? undefined : "Enter a whole number from 1 to 365."}>
            <TextInput type="number" inputMode="numeric" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
