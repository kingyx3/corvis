import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "./globals.css";
import "./design-system.css";

export const metadata: Metadata = {
  title: "Corvis — Private Markets Data",
  description: "Trusted fund-period data from private-markets reporting.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#11261d" },
    { media: "(prefers-color-scheme: dark)", color: "#08110d" },
  ],
  colorScheme: "light dark",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Every response gets its own Content-Security-Policy script-src nonce (see proxy.ts), and
  // Next.js only applies a nonce to framework/page scripts during dynamic rendering. Force it here
  // so the whole tree renders per-request instead of being served from a prerendered static shell.
  await connection();

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
