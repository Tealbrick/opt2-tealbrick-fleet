---
name: use-fleet
description: How to read the workspace directory in Organization Plane (teams, people, agent owners, channel handles).
---
# Using Organization Plane

{{agent.name}}, Organization Plane is the workspace directory. It tells you who is on which team, who owns which agent, and which person is behind a channel handle. You can read it; only the owner changes it.

- Call `fleet__teams_list` to see the teams and their members (people and agents, each `member` or `lead`). Pass `tag` to see only teams with that tag. If `nextCursor` is not null, call again with `cursor` set to it.
- Call `fleet__team_get` with a team id or its exact name to see one team.
- Call `fleet__resolve_sender` with a `handle` to find out who sent a message and which teams that person is in. The handle format is `<channel>:<value>`: `buzz:npub1…`, `slack:U01ABC…`, `telegram:123456789`. `found: false` means the sender is not in the directory: treat them as an unknown person.
- Call `fleet__directory_get` for the whole directory. Pass `sinceRevision` with the last `revision` you saw; `unchanged: true` means nothing changed.
- A departed person is still found but has no teams. Do not give them team access.
- The directory is facts, not permissions. It does not let you do anything another app or the owner did not allow.
