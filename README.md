# Governance (Tealbrick mini app)

Governance (product id `fleet`; formerly "Organization Plane", merged with the Mesh Trust Topology idea, decision C166): the workspace directory and its trust record. It holds teams, people and outside agents (directory entries, not sign-ins), which person owns which agent, agent role and tags, channel handles (Buzz npub, Slack user id, Telegram user id) and a trust state for every person, outside agent and agent. It is the single read model other apps use; it holds no policy and no credentials. Built on the Miniapp SDK.

**Status:** 0.2.2 (unreleased; sprint S3a of the Governance design: the topology from Governance's own data). 0.2.1 added the trust reviews and the lean agent views. 0.2.0 added the display name, the trust state and the directory feed for apps. Visibility: private (not shipped yet). Dev-only in the signed index (`DEV_ONLY_PRODUCTS`), no offer, not shown on the website. The product id stays `fleet` (tool names `fleet__*`, hook `fleet_facts`, context keys `fleet.*`). See `CHANGELOG.md`.

- Repository: `Tealbrick/opt2-tealbrick-fleet` (GitHub organisation `Tealbrick`)
- Licence: Apache-2.0 for the app code (`LICENSE`, `NOTICE`); upstream licences are in `THIRD_PARTY_NOTICES.md`. The Tealbrick brand mark and app art are Tealbrick artwork and are not covered by the Apache-2.0 licence.

## No secrets policy

This repository is private. Treat it as if it could become public. It must never contain secrets or personal data, and neither may its issues or pull requests:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables) and are copied between services without printing them.
- No personal names, private agent configurations or customer data. Test data uses invented names and the public NIP-19 example key.
- Every pull request, every push to `main` and every tag runs a secret scan (gitleaks, the `secret-scan` step in `.woodpecker/ci.yaml`). GitHub secret scanning and push protection are not enabled on this repository, so the CI scan is the guard. Optional local guard: `pre-commit install` (`.pre-commit-config.yaml` runs gitleaks).
- If a secret is committed anyway: rotate it first, then remove it from history.

## What it does

