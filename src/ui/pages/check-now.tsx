// "Check now" (QA D10): reads each app now, on the owner's press. It changes nothing in any app. The read is a job, so the page reads its own data again a
// few seconds later and says so; it does not claim the read finished.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Notice } from "@opt2-tealbrick/ui";
import { useEffect, useRef, useState } from "react";
import { PERSON_OPS } from "#kit";
import { changeError } from "../common.tsx";

const AGAIN_MS = [3000, 8000];

export function CheckNow({ onRead }: { onRead: () => void | Promise<void> }) {
  const [hasOp] = useState(() => (PERSON_OPS as readonly string[]).includes("reconcile_now"));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const t of timers.current) clearTimeout(t);
    };
  }, []);
  const check = async () => {
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      await callOp("reconcile_now", {});
      setNote("Governance is reading each app. The times here change when it has the answers.");
      if (!alive.current) return;
      for (const t of timers.current) clearTimeout(t);
      timers.current = AGAIN_MS.map((ms) => setTimeout(() => void onRead(), ms));
    } catch (e) {
      setFailure(changeError(e));
    } finally {
      setBusy(false);
    }
  };
  if (!hasOp) return null;
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
