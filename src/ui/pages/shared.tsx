// Pieces the directory pages (Teams, People, Agents) share: the directory types, list parsing, the two-click delete.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button } from "@opt2-tealbrick/ui";
import { useState } from "react";
import type { OverviewGetOutput } from "#kit";
import { changeError } from "../common.tsx";

export type Dir = OverviewGetOutput;
export type Team = Dir["teams"][number];
export type Person = Dir["people"][number];
export type Agent = Dir["agents"][number];
export type Role = "member" | "lead";
export type Reload = () => Promise<void>;

export const csv = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Display only (the full handle stays in `title`): `buzz:npub180cvv07t…` for a long value, short handles as they are. */
export const shortHandle = (h: string) => {
  const at = h.indexOf(":");
  const value = at < 0 ? h : h.slice(at + 1);
  return value.length > 20 ? `${h.slice(0, at + 1)}${value.slice(0, 13)}…` : h;
};

export const loadDirectory = () => callOp<Dir>("overview_get", {});

/** Delete in two clicks: the first arms the button (it turns into the filled confirm), the second deletes. */
export function DeleteButton({ what, run, onError }: { what: string; run: () => Promise<void>; onError: (message: string | null) => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const click = async () => {
    if (!armed) {
      setArmed(true);
      onError(null);
      return;
    }
    setBusy(true);
    try {
      await run();
    } catch (e) {
      onError(changeError(e));
      setArmed(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="danger"
      confirm={armed}
      disabled={busy}
      aria-label={armed ? `Confirm delete ${what}` : `Delete ${what}`}
      onClick={() => void click()}
      onBlur={() => setArmed(false)}
    >
      {armed ? "Confirm delete" : "Delete"}
    </Button>
  );
}
