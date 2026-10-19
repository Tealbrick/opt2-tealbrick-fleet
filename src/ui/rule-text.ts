// The words of the contact-rule proposals in the owner's pages (L18): what each template does, and one plain sentence for
// every way sending can fail. Pure; shared by the review flow and the Contact rules page.

export type Template = "hold_outward_for_agent" | "deny_outward_for_agent" | "hold_on_behalf_of_sender" | "deny_on_behalf_of_sender";

export const TEMPLATE_INFO: Record<Template, { title: string; body: string }> = {
  hold_outward_for_agent: { title: "Hold its outward actions", body: "Every message, email or post this agent sends outside the workspace waits for your approval." },
  deny_outward_for_agent: { title: "Refuse its outward actions", body: "This agent may not send anything outside the workspace." },
  hold_on_behalf_of_sender: {
    title: "Hold what agents do for this sender",
    body: "When an agent acts for a message from this sender, the action waits for your approval. The sender is only a claim the agent passes on, so this can add a hold and never grants anything.",
  },
  deny_on_behalf_of_sender: {
    title: "Refuse what agents do for this sender",
    body: "When an agent acts for a message from this sender, the action is refused. The sender is only a claim the agent passes on, so this can add a refusal and never grants anything.",
  },
};

/** The templates that fit a subject: an agent gets the outward ones; a person or outside agent gets the sender ones (it needs a handle). */
export const templatesFor = (kind: "agent" | "person" | "outside_agent"): Template[] =>
  kind === "agent" ? ["hold_outward_for_agent", "deny_outward_for_agent"] : ["hold_on_behalf_of_sender", "deny_on_behalf_of_sender"];

export const NOTHING_APPLIES = "Nothing applies yet. This only sends a draft to Rules & Approvals. You approve or reject it there, under Drafts.";

const AGAIN = "Send it again; it will not make a second draft.";
const ERRORS: Record<string, string> = {
  no_grant: "This app has no access to Rules & Approvals. Deploy Rules in this workspace, then send it again.",
  companion_undeclared: "This app has no access to Rules & Approvals. Deploy Rules in this workspace, then send it again.",
  no_bridge: "Rules is not reachable: this app is not connected to the workspace bridge.",
  paused: "This app is paused, so nothing was sent.",
  too_many_drafts: "Rules already has too many drafts waiting. Approve or reject some in Rules, then send it again.",
  timeout: `Rules did not answer in time. ${AGAIN}`,
  network_error: `Rules could not be reached. ${AGAIN}`,
  transport_error: `Rules could not be reached. ${AGAIN}`,
  interrupted: `The send was interrupted before Rules answered. ${AGAIN}`,
  held: "Rules asked you to approve this call first. Approve it under Holds, then send it again.",
  bad_answer: "Rules gave an answer this app does not understand, so the rule counts as not sent.",
  input_invalid: "Rules did not accept this draft. Send it again: Governance makes a new draft from the directory as it is now.",
};
/** Plain sentence for the code a proposal failed with. */
export const proposalError = (code: string | null): string => (code && ERRORS[code]) || `Rules did not take the draft (${code ?? "no reason given"}). Nothing was sent.`;

export type RulesStatus = "pending" | "approved" | "rejected" | "gone" | "unknown";
export const RULES_STATUS: Record<RulesStatus, { tag: string; tone: "live" | "needs-you" | "default" | "open" }> = {
  pending: { tag: "Waiting for you in Rules", tone: "needs-you" },
  approved: { tag: "Approved in Rules", tone: "live" },
  rejected: { tag: "Rejected in Rules", tone: "default" },
  gone: { tag: "Rules no longer has this draft", tone: "default" },
  unknown: { tag: "Status not known: Rules did not answer", tone: "open" },
};
