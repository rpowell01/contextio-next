export const dynamic = 'force-dynamic';

import { RedactionsContent } from "./redactions-content";

/**
 * Page wrapper that provides PageLoadProvider via MainLayout.
 * Force dynamic to prevent static pre-rendering issues with usePageLoad context.
 */
export default function RedactionsPage() {
  return (
    <main>
      <RedactionsContent />
    </main>
  );
}