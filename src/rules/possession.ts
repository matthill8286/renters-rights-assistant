import type { IsoDate, Tenancy } from "../domain.js";
import { addDays, addMonths, formatLong } from "../dates.js";
import { GROUNDS, SOURCES } from "./legislation.js";

export interface PossessionCheck {
  ground: string;
  groundName: string;
  ok: boolean;
  blockers: string[];
  warnings: string[];
  /** Earliest date the notice period ends if served on `serveDate`. */
  noticeExpires?: IsoDate;
  /** Earliest date possession could take effect, taking the 12-month rule into account. */
  earliestPossession?: IsoDate;
  form: "Form 3A";
  notes: string;
  sources: string[];
}

function monthsOfRentOwed(t: Tenancy): { months: number; weeks: number } {
  const arrears = t.arrears ?? 0;
  switch (t.rentFrequency) {
    case "weekly":
      return { weeks: arrears / t.rent, months: (arrears / t.rent) * (12 / 52) };
    case "fortnightly":
      return { weeks: (arrears / t.rent) * 2, months: (arrears / t.rent) * (12 / 26) };
    case "monthly":
      return { months: arrears / t.rent, weeks: (arrears / t.rent) * (52 / 12) };
    case "quarterly":
      return { months: (arrears / t.rent) * 3, weeks: (arrears / t.rent) * 13 };
    case "yearly":
      return { months: (arrears / t.rent) * 12, weeks: (arrears / t.rent) * 52 };
  }
}

/**
 * Checks whether a Section 8 notice on the given ground could be served on
 * `serveDate`, and when it could take effect. This is a screening aid for the
 * agent, not legal advice.
 */
export function checkPossession(t: Tenancy, ground: string, serveDate: IsoDate): PossessionCheck {
  const g = GROUNDS[ground.toUpperCase()];
  if (!g) {
    return {
      ground,
      groundName: "Unsupported ground",
      ok: false,
      blockers: [`Ground ${ground} is not supported yet. Supported: ${Object.keys(GROUNDS).join(", ")}.`],
      warnings: [],
      form: "Form 3A",
      notes: "",
      sources: [SOURCES.possessionGrounds],
    };
  }

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (t.status === "ended") blockers.push("The tenancy has already ended.");

  if (g.requiresDepositProtected && t.depositAmount && t.depositAmount > 0) {
    if (t.depositProtected === false) {
      blockers.push("The deposit is not protected. Protect it and give the prescribed information before relying on this ground.");
    } else if (t.depositProtected === undefined) {
      warnings.push("Deposit protection is not recorded. Confirm it before serving notice.");
    }
    if (!t.documents.some((d) => d.kind === "depositPrescribedInformation")) {
      warnings.push("No record of the deposit prescribed information being given.");
    }
  }

  let noticeExpires: IsoDate | undefined;
  if (g.noticeMonths) noticeExpires = addMonths(serveDate, g.noticeMonths);
  else if (g.noticeWeeks) noticeExpires = addDays(serveDate, g.noticeWeeks * 7);
  else if (g.courtNotBeforeDays) noticeExpires = addDays(serveDate, g.courtNotBeforeDays);

  let earliestPossession = noticeExpires;
  if (g.notInFirstMonths) {
    const firstAllowed = addMonths(t.startDate, g.notInFirstMonths);
    if (earliestPossession && earliestPossession < firstAllowed) {
      warnings.push(
        `Possession cannot take effect in the first ${g.notInFirstMonths} months of the tenancy, so the earliest date is ${formatLong(firstAllowed)}, not ${formatLong(earliestPossession)}.`,
      );
      earliestPossession = firstAllowed;
    }
  }

  if (g.ground === "8") {
    if (t.arrears === undefined) {
      blockers.push("Arrears are not recorded for this tenancy, so the 3-month threshold cannot be checked.");
    } else {
      const owed = monthsOfRentOwed(t);
      const weeklyish = t.rentFrequency === "weekly" || t.rentFrequency === "fortnightly";
      const meets = weeklyish ? owed.weeks >= 13 : owed.months >= 3;
      if (!meets) {
        blockers.push(
          weeklyish
            ? `Arrears are about ${owed.weeks.toFixed(1)} weeks of rent; at least 13 weeks are needed.`
            : `Arrears are about ${owed.months.toFixed(1)} months of rent; at least 3 months are needed.`,
        );
      } else {
        warnings.push("The arrears must still be at the threshold at the hearing. Universal Credit payments not yet received are not counted.");
      }
    }
  }

  return {
    ground: g.ground,
    groundName: g.name,
    ok: blockers.length === 0,
    blockers,
    warnings,
    noticeExpires,
    earliestPossession,
    form: "Form 3A",
    notes: g.notes,
    sources: [SOURCES.possessionGrounds, SOURCES.repossessing],
  };
}
