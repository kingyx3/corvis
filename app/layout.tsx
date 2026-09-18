import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Corvis — Private Markets Data",
  description: "Trusted fund-period data from private-markets reporting.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
