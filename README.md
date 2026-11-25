# Renters' Rights assistant

An MCP server and Claude plugin for letting agents in England. It checks every tenancy against the Renters' Rights Act 2025, lists what is missing or at risk, and drafts the letter or notice to fix it. A person reviews and sends every draft. Nothing is sent or written back to the CRM.

Status: **prototype (phase 2 of the plan)**. It runs on demo data today. The Reapit connector is written but has not yet been run against the Reapit sandbox.

> This is a screening tool, not legal advice. The rules in `src/rules/legislation.ts` need a solicitor's review before any agency relies on them.

## What it checks

| Check | Rule | Severity |
| --- | --- | --- |
| `periodic-tenancy` | New tenancies from 1 May 2026 cannot have a fixed end date; older records still marked shorthold are flagged for tidying | critical / info |
| `written-terms` | Written statement of terms for new tenancies; written summary for pre-May verbal tenancies (due 31 May 2026) | critical / warning |
| `information-sheet` | Information Sheet served on every named tenant of pre-May written tenancies (due 31 May 2026, fine up to £7,000) | critical |
| `rent-increase` | Once a year, through Section 13, at least 2 months' notice | critical / warning |
| `bidding-and-advance` | Agreed rent not above the advertised rent; at most one month's rent in advance | critical |
| `pet-requests` | Answer within 28 days; refusals need a reason | critical / warning |
| `landlord-register` | Register Your Rental Property: 3 months from the region's opening (West Midlands opens 15 Dec 2026), everyone by 14 Nov 2027 | info → critical |

Plus `check_possession`, which screens Section 8 grounds 1, 1A, 8 and 14 for notice periods, the 12-month rule, arrears thresholds and deposit protection.

Tenancies in Wales, Scotland and Northern Ireland are skipped and reported.

## MCP tools

All tools are read-only.

| Tool | What it does |
| --- | --- |
| `list_findings` | Every finding across the agency, most urgent first. Filter by severity or rule. |
| `check_tenancy` | One tenancy's details and findings. |
| `check_possession` | Can a Section 8 notice on this ground be served, and when could it take effect? |
| `draft_document` | Drafts a cover letter, Section 13 details, pet reply, landlord chaser, CRM update note or Section 8 summary. |
| `list_rules` | The rules, with their GOV.UK sources. |

## Quick start

Needs Node 20 or later.

```bash
npm ci
npm run build
npm test
```

Run on the demo agency (7 tenancies, 14 findings):

```bash
RRA_TODAY=2026-11-25 npm start            # stdio
RRA_TODAY=2026-11-25 npm run start:http   # http://127.0.0.1:3333/mcp
```

### Use it in Claude Code

The repo is also a Claude plugin, with three skills (`compliance-sweep`, `draft-for-approval`, `possession-check`) and the MCP server.

```bash
npm ci && npm run build
claude --plugin-dir .
```

Then ask: "Which tenancies are at risk this month?"

### Use it in Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "renters-rights": {
      "command": "node",
      "args": ["/absolute/path/to/renters-rights-assistant/dist/server.js"],
      "env": { "RRA_TODAY": "2026-11-25" }
    }
  }
}
```

## Connecting Reapit

1. Register on the [Reapit Developer Portal](https://developers.reapit.cloud) and create an app using the **client credentials** flow. The flow cannot be changed later.
2. Request read permissions for tenancies, properties, landlords, contacts and documents. Request the write scopes you will need later now, because adding scopes means every agency has to consent again.
3. Copy `.env.example` to `.env`, fill in the client id and secret, and set `REAPIT_CUSTOMER_ID=SBOX` for the sandbox.
4. Start the server. With the three Reapit variables set it reads from Reapit instead of the demo data.

Before trusting the output, check the field mapping in `src/reapit/mapper.ts` against real sandbox records. Facts Reapit does not hold (pet requests, who was served the Information Sheet, the advertised rent) are read from each tenancy's `metadata.rra` object for now.

## Layout

```
src/
  domain.ts            CRM-neutral types
  rules/legislation.ts Every legal date and period, with GOV.UK sources (solicitor reviews this)
  rules/checks.ts      The compliance checks
  rules/possession.ts  Section 8 screening
  drafts/templates.ts  Letter and notice drafts
  reapit/client.ts     Reapit Connect auth, paging, rate limits, 429 retries
  reapit/mapper.ts     Reapit records → domain model
  app.ts               MCP tools
  server.ts            stdio and HTTP entry point
skills/                Claude plugin skills
fixtures/              Demo agency data
test/                  32 tests (node:test)
```

## Next steps

- Run the mapper against the Reapit sandbox and fix field names.
- Postgres store for service records and pet requests, fed by Reapit webhooks.
- Write-back to Reapit (journal entries, documents) behind explicit approval.
- Solicitor review of `legislation.ts` and the draft wording.
