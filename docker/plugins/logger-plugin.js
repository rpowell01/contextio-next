import { createLoggerPlugin } from "@contextio/logger";

const captureDir = process.env.LOGGER_CAPTURE_DIR || "/app/captures";
const maxSessions = process.env.LOGGER_MAX_SESSIONS ? parseInt(process.env.LOGGER_MAX_SESSIONS, 10) : 0;

// Encryption at rest configuration
// Required: CONTEXTIO_LOGGER_ENCRYPTION_ENABLED=true
// Required: CONTEXTIO_LOGGER_ENCRYPTION_KEY=<actual_key_value>
// Optional overrides (have defaults in proxy config):
//   CONTEXTIO_LOGGER_ENCRYPTION_KEY_PROVIDER (default: "env")
//   CONTEXTIO_LOGGER_ENCRYPTION_KEY_LENGTH (default: 32)
//   CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY (only if keyProvider="static")
const encryptionEnabled = process.env.CONTEXTIO_LOGGER_ENCRYPTION_ENABLED === "true";
const keyProvider = process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY_PROVIDER || "env";
const staticKey = process.env.CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY;
const keyEnvVar = "CONTEXTIO_LOGGER_ENCRYPTION_KEY";
const keyLength = process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY_LENGTH ? parseInt(process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY_LENGTH, 10) : 32;

let encryption = undefined;
if (encryptionEnabled) {
  encryption = { enabled: true, keyProvider, staticKey, keyEnvVar, keyLength };
}

console.log("Logger plugin: captureDir =", captureDir);
console.log("Logger plugin: encryptionEnabled =", encryptionEnabled);

if (encryptionEnabled) {
  console.log("[startup] Encryption at rest configuration:");
  console.log("  enabled: true");
  console.log("  keyProvider:", keyProvider);
  console.log("  keyEnvVar:", keyEnvVar);
  console.log("  keyLength:", keyLength, "bytes");
  console.log("  staticKey provided:", !!staticKey);
  const keyValue = process.env[keyEnvVar];
  console.log(`  ${keyEnvVar} environment variable:`, keyValue ? "SET" : "NOT SET");
  if (keyValue) console.log(`  ${keyEnvVar} length:`, keyValue.length, "chars");
}

export default () => createLoggerPlugin({ captureDir, maxSessions, encryption });