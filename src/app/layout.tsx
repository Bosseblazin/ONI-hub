import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Interplanetary Command",
  description: "Colony Operations and Intelligence System for Oxygen Not Included: Spaced Out!",
};
export const viewport: Viewport = { themeColor: "#0a0d11", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
