// Security decision types — shapes the output of policy + sandbox evaluation
// Re-exports and extends sandbox types for use across the security layer.

export type { SecurityVerdict, RiskLevel, SecurityConstraints, SecurityBlock, SecurityDecision, SandboxResult, ISandbox } from "../sandbox/sandbox.js";
export { DEFAULT_CONSTRAINTS } from "../sandbox/sandbox.js";
