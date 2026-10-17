# Changelog

Versions follow `package.json` and `tealbrick.manifest.json` (product id `fleet`).

## 0.2.0 - Unreleased

Governance, sprint S1 "contract first" (decision C166; refs C230). The product id stays `fleet`.

### Changed
- Display name "Organization Plane" becomes "Governance": manifest name, summary, description and discovery text, skill title and text, UI header and page title, README and ARCHITECTURE.
- `resolve_sender` adds `contact` (`id`, `name`, `kind` = `person` | `outside_agent`, `status`, `trust`) next to the contact's `teams`. A departed or blocked contact has no teams. Outside agents resolve like people. The old `person` object stays exactly as 0.1.10 returned it (`id`, `name`, `status`), but only for kind person; it is `null` for outside agents, so a 0.1.10 client that reads `person.name` after `found: true` without a null check throws for an outside-agent sender (outside agents are new in 0.2.0; the test `a STRICT 0.1.10 client` shows it). `person` is deprecated since 0.2.0 (use `contact`; removed after 0.3.0), marked in the manifest description (no `deprecated` keyword is used).
- The `fleet_facts` context hook adds `fleet.requester.trust` (a trust state, or `null` when the requester is not in the directory) and puts `trust` inside `fleet.requester`. `fleet.requester.kind` can now be `outside_agent`. It also adds the flat `fleet.requester.verified` (the onBehalfOf `verified` flag; `false` without a requester). `fleet.requester.trust` of an unverified claim is for narrowing only. A departed contact now reports its trust value (it used to give no requester) and has no teams; a blocked requester has no team facts.
- Shared handle code: `normalizeHandle`, `isNpub`, `npubFromHex`, `handleChannel` come from `@opt2-tealbrick/manifest` 0.1.19; the local `src/handles.ts` is deleted.
- Dependencies: manifest 0.1.19, miniapp-sdk 0.1.25 (was 0.1.18 / 0.1.22); conformance 0.1.18 and ui 0.2.4 unchanged. Lockfile integrity re-pinned.

### Added
- Operation `directory_feed` (contract `fleet.directory_feed/1`, `v: 1`): team member ids and roles, contacts with kind, status, trust and canonical handles, agents with status, trust and owner id; `{v, revision, unchanged:true}` when `sinceRevision` equals the revision. The handler refuses every caller that is not an app (agents get `no_access`, HTTP 403). Handles that are not canonical are left out. No email, title, tag or review text. Rows the contract cannot carry (an agent id that is not `agt_` + 26 Crockford characters, an id over 64 characters, an off-pattern handle) are left out with one warning per id; a member or owner that names a left-out row is left out or set to null. Removed agents are listed only while a team still names them and do not count against the cap. A directory beyond the contract caps is refused with `feed_too_large` (503, transient), never cut.
- Migration 0002 (`migrations/0002_governance.sql`): `fleet_people.kind`, `.trust`, `.source`; `fleet_agents.trust`; table `fleet_review_policy` with `agent_days` 90 and `contact_days` 180. Existing rows become `trusted` (source `owner`). The migration also moves `revision` by one, so a reader with the old revision pulls the full feed. New-row rule in one function: `defaultTrust` (`src/trust.ts`): owner entries `trusted`, agent entries `unreviewed`.
- Contract files `test/contracts/fleet.directory_feed.1.schema.json` and `.json` (spec tag `spec-v0.1.42`, sha256 in `test/contracts/PROVENANCE.md`) and tests that validate every feed answer against them.

### Operations notes
- Rollback: a failed 0.2.0 update is rolled back by the SDK pre-update snapshot (E3). There is no down migration.
- After a restore the `revision` can be lower than a reader's copy. Readers re-pull the full feed after a restore.
- `resolve_sender` returns at most 50 teams (the first 50 by name, then id), as the manifest declares; before this fix a person in more than 50 teams made the answer invalid.

### Unchanged on purpose
- `directory_get`, `teams_list`, `team_get` keep their 0.1.x output, including email, title, tags and handles (Rules 0.2.x still reads `directory_get`). The lean versions are 0.2.1, after Rules 0.3.0.
- `person_set` and `overview_get` do not show or set `kind` or `trust` yet; trust changes only through reviews (0.2.1).
- No `contracts` field in the manifest (needs manifest 0.1.20 and a bridge that pins it) and no `app` audience (G-1).

### Not in this release
- Reviews, topology, contact rules and the Governance UI pages (sprints S2 to S4).
