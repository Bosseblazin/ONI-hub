import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegister } from "@/components/sw-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "Interplanetary Command",
  description: "Colony Operations and Intelligence System for Oxygen Not Included: Spaced Out!",
  manifest: "/manifest.webmanifest",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192" }], apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }] },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Command" },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: "#0a0d11", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
