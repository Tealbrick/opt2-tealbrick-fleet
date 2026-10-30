// Identities page (owner): channel identities Connect issued to the agents. Read only.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { EmptyState, Notice, Swatch, Tag } from "@opt2-tealbrick/ui";
import type { IdentitiesViewOutput } from "#kit";
import { LoadFailed, Loading, PageHead, useLoad } from "../common.tsx";

const loadIdentities = () => callOp<IdentitiesViewOutput>("identities_view", {});

const bare = (channel: string, id: string) => (id.startsWith(`${channel}:`) ? id.slice(channel.length + 1) : id);
/** Display only (the full value stays in `title`): a long key shows its head and tail, `npub1q8x…h6w6`. */
const shortId = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

export function Identities() {
  const { data: ids, error, loading, reload } = useLoad(loadIdentities);
  return (
    <section className="app-page" aria-label="Identities">
      <PageHead title="Identities" />
      <p className="tb-soft page-note">Channel identities Connect issued to your agents. Only you see this page.</p>
      {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      {ids === null ? (
        error ? null : <Loading what="identities" />
      ) : (
        <>
          {ids.connect.note ? (
            <Notice tone={ids.connect.status === "available" ? "live" : "needs-you"} role="status">
              {ids.connect.note}
            </Notice>
          ) : null}
          {ids.agents.length === 0 ? (
            <EmptyState title="No channel identities issued yet." />
          ) : (
            <div className="ruled dir">
              {ids.agents.map((a) => {
                const id = bare(a.channel, a.identity);
                return (
                  <div className="item" key={`${a.agent.id}:${a.channel}:${a.identity}`}>
                    <Swatch />
                    <h3>{a.agent.name}</h3>
                    <span className="meta">
                      <Tag>{a.channel}</Tag>
                      <span className="mono handle" title={id}>
                        {shortId(id)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────
