import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import "../globals.css";
import { DEFAULT_SETTINGS, applyEnvOverrides } from "@/lib/settings";

export const metadata: Metadata = {
  title: "ContextIO-Next Web",
  description: "Web interface for ContextIO-Next proxy monitoring and inspection",
  icons: {
    icon: [
      { url: "/ContextIO-Next-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/ContextIO-Next-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/ContextIO-Next-48x48.png", sizes: "48x48", type: "image/png" },
      { url: "/ContextIO-Next-64x64.png", sizes: "64x64", type: "image/png" },
    ],
    shortcut: "/ContextIO-Next-32x32.png",
    apple: "/ContextIO-Next-64x64.png",
    other: [
      { rel: "icon", url: "/ContextIO-Next-64x64.png", sizes: "192x192", type: "image/png" },
      { rel: "icon", url: "/ContextIO-Next-64x64.png", sizes: "512x512", type: "image/png" },
      { rel: "manifest", url: "/site.webmanifest" },
    ],
  },
};

// Read the server-resolved theme (including CONTEXTIO_THEME env override) so the
// anti-flash script can apply it before first paint, not just localStorage.
async function getServerTheme(): Promise<string> {
  try {
    // Get settings from database (no env keys yet)
    const { getSettingsWithMeta } = await import("@contextio/core/db");
    const { settings: dbSettings } = getSettingsWithMeta();
    
    // Handle case where settings might be null (database empty)
    const settings = dbSettings ?? DEFAULT_SETTINGS;
    
    // Apply environment variable overrides
    const { settings: effectiveSettings, appliedKeys } = applyEnvOverrides(settings);
    
    // Only use the server theme if it came from an env override (dynamic) or was
    // explicitly saved; otherwise fall back to client localStorage / OS default.
    if (appliedKeys.has("theme")) {
      return effectiveSettings.theme;
    }
    return settings.theme;
  } catch {
    return DEFAULT_SETTINGS.theme;
  }
}

// Inline script that sets the theme before the body paints to prevent a flash of the wrong theme.
// This is a plain inline script (not next/script) so it executes synchronously and blocks first paint.
function makeThemeInitScript(serverTheme: string): string {
  return `(function() {
  try {
    var serverTheme = ${JSON.stringify(serverTheme)};
    var stored = serverTheme || localStorage.getItem('contextio-theme');
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
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const serverTheme = await getServerTheme();
  const themeInitScript = makeThemeInitScript(serverTheme);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        <ThemeProvider initialTheme={serverTheme as "light" | "dark" | "system" | "high-contrast"}>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}