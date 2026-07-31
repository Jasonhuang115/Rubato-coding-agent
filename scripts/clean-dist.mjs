import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDir = path.join(projectRoot, "dist");

// Keep cleanup fixed to this package's build directory. This prevents deleted
// source modules from surviving as stale JavaScript in published artifacts.
if (path.dirname(distDir) !== projectRoot || path.basename(distDir) !== "dist") {
  throw new Error("Refusing to clean an unexpected build directory");
}

fs.rmSync(distDir, { recursive: true, force: true });
