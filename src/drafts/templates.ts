import type { AgencySnapshot, DraftKind, IsoDate, Landlord, Property, Tenancy, Tenant } from "../domain.js";
import { addMonths, formatLong } from "../dates.js";
import { LAW, SOURCES } from "../rules/legislation.js";

/**
 * Drafts are plain text for a person to review, edit and send. Nothing here
 * sends anything or writes to the CRM. Every draft carries a review banner.
 */

export interface Draft {
  kind: DraftKind;
  title: string;
  to: string[];
  subject: string;
  body: string;
  /** Things the agent must check or fill in before sending. */
  checklist: string[];
  sources: string[];
}

export interface DraftInput {
  snapshot: AgencySnapshot;
  tenancyId?: string;
  landlordId?: string;
  today: IsoDate;
  /** Extra fields some drafts need, such as a proposed rent. */
  options?: Record<string, string | number | undefined>;
}

const BANNER = "DRAFT FOR REVIEW. Check every detail before sending. This is not legal advice.";

function lookup(input: DraftInput) {
  const { snapshot } = input;
  const tenancy = input.tenancyId ? snapshot.tenancies.find((t) => t.id === input.tenancyId) : undefined;
  if (input.tenancyId && !tenancy) throw new Error(`Tenancy ${input.tenancyId} not found`);
  const landlordId = input.landlordId ?? tenancy?.landlordId;
  const landlord = landlordId ? snapshot.landlords.find((l) => l.id === landlordId) : undefined;
  const property = tenancy ? snapshot.properties.find((p) => p.id === tenancy.propertyId) : undefined;
  const tenants: Tenant[] = tenancy ? tenancy.tenantIds.map((id) => snapshot.tenants.find((x) => x.id === id)).filter((x): x is Tenant => !!x) : [];
  return { tenancy, landlord, property, tenants };
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`This draft needs ${what}`);
  return v;
}

const names = (ts: Tenant[]) => ts.map((t) => t.name).join(" and ") || "[tenant name]";
const emails = (ts: Tenant[]) => ts.map((t) => t.email).filter((e): e is string => !!e);
const addr = (p?: Property) => (p ? `${p.address}, ${p.postcode}` : "[property address]");
const PER: Record<Tenancy["rentFrequency"], string> = { weekly: "week", fortnightly: "fortnight", monthly: "month", quarterly: "quarter", yearly: "year" };
const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Builder = (input: DraftInput) => Draft;

