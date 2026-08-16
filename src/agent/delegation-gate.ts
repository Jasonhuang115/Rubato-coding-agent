/**
 * Runtime backstop for explicit parallel multi-scope requests.
 *
 * The system prompt remains responsible for good decomposition. This gate only
 * handles the narrow, high-confidence case where the user explicitly asks for
 * parallel work across all/multiple projects, repositories, directories,
 * modules, or subsystems. It prevents a model from silently doing the whole
 * request serially in the root context.
 */
export class RootDelegationGate {
  private required = false;
  private delegated = false;
  private readDelegationPlanned = false;

  constructor(initialUserMessage: string) {
    this.observeUserMessage(initialUserMessage);
  }

  observeUserMessage(message: string): void {
    this.required = requiresParallelDelegation(message);
    this.delegated = false;
    this.readDelegationPlanned = false;
  }

  prepareTurn(toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
  }>): void {
    this.readDelegationPlanned = this.required &&
      toolCalls.some((call) => call.name === "Subagent");
  }

  check(toolName: string, _input: Record<string, unknown> = {}): string | null {
    if (!this.required || this.delegated) return null;
    if (toolName === "Subagent") return null;
    if (toolName === "TodoWrite" || toolName === "Plan") {
      return null;
    }
    // Read calls can execute concurrently before the serial Agent call in the
    // same model turn. Mutations must wait until Agent actually succeeds.
    if (
      this.readDelegationPlanned &&
      (toolName === "Read" || toolName === "Glob" || toolName === "Grep")
    ) {
      return null;
    }
    return [
      "Runtime delegation gate blocked this tool call.",
      "The user explicitly requested parallel work across multiple scopes.",
      "First call Subagent with a concrete non-overlapping scope.",
      "Retain a different meaningful scope for the root Agent, then continue both in parallel.",
    ].join(" ");
  }

  recordToolResult(toolName: string, succeeded: boolean): void {
    if (toolName === "Subagent" && succeeded) this.delegated = true;
  }

  get isRequired(): boolean {
    return this.required;
  }
}

export function requiresParallelDelegation(message: string): boolean {
  const explicitParallel =
    /(?:并行|并发|parallel(?:ize|ism)?|concurrent(?:ly)?)/i.test(message);
  const multipleScopes =
    /(?:所有|全部|各个|每个|多个|多项|all|every|multiple)\s*(?:的\s*)?(?:项目|仓库|目录|模块|子系统|projects?|repositor(?:y|ies)|directories|modules?|subsystems?)/i
      .test(message);
  return explicitParallel && multipleScopes;
}
