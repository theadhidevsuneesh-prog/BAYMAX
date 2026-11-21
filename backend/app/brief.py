"""World headlines for the daily brief. Public RSS feeds only; nothing about the user is sent."""
from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx

# Public news RSS feeds used for the daily brief. Nothing about the user is sent to them.
FEEDS = [
    ("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("NPR World", "https://feeds.npr.org/1004/rss.xml"),
    ("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"),
]
# Matches HTML tags (feed descriptions sometimes contain them).
_TAG = re.compile(r"<[^>]+>")


# Turn feed text into one clean line: no tags, no entities, no extra spaces.
def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(_TAG.sub(" ", s or ""))).strip()


# Fetch one feed and return up to 6 stories. A failing feed just yields nothing.
def _one(feed: tuple[str, str]) -> list[dict[str, str]]:
    name, url = feed
    try:
        r = httpx.get(url, timeout=8, follow_redirects=True, headers={"User-Agent": "BAYMAX/1.0"})
        r.raise_for_status()
        root = ET.fromstring(r.content)
    except Exception:
        return []
    out = []
    for it in root.iter("item"):
        title = _clean(it.findtext("title") or "")
        if title:
            out.append({"source": name, "title": title[:160], "summary": _clean(it.findtext("description") or "")[:220]})
        if len(out) >= 6:
            break
    return out


# Top stories from all feeds (fetched in parallel), interleaved so one source can't dominate, duplicates dropped.
def headlines() -> list[dict[str, str]]:
    """Top stories interleaved across sources, near-duplicates dropped."""
    with ThreadPoolExecutor(max_workers=len(FEEDS)) as ex:
        lists = list(ex.map(_one, FEEDS))
    merged: list[dict[str, str]] = []
    seen: set[str] = set()
    for i in range(6):
        for lst in lists:
            if i < len(lst):
                key = re.sub(r"\W+", "", lst[i]["title"].lower())[:40]
                if key not in seen:
                    seen.add(key)
                    merged.append(lst[i])
    return merged[:10]


# Format the stories as a list the model can summarize.
def as_prompt_block(items: list[dict[str, Any]]) -> str:
    return "\n".join(f"- ({h['source']}) {h['title']}" + (f": {h['summary']}" if h["summary"] else "") for h in items)
