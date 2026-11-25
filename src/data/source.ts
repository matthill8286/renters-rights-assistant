import { readFile } from "node:fs/promises";
import type { AgencySnapshot } from "../domain.js";

/** Anything that can give the rules a full picture of one agency. */
export interface DataSource {
  name: string;
  loadSnapshot(): Promise<AgencySnapshot>;
}

/** Reads a snapshot from a JSON file. Used for demos, tests and offline work. */
export class FixtureSource implements DataSource {
  name = "fixture";
  constructor(private path: string) {}
  async loadSnapshot(): Promise<AgencySnapshot> {
    const raw = await readFile(this.path, "utf8");
    return JSON.parse(raw) as AgencySnapshot;
  }
}

/** Caches a snapshot for a short time so a chat does not refetch on every tool call. */
export class CachedSource implements DataSource {
  name: string;
  private cached?: { at: number; snapshot: AgencySnapshot };
  constructor(private inner: DataSource, private ttlMs = 5 * 60_000) {
    this.name = `${inner.name} (cached)`;
  }
  async loadSnapshot(): Promise<AgencySnapshot> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.snapshot;
    const snapshot = await this.inner.loadSnapshot();
    this.cached = { at: Date.now(), snapshot };
    return snapshot;
  }
  invalidate() {
    this.cached = undefined;
  }
}
