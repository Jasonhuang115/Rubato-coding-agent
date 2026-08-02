import os from "os";
import path from "path";

/** Resolve Rubato's user data root, honoring the supported override. */
export function getRubatoHome(): string {
  return path.resolve(process.env.RUBATO_HOME ?? path.join(os.homedir(), ".rubato"));
}
