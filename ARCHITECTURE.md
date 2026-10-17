# Governance (Tealbrick mini app, product id `fleet`): architecture

State: verified against the repo on 2026-10-17. Claims cite paths in this repo. Anything not verified is marked UNVERIFIED. For the whole system see `engineering/ARCHITECTURE.md` and `engineering/SYSTEM-OVERVIEW.md` in the private repo `Tealbrick/opt2-tealbrick-docs`.

## Common app pattern (verified for all seven apps)

- **Runtime**: Node 24, TypeScript run through `tsc` to `dist/`, UI built by `scripts/build-ui.ts` (no bundler; content-hashed `assets-<hash>/`). The app is started by `startApp` from `@opt2-tealbrick/miniapp-sdk` (`src/main.ts`).
- **Dockerfile**: two stages on `node:24-slim` pinned by digest, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build && pnpm prune --prod`, the manifest also copied to `/opt/tb/tealbrick.manifest.json` (the `tb-exec` default), `USER node`, no `VOLUME`. The SDK drops root to uid 1000 itself when the platform starts the container as root (Railway volumes are root-owned).
- **Data**: one SQLite file `TB_DATA_DIR/app.db` owned by the SDK. App tables use their own prefix; SDK tables use `tb_*`. On Railway there is ONE volume per service: the backup directory is `<data mount>/backup`, so the volume size is data plus backup (C28).
- **Migrations**: `migrations/NNNN_name.sql` (or `.ts` exporting `up(db)`). The SDK enforces forward-only: gap-free from 0001, one transaction each, sha256 recorded in `tb_migrations`. A changed, missing, misnamed or `down` migration stops the app with `migration_invalid`.
- **Backups and restore**: SDK cron runner writes `tb-backup-<UTC>.tar.gz`; export `tealbrick.export/1` never carries the instance key, KEK, keys, secrets or sessions. Restore at next boot with `TB_RESTORE_FROM`.
- **Authorization**: the bridge gates (`gate()`); the SDK decides (`authorize()`): run, hold or refuse. Holds and receipts live in the app's own `tb_receipts` table. Raw call input is never stored, only a digest.
- **Manifest** `tealbrick.manifest.json` is the only source for operations, scopes, settings, hooks, companions, skills, runtime hints, backups and UI paths. Schema `tealbrick.miniapp/2`, `sdkMajor 1`, `source.license Apache-2.0`. Agent ops become MCP tools `<product>__<op>`. Person ops are owner UI only.
- **Generated**: `gen/` (openapi, kit, docs, railway) is produced by `tb-gen` and is not committed. The typed client kit is built into `dist/kit` and imported as `#kit` in apps that have one.
- **Standard UI pages** (from the kit `AppShell`): Holds, Receipts, Agents and scopes, Keys (where the app has keys), Backups and export.
- **Licence files**: `LICENSE` (Apache-2.0), `NOTICE`, `THIRD_PARTY_NOTICES.md`. The brand mark and app art are Tealbrick artwork and are not Apache-licensed.
- **Private by design**: no public address. Only the bridge is public.

## Governance: what it does

Governance (0.2.0; formerly Organization Plane) is the workspace directory and its trust record. Rules reads the directory from here: `directory_get` today, and the versioned feed `directory_feed` (contract `fleet.directory_feed/1`, apps only) from Rules 0.3.0. A context hook adds facts about the requester (with its trust) and the agent owner to every call. Handle format is `<channel>:<value>` (`buzz:npub1...`, `slack:U...`, `telegram:123...`), canonicalized by `normalizeHandle` from `@opt2-tealbrick/manifest` (no local parser). Design: `coordination/leads/fleet/DESIGN.md` (private).

## Operations (from `tealbrick.manifest.json`)

13 operations.
- Agent read: `teams_list`, `team_get`, `directory_get` (the whole directory; `sinceRevision` returns `unchanged:true`), `resolve_sender` (channel handle to contact, trust and teams; the 0.1.10 `person` field is kept but deprecated, null for outside agents).
- App read: `directory_feed` (audience `agent` in the manifest for now; the handler refuses every caller that is not an app with `no_access` 403; sinceRevision gives `{v, revision, unchanged:true}`).
- Person read: `overview_get`, `identities_view`. Person write: `team_set`, `person_set`, `members_set`, `agent_set`. Person destructive (held): `team_delete`, `person_delete`.
- **Privacy:** the agent-audience op `directory_get` still returns people records including `email` (kept unchanged in 0.2.0; lean in 0.2.1). `teams_list`, `team_get`, `resolve_sender` and `directory_feed` do not.

## Scopes, hooks and companions

- **Scopes:** None. `needsAgentDirectory: true`; `events.agentsChanged` keeps `fleet_agents` in sync.
- **Hooks:** `fleet_facts`, phase `context`, order -100, match all products, timeout 1000 ms. Adds `fleet.requester` (with `trust`), `fleet.requester.trust`, `fleet.requesterTeams` (from the bridge-copied, unverified `tb.onBehalfOf` claim; narrow only), `fleet.agentOwner`, `fleet.agentTeams` (at most 50).
- **Companion grants it asks for:** `connect.identities_list` (read), used only by the person op `identities_view`. It is never exposed to agents or hooks (C88). Missing Connect gives an `unavailable` note, not an error.

## Settings, keys and environment

None. No keys and no environment variables.

## Data

- **Stored:** Migration 0002 adds `kind` (`person` | `outside_agent`), `trust` and `source` (`owner` | `agent`) to `fleet_people`, `trust` to `fleet_agents`, and `fleet_review_policy` (`agent_days` 90, `contact_days` 180). Existing rows become `trusted` / `owner`; the column defaults are the fail-closed values (`unreviewed`, `agent`). Migration 0001: `fleet_teams`, `fleet_people` (name, email, title, status, tags), `fleet_handles`, `fleet_agents` (owner, role, tags, status), `fleet_members`, `fleet_meta` (revision counter bumped on every change). Channel identities from Connect are read live and not stored.
- **Never stored:** Connect identities.

## External calls and background work

- **External:** None.
- **Background:** None.

## Person UI

Teams, People, Agents, Identities, Holds (`src/ui/App.tsx`, a single 636 line file). `ui.configurePath` is `/` here and `/configure` in the other apps.

## Requirements and runtime hints

Connect is optional (Identities page only). Rules reads a versioned directory feed; release order on qa1 matters (Rules first).

Port 8080. 0.25 cpu, 256 MB. Data 1 GB plus backup 2 GB. Backup cron `30 2 * * *`, retain 7. Publisher name "Teal Brick opt2" (inconsistent; fix).

## Pinned packages

miniapp-sdk 0.1.25, manifest 0.1.19, conformance 0.1.18, ui 0.2.4.

All `@opt2-tealbrick/*` pins use dist-host tarball URLs. Upgrade safety (SDK 0.1.25: pre-update snapshot, migration lock, failed mode) is in this app since 0.2.0, which migrates with migration 0002.

## Known gaps

- Governance is built in sprints (DESIGN §8). 0.2.0 (S1) has the name, trust state, the feed for apps and `resolve_sender` with trust. Reviews, topology and contact rules (0.2.1 to 0.2.3) are not built; there is no UI for trust yet.
- Agent-readable emails: `directory_get` still returns them in 0.2.0; the lean version is 0.2.1, after Rules reads the feed.
- The manifest has no `app` audience yet (G-1) and no `contracts` field (needs manifest 0.1.20 and a bridge that pins it): `directory_feed` is an agent-audience op whose handler refuses agents.
