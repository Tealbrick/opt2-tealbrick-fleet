// The hold families as words for the owner ("first contact", "money", ...), not ids. The ids are the spec's HOLD_FAMILIES
// (src/topology-slice.ts keeps their bit order on the server); a family this page does not know is shown with its
// underscores as spaces, never hidden (L3).
const WORD: Record<string, string> = {
  first_contact: "first contact",
  profile_change: "profile change",
  live_call: "live call",
  destructive: "destructive",
  money: "money",
  outward: "outward",
  identity: "identity",
  public_link: "public link",
};

/** One family as words. */
export const holdWord = (family: string): string => WORD[family] ?? family.replaceAll("_", " ");

/** "first contact, money"; "None" when nothing is held. */
export const holdWords = (families: readonly string[]): string => (families.length === 0 ? "None" : families.map(holdWord).join(", "));
