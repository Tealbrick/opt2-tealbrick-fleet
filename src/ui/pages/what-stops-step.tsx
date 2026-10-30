// Step "What stops" of the person flow (DESIGN-C380 §10): per store, what ends when the plan runs. A store that was not read sits on top
// and is not zero. Items others can read about this person start unticked, with the sentence that says what that means. A failed read
// stops nothing: the Core steps still go, and the owner can go on.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { useCallback, useEffect, useState } from "react";
import { LoadFailed, Loading, useLoad } from "../common.tsx";
import type { PlanPreviewOutput, PreviewItem } from "./inventory-types.ts";
import { StoreRows, type TickProps } from "./store-rows.tsx";

export type Tick = { product: "connect" | "knowledge" | "kanban" | "evolution"; id: string };
const TARGETS = new Set(["connect", "knowledge", "kanban", "evolution"]);
const keyOf = (product: string, id: string) => `${product}:${id}`;

export function defaultTicks(preview: PlanPreviewOutput): Map<string, Tick> {
  const on = new Map<string, Tick>();
  for (const s of preview.stores) {
    if (s.state !== "read" || !TARGETS.has(s.product)) continue;
    for (const i of s.items) if (i.effect === "stops") on.set(keyOf(s.product, i.id), tickOf(s.product, i));
  }
  return on;
}
const tickOf = (product: string, i: PreviewItem): Tick => ({ product: product as Tick["product"], id: i.id });

export function WhatStopsStep({ kind, id, name, onChange }: { kind: "person" | "agent"; id: string; name: string; onChange: (ticks: Tick[]) => void }) {
  const { data, error, loading, reload } = useLoad(useCallback(() => callOp<PlanPreviewOutput>("plan_preview", { kind, id }), [kind, id]));
  const [on, setOn] = useState<Map<string, Tick> | null>(null);
  useEffect(() => {
    if (data && on === null) setOn(defaultTicks(data));
  }, [data, on]);
  useEffect(() => {
    if (on) onChange([...on.values()]);
  }, [on, onChange]);
  const ticks: TickProps = {
    isOn: (product, itemId) => on?.has(keyOf(product, itemId)) ?? false,
    toggle: (product, item, value) =>
      setOn((cur) => {
        const next = new Map(cur ?? []);
        if (value) next.set(keyOf(product, item.id), tickOf(product, item));
        else next.delete(keyOf(product, item.id));
        return next;
      }),
  };
  if (error) return <LoadFailed message={`What each app reports could not be read. You can go on: the steps in Portal do not need it. ${error}`} retrying={loading} onRetry={() => void reload()} />;
  if (!data) return <Loading what="what each app reports" />;
  return <StoreRows stores={data.stores} subjectName={name} unlinkedAccounts={data.unlinkedAccounts} ticks={ticks} />;
}
