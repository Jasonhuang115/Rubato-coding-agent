import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import YAML from "yaml";
import { getRubatoHome } from "../shared/rubato-home.js";

export interface MemoryPolicy {
  schema: "rubato.memory.policy/v1";
  learning_enabled: boolean;
  auto_publish_explicit_low_risk: boolean;
  profile_max_tokens: number;
  dream: {
    closed_sessions: number;
    pending_candidates: number;
    observation_age_hours: number;
    max_retries: number;
    lease_minutes: number;
  };
  utility: {
    alpha: number;
    minimum_uses: number;
  };
  prohibited_sensitive_categories: string[];
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  schema: "rubato.memory.policy/v1",
  learning_enabled: true,
  auto_publish_explicit_low_risk: true,
  profile_max_tokens: 1_000,
  dream: {
    closed_sessions: 5,
    pending_candidates: 20,
    observation_age_hours: 24,
    max_retries: 3,
    lease_minutes: 15,
  },
  utility: {
    alpha: 0.2,
    minimum_uses: 5,
  },
  prohibited_sensitive_categories: [
    "authentication_secret",
    "identity_document",
    "health",
    "politics",
    "religion",
    "finance",
    "sexuality",
    "relationship",
  ],
};

/**
 * Recognizers for the categories POLICY.yml can prohibit. A category without a
 * recognizer here cannot be enforced by pattern matching, so callers are told
 * about it rather than being left to assume it was checked.
 */
