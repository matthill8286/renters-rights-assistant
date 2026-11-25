/**
 * Maps Reapit Platform API records into the CRM-neutral domain model.
 *
 * VERIFY AGAINST THE SANDBOX: the field names below follow the Foundations
 * Swagger explorer as far as we could read it, but have not yet been run
 * against live sandbox data. `test/reapit-mapper.test.ts` pins the shapes we
 * expect; update both together once the sandbox is connected.
 *
 * Reapit does not hold everything the Act needs (pet requests, which tenants
 * were served the Information Sheet, the advertised rent). Until we have our
 * own database, those live in each tenancy's `metadata.rra` object, which
 * Reapit lets integrations store on most entities.
 */

import type {
  AgencySnapshot,
  DocumentKind,
  Landlord,
  Nation,
  PetRequest,
  Property,
  Region,
  RentChange,
  RentFrequency,
  Tenancy,
  TenancyDocument,
  Tenant,
} from "../domain.js";
import type { ReapitClient } from "./client.js";
import type { DataSource } from "../data/source.js";

export interface ReapitAddress {
  buildingName?: string;
  buildingNumber?: string;
  line1?: string;
  line2?: string;
  line3?: string;
  line4?: string;
  postcode?: string;
  countryId?: string;
}

export interface ReapitProperty {
  id: string;
  address?: ReapitAddress;
  metadata?: { rra?: { region?: Region; nation?: Nation } };
}

export interface ReapitLandlord {
  id: string;
  related?: { name?: string; email?: string }[];
  metadata?: { rra?: { registrationNumber?: string } };
}

export interface ReapitContact {
  id: string;
  title?: string;
  forename?: string;
  surname?: string;
  email?: string;
}

export interface ReapitTenancy {
  id: string;
  propertyId: string;
  landlordId?: string;
  status?: string;
  typeId?: string;
  isPeriodic?: boolean;
  startDate?: string;
  endDate?: string;
  rent?: number;
  rentFrequency?: string;
  deposit?: { sum?: number; heldBy?: string; protected?: boolean };
  metadata?: { rra?: TenancyRraMetadata };
}

/** Compliance facts we store against the tenancy ourselves. */
export interface TenancyRraMetadata {
  hadWrittenAgreement?: boolean;
  advertisedRent?: number;
  rentInAdvance?: number;
  arrears?: number;
  rentChanges?: RentChange[];
  petRequests?: PetRequest[];
  /** Service records keyed by document id: which tenants, which date. */
  served?: Record<string, { date?: string; tenantIds?: string[] }>;
}

export interface ReapitRelationship {
  associatedType?: string;
  associatedId: string;
  isMainContact?: boolean;
}

export interface ReapitDocument {
  id: string;
  typeId?: string;
  name?: string;
  associatedType?: string;
  associatedId?: string;
  created?: string;
}

/**
 * Reapit document type ids vary by agency configuration. Map an agency's own
 * type ids or name keywords onto our kinds. Defaults match by name keyword.
 */
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

export function documentKind(d: ReapitDocument, keywords = DEFAULT_DOCUMENT_KEYWORDS): DocumentKind {
  const name = d.name ?? "";
  for (const [re, kind] of keywords) if (re.test(name)) return kind;
  return "other";
}

const FREQ: Record<string, RentFrequency> = {
  weekly: "weekly",
  fortnightly: "fortnightly",
  monthly: "monthly",
  "4weekly": "monthly",
  quarterly: "quarterly",
  annually: "yearly",
  yearly: "yearly",
};

/** Reapit tenancy statuses we treat as live. */
const CURRENT = new Set(["current", "periodic", "renewing", "renewed", "extending", "finishing"]);
const PENDING = new Set(["offerAccepted", "offerPending", "arrangingTenancy", "pending"]);

function mapStatus(s?: string): Tenancy["status"] {
  if (!s) return "current";
  if (CURRENT.has(s)) return "current";
  if (PENDING.has(s)) return "pending";
  return "ended";
}

/**
 * Nation from metadata if set; otherwise a coarse guess from the postcode area.
 * Border postcodes (for example some CH, SY and TD areas) can be wrong, so
 * agencies should set metadata.rra.nation on cross-border properties.
 */
export function guessNation(p: ReapitProperty): Nation {
  const meta = p.metadata?.rra?.nation;
  if (meta) return meta;
  const pc = (p.address?.postcode ?? "").trim().toUpperCase();
  if (pc.startsWith("BT")) return "Northern Ireland";
  if (/^(CF|SA|NP|LL|LD)\d/.test(pc)) return "Wales";
  if (/^(EH|G\d|AB|DD|KY|PH|FK|KW|IV|PA|HS|ZE|ML|TD|DG|KA)/.test(pc)) return "Scotland";
  return "England";
}

