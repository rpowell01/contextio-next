import { createRedactPlugin } from "@contextio/redact";

const preset = process.env.REDACT_PRESET || "pii";
const reversible = process.env.REDACT_REVERSIBLE === "true";
const policyFile = process.env.REDACT_POLICY_FILE || "/app/custom-policy/custom-policy.json";
const captureDir = process.env.REDACT_CAPTURE_DIR || process.env.LOGGER_CAPTURE_DIR || "/app/captures";

console.log("Redact plugin: policyFile =", policyFile);
console.log("Redact plugin: captureDir =", captureDir);

const config = policyFile ? { policyFile, reversible, captureDir } : { preset, reversible, captureDir };

export default () => createRedactPlugin(config);