import { stripAnsi } from "../../shared/text.js";

const SECRET_KEY =
  /(api[-_]?key|authorization|set[-_]?cookie|cookie|pass(?:word|wd)|private[-_]?key|client[-_]?secret|secret|(?:access|refresh|auth|id)[-_]?token|credential)/i;
const PRIVATE_REASONING_KEY = /(thinking|reasoning|chain[-_]?of[-_]?thought)/i;

export function redactText(value: string): string {
  const secretName =
    "(?:api[-_]?key|authorization|set[-_]?cookie|cookie|pass(?:word|wd)|" +
    "private[-_]?key|client[-_]?secret|secret|(?:access|refresh|auth|id)[-_]?token|credential)";
  const quotedAssignment = new RegExp(
    `((?:["']?${secretName}["']?)\\s*[:=]\\s*)(["'])([^"'\\r\\n]*)\\2`,
    "gi",
  );
  const bareAssignment = new RegExp(
    `((?:["']?${secretName}["']?)\\s*[:=]\\s*)(?!\\[REDACTED(?:[^\\]]*)\\])([^"'\\s,;\\]}]+)`,
    "gi",
  );

  return stripAnsi(value)
    // PEM blocks are multiline and otherwise contain no recognizable key name.
    .replace(
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b(Authorization\s*:\s*)(?:Bearer|Basic|Token)?\s*[^\r\n,;]+/gi, "$1[REDACTED]")
    .replace(/\b((?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
    .replace(quotedAssignment, (_match, prefix: string, quote: string) =>
      `${prefix}${quote}[REDACTED]${quote}`)
    .replace(bareAssignment, "$1[REDACTED]")
    // Credentials embedded in connection URLs.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, "$1[REDACTED]$2")
    // Provider-specific token formats. Keep these explicit to avoid depending
    // on surrounding field names in arbitrary model/tool output.
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g, "[REDACTED]")
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,255}\b/g, "[REDACTED]")
    .replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}

export function redactValue(value: unknown, key = ""): unknown {
  if (PRIVATE_REASONING_KEY.test(key)) return undefined;
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const redacted = redactValue(childValue, childKey);
      if (redacted !== undefined) output[childKey] = redacted;
    }
    return output;
  }
  return value;
}

export function isPrivateReasoningKey(key: string): boolean {
  return PRIVATE_REASONING_KEY.test(key);
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}
