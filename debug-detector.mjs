import { createRuleDetector } from './packages/redact/dist/ruleDetector.js';
import { PRESETS } from './packages/redact/dist/presets.js';

async function main() {
  const detector = await createRuleDetector({
    name: 'rules',
    rules: PRESETS.strict,
    allowlistStrings: new Set(PRESETS.strict.map(r => r.replacement)),
    placeholderAllowlist: new Set(PRESETS.strict.map(r => r.replacement)),
  });

  const testCases = [
    'Contact me at john.doe@example.com for more information.',
    'My phone number is +1-555-123-4567 and my email is jane@test.com.',
    'My SSN is 123-45-6789 for tax records.',
    'My credit card is 3782-822463-10005 for the purchase.',
    'Contact Dr. Emily Watson at emily@clinic.com.',
    'AWS Access Key: AKIAIOSFODNN7EXAMPLE',
    'GitHub token ghp_abcdefghijklmnopqrstuvwxyz123456 is active.',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'Server at 192.168.1.100 needs restart.',
    'Visit https://api.example.com/v1/users for docs.',
    'BSN number 123456782 for Dutch registration.',
    'NI number AB 12 34 56 C for UK employment.',
    'Private key -----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD...',
    'OpenRouter key sk-or-v1-abcdefghijklmnopqrstuvwxyz123456 used.',
    'NVIDIA key nvapi-abcdefghijklmnopqrstuvwxyz1234 for API.',
    'Kilo key kilo-abcdefghijklmnopqrstuvwxyz12345 for CLI.',
    'Generic secret api_token_xyz789abc123 with high entropy.',
    'Low entropy value aaaaaaaaaaaaaaaaaaaaaaaaaaaa not a secret.',
    'UUID 550e8400-e29b-41d4-a716-446655440000 is not a person.',
  ];

  for (const tc of testCases) {
    const result = await detector.detect(tc);
    console.log('Text:', tc);
    console.log('Spans:', JSON.stringify(result.spans, null, 2));
    console.log('---');
  }
}

main().catch(console.error);