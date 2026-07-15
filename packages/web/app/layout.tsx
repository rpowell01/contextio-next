import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('contextio-theme');
                  if (theme) {
                    document.documentElement.setAttribute('data-theme', theme === 'system' 
                      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
                      : theme);
                  } else {
                    // No saved preference - use system preference
                    document.documentElement.setAttribute('data-theme', 
                      window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
                  }
                } catch (e) {
                  document.documentElement.setAttribute('data-theme', 'light');
                }
              })();
            `,
          }}
        />
      </head>
      <body className={`antialiased`}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}