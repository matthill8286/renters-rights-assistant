import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArthurSource,
  customField,
  mapArthurStatus,
  mapArthurTenancy,
  mapEntity,
  mapTenant,
  mapUnit,
  readRraFacts,
} from "../src/arthur/mapper.ts";
import { ArthurClient } from "../src/arthur/client.ts";
import { fieldReport, shapeOf } from "../src/tools/arthur-probe.ts";
import { runChecks } from "../src/rules/checks.ts";

test("Arthur statuses map to ours", () => {
  assert.deepEqual(mapArthurStatus("Periodic"), { status: "current", periodic: true });
  assert.deepEqual(mapArthurStatus("Current"), { status: "current", periodic: false });
  assert.deepEqual(mapArthurStatus("Ending"), { status: "current", periodic: false });
  assert.equal(mapArthurStatus("Prospective").status, "pending");
  assert.equal(mapArthurStatus("Approved").status, "pending");
  assert.equal(mapArthurStatus("Past").status, "ended");
  assert.equal(mapArthurStatus("Rejected").status, "ended");
});

test("custom fields are read from an object map or a list", () => {
  assert.equal(customField({ rra: "x" }, "rra"), "x");
  assert.equal(customField([{ name: "Other", value: 1 }, { label: "RRA", value: "y" }], "rra"), "y");
  assert.equal(customField([{ key: "nation", value: "Wales" }], "nation"), "Wales");
  assert.equal(customField(undefined, "rra"), undefined);
});

test("rra facts parse from JSON text or an object, and bad JSON is ignored", () => {
  assert.equal(readRraFacts({ rra: '{"advertisedRent":1200}' }).advertisedRent, 1200);
  assert.equal(readRraFacts([{ name: "rra", value: { rentInAdvance: 500 } }]).rentInAdvance, 500);
  assert.deepEqual(readRraFacts({ rra: "{not json" }), {});
});

test("unit, entity and tenant map cleanly", () => {
  const p = mapUnit({ id: 7, address_line_1: "12 Harborne Road", city: "Birmingham", postcode: "B15 3AA" });
  assert.deepEqual(p, { id: "7", address: "12 Harborne Road, Birmingham", postcode: "B15 3AA", nation: "England" });
  assert.equal(mapUnit({ id: 8, postcode: "CF10 1BS", custom_fields: { nation: "England" } }).nation, "England");
  assert.equal(mapUnit({ id: 9, postcode: "CF10 1BS" }).nation, "Wales");

  const l = mapEntity({ id: 3, first_name: "Asha", last_name: "Patel", custom_fields: [{ name: "landlord_register_number", value: "RR-1" }] });
  assert.equal(l.name, "Asha Patel");
  assert.equal(l.registrationNumber, "RR-1");
  assert.equal(mapEntity({ id: 4, company: "Lets Ltd" }).name, "Lets Ltd");

  assert.equal(mapTenant({ id: 5, title: "Ms", first_name: "Jo", last_name: "Bloggs" }).name, "Ms Jo Bloggs");
});

test("tenancy maps dates, rent, deposit, periodic flag and service records", () => {
  const t = mapArthurTenancy(
    {
      id: 101,
      unit_id: 7,
      status: "Periodic",
      start_date: "2024-03-01T00:00:00+00:00",
      end_date: "2025-02-28",
      rent_amount: "1150.00",
      rent_frequency: "Monthly",
      deposit_amount: 1300,
      deposit_held_by: "DPS Custodial",
      custom_fields: { rra: JSON.stringify({ hadWrittenAgreement: true, served: { "55": { date: "2026-05-10", tenantIds: ["5"] } } }) },
    },
    { landlordId: "3", tenantIds: ["5"], assets: [{ id: 55, name: "Information Sheet 2026.pdf" }, { id: 56, name: "Inventory" }] },
  );
  assert.equal(t.id, "101");
  assert.equal(t.propertyId, "7");
  assert.equal(t.status, "current");
  assert.equal(t.startDate, "2024-03-01");
  assert.equal(t.endDate, undefined);
  assert.equal(t.recordedType, "assuredPeriodic");
  assert.equal(t.rent, 1150);
  assert.equal(t.rentFrequency, "monthly");
  assert.equal(t.depositProtected, true);
  assert.equal(t.hadWrittenAgreement, true);
  assert.equal(t.documents[0].kind, "informationSheet2026");
  assert.equal(t.documents[0].servedDate, "2026-05-10");
  assert.deepEqual(t.documents[0].servedOnTenantIds, ["5"]);
  assert.equal(t.documents[1].kind, "other");

  const fixed = mapArthurTenancy({ id: 1, status: "Current", start_date: "2025-06-01", end_date: "2026-05-31", rent: 900, rent_frequency: "Weekly" }, { landlordId: "", tenantIds: [], assets: [] });
  assert.equal(fixed.endDate, "2026-05-31");
  assert.equal(fixed.recordedType, "assuredShorthold");
  assert.equal(fixed.rentFrequency, "weekly");
});

