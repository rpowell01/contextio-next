import { PresidioTsDetector } from "./packages/redact/src/presidioTsDetector.js";

// Test the labels getter with aliases
const detector = new PresidioTsDetector({
  name: "test",
  labels: ["EMAIL", "PHONE", "SSN", "EMAIL_ADDRESS", "PHONE_NUMBER"]
});

console.log("Config labels:", detector.config.labels);
console.log("Getter labels:", detector.labels);
