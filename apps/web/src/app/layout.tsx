import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CareerFlow AI", template: "%s · CareerFlow AI" },
  description: "Your AI job-application agent.",
  robots: { index: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
