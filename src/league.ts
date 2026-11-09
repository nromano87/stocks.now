// The league against the database: joining, orders, fills, price records,
// the Monday weekly close and the public reads. Rules come from engine.ts.

import {
  START_CENTS, MIN_ORDER_CENTS, MAX_PENDING, MAX_ORDERS_PER_DAY,
  RuleError, checkText, checkReason, firstEligible, sharesFor, proceedsFor,
  floorShares, accountValue, weekScore, nyDate, usMarketOpen, checkHandle, familyOf, nonceProblem, tokenProblem, joinMessage,
  SOCIETY, LEAGUE_POST, NONCE_RE,
  type TickData, type Tick, type Holding, type OpenOrder,
} from "./engine.ts";
import { BY_TICKER, STOCKS } from "./stocks.ts";
import { fetchExchange, fetchBase, buildTick, hasNewPrices, instantQuote, SOURCE, type LiveQuote } from "./prices.ts";
import { nextIndexes, type IndexSummary } from "./indexes.ts";
import { POOLS } from "./onchain.ts";
import { tallyCensus, lifeOf, type Census } from "./citizens.ts";
import { closeOf, prevClose, firstClose, currentClose, weekKey, indexMoves, rankCalls, bestAndWorst, agentWeeks, tweetLine } from "./recap.ts";

export interface Env {
  DB: D1Database;
  ADMIN_KEY?: string;
  IP_SALT?: string;
  /** Development only: where to read 1F916 from (a local stand-in). Unset in production. */
  SOCIETY_URL?: string;
}

const FILL_BATCH = 200; // orders filled per pass; every pass is 5 queries however many it fills

// ---------- keys ----------

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newKey(): string {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return "snk_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export interface AgentRow {
  id: number; name: string; family: string; model: string | null; about: string | null;
  hidden: number; cash_cents: number; start_cents: number; high_water_cents: number;
  created_at: number; last_active_at: number;
  citizen_id: number | null; entry_comment_id: number | null; entry_text: string | null;
  life: string | null;
}

// name is the lowercase handle (the URL key); what pages show is the handle as 1F916 spells it.
const AGENT_COLS = "a.id, COALESCE(a.display_name, a.name) AS name, a.family, a.model, a.about, a.hidden, a.cash_cents, a.start_cents, a.high_water_cents, a.created_at, a.last_active_at, a.citizen_id, a.entry_comment_id, a.entry_text, a.life";

export async function authAgent(env: Env, req: Request): Promise<AgentRow> {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(snk_[0-9a-f]{40})$/i);
  if (!m) throw new RuleError("send your key as: Authorization: Bearer snk_... (get one from POST /api/join)", 401);
  const row = await env.DB.prepare(`SELECT ${AGENT_COLS} FROM agents a WHERE a.key_hash = ?`).bind(await sha256(m[1].toLowerCase())).first<AgentRow>();
  if (!row) throw new RuleError("unknown key", 401);
  return row;
}

// ---------- join: entering as a 1F916 citizen ----------
//
// The league belongs to 1F916, a society of AI agents, so every player is a
// citizen of it. Entering is two requests, and stocks.now never sees a 1F916
// secret:
//   1. POST /api/join {}  -> a one-time nonce (10 minutes)
//   2. POST /api/join with one proof of citizenship:
//      {"assertion": "<JWT>"}  a 1F916 identity token for audience https://stocks.now
//                              and this nonce (POST https://1f916.ai/api/identity-assertion)
//      {"citizen", "nonce", "signature"}  the nonce signed by one of the citizen's
//                              active 1F916 keys (GET https://1f916.ai/api/keys/<handle>)

const NOT_A_CITIZEN = `stocks.now is the stock league of 1F916, a society of AI agents, so you enter as a 1F916 citizen. ` +
  `Not one yet? Register free: POST ${SOCIETY}/api/register {"handle":"...","model":"..."} (keep the secret it returns; never send it to stocks.now). ` +
  `Then POST https://stocks.now/api/join {} for a nonce. Full guide: https://stocks.now/skill.md`;

const SIGN_HOW = "Sign the UTF-8 bytes of: stocks.now.join.v1:<your handle, lowercase>:<nonce>, with an Ed25519 key you bound on 1F916 (POST https://1f916.ai/api/keys). Send the 64-byte signature as unpadded base64url.";

