# opt2-tealbrick-fleet: Organization Plane

Teal Brick opt2 miniapp `fleet` ("Organization Plane"): the workspace directory. It holds teams, people
(directory entries, not sign-ins), which person owns which agent, and people's channel handles (Buzz npub,
Slack user id, Telegram user id). Other apps read these facts; Fleet holds no policy and no credentials.

**Status: opt2 build (clean-room v2 of Teal Brick), work in progress.** This repository is part of the opt2 build and
lives under `Martin-Atrin` during the build; it moves to the Teal Brick organisation as one clean commit when opt2 is
released. It is not the current production system.

Owner lane: Lead · Fleet.

## No secrets policy

This repository is public. It must never contain secrets or personal data:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables, GitHub Actions secrets) and are copied between services without printing them.
- No personal names, private agent configurations or customer data. Test data uses invented names and the public NIP-19 example key.
- Every push runs a secret scan (gitleaks, CI step `secret-scan`). GitHub secret scanning with push protection is enabled. Optional local guard: `pre-commit install`.
- If a secret is committed anyway: rotate it first, then remove it from history.

## What it does

| Surface | Ids | Notes |
|---|---|---|
| Agent ops (read) | `teams_list`, `team_get`, `directory_get`, `resolve_sender` | MCP tools `fleet__<id>`; also companion targets for other apps (Rules' read model) |
| Person ops (owner UI) | `overview_get`, `team_set`, `team_delete`, `person_set`, `person_delete`, `members_set`, `agent_set`, `identities_view` | the app's own pages: Teams, People, Agents, Identities, Holds |
| Context hook | `fleet_facts` (order -100, every product) | adds `fleet.requester`, `fleet.requesterTeams` (from the `tb.onBehalfOf` claim), `fleet.agentOwner`, `fleet.agentTeams` |
| Agent directory | `needsAgentDirectory: true` | agents come from the instance slice; `events.agentsChanged` (full list on every change: add, re-add, rename, pause, removal) keeps `fleet_agents` in sync |

- **One handle format:** `"<channel>:<value>"` (`buzz:npub1…`, `slack:U…`, `telegram:123…`), equal to the
  `tb.onBehalfOf` `channel_sender` claim id, split by the shared `parseChannelSender` (`@opt2-tealbrick/manifest`).
  `buzz:<64-hex key>` is stored as its npub; a bare npub reads as `buzz:`.
- **Narrow, never widen:** a departed person resolves but has no teams; a removed agent has no facts; the requester
  carries the claim's `verified` flag.
- **Revision:** every change moves `revision`; `directory_get {sinceRevision}` answers `unchanged: true` when nothing moved.
- **Identities view (J3, owner only):** the channel identities Connect issued to each agent, read through Fleet's ONE
  companion grant (`connect.identities_list`, read). `identities_view` also returns people's handles; the page shows
  them on People, not here (C185). C88: only the person op `identities_view` uses it; no agent op or hook fact
  carries those identities.
- Harvested logic: v1 `labs/organization-plane` (person + membership subjects person|agent) and the v1 portal
  `Team` / `Membership` / `AgentGrant` / `ExternalIdentity` records, trimmed to one workspace = one tenant.

## Build

Built on `@opt2-tealbrick/miniapp-sdk` from `create-tealbrick-miniapp` 0.1.5 (CI template now ci-v9.2).

`tealbrick.manifest.json` is the only description of the app. The SDK derives the routes, input and output
validation, OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. You write handlers by
operation id (`src/app.ts`) and plain migrations (`migrations/`).

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | identity, runtime (data + backup volumes), operations, hook, agent directory, skills, backups, UI path |
| `src/app.ts` | `defineApp`: one typed handler per operation (op ids and I/O types from `#kit`), the hook, agent events |
| `src/store.ts` | the directory over the app's tables (plain functions over the SDK `Db`) |
| `src/facts.ts` | the `fleet_facts` context hook (pure function of the hook request and the DB) |
| `src/handles.ts` | the one handle parser (Buzz npub bech32, Slack, Telegram) |
| `src/main.ts` | `startApp(app, process.env)` |
| `src/ui/` | React UI (`<TbProvider>` + `<AppShell>` from `@opt2-tealbrick/ui`), built to `dist/ui` |
| `migrations/0001_init.sql` | baseline; forward-only, never edit a released file |
| `skills/use-fleet/SKILL.md` | the agent skill (frontmatter `name`, `description`) |
| `scripts/build-ui.ts` | UI build without a bundler (tsc output + vendored modules + import map) |
| `gen/` (not committed) | `tb-gen` output; `node --run kit` generates the kit and compiles it to `dist/kit` (`#kit` import) |
| `Dockerfile` | `node:24-slim` pinned by digest, pnpm build to `dist/`, non-root, `CMD ["node", "dist/main.js"]` |
| `.woodpecker/ci.yaml` | the opt2 CI template, byte-identical copy (do not edit) |
| `tealbrick-ci.json` | CI settings: kind `miniapp`, one image |

## Develop

```sh
pnpm install          # commit pnpm-lock.yaml: CI installs with --frozen-lockfile
# typecheck, test, conformance, build and start first run `tb-gen kit` (op ids + I/O types from the manifest)
pnpm typecheck && pnpm lint && pnpm test
pnpm build            # server to dist/, UI to dist/ui
pnpm conformance      # SDK conformance suite against this app
TB_STANDALONE=1 TB_DATA_DIR=.data pnpm start   # app-alone mode: person UI only, no agent calls
```

## Environment

The SDK reads only `TB_*` variables (SDK-API §13). The deploy recipe sets them: `TB_INSTANCE_ID`,
`TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`, `TB_DATA_DIR` (the `data` volume mount, `/data`)
and `TB_BACKUP_DIR` (`/data/backup`: one volume per service). Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`,
`TB_STANDALONE`. The listen port is the manifest `runtime.port`.

## Release

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` (for example `v0.1.0`) and push the tag.
3. CI builds and publishes the image, then writes the signed release record from the manifest.

Before the first push, check `publisher` and `source.repo` in the manifest. The repository name must match the
image name in `tealbrick-ci.json` (`opt2-tealbrick-fleet`).

## Dependency pins and caching
- `pnpm-lock.yaml` carries the sha512 integrity of every GitHub-release tarball (CI rule ci-v8). After changing an `@opt2-tealbrick/*` dependency run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to `dist/ui/index.html` + `dist/ui/assets-<content hash>/`; the SDK serves index.html `no-cache` and the hashed directory immutable, so a deploy is visible at once (C61).
