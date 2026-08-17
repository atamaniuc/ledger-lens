---
name: prd
description: Write and maintain a Product Requirements Document — business context, success metrics (North Star/proxy/counter-metrics), prioritized user stories (P0/P1/P2), non-functional constraints, user flow, and out-of-scope boundaries, with an optional AI Build Brief appendix (data models, API surface, component inventory, file structure) for handing the spec to an AI prototyping tool. Use when starting a new product feature, asked to write/update/revise a PRD, or asked to turn a feature idea into requirements before design or engineering work begins.
argument-hint: "[feature or project name]"
---

# PRD Skill

Write Product Requirements Documents for two audiences at once: the
cross-functional human team (PM, engineering, design, QA) who has five to
seven minutes to read it, and — when the section applies — an AI
prototyping/coding tool that needs an unambiguous build brief.

## Approach

- **Write simply.** No corporate jargon. A junior engineer and a marketing
  stakeholder should both understand every sentence on first read.
- **Use visual anchors.** Screenshots of the current UI, process diagrams
  (Mermaid), links to Figma/Miro prototypes — a picture answers a question
  a paragraph raises.
- **Focus on "What," not "How."** Describe the user-facing logic and the
  business reason it exists. Don't dictate database schema, function
  names, or component internals in the core document — that belongs only
  in the optional AI Build Brief appendix, and only when the reader is a
  build tool, not a human stakeholder.
- **Update the status, don't silently rewrite history.** If requirements
  change mid-build, record the change and flag it to the team — edit the
  metadata status and note what changed, rather than quietly rewriting a
  section as if it always said that.
- **Keep it short.** A well-written PRD reads in 5–7 minutes. If a section
  doesn't apply to this feature, omit it — don't pad it to look complete.

## Before generating: ask, one question at a time

Don't guess the essentials. Ask conversationally, one at a time, building
on each answer:

1. What problem are we solving, and who feels the pain most?
2. Who's the target audience/segment for this?
3. What's the business goal this serves (growth, retention, new market,
   cost reduction)?
4. What's the one metric that tells us we won.
5. Any hard constraints already known (platform, compliance, deadline,
   preferred stack)?
6. Is this PRD going to be handed to an AI prototyping/coding tool as a
   build brief, or is it staying at the human-team spec level? (Decides
   whether the AI Build Brief appendix gets included.)

Suggest things the requester might not have thought to mention: empty
states, error states, offline behavior, localization, what happens under
load, who signs off.

## PRD structure

Use this structure. Skip any section that doesn't apply — don't leave a
placeholder that just says "N/A," omit the heading entirely.

---

### 0. Metadata

| Field | Value |
|---|---|
| Status | Draft / In Review / Approved / Archived |
| Author (PO) | |
| Participants | CTO, Lead Designer, QA, ... |
| Timeline | Target release date |

---

### 1. Context & Business Value

**Problem:** The user pain this addresses, in plain language.

**Business goal:** Why the company should care — conversion, retention,
new-market entry, cost, risk reduction. Name the actual driver, not a
generic "improve the product."

**Target audience:** Which segments or personas this is for.

---

### 2. Success Metrics

**North Star metric:** The single measurable outcome that defines winning.
Example: "Day-1 retention +5%."

**Proxy metrics:** Earlier, faster signals that correlate with the North
Star. Example: "Checkout time −15 seconds."

**Counter-metrics (health metrics):** What must *not* get worse. Example:
"Support ticket volume for payments."

---

### 3. Functional Requirements

One table, prioritized. P0 = release blocks without it. P1 = important,
can ship next sprint. P2 = backlog / nice-to-have.

| ID | User Story | Priority | Acceptance Criteria |
|---|---|---|---|
| US-01 | As a [role], I want to [action], so that [benefit]. | P0 | Binary, testable: "X happens when Y," not "works correctly." |
| US-02 | ... | P1 | ... |

Worked example, for calibrating tone and specificity:

| ID | User Story | Priority | Acceptance Criteria |
|---|---|---|---|
| US-01 | As a shopper, I want to pay via SBP (Fast Payment System), so I don't have to type card details manually. | P0 | SBP button is active; a QR code is generated; order status changes to "Paid" once the transaction confirms. |
| US-02 | As a shopper, I want to see my SBP payment history in my account. | P1 | Order history shows an SBP icon next to the payment method. |

---

### 4. Non-Functional Requirements & Constraints

**Technical constraints:** Supported platform versions (iOS/Android/
browsers), load requirements (RPS), latency budgets.

**Localization:** Which languages/locales the interface must support.

**Security / Legal:** Compliance requirements (GDPR, etc.), PII handling,
data residency.

---

### 5. User Flow & Design

Links to interactive prototypes (Figma, Miro). Description of key screens
and states — not just the happy path: empty states, validation errors,
success/confirmation screens.

---

### 6. Out of Scope

Explicit boundaries, stated as plainly as the in-scope items — this is
what prevents scope creep, not an afterthought section. Example: "This
release does NOT include Apple Pay — cards only."

---

### Appendix: AI Build Brief (optional — include only if this PRD hands off to an AI prototyping/coding tool)

Everything below is engineering-facing and belongs in an appendix, not
the core document a marketing stakeholder reads. Include only the
sub-sections that add real signal for the build tool; omit the rest.

**AI Build Summary** — one imperative-voice paragraph: what to build,
what stack (if known), the hardest constraint. Example: "Build a Next.js
14 + Supabase feature that lets shoppers pay via SBP. No saved-card
storage in MVP. Must support the QR-code polling flow."

**Jobs to Be Done** — reframe the top 2–5 user stories as: *"When
[situation], I want to [motivation], so I can [expected outcome]."* This
gives a build tool the situational "why" a user story alone doesn't
carry.

**Component Inventory** — flat list of UI components required.

| Component | Type | Description | Linked Stories |
|---|---|---|---|
| [Name] | Form / Layout / Action / Display / Navigation / Modal | What it does | US-01 |

**Data Models** — the shape of everything this feature creates, reads,
updates, or deletes. TypeScript interfaces if the stack uses TS; JSON
Schema or plain field descriptions otherwise.

```typescript
interface Example {
  id: string;          // UUID
  createdAt: string;   // ISO8601
  // ...
}
```

**API / Integration Surface** — every endpoint or external integration
this feature touches. For a BaaS (Supabase/Firebase), describe the table
operations instead of REST routes.

| Method | Path | Description | Auth required | Response shape |
|---|---|---|---|---|
| POST | /api/[resource] | Create [resource] | Yes | `Model` |

**State Management Map** — where each piece of state lives and why.

| State | Location | Persistence | Notes |
|---|---|---|---|
| [name] | Server / Local UI / URL / Auth context / Cache | Session / Persistent / None | Why it lives here |

**Suggested File Structure** — an ASCII directory tree scoped to this
feature's code, omitting unchanged files.

**Acceptance Criteria (expanded)** — one checklist per user story, binary
and specific enough to paste into an AI coding tool or a QA checklist
without further clarification.

---

## After generating

Offer to drill into any section, adjust scope, or regenerate a section
after new information. If the requester says requirements changed after
this PRD was already in flight, update the Metadata status and note what
changed — don't silently rewrite an already-shared section as if it
always said the new thing.
