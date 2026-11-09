// Price recording. Every 5 minutes, day and night, we read two kinds of price
// and save them as one record (a "tick"):
//
// - Base: the token's own price in its trading pool on Base, for the stocks
//   whose token has a real pool there (h24 in stocks.ts). These trade 24/7,
//   like the tokens themselves. Read straight from the chain (onchain.ts), so
//   each one names the block it came from and anyone can re-check it.
// - Exchange: the stock's regular-market price on its US exchange, for the
//   rest. These only move while the US market is open. Read from Yahoo Finance.
//
// Each stock always uses the same kind of price, so nobody can trade the jump
// between the two.

import { STOCKS } from "./stocks.ts";
import type { Quote, TickData } from "./engine.ts";
import { readPools, type ChainRead } from "./onchain.ts";

export const SOURCE = "base: pool price on Base (Aerodrome Slipstream slot0, read through Multicall3 at the block in each quote) · exchange: Yahoo Finance regularMarketPrice";
export const QUOTE_FORMAT = "TICKER: [price, price_time_unix_seconds, previous_close, venue (b = token's pool on Base, x = US exchange), exchange_price, base_block]";
const UA = "Mozilla/5.0 (compatible; stocks-now-league/1.0; +https://stocks.now)";

/** A token's pool must hold at least this much (in dollars) for its price to count. */
export const MIN_POOL_USD = 25_000;
/** A Base price more than this far from the stock's last exchange price is held back. */
export const MAX_GAP = 0.15;
/** A 24/7 stock's pool price older than this (in seconds) is considered stale and falls back to exchange pricing. */
export const STALE_THRESHOLD_SEC = 2 * 3600; // 2 hours

export interface ExchangeQuote { price: number; t: number; prev: number | null; sessionStart: number | null; sessionEnd: number | null }

