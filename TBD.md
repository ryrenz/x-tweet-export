# TBD - Future Features

## Media Export (P1)

Export images and videos associated with tweets, with one-to-one correspondence.

### Technical Feasibility

- **Images**: `legacy.entities.media[].media_url_https` — direct CDN link (`pbs.twimg.com`), append `?format=jpg&name=orig` for original resolution
- **Videos/GIFs**: `legacy.extended_entities.media[].video_info.variants[]` — multiple bitrate mp4 URLs, pick highest bitrate
- **Association**: Each media object has `id_str` and is nested under its parent tweet — natural 1:1 mapping

### Implementation Options

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A — URL column | Add `media_urls` column to CSV (comma-separated links) | Zero risk, no extra dependencies, user downloads manually | Not a true "media export" |
| B — Zip bundle | Export `tweets.csv` + `media/` folder as `.zip` | Complete solution, one-click download | Requires JSZip (breaks zero-dependency principle), large files, CDN rate limit risk |

### Open Questions

- Zip approach needs JSZip or similar — acceptable to bundle a dependency?
- Video files can be large (50MB+) — should we cap per-export size?
- CDN throttling — need delay between media fetches (similar to API delay)
- File naming: `{tweet_id}_{index}.{ext}` or `{date}_{tweet_id}.{ext}`?

## Robust Anti-Rate-Limit System (P0)

> **Blocker for Custom Count Slider** — must be implemented before raising the export cap above 200.

Must guarantee 1000-tweet exports without account suspension. Current 3s delay + 429 auto-pause is a start but not battle-tested at 1000 scale.

### Requirements

- **Adaptive delay**: Instead of fixed 3s, dynamically adjust based on response headers (`x-rate-limit-remaining`, `x-rate-limit-reset`). Slow down as quota runs low, speed up when headroom is high.
- **Exponential backoff on 429**: Current 60s flat wait is naive. Should do 30s → 60s → 120s → 240s with jitter.
- **Concurrent session protection**: Users may open multiple tabs exporting different accounts simultaneously. Need a global request counter via `chrome.storage.session` to coordinate rate across all tabs, ensuring total request rate stays safe even with 3+ parallel exports.
- **Per-window request budget**: e.g. max 50 requests per 15-minute window across all tabs, matching X's known rate limit window.
- **Pre-flight check**: Before starting a large export (>200), query `x-rate-limit-remaining` from the last response to estimate if the export can complete without hitting the wall.
- **Graceful degradation**: If budget is low, show "Estimated wait: ~5 min" before starting, or auto-split into batches with cooldown between them.
- **Progress persistence**: For 1000-tweet exports that may take 5+ min, save progress to `chrome.storage.local` so that if the tab is accidentally closed or refreshed, the user can resume from where they left off instead of restarting.

### Open Questions

- What are X's exact rate limits for UserTweets? (Believed to be ~50 requests / 15 min for GraphQL, but unconfirmed for authenticated users)
- Should we fingerprint the request pattern to mimic real user scrolling behavior (randomized delays)?
- Is there a safe maximum concurrent export count? (Probably 1 at a time to be safe)

## Custom Count Slider (P1)

> Depends on: Anti-Rate-Limit System (P0)

Replace the dropdown (50/100/200) with a draggable slider/progress bar for setting export count.

- Range: 0 - 1000
- UI: Slider bar with current value displayed, user can drag to set
- Remove the current hard cap of 200; let users decide their own risk tolerance
- Show warning text when value > 200 (e.g. "High count may trigger rate limiting")
- 0 = export all (no limit)

## i18n (P1)

- English + Chinese + Japanese UI
- Button labels, error messages, progress text
- Detect from browser language or X's UI language

## Date Range Filter (P2)

- Export only tweets from a specific time period
- Add date pickers to the UI

## Search Export (P2)

- Export tweets from search results, not just profile timeline
- Intercept search GraphQL endpoint

## Likes / Bookmarks Export (P2)

- Export user's own liked or bookmarked tweets
- Different GraphQL endpoints: `Likes`, `Bookmarks`

## Batch Export (P3)

- Export from multiple accounts in sequence
- Queue system with progress per account