const builders: Record<DraftKind, Builder> = {
  informationSheetCoverLetter(input) {
    const { tenancy, property, tenants } = lookup(input);
    need(tenancy, "a tenancy");
    return {
      kind: "informationSheetCoverLetter",
      title: "Cover letter for the Renters' Rights Act Information Sheet",
      to: emails(tenants),
      subject: `Important information about your tenancy at ${addr(property)}`,
      body: [
        BANNER,
        "",
        `Dear ${names(tenants)},`,
        "",
        `The law on renting in England changed on 1 May 2026. Your tenancy at ${addr(property)} is now an assured periodic tenancy. This means it has no fixed end date, and you can end it by giving two months' notice.`,
        "",
        "We are required to give every tenant the government's Renters' Rights Act Information Sheet. A copy is attached. Please keep it with your tenancy documents.",
        "",
        "If you have any questions, please reply to this email.",
        "",
        "Kind regards,",
        "[Your name]",
        `${input.snapshot.agencyName}`,
      ].join("\n"),
      checklist: [
        "Attach the current Information Sheet from GOV.UK, not an older copy.",
        "Send to every named tenant, including any without an email address (post or hand delivery).",
        "Record the date and method of service against each tenant in the CRM.",
      ],
      sources: [SOURCES.informationSheet],
    };
  },

  writtenStatementCoverLetter(input) {
    const { tenancy, property, tenants, landlord } = lookup(input);
    const t = need(tenancy, "a tenancy");
    return {
      kind: "writtenStatementCoverLetter",
      title: "Cover letter for the written statement of terms",
      to: emails(tenants),
      subject: `Written statement of your tenancy terms, ${addr(property)}`,
      body: [
        BANNER,
        "",
        `Dear ${names(tenants)},`,
        "",
        `Please find attached the written statement of the terms of your tenancy at ${addr(property)}, which began on ${formatLong(t.startDate)}.`,
        "",
        "Your tenancy is an assured periodic tenancy. It runs from month to month with no fixed end date. You can end it by giving at least two months' notice in writing.",
        "",
        `Your rent is ${gbp(t.rent)} per ${PER[t.rentFrequency]}. Your landlord is ${landlord?.name ?? "[landlord name]"}.`,
        "",
        "Please read the statement and keep it safe. Let us know if anything in it is wrong.",
        "",
        "Kind regards,",
        "[Your name]",
        `${input.snapshot.agencyName}`,
      ].join("\n"),
      checklist: [
        "Attach the written statement itself, prepared from your solicitor-approved template.",
        "Make sure the statement has no fixed term or break clause.",
        "If the tenancy record shows an end date, clear it in the CRM.",
        "Record the date the statement was given.",
      ],
      sources: [SOURCES.overview, SOURCES.roadmap],
    };
  },

  section13Notice(input) {
    const { tenancy, property, tenants, landlord } = lookup(input);
    const t = need(tenancy, "a tenancy");
    const proposed = Number(need(input.options?.proposedRent, "options.proposedRent"));
    const serve = (input.options?.serveDate as string | undefined) ?? input.today;
    const minStart = addMonths(serve, LAW.rentIncrease.minNoticeMonths);
    const lastIncrease = t.rentChanges
      .filter((c) => c.newRent > c.previousRent && !c.planned)
      .map((c) => c.effectiveDate)
      .sort()
      .at(-1);
    const yearRule = lastIncrease ? addMonths(lastIncrease, LAW.rentIncrease.minMonthsBetweenIncreases) : undefined;
    const start = yearRule && yearRule > minStart ? yearRule : minStart;
    return {
      kind: "section13Notice",
      title: "Section 13 rent increase: details for the prescribed form",
      to: emails(tenants),
      subject: `Notice of proposed rent increase, ${addr(property)}`,
      body: [
        BANNER,
        "",
        "Use the current prescribed Section 13 form from GOV.UK. Details to enter:",
        "",
        `Property: ${addr(property)}`,
        `Tenant(s): ${names(tenants)}`,
        `Landlord: ${landlord?.name ?? "[landlord name]"}`,
        `Current rent: ${gbp(t.rent)} per ${PER[t.rentFrequency]}`,
        `Proposed rent: ${gbp(proposed)} per ${PER[t.rentFrequency]}`,
        `Date notice served: ${formatLong(serve)}`,
        `Earliest start date for the new rent: ${formatLong(start)}`,
        lastIncrease ? `Last increase took effect: ${formatLong(lastIncrease)}` : "No earlier increase is recorded.",
        "",
        "Cover note to the tenant:",
        "",
        `Dear ${names(tenants)},`,
        "",
        `Your landlord proposes to change the rent for ${addr(property)} from ${gbp(t.rent)} to ${gbp(proposed)} per ${PER[t.rentFrequency]}, starting on ${formatLong(start)}. The formal notice is attached. If you think the new rent is above the market rate, you can challenge it; the notice explains how.`,
        "",
        "Kind regards,",
        "[Your name]",
        `${input.snapshot.agencyName}`,
      ].join("\n"),
      checklist: [
        "Use the latest prescribed form from GOV.UK.",
        "Check the proposed rent against local market rents, since tenants can challenge it.",
        "Keep proof of the date the notice was served.",
        "Record the planned increase in the CRM so the once-a-year check stays accurate.",
      ],
      sources: [SOURCES.overview, SOURCES.roadmap],
    };
  },

  petRequestReply(input) {
    const { tenancy, property, tenants, landlord } = lookup(input);
    const t = need(tenancy, "a tenancy");
    const requestId = input.options?.petRequestId as string | undefined;
    const req = (requestId ? t.petRequests.find((p) => p.id === requestId) : undefined) ?? t.petRequests.find((p) => !p.respondedDate) ?? t.petRequests.at(-1);
    const r = need(req, "a pet request on this tenancy");
    const decision = (input.options?.decision as string | undefined) ?? r.decision ?? "[approved or refused]";
    const reason = (input.options?.reason as string | undefined) ?? r.refusalReason;
    const refused = decision === "refused";
    return {
      kind: "petRequestReply",
      title: "Reply to a pet request",
      to: emails(tenants),
      subject: `Your request to keep a pet at ${addr(property)}`,
      body: [
        BANNER,
        "",
        `Dear ${names(tenants)},`,
        "",
        `Thank you for your request of ${formatLong(r.receivedDate)} to keep ${r.description} at ${addr(property)}.`,
        "",
        refused
          ? `${landlord?.name ?? "Your landlord"} has decided not to agree to this request, for the following reason: ${reason ?? "[reason must be given]"}.`
          : decision === "approved"
            ? `${landlord?.name ?? "Your landlord"} is happy to agree to this request. [Add any reasonable conditions here.]`
            : "[State the landlord's decision here. A refusal must include the reason.]",
        "",
        "If you have any questions, please reply to this email.",
        "",
        "Kind regards,",
        "[Your name]",
        `${input.snapshot.agencyName}`,
      ].join("\n"),
      checklist: [
        "Confirm the decision in writing with the landlord first.",
        "A refusal must give a reason, and the reason must be reasonable.",
        `Send within ${LAW.pets.responseDays} days of the request.`,
        "Record the response date and decision in the CRM.",
      ],
      sources: [SOURCES.overview],
    };
  },

  landlordRegisterChaser(input) {
    const { landlord } = lookup(input);
    const l: Landlord = need(landlord, "a landlord");
    const props = input.snapshot.tenancies
      .filter((t) => t.landlordId === l.id && t.status !== "ended")
      .map((t) => input.snapshot.properties.find((p) => p.id === t.propertyId))
      .filter((p): p is Property => !!p && p.nation === "England");
    const regions = [...new Set(props.map((p) => p.region).filter(Boolean))] as string[];
    const opens = regions.map((r) => LAW.landlordRegister.regionOpens[r]).filter(Boolean).sort().at(0);
    const due = opens ? addMonths(opens, LAW.landlordRegister.monthsToRegister) : LAW.landlordRegister.finalDeadline;
    return {
      kind: "landlordRegisterChaser",
      title: "Landlord register reminder",
      to: l.email ? [l.email] : [],
      subject: "Action needed: registering your rental properties",
      body: [
        BANNER,
        "",
        `Dear ${l.name},`,
        "",
        "The government's new register for private landlords, Register Your Rental Property, is opening region by region. Every landlord in England must register each property they let.",
        "",
        opens
          ? `Registration opens in your area on ${formatLong(opens)}. You will need to register by ${formatLong(due)}.`
          : `The opening date for your area has not been announced yet. Everyone must be registered by ${formatLong(LAW.landlordRegister.finalDeadline)}.`,
        "",
        "Properties we manage for you that need registering:",
        ...props.map((p) => `- ${addr(p)}`),
        "",
        "We can enter the details for you if you would like, though the legal responsibility stays with you. Please send us your registration number once you have it so we can keep our records up to date.",
        "",
        "Kind regards,",
        "[Your name]",
        `${input.snapshot.agencyName}`,
      ].join("\n"),
      checklist: [
        "Check the region opening dates on GOV.UK, as more are announced.",
        "Confirm the property list with the landlord.",
        "Record the registration number in the CRM when received.",
      ],
      sources: [SOURCES.landlordRegister],
    };
  },

  recordUpdateNote(input) {
    const { tenancy, property } = lookup(input);
    const t = need(tenancy, "a tenancy");
    return {
      kind: "recordUpdateNote",
      title: "CRM record update",
      to: [],
      subject: `Update tenancy record ${t.id}`,
      body: [
        BANNER,
        "",
        `Tenancy ${t.id} at ${addr(property)} started on ${formatLong(t.startDate)}.`,
        "It became an assured periodic tenancy on 1 May 2026.",
        "",
        "Changes to make in the CRM:",
        t.endDate ? `- Clear the end date (${formatLong(t.endDate)}).` : "- No end date to clear.",
        t.recordedType === "assuredShorthold" ? "- Change the tenancy type from assured shorthold to periodic." : "- Check the tenancy type is periodic.",
        "- Cancel any renewal or Section 21 reminders on this tenancy.",
      ].join("\n"),
      checklist: ["Make the changes in the CRM.", "Tell the landlord if they expected a renewal date."],
      sources: [SOURCES.roadmap],
    };
  },

  section8NoticeSummary(input) {
    const { tenancy, property, tenants } = lookup(input);
    need(tenancy, "a tenancy");
    const ground = String(need(input.options?.ground, "options.ground"));
    return {
      kind: "section8NoticeSummary",
      title: "Section 8 notice preparation summary",
      to: [],
      subject: `Possession notice, ground ${ground}, ${addr(property)}`,
      body: [
        BANNER,
        "",
        `Tenant(s): ${names(tenants)}`,
        `Property: ${addr(property)}`,
        `Ground: ${ground}`,
        "",
        "Run the possession check tool for notice dates and blockers, then complete Form 3A. Have a solicitor review the notice before it is served.",
      ].join("\n"),
      checklist: ["Use the current Form 3A.", "Have a solicitor review before serving.", "Keep proof of service."],
      sources: [SOURCES.possessionGrounds, SOURCES.repossessing],
    };
  },
};

export const DRAFT_KINDS = Object.keys(builders) as DraftKind[];

export function buildDraft(kind: DraftKind, input: DraftInput): Draft {
  const b = builders[kind];
  if (!b) throw new Error(`Unknown draft kind: ${kind}`);
  return b(input);
}

export function renderDraft(d: Draft): string {
  return [
    `# ${d.title}`,
    "",
    `To: ${d.to.length ? d.to.join(", ") : "(no email on file)"}`,
    `Subject: ${d.subject}`,
    "",
    d.body,
    "",
    "## Before sending",
    ...d.checklist.map((c) => `- [ ] ${c}`),
    "",
    "## Sources",
    ...d.sources.map((s) => `- ${s}`),
  ].join("\n");
}

