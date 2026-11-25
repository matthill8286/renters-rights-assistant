import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AgencySnapshot, Tenancy } from "../src/domain.ts";
import { runChecks } from "../src/rules/checks.ts";
import { addMonths, addDays } from "../src/dates.ts";

const demo = JSON.parse(readFileSync(new URL("../fixtures/demo-agency.json", import.meta.url), "utf8")) as AgencySnapshot;
const TODAY = "2026-11-25";

function base(overrides: Partial<Tenancy> = {}): AgencySnapshot {
  const t: Tenancy = {
    id: "T",
    propertyId: "P",
    landlordId: "L",
    tenantIds: ["C"],
    status: "current",
    startDate: "2026-06-01",
    recordedType: "assuredPeriodic",
    hadWrittenAgreement: true,
    rent: 1000,
    rentFrequency: "monthly",
    advertisedRent: 1000,
    rentInAdvance: 1000,
    depositAmount: 1150,
    depositProtected: true,
    rentChanges: [],
    petRequests: [],
    documents: [{ id: "D", kind: "writtenStatementOfTerms", name: "WS", servedDate: "2026-06-01", servedOnTenantIds: ["C"] }],
    ...overrides,
  };
  return {
    agencyId: "X",
    agencyName: "Test",
    properties: [{ id: "P", address: "1 Test St", postcode: "B1 1AA", nation: "England", region: "West Midlands" }],
    landlords: [{ id: "L", name: "Lan Lord", registrationNumber: "R1" }],
    tenants: [{ id: "C", name: "Ten Ant" }],
    tenancies: [t],
  };
}

const ids = (s: AgencySnapshot, today = TODAY) => runChecks(s, today).findings.map((f) => `${f.ruleId}:${f.severity}`);

test("dates: month arithmetic clamps to month end", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-05-20", 2), "2026-07-20");
  assert.equal(addMonths("2026-12-15", 3), "2027-03-15");
  assert.equal(addDays("2026-10-10", 28), "2026-11-07");
});

test("a compliant new tenancy has no findings", () => {
  assert.deepEqual(ids(base()), []);
});

test("new tenancy with a fixed end date is critical", () => {
  assert.ok(ids(base({ endDate: "2027-05-31" })).includes("periodic-tenancy:critical"));
});

test("old tenancy still recorded as shorthold is info only", () => {
  const s = base({
    startDate: "2024-01-01",
    endDate: "2025-01-01",
    recordedType: "assuredShorthold",
    documents: [{ id: "I", kind: "informationSheet2026", name: "IS", servedOnTenantIds: ["C"] }],
  });
  assert.deepEqual(ids(s), ["periodic-tenancy:info"]);
});

test("new tenancy without a written statement is critical", () => {
  assert.ok(ids(base({ documents: [] })).includes("written-terms:critical"));
});

test("verbal pre-May tenancy without a summary: warning before 31 May, critical after", () => {
  const s = base({ startDate: "2020-01-01", hadWrittenAgreement: false, documents: [] });
  assert.ok(ids(s, "2026-05-15").includes("written-terms:warning"));
  assert.ok(ids(s, "2026-06-01").includes("written-terms:critical"));
});

test("information sheet must reach every named tenant", () => {
  const s = base({
    startDate: "2024-01-01",
    tenantIds: ["C", "C2"],
    documents: [{ id: "I", kind: "informationSheet2026", name: "IS", servedOnTenantIds: ["C"] }],
  });
  s.tenants.push({ id: "C2", name: "Second Tenant" });
  const f = runChecks(s, TODAY).findings.find((x) => x.ruleId === "information-sheet");
  assert.ok(f);
  assert.equal(f.severity, "critical");
  assert.match(f.detail, /Second Tenant/);
  assert.doesNotMatch(f.detail, /Ten Ant/);
});

