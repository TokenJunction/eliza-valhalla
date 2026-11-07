# Valhalla X helper

`valhalla-x` is a small Python 3 tool for the Valhalla X account. It runs on a plain Linux box. It uses the Python standard library only. You do not install packages.

It can preview drafts, post one approved note, upload one image, and update the profile. It does not like, follow, send direct messages, or reply.

Every command is a dry run until you add `--live`. A real post also needs `"approved": true` on that item in `social/queue.json`.

## Preview

From the repository root:

```bash
python3 social/valhalla-x draft
python3 social/valhalla-x post --id 1
```

`draft` reads `social/drafts.md` and `social/queue.json`. It prints the notes and does not call X.

`post --id 1` prints that one note. It does not call X.

`social/queue.yml` is a reference copy only. The tool does not post from it.

## Approve a note

Open `social/queue.json`. Set `"approved"` to `true` on the one item you want to send. Leave every other item `false`. The text must be 1 to 280 characters.

An optional `"image"` value is a local png, jpg, gif, or webp path. The file must be 5 MB or smaller. The tool uploads it with X media upload v2, then attaches it to that one post.

## Post for real

Put the four secrets in the environment for that command. Do not write them in a file in this repo. Do not paste them into the terminal log you keep. The tool reads these names:

- `X_API_KEY`
- `X_API_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_TOKEN_SECRET`

These are OAuth 1.0a credentials from the X developer app. The tool never prints them.

```bash
python3 social/valhalla-x post --id 1 --live
```

The command sends at most one post. A later post the same America/New_York day counts too. The third live post that day stops. The counter is `social/.x-posts.json`. That file is local. Do not commit it.

`--live` without `"approved": true` does not post.

`DRY_RUN=false` does not post. Only the `--live` flag does.

## Profile

Dry run:

```bash
python3 social/valhalla-x profile --name "Valhalla" --bio "Desk status for a Solana companion. Keys stay on your PC. Not financial advice." --url "https://valhalla-app.xyz" --location "Remote" --avatar ./avatar.png --banner ./banner.png
```

Add `--live` to send the change. The same four environment variables are required. Profile calls use X API v1.1 `account/update_profile`, `account/update_profile_image`, and `account/update_profile_banner`. Avatar and banner files must be png, jpg, gif, or webp, and 2 MB or smaller. A profile update does not count toward the two posts per day.

The url must start with `https://`.

## Checks

```bash
python3 social/test_valhalla_x.py
```

The tests do not use the network and do not read real credentials.

## GitHub Actions

`.github/workflows/valhalla-social.yml` runs the tests and `draft` only. It does not receive the X secrets. It cannot post. The daily schedule runs only after this file is on the default branch. That run is still a preview.
