// The owner's pages inside the ONE app shell, <AppShell> from @opt2-tealbrick/ui (SDK-API §14): teams, topology, trust reviews, people,
// agents, identities, and the SDK holds page (./standard.tsx, the template's single copy). Every change is a person op
// (`callOp`); the page reloads the directory after each one. Holds are decided one call at a time (C8, in HoldsPage).
// Every load shows its error with Try again (RUL-14); every failed change shows a plain message (L18).
// The pages live in src/ui/pages/ (teams, people, agents, identities; one file per page) and the feature pages beside this file.
import { callOp, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, Notice, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import type { PlanGetOutput } from "#kit";
import { AccessPage } from "./access-page.tsx";
import { useLoad } from "./common.tsx";
import { ContactRulesPage } from "./contact-rules.tsx";
import { DirectoryPage } from "./pages/directory.tsx";
import { EveryonePage } from "./pages/everyone.tsx";
import { CannotHoldBothPage } from "./pages/exclusions.tsx";
import { FEATURES } from "./pages/features.ts";
import { Identities } from "./pages/identities.tsx";
import { JoinPage } from "./pages/join-page.tsx";
import { liveBanners } from "./pages/plan-poll.ts";
import { RecordPage } from "./pages/record.tsx";
import { RefusalsPage } from "./pages/refusals.tsx";
import { RolesPage } from "./pages/roles.tsx";
import { RoundsPage } from "./pages/rounds.tsx";
import { SubjectPage } from "./pages/subject.tsx";
import { SUBJECT_PATH } from "./pages/subject-link.ts";
import { SummaryPage } from "./pages/summary.tsx";
import { loadReviews, ReviewsPage, reviewBadge } from "./reviews.tsx";
import { HoldsPage, portalHref, useHoldList, useNav } from "./standard.tsx";
import { TopologyPage } from "./topology.tsx";

const NAME = "Governance";
/** Where scripts/build-ui.ts puts this app's still (`stills/`, next to this module in the hashed asset directory, C61). */
const STILLS = new URL("./stills/", import.meta.url).href;

/** Shell page id → path under the base `/a/fleet/`. Teams is the launch page and the configure page (manifest `ui.launchPath` = `ui.configurePath` = "/"). */
const OLD_ROUTES = { teams: "", topology: "topology", access: "access", reviews: "reviews", rules: "contact-rules", people: "people", agents: "agents", identities: "identities", holds: "holds" } as const;
/** With the lifecycle ops (C380): Summary is the launch page; /people and /agents stay as routes and leave the nav for one release. */
const NEW_ROUTES = { ...OLD_ROUTES, summary: "", everyone: "people-and-agents", subject: SUBJECT_PATH, teams: "teams", join: "join" } as const;
/** Tier 2: a route exists when the ops are there; the nav entry waits for the QA rows (features.ts). */
const TIER2_ROUTES = { ...(FEATURES.refusals ? { refusals: "who-is-refused" } : {}), ...(FEATURES.roles ? { roles: "roles" } : {}), ...(FEATURES.exclusions ? { exclusions: "cannot-hold-both" } : {}), ...(FEATURES.rounds ? { rounds: "review-rounds" } : {}), ...(FEATURES.record ? { record: "access-record" } : {}) };
const ROUTES: Readonly<Record<string, string>> = { ...(FEATURES.lifecycle ? NEW_ROUTES : OLD_ROUTES), ...TIER2_ROUTES };
const LAUNCH = FEATURES.lifecycle ? "summary" : "teams";
const OLD_PAGES = [
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
const NEW_PAGES = [
  { id: "summary", label: "Summary" },
  { id: "everyone", label: "People and agents" },
  { id: "access", label: "Access" },
  { id: "reviews", label: "Reviews" },
  { id: "teams", label: "Teams" },
  { id: "topology", label: "Who owns what" },
  { id: "rules", label: "Contact rules" },
  { id: "identities", label: "Identities" },
  { id: "holds", label: "Waiting for approval" },
];
/** Review rounds follow Reviews, the Access record follows Access, Roles follows Teams, Cannot hold both follows Roles (or Teams when Roles is not in the navigation). */
function withTier2(pages: { id: string; label: string }[]): { id: string; label: string }[] {
  return pages.flatMap((p) => [
    p,
    ...(p.id === "everyone" && FEATURES.refusals ? [{ id: "refusals", label: "Who is refused" }] : []),
    ...(p.id === "reviews" && FEATURES.roundsNav ? [{ id: "rounds", label: "Review rounds" }] : []),
    ...(p.id === "access" && FEATURES.recordNav ? [{ id: "record", label: "Access record" }] : []),
    ...(p.id === "teams" && FEATURES.rolesInNav ? [{ id: "roles", label: "Roles" }] : []),
    ...(p.id === "teams" && FEATURES.exclusionsInNav ? [{ id: "exclusions", label: "Cannot hold both" }] : []),
  ]);
}
const PAGES = withTier2(FEATURES.lifecycle ? NEW_PAGES : OLD_PAGES);

export function App() {
  const { principal, status, signOut } = useSession();
  const nav = useNav(ROUTES, LAUNCH);
  const holds = useHoldList();
  const signedIn = status === "signed_in" && principal;
  const loadBadge = useCallback(() => (signedIn ? loadReviews() : Promise.resolve(null)), [signedIn]);
  const badge = useLoad(loadBadge);
  const [notice, setNotice] = useState<string | null>(null);
  const [portal] = useState(portalHref);
  // "./" = the Portal origin is not known (no trusted referrer): then there is no link to show
  const portalLink = portal === "./" ? undefined : portal;
  const loadAlerts = useCallback(() => (signedIn && FEATURES.plans ? callOp<PlanGetOutput>("plan_get", {}) : Promise.resolve(null)), [signedIn]);
  const alerts = useLoad(loadAlerts);
  const pages = PAGES.map((p) => (p.id === "summary" ? { ...p, badge: (alerts.data ? liveBanners(alerts.data).length : 0) || null } : p.id === "holds" ? { ...p, badge: holds.holds?.length || null } : p.id === "reviews" ? { ...p, badge: reviewBadge(badge.data) } : p));
  return (
    <AppShell
      title={NAME}
      colour={appColour("fleet")}
      art={appArt("fleet", STILLS)}
      portalHref={portal}
      pages={pages}
      current={nav.page === "subject" || nav.page === "join" ? "everyone" : (nav.page === "roles" && !FEATURES.rolesInNav) || (nav.page === "exclusions" && !FEATURES.exclusionsInNav) ? LAUNCH : nav.page}
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
      {!signedIn ? null : nav.page === "summary" ? (
        <SummaryPage />
      ) : nav.page === "refusals" && FEATURES.refusals ? (
        <RefusalsPage />
      ) : nav.page === "everyone" ? (
        <EveryonePage portalHref={portalLink} />
      ) : nav.page === "subject" ? (
        <SubjectPage portalHref={portalLink} />
      ) : nav.page === "join" && FEATURES.join ? (
        <JoinPage portalHref={portalLink} />
      ) : nav.page === "holds" ? (
        <HoldsPage title="Waiting for approval" list={holds} only={nav.hold} empty="No calls wait for your approval." />
      ) : nav.page === "topology" ? (
        <TopologyPage portalHref={portalLink} />
      ) : nav.page === "access" ? (
        <AccessPage portalHref={portalLink} />
      ) : nav.page === "rules" ? (
        <ContactRulesPage />
      ) : nav.page === "reviews" ? (
        <ReviewsPage onChanged={() => void badge.reload()} />
      ) : nav.page === "rounds" ? (
        <RoundsPage />
      ) : nav.page === "record" ? (
        <RecordPage />
      ) : nav.page === "identities" ? (
        <Identities />
      ) : nav.page === "roles" ? (
        <RolesPage />
      ) : nav.page === "exclusions" ? (
        <CannotHoldBothPage />
      ) : (
        <DirectoryPage page={nav.page as "teams" | "people" | "agents"} />
      )}
    </AppShell>
  );
}
