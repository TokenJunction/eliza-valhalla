import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_FILES = [
  "index.html",
  "404.html",
  "home.css",
  "home.js",
  "home-motion.js",
  "site-config.js",
  "site-chrome.js",
  "consent.js",
  "status.js",
  "merch-promo.js",
  "errors.js",
  "ticker.js",
  "nacl.min.js",
  "connect-core.js",
  "site-wallet.js",
  "styles.css",
  "trust.js",
  "faq.json",
  "changelog.json",
  "monetization.json",
  "disclaimer.html",
  "valhalla-command.css"
];

const ROOT_DIRS = [
  "app",
  "os",
  "assets",
  "faq",
  "contact",
  "pay",
  "shop",
  "terms",
  "privacy",
  "cookies",
  "disclosure"
];

const DENY_TOP = new Set([
  ".git",
  ".github",
  ".wrangler",
  ".vscode",
  "admin",
  "api",
  "chrome",
  "dashboard",
  "demo",
  "docs",
  "extension",
  "health",
  "lib",
  "node_modules",
  "preview",
  "scripts",
  "source",
  "supabase",
  "valhalla-elizaos",
  "workers"
]);

const DENY_FILE = new Set([
  "package.json",
  "package-lock.json",
  "render.yaml",
  "vercel.json",
  "CNAME",
  "valhallaMasterEngineV35.js",
  "valhallaQueueEngine.js",
  "valhallaQueueEngine.test.cjs"
]);

function posix(value) {
  return value.split(path.sep).join("/");
}

export function isDenied(rel) {
  const norm = posix(rel).replace(/^\.\//, "");
  if (!norm || norm.startsWith("../") || norm.includes("/../") || norm === "..") return true;
  if (norm.split("/").some((part) => part.startsWith("."))) return true;
  if (DENY_TOP.has(norm.split("/")[0])) return true;
  if (DENY_FILE.has(norm)) return true;
  if (/\.test\.(mjs|cjs|js)$/.test(norm)) return true;
  if (norm.endsWith(".py")) return true;
  if (norm.endsWith(".env") || norm.includes(".env.")) return true;
  return false;
}

function addFile(root, outDir, files, rel) {
  if (isDenied(rel) || files.has(rel)) return;
  const source = path.join(root, rel);
  if (!statSync(source).isFile()) return;
  files.add(rel);
  const target = path.join(outDir, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function addDir(root, outDir, files, rel) {
  if (isDenied(rel)) return;
  const source = path.join(root, rel);
  for (const name of readdirSync(source)) {
    const child = rel ? rel + "/" + name : name;
    if (isDenied(child)) continue;
    const full = path.join(source, name);
    if (statSync(full).isDirectory()) addDir(root, outDir, files, child);
    else addFile(root, outDir, files, child);
  }
}

export function stagePublicSite(options) {
  const root = options.root;
  const outDir = options.outDir;
  const manifestPath = options.manifestPath;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const files = new Set();
  for (const rel of ROOT_FILES) addFile(root, outDir, files, rel);
  for (const rel of ROOT_DIRS) addDir(root, outDir, files, rel);
  const listed = [...files].sort();
  const manifest = { output: "dist/public", files: listed };
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

function walk(dir, base) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = posix(path.relative(base, full));
    if (statSync(full).isDirectory()) found.push(...walk(full, base));
    else found.push(rel);
  }
  return found;
}

export function stagedFiles(outDir) {
  return walk(outDir, outDir).sort();
}

function runCli() {
  const root = process.cwd();
  const outDir = path.join(root, "dist", "public");
  const manifestPath = path.join(root, "dist", "manifest.json");
  const manifest = stagePublicSite({ root, outDir, manifestPath });
  const onDisk = stagedFiles(outDir);
  if (onDisk.join("\n") !== manifest.files.join("\n")) {
    throw new Error("Staged files do not match the manifest.");
  }
  process.stdout.write("Staged " + manifest.files.length + " public files in dist/public\n");
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) runCli();
