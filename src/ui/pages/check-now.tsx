// "Check now" (QA D10): reads each app now, on the owner's press. It changes nothing in any app. The read is a job, so the page reads its own data again a
// few seconds later and says so; it does not claim the read finished.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Notice } from "@opt2-tealbrick/ui";
import { useEffect, useRef, useState } from "react";
import { changeError } from "../common.tsx";

const AGAIN_MS = [3000, 8000];

export function CheckNow({ onRead }: { onRead: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
    },
    [],
  );
  const check = async () => {
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      await callOp("reconcile_now", {});
      setNote("Governance is reading each app. The times here change when it has the answers.");
      for (const ms of AGAIN_MS) timers.current.push(setTimeout(() => void onRead(), ms));
    } catch (e) {
      setFailure(changeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tb-stack">
      <span>
        <Button onClick={() => void check()} disabled={busy}>
          {busy ? "Checking" : "Check now"}
        </Button>
      </span>
      {note ? <p className="tb-hint" role="status">{note}</p> : null}
      {failure ? (
        <Notice tone="needs-you" role="alert">
          {failure}
        </Notice>
      ) : null}
    </div>
  );
}
