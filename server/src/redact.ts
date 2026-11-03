const REDACTED = "[REDACTED]";

// Whole blocks, including escaped JSON newlines and unfinished captures, must go first.
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+[ -])*(?:PRIVATE KEY(?: BLOCK)?|SECRET KEY BLOCK)-----[\s\S]*?(?:-----END (?:[A-Z0-9]+[ -])*(?:PRIVATE KEY(?: BLOCK)?|SECRET KEY BLOCK)-----|$)/g;
const RECOVERY_SECRET = /\b(?:(?:seed|recovery|mnemonic)[ _-]*(?:phrase|words)|(?:backup|recovery)[ _-]*codes?|passphrase)\b["']?\s*(?::|=|\bis\b)\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n<>]+)/gi;
const AUTH_HEADER = /\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*[^\r\n<>]+/gi;
const AUTH_TOKEN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/<>"']+@[^\s<>"']+/gi;

const TOKEN_PATTERNS = [
  /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_|github_pat_|glpat-|glcbt-|gloas-|glsoat-|xox[bpaers]-|xapp-|npm_|pypi-|hf_|sb_secret_|dop_v1_|vcp_|phx_|GOCSPX-|ya29\.|AQ\.)[A-Za-z0-9_.-]{10,}/g,
  /\b(?:[sr]k_(?:live|test)_|whsec_)[A-Za-z0-9]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}/g,
  /\bsk_[a-f0-9]{48}\b/g,
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
  /\bSK[a-fA-F0-9]{32}\b/g,
  /\b\d{8,12}:[A-Za-z0-9_-]{35,}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\b(?:api[_-]key[_-]|token[_-]|secret[_-])[A-Za-z0-9_-]{20,}/gi,
];

// Includes JSON, .env, camelCase settings, URL query parameters and signed URLs.
const LABELED_SECRET = /(\b(?:[\w.-]{0,64}(?:password|passwd|pwd|passphrase|passcode|secret|token|credential|api[ _-]?key|access[ _-]?key|private[ _-]?key|connection[ _-]?string)[\w.-]{0,64}|pin|otp|cvv|cvc|security[ _-]?code|verification[ _-]?code|backup[ _-]?codes?|recovery[ _-]?codes?|account[ _-]?key|signature|sig|x-amz-signature|x-goog-signature)["']?\s*(?::|=|\bis\b)\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&<>"']+)/gi;
const LABELED_ID = /(\b(?:ssn|social[ _-]?security(?:[ _-]?(?:number|no))?|aadhaar|aadhar|pan|passport|tax[ _-]?id|bank[ _-]?account|account[ _-]?(?:number|no)|routing[ _-]?(?:number|no))["']?\s*(?:(?:number|no\.?)[ _-]*)?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z0-9][A-Za-z0-9 -]*)/gi;
const SSN = /(?<!\w)\d{3}-\d{2}-\d{4}(?!\w)/g;
const AADHAAR = /(?<!\w)[2-9]\d{3}[ -]\d{4}[ -]\d{4}(?!\w)/g;
const PAN = /\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const CARD = /(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g;

function redactCard(value: string): string {
  const digits = value.replace(/\D/g, "");
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum > 0 && sum % 10 === 0 ? REDACTED : value;
}

/** Best-effort text filtering at AI boundaries. Names and emails are deliberately retained. */
export function redactSensitive(text: string): string {
  let safe = text.replace(PRIVATE_KEY, REDACTED)
    .replace(RECOVERY_SECRET, REDACTED)
    .replace(AUTH_HEADER, REDACTED)
    .replace(AUTH_TOKEN, REDACTED)
    .replace(CREDENTIAL_URL, REDACTED);
  for (const pattern of TOKEN_PATTERNS) safe = safe.replace(pattern, REDACTED);
  return safe.replace(LABELED_SECRET, `$1${REDACTED}`)
    .replace(LABELED_ID, `$1${REDACTED}`)
    .replace(SSN, REDACTED)
    .replace(CARD, redactCard)
    .replace(AADHAAR, REDACTED)
    .replace(PAN, REDACTED)
    .replace(IBAN, REDACTED);
}
