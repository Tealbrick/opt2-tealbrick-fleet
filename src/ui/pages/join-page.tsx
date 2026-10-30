// The Join page (C380 T2-d): two ways in, one person or a pasted list. A route, not a nav entry, until the QA rows R12 to R14 pass
// (features.ts JOIN_ROWS_PASSED); the People and agents page shows the same button only then.
import { Button, ButtonLink } from "@opt2-tealbrick/ui";
import { useState } from "react";
import { PageHead } from "../common.tsx";
import { JoinFlow, type JoinMode } from "./join-flow.tsx";

/** The button on People and agents (only when Join is in the navigation). It opens the same flow. */
export function JoinButton() {
  return (
    <ButtonLink href="./join" variant="primary">
      Add people
    </ButtonLink>
  );
}

export function JoinPage({ portalHref }: { portalHref?: string }) {
  const [open, setOpen] = useState<JoinMode | null>(null);
  return (
    <section className="app-page" aria-label="Add people">
      <PageHead title="Add people" lede="Put a person, or a list of people, in your directory. This gives no access: you grant access to agents in Portal." />
      <div className="tb-stack">
        <span className="tb-row">
          <Button variant="primary" onClick={() => setOpen("one")}>
            Add a person
          </Button>
          <Button onClick={() => setOpen("list")}>Add people from a list</Button>
        </span>
        <p className="tb-hint">A contractor has a last day. At the end of that day Governance marks the person as stopped.</p>
      </div>
      {open ? <JoinFlow mode={open} portalHref={portalHref} onClose={() => setOpen(null)} onChanged={() => undefined} /> : null}
    </section>
  );
}