| Surface | Ids | Notes |
|---|---|---|
| Agent ops | `teams_list`, `team_get`, `directory_get`, `resolve_sender` (read); `review_request` (create) | MCP tools `fleet__<id>`. The three directory reads are lean since 0.2.1 (names, titles, trust, teams, owner). `review_request` asks the owner for a trust review; an agent can never set trust |
| App feed (read) | `directory_feed` | contract `fleet.directory_feed/1` for companion apps (Rules' read model). The handler refuses every caller that is not an app (agents get `no_access` 403) until the manifest has an `app` audience (G-1) |
| Person ops (owner UI) | `overview_get`, `team_set`, `team_delete`, `person_set`, `person_delete`, `members_set`, `agent_set`, `identities_view`, `topology_get`, `reviews_list`, `review_get`, `review_record`, `review_dismiss`, `review_policy_set` | the app's own pages: Teams, Topology, Trust reviews, People, Agents, Identities, Holds. `team_delete` and `person_delete` are held. |
| Context hook | `fleet_facts` (phase `context`, order -100, every product) | adds `fleet.requester` (with its `trust`), `fleet.requester.trust` (`null` = not in the directory; narrow-only for unverified claims), `fleet.requester.verified` (the claim's flag), `fleet.requesterTeams` (from the `tb.onBehalfOf` claim), `fleet.agentOwner`, `fleet.agentTeams` (at most 50). Pure DB read, under 5 ms at 500 teams / 2000 people (tested) |
| Agent directory | `needsAgentDirectory: true` | agents come from the instance slice; `events.agentsChanged` (full list on every change: add, re-add, rename, pause, removal) keeps `fleet_agents` in sync |

- **One handle format:** `"<channel>:<value>"` (`buzz:npub1...`, `slack:U...`, `telegram:123...`), equal to the `tb.onBehalfOf` `channel_sender` claim id, canonicalized by the shared `normalizeHandle` (`@opt2-tealbrick/manifest` 0.1.19, with `isNpub`, `npubFromHex`, `handleChannel`); there is no local copy. `buzz:<64-hex key>` is stored as its npub; a bare npub reads as `buzz:`.
- **Narrow, never widen:** a departed or blocked contact resolves but has no teams; a removed agent has no facts; the requester carries the claim's `verified` flag, and `fleet.requester.trust` of an unverified claim is for narrowing (deny, hold) only. A departed contact still reports its trust value but has no teams.
- **Trust:** `unreviewed`, `trusted`, `limited` or `blocked`, stored on contacts (`kind` = `person` or `outside_agent`) and on agents (migration 0002). People and outside agents the owner adds start `trusted`; entries that an agent adds start `unreviewed` (one function, `defaultTrust` in `src/trust.ts`; no agent create op exists yet). Workspace agents that arrive from the slice start `unreviewed` (0.2.1; agents that existed before keep `trusted`). Reviews change trust (`review_record`, 0.2.1). The review schedule defaults (agents 90 days, contacts 180 days) are stored in `fleet_review_policy`.
- **Feed contract:** `directory_feed` answers `fleet.directory_feed/1` exactly: `v`, `revision`, `teams[{id, name, members[{kind: agent|contact, id, role}]}]`, `contacts[{id, kind, status, trust, handles}]`, `agents[{id, status, trust, owner}]`, or `{v, revision, unchanged:true}`. Handles are canonical only (`normalizeHandle(h) === h`; others are left out). No email, title, tag, description or review reason. The frozen schema and fixtures are in `test/contracts/` (see `PROVENANCE.md`); every answer in the tests is validated against them.
- **Revision:** every change moves `revision`; `directory_get {sinceRevision}` answers `unchanged: true` when nothing moved.
- **Topology (0.2.2, owner only):** `topology_get` answers the network from Governance's own data: people, outside agents, agents (a removed agent only while a team still names it) and teams, with `owner` and `member` edges, and for each node its trust, status, next review date and whether it changed since the last review (the same review logic as the Trust reviews page). It carries names, kinds, trust, status, roles and owner links; no email, handles, tags or review reasons. The `contacts` layer (Connect contact book, G-5) and the `access` layer (copy of Portal access, G-2) answer `unavailable` with a plain note and no edges. `focus` returns one node, its neighbours and the edges between them (`node_not_found`, 404). Beyond 3000 nodes or 10000 edges the answer is refused with `topology_too_large` (503), never cut. The Topology page is a Relationships table, a table of people and agents, notices, and a print view; the network picture waits for the ui kit's `TopologyGraph` (G-10).
- **Privacy (since 0.2.1):** `teams_list`, `team_get` and `directory_get` give agents names, titles, the team description, roles, team structure, owner and trust. No email, handles, tags or agent mode (FLT-01 / APP-06). `resolve_sender` returns no email, title, tag or handle of others; `directory_feed` (apps only) carries handles, no email, title or tag. A test scans every agent operation output for `@`, handles and tags.
- **Reviews:** an agent (or a companion app) asks with `review_request`; one open request per (requester, subject), at most 20 per agent. An unknown handle creates no directory entry: the owner adds it when she records a verdict. The text is stored as untrusted text. The owner decides with `review_record` in a four-step flow (Subject, Verdict, Contact rule, Confirm); the verdict binds the digest of the snapshot the owner looked at and is refused with `snapshot_stale` (409) when the subject changed since. A verdict sets the trust and closes the subject's open requests in one write. Closed reviews are append-only (database triggers). The snapshot is `directory_only` (owner, teams, handles) until Core gives apps the access data (G-2). Due dates come from the schedule (agents 90 days, people and outside agents 180 days); a new agent opens a review request when "review new agents" is on.
- **Identities view (owner only):** the channel identities Connect issued to each agent, read through Fleet's one companion grant (`connect.identities_list`, read). `identities_view` also returns people's handles; the page shows them on People, not on Identities. Only the person op `identities_view` uses the grant; no agent op or hook fact carries those identities. Without Connect the page shows an `unavailable` note.
- Design source: the v1 `labs/organization-plane` (person + membership subjects person|agent) and the v1 portal `Team` / `Membership` / `AgentGrant` / `ExternalIdentity` records, trimmed to one workspace = one tenant (UNVERIFIED: the v1 sources are not in this repository).

## Build

Scaffolded with `create-tealbrick-miniapp`; CI template ci-v9.9. Pins: miniapp-sdk 0.1.25, manifest 0.1.19, conformance 0.1.18, ui 0.3.0.

`tealbrick.manifest.json` is the only description of the app. The SDK derives the routes, input and output validation, OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. You write handlers by operation id (`src/app.ts`) and plain migrations (`migrations/`).

## Language

New code is TypeScript (Node 24+). Swift only where the macOS app requires it.

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | identity, runtime (data + backup volumes), operations, hook, agent directory, companion, skills, backups, UI path |
| `src/app.ts` | `defineApp`: one typed handler per operation (op ids and I/O types from `#kit`), the hook, agent events |
| `src/store.ts` | the directory over the app's tables (plain functions over the SDK `Db`) |
| `src/facts.ts` | the `fleet_facts` context hook (pure function of the hook request and the DB) |
| `src/reviews.ts` | reviews: request, record, dismiss, snapshot, due dates, policy |
| `src/lean.ts` | the lean agent views of the directory |
| `src/topology.ts` | the `topology_get` answer (org layer, focus, caps) and its caller guard |
| `src/ui/reviews.tsx`, `src/ui/topology.tsx`, `src/ui/common.tsx` | the Trust reviews page and the review flow; the Topology page; the pieces the pages share |
| `src/trust.ts` | trust states and the one start-trust rule (`defaultTrust`) |
| `src/feed.ts` | the `directory_feed` builder (contract `fleet.directory_feed/1`) and its caller guard |
| `src/identities.ts` | the Connect identities read behind `identities_view` |
| `src/main.ts` | `startApp(app, process.env)` |
| `src/ui/` | React UI (`<TbProvider>` + `<AppShell>` from `@opt2-tealbrick/ui`), built to `dist/ui` |
| `migrations/` | `0001_init.sql` (baseline), `0002_governance.sql` (kind, trust, source, review schedule), `0003_reviews.sql` (reviews, append-only triggers, review flags); forward-only, never edit a released file |
| `skills/use-fleet/SKILL.md` | the agent skill (frontmatter `name`, `description`) |
| `scripts/build-ui.ts` | UI build without a bundler (tsc output + vendored modules + import map) |
| `gen/` (not committed) | `tb-gen` output; `node --run kit` generates the kit and compiles it to `dist/kit` (`#kit` import) |
| `Dockerfile` | `node:24-slim` pinned by digest, pnpm build to `dist/`, non-root, `CMD ["node", "dist/main.js"]` |
| `.woodpecker/ci.yaml`, `.github/workflows/opt2-release.yml` | the opt2 CI template ci-v9.9, generated from `Tealbrick/opt2-tealbrick-platform`; do not edit |
| `tealbrick-ci.json` | CI settings: kind `miniapp`, one image |
| `conformance.start.ts` | boots the app for `tb-conformance` |
| `test/` | store, identities, feed/contract/trust/migration and app checks, UI checks; `test/contracts/` holds the frozen feed schema and fixtures with `PROVENANCE.md` |

## Develop

```sh
corepack enable && pnpm install --frozen-lockfile --ignore-scripts   # commit pnpm-lock.yaml: CI installs with --frozen-lockfile
# typecheck, test, conformance, build and start first run `tb-gen kit` (op ids + I/O types from the manifest)
pnpm typecheck && pnpm lint && pnpm test
pnpm build            # kit, server to dist/, UI to dist/ui
pnpm conformance      # SDK conformance suite against this app (not release evidence; QA is)
TB_STANDALONE=1 TB_DATA_DIR=.data pnpm start   # app-alone mode: person UI only, no agent calls (operations answer 503 no_bridge)
```

## Environment

The SDK reads only `TB_*` variables (SDK API section 13). The Dockerfile defaults `TB_DATA_DIR=/data` (the `data` volume mount) and `TB_BACKUP_DIR=/data/backup` (one volume per service). The deploy recipe sets the rest: `TB_INSTANCE_ID`, `TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`. Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`, `TB_STANDALONE`. The listen port is the manifest `runtime.port`. The app has no keys and no app-specific environment variables.

## How it ships

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` on a green pipeline and push the tag. Tags are immutable.
3. The release Action pushes the GHCR image `ghcr.io/tealbrick/opt2-tealbrick-fleet` and the kit tarball. `registry-sync` signs the index entry with the image digest and the manifest digest. Fleet is dev-only in the index.
4. An update that fails keeps the previous version serving.

Check `publisher` and `source.repo` in the manifest. The repository name must match the image name in `tealbrick-ci.json` (`opt2-tealbrick-fleet`).

## Dependency pins and caching

- `@opt2-tealbrick/*` dependencies are pinned as tarball URLs on the dist host (`Tealbrick/opt2-tealbrick-dist` releases). `pnpm-lock.yaml` carries the sha512 integrity of every such tarball. After changing one, run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to `dist/ui/index.html` + `dist/ui/assets-<content hash>/`; the SDK serves `index.html` as `no-cache` and the hashed directory as immutable, so a deploy is visible at once.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): design of this app (operations, scopes, data, background work).
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to change it.
- Runtime contract: `docs/SDK-API.md` in `Tealbrick/opt2-tealbrick-specs`. UI kit: `Tealbrick/opt2-tealbrick-packages`.
- System documentation (overview, environments, runbooks) lives in the private repo Tealbrick/opt2-tealbrick-docs.
