# Mike's News (Meta Ray-Ban Display web app)

Two buttons: the latest **PBS News Hour** full episode and the latest **Washington Week** full episode, played through the YouTube embedded player. On Fridays Washington Week is listed first. Playback position is remembered per episode.

## How it works

- `index.html`, `styles.css`, `app.js`: the app. Built for the 600 x 600 additive display, navigated with the Neural Band or touchpad. No custom focus code; the browser handles directional navigation.
- `latest.json`: the current episode IDs. Refreshed by `scripts/update_latest.py`, which reads each channel's public Videos tab and picks the newest upload titled "... full episode". No API key.
- `.github/workflows/pages.yml`: every 20 minutes (and on every push) it refreshes `latest.json`, commits it if changed, and deploys to GitHub Pages. Scheduled runs with nothing new skip the deploy.
- `.well-known/meta-wearables-manifest.json` and `icons/news.svg`: the app name and icon the glasses read.
- If `latest.json` can't be loaded, each card opens that channel's latest uploads instead. If the YouTube API script can't load, the app falls back to a plain embed with YouTube's own controls.

## Publish (one time)

1. On GitHub, create an empty **public** repo named `glasses`.
2. Push this folder to its `main` branch.
3. In the repo: **Settings > Pages > Source: GitHub Actions**.
4. Run **Actions > Refresh episodes and deploy > Run workflow** (or just push).
5. The app is then at `https://<username>.github.io/glasses/`.
6. Check the manifest is served correctly: `curl -I https://<username>.github.io/glasses/.well-known/meta-wearables-manifest.json` should show `content-type: application/json; charset=utf-8`.

## Put it on the glasses

1. Update the glasses (v125 or later; newest is best) and the Meta AI app (v272 or later).
2. Meta AI app > Settings > App Info > tap the app version 5 times > Enable.
3. Add the app by URL: App settings > App connections > Add a Web App, then enter the URL above. Or scan a QR code encoding
   `fb-viewapp://web_app_deep_link?appName=Mikes%20News&appUrl=https://<username>.github.io/glasses/`
4. The glasses mark it "unverified". That is normal for your own app.

## Check on the device

- Does video actually play, with sound through the glasses speakers?
- Do `-15s`, `Play/Pause` and `+30s` respond once per press?
- Does Back return to the home screen, and does a second Back leave the app?
- Is the text readable outdoors and indoors? Are focus outlines visible at the edges?
- If playback fails: the status line shows YouTube's error code.
- An "Open in YouTube" link was tried and removed: the glasses' browser did not follow it.

## Run locally

```sh
python3 -m http.server 8765      # then open http://127.0.0.1:8765/
python3 scripts/update_latest.py --debug
```

If the script reports a certificate error on a python.org Python on macOS, run it with `SSL_CERT_FILE=/etc/ssl/cert.pem`.

## Known limits

- The episode lookup reads the 30 most recent uploads per channel. If a lookup fails, the previous episode stays.
- YouTube can change its page layout, which would break the lookup until the script is updated.
- Scheduled workflows on GitHub can be delayed by several minutes.
