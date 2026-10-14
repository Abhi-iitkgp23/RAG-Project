import type { ReactNode } from "react";
import { Public_Sans, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const publicSans = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata = {
  title: "Dietary Guidance Assistant",
  description: "Evidence, made easier to understand.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${publicSans.variable} ${sourceSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
