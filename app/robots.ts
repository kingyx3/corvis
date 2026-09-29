import type { MetadataRoute } from "next";

// Authenticated application: nothing behind the sign-in should be crawled or indexed.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
