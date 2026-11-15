#!/usr/bin/env python3
"""Dry tests for valhalla-x. No network. No real credentials."""

from __future__ import annotations

import datetime as dt
import io
import json
import os
import runpy
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import valhalla_x

ROOT = Path(__file__).resolve().parents[1]
FAKE = {
    "X_API_KEY": "ck-test-value",
    "X_API_SECRET": "cs-test-value",
    "X_ACCESS_TOKEN": "token-test-value",
    "X_ACCESS_TOKEN_SECRET": "ts-test-value",
}
PNG = (
    b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def signature_of(header: str) -> str:
    part = [piece for piece in header.split(", ") if "oauth_signature=" in piece][0]
    raw = part.split('"', 2)[1]
    return urllib.parse.unquote(raw)


class Capture:
    def __init__(self, status: int = 201, payload: dict | None = None):
        self.requests = []
        self.status = status
        self.payload = payload if payload is not None else {"data": {"id": "999"}}

    def __call__(self, request, timeout=30):
        self.requests.append(request)
        body = json.dumps(self.payload).encode()
        return FakeResponse(self.status, body)


class FakeResponse:
    def __init__(self, status: int, body: bytes):
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def getcode(self) -> int:
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> bool:
        return False


class ValhallaXTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old = {name: os.environ.get(name) for name in list(FAKE) + ["VALHALLA_X_QUEUE", "VALHALLA_X_DRAFTS", "VALHALLA_X_LOG", "DRY_RUN", "GITHUB_STEP_SUMMARY"]}
        for name in FAKE:
            os.environ.pop(name, None)
        os.environ["VALHALLA_X_LOG"] = str(Path(self.tmp.name) / "posts.json")
        valhalla_x.OPENER = None
        valhalla_x.NONCE_OVERRIDE = ""
        valhalla_x.TIMESTAMP_OVERRIDE = ""

    def tearDown(self) -> None:
        valhalla_x.OPENER = None
        valhalla_x.NONCE_OVERRIDE = ""
        valhalla_x.TIMESTAMP_OVERRIDE = ""
        for name, value in self.old.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        self.tmp.cleanup()

    def env_creds(self) -> None:
        os.environ.update(FAKE)

    def write_queue(self, items: list[dict]) -> None:
        path = Path(self.tmp.name) / "queue.json"
        path.write_text(json.dumps({"items": items}), encoding="utf-8")
        os.environ["VALHALLA_X_QUEUE"] = str(path)

    def run_cli(self, argv: list[str]) -> tuple[int, str]:
        buf = io.StringIO()
        with redirect_stdout(buf):
            try:
                valhalla_x.main(argv)
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else 1
                return code, buf.getvalue()
        return 0, buf.getvalue()

    def test_oauth_golden_values(self) -> None:
        form = valhalla_x.oauth_header(
            "POST",
            valhalla_x.PROFILE_URL,
            FAKE["X_API_KEY"],
            FAKE["X_API_SECRET"],
            FAKE["X_ACCESS_TOKEN"],
            FAKE["X_ACCESS_TOKEN_SECRET"],
            body_params={"name": "Valhalla"},
            nonce="nonce123456",
            timestamp="1700000000",
        )
        space = valhalla_x.oauth_header(
            "POST",
            valhalla_x.PROFILE_URL,
            FAKE["X_API_KEY"],
            FAKE["X_API_SECRET"],
            FAKE["X_ACCESS_TOKEN"],
            FAKE["X_ACCESS_TOKEN_SECRET"],
            body_params={"description": "desk bot"},
            nonce="nonce123456",
            timestamp="1700000000",
        )
        tweet = valhalla_x.oauth_header(
            "POST",
            valhalla_x.TWEETS_URL,
            FAKE["X_API_KEY"],
            FAKE["X_API_SECRET"],
            FAKE["X_ACCESS_TOKEN"],
            FAKE["X_ACCESS_TOKEN_SECRET"],
            nonce="nonce123456",
            timestamp="1700000000",
        )
        self.assertEqual(signature_of(form), "QlRTeFgwfnYXgm0GGUr2VclGz2I=")
        self.assertEqual(signature_of(space), "LXjVIUtO0Psh4Ki6AnJB9TExv1c=")
        self.assertEqual(signature_of(tweet), "sgMYnu5i5QV2YF8Q1BE3YVxLGQg=")
        self.assertEqual(valhalla_x.form_body({"description": "desk bot"}), b"description=desk%20bot")
        self.assertNotIn(b"desk+bot", valhalla_x.form_body({"description": "desk bot"}))

    def test_blocked_endpoint(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            valhalla_x.oauth_header(
                "POST",
                "https://api.x.com/2/users/1/likes",
                "a",
                "b",
                "c",
                "d",
            )
        self.assertEqual(caught.exception.code, "Blocked endpoint")
        with self.assertRaises(SystemExit):
            valhalla_x.send("https://api.x.com/1.1/friendships/create.json", b"", {})

    def test_source_allows_only_five_endpoints(self) -> None:
        text = Path(valhalla_x.__file__).read_text(encoding="utf-8")
        self.assertNotIn("X_ACCESS_SECRET", text.replace("X_ACCESS_TOKEN_SECRET", ""))
        self.assertNotIn("friendships", text)
        self.assertNotIn("direct_messages", text)
        self.assertNotIn("/likes", text)
        urls = set(valhalla_x.ALLOWED_URLS)
        self.assertEqual(
            urls,
            {
                "https://api.x.com/2/tweets",
                "https://api.x.com/2/media/upload",
                "https://api.x.com/1.1/account/update_profile.json",
                "https://api.x.com/1.1/account/update_profile_image.json",
                "https://api.x.com/1.1/account/update_profile_banner.json",
            },
        )

    def test_shipped_queue_is_unapproved(self) -> None:
        items = valhalla_x.load_queue(ROOT / "social" / "queue.json")
        self.assertGreaterEqual(len(items), 1)
        self.assertTrue(all(item["approved"] is False for item in items))
        self.assertTrue(all(len(str(item["text"])) <= 280 for item in items))
        self.assertIn("$9.99/month", Path(ROOT / "social" / "queue.json").read_text(encoding="utf-8"))
        self.assertNotIn("$19/month", Path(ROOT / "social" / "queue.yml").read_text(encoding="utf-8"))
        drafts = valhalla_x.load_drafts(ROOT / "social" / "drafts.md")
        self.assertEqual([item["id"] for item in drafts], [item["id"] for item in items])

    def test_draft_and_dry_post_do_not_call_x(self) -> None:
        called = {"hit": False}

        def explode(request, timeout=30):
            called["hit"] = True
            raise AssertionError("network")

        valhalla_x.OPENER = explode
        os.environ["DRY_RUN"] = "false"
        code, out = self.run_cli(["draft"])
        self.assertEqual(code, 0)
        self.assertIn("DRY RUN", out)
        self.assertIn("not-approved", out)
        code, out = self.run_cli(["post", "--id", "1"])
        self.assertEqual(code, 0)
        self.assertIn("DRY RUN", out)
        self.assertIn("No request was sent", out)
        self.assertFalse(called["hit"])

    def test_live_requires_approval_and_hides_secrets(self) -> None:
        self.write_queue(
            [
                {
                    "id": 1,
                    "text": "Hello from the test queue.",
                    "approved": False,
                    "reply_to": "55",
                    "like": True,
                }
            ]
        )
        self.env_creds()
        capture = Capture()
        valhalla_x.OPENER = capture
        code, out = self.run_cli(["post", "--id", "1", "--live"])
        self.assertEqual(code, 1)
        self.assertIn("not approved", out)
        self.assertEqual(capture.requests, [])
        self.assertNotIn("ck-test-value", out)
        self.assertNotIn("ts-test-value", out)

    def test_live_post_signs_without_json_body_and_ignores_reply(self) -> None:
        self.write_queue(
            [{"id": 4, "slug": "note", "text": "Approved note.", "approved": True, "reply_to": "88"}]
        )
        self.env_creds()
        valhalla_x.NONCE_OVERRIDE = "nonce123456"
        valhalla_x.TIMESTAMP_OVERRIDE = "1700000000"
        capture = Capture()
        valhalla_x.OPENER = capture
        code, out = self.run_cli(["post", "--id", "4", "--live"])
        self.assertEqual(code, 0, out)
        self.assertEqual(len(capture.requests), 1)
        request = capture.requests[0]
        self.assertEqual(request.full_url, valhalla_x.TWEETS_URL)
        self.assertEqual(json.loads(request.data.decode()), {"text": "Approved note."})
        expected = valhalla_x.oauth_header(
            "POST",
            valhalla_x.TWEETS_URL,
            FAKE["X_API_KEY"],
            FAKE["X_API_SECRET"],
            FAKE["X_ACCESS_TOKEN"],
            FAKE["X_ACCESS_TOKEN_SECRET"],
            nonce="nonce123456",
            timestamp="1700000000",
        )
        self.assertEqual(request.get_header("Authorization"), expected)
        self.assertNotIn("ck-test-value", out)
        self.assertNotIn("OAuth ", out)
        self.assertIn("HTTP 201", out)
        self.assertIn("tweet 999", out)
        log = json.loads(Path(os.environ["VALHALLA_X_LOG"]).read_text(encoding="utf-8"))
        self.assertEqual(list(log["days"].values())[0]["count"], 1)
        self.assertNotIn("ck-test-value", Path(os.environ["VALHALLA_X_LOG"]).read_text(encoding="utf-8"))

    def test_daily_cap(self) -> None:
        self.write_queue([{"id": 2, "text": "Cap note.", "approved": True}])
        self.env_creds()
        capture = Capture()
        valhalla_x.OPENER = capture
        self.assertEqual(self.run_cli(["post", "--id", "2", "--live"])[0], 0)
        self.assertEqual(self.run_cli(["post", "--id", "2", "--live"])[0], 0)
        code, out = self.run_cli(["post", "--id", "2", "--live"])
        self.assertEqual(code, 1)
        self.assertIn("Daily cap", out)
        self.assertEqual(len(capture.requests), 2)

    def test_corrupt_daily_log_fails_closed(self) -> None:
        self.write_queue([{"id": 2, "text": "Cap note.", "approved": True}])
        self.env_creds()
        Path(os.environ["VALHALLA_X_LOG"]).write_text(
            '{"days":{"2026-11-12":{"count":2}}}corrupt', encoding="utf-8"
        )
        capture = Capture()
        valhalla_x.OPENER = capture
        code, out = self.run_cli(["post", "--id", "2", "--live"])
        self.assertEqual(code, 1)
        self.assertIn("Post counter is invalid", out)
        self.assertEqual(capture.requests, [])

    def test_media_upload_is_not_in_the_signature(self) -> None:
        image = Path(self.tmp.name) / "dot.png"
        image.write_bytes(__import__("base64").b64decode(PNG))
        self.write_queue([{"id": 3, "text": "With image.", "approved": True, "image": str(image)}])
        self.env_creds()
        valhalla_x.NONCE_OVERRIDE = "nonce123456"
        valhalla_x.TIMESTAMP_OVERRIDE = "1700000000"
        capture = Capture()
        valhalla_x.OPENER = capture
        code, out = self.run_cli(["post", "--id", "3", "--live"])
        self.assertEqual(code, 0, out)
        self.assertEqual(capture.requests[0].full_url, valhalla_x.MEDIA_URL)
        self.assertIn("multipart/form-data", capture.requests[0].get_header("Content-type"))
        self.assertIn(b"tweet_image", capture.requests[0].data)
        expected = valhalla_x.oauth_header(
            "POST",
            valhalla_x.MEDIA_URL,
            FAKE["X_API_KEY"],
            FAKE["X_API_SECRET"],
            FAKE["X_ACCESS_TOKEN"],
            FAKE["X_ACCESS_TOKEN_SECRET"],
            nonce="nonce123456",
            timestamp="1700000000",
        )
        self.assertEqual(capture.requests[0].get_header("Authorization"), expected)
        tweet = json.loads(capture.requests[1].data.decode())
        self.assertEqual(tweet["media"]["media_ids"], ["999"])
        self.assertNotIn("reply", tweet)
        self.assertNotIn(PNG.decode(), out)
        self.assertNotIn("ck-test-value", out)

    def test_profile_dry_run_and_live_image(self) -> None:
        image = Path(self.tmp.name) / "avatar.png"
        raw = __import__("base64").b64decode(PNG)
        image.write_bytes(raw)
        code, out = self.run_cli(["profile", "--name", "Valhalla", "--bio", "desk bot", "--avatar", str(image)])
        self.assertEqual(code, 0)
        self.assertIn("DRY RUN", out)
        self.assertIn("desk bot", out)
        self.assertNotIn(PNG.decode(), out)
        self.env_creds()
        valhalla_x.NONCE_OVERRIDE = "nonce123456"
        valhalla_x.TIMESTAMP_OVERRIDE = "1700000000"
        capture = Capture(payload={"ok": True})
        valhalla_x.OPENER = capture
        code, out = self.run_cli(["profile", "--bio", "desk bot", "--avatar", str(image), "--live"])
        self.assertEqual(code, 0, out)
        self.assertEqual(capture.requests[0].full_url, valhalla_x.PROFILE_URL)
        self.assertIn(b"description=desk%20bot", capture.requests[0].data)
        self.assertEqual(capture.requests[1].full_url, valhalla_x.PROFILE_IMAGE_URL)
        parsed = urllib.parse.parse_qs(capture.requests[1].data.decode())
        encoded = __import__("base64").b64encode(raw).decode()
        self.assertEqual(parsed["image"][0], encoded)
        expected = valhalla_x.oauth_header(
            "POST",
            valhalla_x.PROFILE_IMAGE_URL,
            FAKE["X_API_KEY"],
            FAKE["X_API_SECRET"],
            FAKE["X_ACCESS_TOKEN"],
            FAKE["X_ACCESS_TOKEN_SECRET"],
            body_params={"image": encoded},
            nonce="nonce123456",
            timestamp="1700000000",
        )
        self.assertEqual(capture.requests[1].get_header("Authorization"), expected)
        self.assertNotIn(encoded, out)
        self.assertNotIn("ck-test-value", out)

    def test_banner_endpoint(self) -> None:
        image = Path(self.tmp.name) / "banner.png"
        image.write_bytes(__import__("base64").b64decode(PNG))
        self.env_creds()
        capture = Capture(payload={"ok": True})
        valhalla_x.OPENER = capture
        code, _out = self.run_cli(["profile", "--banner", str(image), "--url", "https://valhalla-app.xyz", "--live"])
        self.assertEqual(code, 0)
        urls = [request.full_url for request in capture.requests]
        self.assertEqual(urls, [valhalla_x.PROFILE_URL, valhalla_x.PROFILE_BANNER_URL])

    def test_missing_credentials_names_only(self) -> None:
        self.write_queue([{"id": 1, "text": "Ready.", "approved": True}])
        code, out = self.run_cli(["post", "--id", "1", "--live"])
        self.assertEqual(code, 1)
        self.assertIn("Missing X_API_KEY", out)
        self.assertIn("X_ACCESS_TOKEN_SECRET", out)
        self.assertNotIn("X_ACCESS_SECRET", out.replace("X_ACCESS_TOKEN_SECRET", ""))

    def test_http_error_is_status_only(self) -> None:
        class Boom:
            def __call__(self, request, timeout=30):
                raise urllib.error.HTTPError(
                    request.full_url,
                    403,
                    "forbidden ck-test-value",
                    {},
                    io.BytesIO(b"body ck-test-value"),
                )

        self.env_creds()
        with self.assertRaises(SystemExit) as caught:
            valhalla_x.send(valhalla_x.TWEETS_URL, b"{}", {"Authorization": "OAuth ck-test-value"}, Boom())
        self.assertEqual(caught.exception.code, "X API HTTP 403")

    def test_new_york_day(self) -> None:
        early = dt.datetime(2026, 11, 4, 2, 30, tzinfo=dt.timezone.utc)
        later = dt.datetime(2026, 11, 4, 5, 0, tzinfo=dt.timezone.utc)
        self.assertEqual(valhalla_x.today_key(early), "2026-11-03")
        self.assertEqual(valhalla_x.today_key(later), "2026-11-04")

    def test_legacy_script_and_workflow_cannot_post(self) -> None:
        valhalla_x.OPENER = lambda request, timeout=30: (_ for _ in ()).throw(AssertionError("network"))
        buf = io.StringIO()
        with redirect_stdout(buf):
            runpy.run_path(str(ROOT / "social" / "post.py"), run_name="__main__")
        self.assertIn("only previews", buf.getvalue())
        self.assertIn("DRY RUN", buf.getvalue())
        workflow = (ROOT / ".github" / "workflows" / "valhalla-social.yml").read_text(encoding="utf-8")
        self.assertNotIn("secrets.", workflow)
        self.assertNotIn("--live", workflow)
        readme = (ROOT / "social" / "README.md").read_text(encoding="utf-8")
        self.assertNotIn("X_ACCESS_SECRET", readme.replace("X_ACCESS_TOKEN_SECRET", ""))


if __name__ == "__main__":
    unittest.main()