const SENSITIVE_CATEGORY_PATTERNS: Readonly<Record<string, RegExp>> = {
  authentication_secret:
    /(?:密码|口令|密钥|令牌|凭据|api\s*key|access\s*token|password|passphrase|secret\s*key|credential)/i,
  identity_document:
    /(?:身份证|护照|driver'?s\s+licen[cs]e|social\s+security|passport\s+number)/i,
  health:
    /(?:病史|病历|诊断|确诊|用药|药物|抑郁|焦虑症|残疾|diagnosis|prescription|medication|disability|mental\s+illness)/i,
  politics:
    /(?:政治立场|政治倾向|党派|投票给|political\s+affiliation|political\s+party|voted\s+for)/i,
  religion:
    /(?:宗教信仰|信教|信仰宗教|教徒|religious\s+belief|religion\s+is|practicing\s+(?:christian|muslim|jew|buddhist|hindu))/i,
  finance:
    /(?:银行卡|信用卡|工资|薪资|收入|负债|贷款|存款|信用分|credit\s+card|bank\s+account|salary|annual\s+income|net\s+worth|debt)/i,
  sexuality:
    /(?:性取向|性倾向|同性恋|双性恋|跨性别|sexual\s+orientation|gay|lesbian|bisexual|transgender)/i,
  relationship:
    /(?:恋爱关系|男朋友|女朋友|配偶|离婚|婚姻状况|girlfriend|boyfriend|spouse|marital\s+status|divorce)/i,
};

export interface ProhibitedSensitiveMatch {
  /** Configured categories whose recognizer matched the text. */
  matched: string[];
  /** Configured categories that have no recognizer and were not checked. */
  unenforceable: string[];
}

/**
 * Applies POLICY.yml's prohibited categories to candidate user text. This is the
 * durable, user-editable half of sensitivity screening; findMemorySafetyIssues
 * remains the unconditional secret/injection scanner.
 */
export function findProhibitedSensitiveCategories(
  text: string,
  categories: ReadonlyArray<string> =
    loadMemoryPolicy().prohibited_sensitive_categories,
): ProhibitedSensitiveMatch {
  const matched: string[] = [];
  const unenforceable: string[] = [];
  for (const category of categories) {
    const pattern = SENSITIVE_CATEGORY_PATTERNS[category];
    if (!pattern) {
      unenforceable.push(category);
      continue;
    }
    if (pattern.test(text)) matched.push(category);
  }
  return { matched, unenforceable };
}

export function getMemoryPolicyPath(rootDir?: string): string {
  return path.join(
    rootDir ? path.resolve(rootDir) : getRubatoHome(),
    "memory",
    "global",
    "POLICY.yml",
  );
}

export function loadMemoryPolicy(rootDir?: string): MemoryPolicy {
  const filePath = getMemoryPolicyPath(rootDir);
  if (!fs.existsSync(filePath)) {
    return structuredClone(DEFAULT_MEMORY_POLICY);
  }
  try {
    const raw = YAML.parse(fs.readFileSync(filePath, "utf8")) as
      Partial<MemoryPolicy> | null;
    return normalizePolicy(raw ?? {});
  } catch {
    return structuredClone(DEFAULT_MEMORY_POLICY);
  }
}

export function saveMemoryPolicy(policy: MemoryPolicy, rootDir?: string): void {
  const normalized = normalizePolicy(policy);
  const filePath = getMemoryPolicyPath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp.${randomUUID()}`;
  fs.writeFileSync(temporary, YAML.stringify(normalized), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

export function setMemoryLearningEnabled(
  enabled: boolean,
  rootDir?: string,
): MemoryPolicy {
  const policy = loadMemoryPolicy(rootDir);
  policy.learning_enabled = enabled;
  saveMemoryPolicy(policy, rootDir);
  return policy;
}

/**
 * Defense-in-depth scanner for candidates and compiled artifacts. It is
 * intentionally conservative; a hit means "needs review", never auto-publish.
 */
export function findMemorySafetyIssues(text: string): string[] {
  const issues: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
    ["generic API token", /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i],
    ["GitHub token", /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["bearer credential", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
    ["prompt injection", /\b(?:ignore|disregard|override)\b.{0,40}\b(?:previous|system|developer)\b.{0,30}\b(?:instruction|prompt)s?\b/is],
    ["prompt injection (Chinese)", /(?:忽略|无视|绕过|覆盖|替换).{0,24}(?:之前|以上|系统|开发者).{0,20}(?:指令|提示词|规则)/is],
    ["tool execution instruction", /\b(?:run|execute)\s+(?:this\s+)?(?:shell|bash|command|script)\b/i],
    ["tool execution instruction (Chinese)", /(?:运行|执行).{0,12}(?:这段|以下|任意)?\s*(?:shell|bash|命令|脚本)/is],
  ];
  for (const [label, pattern] of checks) {
    if (pattern.test(text)) issues.push(label);
  }
  return issues;
}

function normalizePolicy(raw: Partial<MemoryPolicy>): MemoryPolicy {
  const dream = (raw.dream ?? {}) as Partial<MemoryPolicy["dream"]>;
  const utility = (raw.utility ?? {}) as Partial<MemoryPolicy["utility"]>;
  return {
    schema: "rubato.memory.policy/v1",
    learning_enabled: raw.learning_enabled ?? true,
    auto_publish_explicit_low_risk:
      raw.auto_publish_explicit_low_risk ?? true,
    profile_max_tokens: boundedInteger(
      raw.profile_max_tokens,
      DEFAULT_MEMORY_POLICY.profile_max_tokens,
      100,
      4_000,
    ),
    dream: {
      closed_sessions: boundedInteger(
        dream.closed_sessions,
        DEFAULT_MEMORY_POLICY.dream.closed_sessions,
        1,
        1_000,
      ),
      pending_candidates: boundedInteger(
        dream.pending_candidates,
        DEFAULT_MEMORY_POLICY.dream.pending_candidates,
        1,
        10_000,
      ),
      observation_age_hours: boundedInteger(
        dream.observation_age_hours,
        DEFAULT_MEMORY_POLICY.dream.observation_age_hours,
        1,
        24 * 365,
      ),
      max_retries: boundedInteger(
        dream.max_retries,
        DEFAULT_MEMORY_POLICY.dream.max_retries,
        0,
        20,
      ),
      lease_minutes: boundedInteger(
        dream.lease_minutes,
        DEFAULT_MEMORY_POLICY.dream.lease_minutes,
        1,
        24 * 60,
      ),
    },
    utility: {
      alpha: boundedNumber(
        utility.alpha,
        DEFAULT_MEMORY_POLICY.utility.alpha,
        0.01,
        1,
      ),
      minimum_uses: boundedInteger(
        utility.minimum_uses,
        DEFAULT_MEMORY_POLICY.utility.minimum_uses,
        1,
        1_000,
      ),
    },
    prohibited_sensitive_categories:
      Array.isArray(raw.prohibited_sensitive_categories)
        ? [...new Set(raw.prohibited_sensitive_categories
            .map((value) => String(value).trim())
            .filter(Boolean))]
        : [...DEFAULT_MEMORY_POLICY.prohibited_sensitive_categories],
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value as number)));
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value as number));
}
