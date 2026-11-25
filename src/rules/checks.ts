import type { AgencySnapshot, Finding, IsoDate, Landlord, Property, Tenancy } from "../domain.js";
import { addDays, addMonths, daysBetween, formatLong } from "../dates.js";
import { LAW, SOURCES } from "./legislation.js";

export interface RuleContext {
  today: IsoDate;
  snapshot: AgencySnapshot;
  property?: Property;
  landlord?: Landlord;
}

export interface Rule {
  id: string;
  title: string;
  summary: string;
  sources: string[];
  /** Per-tenancy rules return findings for that tenancy. */
  checkTenancy?: (t: Tenancy, ctx: RuleContext) => Finding[];
  /** Per-landlord rules run once per landlord. */
  checkLandlord?: (l: Landlord, ctx: RuleContext & { tenancies: Tenancy[] }) => Finding[];
}

const fmtGbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const hasDoc = (t: Tenancy, kind: Tenancy["documents"][number]["kind"]) => t.documents.some((d) => d.kind === kind);

/** Tenants on the tenancy who have no recorded service of a document of this kind. */
function tenantsNotServed(t: Tenancy, kind: Tenancy["documents"][number]["kind"]): string[] {
  const served = new Set(t.documents.filter((d) => d.kind === kind).flatMap((d) => d.servedOnTenantIds ?? []));
  return t.tenantIds.filter((id) => !served.has(id));
}

function monthlyRent(t: Tenancy): number {
  switch (t.rentFrequency) {
    case "weekly":
      return (t.rent * 52) / 12;
    case "fortnightly":
      return (t.rent * 26) / 12;
    case "monthly":
      return t.rent;
    case "quarterly":
      return t.rent / 3;
    case "yearly":
      return t.rent / 12;
  }
}

// ---------------------------------------------------------------------------
// 1. Tenancy health check: periodic tenancies, written terms, Information Sheet
// ---------------------------------------------------------------------------

export const periodicTenancy: Rule = {
  id: "periodic-tenancy",
  title: "Tenancy must be assured periodic",
  summary:
    "From 1 May 2026 assured shorthold tenancies became assured periodic tenancies, and new tenancies cannot have a fixed end date.",
  sources: [SOURCES.roadmap, SOURCES.overview],
  checkTenancy(t) {
    if (t.status === "ended") return [];
    const out: Finding[] = [];
    const startedAfter = t.startDate >= LAW.commencement;
    if (startedAfter && t.endDate) {
      out.push({
        ruleId: this.id,
        severity: "critical",
        tenancyId: t.id,
        title: "New tenancy has a fixed end date",
        detail: `This tenancy started on ${formatLong(t.startDate)} with an end date of ${formatLong(t.endDate)}. Tenancies created from 1 May 2026 must be periodic, and a fixed term can lead to a fine.`,
        action: "Remove the fixed term, issue a corrected written statement of terms and update the CRM record.",
        draft: "writtenStatementCoverLetter",
      });
    } else if (!startedAfter && (t.endDate || t.recordedType === "assuredShorthold")) {
      out.push({
        ruleId: this.id,
        severity: "info",
        tenancyId: t.id,
        title: "CRM still shows a fixed-term or shorthold tenancy",
        detail:
          "This tenancy converted to an assured periodic tenancy on 1 May 2026 by law. The CRM record still shows a fixed end date or an assured shorthold type, which can cause wrong renewal or notice reminders.",
        action: "Update the tenancy type to periodic and clear the end date in the CRM.",
        draft: "recordUpdateNote",
      });
    }
    return out;
  },
};