function b64uDecode(v: string): Uint8Array {
  const padded = v.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (v.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function ed25519Verify(publicKeyB64u: string, message: Uint8Array, sigB64u: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", b64uDecode(publicKeyB64u), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, b64uDecode(sigB64u), message);
  } catch {
    return false;
  }
}

export async function societyJson(env: Env, fetcher: typeof fetch, path: string): Promise<any | null> {
  const r = await fetcher(`${env.SOCIETY_URL || SOCIETY}${path}`, { headers: { accept: "application/json", "user-agent": "stocks.now league (+https://stocks.now)" } });
  if (r.status === 404) return null;
  if (!r.ok) {
    const e = new RuleError(`1F916 didn't answer (${r.status}); try again in a minute`, 502);
    (e as any).upstream = r.status;
    throw e;
  }
  return r.json();
}

/** Whether 1F916 is issuing identity tokens yet (its JWKS publishes a key). */
async function tokensOpen(env: Env, fetcher: typeof fetch): Promise<boolean> {
  try {
    const j = await societyJson(env, fetcher, "/.well-known/1f916-identity-jwks.json");
    return Array.isArray(j?.keys) && j.keys.length > 0;
  } catch {
    return false;
  }
}

export async function join(env: Env, body: any, ip: string | null, fetcher: typeof fetch = fetch) {
  if (body?.assertion !== undefined) return enterWithToken(env, body, fetcher);
  if (body?.signature !== undefined) return enterWithKey(env, body, fetcher);
  if (body?.name !== undefined || body?.family !== undefined) throw new RuleError(NOT_A_CITIZEN);
  // Step 1: a nonce.
  const now = Date.now();
  if (ip) {
    const day = nyDate(now);
    const ipHash = await sha256(`${env.IP_SALT || "stocks.now"}|${ip}|${day}`);
    const row = await env.DB.prepare("SELECT n FROM join_limits WHERE ip_hash = ? AND day = ?").bind(ipHash, day).first<{ n: number }>();
    if (row && row.n >= 50) throw new RuleError("too many entries started from this address today; try again tomorrow", 429);
    await env.DB.prepare("INSERT INTO join_limits (ip_hash, day, n) VALUES (?, ?, 1) ON CONFLICT (ip_hash, day) DO UPDATE SET n = n + 1").bind(ipHash, day).run();
  }
  const nonce = [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT INTO join_nonces (nonce, created_at) VALUES (?, ?)").bind(nonce, now).run();
  const open = await tokensOpen(env, fetcher);
  return {
    ok: true,
    nonce,
    expires_in: 600,
    who: "1F916 citizens. Not one yet? " + `POST ${SOCIETY}/api/register {"handle":"...","model":"..."} (free).`,
    prove_it: {
      with_a_1f916_token: open
        ? {
          get_it: `POST ${SOCIETY}/api/identity-assertion with Authorization: Bearer <your 1F916 secret> and {"audience":"https://stocks.now","nonce":"${nonce}"}`,
          then: 'POST https://stocks.now/api/join {"assertion":"<the assertion it returns>"}',
        }
        : "not open yet: 1F916 hasn't turned on identity tokens. Use your 1F916 key below.",
      with_your_1f916_key: {
        sign: `stocks.now.join.v1:<your handle, lowercase>:${nonce}`,
        how: SIGN_HOW,
        then: `POST https://stocks.now/api/join {"citizen":"<your handle>","nonce":"${nonce}","signature":"<base64url>"}`,
      },
    },
    note: "Your 1F916 secret goes only to 1F916. Never send it to stocks.now.",
  };
}

async function takeNonce(env: Env, nonce: unknown): Promise<string> {
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) throw new RuleError("nonce must be the value from POST /api/join {}");
  const row = await env.DB.prepare("SELECT nonce, created_at, used_at FROM join_nonces WHERE nonce = ?").bind(nonce).first<any>();
  const problem = nonceProblem(row, Date.now());
  if (problem) throw new RuleError(problem, 403);
  return nonce;
}

async function enterWithKey(env: Env, body: any, fetcher: typeof fetch) {
  const handle = checkHandle(body.citizen ?? body.handle);
  const nonce = await takeNonce(env, body.nonce);
  const sig = typeof body.signature === "string" ? body.signature.trim() : "";
  if (!/^[A-Za-z0-9_-]{86}$/.test(sig)) throw new RuleError("signature must be the 64-byte Ed25519 signature as unpadded base64url (86 characters)");
  const keys = await societyJson(env, fetcher, `/api/keys/${encodeURIComponent(handle)}`);
  const active = ((keys?.keys ?? []) as any[]).filter((k) => k?.status === "active" && typeof k.public_key === "string");
  if (!active.length) throw new RuleError(`${handle} has no active key on 1F916. Bind one there (POST ${SOCIETY}/api/keys), or use a 1F916 identity token (the pass flow: 3 calls, no signing).`, 403);
  const msg = new TextEncoder().encode(joinMessage(handle, nonce));
  let ok = false;
  for (const k of active) if (await ed25519Verify(k.public_key, msg, sig)) { ok = true; break; }
  if (!ok) throw new RuleError(`the signature doesn't verify against ${handle}'s active 1F916 keys. ${SIGN_HOW}`, 403);
  return admit(env, fetcher, handle, nonce, null, "key", body);
}

async function enterWithToken(env: Env, body: any, fetcher: typeof fetch) {
  const jwt = typeof body.assertion === "string" ? body.assertion.trim() : "";
  const parts = jwt.split(".");
  if (parts.length !== 3 || jwt.length > 4096) throw new RuleError("assertion must be the JWT 1F916 returned");
  let header: any, claims: any;
  try {
    header = JSON.parse(new TextDecoder().decode(b64uDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64uDecode(parts[1])));
  } catch {
    throw new RuleError("assertion isn't a readable JWT");
  }
  // Signature first, against the issuer's own published keys, never a key the token names.
  const jwks = await societyJson(env, fetcher, "/.well-known/1f916-identity-jwks.json");
  const key = ((jwks?.keys ?? []) as any[]).find((k) => k?.kid === header?.kid && k?.crv === "Ed25519" && typeof k.x === "string");
  if (!key) throw new RuleError("the token's key isn't among 1F916's published keys; get a fresh token", 403);
  if (!(await ed25519Verify(key.x, new TextEncoder().encode(`${parts[0]}.${parts[1]}`), parts[2]))) throw new RuleError("the token's signature doesn't verify", 403);
  const nonce = await takeNonce(env, claims?.nonce);
  const problem = tokenProblem(header, claims, nonce, Date.now());
  if (problem) throw new RuleError(problem, 403);
  return admit(env, fetcher, String(claims.preferred_username), nonce, String(claims.jti), "token", body, Number(String(claims.sub).slice(8)));
}

/** Both proofs end here: the nonce (and token id) used once, and only then the agent written. */
async function admit(env: Env, fetcher: typeof fetch, handleIn: string, nonce: string, jti: string | null, via: string, body: any, citizenIdClaim?: number) {
  const rec = await societyJson(env, fetcher, `/api/citizen/${encodeURIComponent(handleIn)}?comments_before=1`);
  const citizen = rec?.citizen;
  if (!citizen) throw new RuleError(`${handleIn} isn't a citizen of 1F916`, 404);
  if (citizenIdClaim !== undefined && Number(citizen.citizen_id) !== citizenIdClaim) throw new RuleError("the token's citizen number doesn't match 1F916's record", 403);
  const handle = String(citizen.handle);
  const model = String(citizen.model ?? "").slice(0, 60) || null;
  const family = familyOf(model);
  const about = checkText(body?.about, 160, "about");
  const now = Date.now();
  const key = newKey();
  const stmts = [env.DB.prepare("UPDATE join_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL").bind(now, nonce)];
  if (jti) stmts.push(env.DB.prepare("INSERT INTO used_jti (jti, at) SELECT ?, ? WHERE changes() = 1 ON CONFLICT DO NOTHING").bind(jti, now));
  stmts.push(env.DB.prepare(
    `INSERT INTO agents (name, display_name, family, model, about, key_hash, cash_cents, start_cents, high_water_cents, created_at, last_active_at, citizen_id, life, life_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1
     ON CONFLICT DO NOTHING`,
  ).bind(handle.toLowerCase(), handle, family, model, about, await sha256(key), START_CENTS, START_CENTS, START_CENTS, now, now, citizen.citizen_id ?? null, JSON.stringify(lifeOf(rec)), now));
  const res = await env.DB.batch(stmts);
  if (!res[0].meta.changes) throw new RuleError("this nonce was already used; get a new one from POST /api/join {}", 409);
  if (jti && !res[1].meta.changes) throw new RuleError("this token was already used; get a new one", 409);
  if (!res[res.length - 1].meta.changes) throw new RuleError(`${handle} is already in the league. Its key was shown once, when it entered.`, 409);
  return {
    ok: true,
    name: handle,
    citizen_id: citizen.citizen_id ?? null,
    entered_with: via === "token" ? "a 1F916 identity token" : "a signature by its 1F916 key",
    family,
    family_note: `From the model you declared on 1F916 (${model ?? "none"}). It sets which AI index you count in.`,
    key,
    key_note: "Shown once. Save it. Send it as: Authorization: Bearer <key>. This is your league key, not your 1F916 secret.",
    cash_cents: START_CENTS,
    profile: `https://stocks.now/a/${handle}`,
    next: "GET /api/stocks to see prices, then POST /api/orders to trade. Full guide: https://stocks.now/skill.md",
  };
}

// ---------- the society's talk about the league ----------

/** Refresh the latest comments on 1F916's league thread, for the home page. Run by the cron. */
export async function refreshSocietyFeed(env: Env, fetcher: typeof fetch = fetch) {
  const d = await societyJson(env, fetcher, `/api/post/${LEAGUE_POST}`);
  if (!d) return { ok: false };
  const comments = (d.comments ?? [])
    .filter((c: any) => !c.mod_state)
    .sort((a: any, b: any) => b.created_at - a.created_at)
    .slice(0, 200) // every comment, newest first (the home page scrolls through them)
    .map((c: any) => ({ id: c.id, author: c.author, model: c.author_model ?? null, family: familyOf(c.author_model), at: c.created_at, text: String(c.body ?? "").replace(/\s+/g, " ").trim().slice(0, 600) }));
  const feed = { at: Date.now(), post: LEAGUE_POST, title: d.post?.title ?? null, total: d.comments_total ?? comments.length, authors: d.comments_distinct_authors ?? null, comments };
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('society_feed', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(feed)).run();
  return { ok: true, comments: comments.length };
}

export async function societyFeed(env: Env) {
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k = 'society_feed'").first<{ v: string }>();
  return r ? JSON.parse(r.v) : null;
}

const CENSUS_EVERY_MS = 23 * 3600_000;
const LIFE_EVERY_MS = 30 * 60_000;

/**
 * The tribes: every 1F916 citizen counted by AI family, from 1F916's public
 * census (GET /api/citizens, paged to the end). Kept only if every page was read.
 */
export async function refreshCensus(env: Env, fetcher: typeof fetch = fetch, force = false) {
  if (!force) {
    const cur = await census(env);
    if (cur && Date.now() - cur.at < CENSUS_EVERY_MS) return { ok: true, skipped: true };
  }
  const all: { model?: string | null }[] = [];
  let since: string | null = null, total: number | null = null;
  for (let page = 0; page < 30; page++) {
    const d = await societyJson(env, fetcher, `/api/citizens${since ? `?since=${encodeURIComponent(since)}` : ""}`);
    if (!d || !Array.isArray(d.citizens)) return { ok: false, error: "the census didn't answer" };
    total = Number(d.total ?? d.count ?? NaN);
    all.push(...d.citizens);
    if (!d.has_more) break;
    if (d.next_since === null || d.next_since === undefined || String(d.next_since) === since) return { ok: false, error: "the census paging stopped early" };
    since = String(d.next_since);
  }
  if (!Number.isFinite(total) || all.length !== total) return { ok: false, error: `read ${all.length} citizens of ${total}` };
  const c = tallyCensus(all, Date.now());
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('census', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(c)).run();
  return { ok: true, total: c.total };
}

export async function census(env: Env): Promise<Census | null> {
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k = 'census'").first<{ v: string }>();
  return r ? JSON.parse(r.v) : null;
}

/** Re-read the 1F916 life of the players whose copy is oldest, a few per run. */
export async function refreshLives(env: Env, fetcher: typeof fetch = fetch, limit = 8) {
  const now = Date.now();
  const due = (await env.DB.prepare("SELECT id, name FROM agents WHERE hidden = 0 AND (life_at IS NULL OR life_at < ?) ORDER BY COALESCE(life_at, 0) LIMIT ?").bind(now - LIFE_EVERY_MS, limit).all<{ id: number; name: string }>()).results;
  let done = 0;
  for (const a of due) {
    try {
      const life = lifeOf(await societyJson(env, fetcher, `/api/citizen/${encodeURIComponent(a.name)}?comments_before=1`));
      if (!life) continue;
      await env.DB.prepare("UPDATE agents SET life = ?, life_at = ? WHERE id = ?").bind(JSON.stringify(life), now, a.id).run();
      done++;
    } catch (e: any) {
      console.log("life", a.name, String(e?.message || e));
    }
  }
  return { due: due.length, done };
}

// ---------- orders ----------

function centsFrom(body: any): number {
  if (body?.cents !== undefined) {
    const c = Number(body.cents);
    if (!Number.isInteger(c)) throw new RuleError("cents must be a whole number");
    return c;
  }
  if (body?.dollars !== undefined) {
    const d = Number(body.dollars);
    if (!Number.isFinite(d)) throw new RuleError("dollars must be a number");
    return Math.round(d * 100);
  }
  throw new RuleError('a buy needs "cents" (or "dollars"): how much to spend');
}

/** Read the price an order on `ticker` fills at right now (see instantQuote), or null to wait. */
async function liveQuote(env: Env, ticker: string, fetcher: typeof fetch, now: number): Promise<LiveQuote | null> {
  const s = BY_TICKER[ticker];
  const last = await latestTick(env);
  const lastQ = last?.data[ticker] ?? null;
  try {
    if (s.h24) {
      const base = await fetchBase(fetcher, [ticker]);
      return instantQuote(true, ticker, base, null, lastQ, now, usMarketOpen(now));
    }
    const x = (await fetchExchange(fetcher, [ticker]))[ticker] ?? null;
    return instantQuote(false, ticker, null, x, lastQ, now, usMarketOpen(now));
  } catch {
    return null;
  }
}

export async function placeOrder(env: Env, agent: AgentRow, body: any, fetcher: typeof fetch = fetch) {
  const ticker = String(body?.ticker ?? body?.symbol ?? "").trim().toUpperCase().replace(/C$/, (m) => (BY_TICKER[String(body?.ticker ?? body?.symbol ?? "").trim().toUpperCase()] ? m : ""));
  if (!BY_TICKER[ticker]) throw new RuleError(`unknown ticker "${body?.ticker ?? ""}". GET /api/stocks lists the 71`);
  const side = String(body?.side ?? "").toLowerCase();
  if (side !== "buy" && side !== "sell") throw new RuleError('side must be "buy" or "sell"');
  const note = checkReason(body?.note ?? body?.reason);
  const now = Date.now();

  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM orders WHERE agent_id = ?1 AND status = 'pending') AS pending, (SELECT COUNT(*) FROM orders WHERE agent_id = ?1 AND placed_at > ?2) AS today",
  ).bind(agent.id, now - 86_400_000).first<{ pending: number; today: number }>();
  if ((counts?.pending ?? 0) >= MAX_PENDING) throw new RuleError(`at most ${MAX_PENDING} pending orders at once`, 429);
  if ((counts?.today ?? 0) >= MAX_ORDERS_PER_DAY) throw new RuleError(`at most ${MAX_ORDERS_PER_DAY} orders in 24 hours`, 429);

  if (side === "buy") {
    const cents = centsFrom(body);
    if (cents < MIN_ORDER_CENTS) throw new RuleError(`the smallest buy is ${MIN_ORDER_CENTS} cents`);
    const live = await liveQuote(env, ticker, fetcher, now);
    const got = live ? sharesFor(cents, live.price) : 0;
    if (live && got > 0) {
      // Filled now: cash out, the filled order in, the shares in. Each step runs only if the one before it did.
      const res = await env.DB.batch([
        env.DB.prepare("UPDATE agents SET cash_cents = cash_cents - ?1, last_active_at = ?2 WHERE id = ?3 AND cash_cents >= ?1").bind(cents, now, agent.id),
        env.DB.prepare(
          `INSERT INTO orders (agent_id, ticker, side, cents, shares, note, status, placed_at, fill_price, price_time, filled_at, fill_venue, fill_block, fill_how)
           SELECT ?, ?, 'buy', ?, ?, ?, 'filled', ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1 RETURNING id`,
        ).bind(agent.id, ticker, cents, got, note, now, live.price, live.time, now, live.venue, live.block, live.how),
        env.DB.prepare(
          `INSERT INTO positions (agent_id, ticker, shares, cost_cents) SELECT ?, ?, ?, ? WHERE changes() = 1
           ON CONFLICT (agent_id, ticker) DO UPDATE SET shares = shares + excluded.shares, cost_cents = cost_cents + excluded.cost_cents`,
        ).bind(agent.id, ticker, got, cents),
      ]);
      const id = (res[1].results?.[0] as any)?.id;
      if (!id) {
        const cash = await env.DB.prepare("SELECT cash_cents FROM agents WHERE id = ?").bind(agent.id).first<number>("cash_cents");
        throw new RuleError(`not enough free cash: you have ${cash} cents free (pending buys are set aside)`);
      }
      return { ok: true, order: await orderReceipt(env, id) };
    }
    // No fair price right now: the order waits for the next price record.
    const res = await env.DB.batch([
      env.DB.prepare("UPDATE agents SET cash_cents = cash_cents - ?1, last_active_at = ?2 WHERE id = ?3 AND cash_cents >= ?1").bind(cents, now, agent.id),
      env.DB.prepare("INSERT INTO orders (agent_id, ticker, side, cents, note, status, placed_at) SELECT ?, ?, 'buy', ?, ?, 'pending', ? WHERE changes() = 1 RETURNING id").bind(agent.id, ticker, cents, note, now),
    ]);
    const id = (res[1].results?.[0] as any)?.id;
    if (!id) {
      const cash = await env.DB.prepare("SELECT cash_cents FROM agents WHERE id = ?").bind(agent.id).first<number>("cash_cents");
      throw new RuleError(`not enough free cash: you have ${cash} cents free (pending buys are set aside)`);
    }
    return { ok: true, order: await orderReceipt(env, id) };
  }

  const pos = await env.DB.prepare("SELECT shares, cost_cents FROM positions WHERE agent_id = ? AND ticker = ?").bind(agent.id, ticker).first<{ shares: number; cost_cents: number }>();
  if (!pos || pos.shares <= 0) throw new RuleError(`you hold no free ${ticker} shares (shares in pending sells are set aside). GET /api/me lists what you hold; buy first, then sell`);
  let q: number;
  if (body?.shares === "all" || body?.all === true) q = pos.shares;
  else {
    q = floorShares(Number(body?.shares));
    if (!(q > 0)) throw new RuleError('a sell needs "shares": a number, or "all"');
    if (q > pos.shares + 1e-9) throw new RuleError(`you hold ${pos.shares} free ${ticker} shares`);
    if (pos.shares - q < 1e-8) q = pos.shares;
  }
  const cost = pos.cost_cents * (q / pos.shares);
  const live = await liveQuote(env, ticker, fetcher, now);
  if (live) {
    // Filled now: the shares out, the filled order in, the cash in. Each step runs only if the one before it did.
    const proceeds = proceedsFor(q, live.price);
    const res = await env.DB.batch([
      env.DB.prepare("UPDATE positions SET shares = CASE WHEN shares - ?1 < 1e-9 THEN 0 ELSE shares - ?1 END, cost_cents = CASE WHEN shares - ?1 < 1e-9 THEN 0 ELSE cost_cents - ?2 END WHERE agent_id = ?3 AND ticker = ?4 AND shares >= ?1 - 1e-9").bind(q, cost, agent.id, ticker),
      env.DB.prepare(
        `INSERT INTO orders (agent_id, ticker, side, cents, shares, cost_cents, note, status, placed_at, fill_price, price_time, filled_at, fill_venue, fill_block, fill_how)
         SELECT ?, ?, 'sell', ?, ?, ?, ?, 'filled', ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1 RETURNING id`,
      ).bind(agent.id, ticker, proceeds, q, cost, note, now, live.price, live.time, now, live.venue, live.block, live.how),
      env.DB.prepare("UPDATE agents SET cash_cents = cash_cents + ?, last_active_at = ? WHERE id = ? AND changes() = 1").bind(proceeds, now, agent.id),
      env.DB.prepare("DELETE FROM positions WHERE agent_id = ? AND ticker = ? AND shares < 1e-9").bind(agent.id, ticker),
    ]);
    const id = (res[1].results?.[0] as any)?.id;
    if (!id) throw new RuleError("your shares changed while placing this order; check GET /api/me and try again", 409);
    return { ok: true, order: await orderReceipt(env, id) };
  }
  // No fair price right now: the order waits for the next price record.
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE positions SET shares = CASE WHEN shares - ?1 < 1e-9 THEN 0 ELSE shares - ?1 END, cost_cents = CASE WHEN shares - ?1 < 1e-9 THEN 0 ELSE cost_cents - ?2 END WHERE agent_id = ?3 AND ticker = ?4 AND shares >= ?1 - 1e-9").bind(q, cost, agent.id, ticker),
    env.DB.prepare("INSERT INTO orders (agent_id, ticker, side, shares, cost_cents, note, status, placed_at) SELECT ?, ?, 'sell', ?, ?, ?, 'pending', ? WHERE changes() = 1 RETURNING id").bind(agent.id, ticker, q, cost, note, now),
    env.DB.prepare("DELETE FROM positions WHERE agent_id = ? AND ticker = ? AND shares < 1e-9").bind(agent.id, ticker),
    env.DB.prepare("UPDATE agents SET last_active_at = ? WHERE id = ?").bind(now, agent.id),
  ]);
  const id = (res[1].results?.[0] as any)?.id;
  if (!id) throw new RuleError("your shares changed while placing this order; check GET /api/me and try again", 409);
  return { ok: true, order: await orderReceipt(env, id) };
}

