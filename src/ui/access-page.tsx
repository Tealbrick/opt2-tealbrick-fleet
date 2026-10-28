// The Access page (C373 WP-D): the grant view from the person op `access_get`, read only. It shows what Core's copy of access
// says (per agent: connections, channel identities, the apps it may use; per app: the agents and the apps that may call it).
// Governance changes nothing here; "Change access in Portal" links to Portal. When the copy is not available (the platform is
// older, or the owner has not turned on "See who has access" for Governance) the page says so in plain words.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Notice } from "@opt2-tealbrick/ui";
import type { AccessGetOutput } from "#kit";
import { AccessView } from "./access.tsx";
import { LoadFailed, Loading, PageHead, useLoad } from "./common.tsx";

const loadAccess = () => callOp<AccessGetOutput>("access_get", {});

export function AccessPage({ portalHref }: { portalHref?: string }) {
  const { data, error, loading, reload } = useLoad(loadAccess);
  return (
    <section className="app-page" aria-label="Access page">
      <PageHead title="Access" lede="Which agents may use which apps, and the connections and channels each agent has. Only you see this page. Governance only shows it: access is changed in Portal." />
      {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
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
