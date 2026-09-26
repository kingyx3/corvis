"use client";

import { useState } from "react";
import { CompositionChart } from "./charts/composition-chart";
import { Icon } from "./icon";
import { MetricCard } from "./metric-card";
import { PageHeading } from "./page-heading";
import { SidebarNavItem } from "./sidebar-nav-item";
import { SortableDataTable, type SortableColumn } from "./sortable-data-table";
import { StatusPill, STATUS_PILL_VOCABULARY } from "./status-pill";
import { TableDensityToggle, type TableDensity } from "./table-density-toggle";

type ExampleRow = { name: string; kind: string; count: number };
const EXAMPLE_ROWS: ExampleRow[] = [
  { name: "Northstar Growth", kind: "Fund", count: 24 },
  { name: "Meridian Software", kind: "Company", count: 17 },
  { name: "Atlas Credit", kind: "Fund", count: 9 },
];
const EXAMPLE_COLUMNS: SortableColumn<ExampleRow>[] = [
  { id: "name", header: "Name", rowHeader: true, render: (row) => row.name, sortValue: (row) => row.name },
  { id: "kind", header: "Type", render: (row) => row.kind, sortValue: (row) => row.kind },
  { id: "count", header: "Facts", align: "end", render: (row) => row.count.toLocaleString(), sortValue: (row) => row.count },
];

/** Live examples for docs/design-system.md. This page is development-only. */
export function DesignSystemCatalog() {
  const [density, setDensity] = useState<TableDensity>("comfortable");
  return <main className="design-system-catalog">
    <PageHeading eyebrow="Developer catalog" title="Corvis design system" description="Live reference for reusable workspace primitives. Production surfaces should import these components instead of recreating their JSX patterns." />

    <section className="design-system-section"><h2>Actions and statuses</h2><div className="design-system-row"><button className="primary-button">Primary action</button><button className="secondary-button">Secondary action</button><button className="danger-button">Destructive action</button></div><div className="design-system-row">{Object.keys(STATUS_PILL_VOCABULARY).slice(0, 12).map((status) => <StatusPill key={status} status={status}/>) }<StatusPill status="Future workflow state"/></div></section>

    <section className="design-system-section"><h2>Metric cards</h2><div className="metric-grid"><MetricCard label="Trusted facts" value="1,284" detail="Across 37 holdings" icon={<Icon name="database"/>}/><MetricCard label="Needs attention" value="3" detail="1 blocking · 2 to review" icon={<Icon name="alert"/>} tone="warning"/></div></section>

    <section className="design-system-section"><h2>Sidebar navigation item</h2><div className="design-system-nav-sample"><nav aria-label="Catalog navigation example"><SidebarNavItem label="Overview" icon="home" active onSelect={() => {}}/><SidebarNavItem label="Data review" icon="table" badge={3} onSelect={() => {}}/></nav></div></section>

    <section className="design-system-section"><h2>Sortable dense table</h2><div className="design-system-row"><TableDensityToggle value={density} onChange={setDensity}/></div><div className="data-table-wrap"><SortableDataTable caption="Design system sortable table example" rows={EXAMPLE_ROWS} columns={EXAMPLE_COLUMNS} rowKey={(row) => row.name} density={density}/></div></section>

    <section className="design-system-section"><h2>Accessible composition chart</h2><CompositionChart eyebrow="Allocation" title="Example exposure" description="Chart primitives always expose the same values through a tabular fallback." items={[{ key: "growth", label: "Growth", value: 52 }, { key: "credit", label: "Credit", value: 31 }, { key: "other", label: "Other", value: 17 }]} unitLabel="Exposure"/></section>
  </main>;
}
