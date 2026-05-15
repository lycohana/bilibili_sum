#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const staticRoot = path.join(repoRoot, "apps", "web", "static");
const indexPath = path.join(staticRoot, "index.html");

if (!fs.existsSync(indexPath)) {
  console.error(`Static index.html was not found: ${indexPath}`);
  process.exit(1);
}

const references = new Set();
const visited = new Set();
const attributePattern = /\b(?:src|href)=["'](\/static\/[^"']+)["']/g;
const cssUrlPattern = /url\(\s*["']?(\/static\/[^"')]+)["']?\s*\)/g;

function staticReferenceToPath(reference) {
  const relativePath = reference.replace(/^\/static\//, "").split(/[?#]/, 1)[0];
  return path.join(staticRoot, relativePath);
}

function collectReference(reference) {
  references.add(reference);
}

function collectIndexReferences() {
  const html = fs.readFileSync(indexPath, "utf8");
  let match;
  while ((match = attributePattern.exec(html)) !== null) {
    collectReference(match[1]);
  }
}

function collectCssReferences(cssPath) {
  const resolvedPath = path.resolve(cssPath);
  if (visited.has(resolvedPath)) {
    return;
  }
  visited.add(resolvedPath);

  const css = fs.readFileSync(resolvedPath, "utf8");
  let match;
  while ((match = cssUrlPattern.exec(css)) !== null) {
    collectReference(match[1]);
  }
}

collectIndexReferences();

const missing = [];
for (const reference of Array.from(references)) {
  const targetPath = staticReferenceToPath(reference);
  if (!fs.existsSync(targetPath)) {
    missing.push(reference);
    continue;
  }
  if (targetPath.endsWith(".css")) {
    collectCssReferences(targetPath);
  }
}

for (const reference of references) {
  const targetPath = staticReferenceToPath(reference);
  if (!fs.existsSync(targetPath) && !missing.includes(reference)) {
    missing.push(reference);
  }
}

if (missing.length > 0) {
  console.error("Static index.html references missing files:");
  for (const reference of missing) {
    console.error(`  - ${reference}`);
  }
  console.error("Run the renderer build and commit the generated apps/web/static assets.");
  process.exit(1);
}

console.log(`Validated ${references.size} static index asset reference(s).`);