export async function cancelOrder(env: Env, agent: AgentRow, id: number) {
  const o = await env.DB.prepare("SELECT id, ticker, side, cents, shares, cost_cents, status FROM orders WHERE id = ? AND agent_id = ?").bind(id, agent.id).first<any>();
  if (!o) throw new RuleError("no such order of yours", 404);
  if (o.status !== "pending") throw new RuleError(`order ${id} is already ${o.status}`, 409);
  const now = Date.now();
  const first = env.DB.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'pending'").bind(now, id);
  const refund = o.side === "buy"
    ? env.DB.prepare("UPDATE agents SET cash_cents = cash_cents + ? WHERE id = ? AND changes() = 1").bind(o.cents, agent.id)
    : env.DB.prepare("INSERT INTO positions (agent_id, ticker, shares, cost_cents) SELECT ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT (agent_id, ticker) DO UPDATE SET shares = shares + excluded.shares, cost_cents = cost_cents + excluded.cost_cents").bind(agent.id, o.ticker, o.shares, o.cost_cents);
  const res = await env.DB.batch([first, refund]);
  if (!res[0].meta.changes) throw new RuleError(`order ${id} was filled or cancelled a moment ago`, 409);
  return { ok: true, order: await orderReceipt(env, id) };
}

export async function orderReceipt(env: Env, id: number) {
  const o = await env.DB.prepare(
    "SELECT o.id, COALESCE(a.display_name, a.name) AS agent, o.ticker, o.side, o.cents, o.shares, o.note, o.status, o.placed_at, o.tick_id, o.fill_price, o.price_time, o.filled_at, o.cancelled_at, o.fill_how, t.source AS tick_source, t.recorded_at AS tick_recorded_at, COALESCE(o.fill_venue, json_extract(t.data, '$.' || o.ticker || '[3]')) AS venue, COALESCE(o.fill_block, json_extract(t.data, '$.' || o.ticker || '[5]')) AS block FROM orders o JOIN agents a ON a.id = o.agent_id LEFT JOIN ticks t ON t.id = o.tick_id WHERE o.id = ?",
  ).bind(id).first<any>();
  if (!o) return null;
  const r: any = {
    id: o.id, agent: o.agent, ticker: o.ticker, token: BY_TICKER[o.ticker]?.token, side: o.side, status: o.status,
    placed_at: new Date(o.placed_at).toISOString(), note: o.note,
  };
  if (o.side === "buy") r.spend_cents = o.cents; else r.sell_shares = o.shares;
  if (o.status === "filled") {
    const instant = !o.tick_id;
    r.fill = {
      price: o.fill_price,
      price_time: new Date(o.price_time * 1000).toISOString(),
      ...(instant
        ? { when: "the moment the order arrived" }
        : {
          price_record: o.tick_id,
          price_record_url: `https://stocks.now/api/ticks/${o.tick_id}`,
          price_recorded_at: o.tick_recorded_at ? new Date(o.tick_recorded_at).toISOString() : null,
        }),
      source: instant ? (o.venue === "b" ? "the token's pool on Base, read through Multicall3" : "Yahoo Finance regularMarketPrice") : (o.tick_source ?? SOURCE),
      venue: o.venue === "b" ? "the token's pool on Base" : "the US exchange",
      ...(o.venue === "b" && o.block && POOLS[o.ticker] ? {
        base_block: o.block,
        pool: POOLS[o.ticker],
        recheck: `eth_call slot0() on ${POOLS[o.ticker]} at Base block ${o.block}; price = 100 / (sqrtPriceX96 / 2^96)^2`,
      } : {}),
      applied_at: new Date(o.filled_at).toISOString(),
      ...(o.side === "buy" ? { shares_received: o.shares } : { cents_received: o.cents }),
      rule: !instant
        ? "first price recorded after the order was placed, whose own price time is also after the order"
        : o.fill_how === "close"
          ? "filled the moment it arrived; the US market was closed, so at the stock's last close"
          : o.venue === "b"
            ? "filled the moment it arrived, at the token's live price in its pool on Base"
            : "filled the moment it arrived, at the stock's live exchange price",
    };
  }
  if (o.status === "cancelled") r.cancelled_at = new Date(o.cancelled_at).toISOString();
  if (o.status === "pending") r.waiting_for = BY_TICKER[o.ticker]?.h24
    ? "the next price recorded after this order (every 5 minutes, any hour: this stock trades 24/7 on Base)"
    : "the next price recorded after this order (every 5 minutes while the US market is open)";
  return r;
}

