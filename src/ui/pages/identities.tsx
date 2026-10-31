// Identities page (owner): channel identities Connect issued to the agents. Read only.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { accessFilter, EmptyState, ListFilter, Notice, Swatch, Tag, useAccessFilter } from "@opt2-tealbrick/ui";
import type { IdentitiesViewOutput } from "#kit";
import { LoadFailed, Loading, PageHead, useLoad } from "../common.tsx";
import { FILTER_FROM, filterKey } from "../list-filter.ts";

const loadIdentities = () => callOp<IdentitiesViewOutput>("identities_view", {});

/** The start of the note the server writes when Connect holds more identities than it read (src/identities.ts). */
const CUT_NOTE = "Showing the first";
const bare = (channel: string, id: string) => (id.startsWith(`${channel}:`) ? id.slice(channel.length + 1) : id);
/** Display only (the full value stays in `title`): a long key shows its head and tail, `npub1q8x…h6w6`. */
const shortId = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

export function Identities() {
  const { data: ids, error, loading, reload } = useLoad(loadIdentities);
  // C382 batch 4: a text filter. `identities_view` has no filter; the server reads up to its page limit and says so in the note, so the filter says it reads only those.
  const [query, setQuery] = useAccessFilter(filterKey("identities"));
  const textFilter = accessFilter(query);
  const all = ids?.agents ?? [];
  const rows = all.filter((a) => textFilter.test(`${a.agent.name} ${a.channel} ${bare(a.channel, a.identity)}`));
  const filterOn = query.trim() !== "";
  const showBar = all.length >= FILTER_FROM || filterOn;
  const more = ids?.connect.note.startsWith(CUT_NOTE) ?? false;
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
            <>
              {showBar ? (
                <ListFilter
                  label="Filter the identities"
                  value={query}
                  onChange={setQuery}
                  filter={textFilter}
                  placeholder="Agent, channel, or a regex"
                  noun={{ one: "identity", many: "identities" }}
                  shown={rows.length}
                  total={all.length}
                  more={more}
                  onClear={() => setQuery("")}
                />
              ) : null}
              <div className="ruled dir">
                {rows.map((a) => {
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
            </>
          )}
        </>
      )}
    </section>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────