export function mapProperty(p: ReapitProperty): Property {
  const a = p.address ?? {};
  const line = [[a.buildingNumber, a.buildingName].filter(Boolean).join(" "), a.line1, a.line2, a.line3, a.line4]
    .filter((x) => x && x.trim())
    .join(", ");
  return { id: p.id, address: line, postcode: a.postcode ?? "", nation: guessNation(p), region: p.metadata?.rra?.region };
}

export function mapLandlord(l: ReapitLandlord): Landlord {
  const main = l.related?.[0];
  return { id: l.id, name: main?.name ?? `Landlord ${l.id}`, email: main?.email, registrationNumber: l.metadata?.rra?.registrationNumber };
}

export function mapContact(c: ReapitContact): Tenant {
  const name = [c.title, c.forename, c.surname].filter(Boolean).join(" ") || `Contact ${c.id}`;
  return { id: c.id, name, email: c.email };
}

export function mapTenancy(t: ReapitTenancy, tenantIds: string[], docs: ReapitDocument[]): Tenancy {
  const meta = t.metadata?.rra ?? {};
  const documents: TenancyDocument[] = docs.map((d) => ({
    id: d.id,
    kind: documentKind(d),
    name: d.name ?? d.id,
    servedDate: meta.served?.[d.id]?.date,
    servedOnTenantIds: meta.served?.[d.id]?.tenantIds,
  }));
  return {
    id: t.id,
    propertyId: t.propertyId,
    landlordId: t.landlordId ?? "",
    tenantIds,
    status: mapStatus(t.status),
    startDate: (t.startDate ?? "").slice(0, 10),
    endDate: t.isPeriodic ? undefined : t.endDate?.slice(0, 10),
    recordedType: t.isPeriodic ? "assuredPeriodic" : t.endDate ? "assuredShorthold" : undefined,
    hadWrittenAgreement: meta.hadWrittenAgreement,
    rent: t.rent ?? 0,
    rentFrequency: FREQ[t.rentFrequency ?? "monthly"] ?? "monthly",
    advertisedRent: meta.advertisedRent,
    rentInAdvance: meta.rentInAdvance,
    depositAmount: t.deposit?.sum,
    depositProtected: t.deposit?.protected,
    rentChanges: meta.rentChanges ?? [],
    petRequests: meta.petRequests ?? [],
    documents,
    arrears: meta.arrears,
  };
}

/** Loads a whole agency from Reapit. Read-only. */
export class ReapitSource implements DataSource {
  name = "reapit";
  constructor(private client: ReapitClient, private agencyName = "Your agency") {}

  async loadSnapshot(): Promise<AgencySnapshot> {
    const c = this.client;
    const tenancies = await c.getAll<ReapitTenancy>("/tenancies", { status: [...CURRENT, ...PENDING] });

    const propertyIds = [...new Set(tenancies.map((t) => t.propertyId))];
    const landlordIds = [...new Set(tenancies.map((t) => t.landlordId).filter((x): x is string => !!x))];

    const [properties, landlords] = await Promise.all([
      chunked(propertyIds, (ids) => c.getAll<ReapitProperty>("/properties", { id: ids })),
      chunked(landlordIds, (ids) => c.getAll<ReapitLandlord>("/landlords", { id: ids })),
    ]);

    const perTenancy = await Promise.all(
      tenancies.map(async (t) => {
        const [rels, docs] = await Promise.all([
          c.getAll<ReapitRelationship>(`/tenancies/${encodeURIComponent(t.id)}/relationships`),
          c.getAll<ReapitDocument>("/documents", { associatedType: "tenancy", associatedId: t.id }),
        ]);
        const tenantIds = rels.filter((r) => !r.associatedType || r.associatedType === "contact").map((r) => r.associatedId);
        return { t, tenantIds, docs };
      }),
    );

    const contactIds = [...new Set(perTenancy.flatMap((x) => x.tenantIds))];
    const contacts = await chunked(contactIds, (ids) => c.getAll<ReapitContact>("/contacts", { id: ids }));

    return {
      agencyId: c.customerId,
      agencyName: this.agencyName,
      properties: properties.map(mapProperty),
      landlords: landlords.map(mapLandlord),
      tenants: contacts.map(mapContact),
      tenancies: perTenancy.map(({ t, tenantIds, docs }) => mapTenancy(t, tenantIds, docs)),
    };
  }
}

async function chunked<T>(ids: string[], fetchFn: (ids: string[]) => Promise<T[]>, size = 50): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fetchFn(ids.slice(i, i + size))));
  return out;
}
