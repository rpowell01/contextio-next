"use client";

import { useState, useEffect } from "react";
import { getSingletonHighlighter, codeToHtml } from "shiki";

interface SyntaxHighlighterProps {
  code: string;
  lang?: string;
  theme?: "github-light" | "github-dark";
}

export function SyntaxHighlighter({
  code,
  lang = "json",
  theme = "github-light",
}: SyntaxHighlighterProps) {
  const [highlighter, setHighlighter] = useState<Awaited<ReturnType<typeof getSingletonHighlighter>> | null>(null);

  useEffect(() => {
    getSingletonHighlighter().then(setHighlighter);
  }, []);

  const darkTheme = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const effectiveTheme = darkTheme ? "github-dark" : theme;

  if (!highlighter) {
    return <pre className="font-mono text-xs overflow-auto"><code>{code}</code></pre>;
  }

  const html = codeToHtml(code, { lang, theme: effectiveTheme });

  return <pre className="font-mono text-xs overflow-auto" dangerouslySetInnerHTML={{ __html: html }} />;
}