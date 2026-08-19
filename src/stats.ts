import { CONTRACT, SEL_MINT_STATS } from "./config.js";

export interface MintStats {
  minted: bigint;
  cap: bigint;
  price: bigint;
  maxPerWallet: bigint;
  sold: bigint;
  wallets: bigint;
  active: bigint;
  raised: bigint;
}

/**
 * The eth_call param object for mintStats(), built once at module load.
 * Never rebuild this per poll.
 */
export const STATS_CALL = Object.freeze({ to: CONTRACT, data: SEL_MINT_STATS });

/** Pre-serialised request body for the poll. Reused verbatim every tick. */
export const STATS_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "eth_call",
  params: [STATS_CALL, "latest"],
});

const FIELDS = [
  "minted",
  "cap",
  "price",
  "maxPerWallet",
  "sold",
  "wallets",
  "active",
  "raised",
] as const;

/**
 * mintStats() returns 8 ABI words. Word n starts at hex-string offset
 * 2 + 64n and is 64 chars long.
 */
export function decodeStats(hex: string): MintStats {
  if (typeof hex !== "string" || !hex.startsWith("0x")) {
    throw new Error(`mintStats: expected 0x-prefixed hex, got ${JSON.stringify(hex)?.slice(0, 80)}`);
  }
  const body = hex.slice(2);
  if (body.length < 64 * 8) {
    throw new Error(`mintStats: short return, ${body.length} hex chars (need ${64 * 8})`);
  }
  const out = {} as Record<(typeof FIELDS)[number], bigint>;
  for (let i = 0; i < FIELDS.length; i++) {
    const word = body.slice(i * 64, i * 64 + 64);
    out[FIELDS[i]!] = BigInt("0x" + word);
  }
  return out as unknown as MintStats;
}

export function fmtStats(s: MintStats): string {
  return (
    `minted=${s.minted} cap=${s.cap} price=${s.price} maxPerWallet=${s.maxPerWallet} ` +
    `sold=${s.sold} wallets=${s.wallets} active=${s.active} raised=${s.raised}`
  );
}

export function remaining(s: MintStats): bigint {
  return s.cap - s.minted;
}
