// Instant fills: the price an order fills at the moment it arrives. Each test
// names the mutation that should turn it red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { instantQuote, MIN_POOL_USD, type ExchangeQuote } from "../src/prices.ts";
import { usMarketOpen, usSession, type Quote } from "../src/engine.ts";
import { marketStatus } from "../src/pages.ts";
import type { ChainRead } from "../src/onchain.ts";

const SUN = Date.UTC(2026, 10, 8, 23, 0, 0); // Sunday 6 pm New York
const SUN_S = SUN / 1000;
const FRI_CLOSE = Date.UTC(2026, 10, 6, 21, 0, 0) / 1000; // Friday 4 pm New York
const TUE_11 = Date.UTC(2026, 10, 10, 16, 0, 0); // Tuesday 11 am New York
const TUE_11_S = TUE_11 / 1000;

const chain = (ticker: string, price: number, poolUsd = 500_000): ChainRead => ({
  block: 4242, time: SUN_S - 2, rpc: "test", pools: { [ticker]: { price, poolUsd, pool: "0xpool" } },
});
// An exchange answer whose session ended Friday (off hours) or runs now (in session).
const closed = (price: number): ExchangeQuote => ({ price, t: FRI_CLOSE, prev: price, sessionStart: FRI_CLOSE - 23400, sessionEnd: FRI_CLOSE });
const inSession = (price: number): ExchangeQuote => ({ price, t: TUE_11_S - 30, prev: price, sessionStart: TUE_11_S - 5400, sessionEnd: TUE_11_S + 18000 });
// A last price record's quote for a 24/7 stock: [price, time, prev close, "b", exchange price, block].
const lastB = (price: number, exchange: number): Quote => [price, SUN_S - 300, exchange, "b", exchange, 4100];
const lastX = (price: number): Quote => [price, FRI_CLOSE, price, "x"];

test("a 24/7 order fills now at the pool's live price, stamped with its block", () => {
  // Kill: make instantQuote return null for 24/7 stocks, or price them from the last record.
  const q = instantQuote(true, "AAPL", chain("AAPL", 270.123456789), null, lastB(268, 269), SUN, false);
  assert.deepEqual(q, { price: 270.123457, time: SUN_S - 2, venue: "b", block: 4242, how: "pool" });
});

test("a thin pool can't fill an order; it waits", () => {
  // Kill: drop the MIN_POOL_USD check from instantQuote.
  assert.equal(instantQuote(true, "NIO", chain("NIO", 6.1, MIN_POOL_USD - 1), null, lastB(6, 6), SUN, false), null);
  assert.notEqual(instantQuote(true, "NIO", chain("NIO", 6.1, MIN_POOL_USD), null, lastB(6, 6), SUN, false), null);
});

test("a pool price more than 15% from the stock can't fill an order; it waits", () => {
  // Kill: drop the MAX_GAP check from instantQuote.
  assert.equal(instantQuote(true, "PM", chain("PM", 860), null, lastB(198, 198), SUN, false), null);
  assert.notEqual(instantQuote(true, "PM", chain("PM", 199), null, lastB(198, 198), SUN, false), null);
});

test("no Base read, or no exchange price to check it against, means wait", () => {
  // Kill: fill a 24/7 order without a reference price, or without a chain read.
  assert.equal(instantQuote(true, "AAPL", null, null, lastB(268, 269), SUN, false), null);
  assert.equal(instantQuote(true, "AAPL", chain("AAPL", 270), null, null, SUN, false), null);
});

test("a market-hours stock fills at its live exchange price in session", () => {
  // Kill: label an in-session fill as the close, or price market-hours stocks from Base.
  const q = instantQuote(false, "PFE", chain("PFE", 99), inSession(25.5), lastX(25), TUE_11, true);
  assert.deepEqual(q, { price: 25.5, time: TUE_11_S - 30, venue: "x", block: null, how: "exchange" });
});

test("while the market is shut, a market-hours stock fills now at its last close", () => {
  // Kill: make off-hours market-hours orders wait (return null when the session is over).
  const q = instantQuote(false, "RDDT", null, closed(201.4), lastX(201.4), SUN, false);
  assert.deepEqual(q, { price: 201.4, time: FRI_CLOSE, venue: "x", block: null, how: "close" });
});

