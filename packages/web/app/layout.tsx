import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import "../globals.css";

export const metadata: Metadata = {
  title: "ContextIO-Next Web",
  description: "Web interface for ContextIO-Next proxy monitoring and inspection",
};

// Inline script that sets the theme before the body paints to prevent a flash of the wrong theme.
// This is a plain inline script (not next/script) so it executes synchronously and blocks first paint.
const themeInitScript = `(function() {
  try {
    var stored = localStorage.getItem('contextio-theme');
    var theme = stored;

    // Resolve 'system' stored value to OS preference or use it for first-time visitors
    if (theme === 'system' || !theme) {
      var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      theme = prefersDark ? 'dark' : 'light';
    }

    // Only set data-theme if we have a valid theme value (not null/undefined)
    if (theme) {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}