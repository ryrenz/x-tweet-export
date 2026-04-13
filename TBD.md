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