export const writtenTerms: Rule = {
  id: "written-terms",
  title: "Tenancy terms must be in writing",
  summary:
    "New tenancies from 1 May 2026 need a written statement of terms. Existing verbal tenancies needed a written summary of terms by 31 May 2026.",
  sources: [SOURCES.roadmap, SOURCES.overview],
  checkTenancy(t, ctx) {
    if (t.status === "ended") return [];
    if (t.startDate >= LAW.commencement) {
      if (hasDoc(t, "writtenStatementOfTerms")) return [];
      return [
        {
          ruleId: this.id,
          severity: "critical",
          tenancyId: t.id,
          title: "No written statement of terms",
          detail: `This tenancy started on ${formatLong(t.startDate)}. No written statement of terms is recorded against it.`,
          action: "Prepare and serve the written statement of terms, then upload it to the tenancy.",
          draft: "writtenStatementCoverLetter",
        },
      ];
    }
    if (t.hadWrittenAgreement === false && !hasDoc(t, "writtenSummaryOfTerms")) {
      const overdue = ctx.today > LAW.writtenSummaryDeadline;
      return [
        {
          ruleId: this.id,
          severity: overdue ? "critical" : "warning",
          tenancyId: t.id,
          title: "Verbal tenancy has no written summary of terms",
          detail: `This tenancy was agreed verbally before 1 May 2026. A written summary of its terms was due by ${formatLong(LAW.writtenSummaryDeadline)} and none is recorded.`,
          action: "Send the written summary of terms now and record the date it was given.",
          draft: "writtenStatementCoverLetter",
          dueDate: LAW.writtenSummaryDeadline,
        },
      ];
    }
    return [];
  },
};

