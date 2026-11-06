import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isDenied, stagePublicSite, stagedFiles } from "./vercel-build.mjs";

const root = path.resolve(import.meta.dirname, "..");

function publicFile(dir, pathname) {
  let rel = decodeURIComponent(pathname.split("?")[0]);
  if (rel.includes("\0")) return "";
  rel = path.posix.normalize(rel);
  if (rel.startsWith("/")) rel = rel.slice(1);
  if (rel === "." || rel === "") rel = "index.html";
  if (rel.startsWith("..") || rel.includes("/../")) return "";
  const exact = path.resolve(dir, rel);
  if (exact !== dir && !exact.startsWith(dir + path.sep)) return "";
  try {
    if (statSync(exact).isFile()) return exact;
  } catch { /* missing file */ }
  if (rel.endsWith("/")) rel = rel.slice(0, -1);
  const index = path.resolve(dir, rel, "index.html");
  if (index !== dir && !index.startsWith(dir + path.sep)) return "";
  try {
    if (statSync(index).isFile()) return index;
  } catch { /* no directory index */ }
  return "";
}

function serve(dir) {
  const server = createServer((req, res) => {
    const file = publicFile(dir, new URL(req.url, "http://127.0.0.1").pathname);
    if (!file) {
      const missing = path.join(dir, "404.html");
      try {
        const body = readFileSync(missing);
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("missing");
      }
      return;
    }
    res.writeHead(200);
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("public preview keeps the site pages and leaves backend out", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "valhalla-preview-"));
  const outDir = path.join(work, "dist", "public");
  const manifestPath = path.join(work, "dist", "manifest.json");
  const manifest = stagePublicSite({ root, outDir, manifestPath });
  const saved = JSON.parse(readFileSync(manifestPath, "utf8"));
  const onDisk = stagedFiles(outDir);
  assert.deepEqual(saved.files, manifest.files);
  assert.deepEqual(onDisk, manifest.files);
  assert.equal(saved.output, "dist/public");

  for (const rel of [
    "index.html",
    "home.js",
    "home.css",
    "home-motion.js",
    "app/index.html",
    "app/gate.js",
    "os/index.html",
    "os/os.css",
    "faq/index.html",
    "contact/index.html",
    "pay/index.html",
    "shop/index.html",
    "terms/index.html",
    "privacy/index.html",
    "cookies/index.html",
    "disclaimer.html",
    "404.html",
    "assets/hero-ascent.mp4",
    "assets/hero-ascent-poster.jpg",
    "assets/mark.svg",
    "valhalla-command.css"
  ]) {
    assert.equal(manifest.files.includes(rel), true, rel);
  }

  for (const rel of [
    "workers/auth.js",
    "workers/auth-logic.js",
    "package.json",
    "package-lock.json",
    "render.yaml",
    "vercel.json",
    "valhallaMasterEngineV35.js",
    "valhallaQueueEngine.js",
    "CNAME"
  ]) {
    assert.equal(manifest.files.includes(rel), false, rel);
    assert.equal(isDenied(rel), true, rel);
  }
  for (const prefix of ["admin/", "api/", "dashboard/", "docs/", "source/", "lib/", "supabase/", "valhalla-elizaos/", "scripts/", "extension/", "workers/"]) {
    assert.equal(manifest.files.some((file) => file.startsWith(prefix)), false, prefix);
  }
  assert.equal(manifest.files.some((file) => file.endsWith(".py")), false);
  assert.equal(manifest.files.includes("dist/manifest.json"), false);

  const authSource = readFileSync(path.join(root, "workers", "auth.js"));
  assert.equal(authSource.length > 1000, true);
  for (const rel of manifest.files) {
    assert.equal(readFileSync(path.join(outDir, rel)).equals(authSource), false, rel);
  }

  const vercel = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8"));
  assert.equal(vercel.installCommand, "");
  assert.equal(vercel.buildCommand, "node scripts/vercel-build.mjs");
  assert.equal(vercel.outputDirectory, "dist/public");
  assert.equal(vercel.cleanUrls, false);
  assert.equal(vercel.rewrites, undefined);
  const configText = readFileSync(path.join(root, "vercel.json"), "utf8");
  assert.doesNotMatch(configText, /rewrite all index/i);
  assert.doesNotMatch(configText, /"destination"\s*:\s*"\/index\.html"/);
  assert.equal(manifest.files.some(function (file) { return file.indexOf(".env") >= 0; }), false);
  assert.equal(JSON.stringify(vercel.headers).includes("Access-Control-Allow-Origin"), false);
  assert.match(JSON.stringify(vercel.headers), /nosniff/);
  assert.match(JSON.stringify(vercel.headers), /frame-ancestors 'none'/);

  const server = await serve(outDir);
  try {
    const port = server.address().port;
    async function status(pathname) {
      const response = await fetch("http://127.0.0.1:" + port + pathname, { headers: { accept: "text/html" } });
      assert.equal(response.headers.get("www-authenticate"), null);
      const text = await response.text();
      return { status: response.status, text };
    }

    const home = await status("/");
    assert.equal(home.status, 200);
    assert.match(home.text, /href="\/app\/">Client access/);
    assert.doesNotMatch(home.text, /id="home-email"|href="#access"|id="access"/);
    assert.match(home.text, /rel="canonical" href="https:\/\/valhalla-app\.xyz\/"/);
    assert.doesNotMatch(home.text, /ADMIN/);

    const mark = await status("/assets/mark.svg");
    assert.equal(mark.status, 200);
    assert.match(mark.text, /<svg/);
    assert.equal((await status("/assets/")).status, 404);

    for (const pathname of ["/app/", "/os/", "/faq/", "/contact/", "/pay/", "/shop/", "/terms/", "/privacy/", "/cookies/", "/disclaimer.html"]) {
      const page = await status(pathname);
      assert.equal(page.status, 200, pathname);
    }

    const risk = await status("/disclaimer.html");
    assert.match(risk.text, /<h1>Disclaimer<\/h1>/);
    assert.match(risk.text, /not financial, legal, or tax advice/);
    assert.match(risk.text, /Crypto can lose money/);
    assert.match(risk.text, /irreversible/);
    assert.match(risk.text, /not risk-free/);
    assert.match(risk.text, /stylesheet" href="\/styles.css"/);
    const plain = await status("/disclaimer.md");
    assert.equal(plain.status, 404);
    assert.doesNotMatch(plain.text, /id="home-email"/);

    const desk = await status("/app/");
    assert.match(desk.text, /HUMAN CHECK/);
    assert.match(desk.text, /id="magicEmail"/);
    assert.doesNotMatch(desk.text, /mock session|authentication succeeded|signed in as/i);
    const gate = readFileSync(path.join(outDir, "app", "gate.js"), "utf8");
    assert.match(gate, /ux_mode:\s*"popup"/);
    assert.doesNotMatch(gate, /ux_mode:\s*"redirect"|pending iframe|oidc iframe/i);

    for (const pathname of ["/workers/auth.js", "/package.json", "/render.yaml", "/admin", "/admin/", "/adminsource", "/docs/", "/source/", "/api/health", "/auth/google", "/valhallaMasterEngineV35.js", "/.env"]) {
      const blocked = await status(pathname);
      assert.equal(blocked.status, 404, pathname);
      assert.notEqual(blocked.text, home.text, pathname);
      assert.doesNotMatch(blocked.text, /id="home-email"/);
      assert.doesNotMatch(blocked.text, /<title>[^<]*ADMIN/i);
      assert.match(blocked.text, /That page is not here/);
    }
  } finally {
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
});