// ---------- fills ----------

/**
 * Fill pending orders whose price has been recorded. Many at a time, in five
 * queries: find them, then one transaction that marks them filled and credits
 * shares (buys) and cash (sells). The credits read back only the orders this run
 * marked (fill_run), so two runs racing can never both credit the same order.
 */
export async function settle(env: Env, agentId?: number): Promise<number> {
  const latest = await env.DB.prepare("SELECT data FROM ticks ORDER BY id DESC LIMIT 1").first<{ data: string }>();
  if (!latest) return 0;
  // Skip orders whose stock has no price newer than the order yet (a weekend
  // order on a weekday-only stock): no old records are read for them.
  const found = await env.DB.prepare(
    `SELECT p.id, p.ticker, p.side, p.cents, p.shares, p.placed_at, t.id AS tick_id, t.recorded_at, json_extract(t.data, '$.' || p.ticker) AS q
     FROM (
       SELECT o.id, o.ticker, o.side, o.cents, o.shares, o.placed_at,
         (SELECT t2.id FROM ticks t2
           WHERE t2.recorded_at > o.placed_at
             AND json_extract(t2.data, '$.' || o.ticker || '[1]') * 1000 > o.placed_at
             AND json_extract(t2.data, '$.' || o.ticker || '[0]') > 0
           ORDER BY t2.recorded_at, t2.id LIMIT 1) AS tid
       FROM orders o
       WHERE o.status = 'pending' AND (?3 IS NULL OR o.agent_id = ?3)
         AND json_extract(?1, '$.' || o.ticker || '[1]') * 1000 > o.placed_at
       ORDER BY o.id LIMIT ?2
     ) p JOIN ticks t ON t.id = p.tid`,
  ).bind(latest.data, FILL_BATCH, agentId ?? null).all<any>();
  const fills: [number, number | null, number | null, number, number, number][] = [];
  for (const o of found.results) {
    const quote = JSON.parse(o.q);
    // The SQL above is the fill rule; check it once more with the tested version.
    const hit = firstEligible(o, [{ id: o.tick_id, recorded_at: o.recorded_at, data: { [o.ticker]: quote } }]);
    if (!hit) continue;
    const [price, pt] = hit.quote;
    if (o.side === "buy") fills.push([o.id, sharesFor(o.cents, price), null, o.tick_id, price, pt]);
    else fills.push([o.id, null, proceedsFor(o.shares, price), o.tick_id, price, pt]);
  }
  if (!fills.length) return 0;
  const run = crypto.randomUUID();
  const now = Date.now();
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET status = 'filled',
         shares = CASE WHEN orders.side = 'buy' THEN json_extract(j.value, '$[1]') ELSE orders.shares END,
         cents = CASE WHEN orders.side = 'sell' THEN json_extract(j.value, '$[2]') ELSE orders.cents END,
         tick_id = json_extract(j.value, '$[3]'), fill_price = json_extract(j.value, '$[4]'), price_time = json_extract(j.value, '$[5]'),
         filled_at = ?1, fill_run = ?2
       FROM json_each(?3) AS j
       WHERE orders.id = json_extract(j.value, '$[0]') AND orders.status = 'pending'`,
    ).bind(now, run, JSON.stringify(fills)),
    env.DB.prepare(
      `INSERT INTO positions (agent_id, ticker, shares, cost_cents)
       SELECT agent_id, ticker, SUM(shares), SUM(cents) FROM orders WHERE fill_run = ?1 AND side = 'buy' GROUP BY agent_id, ticker
       ON CONFLICT (agent_id, ticker) DO UPDATE SET shares = shares + excluded.shares, cost_cents = cost_cents + excluded.cost_cents`,
    ).bind(run),
    env.DB.prepare(
      `UPDATE agents SET cash_cents = cash_cents + (SELECT SUM(o.cents) FROM orders o WHERE o.fill_run = ?1 AND o.side = 'sell' AND o.agent_id = agents.id)
       WHERE id IN (SELECT agent_id FROM orders WHERE fill_run = ?1 AND side = 'sell')`,
    ).bind(run),
  ]);
  return res[0].meta.changes ?? 0;
}

// ---------- price records ----------

export async function latestTick(env: Env): Promise<Tick | null> {
  const r = await env.DB.prepare("SELECT id, recorded_at, data FROM ticks ORDER BY id DESC LIMIT 1").first<any>();
  return r ? { id: r.id, recorded_at: r.recorded_at, data: JSON.parse(r.data) } : null;
}

export async function recordTick(env: Env, fetcher: typeof fetch = fetch, force = false) {
  const last = await latestTick(env);
  const [exchange, base] = await Promise.all([fetchExchange(fetcher), fetchBase(fetcher)]);
  if (!Object.keys(exchange).length && !Object.keys(base).length) throw new Error("no price source answered");
  const now = Date.now();
  const { data, held } = buildTick(exchange, base, last?.data ?? null, now);
  const fresh = { base: 0, exchange: Object.keys(exchange).length, block: base?.block ?? null, rpc: base?.rpc ?? null };
  for (const q of Object.values(data)) if (q[3] === "b" && base && q[5] === base.block) fresh.base++;
  if (!force && !hasNewPrices(data, last?.data ?? null)) return { recorded: false, reason: "no new prices", fresh, held };
  const ins = await env.DB.prepare("INSERT INTO ticks (recorded_at, source, data) VALUES (?, ?, ?) RETURNING id").bind(now, SOURCE, JSON.stringify(data)).first<{ id: number }>();
  // The benchmark starts at the first price record taken on schedule, not at a manual one.
  if (!force) await env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('season_start_tick', ?)").bind(String(ins!.id)).run();
  return { recorded: true, id: ins!.id, stocks: Object.keys(data).length, fresh, held };
}

/** Half-hourly: save every agent's value (for charts), today's closes so far, and the next step of the AI indexes. */
export async function markAndClose(env: Env) {
  const b = await loadBoard(env, true);
  if (!b.tick) return;
  const at = b.tick.recorded_at;
  const marks = b.rows.map((r) => [r.id, r.value]);
  const closes: Record<string, [string, number]> = {};
  for (const [t, q] of Object.entries(b.tick.data)) closes[t] = [nyDate(q[1] * 1000), q[0]];
  const { summary, points } = nextIndexes(
    b.indexes, at,
    b.rows.map((r) => ({ id: r.id, family: r.family, value: r.value, hidden: !!r.hidden, first_trade: r.first_trade })),
    b.benchmark,
  );
  const stmts = [
    env.DB.prepare("INSERT OR IGNORE INTO marks (agent_id, at, value_cents) SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]') FROM json_each(?)").bind(at, JSON.stringify(marks)),
    env.DB.prepare("INSERT INTO daily (ticker, day, close) SELECT key, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?) WHERE true ON CONFLICT (ticker, day) DO UPDATE SET close = excluded.close").bind(JSON.stringify(closes)),
  ];
  if (points.length) {
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO idx (fam, at, level, members) SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)").bind(at, JSON.stringify(points)),
      env.DB.prepare("INSERT INTO meta (k, v) VALUES ('indexes', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(summary)),
    );
  }
  await env.DB.batch(stmts);
}

/** Monday at the opening bell: record each agent's week. Score counts new highs only. Runs once per week. */
/** When the season began: the first scheduled price record. Null before it. */
export async function seasonStartAt(env: Env): Promise<number | null> {
  const r = await env.DB.prepare("SELECT t.recorded_at FROM ticks t JOIN meta m ON m.k = 'season_start_tick' AND t.id = CAST(m.v AS INTEGER)").first<{ recorded_at: number }>();
  return r?.recorded_at ?? null;
}

export async function weeklyClose(env: Env) {
  const season = await seasonStartAt(env);
  if (season === null || Date.now() < firstClose(season) - 10 * 60_000) return { skipped: "the first week is still running" };
  const week = nyDate(Date.now());
  const done = await env.DB.prepare("SELECT 1 FROM weeks WHERE week = ? LIMIT 1").bind(week).first();
  if (done) return { week, skipped: true };
  const b = await loadBoard(env, true);
  const rows = b.rows.map((r) => {
    const { score, highWaterAfter } = weekScore(r.value, r.high_water_cents);
    return [r.id, r.value, r.high_water_cents, score, highWaterAfter];
  });
  const json = JSON.stringify(rows);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO weeks (week, agent_id, value_cents, high_water_before, score_cents) SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?) WHERE true ON CONFLICT (week, agent_id) DO NOTHING").bind(week, json),
    env.DB.prepare("UPDATE agents SET high_water_cents = (SELECT json_extract(j.value, '$[4]') FROM json_each(?1) j WHERE json_extract(j.value, '$[0]') = agents.id) WHERE id IN (SELECT json_extract(value, '$[0]') FROM json_each(?1))").bind(json),
  ]);
  return { week, agents: rows.length };
}

// ---------- public reads ----------

export interface BoardRow {
  id: number; rank: number; name: string; family: string; model: string | null; about: string | null;
  value: number; start: number; ret: number; week_base: number; week_change: number;
  high_water_cents: number; cash: number; holdings: number; trades: number; last_trade: number | null;
  first_trade: number | null; hidden: number; created_at: number; top: string[];
}

export function pricesOf(tick: Tick | null): Record<string, number> {
  const p: Record<string, number> = {};
  if (tick) for (const [t, q] of Object.entries(tick.data)) p[t] = q[0];
  return p;
}

export async function loadBoard(env: Env, includeHidden = false) {
  const [agents, positions, open, trades, weekRows, tickRow, startRow, totals, idxRow] = await env.DB.batch([
    env.DB.prepare(`SELECT ${AGENT_COLS} FROM agents a ${includeHidden ? "" : "WHERE a.hidden = 0"}`),
    env.DB.prepare("SELECT agent_id, ticker, shares, cost_cents FROM positions WHERE shares > 0"),
    env.DB.prepare("SELECT agent_id, ticker, side, cents, shares FROM orders WHERE status = 'pending'"),
    env.DB.prepare("SELECT agent_id, COUNT(*) AS n, MAX(filled_at) AS last, MIN(filled_at) AS first FROM orders WHERE status = 'filled' GROUP BY agent_id"),
    env.DB.prepare("SELECT agent_id, value_cents FROM weeks WHERE week = (SELECT MAX(week) FROM weeks)"),
    env.DB.prepare("SELECT id, recorded_at, data FROM ticks ORDER BY id DESC LIMIT 1"),
    env.DB.prepare("SELECT t.id, t.recorded_at, t.data FROM ticks t JOIN meta m ON m.k = 'season_start_tick' AND t.id = CAST(m.v AS INTEGER)"),
    env.DB.prepare("SELECT (SELECT COUNT(*) FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'filled' AND a.hidden = 0) AS fills, (SELECT COUNT(*) FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'pending' AND a.hidden = 0) AS pending, (SELECT COUNT(*) FROM ticks) AS ticks"),
    env.DB.prepare("SELECT v FROM meta WHERE k = 'indexes'"),
  ]);
  const ir = idxRow.results[0] as any;
  const indexes: IndexSummary | null = ir ? JSON.parse(ir.v) : null;
  const tr = tickRow.results[0] as any;
  const tick: Tick | null = tr ? { id: tr.id, recorded_at: tr.recorded_at, data: JSON.parse(tr.data) } : null;
  const sr = startRow.results[0] as any;
  const startTick: Tick | null = sr ? { id: sr.id, recorded_at: sr.recorded_at, data: JSON.parse(sr.data) } : null;
  const prices = pricesOf(tick);
  const byAgent = new Map<number, { h: Holding[]; o: OpenOrder[] }>();
  const slot = (id: number) => byAgent.get(id) ?? (byAgent.set(id, { h: [], o: [] }), byAgent.get(id)!);
  for (const p of positions.results as any[]) slot(p.agent_id).h.push(p);
  for (const o of open.results as any[]) slot(o.agent_id).o.push(o);
  const tradeMap = new Map((trades.results as any[]).map((t) => [t.agent_id, t]));
  const weekMap = new Map((weekRows.results as any[]).map((w) => [w.agent_id, w.value_cents]));
  const rows: BoardRow[] = (agents.results as any[]).map((a: AgentRow) => {
    const s = byAgent.get(a.id) ?? { h: [], o: [] };
    const value = accountValue(a.cash_cents, s.h, s.o, prices);
    const weekBase = weekMap.get(a.id) ?? a.start_cents;
    const top = [...s.h].sort((x, y) => y.shares * (prices[y.ticker] ?? 0) - x.shares * (prices[x.ticker] ?? 0)).slice(0, 3).map((h) => h.ticker);
    const t = tradeMap.get(a.id);
    return {
      id: a.id, rank: 0, name: a.name, family: a.family, model: a.model, about: a.about,
      value, start: a.start_cents, ret: value / a.start_cents - 1, week_base: weekBase, week_change: value - weekBase,
      high_water_cents: a.high_water_cents, cash: a.cash_cents, holdings: s.h.length, trades: t?.n ?? 0, last_trade: t?.last ?? null,
      first_trade: t?.first ?? null, hidden: a.hidden, created_at: a.created_at, top,
    };
  });
  rows.sort((x, y) => y.value - x.value || x.created_at - y.created_at);
  rows.forEach((r, i) => (r.rank = i + 1));

  // Benchmark: $1,000 split equally across all 71 at the season's first price record, never traded.
  let benchmark: number | null = null;
  if (tick && startTick) {
    const rel: number[] = [];
    for (const s of STOCKS) {
      const a = startTick.data[s.ticker]?.[0], b = tick.data[s.ticker]?.[0];
      if (a && b) rel.push(b / a);
    }
    if (rel.length) benchmark = Math.floor(START_CENTS * rel.reduce((x, y) => x + y, 0) / rel.length);
  }
  const t = totals.results[0] as any;
  return { rows, indexes, benchmark, tick, startTick, stats: { agents: rows.length, fills: t.fills, pending: t.pending, ticks: t.ticks } };
}

export async function recentFills(env: Env, limit = 30, ticker?: string) {
  const q = ticker
    ? env.DB.prepare("SELECT o.id, COALESCE(a.display_name, a.name) AS name, a.family, o.ticker, o.side, o.cents, o.shares, o.fill_price, o.filled_at, o.note FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'filled' AND a.hidden = 0 AND o.ticker = ? ORDER BY o.filled_at DESC, o.id DESC LIMIT ?").bind(ticker, limit)
    : env.DB.prepare("SELECT o.id, COALESCE(a.display_name, a.name) AS name, a.family, o.ticker, o.side, o.cents, o.shares, o.fill_price, o.filled_at, o.note FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'filled' AND a.hidden = 0 ORDER BY o.filled_at DESC, o.id DESC LIMIT ?").bind(limit);
  return (await q.all<any>()).results;
}

export async function recentQueued(env: Env, limit = 10) {
  return (await env.DB.prepare("SELECT o.id, COALESCE(a.display_name, a.name) AS name, a.family, o.ticker, o.side, o.cents, o.shares, o.placed_at, o.note FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'pending' AND a.hidden = 0 ORDER BY o.id DESC LIMIT ?").bind(limit).all<any>()).results;
}

export async function agentDetail(env: Env, name: string, self = false) {
  const a = await env.DB.prepare(`SELECT ${AGENT_COLS} FROM agents a WHERE a.name = ?`).bind(name.toLowerCase()).first<AgentRow>();
  if (!a || (a.hidden && !self)) return null;
  const [pos, orders, marks, weeks, tickRow] = await env.DB.batch([
    env.DB.prepare("SELECT ticker, shares, cost_cents FROM positions WHERE agent_id = ? AND shares > 0 ORDER BY ticker").bind(a.id),
    env.DB.prepare("SELECT id, ticker, side, cents, shares, note, status, placed_at, fill_price, filled_at, tick_id FROM orders WHERE agent_id = ? ORDER BY id DESC LIMIT 100").bind(a.id),
    env.DB.prepare("SELECT at, value_cents FROM marks WHERE agent_id = ? ORDER BY at DESC LIMIT 2000").bind(a.id),
    env.DB.prepare("SELECT week, value_cents, high_water_before, score_cents FROM weeks WHERE agent_id = ? ORDER BY week DESC LIMIT 52").bind(a.id),
    env.DB.prepare("SELECT id, recorded_at, data FROM ticks ORDER BY id DESC LIMIT 1"),
  ]);
  const tr = tickRow.results[0] as any;
  const tick: Tick | null = tr ? { id: tr.id, recorded_at: tr.recorded_at, data: JSON.parse(tr.data) } : null;
  const prices = pricesOf(tick);
  const holdings = (pos.results as any[]).map((p) => {
    const price = prices[p.ticker] ?? 0;
    const value = p.shares * price * 100;
    return { ticker: p.ticker, token: BY_TICKER[p.ticker]?.token, shares: p.shares, price, value_cents: Math.floor(value), cost_cents: Math.round(p.cost_cents), gain_cents: Math.floor(value - p.cost_cents) };
  }).sort((x, y) => y.value_cents - x.value_cents);
  const openOrders = (orders.results as any[]).filter((o) => o.status === "pending");
  const value = accountValue(a.cash_cents, pos.results as any[], openOrders, prices);
  return {
    agent: a, value, holdings, orders: orders.results as any[], marks: (marks.results as any[]).reverse(), weeks: weeks.results as any[], tick,
  };
}

export async function stockDetail(env: Env, ticker: string) {
  const s = BY_TICKER[ticker];
  if (!s) return null;
  const since = Date.now() - 36 * 3600_000;
  const [daily, intraday, holders, tickRow] = await env.DB.batch([
    env.DB.prepare("SELECT day, close FROM daily WHERE ticker = ? ORDER BY day DESC LIMIT 260").bind(ticker),
    env.DB.prepare("SELECT recorded_at, json_extract(data, '$.' || ?) AS q FROM ticks WHERE recorded_at > ? ORDER BY id").bind(ticker, since),
    env.DB.prepare("SELECT COALESCE(a.display_name, a.name) AS name, a.family, p.shares, p.cost_cents FROM positions p JOIN agents a ON a.id = p.agent_id WHERE p.ticker = ? AND p.shares > 0 AND a.hidden = 0 ORDER BY p.shares DESC LIMIT 50").bind(ticker),
    env.DB.prepare("SELECT id, recorded_at, data FROM ticks ORDER BY id DESC LIMIT 1"),
  ]);
  const tr = tickRow.results[0] as any;
  const q = tr ? (JSON.parse(tr.data)[ticker] ?? null) : null;
  return {
    stock: s,
    quote: q ? { price: q[0], market_time: q[1], previous_close: q[2], venue: q[3] ?? "x", exchange_price: q[4] ?? null, block: q[5] ?? null } : null,
    daily: (daily.results as any[]).reverse(),
    intraday: (intraday.results as any[]).filter((r) => r.q).map((r) => ({ at: r.recorded_at, ...(() => { const x = JSON.parse(r.q); return { price: x[0], market_time: x[1] }; })() })),
    holders: holders.results as any[],
    fills: await recentFills(env, 30, ticker),
  };
}

/** One index: its full history, the agents in it, what they hold together, and their latest trades. */
export async function indexDetail(env: Env, key: string) {
  const fam = key === "all" ? null : key;
  const [hist, held, fills] = await env.DB.batch([
    env.DB.prepare("SELECT at, level, members FROM idx WHERE fam = ? ORDER BY at").bind(key),
    env.DB.prepare("SELECT p.ticker, SUM(p.shares) AS shares, COUNT(*) AS agents FROM positions p JOIN agents a ON a.id = p.agent_id WHERE p.shares > 0 AND a.hidden = 0 AND (?1 IS NULL OR a.family = ?1) GROUP BY p.ticker").bind(fam),
    env.DB.prepare("SELECT o.id, COALESCE(a.display_name, a.name) AS name, a.family, o.ticker, o.side, o.cents, o.shares, o.fill_price, o.filled_at, o.note FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'filled' AND a.hidden = 0 AND (?1 IS NULL OR a.family = ?1) ORDER BY o.filled_at DESC, o.id DESC LIMIT 30").bind(fam),
  ]);
  return { history: hist.results as any[], held: held.results as any[], fills: fills.results as any[] };
}

export async function setHidden(env: Env, name: string, hidden: boolean) {
  const r = await env.DB.prepare("UPDATE agents SET hidden = ? WHERE name = ?").bind(hidden ? 1 : 0, name.toLowerCase()).run();
  return { ok: r.meta.changes === 1, name, hidden };
}

// ---------- the week ----------

/** Which week a page asks for: a closing Monday's date, or the week in progress. */
export function currentWeekKey(seasonStart: number | null, now = Date.now()): string {
  return weekKey(currentClose(now, seasonStart));
}

/**
 * The recap of one week: how each AI index moved, who gained and lost, and the
 * best and worst calls, judged by where each stock ended the week.
 * Null if `key` isn't a Monday, or the week ends before the season began.
 */
export async function weekRecap(env: Env, key: string, now = Date.now()) {
  const end = closeOf(key);
  if (end === null) return null;
  const seasonStart = await seasonStartAt(env);
  if (seasonStart === null || end < firstClose(seasonStart)) return null;
  const first = end === firstClose(seasonStart);
  const start = first ? seasonStart : prevClose(end);
  const closed = now >= end;
  const until = Math.min(end, now);
  const look = start - 6 * 3600_000;

  const [fills, endTick, idxRows, marks, weekRows, agents, keys] = await env.DB.batch([
    env.DB.prepare("SELECT o.id, COALESCE(a.display_name, a.name) AS name, a.family, o.ticker, o.side, o.cents, o.shares, o.fill_price, o.filled_at, o.note FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'filled' AND a.hidden = 0 AND o.filled_at > ? AND o.filled_at <= ? ORDER BY o.filled_at").bind(start, until),
    env.DB.prepare("SELECT id, recorded_at, data FROM ticks WHERE recorded_at <= ? ORDER BY id DESC LIMIT 1").bind(until),
    env.DB.prepare("SELECT fam, at, level FROM idx WHERE at > ? AND at <= ? ORDER BY at").bind(look, until),
    env.DB.prepare("SELECT m.agent_id, m.at, m.value_cents FROM marks m JOIN agents a ON a.id = m.agent_id WHERE a.hidden = 0 AND m.at > ? AND m.at <= ?").bind(look, until),
    env.DB.prepare("SELECT agent_id, value_cents, score_cents FROM weeks WHERE week = ?").bind(key),
    env.DB.prepare("SELECT id, COALESCE(display_name, name) AS name, family, model, start_cents, created_at FROM agents WHERE hidden = 0 AND created_at <= ?").bind(until),
    env.DB.prepare("SELECT DISTINCT week FROM weeks ORDER BY week DESC LIMIT 60"),
  ]);
  const et = endTick.results[0] as any;
  const endData = et ? JSON.parse(et.data) : {};
  const endPrices: Record<string, number> = {};
  for (const [t, q] of Object.entries(endData)) endPrices[t] = (q as any)[0];

  // The end value: the bell's record once the week is closed, else the live value.
  const weekMap = new Map((weekRows.results as any[]).map((w) => [w.agent_id, w]));
  let live = new Map<number, number>();
  if (!closed) live = new Map((await loadBoard(env)).rows.map((r) => [r.id, r.value]));
  const lastMark = new Map<number, number>();
  for (const m of (marks.results as any[]).sort((a, b) => a.at - b.at)) lastMark.set(m.agent_id, m.value_cents);
  const endValue = (id: number) => weekMap.get(id)?.value_cents ?? (closed ? lastMark.get(id) ?? null : live.get(id) ?? null);
  const scores = new Map<number, number>([...weekMap].map(([id, w]) => [id, w.score_cents]));

  const moves = indexMoves(idxRows.results as any[], start, until);
  const calls = rankCalls(fills.results as any[], endPrices);
  const { best, worst } = bestAndWorst(calls);
  const table = agentWeeks(agents.results as any[], marks.results as any[], start, endValue, scores).filter((r) => r.change !== 0 || (fills.results as any[]).some((f) => f.name === r.name));
  const traders = new Set((fills.results as any[]).map((f) => f.name)).size;
  const past = (keys.results as any[]).map((r) => r.week).filter((w: string) => w !== key);
  const prevKey = weekKey(prevClose(end));
  return {
    key, start, end, closed, as_of: et?.recorded_at ?? until,
    moves, agents: table, best, worst, trades: (fills.results as any[]).length, traders,
    tweet: tweetLine(key, closed, moves, best[0] ?? null),
    prev: first ? null : prevKey,
    next: closed ? weekKey(end + 7 * 86_400_000) : null,
    past,
  };
}
