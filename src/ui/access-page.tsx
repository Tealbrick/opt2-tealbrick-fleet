// The Access page (C373 WP-D): the grant view from the person op `access_get`, read only. It shows what Core's copy of access
// says (per agent: connections, channel identities, the apps it may use; per app: the agents and the apps that may call it).
// Governance changes nothing here; "Change access in Portal" links to Portal. When the copy is not available (the platform is
// older, or the owner has not turned on "See who has access" for Governance) the page says so in plain words.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Notice, Tabs } from "@opt2-tealbrick/ui";
import { useState } from "react";
import type { AccessGetOutput } from "#kit";
import { AccessView } from "./access.tsx";
import { LoadFailed, Loading, PageHead, useLoad } from "./common.tsx";
import { Differences } from "./pages/differences.tsx";
import { FEATURES } from "./pages/features.ts";

const loadAccess = () => callOp<AccessGetOutput>("access_get", {});

type View = "grants" | "differences";
const VIEWS: { value: View; label: string }[] = [
  { value: "grants", label: "Who can use what" },
  { value: "differences", label: "Differences" },
];

export function AccessPage({ portalHref }: { portalHref?: string }) {
  // A link from a person's page opens the list it speaks of.
  const [view, setView] = useState<View>(() => (new URLSearchParams(globalThis.location?.search ?? "").get("view") === "differences" ? "differences" : "grants"));
  if (!FEATURES.differences) return <Grants portalHref={portalHref} />;
  return (
    <section className="app-page" aria-label="Access">
      <Tabs label="Access" tabs={VIEWS} value={view} onChange={setView} />
      {view === "grants" ? (
        <Grants portalHref={portalHref} />
      ) : (
        <>
          <PageHead title="Differences" lede="What no longer matches. Nothing here changes by itself." />
          <Differences />
        </>
      )}
    </section>
  );
}

function Grants({ portalHref }: { portalHref?: string }) {
  const { data, error, loading, reload } = useLoad(loadAccess);
  return (
    <section className="app-page" aria-label="Access page">
      <PageHead title="Access" lede="Which agents may use which apps, and the connections and channels each agent has. Only you see this page. Governance only shows it: access is changed in Portal." />
      {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      <Notice tone="neutral">Teal Brick asks you to approve a sender's call only when the agent's runner names that sender. Governance does not find agents you do not know about.</Notice>
      {data === null ? (
        error ? null : (
          <Loading what="access" />
        )
      ) : data.status === "available" ? (
        <>
          {data.note ? (
            <Notice tone="neutral" role="status">
              {data.note}
            </Notice>
          ) : null}
          <AccessView slice={data.topology} agents={data.agents} identities={data.identities} portalHref={portalHref} />
        </>
      ) : (
        <AccessView slice={null} agents={[]} identities={[]} portalHref={portalHref} note={data.note} />
      )}
    </section>
  );
}
