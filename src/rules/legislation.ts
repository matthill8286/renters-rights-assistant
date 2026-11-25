/**
 * Every legal date, period and amount the rules use, in one versioned place,
 * each with the GOV.UK page it came from. A solicitor reviews this file; a
 * change in the law is a change here, not across the codebase.
 *
 * Scope: England only. Wales, Scotland and Northern Ireland have different law.
 */

export const RULESET_VERSION = "2026-11-25";

export const SOURCES = {
  roadmap:
    "https://www.gov.uk/government/publications/renters-rights-act-2025-implementation-roadmap/implementing-the-renters-rights-act-2025-our-roadmap-for-reforming-the-private-rented-sector",
  overview:
    "https://www.gov.uk/guidance/renting-out-your-property-guidance-for-landlords-and-letting-agents/renters-rights-act-an-overview-for-landlords",
  informationSheet: "https://www.gov.uk/government/publications/the-renters-rights-act-information-sheet-2026",
  possessionGrounds:
    "https://www.gov.uk/government/publications/grounds-for-possession-guidance-for-landlords-and-letting-agents/grounds-for-possession-guidance-for-landlords-and-letting-agents",
  repossessing: "https://www.gov.uk/guidance/repossessing-your-privately-rented-property-after-1-may-2026",
  landlordRegister: "https://www.gov.uk/government/news/stronger-protections-and-greater-confidence-for-renters",
} as const;

export const LAW = {
  /** Section 21 abolished, tenancies become assured periodic. */
  commencement: "2026-05-01",
  /** Deadline to give the Information Sheet to tenants of existing written tenancies. */
  informationSheetDeadline: "2026-05-31",
  /** Deadline to give a written summary of terms for existing verbal tenancies. */
  writtenSummaryDeadline: "2026-05-31",
  informationSheetMaxFine: 7000,
  /** Maximum civil penalty for serious or repeated breaches. */
  maxCivilPenalty: 40000,

  rentIncrease: {
    /** Rent may rise once a year via Section 13. */
    minMonthsBetweenIncreases: 12,
    minNoticeMonths: 2,
  },

  /** Rent in advance capped at one month's rent. */
  maxRentInAdvanceMonths: 1,

  pets: {
    /** Days to answer a pet request. */
    responseDays: 28,
    /** Warn this many days before the deadline. */
    warnDaysBefore: 7,
  },

  landlordRegister: {
    /**
     * Known regional opening dates. Only the West Midlands date has been
     * announced; others follow "over 12 months". Add dates here as published.
     */
    regionOpens: { "West Midlands": "2026-12-15" } as Record<string, string>,
    /** Landlords have this many months after their region opens. */
    monthsToRegister: 3,
    /** Everyone must be registered by this date. */
    finalDeadline: "2027-11-14",
  },
} as const;

export interface GroundRule {
  ground: string;
  name: string;
  noticeMonths?: number;
  noticeWeeks?: number;
  /** Notice can be served but possession cannot take effect within the first N months. */
  notInFirstMonths?: number;
  /** Court cannot order possession until N days after notice (ground 14). */
  courtNotBeforeDays?: number;
  requiresDepositProtected: boolean;
  notes: string;
}

/** Section 8 grounds the prototype supports. Notices use Form 3A. */
export const GROUNDS: Record<string, GroundRule> = {
  "1": {
    ground: "1",
    name: "Landlord or family member moving in",
    noticeMonths: 4,
    notInFirstMonths: 12,
    requiresDepositProtected: true,
    notes: "Cannot take effect within the first 12 months of the tenancy.",
  },
  "1A": {
    ground: "1A",
    name: "Landlord selling the property",
    noticeMonths: 4,
    notInFirstMonths: 12,
    requiresDepositProtected: true,
    notes: "Cannot take effect within the first 12 months of the tenancy.",
  },
  "8": {
    ground: "8",
    name: "Serious rent arrears",
    noticeWeeks: 4,
    requiresDepositProtected: true,
    notes:
      "At least 3 months' rent (13 weeks if rent is paid weekly or fortnightly) must be owed both when notice is served and at the hearing. Universal Credit payments not yet received are not counted.",
  },
  "14": {
    ground: "14",
    name: "Anti-social behaviour",
    requiresDepositProtected: false,
    courtNotBeforeDays: 14,
    notes: "Proceedings can start straight away; the court cannot order possession until 14 days after notice.",
  },
};
