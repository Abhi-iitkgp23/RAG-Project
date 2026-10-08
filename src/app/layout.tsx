import type { ReactNode } from "react";

export const metadata = {
  title: "Dietary guidance",
  description: "Answers from official public dietary guidance.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
