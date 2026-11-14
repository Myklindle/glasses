#!/usr/bin/env python3
"""Find the newest full-episode upload for each show and write latest.json.

Reads each channel's public Videos tab (no API key needed), picks the newest
video whose title looks like a full episode, and records its video ID.

Behavior worth knowing:
- If a lookup fails, the previous value in latest.json is kept.
- latest.json is rewritten only when an episode actually changes, so the
  workflow only commits when there is something new.
- Standard library only, so it runs on a stock GitHub runner.

Usage:
    python3 scripts/update_latest.py            # update latest.json
    python3 scripts/update_latest.py --debug    # also print what was matched
"""
import datetime
import functools
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "latest.json")

SHOWS = {
    "newshour": {
        "channel": "UC6ZFN9Tx6xh-skXCuRHCDpQ",
        "title": re.compile(r"news ?hour.*full episode", re.I),
    },
    "washingtonweek": {
        "channel": "UC2s0uKOc2WgB9eGta7cUUEA",
        "title": re.compile(r"washington week.*full episode", re.I),
    },
    # PBS News keeps each of these in a playlist of full episodes, newest first.
    # Upload titles are topics (no show name), so the label is built from the
    # upload date instead.
    "compasspoints": {
        "playlist": "PLgawtcOBBjr-KZydGcRYKOGXvR7xKhm1m",
        "name": "Compass Points",
    },
    "horizons": {
        "playlist": "PLgawtcOBBjr9HbB4Qa0Y_BDsCADC_v00X",
        "name": "Horizons",
    },
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    # Skips the cookie-consent interstitial some regions get.
    "Cookie": "CONSENT=YES+cb; SOCS=CAI",
}

DEBUG = "--debug" in sys.argv


@functools.lru_cache(maxsize=None)
def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def initial_data(html):
    marker = "var ytInitialData = "
    start = html.find(marker)
    if start < 0:
        raise RuntimeError("ytInitialData not found (page layout changed or blocked)")
    data, _ = json.JSONDecoder().raw_decode(html[start + len(marker):])
    return data


def videos(node):
    """Yield (video_id, title) in page order from both old and new layouts."""
    stack = [node]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            # New layout: lockupViewModel
            if cur.get("contentType") == "LOCKUP_CONTENT_TYPE_VIDEO" and "contentId" in cur:
                meta = cur.get("metadata", {}).get("lockupMetadataViewModel", {})
                title = meta.get("title", {}).get("content")
                if title:
                    yield cur["contentId"], title
                continue
            # Old layout: videoRenderer
            if "videoId" in cur and isinstance(cur.get("title"), dict):
                runs = cur["title"].get("runs") or []
                title = runs[0].get("text") if runs else cur["title"].get("simpleText")
                if title:
                    yield cur["videoId"], title
                continue
            stack.extend(reversed(list(cur.values())))
        elif isinstance(cur, list):
            stack.extend(reversed(cur))


MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."]
def newest_in_playlist(show):
    html = fetch("https://www.youtube.com/playlist?list=" + show["playlist"])
    for vid, _title in videos(initial_data(html)):
        page = fetch("https://www.youtube.com/watch?v=" + vid)
        m = re.search(r'"publishDate":"(\d{4})-(\d{2})-(\d{2})', page)
        if not m:
            raise RuntimeError("publish date not found for " + vid)
        year, month, day = (int(g) for g in m.groups())
        title = "%s full episode, %s %d, %d" % (show["name"], MONTHS[month - 1], day, year)
        if DEBUG:
            print("  playlist top: %s %s" % (vid, title))
        return {"videoId": vid, "title": title}
    raise RuntimeError("playlist is empty (page layout changed or blocked)")
def newest_full_episode(show):
    if "playlist" in show:
        return newest_in_playlist(show)
    html = fetch("https://www.youtube.com/channel/%s/videos" % show["channel"])
    seen = set()
    for index, (vid, title) in enumerate(videos(initial_data(html))):
        if vid in seen:
            continue
        seen.add(vid)
        if show["title"].search(title):
            if DEBUG:
                print("  matched at position %d: %s %s" % (index, vid, title))
            return {"videoId": vid, "title": title}
    raise RuntimeError("no full episode in the %d most recent uploads" % len(seen))


def find_key(node, key):
    """Yield every value stored under `key` anywhere in a nested structure."""
    stack = [node]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            if key in cur:
                yield cur[key]
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)


TIMESTAMP_LINE = re.compile(
    r"^\s*\(?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\)?\s*[-\u2013\u2014:]?\s*(.+?)\s*$"
)


def chapters_from_description(html):
    """Fallback: read "00:00- Title" style lines from the video description."""
    m = re.search(r'"shortDescription":"(.*?)","isCrawlable"', html, re.S)
    if not m:
        return []
    try:
        text = json.loads('"' + m.group(1) + '"')
    except ValueError:
        return []
    out = []
    for line in text.splitlines():
        t = TIMESTAMP_LINE.match(line)
        if t:
            hours, minutes, seconds, title = t.groups()
            start = int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds)
            out.append({"start": start, "title": title})
    return out


def episode_chapters(video_id):
    """Return [{"start": seconds, "title": str}, ...] for a video, or []."""
    html = fetch("https://www.youtube.com/watch?v=" + video_id)
    chapters, seen = [], set()
    for item in find_key(initial_data(html), "macroMarkersListItemRenderer"):
        title = (item.get("title") or {}).get("simpleText")
        start = ((item.get("onTap") or {}).get("watchEndpoint") or {}).get("startTimeSeconds")
        if title and isinstance(start, int) and start not in seen:
            seen.add(start)
            chapters.append({"start": start, "title": title})
    if not chapters:
        # YouTube's own rule: chapters need 3+ timestamps, the first at 0:00.
        chapters = chapters_from_description(html)
        if len(chapters) < 3 or chapters[0]["start"] != 0:
            chapters = []
    chapters.sort(key=lambda c: c["start"])
    return chapters


def main():
    try:
        with open(OUT, encoding="utf-8") as fh:
            current = json.load(fh)
    except (OSError, ValueError):
        current = {}
    shows_now = dict(current.get("shows", {}))

    changed = False
    missing = False
    for key, show in SHOWS.items():
        try:
            found = newest_full_episode(show)
        except Exception as exc:  # keep going; keep the old value
            print("::warning::%s lookup failed: %s" % (key, exc))
            if key not in shows_now:
                missing = True
            continue

        # Chapters are optional. Keep the old ones if this lookup fails or comes back
        # empty for the same video (PBS can add chapters some time after upload).
        previous = shows_now.get(key) or {}
        try:
            chapters = episode_chapters(found["videoId"])
        except Exception as exc:
            print("::warning::%s chapters lookup failed: %s" % (key, exc))
            chapters = []
        if not chapters and previous.get("videoId") == found["videoId"]:
            chapters = previous.get("chapters", [])
        found["chapters"] = chapters

        if shows_now.get(key) != found:
            print("%s: %s" % (key, found["title"]))
            shows_now[key] = found
            changed = True
        elif DEBUG:
            print("%s: unchanged (%s)" % (key, found["title"]))

    if changed:
        payload = {
            "updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "shows": shows_now,
        }
        with open(OUT, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
            fh.write("\n")

    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as fh:
            fh.write("changed=%s\n" % ("true" if changed else "false"))

    # Fail only when a show has no episode at all to fall back on.
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
