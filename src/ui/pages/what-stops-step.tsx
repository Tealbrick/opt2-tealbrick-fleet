// Step "What ends" of the person flow (DESIGN-C380 §10, C381): per store, what ends when the plan runs. A person's agents keep what they hold, unless the owner chose to stop one. A store that was not read sits on top
// and is not zero. Items others can read about this person start unticked, with the sentence that says what that means. A failed read
// stops nothing: the Core steps still go, and the owner can go on.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { useCallback, useEffect, useRef, useState } from "react";
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

export function WhatStopsStep({ kind, id, name, stopping = [], onChange }: { kind: "person" | "agent"; id: string; name: string; stopping?: readonly string[]; onChange: (ticks: Tick[] | null) => void }) {
  const asked = stopping.join(",");
  const { data, error, loading, reload } = useLoad(useCallback(() => callOp<PlanPreviewOutput>("plan_preview", { kind, id, ...(asked ? { stopping: asked.split(",") } : {}) }), [kind, id, asked]));
  const [on, setOn] = useState<Map<string, Tick> | null>(null);
  // The owner went back and changed a choice: the list is new, so the ticks start again from it. Until it is read no tick is sent: a plan with none ends the server's defaults, so an agent just chosen to stop does not keep what it holds.
  const readFor = useRef<PlanPreviewOutput | null>(null);
  useEffect(() => {
    setOn(null);
    onChange(null);
  }, [asked, onChange]);
  useEffect(() => {
    if (data && readFor.current !== data) {
      readFor.current = data;
      setOn(defaultTicks(data));
    }
  }, [data]);
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
