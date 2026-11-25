---
name: draft-for-approval
description: Use when a letting agent wants a letter, email or notice drafted to fix a Renters' Rights Act finding, such as an Information Sheet cover letter, Section 13 rent notice, pet reply or landlord register chaser.
---

# Draft for approval

1. If the finding is not already known, call `check_tenancy` first so the draft matches the record.
2. Call `draft_document` with the `kind` the finding suggests. Ask the agent for anything the draft needs and the record lacks:
   - `section13Notice`: `proposedRent` (and `serveDate` if not today)
   - `petRequestReply`: the landlord's `decision`, and a `reason` if refused
   - `section8NoticeSummary`: the `ground`
3. Show the draft, then the "Before sending" checklist exactly as returned.
4. Point out any placeholder in square brackets that the agent must fill in.
5. Remind the agent that nothing has been sent and they should record the date of service in the CRM once they send it.

Never remove the "DRAFT FOR REVIEW" banner, and never invent a landlord's decision or reason.
