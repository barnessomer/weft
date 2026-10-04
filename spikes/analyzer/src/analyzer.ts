import { createRequire } from "node:module";
import type * as TS from "typescript";

const require = createRequire(import.meta.url);
// The spike deliberately uses the official TypeScript compiler API. B3 should declare this
// dependency normally in the workspace package rather than relying on NODE_PATH.
const ts = require("typescript") as typeof import("typescript");

export type WriteKind = "signature" | "body" | "new" | "deleted";
export type Write = { key: string; kind: WriteKind };
export type Analysis = { reads: string[]; writes: Write[] };

type DeclarationInfo = {
  key: string;
  signature: string;
  body: string;
};

const declarationKinds = new Set<TS.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
]);

function sourcePath(fileName: string, requestedPath: string): string {
  return fileName === "/entry.ts" ? requestedPath : fileName.replace(/^\//, "");
}

function nameOf(node: TS.Node): string | undefined {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  const named = node as TS.NamedDeclaration;
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  return undefined;
}

function declarationKey(node: TS.Node, source: TS.SourceFile, requestedPath: string): string | undefined {
  const names: string[] = [];
  let current: TS.Node | undefined = node;
  while (current) {
    if (declarationKinds.has(current.kind)) {
      const name = nameOf(current);
      if (name) names.unshift(name);
    }
    current = current.parent;
  }
  return names.length ? `${sourcePath(source.fileName, requestedPath)}#${names.join(".")}` : undefined;
}

function declarations(source: TS.SourceFile, path: string): Map<string, DeclarationInfo> {
  const result = new Map<string, DeclarationInfo>();
  const visit = (node: TS.Node) => {
    if (declarationKinds.has(node.kind)) {
      const key = declarationKey(node, source, path);
      if (key) {
        const whole = node.getText(source);
        // Functions/methods expose `body`; classes/enums use member lists instead. Treat the
        // braced class/enum region as body so an implementation edit does not invalidate its API.
        const functionLike = node as TS.FunctionLikeDeclarationBase;
        let body = functionLike.body ? functionLike.body.getText(source) : "";
        if (!body && (ts.isClassDeclaration(node) || ts.isEnumDeclaration(node))) {
          const open = whole.indexOf("{");
          const close = whole.lastIndexOf("}");
          if (open >= 0 && close >= open) body = whole.slice(open, close + 1);
        }
        // Full declaration minus body detects modifiers, name, parameters, return type and type members.
        result.set(key, { key, signature: body ? whole.replace(body, "") : whole, body });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function buildProgram(text: string): { program: TS.Program; source: TS.SourceFile; checker: TS.TypeChecker } {
  const fileName = "/entry.ts";
  const options: TS.CompilerOptions = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, noLib: true };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (requested, languageVersion) => requested === fileName
    ? ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS)
    : undefined;
  host.fileExists = (requested) => requested === fileName;
  host.readFile = (requested) => requested === fileName ? text : undefined;
  const program = ts.createProgram([fileName], options, host);
  const source = program.getSourceFile(fileName)!;
  return { program, source, checker: program.getTypeChecker() };
}

function keyForSymbol(symbol: TS.Symbol, requestedPath: string): string | undefined {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return undefined;
  const source = declaration.getSourceFile();
  const key = declarationKey(declaration, source, requestedPath);
  if (key) return key;
  // Imported module symbols do not always expose a named declaration in noLib mode.
  const name = symbol.getName();
  return name && name !== "__export" ? `${sourcePath(source.fileName, requestedPath)}#${name}` : undefined;
}

function reads(source: TS.SourceFile, checker: TS.TypeChecker, path: string): string[] {
  const found = new Set<string>();
  const visit = (node: TS.Node) => {
    let candidate: TS.Node | undefined;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) candidate = node.expression;
    else if (ts.isTypeReferenceNode(node)) candidate = node.typeName;
    else if (ts.isImportSpecifier(node)) candidate = node.name;
    else if (ts.isNamespaceImport(node)) candidate = node.name;
    if (candidate) {
      let symbol = checker.getSymbolAtLocation(candidate);
      if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      if (symbol) {
        const key = keyForSymbol(symbol, path);
        if (key) found.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

/** Analyze a single-file TypeScript edit. Keys deliberately retain the caller's repository path. */
export function analyze(before: string, after: string, path: string): Analysis {
  const beforeSource = ts.createSourceFile("/entry.ts", before, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  const afterBuild = buildProgram(after);
  const oldDeclarations = declarations(beforeSource, path);
  const newDeclarations = declarations(afterBuild.source, path);
  const writes: Write[] = [];
  for (const [key, afterDeclaration] of newDeclarations) {
    const beforeDeclaration = oldDeclarations.get(key);
    if (!beforeDeclaration) writes.push({ key, kind: "new" });
    else if (beforeDeclaration.signature !== afterDeclaration.signature) writes.push({ key, kind: "signature" });
    else if (beforeDeclaration.body !== afterDeclaration.body) writes.push({ key, kind: "body" });
  }
  for (const key of oldDeclarations.keys()) if (!newDeclarations.has(key)) writes.push({ key, kind: "deleted" });
  return { reads: reads(afterBuild.source, afterBuild.checker, path), writes: writes.sort((a, b) => a.key.localeCompare(b.key)) };
}
