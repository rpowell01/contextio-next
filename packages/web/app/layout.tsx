import type { Metadata } from "next";
import "../globals.css";

export const metadata: Metadata = {
  title: "ContextIO-Next Web",
  description: "Web interface for ContextIO-Next proxy monitoring and inspection",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`antialiased`}>
        {children}
      </body>
    </html>
  );
}