/**
 * Helpers shared by every CRM connector.
 */
import type { DocumentKind, Nation, PetRequest, RentChange } from "../domain.js";

/**
 * Compliance facts most CRMs do not hold natively. Connectors read them from
 * a JSON blob the CRM lets integrations store (Reapit metadata, Arthur custom
 * fields) until we have our own database.
 */
export interface RraFacts {
  hadWrittenAgreement?: boolean;
  advertisedRent?: number;
  rentInAdvance?: number;
  arrears?: number;
  rentChanges?: RentChange[];
  petRequests?: PetRequest[];
  /** Service records keyed by document id: which tenants, which date. */
  served?: Record<string, { date?: string; tenantIds?: string[] }>;
}

/** Document names vary by agency. These keywords map names onto our kinds. */
export const DEFAULT_DOCUMENT_KEYWORDS: [RegExp, DocumentKind][] = [
  [/information sheet/i, "informationSheet2026"],
  [/written statement/i, "writtenStatementOfTerms"],
  [/(written )?summary of terms/i, "writtenSummaryOfTerms"],
  [/prescribed information/i, "depositPrescribedInformation"],
  [/deposit (protection )?certificate|dps|tds|mydeposits/i, "depositProtectionCertificate"],
  [/section 13|form 4a/i, "section13Notice"],
  [/section 8|form 3a/i, "section8Notice"],
  [/tenancy agreement|\bast\b/i, "tenancyAgreement"],
];

export function documentKindFromName(name: string | undefined, keywords = DEFAULT_DOCUMENT_KEYWORDS): DocumentKind {
  for (const [re, kind] of keywords) if (re.test(name ?? "")) return kind;
  return "other";
}

/**
 * Coarse nation guess from the postcode area. Border postcodes (some CH, SY
 * and TD areas) can be wrong, so connectors let agencies override it.
 */
export function nationFromPostcode(postcode: string | undefined): Nation {
  const pc = (postcode ?? "").trim().toUpperCase();
  if (pc.startsWith("BT")) return "Northern Ireland";
  if (/^(CF|SA|NP|LL|LD)\d/.test(pc)) return "Wales";
  if (/^(EH|G\d|AB|DD|KY|PH|FK|KW|IV|PA|HS|ZE|ML|TD|DG|KA)/.test(pc)) return "Scotland";
  return "England";
}

/** Splits ids into chunks and fetches each chunk in turn. */
export async function chunked<T>(ids: string[], fetchFn: (ids: string[]) => Promise<T[]>, size = 50): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fetchFn(ids.slice(i, i + size))));
  return out;
}
