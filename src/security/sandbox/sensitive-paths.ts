import path from "path";

export interface SensitivePathMatch {
  label: string;
  value: string;
}

interface SensitivePathRule {
  label: string;
  pattern: RegExp;
}

/**
 * One source of truth for paths that file tools and shell commands must not
 * access. Patterns use normalized forward-slash paths and segment boundaries
 * so names such as `development` do not accidentally match `/dev`.
 */
const SENSITIVE_PATH_RULES: SensitivePathRule[] = [
  {
    label: "system account files",
    pattern: /(?:^|\/)etc\/(?:passwd|shadow|hosts)(?:$|\/)/i,
  },
  {
    label: "kernel and device files",
    pattern: /(?:^|\/)(?:proc|sys|dev)(?:$|\/)/i,
  },
  {
    label: "SSH private or authorization data",
    pattern: /(?:^|\/)\.ssh\/(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|authorized_keys|known_hosts)(?:$|\/)/i,
  },
  {
    label: "Git credential-bearing config",
    pattern: /(?:^|\/)\.git\/config(?:$|\/)/i,
  },
  {
    label: "environment secret file",
    pattern: /(?:^|\/)\.env(?:\.[^/]+)?(?:$|\/)/i,
  },
  {
    label: "package registry credentials",
    pattern: /(?:^|\/)(?:\.npmrc|\.pypirc|\.netrc)(?:$|\/)/i,
  },
  {
    label: "cloud or container credentials",
    pattern: /(?:^|\/)(?:\.aws\/credentials|\.docker\/config\.json|\.config\/gcloud\/application_default_credentials\.json)(?:$|\/)/i,
  },
];

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/**
 * Match a concrete or relative filesystem path.
 */
export function matchSensitivePath(
  filePath: string,
  workingDir?: string,
): SensitivePathMatch | undefined {
  const candidates = new Set<string>();
  candidates.add(normalize(filePath));
  if (workingDir && !path.isAbsolute(filePath) && !filePath.startsWith("~")) {
    candidates.add(normalize(path.resolve(workingDir, filePath)));
  }

  for (const candidate of candidates) {
    for (const rule of SENSITIVE_PATH_RULES) {
      if (rule.pattern.test(candidate)) {
        return { label: rule.label, value: filePath };
      }
    }
  }
  return undefined;
}

/**
 * Shell quoting and escaping can split an otherwise obvious sensitive name
 * (`.e""nv`, `.e\ nv`). Inspect both the original command and a conservative
 * dequoted form. This is intentionally lexical: it rejects references before a
 * shell gets a chance to expand them.
 */
export function matchSensitiveShellReference(
  command: string,
): SensitivePathMatch | undefined {
  const compact = command
    .replace(/\\\r?\n/g, "")
    .replace(/\\(.)/gs, "$1")
    .replace(/["']/g, "");
  const candidates = [
    command,
    compact,
    ...compact.split(/[\s|;&()<>{}=,:]+/).filter(Boolean),
  ];

  for (const candidate of candidates) {
    const normalized = normalize(candidate);
    for (const rule of SENSITIVE_PATH_RULES) {
      if (rule.pattern.test(normalized)) {
        return { label: rule.label, value: "[shell command]" };
      }
    }
  }
  return undefined;
}
