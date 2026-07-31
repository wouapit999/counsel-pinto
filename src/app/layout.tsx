import type { Metadata } from "next";
import { Inter, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const sans = Inter({
  variable: "--font-sans-stack",
  subsets: ["latin"],
  display: "swap",
});

const serif = Source_Serif_4({
  variable: "--font-serif-stack",
  subsets: ["latin"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono-stack",
  subsets: ["latin"],
  display: "swap",
});

const DESCRIPTION =
  "Structured, jurisdiction-specific legal guidance for Cameroon, Mozambique and the CEMAC region, in English, French or Portuguese. Developed by Bouquet Innovation S.A.";

export const metadata: Metadata = {
  title: "Counsel Pinto — AI Legal Counsel | Cameroon · Mozambique · CEMAC",
  description: DESCRIPTION,
  applicationName: "Counsel Pinto",
  authors: [{ name: "Bouquet Innovation S.A" }],
  creator: "Bouquet Innovation S.A",
  publisher: "Bouquet Innovation S.A",
  openGraph: {
    title: "Counsel Pinto — AI Legal Counsel",
    description: DESCRIPTION,
    siteName: "Counsel Pinto",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Counsel Pinto — AI Legal Counsel",
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${serif.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
