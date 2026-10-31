// Access > Differences (DESIGN-C380 §4, §10): what no longer matches, "Name an owner" first, grouped by kind. Never changes anything by
// itself. The owner opens the entry to act, or accepts a difference with a reason until a date. "Not checked yet" and "could not be
// read" are not "no differences".
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, EmptyState, Field, Notice, Tag, Textarea, TextInput, TextLink } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import { changeError, LoadFailed, Loading, useLoad } from "../common.tsx";
import type { FindingRow, FindingsListOutput } from "./inventory-types.ts";
import { openSubject, subjectHref } from "./subject-link.ts";
import { age, NOTE_HINT, when } from "./words.ts";

const load = () => callOp<FindingsListOutput>("findings_list", {});

/** Codes in the order an owner should act on them; the rest follow in the server's order. */
const FIRST = ["no_owner", "owner_inactive", "not_stopped", "access_after_leave", "unlinked_account"];
const rank = (code: string) => {
  const i = FIRST.indexOf(code);
  return i < 0 ? FIRST.length : i;
};

/** One group per sentence: the same code can have two wordings, and a heading must be true for each row under it. */
export function groupFindings(items: FindingRow[]): { key: string; text: string; rows: FindingRow[] }[] {
  const groups = new Map<string, FindingRow[]>();
  for (const f of items) groups.set(`${f.code}:${f.text}`, [...(groups.get(`${f.code}:${f.text}`) ?? []), f]);
  return [...groups].map(([key, rows]) => ({ key, text: rows[0]?.text ?? "", rows })).sort((a, b) => rank(a.rows[0]?.code ?? "") - rank(b.rows[0]?.code ?? ""));
}

function AcceptDialog({ row, onClose, onChanged }: { row: FindingRow; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const untilMs = Date.parse(until);
  const ready = reason.trim().length > 0 && Number.isFinite(untilMs) && untilMs > Date.now();
  const save = async () => {
    if (!row.subject) return;
    setBusy(true);
    setFailure(null);
    try {
      await callOp("exception_set", { code: row.code, kind: row.subject.kind, id: row.subject.id, reason: reason.trim(), until: new Date(untilMs).toISOString() });
      await onChanged();
      onClose();
    } catch (e) {
      setFailure(changeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Accept this difference"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !ready} onClick={() => void save()}>
            Accept
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
        <p className="tb-soft">{row.text} Accepting changes no access. The difference comes back on this date.</p>
        <Field label="Why is this acceptable?" hint={NOTE_HINT}>
          <Textarea rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Until">
          <TextInput type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function Row({ row, onAccept }: { row: FindingRow; onAccept: (r: FindingRow) => void }) {
  const s = row.subject;
  return (
    <li>
      <span>
        {s ? (
          <TextLink
            href={subjectHref(s.kind, s.id)}
            onClick={(e) => {
              e.preventDefault();
              openSubject(s.kind, s.id);
            }}
          >
            {s.name}
          </TextLink>
        ) : null}
        {row.productName ? <span className="tb-hint">{` in ${row.productName}`}</span> : null}
        {row.exception ? <span className="tb-hint row-tag">{`Accepted until ${when(row.exception.until)}: ${row.exception.reason}`}</span> : null}
      </span>
      {row.exception ? <Tag>Accepted</Tag> : s ? <Button size="sm" onClick={() => onAccept(row)}>Accept with a reason</Button> : null}
    </li>
  );
}

export function Differences() {
  const { data, error, loading, reload } = useLoad(load);
  const [accept, setAccept] = useState<FindingRow | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailure, setCheckFailure] = useState<string | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    setCheckFailure(null);
    try {
      await callOp("reconcile_now", {});
      await reload();
    } catch (e) {
      setCheckFailure(changeError(e));
    } finally {
      setChecking(false);
    }
  }, [reload]);
  const unread = data?.unread ?? [];
  const groups = data ? groupFindings(data.items) : [];
  return (
    <div className="tb-stack">
      <div className="tb-row">
        <Button onClick={() => void check()} disabled={checking}>
          {checking ? "Checking" : "Check now"}
        </Button>
        {data?.lastSweepAt ? <span className="tb-hint">{`Last check ${when(data.lastSweepAt)} (${age(data.lastSweepAt)}). ${data.storesRead} apps read.`}</span> : null}
      </div>
      {checkFailure ? (
        <Notice tone="needs-you" role="alert">
          {checkFailure}
        </Notice>
      ) : null}
      {error ? <LoadFailed message={data ? `This list may be old. ${error}` : error} retrying={loading} onRetry={() => void reload()} /> : null}
      {data === null ? (
        error ? null : (
          <Loading what="the differences" />
        )
      ) : data.lastSweepAt === null ? (
        <EmptyState title="Not checked yet.">Governance reads each app about every 6 hours. Use Check now to read them now.</EmptyState>
      ) : (
        <>
          {unread.length ? (
            <details className="store-items">
              <summary>{unread.length === 1 ? `Could not be read: ${unread[0]?.name}` : `${unread.length} apps could not be read`}</summary>
              <ul className="ready">
                {unread.map((u) => (
                  <li key={u.product}>
                    <span>{`${u.name}: ${u.text}`}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {groups.length === 0 ? (
            <EmptyState title={`No differences at ${when(data.lastSweepAt)}.`}>{`${data.storesRead} apps read. This says what they reported, and nothing about what they could not read.`}</EmptyState>
          ) : (
            groups.map((g) => (
              <section className="tb-stack" key={g.key} aria-label={g.text}>
                <h2 className="sub-head">{g.text}</h2>
                <ul className="ready">
                  {g.rows.map((r) => (
                    <Row key={`${r.code}:${r.subject?.id ?? r.productName}`} row={r} onAccept={setAccept} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}
      {accept ? <AcceptDialog row={accept} onClose={() => setAccept(null)} onChanged={reload} /> : null}
    </div>
  );
}
