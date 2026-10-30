// The confirm of the stop cap (C380 N2-3). A confirm cannot stop a script: the count is in the refusal, and the op takes it. So the page adds
// nothing to that: it never answers by itself, it sends a number only on the owner's next press after the refusal that named it, one press
// spends it, and a change on the form or another refusal drops it. It keeps the number in no store and no URL.
import { useCallback, useState } from "react";
import { stopCapOf } from "./lifecycle-errors.ts";

export function useCapConfirm() {
  const [count, setCount] = useState<number | null>(null);
  /** The number for this press, once. */
  const take = () => {
    const c = count;
    setCount(null);
    return c;
  };
  /** After a refusal: the number it named, or none. */
  const note = useCallback((e: unknown) => setCount(stopCapOf(e)), []);
  const clear = useCallback(() => setCount(null), []);
  return { count, take, note, clear };
}

export const capButton = (count: number) => `Yes, this makes ${count}`;
