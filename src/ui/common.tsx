// Pieces the pages share: plain error sentences, the load state that keeps its error (RUL-14), the page head and the
// edit dialog. Kit components only.
import { Button, Dialog, Notice } from "@opt2-tealbrick/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./standard.tsx";

/** Codes whose message this app wrote as a plain sentence (src/store.ts); everything else gets the shared wording. */
export const OWN_CODES = new Set(["input_invalid", "handle_invalid", "handle_taken", "team_name_taken", "limit_reached", "owner_not_person", "lifecycle_open", "use_bring_back", "date_in_past", "not_new", "role_name_taken", "role_archived", "role_full", "too_many_roles", "already_assigned", "already_ended", "subject_leaving", "no_roles_for_outside_agent", "agent_removed", "cannot_hold_both", "rule_exists", "same_role", "too_many_rules", "stop_cap_reached", "owner_stopped", "use_transfer"]);
export const GONE_CODES = new Set(["team_not_found", "person_not_found", "agent_not_found", "review_not_found", "subject_not_found", "role_not_found", "assignment_not_found", "rule_not_found"]);
/** Codes of the review ops with their own plain sentence. */
export const REVIEW_MESSAGES: Record<string, string> = {
  snapshot_stale: "The subject changed after you looked. Close this and open the review again.",
  review_not_open: "This request is already closed. Reload the page.",
  request_not_found: "That request is already closed. Close this and open the review again.",
};
/** Plain sentence for a failed change: the cause and what to do (L18). */
export function changeError(e: unknown): string {
  const err = (e ?? {}) as { code?: unknown; message?: unknown };
  if (typeof err.code === "string" && OWN_CODES.has(err.code) && typeof err.message === "string" && err.message) {
    const m = err.message.trim();
    return `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? "" : "."}`;
  }
  if (typeof err.code === "string" && REVIEW_MESSAGES[err.code]) return REVIEW_MESSAGES[err.code] as string;
  if (typeof err.code === "string" && GONE_CODES.has(err.code)) return "This entry is gone. Reload the page and try again.";
  return errorMessage(e);
}

/** Load state with the error kept (RUL-14). */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const v = await load();
      if (mine !== seq.current) return;
      setData(v);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(errorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

/** A failed load: what happened, and Try again. */
export function LoadFailed({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return (
    <Notice tone="needs-you" role="alert">
      <span className="tb-row">
        <span>{message}</span>
        <Button size="sm" onClick={onRetry} disabled={retrying}>
          Try again
        </Button>
      </span>
    </Notice>
  );
}

export const Loading = ({ what }: { what: string }) => (
  <p className="tb-soft" role="status">
    Loading {what}.
  </p>
);

export function PageHead({ title, lede, action }: { title: string; lede?: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="tb-stack head-text">
        <h1>{title}</h1>
        {lede ? <p className="tb-lede">{lede}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** A dialog with a Save button that runs `save`; an error stays in the dialog. */
export function EditDialog({ title, onClose, save, children }: { title: string; onClose: () => void; save: () => Promise<void>; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await save();
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
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="tb-stack">
        {error ? (
          <Notice tone="needs-you" role="alert">
            {error}
          </Notice>
        ) : null}
        {children}
      </div>
    </Dialog>
  );
}

