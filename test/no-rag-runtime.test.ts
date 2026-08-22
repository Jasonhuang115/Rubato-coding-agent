import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SRC_ROOT = path.join(PROJECT_ROOT, "src");
const RUNTIME_ROOTS = [
  path.join(SRC_ROOT, "cli", "entry.ts"),
  path.join(SRC_ROOT, "runtime", "context-assembler.ts"),
  path.join(SRC_ROOT, "agent", "loop.ts"),
];

interface RuntimeGraph {
  files: Set<string>;
  externalSpecifiers: Set<string>;
  unresolvedRelativeSpecifiers: string[];
}

describe("normal runtime has only agent-managed file memory", () => {
  it("keeps legacy RAG and verified-memory machinery out", () => {
    const graph = buildRuntimeGraph(RUNTIME_ROOTS);
    const relativeFiles = [...graph.files]
      .map((filePath) => path.relative(PROJECT_ROOT, filePath))
      .sort();

    expect(graph.unresolvedRelativeSpecifiers).toEqual([]);
    expect(relativeFiles).toContain("src/memory/store.ts");
    expect(relativeFiles.some((filePath) =>
      filePath.startsWith("src/memory-files/"))).toBe(false);
    expect(relativeFiles).not.toContain("src/context/memory-md.ts");
    expect(relativeFiles).not.toContain("src/context/mnemosyne-source.ts");
    expect(relativeFiles).not.toContain("src/context/file-memory.ts");
    expect(graph.externalSpecifiers.has("better-sqlite3")).toBe(false);
  });

  it("keeps better-sqlite3 out of the runtime and package", () => {
    const sqliteImports = allTypeScriptFiles(SRC_ROOT)
      .filter((filePath) =>
        /(?:from|import|require)\s*\(?\s*["']better-sqlite3["']/
          .test(fs.readFileSync(filePath, "utf8")))
      .map((filePath) => path.relative(PROJECT_ROOT, filePath))
      .sort();
    expect(sqliteImports).toEqual([]);

    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.["better-sqlite3"]).toBeUndefined();
    expect(packageJson.optionalDependencies?.["better-sqlite3"]).toBeUndefined();
    expect(packageJson.devDependencies?.["better-sqlite3"]).toBeUndefined();
    expect(allTypeScriptFiles(SRC_ROOT).some((filePath) =>
      filePath.includes(`${path.sep}memory-files${path.sep}`)))
      .toBe(false);
  });
});

function buildRuntimeGraph(roots: string[]): RuntimeGraph {
  const files = new Set<string>();
  const externalSpecifiers = new Set<string>();
  const unresolvedRelativeSpecifiers: string[] = [];
  const pending = [...roots.map((filePath) => path.resolve(filePath))];

  while (pending.length > 0) {
    const filePath = pending.pop()!;
    if (files.has(filePath)) continue;
    files.add(filePath);

    const source = fs.readFileSync(filePath, "utf8");
    const parsed = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    for (const specifier of runtimeModuleSpecifiers(parsed)) {
      if (!specifier.startsWith(".")) {
        externalSpecifiers.add(specifier);
        continue;
      }
      const resolved = resolveSourceImport(filePath, specifier);
      if (!resolved) {
        unresolvedRelativeSpecifiers.push(
          `${path.relative(PROJECT_ROOT, filePath)} -> ${specifier}`,
        );
        continue;
      }
      pending.push(resolved);
    }
  }

  return {
    files,
    externalSpecifiers,
    unresolvedRelativeSpecifiers:
      unresolvedRelativeSpecifiers.sort(),
  };
}

function runtimeModuleSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function resolveSourceImport(
  importer: string,
  specifier: string,
): string | null {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const candidates = specifier.endsWith(".js")
    ? [`${unresolved.slice(0, -3)}.ts`]
    : specifier.endsWith(".ts")
      ? [unresolved]
      : [`${unresolved}.ts`, path.join(unresolved, "index.ts")];
  for (const candidate of candidates) {
    if (
      candidate.startsWith(`${SRC_ROOT}${path.sep}`) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    ) {
      return candidate;
    }
  }
  return null;
}

function allTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(entryPath);
      }
    }
  };
  visit(root);
  return files;
}
