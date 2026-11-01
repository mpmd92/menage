import { DurableObject } from "cloudflare:workers";

// Shared chore list for Paul and Marguerite. The whole list is one JSON document, kept in a
// single Durable Object so every write is checked against the latest version. Access needs the
// password; only its SHA-256 hash is stored, as the PASSWORD_HASH secret.
//
// GET  /state           -> { version, data, updatedAt }
// PUT  /state           <- { baseVersion, data }  -> 200 { version, updatedAt } | 409 { version, data, updatedAt }
// GET  /history         -> the 50 latest previous versions (number and date), to recover from a mistake
// GET  /history/<n>     -> one previous version

const MAX_BYTES = 512 * 1024;
const HISTORY_KEEP = 200;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

export class MenageStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS doc (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)"
      );
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS history (version INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)"
      );
    });
  }

  read() {
    const row = this.ctx.storage.sql.exec("SELECT version, data, updated_at FROM doc WHERE id = 1").toArray()[0];
    return row
      ? { version: row.version, data: JSON.parse(row.data), updatedAt: row.updated_at }
      : { version: 0, data: null, updatedAt: null };
  }

  // No await in here: the version check and the write happen as one step.
  write(baseVersion, dataText) {
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT version, data, updated_at FROM doc WHERE id = 1").toArray()[0];
    const current = row ? row.version : 0;
    if (baseVersion !== current) return { ok: false, current: this.read() };
    const version = current + 1;
    const now = new Date().toISOString();
    if (row) {
      sql.exec("INSERT OR REPLACE INTO history (version, data, updated_at) VALUES (?, ?, ?)", row.version, row.data, row.updated_at);
    }
    sql.exec(
      "INSERT INTO doc (id, version, data, updated_at) VALUES (1, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET version = excluded.version, data = excluded.data, updated_at = excluded.updated_at",
      version, dataText, now
    );
    sql.exec("DELETE FROM history WHERE version <= ?", version - HISTORY_KEEP);
    return { ok: true, version, updatedAt: now };
  }

  history() {
    return this.ctx.storage.sql.exec("SELECT version, updated_at AS updatedAt FROM history ORDER BY version DESC LIMIT 50").toArray();
  }

  snapshot(version) {
    const row = this.ctx.storage.sql.exec("SELECT version, data, updated_at FROM history WHERE version = ?", version).toArray()[0];
    return row ? { version: row.version, data: JSON.parse(row.data), updatedAt: row.updated_at } : null;
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

function hexToBytes(hex) {
  const clean = (hex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) return null;
  return new Uint8Array(clean.match(/../g).map((b) => parseInt(b, 16)));
}

async function authorized(request, env) {
  const expected = hexToBytes(env.PASSWORD_HASH);
  const m = (request.headers.get("Authorization") || "").match(/^Bearer (.+)$/);
  if (!expected || !m) return false;
  let password;
  try { password = decodeURIComponent(m[1]); } catch { return false; }
  const given = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)));
  return crypto.subtle.timingSafeEqual(given, expected);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const { pathname } = new URL(request.url);
    const isState = pathname === "/state";
    const historyMatch = pathname.match(/^\/history(?:\/(\d+))?$/);
    if (!isState && !historyMatch) return json({ error: "not_found" }, 404);

    if (!(await authorized(request, env))) {
      await new Promise((r) => setTimeout(r, 400)); // slows down password guessing
      return json({ error: "unauthorized" }, 401);
    }

    const store = env.STORE.getByName("menage");

    if (historyMatch) {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (!historyMatch[1]) return json(await store.history());
      const snap = await store.snapshot(Number(historyMatch[1]));
      return snap ? json(snap) : json({ error: "not_found" }, 404);
    }

    if (request.method === "GET") return json(await store.read());

    if (request.method === "PUT") {
      const text = await request.text();
      if (text.length > MAX_BYTES) return json({ error: "too_large" }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
      if (!body || !Number.isInteger(body.baseVersion) || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
        return json({ error: "bad_request" }, 400);
      }
      const result = await store.write(body.baseVersion, JSON.stringify(body.data));
      return result.ok
        ? json({ version: result.version, updatedAt: result.updatedAt })
        : json({ error: "conflict", ...result.current }, 409);
    }

    return json({ error: "method_not_allowed" }, 405);
  },
};
