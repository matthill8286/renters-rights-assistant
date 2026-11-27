/**
 * Arthur Online API v2 client.
 *
 * From Arthur's developer docs (developer.arthuronline.co.uk, read 2026-11-26):
 * - Base https://api.arthuronline.co.uk/v2. Every call sends
 *   `Authorization: Bearer <token>` and `X-EntityID: <entity id>`.
 * - OAuth2 authorization code only (no client credentials). Token endpoint
 *   https://auth.arthuronline.co.uk/oauth/token. Access tokens last 14 days,
 *   refresh tokens 21 days. An expired token returns 401 with
 *   error "expired_token".
 * - Lists take page and limit (1-100) and return { status, data, pagination }.
 * - Rate limit: 5,000 requests an hour across the account.
 *
 * Read-only in this version.
 */
import { readFile, writeFile } from "node:fs/promises";

export const ARTHUR_API_BASE = "https://api.arthuronline.co.uk/v2";
export const ARTHUR_AUTH_BASE = "https://auth.arthuronline.co.uk/oauth";

export interface ArthurTokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms when the access token expires, if known. */
  expires_at?: number;
}

export interface ArthurConfig {
  clientId: string;
  clientSecret: string;
  entityId: string;
  tokens: ArthurTokens;
  /** If set, refreshed tokens are written here so they survive restarts. */
  tokenFile?: string;
  apiBase?: string;
  authBase?: string;
  fetchImpl?: typeof fetch;
}

export interface ArthurList<T> {
  status?: string | number;
  data: T[];
  pagination?: { page?: number; current?: number; count?: number; pageCount?: number; limit?: number };
}

const MAX_LIMIT = 100;

export async function exchangeToken(
  params: Record<string, string>,
  opts: { authBase?: string; fetchImpl?: typeof fetch } = {},
): Promise<ArthurTokens> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.authBase ?? ARTHUR_AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`Arthur token request failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
  };
}

export class ArthurClient {
  private tokens: ArthurTokens;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private cfg: ArthurConfig) {
    this.tokens = cfg.tokens;
    this.apiBase = cfg.apiBase ?? ARTHUR_API_BASE;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  get entityId() {
    return this.cfg.entityId;
  }

  /**
   * Builds a client from env. Tokens come from ARTHUR_TOKEN_FILE (written by
   * `npm run arthur:auth`) or from ARTHUR_ACCESS_TOKEN / ARTHUR_REFRESH_TOKEN.
   */
  static async fromEnv(env = process.env): Promise<ArthurClient | undefined> {
    const { ARTHUR_CLIENT_ID, ARTHUR_CLIENT_SECRET, ARTHUR_ENTITY_ID, ARTHUR_TOKEN_FILE } = env;
    if (!ARTHUR_CLIENT_ID || !ARTHUR_CLIENT_SECRET || !ARTHUR_ENTITY_ID) return undefined;
    let tokens: ArthurTokens | undefined;
    if (ARTHUR_TOKEN_FILE) {
      try {
        tokens = JSON.parse(await readFile(ARTHUR_TOKEN_FILE, "utf8")) as ArthurTokens;
      } catch {
        // fall through to env tokens
      }
    }
    if (!tokens && env.ARTHUR_ACCESS_TOKEN) {
      tokens = { access_token: env.ARTHUR_ACCESS_TOKEN, refresh_token: env.ARTHUR_REFRESH_TOKEN };
    }
    if (!tokens) {
      throw new Error("Arthur is configured but has no tokens. Run `npm run arthur:auth` first, or set ARTHUR_ACCESS_TOKEN.");
    }
    return new ArthurClient({
      clientId: ARTHUR_CLIENT_ID,
      clientSecret: ARTHUR_CLIENT_SECRET,
      entityId: ARTHUR_ENTITY_ID,
      tokens,
      tokenFile: ARTHUR_TOKEN_FILE,
      apiBase: env.ARTHUR_API_BASE,
    });
  }

  private async refresh(): Promise<void> {
    if (!this.tokens.refresh_token) throw new Error("Arthur access token expired and there is no refresh token. Run `npm run arthur:auth` again.");
    this.tokens = await exchangeToken(
      {
        grant_type: "refresh_token",
        refresh_token: this.tokens.refresh_token,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      },
      { authBase: this.cfg.authBase, fetchImpl: this.fetchImpl },
    );
    if (this.cfg.tokenFile) await writeFile(this.cfg.tokenFile, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    if (this.tokens.expires_at && Date.now() > this.tokens.expires_at - 60_000) await this.refresh();
    const url = new URL(`${this.apiBase.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${this.tokens.access_token}`,
          "X-EntityID": this.cfg.entityId,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });
      if (res.status === 401 && attempt === 0) {
        await this.refresh();
        continue;
      }
      if (res.status === 429 && attempt < 4) {
        const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`Arthur GET ${url.pathname} failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as T;
    }
  }

  async getAll<T>(path: string, query: Record<string, string | number | undefined> = {}, maxItems?: number): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const res = await this.get<ArthurList<T>>(path, { ...query, page, limit: MAX_LIMIT });
      const rows = res.data ?? [];
      out.push(...rows);
      if (maxItems && out.length >= maxItems) return out.slice(0, maxItems);
      const pageCount = res.pagination?.pageCount ?? 1;
      if (page >= pageCount || rows.length === 0) break;
    }
    return out;
  }
}
