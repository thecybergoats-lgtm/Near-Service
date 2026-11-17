import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Near Service — Admin Panel",
  description: "Admin panel for the Near Service local services marketplace (Quetta pilot).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
