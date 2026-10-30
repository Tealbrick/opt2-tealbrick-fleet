// The owner's pages inside the ONE app shell, <AppShell> from @opt2-tealbrick/ui (SDK-API §14): teams, topology, trust reviews, people,
// agents, identities, and the SDK holds page (./standard.tsx, the template's single copy). Every change is a person op
// (`callOp`); the page reloads the directory after each one. Holds are decided one call at a time (C8, in HoldsPage).
// Every load shows its error with Try again (RUL-14); every failed change shows a plain message (L18).
// The pages live in src/ui/pages/ (teams, people, agents, identities; one file per page) and the feature pages beside this file.
import { useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, Notice, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import { AccessPage } from "./access-page.tsx";
import { useLoad } from "./common.tsx";
import { ContactRulesPage } from "./contact-rules.tsx";
import { DirectoryPage } from "./pages/directory.tsx";
import { Identities } from "./pages/identities.tsx";
import { loadReviews, ReviewsPage, reviewBadge } from "./reviews.tsx";
import { HoldsPage, portalHref, useHoldList, useNav } from "./standard.tsx";
import { TopologyPage } from "./topology.tsx";

const NAME = "Governance";
/** Where scripts/build-ui.ts puts this app's still (`stills/`, next to this module in the hashed asset directory, C61). */
const STILLS = new URL("./stills/", import.meta.url).href;

/** Shell page id → path under the base `/a/fleet/`. Teams is the launch page and the configure page (manifest `ui.launchPath` = `ui.configurePath` = "/"). */
const ROUTES = { teams: "", topology: "topology", access: "access", reviews: "reviews", rules: "contact-rules", people: "people", agents: "agents", identities: "identities", holds: "holds" } as const;
const PAGES = [
  { id: "teams", label: "Teams" },
  { id: "topology", label: "Who owns what" },
  { id: "access", label: "Access" },
  { id: "reviews", label: "Reviews" },
  { id: "rules", label: "Contact rules" },
  { id: "people", label: "People" },
  { id: "agents", label: "Agents" },
  { id: "identities", label: "Identities" },
  { id: "holds", label: "Waiting for approval" },
];

export function App() {
  const { principal, status, signOut } = useSession();
  const nav = useNav(ROUTES, "teams");
  const holds = useHoldList();
  const signedIn = status === "signed_in" && principal;
  const loadBadge = useCallback(() => (signedIn ? loadReviews() : Promise.resolve(null)), [signedIn]);
  const badge = useLoad(loadBadge);
  const [notice, setNotice] = useState<string | null>(null);
  const [portal] = useState(portalHref);
  // "./" = the Portal origin is not known (no trusted referrer): then there is no link to show
  const portalLink = portal === "./" ? undefined : portal;
  const pages = PAGES.map((p) => (p.id === "holds" ? { ...p, badge: holds.holds?.length || null } : p.id === "reviews" ? { ...p, badge: reviewBadge(badge.data) } : p));
  return (
    <AppShell
      title={NAME}
      colour={appColour("fleet")}
      art={appArt("fleet", STILLS)}
      portalHref={portal}
      pages={pages}
      current={nav.page}
      onNavigate={nav.go}
      pageHref={nav.href}
      actions={
        signedIn ? (
          <Button
            size="sm"
            onClick={() => {
              setNotice(null);
              signOut().catch(() => setNotice("Couldn’t sign you out. Check your connection and try again."));
            }}
          >
            Sign out
          </Button>
        ) : (
          <Tag status={status === "loading" ? "busy" : "needs-you"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="needs-you" role="alert">
            Open this app from Portal to sign in.
          </Notice>
        ) : notice ? (
          <Notice tone="needs-you" role="alert">
            {notice}
          </Notice>
        ) : null
      }
    >
      {!signedIn ? null : nav.page === "holds" ? (
        <HoldsPage title="Waiting for approval" list={holds} only={nav.hold} empty="No calls wait for your approval." />
      ) : nav.page === "topology" ? (
        <TopologyPage portalHref={portalLink} />
      ) : nav.page === "access" ? (
        <AccessPage portalHref={portalLink} />
      ) : nav.page === "rules" ? (
        <ContactRulesPage />
      ) : nav.page === "reviews" ? (
        <ReviewsPage onChanged={() => void badge.reload()} />
      ) : nav.page === "identities" ? (
        <Identities />
      ) : (
        <DirectoryPage page={nav.page as "teams" | "people" | "agents"} />
      )}
    </AppShell>
  );
}
