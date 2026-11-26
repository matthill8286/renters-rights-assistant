#!/usr/bin/env node
/**
 * Arthur Online probe. Arthur has no sandbox, so this runs against a real
 * account and is careful about what it keeps: it records field NAMES and value
 * TYPES only, plus status and rent-frequency labels and counts. It never writes
 * names, addresses, emails or amounts.
 *
 * Run with the ARTHUR_* variables set (see .env.example) and PROBE_CONFIRM=yes:
 *   PROBE_CONFIRM=yes npm run probe:arthur
 * Output goes to probe-output/arthur-summary.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { ArthurClient } from "../arthur/client.js";
import { ArthurSource, customField, type ArthurTenancy } from "../arthur/mapper.js";
import { runChecks } from "../rules/checks.js";

const OUT = process.env.PROBE_OUT ?? "probe-output";
const SAMPLE = Math.min(Number(process.env.PROBE_SAMPLE ?? 10), 100);

/** Fields the mapper reads, per endpoint. */
export const ARTHUR_EXPECTED: Record<string, string[]> = {
  tenancies: ["id", "unit_id", "status", "start_date", "end_date", "rent_amount", "rent_frequency", "deposit_amount", "deposit_held_by", "custom_fields"],
  tenants: ["id", "first_name", "last_name", "email"],
  assets: ["id", "name"],
  units: ["id", "address_line_1", "city", "postcode", "unit_owner_id"],
  entities: ["id", "name", "email"],
};

type Row = Record<string, unknown>;

/** Field name → JSON type, merged across rows. No values. */
export function shapeOf(rows: Row[]): Record<string, string> {
  const out: Record<string, Set<string>> = {};
  for (const r of rows)
    for (const [k, v] of Object.entries(r)) (out[k] ??= new Set()).add(v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  return Object.fromEntries(Object.entries(out).sort().map(([k, s]) => [k, [...s].sort().join("|")]));
}

export function fieldReport(name: string, rows: Row[]) {
  const shape = shapeOf(rows);
  const expected = ARTHUR_EXPECTED[name] ?? [];
  return { endpoint: name, sampleSize: rows.length, missingExpected: expected.filter((k) => !(k in shape)), fields: shape };
}

/** Custom field names only, whichever shape Arthur uses. */
function customFieldNames(fields: unknown): string[] {
  if (Array.isArray(fields))
    return fields.map((f) => {
      const o = f as Row;
      return String(o.name ?? o.label ?? o.key ?? o.field_name ?? "?");
    });
  if (fields && typeof fields === "object") return Object.keys(fields);
  return [];
}

async function main() {
  if (process.env.PROBE_CONFIRM !== "yes") {
    throw new Error("This reads a real Arthur account. Set PROBE_CONFIRM=yes to go ahead (only field names and counts are saved).");
  }
  const client = await ArthurClient.fromEnv();
  if (!client) throw new Error("Set ARTHUR_CLIENT_ID, ARTHUR_CLIENT_SECRET and ARTHUR_ENTITY_ID, then run `npm run arthur:auth`.");
  await mkdir(OUT, { recursive: true });

  const tenancies = (await client.getAll<ArthurTenancy & Row>("/tenancies", {}, SAMPLE)) as Row[];
  const first = tenancies[0] as (ArthurTenancy & Row) | undefined;
  const tid = first ? encodeURIComponent(String(first.id)) : undefined;
  const raw: Record<string, Row[]> = { tenancies };
  raw.tenants = tid ? await client.getAll<Row>(`/tenancies/${tid}/tenants`, {}, SAMPLE) : [];
  raw.assets = tid ? await client.getAll<Row>(`/tenancies/${tid}/assets`, {}, SAMPLE) : [];
  const unitId = first?.unit_id ?? first?.unit?.id;
  if (unitId !== undefined) {
    const u = await client.get<{ data: Row | Row[] }>(`/units/${encodeURIComponent(String(unitId))}`);
    raw.units = ([] as Row[]).concat(u.data ?? []);
    const ownerId = raw.units[0]?.unit_owner_id;
    if (ownerId !== undefined) {
      try {
        const e = await client.get<{ data: Row | Row[] }>(`/entities/${encodeURIComponent(String(ownerId))}`);
        raw.entities = ([] as Row[]).concat(e.data ?? []);
      } catch (err) {
        raw.entities = [];
        console.error(`entities lookup failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      }
    }
  }

  const snapshot = await new ArthurSource(client, "Arthur probe", SAMPLE).loadSnapshot();
  const { findings, skipped } = runChecks(snapshot, new Date().toISOString().slice(0, 10));
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const byRule = findings.reduce<Record<string, number>>((a, f) => ((a[f.ruleId] = (a[f.ruleId] ?? 0) + 1), a), {});

  const summary = {
    ranAt: new Date().toISOString(),
    fieldReport: Object.entries(raw).map(([k, rows]) => fieldReport(k, rows)),
    tenancyStatusesSeen: [...new Set(tenancies.map((t) => String(t.status ?? t.tenancy_status)))],
    rentFrequenciesSeen: [...new Set(tenancies.map((t) => String(t.rent_frequency)))],
    tenancyCustomFieldNames: [...new Set(tenancies.flatMap((t) => customFieldNames(t.custom_fields)))],
    tenanciesWithRraField: tenancies.filter((t) => customField(t.custom_fields, "rra") !== undefined).length,
    mapped: {
      tenancies: snapshot.tenancies.length,
      properties: snapshot.properties.length,
      landlords: snapshot.landlords.length,
      tenants: snapshot.tenants.length,
      documentsByKind: snapshot.tenancies.flatMap((t) => t.documents).reduce<Record<string, number>>((a, d) => ((a[d.kind] = (a[d.kind] ?? 0) + 1), a), {}),
      tenanciesWithoutTenants: snapshot.tenancies.filter((t) => t.tenantIds.length === 0).length,
      tenanciesWithoutStartDate: snapshot.tenancies.filter((t) => !t.startDate).length,
      tenanciesWithoutLandlord: snapshot.tenancies.filter((t) => !t.landlordId).length,
    },
    findings: counts,
    findingsByRule: byRule,
    skippedOutsideEngland: skipped.length,
  };

  await writeFile(`${OUT}/arthur-summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
