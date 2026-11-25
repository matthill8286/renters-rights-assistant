import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../src/app.ts";
import { FixtureSource } from "../src/data/source.ts";

async function connect() {
  const app = createApp({
    source: new FixtureSource(fileURLToPath(new URL("../fixtures/demo-agency.json", import.meta.url))),
    today: () => "2026-11-25",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([app.connect(a), client.connect(b)]);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

test("MCP server exposes the tools, all read-only", async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_possession", "check_tenancy", "draft_document", "list_findings", "list_rules"]);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
});

test("list_findings summarises and filters", async () => {
  const c = await connect();
  const all = textOf(await c.callTool({ name: "list_findings", arguments: {} }));
  assert.match(all, /8 critical, 3 warnings, 3 info/);
  assert.match(all, /Skipped 1: T6/);
  const pets = textOf(await c.callTool({ name: "list_findings", arguments: { ruleId: "pet-requests", severity: "critical" } }));
  assert.match(pets, /small dog/);
  assert.doesNotMatch(pets, /a cat/);
});

test("check_tenancy, check_possession and draft_document work end to end", async () => {
  const c = await connect();
  assert.match(textOf(await c.callTool({ name: "check_tenancy", arguments: { tenancyId: "T4" } })), /Pet request due soon/);
  const missing = await c.callTool({ name: "check_tenancy", arguments: { tenancyId: "NOPE" } });
  assert.equal(missing.isError, true);
  const p = JSON.parse(textOf(await c.callTool({ name: "check_possession", arguments: { tenancyId: "T4", ground: "1A" } })));
  assert.equal(p.earliestPossession, "2027-08-15");
  const d = textOf(await c.callTool({ name: "draft_document", arguments: { kind: "informationSheetCoverLetter", tenancyId: "T1" } }));
  assert.match(d, /Amy Clarke and Ben Okafor/);
  const bad = await c.callTool({ name: "draft_document", arguments: { kind: "section13Notice", tenancyId: "T1" } });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /proposedRent/);
});
