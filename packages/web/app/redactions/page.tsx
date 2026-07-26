"use client";

import { MainLayout } from "@/components/main-layout";
import { RedactionsContent } from "./redactions-content";

export const dynamic = 'force-dynamic';

/**
 * Page wrapper that provides PageLoadProvider via MainLayout.
 * Force dynamic to prevent static pre-rendering issues with usePageLoad context.
 */
export default function RedactionsPage() {
  return (
    <MainLayout>
      <RedactionsContent />
    </MainLayout>
  );
}