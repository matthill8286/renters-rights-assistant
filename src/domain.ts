/**
 * CRM-neutral domain model. Every CRM connector (Reapit first) maps its records
 * into these shapes, so the rules never depend on one vendor's field names.
 *
 * All dates are ISO calendar dates ("YYYY-MM-DD").
 */

export type IsoDate = string;

export type RentFrequency = "weekly" | "fortnightly" | "monthly" | "quarterly" | "yearly";

/** England regions used by the landlord register rollout. */
export type Region =
  | "West Midlands"
  | "East Midlands"
  | "North East"
  | "North West"
  | "Yorkshire and the Humber"
  | "East of England"
  | "London"
  | "South East"
  | "South West";

export type Nation = "England" | "Wales" | "Scotland" | "Northern Ireland";

export interface Property {
  id: string;
  address: string;
  postcode: string;
  nation: Nation;
  region?: Region;
}

export interface Landlord {
  id: string;
  name: string;
  email?: string;
  /** Set once the landlord has a Register Your Rental Property number. */
  registrationNumber?: string;
}

export interface Tenant {
  id: string;
  name: string;
  email?: string;
}

/** Documents we look for. Connectors map CRM document types onto these. */
export type DocumentKind =
  | "tenancyAgreement"
  | "writtenStatementOfTerms"
  | "writtenSummaryOfTerms"
  | "informationSheet2026"
  | "depositProtectionCertificate"
  | "depositPrescribedInformation"
  | "section13Notice"
  | "section8Notice"
  | "other";

export interface TenancyDocument {
  id: string;
  kind: DocumentKind;
  name: string;
  /** Date the document was given to the tenant(s), if recorded. */
  servedDate?: IsoDate;
  /** Tenant ids it was served on. Empty or missing means "not recorded". */
  servedOnTenantIds?: string[];
}

export interface RentChange {
  effectiveDate: IsoDate;
  newRent: number;
  previousRent: number;
  /** How the increase was made, if known. */
  method?: "section13" | "agreement" | "other";
  /** Date notice was served on the tenant, if any. */
  noticeServedDate?: IsoDate;
  /** True for a change not yet in force (a planned increase). */
  planned?: boolean;
}

export interface PetRequest {
  id: string;
  receivedDate: IsoDate;
  description: string;
  respondedDate?: IsoDate;
  decision?: "approved" | "refused";
  refusalReason?: string;
}

export interface Tenancy {
  id: string;
  propertyId: string;
  landlordId: string;
  tenantIds: string[];
  status: "current" | "pending" | "ended";
  startDate: IsoDate;
  /** A fixed end date recorded in the CRM, if any. */
  endDate?: IsoDate;
  /** How the CRM describes the tenancy. */
  recordedType?: "assuredShorthold" | "assuredPeriodic" | "other";
  /** Whether the tenancy terms were ever put in writing before 1 May 2026. */
  hadWrittenAgreement?: boolean;
  rent: number;
  rentFrequency: RentFrequency;
  /** Rent shown in the listing that led to this tenancy. */
  advertisedRent?: number;
  /** Rent taken before the tenancy started, beyond the deposit. */
  rentInAdvance?: number;
  depositAmount?: number;
  depositProtected?: boolean;
  rentChanges: RentChange[];
  petRequests: PetRequest[];
  documents: TenancyDocument[];
  /** Rent arrears in pounds, if the CRM tracks them. */
  arrears?: number;
}

/** Everything one agency has, as the rules see it. */
export interface AgencySnapshot {
  agencyId: string;
  agencyName: string;
  properties: Property[];
  landlords: Landlord[];
  tenants: Tenant[];
  tenancies: Tenancy[];
}

export type Severity = "critical" | "warning" | "info";

export interface Finding {
  ruleId: string;
  severity: Severity;
  tenancyId?: string;
  landlordId?: string;
  title: string;
  detail: string;
  /** What the agent should do next, in plain words. */
  action: string;
  /** Draft template the assistant can produce for this finding, if any. */
  draft?: DraftKind;
  /** Date by which this must be fixed, if there is one. */
  dueDate?: IsoDate;
}

export type DraftKind =
  | "writtenStatementCoverLetter"
  | "informationSheetCoverLetter"
  | "section13Notice"
  | "petRequestReply"
  | "landlordRegisterChaser"
  | "recordUpdateNote"
  | "section8NoticeSummary";
