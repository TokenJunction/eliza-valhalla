#!/usr/bin/env python3
"""Manual X account tool for Valhalla.

Commands: draft, post, profile.
A real post needs --live and "approved": true on that queue item.
This tool does not like, follow, send direct messages, or reply.
Secrets stay in the environment and are never printed.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import fcntl
import hashlib
import hmac
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import zoneinfo
from pathlib import Path

CRED_NAMES = (
    "X_API_KEY",
    "X_API_SECRET",
    "X_ACCESS_TOKEN",
    "X_ACCESS_TOKEN_SECRET",
)
TWEETS_URL = "https://api.x.com/2/tweets"
MEDIA_URL = "https://api.x.com/2/media/upload"
PROFILE_URL = "https://api.x.com/1.1/account/update_profile.json"
PROFILE_IMAGE_URL = "https://api.x.com/1.1/account/update_profile_image.json"
PROFILE_BANNER_URL = "https://api.x.com/1.1/account/update_profile_banner.json"
ALLOWED_URLS = frozenset(
    {TWEETS_URL, MEDIA_URL, PROFILE_URL, PROFILE_IMAGE_URL, PROFILE_BANNER_URL}
)
DAILY_POST_CAP = 2
MAX_PROFILE_IMAGE = 2_000_000
MAX_TWEET_IMAGE = 5_000_000
FIELD_LIMITS = {"name": 50, "description": 160, "url": 100, "location": 30}
IMAGE_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
OPENER = None
NONCE_OVERRIDE = ""
TIMESTAMP_OVERRIDE = ""


def redact(text: str) -> str:
    cleaned = text
    for name in CRED_NAMES:
        value = os.environ.get(name) or ""
        if len(value) >= 8 and value in cleaned:
            cleaned = cleaned.replace(value, "[redacted]")
    if "oauth_signature" in cleaned or cleaned.startswith("OAuth "):
        return "[redacted]"
    return cleaned


def say(text: str) -> None:
    try:
        print(redact(text), flush=True)
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except BrokenPipeError:
            pass
        raise SystemExit(0) from None


def enc(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")


def social_dir() -> Path:
    return Path(__file__).resolve().parent


def queue_path() -> Path:
    override = os.environ.get("VALHALLA_X_QUEUE")
    return Path(override) if override else social_dir() / "queue.json"


def drafts_path() -> Path:
    override = os.environ.get("VALHALLA_X_DRAFTS")
    return Path(override) if override else social_dir() / "drafts.md"


def log_path() -> Path:
    override = os.environ.get("VALHALLA_X_LOG")
    return Path(override) if override else social_dir() / ".x-posts.json"


def today_key(moment: dt.datetime | None = None) -> str:
    current = moment or dt.datetime.now(dt.timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=dt.timezone.utc)
    try:
        zone = zoneinfo.ZoneInfo("America/New_York")
    except zoneinfo.ZoneInfoNotFoundError as exc:
        raise SystemExit("America/New_York timezone data is missing") from exc
    return current.astimezone(zone).date().isoformat()


def load_drafts(path: Path) -> list[dict[str, object]]:
    if not path.is_file():
        return []
    drafts: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    body: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        if raw.startswith("## "):
            if current is not None:
                current["text"] = "\n".join(body).strip()
                drafts.append(current)
            title = raw[3:].strip()
            ident, dot, slug = title.partition(".")
            if not ident.strip().isdigit():
                current = None
                body = []
                continue
            current = {
                "id": int(ident.strip()),
                "slug": slug.strip() if dot else "",
                "text": "",
            }
            body = []
            continue
        if current is not None:
            body.append(raw)
    if current is not None:
        current["text"] = "\n".join(body).strip()
        drafts.append(current)
    return drafts


def load_queue(path: Path) -> list[dict[str, object]]:
    if not path.is_file():
        raise SystemExit(f"Queue file is missing: {path.name}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit("queue.json is not valid JSON") from exc
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise SystemExit("queue.json needs an items list")
    loaded: list[dict[str, object]] = []
    seen: set[int] = set()
    for item in items:
        if not isinstance(item, dict) or "id" not in item or "text" not in item:
            raise SystemExit("Each queue item needs id and text")
        try:
            item_id = int(item["id"])
        except (TypeError, ValueError) as exc:
            raise SystemExit("Queue id must be a number") from exc
        if item_id in seen:
            raise SystemExit(f"queue.json repeats id {item_id}")
        seen.add(item_id)
        image = item.get("image") or ""
        if not isinstance(image, str) or not isinstance(item["text"], str):
            raise SystemExit("Queue text and image must be strings")
        loaded.append(
            {
                "id": item_id,
                "slug": str(item.get("slug") or ""),
                "text": item["text"],
                "approved": item.get("approved") is True,
                "image": image,
            }
        )
    return loaded


def oauth_header(
    method: str,
    url: str,
    consumer_key: str,
    consumer_secret: str,
    token: str,
    token_secret: str,
    body_params: dict[str, str] | None = None,
    nonce: str | None = None,
    timestamp: str | None = None,
) -> str:
    if url not in ALLOWED_URLS:
        raise SystemExit("Blocked endpoint")
    stamp = timestamp or TIMESTAMP_OVERRIDE or str(int(dt.datetime.now(dt.timezone.utc).timestamp()))
    oauth = {
        "oauth_consumer_key": consumer_key,
        "oauth_nonce": nonce or NONCE_OVERRIDE or secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": stamp,
        "oauth_token": token,
        "oauth_version": "1.0",
    }
    signed = dict(oauth)
    if body_params:
        signed.update(body_params)
    param_string = "&".join(f"{enc(key)}={enc(value)}" for key, value in sorted(signed.items()))
    base_string = "&".join([method.upper(), enc(url), enc(param_string)])
    signing_key = f"{enc(consumer_secret)}&{enc(token_secret)}"
    digest = hmac.new(signing_key.encode(), base_string.encode(), hashlib.sha1).digest()
    oauth["oauth_signature"] = base64.b64encode(digest).decode()
    parts = ", ".join(f'{enc(key)}="{enc(value)}"' for key, value in sorted(oauth.items()))
    return "OAuth " + parts


def credentials() -> dict[str, str]:
    missing = [name for name in CRED_NAMES if not os.environ.get(name)]
    if missing:
        raise SystemExit("Missing " + ", ".join(missing))
    return {name: os.environ[name] for name in CRED_NAMES}


def form_body(params: dict[str, str]) -> bytes:
    return urllib.parse.urlencode(params, quote_via=urllib.parse.quote, safe="").encode()


def send(url: str, data: bytes, headers: dict[str, str], opener=None) -> tuple[int, bytes]:
    if url not in ALLOWED_URLS:
        raise SystemExit("Blocked endpoint")
    request = urllib.request.Request(url, data=data, method="POST")
    for key, value in headers.items():
        request.add_header(key, value)
    open_fn = opener or OPENER or urllib.request.urlopen
    try:
        with open_fn(request, timeout=30) as response:
            code = getattr(response, "status", None) or response.getcode()
            return int(code), response.read()
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"X API HTTP {exc.code}") from None
    except urllib.error.URLError:
        raise SystemExit("X API network error") from None


def auth_headers(header: str, content_type: str) -> dict[str, str]:
    return {"Authorization": header, "Content-Type": content_type}


def signed_form(url: str, params: dict[str, str], creds: dict[str, str], opener=None) -> tuple[int, bytes]:
    header = oauth_header(
        "POST",
        url,
        creds["X_API_KEY"],
        creds["X_API_SECRET"],
        creds["X_ACCESS_TOKEN"],
        creds["X_ACCESS_TOKEN_SECRET"],
        body_params=params,
    )
    return send(url, form_body(params), auth_headers(header, "application/x-www-form-urlencoded"), opener)


def image_bytes(path: str, limit: int) -> tuple[bytes, str, str]:
    file_path = Path(path)
    if not file_path.is_file():
        raise SystemExit("Image file is missing")
    suffix = file_path.suffix.lower()
    if suffix not in IMAGE_TYPES:
        raise SystemExit("Image must be png, jpg, gif, or webp")
    raw = file_path.read_bytes()
    if len(raw) > limit:
        raise SystemExit(f"Image is larger than {limit} bytes")
    name = file_path.name.replace('"', "").replace("\r", "").replace("\n", "")
    return raw, IMAGE_TYPES[suffix], name


def upload_media(path: str, creds: dict[str, str], opener=None) -> str:
    raw, content_type, filename = image_bytes(path, MAX_TWEET_IMAGE)
    category = "tweet_gif" if content_type == "image/gif" else "tweet_image"
    boundary = "ValhallaX" + secrets.token_hex(8)
    chunks = [
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="media"; filename="{filename}"\r\n'.encode(),
        f"Content-Type: {content_type}\r\n\r\n".encode(),
        raw,
        f"\r\n--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="media_category"\r\n\r\n',
        category.encode() + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    header = oauth_header(
        "POST",
        MEDIA_URL,
        creds["X_API_KEY"],
        creds["X_API_SECRET"],
        creds["X_ACCESS_TOKEN"],
        creds["X_ACCESS_TOKEN_SECRET"],
    )
    code, payload = send(
        MEDIA_URL,
        b"".join(chunks),
        auth_headers(header, f"multipart/form-data; boundary={boundary}"),
        opener,
    )
    try:
        parsed = json.loads(payload.decode())
        data = parsed.get("data") if isinstance(parsed, dict) else None
        if not isinstance(data, dict):
            data = parsed if isinstance(parsed, dict) else {}
        media_id = str(data.get("id") or data.get("media_id_string") or "")
    except (UnicodeDecodeError, json.JSONDecodeError):
        media_id = ""
    if not media_id:
        raise SystemExit(f"X API HTTP {code}")
    return media_id


def post_tweet(text: str, media_id: str, creds: dict[str, str], opener=None) -> tuple[int, str]:
    body: dict[str, object] = {"text": text}
    if media_id:
        body["media"] = {"media_ids": [media_id]}
    header = oauth_header(
        "POST",
        TWEETS_URL,
        creds["X_API_KEY"],
        creds["X_API_SECRET"],
        creds["X_ACCESS_TOKEN"],
        creds["X_ACCESS_TOKEN_SECRET"],
    )
    encoded = json.dumps(body, separators=(",", ":")).encode()
    code, payload = send(TWEETS_URL, encoded, auth_headers(header, "application/json"), opener)
    tweet_id = ""
    try:
        parsed = json.loads(payload.decode())
        data = parsed.get("data") if isinstance(parsed, dict) else None
        if isinstance(data, dict) and data.get("id"):
            tweet_id = str(data["id"])
    except (UnicodeDecodeError, json.JSONDecodeError):
        tweet_id = ""
    return code, tweet_id


def read_log(handle) -> dict:
    handle.seek(0)
    raw = handle.read()
    if not raw.strip():
        raise SystemExit("Post counter is empty; refusing live posts")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise SystemExit("Post counter is invalid; refusing live posts") from None
    if not isinstance(data, dict) or not isinstance(data.get("days"), dict):
        raise SystemExit("Post counter is invalid; refusing live posts")
    return data


def write_log(handle, data: dict) -> None:
    handle.seek(0)
    handle.truncate()
    handle.write(json.dumps(data, separators=(",", ":")))
    handle.flush()


def guarded_post(item: dict[str, object], creds: dict[str, str], opener=None) -> tuple[int, str]:
    path = log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    new_log = not path.exists()
    with path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            os.chmod(path, 0o600)
            if new_log and os.fstat(handle.fileno()).st_size == 0:
                write_log(handle, {"days": {}})
            data = read_log(handle)
            day = today_key()
            entry = data["days"].get(day, {"count": 0, "posts": []})
            if not isinstance(entry, dict):
                raise SystemExit("Post counter is invalid; refusing live posts")
            count = entry.get("count", 0)
            if type(count) is not int or count < 0:
                raise SystemExit("Post counter is invalid; refusing live posts")
            if count >= DAILY_POST_CAP:
                raise SystemExit(f"Daily cap is {DAILY_POST_CAP} posts for {day} (America/New_York).")
            media_id = ""
            image = str(item.get("image") or "")
            if image:
                media_id = upload_media(image, creds, opener)
            code, tweet_id = post_tweet(str(item["text"]), media_id, creds, opener)
            posts = list(entry.get("posts") or [])
            posts.append(
                {
                    "id": item["id"],
                    "at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
            )
            data["days"][day] = {"count": count + 1, "posts": posts}
            write_log(handle, data)
            return code, tweet_id
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def find_item(item_id: int) -> dict[str, object]:
    for item in load_queue(queue_path()):
        if item["id"] == item_id:
            return item
    raise SystemExit(f"No queue item {item_id}")


def cmd_draft() -> None:
    drafts = load_drafts(drafts_path())
    queue = load_queue(queue_path())
    lines = [f"drafts.md items: {len(drafts)}"]
    for item in drafts:
        lines.append(f"draft {item['id']} {item['slug']} chars {len(str(item['text']))}")
        lines.append(str(item["text"]))
        lines.append("")
    lines.append(f"queue.json items: {len(queue)}")
    for item in queue:
        flag = "approved" if item["approved"] else "not-approved"
        image = f" image {Path(str(item['image'])).name}" if item["image"] else ""
        lines.append(f"queue {item['id']} {item['slug']} {flag} chars {len(str(item['text']))}{image}")
    lines.append("DRY RUN. Nothing was posted.")
    for line in lines:
        say(line)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write("\n".join(redact(line) for line in lines) + "\n")


def cmd_post(item_id: int, live: bool) -> None:
    item = find_item(item_id)
    text = str(item["text"])
    if not text or len(text) > 280:
        raise SystemExit(f"Item {item_id} must be 1 to 280 characters")
    flag = "approved" if item["approved"] else "not-approved"
    say(f"item {item_id} {flag} chars {len(text)}")
    say(text)
    if item["image"]:
        say(f"image {Path(str(item['image'])).name}")
    if not live:
        say("DRY RUN. No request was sent. Real posting needs --live and approved true in queue.json.")
        return
    if not item["approved"]:
        raise SystemExit(f"Refused. Item {item_id} is not approved in queue.json.")
    if item["image"]:
        image_bytes(str(item["image"]), MAX_TWEET_IMAGE)
    creds = credentials()
    code, tweet_id = guarded_post(item, creds)
    suffix = f" tweet {tweet_id}" if tweet_id else ""
    say(f"Posted item {item_id}. HTTP {code}.{suffix}")


def profile_fields(args: argparse.Namespace) -> dict[str, str]:
    fields: dict[str, str] = {}
    if args.name is not None:
        fields["name"] = args.name
    if args.bio is not None:
        fields["description"] = args.bio
    if args.url is not None:
        fields["url"] = args.url
    if args.location is not None:
        fields["location"] = args.location
    return fields


def cmd_profile(args: argparse.Namespace) -> None:
    fields = profile_fields(args)
    if not fields and not args.avatar and not args.banner:
        raise SystemExit("Give at least one of --name --bio --url --location --avatar --banner")
    for key, value in fields.items():
        if len(value) > FIELD_LIMITS[key]:
            raise SystemExit(f"{key} is longer than {FIELD_LIMITS[key]} characters")
    if fields.get("url") and not fields["url"].startswith("https://"):
        raise SystemExit("url must start with https://")
    if args.avatar:
        image_bytes(args.avatar, MAX_PROFILE_IMAGE)
    if args.banner:
        image_bytes(args.banner, MAX_PROFILE_IMAGE)
    say("DRY RUN profile" if not args.live else "profile")
    for key, value in fields.items():
        label = "bio" if key == "description" else key
        say(f"{label}: {value}")
    if args.avatar:
        say(f"avatar file {Path(args.avatar).name}")
    if args.banner:
        say(f"banner file {Path(args.banner).name}")
    if not args.live:
        say("DRY RUN. No profile request was sent.")
        return
    creds = credentials()
    if fields:
        code, _payload = signed_form(PROFILE_URL, fields, creds)
        say(f"Updated profile text. HTTP {code}.")
    if args.avatar:
        raw, _kind, _name = image_bytes(args.avatar, MAX_PROFILE_IMAGE)
        code, _payload = signed_form(PROFILE_IMAGE_URL, {"image": base64.b64encode(raw).decode()}, creds)
        say(f"Updated avatar. HTTP {code}.")
    if args.banner:
        raw, _kind, _name = image_bytes(args.banner, MAX_PROFILE_IMAGE)
        code, _payload = signed_form(PROFILE_BANNER_URL, {"banner": base64.b64encode(raw).decode()}, creds)
        say(f"Updated banner. HTTP {code}.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="valhalla-x")
    commands = parser.add_subparsers(dest="cmd", required=True)
    commands.add_parser("draft", help="Print drafts.md and queue.json")
    post = commands.add_parser("post", help="Preview or post one queue item")
    post.add_argument("--id", required=True, type=int)
    post.add_argument("--live", action="store_true")
    profile = commands.add_parser("profile", help="Preview or update the X profile")
    profile.add_argument("--name")
    profile.add_argument("--bio")
    profile.add_argument("--url")
    profile.add_argument("--location")
    profile.add_argument("--avatar")
    profile.add_argument("--banner")
    profile.add_argument("--live", action="store_true")
    return parser


def run(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    if args.cmd == "draft":
        cmd_draft()
    elif args.cmd == "post":
        cmd_post(args.id, args.live)
    elif args.cmd == "profile":
        cmd_profile(args)
    else:
        raise SystemExit("Unknown command")


def main(argv: list[str] | None = None) -> None:
    try:
        run(argv)
    except SystemExit as exc:
        if isinstance(exc.code, str):
            say(exc.code)
            raise SystemExit(1) from None
        raise


if __name__ == "__main__":
    main()
