// Channel handles: ONE format everywhere, "<channel>:<value>", equal to the `tb.onBehalfOf` channel_sender id
// (spec 0.1.13). Values follow what Connect reports as a message sender: Buzz = npub (bech32 of the Nostr public
// key), Slack = user id, Telegram = numeric user id. `normalizeHandle` is the only parser; it never throws.

export const CHANNELS = ["buzz", "slack", "telegram"] as const;
export type Channel = (typeof CHANNELS)[number];

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i] as number;
  }
  return chk >>> 0;
}

const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) return null;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & max);
  } else if (bits >= from || (acc << (to - bits)) & max) return null;
  return out;
}

/** 32-byte hex public key → npub. */
export function npubFromHex(hex: string): string {
  const bytes = [...Buffer.from(hex, "hex")];
  const data = convertBits(bytes, 8, 5, true) as number[];
  const values = [...hrpExpand("npub"), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `npub1${[...data, ...checksum].map((d) => BECH32[d]).join("")}`;
}

/** True for a well-formed npub with a valid bech32 checksum and a 32-byte payload. */
export function isNpub(s: string): boolean {
  if (!/^npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/.test(s)) return false;
  const data = [...s.slice(5)].map((c) => BECH32.indexOf(c));
  if (polymod([...hrpExpand("npub"), ...data]) !== 1) return false;
  return convertBits(data.slice(0, -6), 5, 8, false)?.length === 32;
}

function normalizeValue(channel: Channel, raw: string): string | null {
  const v = raw.trim();
  switch (channel) {
    case "buzz": {
      const s = v.toLowerCase().replace(/^nostr:/, "");
      if (/^[0-9a-f]{64}$/.test(s)) return npubFromHex(s);
      return isNpub(s) ? s : null;
    }
    case "slack": {
      const s = v.toUpperCase();
      return /^[UW][A-Z0-9]{2,30}$/.test(s) ? s : null;
    }
    case "telegram":
      return /^-?[1-9][0-9]{0,19}$/.test(v) ? v : null;
  }
}

/** "<channel>:<value>" (or a bare npub / nostr:npub) → canonical handle, or null when it is not a known handle. */
export function normalizeHandle(input: string): string | null {
  const s = input.trim();
  const i = s.indexOf(":");
  const head = i > 0 ? s.slice(0, i).toLowerCase() : "";
  if ((CHANNELS as readonly string[]).includes(head)) {
    const value = normalizeValue(head as Channel, s.slice(i + 1));
    return value ? `${head}:${value}` : null;
  }
  const bare = normalizeValue("buzz", s);
  return bare ? `buzz:${bare}` : null;
}

export function channelOf(handle: string): Channel {
  return handle.slice(0, handle.indexOf(":")) as Channel;
}
