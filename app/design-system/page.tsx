import { notFound } from "next/navigation";
import { DesignSystemCatalog } from "@/components/ui/design-system-catalog";
import { isProductionEnvironment } from "@/lib/server/config";

/** Development-only live companion to docs/DESIGN_SYSTEM.md. */
export default function DesignSystemPage() {
  if (isProductionEnvironment(process.env.NODE_ENV)) notFound();
  return <DesignSystemCatalog/>;
}
