#!/usr/bin/env node
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createApp } from "./app.js";
import { CachedSource, FixtureSource, type DataSource } from "./data/source.js";
import { ReapitClient } from "./reapit/client.js";
import { ReapitSource } from "./reapit/mapper.js";
import { assertIso } from "./dates.js";

function pickSource(): DataSource {
  const reapit = ReapitClient.fromEnv();
  if (reapit) return new CachedSource(new ReapitSource(reapit, process.env.AGENCY_NAME));
  const fixture = process.env.RRA_FIXTURE ?? fileURLToPath(new URL("../fixtures/demo-agency.json", import.meta.url));
  return new FixtureSource(fixture);
}

const source = pickSource();
const pinned = process.env.RRA_TODAY ? assertIso(process.env.RRA_TODAY) : undefined;
const today = pinned ? () => pinned : undefined;

function tokenOk(header: string | undefined, expected: string): boolean {
  const got = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

if (process.argv.includes("--http")) {
  const port = Number(process.env.PORT ?? 3333);
  const host = process.env.HOST ?? "127.0.0.1";
  const authToken = process.env.MCP_AUTH_TOKEN;
  if (!authToken && host !== "127.0.0.1" && host !== "localhost") {
    console.error("Refusing to listen on a public interface without MCP_AUTH_TOKEN set.");
    process.exit(1);
  }
  createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(req.url === "/health" ? 200 : 404).end(req.url === "/health" ? "ok" : "not found");
      return;
    }
    if (authToken && !tokenOk(req.headers.authorization, authToken)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("unauthorised");
      return;
    }
    // Stateless: a fresh server and transport per request.
    const server = createApp({ source, today });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(port, host, () => console.error(`renters-rights-assistant MCP on http://${host}:${port}/mcp (data: ${source.name})`));
} else {
  const server = createApp({ source, today });
  await server.connect(new StdioServerTransport());
  console.error(`renters-rights-assistant MCP on stdio (data: ${source.name})`);
}