function fakeArthur(routes: Record<string, unknown>, log: { url: string; headers: Record<string, string> }[] = []) {
  let tokenCalls = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oauth/token")) {
      tokenCalls++;
      return new Response(JSON.stringify({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 }), { status: 200 });
    }
    const headers = init?.headers as Record<string, string>;
    log.push({ url: url.pathname + url.search, headers });
    if (headers.Authorization === "Bearer stale") return new Response(JSON.stringify({ error: "expired_token" }), { status: 401 });
    const key = url.pathname.replace("/v2", "") + (url.searchParams.get("page") ? `?page=${url.searchParams.get("page")}` : "");
    const body = routes[key] ?? routes[url.pathname.replace("/v2", "")];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, tokenCalls: () => tokenCalls };
}

test("client sends X-EntityID, refreshes on 401 and pages", async () => {
  const log: { url: string; headers: Record<string, string> }[] = [];
  const fake = fakeArthur(
    {
      "/tenancies?page=1": { data: [{ id: 1 }], pagination: { pageCount: 2 } },
      "/tenancies?page=2": { data: [{ id: 2 }], pagination: { pageCount: 2 } },
    },
    log,
  );
  const c = new ArthurClient({
    clientId: "id",
    clientSecret: "secret",
    entityId: "E42",
    tokens: { access_token: "stale", refresh_token: "r1" },
    apiBase: "https://api.test/v2",
    authBase: "https://auth.test/oauth",
    fetchImpl: fake.fetchImpl,
  });
  const rows = await c.getAll<{ id: number }>("/tenancies");
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);
  assert.equal(fake.tokenCalls(), 1);
  assert.ok(log.every((r) => r.headers["X-EntityID"] === "E42"));
  assert.equal(log.at(-1)?.headers.Authorization, "Bearer fresh");
  assert.match(log.at(-1)!.url, /limit=100/);
});

test("ArthurSource loads a snapshot the checks can run on", async () => {
  const fake = fakeArthur({
    "/tenancies": {
      data: [
        { id: 1, unit_id: 7, status: "Periodic", start_date: "2024-03-01", rent_amount: 1000, rent_frequency: "Monthly", custom_fields: { rra: '{"hadWrittenAgreement":true}' } },
        { id: 2, unit_id: 7, status: "Past", start_date: "2020-01-01" },
      ],
      pagination: { pageCount: 1 },
    },
    "/units/7": { data: { id: 7, address_line_1: "1 High St", city: "Leeds", postcode: "LS1 1AA", unit_owner_id: 3 } },
    "/entities/3": { data: { id: 3, name: "Owner One" } },
    "/tenancies/1/tenants": { data: [{ id: 5, first_name: "Jo", last_name: "Bloggs" }], pagination: { pageCount: 1 } },
    "/tenancies/1/assets": { data: [], pagination: { pageCount: 1 } },
  });
  const c = new ArthurClient({ clientId: "i", clientSecret: "s", entityId: "E", tokens: { access_token: "ok" }, apiBase: "https://api.test/v2", fetchImpl: fake.fetchImpl });
  const snap = await new ArthurSource(c, "Test agency").loadSnapshot();
  assert.equal(snap.tenancies.length, 1, "past tenancies are dropped");
  assert.equal(snap.tenancies[0].landlordId, "3");
  assert.deepEqual(snap.tenancies[0].tenantIds, ["5"]);
  assert.equal(snap.landlords[0].name, "Owner One");
  assert.equal(snap.properties[0].nation, "England");
  const { findings } = runChecks(snap, "2026-11-25");
  assert.ok(findings.some((f) => f.ruleId === "information-sheet"), "missing Information Sheet is flagged");
});

test("probe reports field names and types, never values", () => {
  const shape = shapeOf([{ id: 1, email: "a@b.c", tenants: [] }, { id: 2, email: null }]);
  assert.deepEqual(shape, { email: "null|string", id: "number", tenants: "array" });
  const r = fieldReport("tenants", [{ id: 1, email: "secret@example.com" }]);
  assert.deepEqual(r.missingExpected, ["first_name", "last_name"]);
  assert.ok(!JSON.stringify(r).includes("secret@example.com"));
});
