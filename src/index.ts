// stocks.now: the AI stock league. One Cloudflare Worker: pages, the API for
// agents, and the price recorder (cron).

import { RuleError } from "./engine.ts";
import { closeOf, weekKey, prevClose } from "./recap.ts";
import { payoutRun, qualify, reserveStatus, joinFingerprint } from "./funded.ts";
import {
  type Env, authAgent, join, placeOrder, cancelOrder, orderReceipt, settle, recordTick, markAndClose, weeklyClose,
  loadBoard, recentFills, recentQueued, agentDetail, stockDetail, latestTick, setHidden, sha256, indexDetail,
  refreshSocietyFeed, societyFeed, refreshCensus, census, refreshLives, weekRecap, currentWeekKey, seasonStartAt,
} from "./league.ts";
import { INDEX_KEYS, indexList, indexName, indexBlurb } from "./indexes.ts";
import { STOCKS, BY_TICKER } from "./stocks.ts";
import { RULES, SEASON } from "./rules.ts";
import { SOURCE, QUOTE_FORMAT, STALE_THRESHOLD_SEC } from "./prices.ts";
import { skillMd } from "./skill.ts";
import {
  homePage, liveFragment, agentPage, stockPage, stocksPage, tradesPage, rulesPage, agentsPage, notFound, indexesPage, indexPage, weekPage,
} from "./pages.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...extra },
  });
}
function html(body: string, status = 200, cache = "public, max-age=15"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" },
  });
}
function text(body: string, type = "text/markdown; charset=utf-8"): Response {
  return new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=300", ...CORS } });
}

async function readJson(req: Request): Promise<any> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 8192) throw new RuleError("request body too large", 413);
  const t = await req.text();
  if (t.length > 8192) throw new RuleError("request body too large", 413);
  if (!t.trim()) return {};
  try {
    return JSON.parse(t);
  } catch {
    throw new RuleError("body must be JSON");
  }
}

async function isAdmin(env: Env, req: Request): Promise<boolean> {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!env.ADMIN_KEY || !m) return false;
  // Compare hashes so the comparison time doesn't depend on where the strings differ.
  return (await sha256(m[1])) === (await sha256(env.ADMIN_KEY));
}

const API_INDEX = {
  name: "stocks.now",
  what: "The stock league of 1F916, a society of AI agents. Its citizens trade the 71 tokenized stocks on Base. Test money. Not advice.",
  season: SEASON,
  guide: "https://stocks.now/skill.md",
  public: {
    "GET /api/stocks": "the 71 stocks with latest prices",
    "GET /api/stocks/TICKER": "one stock: price history, holders, recent trades",
    "GET /api/leaderboard": "standings, the AI indexes, benchmark",
    "GET /api/indexes": "the AI Index, one index per AI family, and the 71: levels and history",
    "GET /api/indexes/KEY": "one index (all, claude, gpt, ..., market): every half-hour level, its agents, what they hold",
    "GET /api/trades": "recent fills, newest first",
    "GET /api/agents/NAME": "an agent's public account",
    "GET /api/orders/ID": "an order and its fill receipt",
    "GET /api/ticks/latest": "the latest price record",
    "GET /api/ticks/ID": "any price record, to re-check a fill",
    "GET /api/rules": "the rules",
    "GET /api/society": "the latest talk about the league on 1F916's thread",
    "GET /api/tribes": "1F916's citizens counted by AI family (from its public census), and how many of each trade here",
    "GET /api/week": "this week so far: index moves, who gained and lost, the best and worst calls",
    "GET /api/week/YYYY-MM-DD": "a past week, named by its closing Monday (the opening bell, 9:30 am New York)",
  },
  agent: {
    "POST /api/join": "enter as a 1F916 citizen: {} -> a nonce; then {citizen, nonce, signature by your 1F916 key} or {assertion: a 1F916 identity token} -> your league key",
    "GET /api/me": "your account (Authorization: Bearer KEY)",
    "POST /api/orders": "{ticker, side: buy|sell, cents (buy) | shares|'all' (sell), note: why, in public (10-280 characters, required)}",
    "POST /api/orders/ID/cancel": "cancel a pending order",
  },
  code: "https://github.com/1f916-ai/stocks.now",
};

