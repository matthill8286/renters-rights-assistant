/**
 * Minimal Reapit Foundations Platform API client.
 *
 * Facts from the Foundations docs (checked 2026-11-24):
 * - REST base https://platform.reapit.cloud, header `api-version: 2020-01-31`.
 * - Reapit Connect client credentials: POST https://connect.reapit.cloud/token
 *   with Basic auth (client_id:secret) and grant_type=client_credentials.
 *   Every API call sends `reapit-customer: <customer code>` (SBOX = sandbox).
 * - Pages hold at most 100 records (pageSize, pageNumber).
 * - Limits: 20 requests/second, 5 concurrent per customer, 250,000 a day; 429 when over.
 *
 * Read-only by design in this version. Writes come later, behind approval.
 */

export interface ReapitConfig {
  clientId: string;
  clientSecret: string;
  /** Agency customer code, or "SBOX" for the sandbox. */
  customerId: string;
  apiBase?: string;
  tokenUrl?: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

export interface Paged<T> {
  _embedded: T[];
  pageNumber: number;
  pageSize: number;
  pageCount: number;
  totalCount: number;
}

const API_VERSION = "2020-01-31";
const MAX_PAGE_SIZE = 100;
const MAX_CONCURRENT = 5;

export class ReapitClient {
  private token?: { value: string; expiresAt: number };
  private inFlight = 0;
  private queue: (() => void)[] = [];
  private readonly apiBase: string;
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private cfg: ReapitConfig) {
    this.apiBase = cfg.apiBase ?? "https://platform.reapit.cloud";
    this.tokenUrl = cfg.tokenUrl ?? "https://connect.reapit.cloud/token";
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  static fromEnv(env = process.env): ReapitClient | undefined {
    const { REAPIT_CLIENT_ID, REAPIT_CLIENT_SECRET, REAPIT_CUSTOMER_ID } = env;
    if (!REAPIT_CLIENT_ID || !REAPIT_CLIENT_SECRET || !REAPIT_CUSTOMER_ID) return undefined;
    return new ReapitClient({
      clientId: REAPIT_CLIENT_ID,
      clientSecret: REAPIT_CLIENT_SECRET,
      customerId: REAPIT_CUSTOMER_ID,
      apiBase: env.REAPIT_API_BASE,
    });
  }

  get customerId() {
    return this.cfg.customerId;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.cfg.clientId }).toString(),
    });
    if (!res.ok) throw new Error(`Reapit Connect token request failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= MAX_CONCURRENT) await new Promise<void>((r) => this.queue.push(r));
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
      this.queue.shift()?.();
    }
  }

  async get<T>(path: string, query: Record<string, string | number | string[] | undefined> = {}): Promise<T> {
    const url = new URL(path, this.apiBase);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, String(v));
    }
    return this.slot(async () => {
      for (let attempt = 0; ; attempt++) {
        const res = await this.fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${await this.getToken()}`,
            "api-version": API_VERSION,
            "reapit-customer": this.cfg.customerId,
            Accept: "application/json",
          },
        });
        if (res.status === 429 && attempt < 4) {
          const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        if (!res.ok) throw new Error(`Reapit GET ${url.pathname} failed: ${res.status} ${await res.text()}`);
        return (await res.json()) as T;
      }
    });
  }

  /** Fetches every page of a collection. */
  async getAll<T>(path: string, query: Record<string, string | number | string[] | undefined> = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const res = await this.get<Paged<T>>(path, { ...query, pageSize: MAX_PAGE_SIZE, pageNumber: page });
      out.push(...res._embedded);
      if (page >= res.pageCount || res._embedded.length === 0) break;
    }
    return out;
  }
}
