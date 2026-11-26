#!/usr/bin/env node
/**
 * Reapit sandbox probe. Run with REAPIT_CLIENT_ID, REAPIT_CLIENT_SECRET and
 * REAPIT_CUSTOMER_ID=SBOX. It:
 *  1. fetches a small sample of raw records from each endpoint the mapper uses,
 *  2. reports which fields the mapper expects but did not find,
 *  3. runs the full mapper and the compliance checks on the sample,
 * and writes everything to probe-output/ so the mapping can be fixed.
 *
 * Only use this against the sandbox (SBOX demo data), never a live agency.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { ReapitClient } from "../reapit/client.js";
import { ReapitSource } from "../reapit/mapper.js";
import { runChecks } from "../rules/checks.js";

const OUT = process.env.PROBE_OUT ?? "probe-output";
const SAMPLE = Number(process.env.PROBE_SAMPLE ?? 10);

const EXPECTED: Record<string, string[]> = {
  tenancies: ["id", "propertyId", "landlordId", "status", "startDate", "endDate", "isPeriodic", "rent", "rentFrequency", "deposit", "metadata"],
  properties: ["id", "address", "metadata"],
  landlords: ["id", "related", "metadata"],
  contacts: ["id", "forename", "surname", "email"],
  relationships: ["associatedType", "associatedId"],
  documents: ["id", "typeId", "name", "associatedType", "associatedId"],
};

function fieldReport(name: string, rows: Record<string, unknown>[]) {
  const seen = new Set(rows.flatMap((r) => Object.keys(r)));
  const expected = EXPECTED[name] ?? [];
  return {
    endpoint: name,
    sampleSize: rows.length,
    missingExpected: expected.filter((k) => !seen.has(k)),
    otherFieldsSeen: [...seen].filter((k) => !expected.includes(k)).sort(),
  };
}

async function main() {
  const client = ReapitClient.fromEnv();
  if (!client) throw new Error("Set REAPIT_CLIENT_ID, REAPIT_CLIENT_SECRET and REAPIT_CUSTOMER_ID");
  if (client.customerId !== "SBOX" && process.env.PROBE_ALLOW_LIVE !== "yes") {
    throw new Error(`Refusing to probe customer ${client.customerId}: the probe is for the sandbox (SBOX) only.`);
  }
  await mkdir(OUT, { recursive: true });

  type Row = Record<string, unknown> & { id: string };
  const page = async (path: string, q: Record<string, string | number | string[] | undefined> = {}) =>
    (await client.get<{ _embedded: Row[]; totalCount?: number }>(path, { pageSize: SAMPLE, ...q }));

  const raw: Record<string, Row[]> = {};
  const tenancyPage = await page("/tenancies");
  raw.tenancies = tenancyPage._embedded;
  const first = raw.tenancies[0];
  raw.properties = (await page("/properties", { id: [...new Set(raw.tenancies.map((t) => String(t.propertyId)))] }))._embedded;
  raw.landlords = (await page("/landlords", { id: [...new Set(raw.tenancies.map((t) => String(t.landlordId ?? "")).filter(Boolean))] }))._embedded;
  raw.relationships = first ? (await page(`/tenancies/${encodeURIComponent(first.id)}/relationships`))._embedded : [];
  raw.contacts = (await page("/contacts", { id: raw.relationships.map((r) => String(r.associatedId)) }))._embedded;
  raw.documents = first ? (await page("/documents", { associatedType: "tenancy", associatedId: first.id }))._embedded : [];

  const report = Object.entries(raw).map(([k, rows]) => fieldReport(k, rows));
  const statuses = [...new Set(raw.tenancies.map((t) => String(t.status)))];
  const frequencies = [...new Set(raw.tenancies.map((t) => String(t.rentFrequency)))];

  const snapshot = await new ReapitSource(client, "Reapit sandbox", SAMPLE).loadSnapshot();
  const today = new Date().toISOString().slice(0, 10);
  const { findings, skipped } = runChecks(snapshot, today);
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  const summary = {
    ranAt: new Date().toISOString(),
    customer: client.customerId,
    totalTenanciesInSandbox: tenancyPage.totalCount,
    fieldReport: report,
    tenancyStatusesSeen: statuses,
    rentFrequenciesSeen: frequencies,
    mapped: {
      tenancies: snapshot.tenancies.length,
      properties: snapshot.properties.length,
      landlords: snapshot.landlords.length,
      tenants: snapshot.tenants.length,
      documentsByKind: snapshot.tenancies.flatMap((t) => t.documents).reduce<Record<string, number>>((a, d) => ((a[d.kind] = (a[d.kind] ?? 0) + 1), a), {}),
      tenanciesWithoutTenants: snapshot.tenancies.filter((t) => t.tenantIds.length === 0).map((t) => t.id),
      tenanciesWithoutStartDate: snapshot.tenancies.filter((t) => !t.startDate).map((t) => t.id),
    },
    findings: counts,
    skipped,
  };

  await writeFile(`${OUT}/raw-sample.json`, JSON.stringify(raw, null, 2));
  await writeFile(`${OUT}/snapshot.json`, JSON.stringify(snapshot, null, 2));
  await writeFile(`${OUT}/findings.json`, JSON.stringify(findings, null, 2));
  await writeFile(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
