import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DataSource } from "./data/source.js";
import type { DraftKind, Finding, IsoDate } from "./domain.js";
import { assertIso, formatLong } from "./dates.js";
import { RULES, runChecks } from "./rules/checks.js";
import { GROUNDS, RULESET_VERSION } from "./rules/legislation.js";
import { checkPossession } from "./rules/possession.js";
import { DRAFT_KINDS, buildDraft, renderDraft } from "./drafts/templates.js";

export interface AppOptions {
  source: DataSource;
  /** Injected so tests and demos can pin the date. */
  today?: () => IsoDate;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => JSON.stringify(v, null, 2);

function describeFinding(f: Finding, i: number): string {
  const where = f.tenancyId ? `tenancy ${f.tenancyId}` : f.landlordId ? `landlord ${f.landlordId}` : "";
  return [
    `${i + 1}. [${f.severity.toUpperCase()}] ${f.title} (${where}, rule ${f.ruleId})`,
    `   ${f.detail}`,
    `   Next step: ${f.action}`,
    f.dueDate ? `   Due: ${formatLong(f.dueDate)}` : "",
    f.draft ? `   Draft available: ${f.draft}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function createApp({ source, today = () => new Date().toISOString().slice(0, 10) }: AppOptions): McpServer {
  const server = new McpServer(
    { name: "renters-rights-assistant", version: "0.1.0" },
    {
      instructions:
        "Checks a letting agency's tenancies in England against the Renters' Rights Act 2025 and drafts fixes. " +
        "Everything is read-only: drafts are for a person to review and send. Never present output as legal advice. " +
        "Start with list_findings for an overview, then check_tenancy or draft_document for detail.",
    },
  );

  server.registerTool(
    "list_findings",
    {
      title: "List compliance findings",
      description:
        "Runs every Renters' Rights Act check across the agency and returns findings, most urgent first. Use for questions like 'which tenancies are at risk?'",
      inputSchema: {
        severity: z.enum(["critical", "warning", "info"]).optional().describe("Only return findings of this severity"),
        ruleId: z.string().optional().describe("Only return findings from this rule (see list_rules)"),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum findings to return (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ severity, ruleId, limit }) => {
      const snapshot = await source.loadSnapshot();
      const { findings, skipped } = runChecks(snapshot, today());
      const filtered = findings.filter((f) => (!severity || f.severity === severity) && (!ruleId || f.ruleId === ruleId));
      const shown = filtered.slice(0, limit ?? 50);
      const counts = { critical: 0, warning: 0, info: 0 };
      for (const f of findings) counts[f.severity]++;
      const header =
        `${snapshot.agencyName}: ${snapshot.tenancies.length} tenancies checked on ${formatLong(today())} (rules version ${RULESET_VERSION}).\n` +
        `Totals: ${counts.critical} critical, ${counts.warning} warnings, ${counts.info} info.` +
        (skipped.length ? `\nSkipped ${skipped.length}: ${skipped.map((s) => `${s.tenancyId} (${s.reason})`).join("; ")}.` : "");
      const body = shown.length ? shown.map(describeFinding).join("\n\n") : "No findings match.";
      const more = filtered.length > shown.length ? `\n\n${filtered.length - shown.length} more not shown.` : "";
      return text(`${header}\n\n${body}${more}`);
    },
  );

  server.registerTool(
    "check_tenancy",
    {
      title: "Check one tenancy",
      description: "Runs every check on one tenancy and returns its details and findings.",
      inputSchema: { tenancyId: z.string().describe("Tenancy id from the CRM") },
      annotations: { readOnlyHint: true },
    },
    async ({ tenancyId }) => {
      const snapshot = await source.loadSnapshot();
      const t = snapshot.tenancies.find((x) => x.id === tenancyId);
      if (!t) return { ...text(`Tenancy ${tenancyId} not found.`), isError: true };
      const property = snapshot.properties.find((p) => p.id === t.propertyId);
      const landlord = snapshot.landlords.find((l) => l.id === t.landlordId);
      const tenants = t.tenantIds.map((id) => snapshot.tenants.find((x) => x.id === id)?.name ?? id);
      const { findings, skipped } = runChecks(snapshot, today(), tenancyId);
      const summary = [
        `Tenancy ${t.id}: ${property ? `${property.address}, ${property.postcode}` : t.propertyId}`,
        `Tenants: ${tenants.join(", ")}. Landlord: ${landlord?.name ?? t.landlordId}.`,
        `Started ${formatLong(t.startDate)}. Rent £${t.rent} ${t.rentFrequency}. Status ${t.status}.`,
        `Documents: ${t.documents.length ? t.documents.map((d) => d.name).join(", ") : "none recorded"}.`,
      ].join("\n");
      const body = skipped.length
        ? `Not checked: ${skipped[0]?.reason}.`
        : findings.length
          ? findings.map(describeFinding).join("\n\n")
          : "No issues found.";
      return text(`${summary}\n\n${body}`);
    },
  );

  server.registerTool(
    "check_possession",
    {
      title: "Check a Section 8 possession ground",
      description:
        "Screens whether a Section 8 notice on a ground could be served now, and when possession could earliest take effect. Supported grounds: " +
        Object.values(GROUNDS)
          .map((g) => `${g.ground} (${g.name})`)
          .join(", ") +
        ". A screening aid, not legal advice.",
      inputSchema: {
        tenancyId: z.string(),
        ground: z.string().describe("Ground number, for example 1A or 8"),
        serveDate: z.string().optional().describe("Planned date of service, YYYY-MM-DD. Defaults to today."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tenancyId, ground, serveDate }) => {
      const snapshot = await source.loadSnapshot();
      const t = snapshot.tenancies.find((x) => x.id === tenancyId);
      if (!t) return { ...text(`Tenancy ${tenancyId} not found.`), isError: true };
      const result = checkPossession(t, ground, assertIso(serveDate ?? today()));
      return text(json(result));
    },
  );

  server.registerTool(
    "draft_document",
    {
      title: "Draft a letter or notice",
      description:
        "Drafts a letter, email or notice details for a person to review. Never sends anything. Kinds: " + DRAFT_KINDS.join(", ") + ".",
      inputSchema: {
        kind: z.enum(DRAFT_KINDS as [DraftKind, ...DraftKind[]]),
        tenancyId: z.string().optional(),
        landlordId: z.string().optional().describe("For landlordRegisterChaser"),
        options: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe("Extra fields: proposedRent and serveDate (section13Notice); petRequestId, decision, reason (petRequestReply); ground (section8NoticeSummary)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, tenancyId, landlordId, options }) => {
      const snapshot = await source.loadSnapshot();
      try {
        const d = buildDraft(kind, { snapshot, tenancyId, landlordId, today: today(), options });
        return text(renderDraft(d));
      } catch (e) {
        return { ...text(`Could not draft ${kind}: ${(e as Error).message}`), isError: true };
      }
    },
  );

  server.registerTool(
    "list_rules",
    {
      title: "List the rules",
      description: "Lists every check, what it looks for and the GOV.UK pages it rests on.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        `Rules version ${RULESET_VERSION}. England only.\n\n` +
          RULES.map((r) => `${r.id}: ${r.title}\n  ${r.summary}\n  Sources: ${r.sources.join(", ")}`).join("\n\n"),
      ),
  );

  return server;
}
