export type DocumentStatus = "Published" | "Review" | "Extracting" | "Queued";

export type DocumentRecord = {
  id: string;
  name: string;
  fund: string;
  period: string;
  type: string;
  pages: number;
  size: string;
  status: DocumentStatus;
  progress?: number;
  uploaded: string;
  quality: "High" | "Medium" | "Pending";
  observations: number;
};

export const documents: DocumentRecord[] = [
  {
    id: "doc-adv-viii-q2",
    name: "Advent International GPE VIII — Q2 2026.pdf",
    fund: "Advent International GPE VIII",
    period: "Q2 2026",
    type: "Quarterly report",
    pages: 124,
    size: "86.4 MB",
    status: "Published",
    uploaded: "18 Sep, 08:31",
    quality: "High",
    observations: 486,
  },
  {
    id: "doc-nordic-v-q2",
    name: "Nordic Capital Fund V — June 2026.pdf",
    fund: "Nordic Capital Fund V",
    period: "Q2 2026",
    type: "Quarterly report",
    pages: 89,
    size: "44.8 MB",
    status: "Review",
    uploaded: "18 Sep, 08:12",
    quality: "Medium",
    observations: 327,
  },
  {
    id: "doc-eqt-ix-soi",
    name: "EQT IX — Schedule of Investments.xlsx",
    fund: "EQT IX",
    period: "Q2 2026",
    type: "Schedule of investments",
    pages: 12,
    size: "3.2 MB",
    status: "Extracting",
    progress: 68,
    uploaded: "18 Sep, 07:58",
    quality: "Pending",
    observations: 0,
  },
  {
    id: "doc-hg-genesis-q2",
    name: "Hg Genesis 9 — Investor Report Q2.pdf",
    fund: "Hg Genesis 9",
    period: "Q2 2026",
    type: "Investor report",
    pages: 151,
    size: "118.2 MB",
    status: "Queued",
    progress: 0,
    uploaded: "18 Sep, 07:54",
    quality: "Pending",
    observations: 0,
  },
];

export const observations = [
  {
    id: "obs-1",
    company: "ABC Corp",
    metric: "Adjusted EBITDA",
    value: "$125.0m",
    period: "LTM Jun-26",
    source: "p. 18 · Portfolio Company Summary",
    confidence: 99,
    state: "Approved",
    delta: "+8.7%",
  },
  {
    id: "obs-2",
    company: "ABC Corp",
    metric: "Revenue",
    value: "$842.0m",
    period: "LTM Jun-26",
    source: "p. 18 · Portfolio Company Summary",
    confidence: 99,
    state: "Approved",
    delta: "+12.1%",
  },
  {
    id: "obs-3",
    company: "ABC Corp",
    metric: "Net debt / EBITDA",
    value: "4.2x",
    period: "Jun-26",
    source: "p. 19 · Capital Structure",
    confidence: 97,
    state: "Approved",
    delta: "+0.3x",
  },
  {
    id: "obs-4",
    company: "Northstar Health",
    metric: "Fair value",
    value: "$294.5m",
    period: "30 Jun 2026",
    source: "p. 52 · Schedule of Investments",
    confidence: 91,
    state: "Needs review",
    delta: "+4.6%",
  },
  {
    id: "obs-5",
    company: "Project Sparrow",
    metric: "Ownership",
    value: "61.4%",
    period: "30 Jun 2026",
    source: "p. 67 · Investment Summary",
    confidence: 83,
    state: "Needs review",
    delta: "—",
  },
];

export const fundSnapshots = [
  { fund: "Advent International GPE VIII", period: "Q2 2026", status: "Published", holdings: 37, facts: 486, changed: "24m ago" },
  { fund: "Nordic Capital Fund V", period: "Q2 2026", status: "Review", holdings: 22, facts: 327, changed: "43m ago" },
  { fund: "EQT IX", period: "Q1 2026", status: "Published", holdings: 41, facts: 532, changed: "12 Jun" },
  { fund: "Hg Genesis 9", period: "Q1 2026", status: "Published", holdings: 31, facts: 408, changed: "7 Jun" },
];

export const recentActivity = [
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
