"use client";

import { Header, HeaderProps } from "@/components/header";

/**
 * Props for the MainLayout component.
 */
interface MainLayoutProps {
  /** The main content to render */
  children: React.ReactNode;
  /** Optional props to pass to the Header component */
  headerProps?: HeaderProps;
}

/**
 * Main layout component that provides a consistent page structure.
 * Includes a Header at the top and a main content area.
 */
export function MainLayout({ children, headerProps }: MainLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header {...headerProps} />
      <main className="flex flex-1 flex-col p-4 md:p-6">{children}</main>
    </div>
  );
}