/** Yahoo Finance: regular-market price of every stock, 20 per request. */
export async function fetchExchange(fetcher: typeof fetch = fetch, only?: string[]): Promise<Record<string, ExchangeQuote>> {
  const tickers = only ?? STOCKS.map((s) => s.ticker);
  const chunks: string[][] = [];
  for (let i = 0; i < tickers.length; i += 20) chunks.push(tickers.slice(i, i + 20));
  const out: Record<string, ExchangeQuote> = {};
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${chunk.join(",")}&range=1d&interval=1d`;
      const r = await fetcher(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      const j = (await r.json()) as any;
      for (const res of j?.spark?.result ?? []) {
        const m = res?.response?.[0]?.meta;
        const price = Number(m?.regularMarketPrice);
        const t = Number(m?.regularMarketTime);
        const prev = Number(m?.chartPreviousClose ?? m?.previousClose);
        const reg = m?.currentTradingPeriod?.regular;
        if (res?.symbol && price > 0 && t > 0) {
          out[res.symbol] = { price, t, prev: prev > 0 ? prev : null, sessionStart: Number(reg?.start) || null, sessionEnd: Number(reg?.end) || null };
        }
      }
    } catch { /* that chunk's stocks keep their last price */ }
  }));
  return out;
}

/** Pool prices on Base for the 24/7 stocks (or just `only`), or null if no RPC answered (they keep their last price). */
export async function fetchBase(fetcher: typeof fetch = fetch, only?: string[]): Promise<ChainRead | null> {
  try {
    return await readPools(fetcher, only);
  } catch {
    return null;
  }
}

/** The close an exchange price is compared against: yesterday's while the market is open, today's after. */
function lastClose(x: ExchangeQuote, nowSec: number): number | null {
  const inSession = x.sessionStart !== null && x.sessionEnd !== null && nowSec >= x.sessionStart && nowSec < x.sessionEnd;
  return inSession ? x.prev : x.price;
}

/**
 * Build one price record from what was read. Pure: no network, so it can be tested.
 * A stock that got no usable price this time keeps its last quote, with its old
 * price time, so orders on it keep waiting instead of filling at a stale price.
 * 
 * NEW: 24/7 stocks with stale pool prices (older than STALE_THRESHOLD_SEC) fall back
 * to exchange pricing: the live price during market hours, the last close otherwise.
 */
export function buildTick(
  exchange: Record<string, ExchangeQuote>,
  base: ChainRead | null,
  last: TickData | null,
  nowMs: number,
): { data: TickData; held: string[] } {
  const nowSec = Math.floor(nowMs / 1000);
  const data: TickData = {};
  const held: string[] = [];
  for (const s of STOCKS) {
    const x = exchange[s.ticker];
    const prevQ = last?.[s.ticker];
    let q: Quote | null = null;
    if (s.h24) {
      const b = base?.pools[s.ticker];
      // Compare against the exchange: live while the market is open, else its last close.
      const ref = x?.price ?? (prevQ?.[4] ?? null);
      const close = x ? lastClose(x, nowSec) : (prevQ?.[2] ?? null);
      const prevPoolStale = prevQ && prevQ[3] === "b" && (nowSec - prevQ[1]) > STALE_THRESHOLD_SEC;
      
      if (b && base && b.poolUsd >= MIN_POOL_USD && ref && Math.abs(b.price / ref - 1) <= MAX_GAP) {
        // Fresh pool price passes checks
        q = [round6(b.price), base.time, close, "b", ref, base.block];
      } else if (b && !prevPoolStale) {
        // Pool failed checks, but last price not stale yet - hold it (keep waiting)
        held.push(s.ticker);
      }
      
      // Fallback: if last price is stale (or pool failed and we have no recent quote), use exchange pricing
      if (!q && prevPoolStale && x) {
        q = [x.price, x.t, x.prev, "x"];
      }
    } else if (x) {
      q = [x.price, x.t, x.prev, "x"];
    }
    if (q) data[s.ticker] = q;
    else if (prevQ) data[s.ticker] = prevQ;
  }
  return { data, held };
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** True when at least one stock has a newer price time than in the last record. */
export function hasNewPrices(next: TickData, last: TickData | null): boolean {
  if (!last) return Object.keys(next).length > 0;
  for (const [t, q] of Object.entries(next)) {
    const p = last[t];
    if (!p || q[1] > p[1]) return true;
  }
  return false;
}

/** The price an order fills at the moment it arrives, and where it came from. */
export interface LiveQuote {
  price: number;
  time: number; // the price's own time, seconds
  venue: "b" | "x";
  block: number | null;
  how: "pool" | "exchange" | "close"; // Base pool now / the exchange in session / the last close
}

/**
 * Instant fills. Pure, so it can be tested. An order fills when it arrives, at:
 * - a 24/7 stock: its token's price in its pool on Base, read just now, if the pool
 *   passes the same checks as a price record (MIN_POOL_USD, within MAX_GAP of the
 *   stock's exchange price); if the pool fails checks or the last recorded price is
 *   stale (older than STALE_THRESHOLD_SEC), falls back to exchange pricing.
 * - a market-hours stock: its exchange price read just now, which is the live price
 *   in session and the last close after it; if the exchange didn't answer, the last
 *   recorded price, but only while the market is shut (then it is the close).
 * null means there is no fair price right now: the order waits for the next price record.
 */
export function instantQuote(
  h24: boolean,
  ticker: string,
  base: ChainRead | null,
  x: ExchangeQuote | null,
  last: Quote | null,
  nowMs: number,
  marketOpen: boolean,
): LiveQuote | null {
  const nowSec = Math.floor(nowMs / 1000);
  
  if (h24) {
    const b = base?.pools[ticker];
    const ref = x?.price ?? last?.[4] ?? null;
    const lastPoolStale = last && last[3] === "b" && (nowSec - last[1]) > STALE_THRESHOLD_SEC;
    
    // Try pool price first
    if (base && b && b.price > 0 && b.poolUsd >= MIN_POOL_USD && ref && Math.abs(b.price / ref - 1) <= MAX_GAP) {
      return { price: round6(b.price), time: base.time, venue: "b", block: base.block, how: "pool" };
    }
    
    // Fallback to exchange pricing if pool failed or last price is stale
    if ((b || lastPoolStale) && x && x.price > 0) {
      const live = x.sessionStart !== null && x.sessionEnd !== null && nowSec >= x.sessionStart && nowSec < x.sessionEnd;
      return { price: x.price, time: x.t, venue: "x", block: null, how: live ? "exchange" : "close" };
    }
    
    // No fallback available, wait
    return null;
  }
  
  // Market-hours stocks
  if (x && x.price > 0) {
    const live = x.sessionStart !== null && x.sessionEnd !== null && nowSec >= x.sessionStart && nowSec < x.sessionEnd;
    return { price: x.price, time: x.t, venue: "x", block: null, how: live ? "exchange" : "close" };
  }
  if (!marketOpen && last && last[0] > 0) return { price: last[0], time: last[1], venue: "x", block: null, how: "close" };
  return null;
}