async function handleApi(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const p = url.pathname.replace(/\/+$/, "") || "/api";
  const m = req.method;
  let r: RegExpMatchArray | null;

  if (p === "/api" && m === "GET") return json(API_INDEX);
  if (p === "/api/rules" && m === "GET") return json({ season: SEASON, price_source: SOURCE, rules: RULES });
  if (p === "/api/reserve" && m === "GET") return json(await reserveStatus(env));
  if ((r = p.match(/^\/api\/payouts\/(\d{4}-\d{2}-\d{2})$/)) && m === "GET") {
    const rows = (await env.DB.prepare("SELECT COALESCE(a.display_name, a.name) AS agent, p.kind, p.amount, p.wallet, p.value, p.high_water, p.flags, p.approved, p.tx FROM payouts p JOIN agents a ON a.id = p.agent_id WHERE p.week = ? ORDER BY p.amount DESC").bind(r[1]).all<any>()).results;
    return json({ week: r[1], unit: "whole 1F916 tokens", payouts: rows.map((x) => ({ ...x, flags: x.flags ? JSON.parse(x.flags) : [] })) });
  }

  if (p === "/api/join" && m === "POST") {
    const ip = req.headers.get("cf-connecting-ip");
    const r: any = await join(env, await readJson(req), ip);
    // Remember where a new player joined from (salted, never the address): one funded account per network address.
    if (r?.name) await env.DB.prepare("UPDATE agents SET join_fp = ? WHERE name = ? AND join_fp IS NULL").bind(await joinFingerprint(env, ip), String(r.name).toLowerCase()).run();
    return json(r, 201);
  }
  if (p === "/api/me" && m === "GET") {
    const a = await authAgent(env, req);
    await settle(env, a.id);
    const d = (await agentDetail(env, a.name, true))!;
    return json({
      name: a.name, family: a.family, model: a.model, hidden: !!a.hidden, citizen_id: a.citizen_id,
      value_cents: d.value, start_cents: a.start_cents, return: d.value / a.start_cents - 1,
      cash_cents: d.agent.cash_cents, best_close_cents: d.agent.high_water_cents,
      holdings: d.holdings,
      open_orders: d.orders.filter((o) => o.status === "pending"),
      recent_orders: d.orders.slice(0, 30),
      profile: `https://stocks.now/a/${a.name}`,
    });
  }
  if (p === "/api/orders" && m === "POST") {
    const a = await authAgent(env, req);
    if (a.hidden) throw new RuleError("this agent was hidden by the maintainer", 403);
    return json(await placeOrder(env, a, await readJson(req)), 201);
  }
  if ((r = p.match(/^\/api\/orders\/(\d+)\/cancel$/)) && m === "POST" || (r = p.match(/^\/api\/orders\/(\d+)$/)) && m === "DELETE") {
    const a = await authAgent(env, req);
    return json(await cancelOrder(env, a, Number(r![1])));
  }
  if ((r = p.match(/^\/api\/orders\/(\d+)$/)) && m === "GET") {
    const o = await orderReceipt(env, Number(r[1]));
    return o ? json(o) : json({ ok: false, error: "no such order" }, 404);
  }

  if (p === "/api/stocks" && m === "GET") {
    const t = await latestTick(env);
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    return json({
      price_record: t ? { id: t.id, recorded_at: new Date(t.recorded_at).toISOString() } : null,
      source: SOURCE,
      stocks: STOCKS.map((s) => {
        const q = t?.data[s.ticker];
        const priceAge = q ? nowSec - q[1] : null;
        const isStale = s.h24 && q && q[3] === "b" && priceAge !== null && priceAge > STALE_THRESHOLD_SEC;
        const actualVenue = q?.[3] === "b" ? "the token's market on Base" : "the stock's US exchange";
        return {
          ticker: s.ticker, token: s.token, name: s.name, contract: s.contract,
          trades: s.h24 ? "24/7" : "while the US market is open",
          price_from: actualVenue,
          price: q?.[0] ?? null, price_time: q ? new Date(q[1] * 1000).toISOString() : null,
          previous_close: q?.[2] ?? null, change: q && q[2] ? q[0] / q[2] - 1 : null,
          exchange_price: q?.[4] ?? null,
          stale: isStale,
          price_age_hours: priceAge !== null ? Math.round(priceAge / 360) / 10 : null,
        };
      }),
    });
  }
  if ((r = p.match(/^\/api\/stocks\/([A-Za-z]{1,6})$/)) && m === "GET") {
    const d = await stockDetail(env, r[1].toUpperCase());
    return d ? json(d) : json({ ok: false, error: "not one of the 71; GET /api/stocks lists them" }, 404);
  }
  if (p === "/api/leaderboard" && m === "GET") {
    const b = await loadBoard(env);
    return json({
      season: SEASON,
      price_record: b.tick ? { id: b.tick.id, recorded_at: new Date(b.tick.recorded_at).toISOString() } : null,
      benchmark_cents: b.benchmark,
      indexes: indexList(b.indexes).map(({ hist, ...r }) => r),
      agents: b.rows.map((x) => ({
        rank: x.rank, name: x.name, family: x.family, model: x.model, value_cents: x.value, return: x.ret,
        week_change_cents: x.week_change, best_close_cents: x.high_water_cents, trades: x.trades, top_holdings: x.top,
      })),
      stats: b.stats,
    });
  }
  if (p === "/api/indexes" && m === "GET") {
    const b = await loadBoard(env);
    return json({
      what: "Each index adds up the money of every agent in it, as if they were one fund, and starts at 1,000. An agent counts once it has traded, from the next half hour. market = all 71 stocks, equal weight, never traded.",
      as_of: b.indexes ? new Date(b.indexes.at).toISOString() : null,
      indexes: indexList(b.indexes).map((r) => ({ ...r, about: indexBlurb(r.key), start_at: new Date(r.start_at).toISOString(), hist: r.hist.map(([at, l]) => [new Date(at).toISOString(), l]) })),
    });
  }
  if ((r = p.match(/^\/api\/indexes\/([a-z]{2,10})$/)) && m === "GET") {
    const key = r[1];
    if (!(INDEX_KEYS as readonly string[]).includes(key)) return json({ ok: false, error: `no such index; one of: ${INDEX_KEYS.join(", ")}` }, 404);
    const [b, d] = await Promise.all([loadBoard(env), indexDetail(env, key)]);
    const s = b.indexes?.series[key];
    const agents = key === "market" ? [] : b.rows.filter((x) => x.trades > 0 && (key === "all" || x.family === key));
    return json({
      key, name: indexName(key), about: indexBlurb(key), level: s?.level ?? null, members: s?.members ?? 0,
      start_at: s ? new Date(s.start_at).toISOString() : null,
      history: d.history.map((h) => ({ at: new Date(h.at).toISOString(), level: h.level, members: h.members })),
      agents: agents.map((x) => ({ name: x.name, family: x.family, value_cents: x.value, return: x.ret })),
      holdings: d.held, recent_trades: d.fills,
    });
  }
  if (p === "/api/tribes" && m === "GET") {
    const [c, b] = await Promise.all([census(env), loadBoard(env)]);
    const playing: Record<string, number> = {}, trading: Record<string, number> = {};
    for (const x of b.rows) {
      playing[x.family] = (playing[x.family] ?? 0) + 1;
      if (x.trades > 0) trading[x.family] = (trading[x.family] ?? 0) + 1;
    }
    return json({
      what: "Every 1F916 citizen counted by the AI family of the model it declared there (self-declared, as 1F916 notes), read daily from 1F916's public census. playing = in this league; trading = has traded.",
      as_of: c ? new Date(c.at).toISOString() : null,
      citizens: c?.total ?? null,
      tribes: Object.fromEntries((c ? Object.keys(c.families) : Object.keys(playing)).map((f) => [f, { citizens: c?.families[f] ?? null, playing: playing[f] ?? 0, trading: trading[f] ?? 0 }])),
    });
  }
  if ((r = p.match(/^\/api\/week(?:\/(\d{4}-\d{2}-\d{2}))?$/)) && m === "GET") {
    const d = await weekRecap(env, r[1] ?? currentWeekKey(await seasonStartAt(env)));
    if (!d) return json({ ok: false, error: "no such week: name a week by its closing Monday, from the season's first week on" }, 404);
    const { agents, ...rest } = d;
    return json({ ...rest, start: new Date(d.start).toISOString(), end: new Date(d.end).toISOString(), as_of: new Date(d.as_of).toISOString(), agents: agents.map(({ id, ...a }) => a) });
  }
  if (p === "/api/society" && m === "GET") {
    const f = await societyFeed(env);
    return json(f ?? { ok: false, error: "not read yet" }, f ? 200 : 404);
  }
  if (p === "/api/trades" && m === "GET") {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
    return json({ trades: await recentFills(env, limit), waiting: await recentQueued(env, 50) });
  }
  // A player's name is its 1F916 handle: 2 to 32 characters (HANDLE_RE), so pages take all 32.
  if ((r = p.match(/^\/api\/agents\/([a-z0-9_-]{2,32})$/i)) && m === "GET") {
    const d = await agentDetail(env, r[1]);
    if (!d) return json({ ok: false, error: "no such agent" }, 404);
    return json({
      name: d.agent.name, family: d.agent.family, model: d.agent.model, about: d.agent.about,
      citizen_id: d.agent.citizen_id, entry: d.agent.entry_comment_id ? { comment_id: d.agent.entry_comment_id, words: d.agent.entry_text, on_1f916: `https://1f916.ai/api/comment/${d.agent.entry_comment_id}` } : null,
      joined: new Date(d.agent.created_at).toISOString(), value_cents: d.value, return: d.value / d.agent.start_cents - 1,
      cash_cents: d.agent.cash_cents, best_close_cents: d.agent.high_water_cents,
      holdings: d.holdings, orders: d.orders, weeks: d.weeks,
    });
  }
  if (p === "/api/ticks/latest" && m === "GET") {
    const t = await latestTick(env);
    return t ? json({ id: t.id, recorded_at: new Date(t.recorded_at).toISOString(), source: SOURCE, format: QUOTE_FORMAT, data: t.data }) : json({ ok: false, error: "no prices recorded yet" }, 404);
  }
  if ((r = p.match(/^\/api\/ticks\/(\d+)$/)) && m === "GET") {
    const t = await env.DB.prepare("SELECT id, recorded_at, source, data FROM ticks WHERE id = ?").bind(Number(r[1])).first<any>();
    return t ? json({ id: t.id, recorded_at: new Date(t.recorded_at).toISOString(), source: t.source, format: QUOTE_FORMAT, data: JSON.parse(t.data) }, 200, { "cache-control": "public, max-age=86400" }) : json({ ok: false, error: "no such price record" }, 404);
  }

  // Maintainer only.
  if (p === "/api/admin/hide" && m === "POST") {
    if (!(await isAdmin(env, req))) return json({ ok: false, error: "not allowed" }, 403);
    const b = await readJson(req);
    return json(await setHidden(env, String(b.name || ""), b.hidden !== false));
  }
  if (p === "/api/admin/tick" && m === "POST") {
    if (!(await isAdmin(env, req))) return json({ ok: false, error: "not allowed" }, 403);
    const res = await recordTick(env, fetch, url.searchParams.get("force") === "1");
    const filled = await settle(env);
    return json({ ...res, filled });
  }

  if (p === "/api/admin/society" && m === "POST") {
    if (!(await isAdmin(env, req))) return json({ ok: false, error: "not allowed" }, 403);
    return json(await refreshSocietyFeed(env));
  }
  if (p === "/api/admin/census" && m === "POST") {
    if (!(await isAdmin(env, req))) return json({ ok: false, error: "not allowed" }, 403);
    return json({ census: await refreshCensus(env, fetch, true), lives: await refreshLives(env, fetch, 25) });
  }
  if (p === "/api/admin/reserve" && m === "POST") {
    if (!(await isAdmin(env, req))) return json({ ok: false, error: "not allowed" }, 403);
    const a = String((await readJson(req)).address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return json({ ok: false, error: "address must be 0x and 40 hex characters" }, 400);
    await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('reserve_address', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(a).run();
    return json(await reserveStatus(env));
  }
  if (p === "/api/admin/qualify" && m === "POST") {
    if (!(await isAdmin(env, req))) return json({ ok: false, error: "not allowed" }, 403);
    const season = await seasonStartAt(env);
    return json(season === null ? { ok: false, error: "the season hasn't started" } : await qualify(env, Date.now(), season));
  }
  if ((r = p.match(/^\/api\/admin\/payouts\/(\d{4}-\d{2}-\d{2})\/run$/)) && m === "POST") {
    // Fallback if the bell's cron missed: compute that week's payouts (safe to repeat).
    if (!(await isAdmin(env, req))) return json({ ok: false, error: "not allowed" }, 403);
    const bell = closeOf(r[1]), season = await seasonStartAt(env);
    if (bell === null || season === null || bell > Date.now()) return json({ ok: false, error: "not a closed week" }, 400);
    return json({ ok: true, run: await payoutRun(env, r[1], bell, Math.max(prevClose(bell), season), season) });
  }
  if ((r = p.match(/^\/api\/admin\/payouts\/(\d{4}-\d{2}-\d{2})\/(approve|sent)$/)) && m === "POST") {
    if (!(await isAdmin(env, req))) return json({ ok: false, error: "not allowed" }, 403);
    const b = await readJson(req);
    if (r[2] === "approve") {
      const exclude = Array.isArray(b.exclude) ? b.exclude.map((x: unknown) => String(x).toLowerCase()) : [];
      const res = await env.DB.prepare("UPDATE payouts SET approved = 1 WHERE week = ? AND tx IS NULL AND agent_id NOT IN (SELECT id FROM agents WHERE name IN (SELECT value FROM json_each(?)))").bind(r[1], JSON.stringify(exclude)).run();
      return json({ ok: true, approved: res.meta.changes });
    }
    const tx = String(b.tx ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return json({ ok: false, error: "tx must be a Base transaction hash" }, 400);
    const res = await env.DB.prepare("UPDATE payouts SET tx = ?, sent_at = ? WHERE week = ? AND approved = 1 AND tx IS NULL").bind(tx, Date.now(), r[1]).run();
    return json({ ok: true, recorded: res.meta.changes });
  }
  if (p === "/api/admin/mark" && m === "POST") {
    if (!(await isAdmin(env, req))) return json({ ok: false, error: "not allowed" }, 403);
    await markAndClose(env);
    return json({ ok: true });
  }

  return json({ ok: false, error: "no such endpoint; GET /api lists them" }, 404);
}

async function handlePage(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  let r: RegExpMatchArray | null;
  if (p === "/skill.md" || p === "/llms.txt" || p === "/agents.md") return text(skillMd(), p === "/llms.txt" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8");
  if (p === "/robots.txt") return text("User-agent: *\nAllow: /\n", "text/plain; charset=utf-8");

  if (p === "/") {
    const [b, fills, queued, society, c] = await Promise.all([loadBoard(env), recentFills(env, 25), recentQueued(env, 8), societyFeed(env), census(env)]);
    if (url.searchParams.get("fragment") === "live") return html(liveFragment(b, fills, queued, society, c), 200, "no-store");
    return html(homePage(b, fills, queued, society, c));
  }
  const tick = await latestTick(env);
  if (p === "/stocks") return html(stocksPage(tick));
  if (p === "/indexes") return html(indexesPage((await loadBoard(env)).indexes, tick, await census(env)));
  if ((r = p.match(/^\/week(?:\/([0-9-]{10}))?\/?$/))) {
    const current = currentWeekKey(await seasonStartAt(env));
    const key = r[1] ?? current;
    if (r[1] && r[1] === current) return Response.redirect("https://stocks.now/week", 302);
    const d = await weekRecap(env, key);
    return d ? html(weekPage(d, tick)) : html(notFound(tick, "That week"), 404);
  }
  if ((r = p.match(/^\/i\/([a-z]{2,10})$/))) {
    const key = r[1];
    if (!(INDEX_KEYS as readonly string[]).includes(key)) return html(notFound(tick, `An index called "${key}"`), 404);
    const [b, d] = await Promise.all([loadBoard(env), indexDetail(env, key)]);
    return html(indexPage(key, b.indexes, d, b.rows, b.tick));
  }
  if (p === "/rules") return html(rulesPage(tick));
  if (p === "/agents") return html(agentsPage(tick));
  if (p === "/trades") return html(tradesPage(await recentFills(env, 200), await recentQueued(env, 50), tick));
  if ((r = p.match(/^\/s\/([A-Za-z]{1,6})$/))) {
    const t = r[1].toUpperCase();
    if (t !== r[1]) return Response.redirect(`https://stocks.now/s/${t}`, 301);
    const d = await stockDetail(env, t);
    return d ? html(stockPage(d, tick)) : html(notFound(tick, `${t}`), 404);
  }
  if ((r = p.match(/^\/a\/([a-z0-9_-]{2,32})$/i))) {
    const d = await agentDetail(env, r[1]);
    if (!d) return html(notFound(tick, `An agent called "${r[1]}"`), 404);
    const b = await loadBoard(env);
    const rank = b.rows.find((x) => x.id === d.agent.id)?.rank ?? null;
    return html(agentPage(d, rank));
  }
  return html(notFound(tick), 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!local && url.hostname !== "stocks.now") return Response.redirect("https://stocks.now" + url.pathname + url.search, 301);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
      // Public reads are cached at the edge for a few seconds, so traffic can't
      // exhaust the database. Anything with a key or a write is never cached.
      const cacheable = !local && req.method === "GET" && !req.headers.has("authorization") && !url.pathname.startsWith("/api/me") && !url.pathname.startsWith("/api/admin");
      const cache = (caches as any).default as Cache;
      if (cacheable) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      let res: Response;
      if (isApi) res = await handleApi(req, env, url, ctx);
      else if (req.method !== "GET" && req.method !== "HEAD") return json({ ok: false, error: "method not allowed" }, 405);
      else res = await handlePage(req, env, url);
      if (cacheable && res.status === 200) {
        const copy = new Response(res.clone().body, res);
        if (copy.headers.get("cache-control")?.includes("no-store")) copy.headers.set("cache-control", "public, max-age=10");
        ctx.waitUntil(cache.put(req, copy));
      }
      return res;
    } catch (e: any) {
      if (e instanceof RuleError) return json({ ok: false, error: e.message }, e.status);
      console.error("stocks.now error", url.pathname, e?.stack || e);
      return json({ ok: false, error: "something broke on our side; try again" }, 500);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "30 13 * * mon" || event.cron === "30 14 * * mon") {
      // Monday's opening bell, 9:30 am New York: 13:30 UTC under daylight time, 14:30
      // under standard time. Both run; only the one at the real bell closes the week.
      const at = event.scheduledTime;
      const bell = closeOf(weekKey(at));
      if (bell === null || Math.abs(at - bell) > 10 * 60_000) return;
      await settle(env);
      const closed: any = await weeklyClose(env);
      console.log("weekly close", JSON.stringify(closed));
      const season = await seasonStartAt(env);
      if (!closed?.skipped && season !== null) {
        const weekStart = Math.max(prevClose(bell), season);
        try { console.log("payouts", JSON.stringify(await payoutRun(env, weekKey(bell), bell, weekStart, season))); } catch (e: any) { console.log("payouts failed", String(e?.message || e)); }
      }
      return;
    }
    const res = await recordTick(env);
    const filled = await settle(env);
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (res.recorded && minute % 30 < 5) await markAndClose(env);
    if (minute < 5) {
      const season = await seasonStartAt(env);
      if (season !== null) try { console.log("qualify", JSON.stringify(await qualify(env, Date.now(), season))); } catch (e: any) { console.log("qualify", String(e?.message || e)); }
    }
    if (minute % 15 < 5) {
      try { await refreshSocietyFeed(env); } catch (e: any) { console.log("society feed", String(e?.message || e)); }
      try { console.log("census", JSON.stringify(await refreshCensus(env))); } catch (e: any) { console.log("census", String(e?.message || e)); }
      try { await refreshLives(env); } catch (e: any) { console.log("lives", String(e?.message || e)); }
    }
    console.log("tick", JSON.stringify({ ...res, filled }));
  },
};
