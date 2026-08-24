"use client";

import { cn } from "@/lib/utils";

interface RedactionBadgesProps {
  stats?: {
    totalRedactions: number;
    byRule: Record<string, number>;
  };
  className?: string;
}

export function RedactionBadges({ stats, className }: RedactionBadgesProps) {
  if (!stats || !stats.totalRedactions || !Object.keys(stats.byRule).length) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        No redactions
      </span>
    );
  }

  const entries = Object.entries(stats.byRule).filter(([, count]) => count > 0);

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      <span className="inline-flex items-center rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive border border-destructive/20">
        {stats.totalRedactions} redaction{stats.totalRedactions === 1 ? "" : "s"}
      </span>
      {entries.map(([rule, count]) => (
        <span
          key={rule}
          className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground border"
        >
          <span className="capitalize">{rule.replace(/_/g, " ")}</span>
          <span className="ml-1 text-muted-foreground">{count}</span>
        </span>
      ))}
    </span>
  );
}