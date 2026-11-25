import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AgencySnapshot } from "../src/domain.ts";
import { checkPossession } from "../src/rules/possession.ts";
import { buildDraft, DRAFT_KINDS, renderDraft } from "../src/drafts/templates.ts";

const demo = JSON.parse(readFileSync(new URL("../fixtures/demo-agency.json", import.meta.url), "utf8")) as AgencySnapshot;
const tenancy = (id: string) => demo.tenancies.find((t) => t.id === id)!;
const TODAY = "2026-11-25";

test("ground 1A: four months' notice, not within the first 12 months", () => {
  const r = checkPossession(tenancy("T4"), "1A", "2026-11-25"); // started 15 Aug 2026
  assert.equal(r.noticeExpires, "2027-03-25");
  assert.equal(r.earliestPossession, "2027-08-15");
  assert.ok(r.ok);
});

test("ground 8: weekly tenancy needs 13 weeks of arrears", () => {
  const t = tenancy("T3"); // £175 a week, £2,400 owed = 13.7 weeks
  const r = checkPossession(t, "8", TODAY);
  assert.ok(r.ok, r.blockers.join("; "));
  assert.equal(r.noticeExpires, "2026-12-23");
  const low = checkPossession({ ...t, arrears: 1000 }, "8", TODAY);
  assert.equal(low.ok, false);
  assert.match(low.blockers[0]!, /13 weeks/);
});

test("unprotected deposit blocks a Section 8 ground", () => {
  const r = checkPossession(tenancy("T5"), "1", TODAY);
  assert.equal(r.ok, false);
  assert.match(r.blockers.join(" "), /deposit is not protected/i);
});

test("unknown ground is refused clearly", () => {
  const r = checkPossession(tenancy("T1"), "99", TODAY);
  assert.equal(r.ok, false);
  assert.match(r.blockers[0]!, /not supported/);
});

test("every draft kind renders with a review banner", () => {
  const inputs: Record<string, { tenancyId?: string; landlordId?: string; options?: Record<string, string | number> }> = {
    informationSheetCoverLetter: { tenancyId: "T1" },
    writtenStatementCoverLetter: { tenancyId: "T2" },
    section13Notice: { tenancyId: "T3", options: { proposedRent: 190 } },
    petRequestReply: { tenancyId: "T3", options: { decision: "refused", reason: "the lease of the building does not allow dogs" } },
    landlordRegisterChaser: { landlordId: "L1" },
    recordUpdateNote: { tenancyId: "T1" },
    section8NoticeSummary: { tenancyId: "T3", options: { ground: "8" } },
  };
  for (const kind of DRAFT_KINDS) {
    const input = inputs[kind];
    assert.ok(input, `test input missing for ${kind}`);
    const d = buildDraft(kind, { snapshot: demo, today: TODAY, ...input });
    const out = renderDraft(d);
    assert.match(out, /DRAFT FOR REVIEW/, kind);
    assert.doesNotMatch(out, /undefined|NaN/, kind);
  }
});

test("section 13 draft respects the once-a-year rule", () => {
  const d = buildDraft("section13Notice", { snapshot: demo, tenancyId: "T3", today: TODAY, options: { proposedRent: 190 } });
  // last increase 1 April 2026, so not before 1 April 2027
  assert.match(d.body, /Earliest start date for the new rent: 1 April 2027/);
  assert.match(d.body, /per week/);
});

test("landlord register chaser lists only English properties", () => {
  const d = buildDraft("landlordRegisterChaser", { snapshot: demo, landlordId: "L1", today: TODAY });
  assert.match(d.body, /15 December 2026/);
  assert.match(d.body, /15 March 2027/);
  assert.match(d.body, /Harborne Road/);
  assert.match(d.body, /Rose Court/);
});

test("refused pet reply without a reason asks for one", () => {
  const d = buildDraft("petRequestReply", { snapshot: demo, tenancyId: "T5", today: TODAY });
  assert.match(d.body, /\[reason must be given\]/);
});
