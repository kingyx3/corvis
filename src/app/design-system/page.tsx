import { notFound } from "next/navigation";
import { DesignSystemCatalog } from "@/shared/ui/design-system-catalog";
import { isProductionEnvironment } from "@/platform/config";

/** Development-only live companion to docs/architecture/DESIGN_SYSTEM.md. */
export default function DesignSystemPage() {
  if (isProductionEnvironment(process.env.NODE_ENV)) notFound();
  return <DesignSystemCatalog/>;
}
