// CompositeSandbox — chains multiple ISandbox implementations together
// Each sandbox validates in order; first rejection stops the chain.

import type { ISandbox, SandboxResult, SandboxScope } from "./sandbox.js";

export class CompositeSandbox implements ISandbox {
  readonly name = "composite-sandbox";
  private readonly sandboxes: ISandbox[];

  constructor(sandboxes: ISandbox[]) {
    this.sandboxes = sandboxes;
  }

  validate(
    toolName: string,
    input: Record<string, unknown>,
    workingDir: string,
    scope?: SandboxScope,
  ): SandboxResult {
    let currentInput = input;

    for (const sandbox of this.sandboxes) {
      const result = sandbox.validate(toolName, currentInput, workingDir, scope);
      if (!result.allowed) return result; // Stop on first rejection

      // Pass sanitized input to next sandbox
      if (result.sanitizedInput) {
        currentInput = result.sanitizedInput;
      }
    }

    return { allowed: true, sanitizedInput: currentInput };
  }
}
