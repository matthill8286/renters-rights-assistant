/**
 * Maps Arthur Online API v2 records into the CRM-neutral domain model.
 *
 * VERIFY AGAINST A REAL ACCOUNT: property, unit and asset fields come from
 * Arthur's own docs. Tenancy and tenant response fields come from OpenAPI
 * files generated from Arthur's Postman collection by a third party
 * (apis.io), and are not yet confirmed. The mapper accepts the likely
 * variants and the probe (`npm run probe:arthur`) reports what is really there.
 *
 * Arthur's "unit" is the thing that is let, so it becomes our Property.
 * Owners are Arthur "entities" and become our Landlords.
 *
 * Facts Arthur does not hold (pet requests, who was served what, advertised
 * rent) are read from a tenancy custom field named "rra" holding JSON.
 */
import type { AgencySnapshot, Landlord, Nation, Property, RentFrequency, Tenancy, TenancyDocument, Tenant } from "../domain.js";
import type { DataSource } from "../data/source.js";
import { documentKindFromName, nationFromPostcode, type RraFacts } from "../crm/shared.js";
import type { ArthurClient } from "./client.js";

type Id = string | number;

export interface ArthurUnit {
  id: Id;
  property_id?: Id;
  unit_ref?: string;
  full_address?: string;
  address_line_1?: string;
  address_line_2?: string;
  city?: string;
  county?: string;
  country?: string;
  postcode?: string;
  unit_owner_id?: Id;
  owner?: { id?: Id; full_name?: string };
  custom_fields?: unknown;
}

export interface ArthurEntity {
  id: Id;
  name?: string;
  company?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  custom_fields?: unknown;
}

export interface ArthurTenant {
  id: Id;
  tenancy_id?: Id;
  title?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  email?: string;
  main_tenant?: boolean;
}

export interface ArthurTenancy {
  id: Id;
  unit_id?: Id;
  unit?: ArthurUnit;
  status?: string;
  tenancy_status?: string;
  tenancy_type?: string;
  start_date?: string;
  end_date?: string;
  move_in_date?: string;
  rent_amount?: number | string;
  rent?: number | string;
  rent_frequency?: string;
  deposit_amount?: number | string;
  deposit_held_by?: string;
  deposit_registered?: boolean;
  unit_owner_id?: Id;
  tenants?: ArthurTenant[];
  custom_fields?: unknown;
}

export interface ArthurAsset {
  id: Id;
  name?: string;
  description?: string;
  created?: string;
}

