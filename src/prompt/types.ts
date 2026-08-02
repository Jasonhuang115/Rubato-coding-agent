// Prompt architecture types — 4-layer prompt system
// Layers: Static → Capability → Dynamic → Ephemeral
// Each layer has different caching and lifecycle characteristics.

/** The assembled prompt with separated layers. */
export interface LayeredPrompt {
  /** Almost never changes — can be cached aggressively. */
  static: string;
  /** Depends on available tools — changes when tools are added/removed. */
  capability: string;
  /** Session-scoped — workspace, git, memory, plan status. */
  dynamic: string;
}