export const informationSheet: Rule = {
  id: "information-sheet",
  title: "Information Sheet given to every tenant",
  summary:
    "For tenancies that existed in writing before 1 May 2026, the government Information Sheet had to reach every named tenant by 31 May 2026. A managing agent must give it even if the landlord already has. Fine up to £7,000.",
  sources: [SOURCES.informationSheet, SOURCES.roadmap],
  checkTenancy(t, ctx) {
    if (t.status === "ended") return [];
    if (t.startDate >= LAW.commencement) return [];
    if (t.hadWrittenAgreement === false) return [];
    const missing = tenantsNotServed(t, "informationSheet2026");
    if (missing.length === 0) return [];
    const names = missing.map((id) => ctx.snapshot.tenants.find((x) => x.id === id)?.name ?? id).join(", ");
    const overdue = ctx.today > LAW.informationSheetDeadline;
    return [
      {
        ruleId: this.id,
        severity: overdue ? "critical" : "warning",
        tenancyId: t.id,
        title: "No record of the Information Sheet being served",
        detail: `No record shows the Renters' Rights Act Information Sheet was given to: ${names}. It was due by ${formatLong(LAW.informationSheetDeadline)}, and the fine is up to ${fmtGbp(LAW.informationSheetMaxFine)}.`,
        action:
          "If it was served, upload proof and record the date. If not, serve it on each named tenant now and keep proof of service.",
        draft: "informationSheetCoverLetter",
        dueDate: LAW.informationSheetDeadline,
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// 2. Rent increases
// ---------------------------------------------------------------------------

export const rentIncrease: Rule = {
  id: "rent-increase",
  title: "Rent increases: once a year, Section 13, two months' notice",
  summary:
    "Rent can only rise once a year, using the Section 13 process with at least 2 months' notice.",
  sources: [SOURCES.roadmap, SOURCES.overview],
  checkTenancy(t, ctx) {
    if (t.status === "ended") return [];
    const out: Finding[] = [];
    const increases = t.rentChanges
      .filter((c) => c.newRent > c.previousRent)
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

    for (const [i, c] of increases.entries()) {
      const isFutureOrPlanned = c.planned || c.effectiveDate > ctx.today;
      // Only look at increases taking effect under the new regime.
      if (c.effectiveDate < LAW.commencement) continue;
      const problems: string[] = [];

      const prev = increases.at(i - 1);
      if (i > 0 && prev) {
        const earliest = addMonths(prev.effectiveDate, LAW.rentIncrease.minMonthsBetweenIncreases);
        if (c.effectiveDate < earliest) {
          problems.push(
            `the last increase took effect on ${formatLong(prev.effectiveDate)}, so the next cannot take effect before ${formatLong(earliest)}`,
          );
        }
      }
      if (c.method && c.method !== "section13") {
        problems.push("it is not recorded as made through a Section 13 notice");
      }
      if (!c.noticeServedDate) {
        problems.push("no notice date is recorded");
      } else {
        const earliest = addMonths(c.noticeServedDate, LAW.rentIncrease.minNoticeMonths);
        if (c.effectiveDate < earliest) {
          problems.push(
            `notice was served on ${formatLong(c.noticeServedDate)}, so the increase cannot take effect before ${formatLong(earliest)}`,
          );
        }
      }
      if (problems.length === 0) continue;
      out.push({
        ruleId: this.id,
        severity: isFutureOrPlanned ? "critical" : "warning",
        tenancyId: t.id,
        title: isFutureOrPlanned ? "Planned rent increase would break the rules" : "Past rent increase may not be valid",
        detail: `Rent rise from ${fmtGbp(c.previousRent)} to ${fmtGbp(c.newRent)} on ${formatLong(c.effectiveDate)}: ${problems.join("; ")}.`,
        action: isFutureOrPlanned
          ? "Stop this increase and serve a new Section 13 notice with a valid start date."
          : "Check with the landlord whether this increase needs to be refunded or re-served.",
        draft: isFutureOrPlanned ? "section13Notice" : undefined,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 4. Advert and offer guard: bidding ban and rent in advance cap
// ---------------------------------------------------------------------------

export const biddingAndAdvance: Rule = {
  id: "bidding-and-advance",
  title: "No rental bidding; at most one month's rent in advance",
  summary:
    "Agents cannot seek or accept offers above the advertised rent, and rent in advance is capped at one month.",
  sources: [SOURCES.roadmap, SOURCES.overview],
  checkTenancy(t) {
    if (t.startDate < LAW.commencement) return [];
    const out: Finding[] = [];
    if (t.advertisedRent !== undefined && t.rent > t.advertisedRent) {
      out.push({
        ruleId: this.id,
        severity: "critical",
        tenancyId: t.id,
        title: "Agreed rent is above the advertised rent",
        detail: `The listing advertised ${fmtGbp(t.advertisedRent)} but the tenancy was agreed at ${fmtGbp(t.rent)}. Accepting more than the advertised rent is banned.`,
        action: "Check how this rent was agreed. Reduce it to the advertised rent unless the advert itself was changed before offers.",
      });
    }
    const cap = monthlyRent(t) * LAW.maxRentInAdvanceMonths;
    if (t.rentInAdvance !== undefined && t.rentInAdvance > cap + 0.005) {
      out.push({
        ruleId: this.id,
        severity: "critical",
        tenancyId: t.id,
        title: "More than one month's rent taken in advance",
        detail: `${fmtGbp(t.rentInAdvance)} was taken in advance, above the one-month cap of ${fmtGbp(Math.round(cap * 100) / 100)}.`,
        action: "Refund the excess to the tenant and record the refund.",
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 5. Pet requests
// ---------------------------------------------------------------------------

export const petRequests: Rule = {
  id: "pet-requests",
  title: "Answer pet requests within 28 days, with reasons",
  summary: "Landlords must answer a tenant's request to keep a pet within 28 days and give reasons for a refusal.",
  sources: [SOURCES.roadmap, SOURCES.overview],
  checkTenancy(t, ctx) {
    if (t.status === "ended") return [];
    const out: Finding[] = [];
    for (const p of t.petRequests) {
      const due = addDays(p.receivedDate, LAW.pets.responseDays);
      if (!p.respondedDate) {
        const left = daysBetween(ctx.today, due);
        if (left < 0) {
          out.push({
            ruleId: this.id,
            severity: "critical",
            tenancyId: t.id,
            title: "Pet request not answered in time",
            detail: `Request for "${p.description}" received ${formatLong(p.receivedDate)}. The answer was due by ${formatLong(due)}, ${-left} days ago.`,
            action: "Get the landlord's decision today and send the reply, with reasons if refused.",
            draft: "petRequestReply",
            dueDate: due,
          });
        } else if (left <= LAW.pets.warnDaysBefore) {
          out.push({
            ruleId: this.id,
            severity: "warning",
            tenancyId: t.id,
            title: "Pet request due soon",
            detail: `Request for "${p.description}" received ${formatLong(p.receivedDate)}. The answer is due by ${formatLong(due)}, in ${left} days.`,
            action: "Ask the landlord for a decision and send the reply before the deadline.",
            draft: "petRequestReply",
            dueDate: due,
          });
        }
      } else if (p.decision === "refused" && !p.refusalReason?.trim()) {
        out.push({
          ruleId: this.id,
          severity: "warning",
          tenancyId: t.id,
          title: "Pet refusal has no recorded reason",
          detail: `Request for "${p.description}" was refused on ${formatLong(p.respondedDate)} with no reason recorded.`,
          action: "Record the landlord's reason, and send it to the tenant if it was not given.",
          draft: "petRequestReply",
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 6. Landlord register (Register Your Rental Property)
// ---------------------------------------------------------------------------

export const landlordRegister: Rule = {
  id: "landlord-register",
  title: "Landlords must join the rental property register",
  summary:
    "The register opens on 15 December 2026 in the West Midlands, with other regions over the following 12 months. Landlords have 3 months from their region's start, and everyone must be registered by 14 November 2027.",
  sources: [SOURCES.landlordRegister],
  checkLandlord(l, ctx) {
    if (l.registrationNumber) return [];
    const active = ctx.tenancies.filter((t) => t.status !== "ended");
    if (active.length === 0) return [];
    const props = active
      .map((t) => ctx.snapshot.properties.find((p) => p.id === t.propertyId))
      .filter((p): p is Property => !!p && p.nation === "England");
    if (props.length === 0) return [];

    // Earliest deadline across this landlord's English properties.
    let due: IsoDate = LAW.landlordRegister.finalDeadline;
    let opens: IsoDate | undefined;
    for (const p of props) {
      const o = p.region ? LAW.landlordRegister.regionOpens[p.region] : undefined;
      if (o) {
        const d = addMonths(o, LAW.landlordRegister.monthsToRegister);
        if (d < due) {
          due = d;
          opens = o;
        }
      }
    }
    const left = daysBetween(ctx.today, due);
    const isOpen = opens ? ctx.today >= opens : false;
    const severity = left < 0 ? "critical" : isOpen || left <= 60 ? "warning" : "info";
    return [
      {
        ruleId: this.id,
        severity,
        landlordId: l.id,
        title: left < 0 ? "Landlord missed the register deadline" : "Landlord not yet on the rental property register",
        detail:
          `${l.name} has ${props.length} let ${props.length === 1 ? "property" : "properties"} in England and no registration number on file. ` +
          (opens
            ? `Their region opens on ${formatLong(opens)}, so they must register by ${formatLong(due)}.`
            : `Their region's opening date is not announced yet; the final deadline is ${formatLong(due)}.`),
        action: isOpen || left < 0 ? "Send the landlord the register chaser and record their number when it arrives." : "Tell the landlord the register is coming and when their region opens.",
        draft: "landlordRegisterChaser",
        dueDate: due,
      },
    ];
  },
};

export const RULES: Rule[] = [
  periodicTenancy,
  writtenTerms,
  informationSheet,
  rentIncrease,
  biddingAndAdvance,
  petRequests,
  landlordRegister,
];

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

/** Only England is in scope; tenancies elsewhere are skipped and reported. */
export function runChecks(snapshot: AgencySnapshot, today: IsoDate, onlyTenancyId?: string): { findings: Finding[]; skipped: { tenancyId: string; reason: string }[] } {
  const findings: Finding[] = [];
  const skipped: { tenancyId: string; reason: string }[] = [];
  const inScope: Tenancy[] = [];

  for (const t of snapshot.tenancies) {
    if (onlyTenancyId && t.id !== onlyTenancyId) continue;
    const property = snapshot.properties.find((p) => p.id === t.propertyId);
    if (!property) {
      skipped.push({ tenancyId: t.id, reason: "Property not found" });
      continue;
    }
    if (property.nation !== "England") {
      skipped.push({ tenancyId: t.id, reason: `${property.nation} is outside the Renters' Rights Act checks` });
      continue;
    }
    inScope.push(t);
    const landlord = snapshot.landlords.find((l) => l.id === t.landlordId);
    const ctx: RuleContext = { today, snapshot, property, landlord };
    for (const r of RULES) if (r.checkTenancy) findings.push(...r.checkTenancy(t, ctx));
  }

  if (!onlyTenancyId) {
    for (const l of snapshot.landlords) {
      const tenancies = snapshot.tenancies.filter((t) => t.landlordId === l.id);
      for (const r of RULES) if (r.checkLandlord) findings.push(...r.checkLandlord(l, { today, snapshot, landlord: l, tenancies }));
    }
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
      a.ruleId.localeCompare(b.ruleId),
  );
  return { findings, skipped };
}