const str = (v: Id | undefined | null) => (v === undefined || v === null ? "" : String(v));
const num = (v: number | string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
const date = (v: string | undefined) => (v ? v.slice(0, 10) : undefined);

const FREQ: Record<string, RentFrequency> = {
  weekly: "weekly",
  week: "weekly",
  fortnightly: "fortnightly",
  "2 weekly": "fortnightly",
  monthly: "monthly",
  month: "monthly",
  "4 weekly": "monthly",
  quarterly: "quarterly",
  annually: "yearly",
  yearly: "yearly",
};

/**
 * Arthur tenancy statuses: Prospective, Approved, Current (fixed term),
 * Periodic (rolling), Ending, Past, Rejected.
 */
export function mapArthurStatus(s: string | undefined): { status: Tenancy["status"]; periodic?: boolean } {
  switch ((s ?? "").trim().toLowerCase()) {
    case "periodic":
      return { status: "current", periodic: true };
    case "current":
    case "ending":
      return { status: "current", periodic: false };
    case "prospective":
    case "approved":
      return { status: "pending" };
    case "past":
    case "rejected":
      return { status: "ended" };
    default:
      return { status: "current" };
  }
}

/**
 * Reads a named custom field. Arthur's response shape for custom fields is
 * not documented, so this accepts an object map or an array of
 * { name | label | key, value } entries.
 */
export function customField(fields: unknown, name: string): unknown {
  if (!fields) return undefined;
  if (Array.isArray(fields)) {
    const hit = fields.find((f) => {
      const o = f as Record<string, unknown>;
      return [o.name, o.label, o.key, o.field_name].some((k) => typeof k === "string" && k.toLowerCase() === name.toLowerCase());
    }) as Record<string, unknown> | undefined;
    return hit?.value;
  }
  if (typeof fields === "object") return (fields as Record<string, unknown>)[name];
  return undefined;
}

export function readRraFacts(fields: unknown): RraFacts {
  const raw = customField(fields, "rra");
  if (!raw) return {};
  if (typeof raw === "object") return raw as RraFacts;
  try {
    return JSON.parse(String(raw)) as RraFacts;
  } catch {
    return {};
  }
}

export function mapUnit(u: ArthurUnit): Property {
  const address =
    u.full_address ?? [u.address_line_1, u.address_line_2, u.city].filter((x) => x && String(x).trim()).join(", ");
  const override = customField(u.custom_fields, "nation") as Nation | undefined;
  return { id: str(u.id), address, postcode: u.postcode ?? "", nation: override ?? nationFromPostcode(u.postcode) };
}

export function mapEntity(e: ArthurEntity): Landlord {
  const name = e.name ?? e.company ?? ([e.first_name, e.last_name].filter(Boolean).join(" ") || `Landlord ${e.id}`);
  const reg = customField(e.custom_fields, "landlord_register_number") ?? customField(e.custom_fields, "registration_number");
  return { id: str(e.id), name, email: e.email, registrationNumber: reg ? String(reg) : undefined };
}

export function mapTenant(t: ArthurTenant): Tenant {
  const name = t.full_name ?? ([t.title, t.first_name, t.last_name].filter(Boolean).join(" ") || `Tenant ${t.id}`);
  return { id: str(t.id), name, email: t.email };
}

export function mapArthurTenancy(t: ArthurTenancy, opts: { landlordId: string; tenantIds: string[]; assets: ArthurAsset[] }): Tenancy {
  const facts = readRraFacts(t.custom_fields);
  const { status, periodic } = mapArthurStatus(t.status ?? t.tenancy_status);
  const documents: TenancyDocument[] = opts.assets.map((a) => {
    const id = str(a.id);
    return {
      id,
      kind: documentKindFromName(a.name ?? a.description),
      name: a.name ?? id,
      servedDate: facts.served?.[id]?.date,
      servedOnTenantIds: facts.served?.[id]?.tenantIds,
    };
  });
  const endDate = periodic ? undefined : date(t.end_date);
  return {
    id: str(t.id),
    propertyId: str(t.unit_id ?? t.unit?.id),
    landlordId: opts.landlordId,
    tenantIds: opts.tenantIds,
    status,
    startDate: date(t.start_date ?? t.move_in_date) ?? "",
    endDate,
    recordedType: periodic ? "assuredPeriodic" : endDate ? "assuredShorthold" : undefined,
    hadWrittenAgreement: facts.hadWrittenAgreement,
    rent: num(t.rent_amount ?? t.rent) ?? 0,
    rentFrequency: FREQ[(t.rent_frequency ?? "monthly").trim().toLowerCase()] ?? "monthly",
    advertisedRent: facts.advertisedRent,
    rentInAdvance: facts.rentInAdvance,
    depositAmount: num(t.deposit_amount),
    depositProtected: t.deposit_registered ?? (t.deposit_held_by ? /dps|tds|mydeposits|custodial|insured/i.test(t.deposit_held_by) : undefined),
    rentChanges: facts.rentChanges ?? [],
    petRequests: facts.petRequests ?? [],
    documents,
    arrears: facts.arrears,
  };
}

/** Loads a whole Arthur account. Read-only. */
export class ArthurSource implements DataSource {
  name = "arthur";
  constructor(
    private client: ArthurClient,
    private agencyName = "Your agency",
    /** Cap on tenancies loaded, for probes. */
    private maxTenancies?: number,
  ) {}

  async loadSnapshot(): Promise<AgencySnapshot> {
    const c = this.client;
    const all = await c.getAll<ArthurTenancy>("/tenancies", {}, this.maxTenancies ? this.maxTenancies * 3 : undefined);
    const live = all.filter((t) => mapArthurStatus(t.status ?? t.tenancy_status).status !== "ended");
    const tenancies = this.maxTenancies ? live.slice(0, this.maxTenancies) : live;

    const unitIds = [...new Set(tenancies.map((t) => str(t.unit_id ?? t.unit?.id)).filter(Boolean))];
    const units = new Map<string, ArthurUnit>();
    for (const t of tenancies) if (t.unit) units.set(str(t.unit.id), t.unit);
    for (const id of unitIds) {
      if (units.has(id)) continue;
      const res = await c.get<{ data: ArthurUnit | ArthurUnit[] }>(`/units/${encodeURIComponent(id)}`);
      const u = Array.isArray(res.data) ? res.data[0] : res.data;
      if (u) units.set(id, u);
    }

    const ownerOf = (t: ArthurTenancy) => {
      const u = units.get(str(t.unit_id ?? t.unit?.id));
      return str(t.unit_owner_id ?? u?.unit_owner_id ?? u?.owner?.id);
    };
    const ownerIds = [...new Set(tenancies.map(ownerOf).filter(Boolean))];
    const entities: ArthurEntity[] = [];
    for (const id of ownerIds) {
      try {
        const res = await c.get<{ data: ArthurEntity | ArthurEntity[] }>(`/entities/${encodeURIComponent(id)}`);
        const e = Array.isArray(res.data) ? res.data[0] : res.data;
        if (e) entities.push(e);
      } catch {
        // Fall back to the owner name on the unit.
        const u = [...units.values()].find((x) => str(x.unit_owner_id ?? x.owner?.id) === id);
        entities.push({ id, name: u?.owner?.full_name });
      }
    }

    const tenants = new Map<string, Tenant>();
    const mapped: Tenancy[] = [];
    for (const t of tenancies) {
      const id = encodeURIComponent(str(t.id));
      const ts = t.tenants ?? (await c.getAll<ArthurTenant>(`/tenancies/${id}/tenants`));
      for (const x of ts) tenants.set(str(x.id), mapTenant(x));
      const assets = await c.getAll<ArthurAsset>(`/tenancies/${id}/assets`);
      mapped.push(mapArthurTenancy(t, { landlordId: ownerOf(t), tenantIds: ts.map((x) => str(x.id)), assets }));
    }

    return {
      agencyId: c.entityId,
      agencyName: this.agencyName,
      properties: [...units.values()].map(mapUnit),
      landlords: entities.map(mapEntity),
      tenants: [...tenants.values()],
      tenancies: mapped,
    };
  }
}
