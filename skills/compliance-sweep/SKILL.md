---
name: compliance-sweep
description: Use when a letting agent asks which tenancies are at risk, what needs doing this week, or for a Renters' Rights Act compliance check across their portfolio.
---

# Compliance sweep

1. Call `list_findings` with no filters to get the totals and the most urgent items.
2. Lead with the answer in one or two sentences: how many critical items, and the single most urgent one with its due date.
3. Group the rest by what the agent has to do, not by rule:
   - **Send something to a tenant** (Information Sheet, written statement, pet reply)
   - **Fix money** (rent above advert, too much rent in advance, invalid rent increase)
   - **Chase a landlord** (register, pet decision)
   - **Tidy the CRM** (info items)
4. For each group, name the tenancies by property address, not by id, and offer the matching draft.
5. Mention any skipped tenancies (for example Wales) in one line.

Rules:
- Never call anything legal advice or say a tenancy "is compliant". Say "no issues found by these checks".
- Never claim something was sent or saved. The tools are read-only.
- If the agent wants detail on one property, use `check_tenancy`.
