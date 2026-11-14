from html.parser import HTMLParser
from pathlib import Path
import functools
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site-build"


BUILD_SITE_STEP = "python3 website/scripts/build-site.py"


def build_command_steps(script):
    matches = [
        line.strip()
        for line in script.splitlines()
        if line.strip().startswith(BUILD_SITE_STEP)
    ]
    if not matches:
        raise ValueError(f"build script is missing the {BUILD_SITE_STEP!r} step")
    if len(matches) > 1:
        raise ValueError(f"build script has more than one {BUILD_SITE_STEP!r} step")
    steps = [step.strip() for step in matches[0].split("&&")]
    if any(not step for step in steps):
        raise ValueError(f"build script has an empty command step: {matches[0]!r}")
    return steps


def assert_minified_pages_keep_doctype(directory):
    """Fail if any minified HTML page does not begin with an HTML5 doctype."""
    pages = sorted(Path(directory).rglob("*.html"))
    if not pages:
        raise AssertionError("no HTML pages found after minification")
    for page in pages:
        relative = page.relative_to(directory)
        text = page.read_text(encoding="utf-8")
        if text.startswith("google-site-verification:"):
            continue
        content = text.lstrip("\ufeff")
        if not re.match(r"(?i)^<!doctype\s+html\s*>", content):
            raise AssertionError(f"{relative} lost its doctype after minification")


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "img", "video", "source"):
            self.paths.extend(attrs[key] for key in ("src", "poster") if key in attrs)
        if tag == "link" and attrs.get("rel") in ("stylesheet", "icon", "preload"):
            self.paths.append(attrs.get("href", ""))


class SiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(OUT))
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def get(self, path):
        return urllib.request.urlopen(self.base + path)

    def test_routes_and_assets(self):
        for route in ("/", "/app/", "/os/", "/volos/", "/terms/", "/api/"):
            with self.subTest(route=route), self.get(route) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("text/html", response.headers["Content-Type"])
        for route in ("/", "/app/", "/os/", "/volos/"):
            with self.get(route) as response:
                html = response.read().decode()
            parser = Assets()
            parser.feed(html)
            for asset in parser.paths:
                url = urllib.parse.urljoin(route, asset)
                if urllib.parse.urlsplit(url).netloc:
                    continue
                with self.subTest(route=route, asset=url), self.get(url) as response:
                    self.assertEqual(response.status, 200)
                    response.read()
        for asset in ("/assets/mark.svg", "/assets/mech.jpg", "/assets/poster.jpg",
                      "/media/hero.mp4", "/connect-core.js", "/site-wallet.js",
                      "/desk.js?v=1.4.2", "/desk.css?v=1.4.2"):
            with self.subTest(asset=asset), self.get(asset) as response:
                self.assertEqual(response.status, 200)
                response.read()
        with self.get("/app") as response:
            self.assertTrue(response.url.endswith("/app/"))
        config = json.loads((ROOT / "vercel.json").read_text())
        self.assertIn({"source": "/app", "destination": "/", "permanent": False}, config["redirects"])
        self.assertIn({"source": "/app/", "destination": "/", "permanent": False}, config["redirects"])
        self.assertNotIn("proxy", config)
        self.assertIn({"source": "/", "has": [{"type": "host", "value": "valos.live"}], "destination": "/volos/index.html"}, config["rewrites"])
        self.assertTrue(any(row.get("key") == "Cache-Control" and "max-age=2592000" in row.get("value", "") for group in config["headers"] for row in group["headers"]))
        command = config["buildCommand"]
        self.assertLessEqual(len(command), 256)
        self.assertEqual(command, "bash website/scripts/vercel-build.sh")
        script = (ROOT / "website/scripts/vercel-build.sh").read_text()
        steps = build_command_steps(script)
        self.assertGreaterEqual(len(steps), 6)
        self.assertEqual(steps[:4], [
            "python3 website/scripts/build-site.py",
            "python3 website/scripts/test-site.py",
            "python3 scripts/test_private_pack_export.py",
            "node website/scripts/test-wallet.cjs",
        ])
        self.assertTrue(steps[4].startswith("node --test "), steps[4])
        self.assertEqual(steps[5], "node website/scripts/minify-site.mjs")
        for step in steps[6:]:
            self.assertTrue(step.startswith("node --test "), step)
        self.assertFalse(any(item.get("destination") == "/volos/index.html" and "has" not in item for item in config.get("rewrites", [])))
        self.assertFalse((OUT / "index.html").exists())
        with self.get("/home/") as response:
            home = response.read().decode()
        self.assertIn("Continue with Google", home)
        self.assertIn("Email me a sign-in link", home)
        self.assertIn("/assets/heaven-poster.jpg", home)
        self.assertIn("Live trading is off", home)
        self.assertNotIn("github.com", home)
        self.assertNotIn("Public desk", home)
        self.assertNotIn("Trade Solana", home)
        with self.get("/volos/") as response:
            volos = response.read().decode()
        self.assertIn("AwRR84BRbzPKSvWnw4BBNYmFYmRdRTBkLxCiKzTvpump", volos)
        self.assertIn("Not financial advice. Holding the coin is not a promise of profit, yield, or a payout.", volos)
        self.assertIn("can fall to zero", volos)
        self.assertIn("https://valhalla-app.xyz/", volos)
        self.assertIn("https://pump.fun/coin/AwRR84BRbzPKSvWnw4BBNYmFYmRdRTBkLxCiKzTvpump", volos)
        self.assertNotIn("Not published", volos)
        self.assertNotIn("will pump", volos.lower())
        self.assertNotIn("github.com", volos.lower())
        self.assertNotRegex(volos, r"0x[0-9a-fA-F]{40}")

    def test_build_step_parser_returns_chained_steps(self):
        script = (
            "#!/usr/bin/env bash\n"
            "set -e\n"
            "python3 website/scripts/build-site.py && node a.js && python3 b.py\n"
        )
        self.assertEqual(
            build_command_steps(script),
            ["python3 website/scripts/build-site.py", "node a.js", "python3 b.py"],
        )

    def test_build_step_parser_rejects_malformed_scripts(self):
        with self.subTest("missing build step"):
            with self.assertRaisesRegex(
                ValueError, r"missing the 'python3 website/scripts/build-site\.py' step"
            ):
                build_command_steps("node website/scripts/minify-site.mjs\n")
        with self.subTest("empty command step"):
            with self.assertRaisesRegex(ValueError, "empty command step"):
                build_command_steps(
                    "python3 website/scripts/build-site.py && && node a.js\n"
                )
        with self.subTest("duplicate build step"):
            with self.assertRaisesRegex(
                ValueError, r"more than one 'python3 website/scripts/build-site\.py' step"
            ):
                build_command_steps(
                    "python3 website/scripts/build-site.py && node a.js\n"
                    "python3 website/scripts/build-site.py && node b.js\n"
                )

    def test_minified_pages_keep_doctype(self):
        with tempfile.TemporaryDirectory() as temp:
            build = Path(temp) / "site-build"
            shutil.copytree(OUT, build)
            subprocess.run(
                [
                    "node",
                    "--input-type=module",
                    "-e",
                    "import { minifySite } from './website/scripts/minify-site.mjs'; "
                    "await minifySite(process.env.MINIFY_DIR);",
                ],
                cwd=ROOT,
                env={**os.environ, "MINIFY_DIR": str(build)},
                check=True,
                capture_output=True,
                text=True,
            )
            assert_minified_pages_keep_doctype(build)

    def test_doctype_check_fails_when_a_minified_page_loses_it(self):
        with tempfile.TemporaryDirectory() as temp:
            build = Path(temp)
            (build / "index.html").write_text(
                "<!doctype html><html><body>ok</body></html>",
                encoding="utf-8",
            )
            assert_minified_pages_keep_doctype(build)

            (build / "broken.html").write_text(
                "<html><body>doctype stripped</body></html>",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                AssertionError,
                r"broken\.html lost its doctype after minification",
            ):
                assert_minified_pages_keep_doctype(build)

    def test_auth_is_not_rewritten_or_covered(self):
        self.assertEqual((OUT / "app/gate.js").read_bytes(), (ROOT / "website/app/gate.js").read_bytes())
        self.assertIn("window.turnstile.render", (OUT / "app/gate.js").read_text())
        self.assertNotIn("Valhalla read-only preview", (OUT / "errors.js").read_text())
        for name in (".env", "scripts", "src", "experimental", "experiments"):
            self.assertFalse((OUT / name).exists())
        motion = (OUT / "home-motion.js").read_text()
        self.assertIn('"/media/hero-web.mp4"', motion)
        self.assertIn('"/media/heaven-loop.mp4"', motion)

    def test_build_rejects_missing_entry_points_and_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            shutil.copytree(ROOT / "website", root / "website")
            (root / "website/.env").write_text("PRIVATE=fixture")
            build = root / "website/scripts/build-site.py"
            for name in ("index.html", "app/index.html", "app/gate.js",
                         "assets/mark.svg", "media/hero.mp4", "desk.js", "desk.css"):
                with self.subTest(missing=name):
                    source = root / "website" / name
                    backup = source.with_name(source.name + ".saved")
                    source.rename(backup)
                    result = subprocess.run([sys.executable, str(build)], capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    backup.rename(source)
            subprocess.run([sys.executable, str(build)], check=True)
            self.assertFalse((root / "site-build/.env").exists())


if __name__ == "__main__":
    unittest.main()
