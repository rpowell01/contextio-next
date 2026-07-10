#!/usr/bin/env node

/**
 * Combined entry point: Proxy + Next.js on single port (4040)
 * 
 * This starts both the proxy server and Next.js web UI on a single port.
 * Routes:
 * - /admin/*      → Proxy admin API
 * - /chat/*, /v1/* → Proxy routing
 * - *             → Next.js app (web UI + /api/* endpoints)
 */

import type { ProxyPlugin } from "@contextio/core";
import { readFileSync } from "node:fs";

import { createCombinedProxy } from "./combined-server.js";

function readSecretFromFile(secretName: string): string | undefined {
  try {
    const secretPath = `/run/secrets/${secretName}`;
    return readFileSync(secretPath, "utf8").trim();
  } catch {
    return undefined;
  }
}

async function loadPluginsFromEnv(): Promise<ProxyPlugin[]> {
  const pluginsEnv = process.env.CONTEXT_PROXY_PLUGINS;
  if (!pluginsEnv) return [];

  const specifiers = pluginsEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const plugins: ProxyPlugin[] = [];
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier);
      const factory = mod.default ?? mod;
      if (typeof factory === "function") {
        const plugin = factory();
        if (plugin && typeof plugin === "object" && plugin.name) {
          plugins.push(plugin);
          console.log(`Loaded plugin: ${plugin.name} (from ${specifier})`);
        } else {
          console.error(
            `Plugin "${specifier}": factory did not return a valid plugin object`,
          );
        }
      } else if (factory && typeof factory === "object" && factory.name) {
        plugins.push(factory);
        console.log(`Loaded plugin: ${factory.name} (from ${specifier})`);
      } else {
        console.error(
          `Plugin "${specifier}": module does not export a plugin or factory`,
        );
      }
    } catch (err: unknown) {
      console.error(
        `Failed to load plugin "${specifier}":`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return plugins;
}

async function main(): Promise<void> {
  // Load CSRF_SECRET from Docker secret file if available
  const csrfSecret = readSecretFromFile("CSRF_SECRET");
  if (csrfSecret) {
    process.env.CSRF_SECRET = csrfSecret;
    console.log("CSRF_SECRET loaded from Docker secret file");
  } else if (process.env.CSRF_SECRET) {
    console.log("CSRF_SECRET found in environment");
  } else {
    console.warn("CSRF_SECRET not found - CSRF protection will fail in production");
  }

  const plugins = await loadPluginsFromEnv();
  const logTraffic = process.env.LOG_TRAFFIC === "true";
  const proxy = createCombinedProxy({ plugins, logTraffic });
  await proxy.start();

  // Keep the process alive
  process.stdin.resume();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    proxy.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});