#!/usr/bin/env node
/**
 * One-off Arthur sign-in. Arthur only supports the OAuth authorization code
 * flow, so a person signs in once in a browser; this saves the tokens and the
 * server refreshes them from then on (refresh tokens last 21 days).
 *
 * 1. In Arthur: Settings > Account Settings > OAuth Applications > Add
 *    Application, with callback URL http://localhost:8765/callback
 * 2. Set ARTHUR_CLIENT_ID, ARTHUR_CLIENT_SECRET and ARTHUR_TOKEN_FILE.
 * 3. npm run arthur:auth, open the printed link and sign in.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ARTHUR_AUTH_BASE, exchangeToken } from "./client.js";

const clientId = process.env.ARTHUR_CLIENT_ID;
const clientSecret = process.env.ARTHUR_CLIENT_SECRET;
const tokenFile = process.env.ARTHUR_TOKEN_FILE ?? ".arthur-tokens.json";
const port = Number(process.env.ARTHUR_CALLBACK_PORT ?? 8765);
const redirectUri = `http://localhost:${port}/callback`;

if (!clientId || !clientSecret) {
  console.error("Set ARTHUR_CLIENT_ID and ARTHUR_CLIENT_SECRET first.");
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
const authorize = new URL(`${ARTHUR_AUTH_BASE}/authorize`);
authorize.searchParams.set("response_type", "code");
authorize.searchParams.set("client_id", clientId);
authorize.searchParams.set("redirect_uri", redirectUri);
authorize.searchParams.set("state", state);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("state") !== state) {
    res.writeHead(400).end("Missing code or state mismatch.");
    return;
  }
  try {
    const tokens = await exchangeToken({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      state,
    });
    await writeFile(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Signed in to Arthur. You can close this tab.");
    console.error(`Saved tokens to ${tokenFile}.`);
  } catch (e) {
    res.writeHead(500).end("Token exchange failed; see the terminal.");
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.error(`Open this link and sign in to Arthur:\n\n${authorize.toString()}\n`);
});
