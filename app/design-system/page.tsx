import { notFound } from "next/navigation";
import { DesignSystemCatalog } from "@/components/ui/design-system-catalog";

/** Development-only live companion to docs/DESIGN_SYSTEM.md. */
export default function DesignSystemPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DesignSystemCatalog/>;
}
