import type { ActivityRecord, DocumentRecord, FundSnapshot, ObservationRecord } from "../../core/contracts.ts";
import type { PortfolioValueFact } from "../../core/workspace-summary.ts";

export const documents: DocumentRecord[] = [
  { id: "doc-adv-viii-q2", name: "Advent International GPE VIII — Q2 2026.pdf", fund: "Advent International GPE VIII", period: "Q2 2026", type: "Quarterly report", pages: 124, size: "86.4 MB", status: "Published", uploaded: "18 Sep, 08:31", quality: "High", observations: 486 },
  { id: "doc-nordic-v-q2", name: "Nordic Capital Fund V — June 2026.pdf", fund: "Nordic Capital Fund V", period: "Q2 2026", type: "Quarterly report", pages: 89, size: "44.8 MB", status: "Review", uploaded: "18 Sep, 08:12", quality: "Medium", observations: 327 },
  { id: "doc-eqt-ix-soi", name: "EQT IX — Schedule of Investments.xlsx", fund: "EQT IX", period: "Q2 2026", type: "Schedule of investments", pages: 12, size: "3.2 MB", status: "Extracting", progress: 68, uploaded: "18 Sep, 07:58", quality: "Pending", observations: 0 },
  { id: "doc-hg-genesis-q2", name: "Hg Genesis 9 — Investor Report Q2.pdf", fund: "Hg Genesis 9", period: "Q2 2026", type: "Investor report", pages: 151, size: "118.2 MB", status: "Queued", progress: 0, uploaded: "18 Sep, 07:54", quality: "Pending", observations: 0, processingState: "blocked" },
];

// fund/company/holding ids match lib/server/position-financial-statements-demo.ts's
// DEMO_POSITIONS, so drilling through from an observation to Position Financials
// (see features/review/review-view.tsx) lands on the matching demo position.
export const observations: ObservationRecord[] = [
  { id: "obs-1", company: "ABC Corp", fund: "Advent International GPE VIII", fundId: "fund-advent-viii", companyId: "company-abc-corp", holdingId: "holding-abc-corp", metric: "Adjusted EBITDA", value: "$125.0m", period: "LTM Jun-26", source: "p. 18 · Portfolio Company Summary", confidence: 99, state: "Approved", delta: "+8.7%" },
  { id: "obs-2", company: "ABC Corp", fund: "Advent International GPE VIII", fundId: "fund-advent-viii", companyId: "company-abc-corp", holdingId: "holding-abc-corp", metric: "Revenue", value: "$842.0m", period: "LTM Jun-26", source: "p. 18 · Portfolio Company Summary", confidence: 99, state: "Approved", delta: "+12.1%" },
  { id: "obs-3", company: "ABC Corp", fund: "Advent International GPE VIII", fundId: "fund-advent-viii", companyId: "company-abc-corp", holdingId: "holding-abc-corp", metric: "Net debt / EBITDA", value: "4.2x", period: "Jun-26", source: "p. 19 · Capital Structure", confidence: 97, state: "Approved", delta: "+0.3x" },
  { id: "obs-4", company: "Northstar Health", fund: "Nordic Capital Fund V", fundId: "fund-nordic-v", companyId: "company-northstar-health", holdingId: "holding-northstar-health", metric: "Fair value", value: "$294.5m", period: "30 Jun 2026", source: "p. 52 · Schedule of Investments", confidence: 91, state: "Needs review", delta: "+4.6%" },
  { id: "obs-5", company: "Project Sparrow", fund: "EQT IX", fundId: "fund-eqt-ix", companyId: "company-project-sparrow", holdingId: "holding-project-sparrow", metric: "Ownership", value: "61.4%", period: "30 Jun 2026", source: "p. 67 · Investment Summary", confidence: 83, state: "Needs review", delta: "—" },
];

export const fundSnapshots: FundSnapshot[] = [
  { fund: "Advent International GPE VIII", period: "Q2 2026", status: "Published", holdings: 37, facts: 486, changed: "24m ago" },
  { fund: "Nordic Capital Fund V", period: "Q2 2026", status: "Review", holdings: 22, facts: 327, changed: "43m ago" },
  { fund: "EQT IX", period: "Q1 2026", status: "Published", holdings: 41, facts: 532, changed: "12 Jun" },
  { fund: "Hg Genesis 9", period: "Q1 2026", status: "Published", holdings: 31, facts: 408, changed: "7 Jun" },
];

// Published NAV history behind the Overview value trend and exposure breakdown.
// Only published fund periods appear (Nordic Capital Fund V's Q2 2026 period is
// still in review, so it contributes nothing), matching the server rollup rule.
// Snapshot ids for the current periods match customer-journey-store's seeded
// ids (seed-snapshot-N, in fundSnapshots order); earlier periods are history.
function navFact(snapshotId: string, fundId: string, fund: string, period: string, value: number): PortfolioValueFact {
  return { snapshotId, fundId, fund, period, publishedAt: null, metricCode: "nav", currency: "USD", value, factCount: 1 };
}
export const portfolioValueFacts: PortfolioValueFact[] = [
  navFact("history-adv-viii-q3-25", "fund-advent-viii", "Advent International GPE VIII", "Q3 2025", 1_812_000_000),
  navFact("history-adv-viii-q4-25", "fund-advent-viii", "Advent International GPE VIII", "Q4 2025", 1_864_000_000),
  navFact("history-adv-viii-q1-26", "fund-advent-viii", "Advent International GPE VIII", "Q1 2026", 1_903_000_000),
  navFact("seed-snapshot-1", "fund-advent-viii", "Advent International GPE VIII", "Q2 2026", 1_958_000_000),
  navFact("history-eqt-ix-q3-25", "fund-eqt-ix", "EQT IX", "Q3 2025", 1_214_000_000),
  navFact("history-eqt-ix-q4-25", "fund-eqt-ix", "EQT IX", "Q4 2025", 1_236_000_000),
  navFact("seed-snapshot-3", "fund-eqt-ix", "EQT IX", "Q1 2026", 1_271_000_000),
  navFact("history-hg-genesis-9-q3-25", "fund-hg-genesis-9", "Hg Genesis 9", "Q3 2025", 684_000_000),
  navFact("history-hg-genesis-9-q4-25", "fund-hg-genesis-9", "Hg Genesis 9", "Q4 2025", 702_000_000),
  navFact("seed-snapshot-4", "fund-hg-genesis-9", "Hg Genesis 9", "Q1 2026", 719_000_000),
];

export const recentActivity: ActivityRecord[] = [
  { title: "Advent VIII Q2 snapshot published", detail: "486 trusted observations · 37 holdings", time: "24m" },
  { title: "4 observations need review", detail: "Nordic Capital Fund V · Q2 2026", time: "39m" },
  { title: "EQT IX source ingestion started", detail: "Schedule of Investments.xlsx", time: "48m" },
  { title: "Restatement detected", detail: "ABC Corp · Revenue · Q1 2026", time: "1h" },
];

export const researchSuggestions = [
  "What changed across my funds this quarter?",
  "Which companies had two quarters of declining EBITDA?",
  "Show exposure to ABC Corp, direct and look-through",
  "Where did leverage increase by more than 1.0x?",
];
