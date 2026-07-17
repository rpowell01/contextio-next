"use client";

import { useState, useEffect } from "react";
import { createHighlighter } from "shiki";
import { useTheme } from "@/components/theme-provider";

interface SyntaxHighlighterProps {
  code: string;
  lang?: string;
}

export function SyntaxHighlighter({
  code,
  lang = "json",
}: SyntaxHighlighterProps) {
  const [highlighter, setHighlighter] = useState<Awaited<ReturnType<typeof createHighlighter>> | null>(null);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();

useEffect(() => {
  let highlighterInstance: Awaited<ReturnType<typeof createHighlighter>> | null = null;
  createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: ["json"],
  }).then((h) => {
    highlighterInstance = h;
    setHighlighter(h);
  });
  return () => {
    highlighterInstance?.dispose();
  };
}, []);

  // Map app theme to Shiki theme
  const shikiTheme = resolvedTheme === "dark" || resolvedTheme === "high-contrast" ? "github-dark" : "github-light";

  useEffect(() => {
    if (highlighter && code) {
      const html = highlighter.codeToHtml(code, { lang, theme: shikiTheme });
      setHighlightedHtml(html);
    } else if (!highlighter) {
      setHighlightedHtml(null);
    }
  }, [highlighter, code, lang, shikiTheme]);

  if (!highlighter || highlightedHtml === null) {
    return <pre className="font-mono text-xs overflow-auto"><code>{code}</code></pre>;
  }

  return <pre className="font-mono text-xs overflow-auto" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />;
}