import type { Metadata, Viewport } from "next";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "Threads — room for a second thought",
  description: "A quiet place to think. Keep follow-up conversations anchored to the words that started them.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#20262F" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
