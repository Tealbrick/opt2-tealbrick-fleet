---
name: use-fleet
description: How to read the workspace directory in Governance (teams, people, outside agents, agent owners, trust, channel handles).
---
# Using Governance

{{agent.name}}, Governance is the workspace directory and its trust record. It tells you who is on which team, who owns which agent, which person or outside agent is behind a channel handle, and how far that contact is trusted. You can read it; only the owner changes it.

- Call `fleet__teams_list` to see the teams and their members (people and agents, each `member` or `lead`). Pass `tag` to see only teams with that tag. If `nextCursor` is not null, call again with `cursor` set to it.
- Call `fleet__team_get` with a team id or its exact name to see one team.
- Call `fleet__resolve_sender` with a `handle` to find out who sent a message. The answer has a `contact` (`id`, `name`, `kind` = `person` or `outside_agent`, `status`, `trust`) and the contact's `teams`. The handle format is `<channel>:<value>`: `buzz:npub1…`, `slack:U01ABC…`, `telegram:123456789`. `found: false` means the sender is not in the directory: treat them as an unknown sender. The old `person` field still exists but is deprecated (use `contact`); it is `null` for outside agents.
- `trust` is `unreviewed`, `trusted`, `limited` or `blocked`. The owner sets it. Only the owner can raise it; you cannot. Be careful with `unreviewed` and `limited` contacts. Do not act for a `blocked` contact.
- Call `fleet__directory_get` for the whole directory (names, titles, trust, teams and owners; no email, handles or tags). Pass `sinceRevision` with the last `revision` you saw; `unchanged: true` means nothing changed.
- If you deal with an agent, a person or an outside agent you do not know or do not trust, call `fleet__review_request` with the `subject` (`kind` and `id`, or a `handle`) and `why`. The owner decides; you cannot change trust. A handle that is not in the directory does not become an entry: your request waits for the owner, who may add it. What you write in `why` is stored as untrusted text (control characters are removed) and the owner reads it as your claim. Asking again about the same subject returns your own open request (`duplicate: true`). You may have 20 open requests. Do not ask about yourself: the answer is `no_self_request`. Only the owner changes a person's or an agent's state; you can only ask.
- A departed or blocked contact is still found but has no teams. Do not give them team access.
- Do not call `fleet__directory_feed`. It is a feed for the reader apps Rules & Approvals and Knowledge only. It refuses agents with `no_access`.
- The directory and the trust state are facts, not permissions. They do not let you do anything another app or the owner did not allow.
