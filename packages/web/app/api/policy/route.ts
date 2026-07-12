import fs from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { policySchema } from "@/lib/schema";
import type { RedactionPolicy } from "@/types/api";
import { join } from "path";
import { consumeToken } from "@/lib/csrf";

// Default policy - bundled with the application (used as fallback)
const bundledDefaultPolicy: RedactionPolicy = {
  extends: "secrets",
  rules: [],
  allowlist: {
    strings: [],
    patterns: [],
  },
  paths: {
    only: [],
    skip: [],
  },
};

// Policy file paths - custom file (user-modifiable) or bundled default
// Use REDACT_POLICY_FILE to match the redact plugin's environment variable
const CUSTOM_POLICY_PATH = process.env.REDACT_POLICY_FILE || "/app/custom-policy/custom-policy.json";
// BUNDLED_POLICY_PATH can be set via env for Docker, otherwise use relative path
const BUNDLED_POLICY_PATH = process.env.BUNDLED_POLICY_PATH || "/app/default-policy.json";

async function loadPolicyFromFile(): Promise<RedactionPolicy> {
  try {
    // First, try to load the custom policy file
    const content = await fs.readFile(CUSTOM_POLICY_PATH, "utf-8");
    const parsed = JSON.parse(content);
    const result = policySchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    console.warn("Policy file validation failed, using defaults");
    return { ...bundledDefaultPolicy };
  } catch (error) {
    // Custom file doesn't exist or is invalid - try bundled default
    try {
      const bundledContent = await fs.readFile(BUNDLED_POLICY_PATH, "utf-8");
      const parsed = JSON.parse(bundledContent);
      const result = policySchema.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
    } catch (bundledError) {
      // Try fallback to public/default-policy.json for development
      try {
        const devPolicyPath = join(process.cwd(), "public", "default-policy.json");
        const devContent = await fs.readFile(devPolicyPath, "utf-8");
        const parsed = JSON.parse(devContent);
        const result = policySchema.safeParse(parsed);
        if (result.success) {
          return result.data;
        }
      } catch (devError) {
        // Fall through to in-memory default
      }
    }
    console.warn("Failed to load policy file, using in-memory defaults");
    return { ...bundledDefaultPolicy };
  }
}

async function savePolicyToFile(policy: RedactionPolicy): Promise<void> {
  try {
    // Ensure directory exists with proper permissions
    const dir = CUSTOM_POLICY_PATH.substring(0, CUSTOM_POLICY_PATH.lastIndexOf("/"));
    
    // Try to create directory, ignore if it already exists
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o777 });
    } catch {
      // Directory might already exist or we don't have permission
    }
    
    // Write the policy file
    await fs.writeFile(CUSTOM_POLICY_PATH, JSON.stringify(policy, null, 2), "utf-8");
    
    // Ensure the file has proper permissions (world-writable for container environments)
    try {
      await fs.chmod(CUSTOM_POLICY_PATH, 0o666);
    } catch {
      // Ignore chmod errors (may not be supported on all filesystems)
    }
  } catch (error) {
    console.error("Failed to save policy file:", error);
    console.error("Error details:", error instanceof Error ? {
      message: error.message,
      code: (error as NodeJS.ErrnoException).code,
      errno: (error as NodeJS.ErrnoException).errno,
      syscall: (error as NodeJS.ErrnoException).syscall,
      path: (error as NodeJS.ErrnoException).path
    } : error);
    // Preserve the original error for better debugging
    throw error;
  }
}

export async function GET(_request: NextRequest) {
  try {
    const policy = await loadPolicyFromFile();
    return NextResponse.json(policy);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to load policy" },
      { status: 500 }
    );
  }
}

// Debug endpoint to check file status
export async function POST(_request: NextRequest) {
  const debugInfo: Record<string, unknown> = {
    customPolicyPath: CUSTOM_POLICY_PATH,
    bundledPolicyPath: BUNDLED_POLICY_PATH,
  };

  try {
    // Check custom policy file
    const customStats = await fs.stat(CUSTOM_POLICY_PATH);
    debugInfo.customPolicyExists = true;
    debugInfo.customPolicyMode = customStats.mode.toString(8);
    debugInfo.customPolicySize = customStats.size;
  } catch (e) {
    debugInfo.customPolicyExists = false;
    debugInfo.customPolicyError = e instanceof Error ? e.message : String(e);
  }

  try {
    // Check default policy file
    const defaultStats = await fs.stat(BUNDLED_POLICY_PATH);
    debugInfo.defaultPolicyExists = true;
    debugInfo.defaultPolicyMode = defaultStats.mode.toString(8);
    debugInfo.defaultPolicySize = defaultStats.size;
  } catch (e) {
    debugInfo.defaultPolicyExists = false;
    debugInfo.defaultPolicyError = e instanceof Error ? e.message : String(e);
  }

  // Check directory permissions
  try {
    const dir = CUSTOM_POLICY_PATH.substring(0, CUSTOM_POLICY_PATH.lastIndexOf("/"));
    const dirStats = await fs.stat(dir);
    debugInfo.directoryExists = true;
    debugInfo.directoryMode = dirStats.mode.toString(8);
  } catch (e) {
    debugInfo.directoryExists = false;
    debugInfo.directoryError = e instanceof Error ? e.message : String(e);
  }

  // Check process info
  debugInfo.processUid = process.getuid?.() ?? "N/A";
  debugInfo.processGid = process.getgid?.() ?? "N/A";
  debugInfo.cwd = process.cwd();

  return NextResponse.json(debugInfo);
}

export async function PUT(request: NextRequest) {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return NextResponse.json({ error: "Invalid or missing CSRF token" }, { status: 400 });
    }
    const body = await request.json();
    
    // Validate the policy
    const result = policySchema.safeParse(body);
    if (!result.success) {
      const errorDetails = result.error.errors.map((err) => ({
        path: err.path.join("."),
        message: err.message,
      }));
      return NextResponse.json(
        { error: "Invalid policy", details: errorDetails },
        { status: 400 }
      );
    }
    
    // Save the policy to file
    await savePolicyToFile(result.data);
    
    return NextResponse.json(result.data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    const errorCode = (error as NodeJS.ErrnoException)?.code;
    const errorErrno = (error as NodeJS.ErrnoException)?.errno;
    const errorSyscall = (error as NodeJS.ErrnoException)?.syscall;
    const errorPath = (error as NodeJS.ErrnoException)?.path;
    console.error("Failed to save policy:", error);
    return NextResponse.json(
      { 
        error: "Failed to save policy", 
        details: errorMessage, 
        stack: errorStack,
        code: errorCode,
        errno: errorErrno,
        syscall: errorSyscall,
        path: errorPath
      },
      { status: 500 }
    );
  }
}