import { expect, test } from "bun:test";
import { redactSensitive } from "./redact";

const credentials = [
  `sk-proj-${"a".repeat(80)}`, `sk-ant-api03-${"b".repeat(80)}`,
  `ghp_${"a".repeat(36)}`, `github_pat_${"b".repeat(80)}`, `glpat-${"c".repeat(20)}`,
  `xoxb-${"1".repeat(12)}-${"a".repeat(24)}`, `npm_${"a".repeat(36)}`,
  `pypi-${"a".repeat(60)}`, `hf_${"a".repeat(34)}`, `sb_secret_${"a".repeat(30)}`,
  `dop_v1_${"a".repeat(64)}`, `sk_live_${"a".repeat(24)}`, `whsec_${"a".repeat(24)}`,
  "AKIAIOSFODNN7EXAMPLE", `ASIA${"A".repeat(16)}`, `AIza${"a".repeat(35)}`,
  `SG.${"a".repeat(22)}.${"b".repeat(43)}`, `SK${"a".repeat(32)}`,
  `123456789:${"a".repeat(35)}`, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
  `api_key_${"a".repeat(24)}`, `token-${"a".repeat(24)}`,
];

test.each(credentials)("removes a recognized standalone credential: %s", (secret) => {
  expect(redactSensitive(`Please rotate ${secret} tomorrow.`)).toBe("Please rotate [REDACTED] tomorrow.");
});

test.each([
  ["password: hunter2", "hunter2"], ["PASSWORD=hunter2", "hunter2"],
  ['{"clientSecret":"value with spaces"}', "value with spaces"],
  ["AWS_SECRET_ACCESS_KEY='some/secret+value='", "some/secret+value="],
  ['apiKey="escaped\\\"secret"', "secret"], ["PIN: 1234", "1234"],
  ["OTP=567890", "567890"], ["CVV: 123", "123"],
  ["https://example.com/?access_token=opaque%2Fsecret&next=inbox", "opaque%2Fsecret"],
  ["https://example.com/?X-Amz-Signature=opaque-signature", "opaque-signature"],
  ["https://example.com/?sig=azure-signature", "azure-signature"],
  ["postgresql://user:secret@localhost/db", "user:secret"],
  ["https://user:secret@example.com/path", "user:secret"],
  ["Authorization: Bearer opaque.secret\nNext task", "opaque.secret"],
  ["Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
  ["Cookie: session=private; another=hidden", "private"],
  ["Set-Cookie: session=hidden; Secure", "hidden"],
  ["recovery phrase: abandon ability able about above absent absorb abstract absurd abuse access accident", "accident"],
  ['backup_codes="aaaa-bbbb cccc-dddd"', "cccc-dddd"],
  ["recovery codes: aaaa-bbbb cccc-dddd", "cccc-dddd"],
  ["passphrase: four words kept secret", "four words kept secret"],
])("filters labeled secrets and credentials in %s", (input, secret) => {
  const safe = redactSensitive(input);
  expect(safe).not.toContain(secret);
  expect(safe).toContain("[REDACTED]");
});

test.each(["RSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "EC PRIVATE KEY", "PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) (
  "removes an entire %s block, including partial and escaped captures", (kind) => {
    for (const newline of ["\n", "\\n"]) {
      const block = `-----BEGIN ${kind}-----${newline}PRIVATEKEYMATERIAL${newline}`;
      expect(redactSensitive(`${block}-----END ${kind}-----\nCall Alice`)).toBe("[REDACTED]\nCall Alice");
      expect(redactSensitive(block)).toBe("[REDACTED]");
    }
  },
);

test.each([
  "4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111",
  "378282246310005", "4222222222222", "4000000000000000006",
  "123-45-6789", "2345 6789 0123", "ABCDE1234F".replace("D", "P"),
  "GB82WEST12345698765432", "GB82 WEST 1234 5698 7654 32",
])("removes sensitive financial and government IDs: %s", (id) => {
  expect(redactSensitive(`Use ${id} tomorrow.`)).toBe("Use [REDACTED] tomorrow.");
});

test.each([
  "SSN: 123456789", "Aadhaar: 234567890123", "passport: X1234567",
  '"bank_account": "123456789012"', "routing_number=021000021",
])("removes labeled sensitive IDs: %s", (input) => {
  expect(redactSensitive(input)).toContain("[REDACTED]");
  expect(redactSensitive(input)).not.toMatch(/\d/);
});

test("keeps ordinary memory context and is repeatable", () => {
  const ordinary = "Alice Smith <alice@example.com> will call +91 9876543210 on 2026-11-03 at 17:30. Order 1234567890123. IP 192.168.1.1. Review API key rotation tomorrow.";
  expect(redactSensitive(ordinary)).toBe(ordinary);
  const input = 'password="two words"; token=opaque\n4111 1111 1111 1111\nSSN: 123456789';
  const safe = redactSensitive(input);
  expect(redactSensitive(safe)).toBe(safe);
  expect(redactSensitive(input)).toBe(safe);
  expect(redactSensitive("")).toBe("");
});
