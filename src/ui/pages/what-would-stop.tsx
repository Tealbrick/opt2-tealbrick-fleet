// "See what would stop" (DESIGN-C380 §5.1, business F1): a look with no risk. It reads what each app reports now and changes nothing:
// no state, no feed, no plan. The dialog says so, and says what a stop never changes.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Notice } from "@opt2-tealbrick/ui";
import { useCallback } from "react";
import { LoadFailed, Loading, useLoad } from "../common.tsx";
import type { PlanPreviewOutput } from "./inventory-types.ts";
import { NotChanged } from "./plan-result.tsx";
import { StoreRows } from "./store-rows.tsx";
import { when } from "./words.ts";

export const loadPreview = (kind: "person" | "agent", id: string) => callOp<PlanPreviewOutput>("plan_preview", { kind, id });

export function WhatWouldStop({ subject, onClose }: { subject: { kind: "person" | "agent"; id: string; name: string }; onClose: () => void }) {
  const { data, error, loading, reload } = useLoad(useCallback(() => loadPreview(subject.kind, subject.id), [subject.kind, subject.id]));
  return (
    <Dialog
      open
      size="lg"
      title={`If ${subject.name} left now`}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="tb-stack">
        <Notice tone="neutral" role="status">
          {`This is a preview of Stop and remove access. Nothing stops and no access changes.${data ? ` Read ${when(data.asOf)}.` : ""}`}
        </Notice>
        {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
        {data === null ? error ? null : <Loading what="what each app reports" /> : <StoreRows stores={data.stores} subjectName={subject.name} unlinkedAccounts={data.unlinkedAccounts} />}
        {data ? <NotChanged /> : null}
      </div>
    </Dialog>
  );
}
