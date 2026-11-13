import type { Metadata } from "next";
import { Instrument_Sans, Barlow_Condensed, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Same type system as the Trojan site: Instrument Sans for reading,
// Barlow Condensed for small labels, JetBrains Mono for numbers.
const sans = Instrument_Sans({ variable: "--font-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });
const condensed = Barlow_Condensed({ variable: "--font-condensed", subsets: ["latin"], weight: ["500", "600", "700"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400", "500"], display: "swap" });

export const metadata: Metadata = {
  title: "Steady Money Check-in",
  description: "Weekly Friday call list and a one-page halfway view, from an agency's own records.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${condensed.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
