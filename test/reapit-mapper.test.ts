import { test } from "node:test";
import assert from "node:assert/strict";
import { documentKind, guessNation, mapProperty, mapTenancy } from "../src/reapit/mapper.ts";
import { ReapitClient } from "../src/reapit/client.ts";

test("document names map to the kinds the rules need", () => {
  assert.equal(documentKind({ id: "1", name: "Renters' Rights Act Information Sheet 2026.pdf" }), "informationSheet2026");
  assert.equal(documentKind({ id: "1", name: "Written statement of terms" }), "writtenStatementOfTerms");
  assert.equal(documentKind({ id: "1", name: "Deposit Prescribed Information" }), "depositPrescribedInformation");
  assert.equal(documentKind({ id: "1", name: "Form 3A notice" }), "section8Notice");
  assert.equal(documentKind({ id: "1", name: "Inventory" }), "other");
});

test("nation guess from postcode, metadata wins", () => {
  assert.equal(guessNation({ id: "p", address: { postcode: "CF10 1BS" } }), "Wales");
  assert.equal(guessNation({ id: "p", address: { postcode: "EH1 1YZ" } }), "Scotland");
  assert.equal(guessNation({ id: "p", address: { postcode: "BT1 5GS" } }), "Northern Ireland");
  assert.equal(guessNation({ id: "p", address: { postcode: "B15 3AA" } }), "England");
  assert.equal(guessNation({ id: "p", address: { postcode: "CF10 1BS" }, metadata: { rra: { nation: "England" } } }), "England");
});

test("property address is joined cleanly", () => {
  const p = mapProperty({ id: "p", address: { buildingNumber: "12", line1: "Harborne Road", line3: "Birmingham", postcode: "B15 3AA" } });
  assert.equal(p.address, "12, Harborne Road, Birmingham");
  assert.equal(p.nation, "England");
});

test("tenancy maps status, frequency, periodic flag and service records", () => {
  const t = mapTenancy(
    {
      id: "T",
      propertyId: "P",
      landlordId: "L",
      status: "current",
      startDate: "2024-01-01T00:00:00Z",
      endDate: "2025-01-01",
      isPeriodic: false,
      rent: 1200,
      rentFrequency: "annually",
      deposit: { sum: 1300, protected: true },
      metadata: { rra: { served: { D1: { date: "2026-05-10", tenantIds: ["C1"] } }, advertisedRent: 1200 } },
    },
    ["C1"],
    [{ id: "D1", name: "Information Sheet" }],
  );
  assert.equal(t.rentFrequency, "yearly");
  assert.equal(t.startDate, "2024-01-01");
  assert.equal(t.recordedType, "assuredShorthold");
  assert.equal(t.documents[0]?.kind, "informationSheet2026");
  assert.deepEqual(t.documents[0]?.servedOnTenantIds, ["C1"]);
  assert.equal(t.depositProtected, true);
});

test("client sends Reapit headers, pages, and retries a 429", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let tokenCalls = 0;
  let throttled = false;
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/token")) {
      tokenCalls++;
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    calls.push({ url, headers: init?.headers as Record<string, string> });
    if (!throttled) {
      throttled = true;
      return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    }
    const page = Number(new URL(url).searchParams.get("pageNumber"));
    return new Response(JSON.stringify({ _embedded: [{ id: `t${page}` }], pageNumber: page, pageSize: 100, pageCount: 2, totalCount: 2 }), { status: 200 });
  }) as typeof fetch;

  const c = new ReapitClient({ clientId: "id", clientSecret: "secret", customerId: "SBOX", fetchImpl: fakeFetch });
  const all = await c.getAll<{ id: string }>("/tenancies", { status: ["current"] });
  assert.deepEqual(all.map((x) => x.id), ["t1", "t2"]);
  assert.equal(tokenCalls, 1);
  assert.equal(calls[0]?.headers["reapit-customer"], "SBOX");
  assert.equal(calls[0]?.headers["api-version"], "2020-01-31");
  assert.match(calls[0]!.url, /pageSize=100/);
});
