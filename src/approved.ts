// Manual override list. Stables here are scanned even if they fail the market
// cap or pool gates, because YOU vouched for them and pinned the exact contract
// address. Pinning the address also removes any symbol-collision / scam risk:
// we quote that exact token, not "whatever LI.FI calls USDX on that chain".
//
// Edit approved-stables.json (see approved-stables.example.json). Override the
// path with APPROVED_STABLES=/path/to/file.

import { existsSync, readFileSync } from "node:fs";
import { CHAINS } from "./config.js";

export type ApprovedStable = {
  chainId: number;
  symbol: string;
  address: string;
  note?: string;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const scanChainIds = new Set(CHAINS.map((c) => c.id));

/**
 * Load and validate the user's approved-stables file. Returns [] if none.
 * Invalid entries are warned about and skipped, never trusted silently.
 */
export function loadApprovedStables(): ApprovedStable[] {
  const path = process.env.APPROVED_STABLES ?? "approved-stables.json";
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`  approved-stables: could not parse ${path}: ${e instanceof Error ? e.message : e}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error(`  approved-stables: ${path} must be a JSON array. Ignoring.`);
    return [];
  }

  const out: ApprovedStable[] = [];
  for (const [i, raw] of parsed.entries()) {
    const e = raw as Partial<ApprovedStable>;
    const where = `entry #${i}`;
    if (typeof e.chainId !== "number" || !scanChainIds.has(e.chainId)) {
      console.error(`  approved-stables: ${where} skipped — chainId ${e.chainId} is not a scanned chain (add it to CHAINS first).`);
      continue;
    }
    if (typeof e.symbol !== "string" || e.symbol.trim() === "") {
      console.error(`  approved-stables: ${where} skipped — missing symbol.`);
      continue;
    }
    if (typeof e.address !== "string" || !ADDRESS_RE.test(e.address)) {
      console.error(`  approved-stables: ${where} (${e.symbol}) skipped — address must be a 0x-prefixed 40-hex token address.`);
      continue;
    }
    out.push({
      chainId: e.chainId,
      symbol: e.symbol.trim().toUpperCase(),
      address: e.address,
      note: typeof e.note === "string" ? e.note : undefined,
    });
  }
  return out;
}