test("market shut and the exchange silent: the last recorded close still fills it", () => {
  // Kill: drop the last-record fallback for a shut market.
  const q = instantQuote(false, "RDDT", null, null, lastX(201.4), SUN, false);
  assert.deepEqual(q, { price: 201.4, time: FRI_CLOSE, venue: "x", block: null, how: "close" });
});

test("market open and the exchange silent: the order waits rather than fill at an old price", () => {
  // Kill: drop the !marketOpen condition on the last-record fallback.
  assert.equal(instantQuote(false, "RDDT", null, null, lastX(201.4), TUE_11, true), null);
});

test("the US market clock: weekdays 9:30 to 4 pm New York, in winter and summer time", () => {
  // Kill: change 570 or 960, or the weekday range, in usMarketOpen.
  assert.equal(usMarketOpen(TUE_11), true);
  assert.equal(usMarketOpen(Date.UTC(2026, 10, 10, 14, 29)), false); // Tue 9:29 EST
  assert.equal(usMarketOpen(Date.UTC(2026, 10, 10, 14, 30)), true); // Tue 9:30 EST
  assert.equal(usMarketOpen(Date.UTC(2026, 10, 10, 20, 59)), true); // Tue 3:59 pm
  assert.equal(usMarketOpen(Date.UTC(2026, 10, 10, 21, 0)), false); // Tue 4:00 pm
  assert.equal(usMarketOpen(Date.UTC(2026, 10, 14, 16, 0)), false); // Saturday
  assert.equal(usMarketOpen(SUN), false); // Sunday evening
  assert.equal(usMarketOpen(Date.UTC(2026, 10, 8, 16, 0)), false); // Sunday 11 am: inside the hours, outside the week
  assert.equal(usMarketOpen(Date.UTC(2026, 6, 14, 13, 30)), true); // a July Tuesday, 9:30 EDT
});

test("market holidays: shut on Thanksgiving, open until 1 pm the day after", () => {
  // Kill: drop the US_HOLIDAYS check, or the US_EARLY_CLOSE close time, in usSession.
  assert.equal(usMarketOpen(Date.UTC(2026, 10, 26, 16, 0)), false, "Thanksgiving, 11 am");
  assert.equal(usMarketOpen(Date.UTC(2026, 10, 27, 17, 59)), true, "Friday after, 12:59 pm");
  assert.equal(usMarketOpen(Date.UTC(2026, 10, 27, 18, 0)), false, "Friday after, 1:00 pm");
  assert.equal(usSession("2026-12-25"), null);
  assert.deepEqual(usSession("2026-12-23"), { open: 570, close: 960 });
});

test("the site says when the market next opens, skipping the holiday", () => {
  // Kill: ignore holidays when looking for the next open in marketStatus.
  const tick = { id: 1, recorded_at: Date.UTC(2026, 10, 25, 22, 0), data: {} };
  const wedEvening = Date.UTC(2026, 10, 25, 22, 1); // Wed Nov 25, 5:01 pm
  assert.equal(marketStatus(tick, wedEvening).opens, "Fri 9:30 ET");
  const friMorning = { ...tick, recorded_at: Date.UTC(2026, 10, 27, 15, 0) };
  const ms = marketStatus(friMorning, Date.UTC(2026, 10, 27, 15, 1));
  assert.equal(ms.open, true);
  assert.equal(ms.closesAt, "1 pm ET", "the early close");
});

test("a 24/7 order with stale pool price falls back to exchange pricing", () => {
  // Kill: drop the stale check or fallback in instantQuote for 24/7 stocks.
  const staleTime = SUN_S - 2 * 3601; // Over 2 hours ago
  const lastStale = [185, staleTime, 174.62, "b", 174.62, 99] as Quote;
  // Pool unavailable, last price stale, exchange has close price
  const q = instantQuote(true, "ARM", null, closed(174.62), lastStale, SUN, false);
  assert.notEqual(q, null);
  assert.equal(q?.venue, "x");
  assert.equal(q?.how, "close");
  assert.equal(q?.price, 174.62);
});

test("a 24/7 order whose pool fails checks falls back to exchange during market hours", () => {
  // Kill: don't fall back when pool fails for 24/7 stocks.
  const q = instantQuote(true, "SAP", chain("SAP", 230, MIN_POOL_USD - 1), inSession(227.35), lastB(227, 227), TUE_11, true);
  assert.notEqual(q, null);
  assert.equal(q?.venue, "x");
  assert.equal(q?.how, "exchange");
  assert.equal(q?.price, 227.35);
});