test("rent increase within 12 months of the last is flagged", () => {
  const s = base({
    startDate: "2024-01-01",
    documents: [{ id: "I", kind: "informationSheet2026", name: "IS", servedOnTenantIds: ["C"] }],
    rentChanges: [
      { effectiveDate: "2026-06-01", previousRent: 950, newRent: 1000, method: "section13", noticeServedDate: "2026-03-01" },
      { effectiveDate: "2027-01-01", previousRent: 1000, newRent: 1050, method: "section13", noticeServedDate: "2026-10-01", planned: true },
    ],
  });
  const f = runChecks(s, TODAY).findings.filter((x) => x.ruleId === "rent-increase");
  assert.equal(f.length, 1);
  assert.equal(f[0]?.severity, "critical");
  assert.match(f[0]!.detail, /1 June 2027/);
});

test("rent increase with under two months' notice is flagged", () => {
  const s = base({
    rentChanges: [{ effectiveDate: "2027-07-01", previousRent: 1000, newRent: 1050, method: "section13", noticeServedDate: "2027-05-15", planned: true }],
  });
  assert.ok(ids(s).includes("rent-increase:critical"));
});

test("valid Section 13 increase passes", () => {
  const s = base({
    rentChanges: [{ effectiveDate: "2027-08-01", previousRent: 1000, newRent: 1050, method: "section13", noticeServedDate: "2027-05-15", planned: true }],
  });
  assert.deepEqual(ids(s), []);
});

test("bidding above advert and excess rent in advance are critical", () => {
  const f = ids(base({ rent: 1050, rentInAdvance: 2100 }));
  assert.equal(f.filter((x) => x === "bidding-and-advance:critical").length, 2);
});

test("weekly rent: one month in advance is allowed", () => {
  // £200 a week = £866.67 a month
  assert.deepEqual(ids(base({ rent: 200, rentFrequency: "weekly", advertisedRent: 200, rentInAdvance: 866.67 })), []);
  assert.ok(ids(base({ rent: 200, rentFrequency: "weekly", advertisedRent: 200, rentInAdvance: 900 })).includes("bidding-and-advance:critical"));
});

test("pet requests: due soon is a warning, overdue is critical, refusal needs a reason", () => {
  assert.ok(ids(base({ petRequests: [{ id: "p", receivedDate: "2026-11-01", description: "cat" }] })).includes("pet-requests:warning"));
  assert.ok(ids(base({ petRequests: [{ id: "p", receivedDate: "2026-10-01", description: "cat" }] })).includes("pet-requests:critical"));
  assert.deepEqual(ids(base({ petRequests: [{ id: "p", receivedDate: "2026-11-20", description: "cat" }] })), []);
  assert.ok(
    ids(base({ petRequests: [{ id: "p", receivedDate: "2026-10-01", description: "cat", respondedDate: "2026-10-10", decision: "refused" }] })).includes(
      "pet-requests:warning",
    ),
  );
});

test("landlord register: West Midlands landlord gets the 15 March 2027 deadline", () => {
  const s = base();
  s.landlords[0]!.registrationNumber = undefined;
  const f = runChecks(s, TODAY).findings.find((x) => x.ruleId === "landlord-register");
  assert.equal(f?.dueDate, "2027-03-15");
  assert.equal(f?.severity, "info");
  assert.equal(runChecks(s, "2026-12-20").findings.find((x) => x.ruleId === "landlord-register")?.severity, "warning");
  assert.equal(runChecks(s, "2027-03-16").findings.find((x) => x.ruleId === "landlord-register")?.severity, "critical");
});

test("Wales and ended tenancies are not checked", () => {
  const s = base({ endDate: "2027-01-01" });
  s.properties[0]!.nation = "Wales";
  const r = runChecks(s, TODAY);
  assert.deepEqual(r.findings.filter((f) => f.tenancyId), []);
  assert.equal(r.skipped.length, 1);
  assert.deepEqual(ids(base({ status: "ended", documents: [] })), []);
});

test("demo agency produces the expected spread of findings", () => {
  const r = runChecks(demo, TODAY);
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of r.findings) counts[f.severity]++;
  assert.deepEqual(counts, { critical: 8, warning: 3, info: 3 });
  assert.equal(r.findings[0]?.severity, "critical");
});
