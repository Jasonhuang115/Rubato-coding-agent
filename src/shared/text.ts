/**
 * Remove terminal control sequences before model context or persisted
 * artifacts consume command output. This prevents copied fragments such as
 * `1m[` from leaking into reports when an ANSI sequence is split or rendered
 * by a different terminal.
 */
export function stripAnsi(value: string): string {
  return value.replace(
    // CSI/OSC and common two-byte escape sequences.
    /(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\))|(?:\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_]))/g,
    "",
  );
}
