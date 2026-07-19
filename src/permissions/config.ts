// Default permissions — re-exported for backward compatibility.
// New code should import from security/policy/ directly.

export { HARD_BLACKLIST, DEFAULT_ALLOW_RULES } from "../security/policy/rules.js";
export type { PermissionRule } from "../security/policy/rules.js";

import type { AgentConfig } from "../shared/core-types.js";

/** Default permission configuration — all tools auto (sandbox is the real defense). */
export const DEFAULT_PERMISSIONS: AgentConfig["permissions"] = {
  bash: "auto",
  read: "auto",
  write: "auto",
  edit: "auto",
  web: "auto",
  rules: [],
};
