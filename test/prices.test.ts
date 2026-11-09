// How a price record is built from the two sources. Each test names the
// mutation that should turn it red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTick, MIN_POOL_USD, type ExchangeQuote } from "../src/prices.ts";
import { firstEligible } from "../src/engine.ts";
import { priceFromSqrt, decodeAggregate3, type ChainRead } from "../src/onchain.ts";

const NOW = Date.UTC(2026, 10, 8, 18, 0, 0); // a Sunday
const NOW_S = NOW / 1000;
const FRI_CLOSE = Date.UTC(2026, 10, 6, 21, 0, 0) / 1000;
const x = (price: number, prev = price): ExchangeQuote => ({ price, t: FRI_CLOSE, prev, sessionStart: FRI_CLOSE - 23400, sessionEnd: FRI_CLOSE });
// A read from Base at block 100, timed now: { TICKER: price } or { TICKER: [price, poolUsd] }.
const chain = (pools: Record<string, number | [number, number]>, time = NOW_S): ChainRead => ({
  block: 100, time, rpc: "test",
  pools: Object.fromEntries(Object.entries(pools).map(([t, v]) => [t, { price: Array.isArray(v) ? v[0] : v, poolUsd: Array.isArray(v) ? v[1] : 500_000, pool: "0xpool" }])),
});

test("a 24/7 stock is priced from its token on Base, stamped now, so a weekend order on it can fill", () => {
  // Kill: price h24 stocks from the exchange, or stamp them with the exchange time.
  const { data } = buildTick({ AAPL: x(342.37, 344.17) }, chain({ AAPL: 343.11 }), null, NOW);
  assert.deepEqual(data.AAPL, [343.11, NOW_S, 342.37, "b", 342.37, 100]);
  const placed = NOW - 60_000;
  const hit = firstEligible({ id: 1, ticker: "AAPL", side: "buy", placed_at: placed }, [{ id: 7, recorded_at: NOW, data }]);
  assert.equal(hit?.quote[0], 343.11);
});

test("a market-hours stock never takes a Base price, even if one is offered", () => {
  // Kill: let any stock with a Base price use it.
  const { data } = buildTick({ PM: x(197.88, 196) }, chain({ PM: 2996.99 }), null, NOW);
  assert.deepEqual(data.PM, [197.88, FRI_CLOSE, 196, "x"]);
  // ...so a weekend order on it waits: the price is from before the order.
  const hit = firstEligible({ id: 2, ticker: "PM", side: "buy", placed_at: NOW - 60_000 }, [{ id: 8, recorded_at: NOW, data }]);
  assert.equal(hit, null);
});

test("a thin pool's price is held back, but if not stale yet, keeps last quote", () => {
  // Kill: drop the MIN_POOL_USD check.
  const recentTime = NOW_S - 1800; // 30 minutes ago, definitely not stale
  const last = { NVDA: [186.64, recentTime, 185, "b", 186.64, 99] as any };
  // A sensible price, so only the pool size can stop it. Last quote is recent (30 min ago).
  const { data, held } = buildTick({ NVDA: x(186.64) }, chain({ NVDA: [187, MIN_POOL_USD - 1] }), last, NOW);
  assert.deepEqual(data.NVDA, last.NVDA);
  assert.deepEqual(held, ["NVDA"]);
});

test("a Base price far from the stock's exchange price is held back", () => {
  // Kill: drop the MAX_GAP check.
  const recentTime = NOW_S - 1800;
  const last = { NVDA: [186.64, recentTime, 185, "b", 186.64, 98] as any };
  const { data, held } = buildTick({ NVDA: x(186.64) }, chain({ NVDA: 186.64 * 1.2 }), last, NOW);
  assert.deepEqual(data.NVDA, last.NVDA);
  assert.deepEqual(held, ["NVDA"]);
  const ok = buildTick({ NVDA: x(186.64) }, chain({ NVDA: 186.64 * 1.1 }), last, NOW);
  assert.equal(ok.data.NVDA[3], "b");
});

test("a stock with no price this time keeps its last quote, with its old time", () => {
  // Kill: drop the carry-over, or re-stamp carried quotes with the current time.
  const last = { MSFT: [530.61, NOW_S - 300, 529, "b", 530.61] as any, AMC: [3.14, FRI_CLOSE, 3.1, "x"] as any };
  const { data } = buildTick({}, null, last, NOW);
  assert.deepEqual(data.MSFT, last.MSFT);
  assert.deepEqual(data.AMC, last.AMC);
});

test("while the US market is open, a 24/7 stock's previous close is yesterday's, not the live price", () => {
  // Kill: always use the latest exchange price as the previous close.
  const open = Date.UTC(2026, 10, 9, 16, 0, 0);
  const q: ExchangeQuote = { price: 345, t: open / 1000 - 30, prev: 342.37, sessionStart: open / 1000 - 5400, sessionEnd: open / 1000 + 18000 };
  const { data } = buildTick({ AAPL: q }, chain({ AAPL: 345.2 }, open / 1000), null, open);
  assert.equal(data.AAPL[2], 342.37);
  assert.equal(data.AAPL[4], 345);
});

test("a pool's sqrtPriceX96 turns into dollars per token (USDC is token0, 6 vs 8 decimals)", () => {
  // Kill: invert the ratio, or swap the decimals.
  const raw = 100 / 342.37; // token raw units per USDC raw unit at $342.37
  const sqrt = BigInt(Math.round(Math.sqrt(raw) * 2 ** 96));
  assert.ok(Math.abs(priceFromSqrt(sqrt) - 342.37) < 1e-6);
});

test("Multicall3 answers decode into each call's success and bytes", () => {
  // Kill: read offsets from the wrong base, or ignore the success flag.
  const w = (n: number) => n.toString(16).padStart(64, "0");
  const hex = "0x" + w(0x20) + w(2) + w(0x40) + w(0xc0)
    + w(1) + w(0x40) + w(2) + "abcd".padEnd(64, "0")
    + w(0) + w(0x40) + w(0);
  assert.deepEqual(decodeAggregate3(hex), [{ ok: true, data: "abcd" }, { ok: false, data: "" }]);
});

test("a 24/7 stock with stale pool price falls back to exchange pricing", () => {
  // Kill: drop the stale check or the fallback to exchange pricing.
  const staleTime = NOW_S - 2 * 3601; // Just over 2 hours ago
  const last = { ARM: [185, staleTime, 174.62, "b", 174.62, 99] as any };
  const { data } = buildTick({ ARM: x(174.62) }, null, last, NOW);
  // Should fall back to exchange price (venue "x"), not keep the stale "b" price
  assert.equal(data.ARM[3], "x");
  assert.equal(data.ARM[0], 174.62);
  assert.equal(data.ARM[1], FRI_CLOSE);
});

test("a thin pool with stale last price falls back to exchange", () => {
  // Kill: don't apply fallback when pool fails checks if last price is stale.
  const staleTime = NOW_S - 2 * 3601;
  const last = { NVO: [40.5, staleTime, 40, "b", 40, 99] as any };
  const { data } = buildTick({ NVO: x(40.66) }, chain({ NVO: [41, MIN_POOL_USD - 1] }), last, NOW);
  // Pool failed, last is stale, should fall back to exchange
  assert.equal(data.NVO[3], "x");
  assert.equal(data.NVO[0], 40.66);
});
