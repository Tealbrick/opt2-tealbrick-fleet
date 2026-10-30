// The Teams, People and Agents pages share one directory load (overview_get) and one reload.
import { LoadFailed, Loading, useLoad } from "../common.tsx";
import { Agents } from "./agents.tsx";
import { People } from "./people.tsx";
import { loadDirectory } from "./shared.tsx";
import { Teams } from "./teams.tsx";

export function DirectoryPage({ page }: { page: "teams" | "people" | "agents" }) {
  const { data: dir, error, loading, reload } = useLoad(loadDirectory);
  if (dir === null)
    return (
      <section className="app-page" aria-label={page}>
        {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : <Loading what="the directory" />}
      </section>
    );
  return (
    <>
      {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      {page === "people" ? <People dir={dir} reload={reload} /> : page === "agents" ? <Agents dir={dir} reload={reload} /> : <Teams dir={dir} reload={reload} />}
    </>
  );
}
