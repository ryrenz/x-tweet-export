// x-tweet-export: MAIN world content script
// Hooks window.fetch to capture auth headers, GraphQL request templates, and userId.
// Also handles tweet fetching, parsing, export generation, and UI injection.

(function () {
  'use strict';

  // =========================================================================
  // State
  // =========================================================================
  const state = {
    auth: {
      authorization: null,
      csrfToken: null,
    },
    // Captured GraphQL request templates — queryId for each endpoint
    queryIdMap: {},       // { operationName: queryId }
    featuresMap: {},      // { operationName: featuresJSON }
    fieldTogglesMap: {},  // { operationName: fieldTogglesJSON }
    // Current profile info
    profile: {
      userId: null,
      screenName: null,
    },
    // Export state
    exporting: false,
    pauseRequested: false,
  };

  // Cancellable sleep — checks state.pauseRequested while waiting so a long
  // 429 backoff (up to ~240s) can be aborted within ~200ms of the user clicking Stop.
  function sleepCancellable(ms) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (state.pauseRequested) return resolve();
        const elapsed = Date.now() - start;
        if (elapsed >= ms) return resolve();
        setTimeout(tick, Math.min(200, ms - elapsed));
      };
      tick();
    });
  }

  // =========================================================================
  // Message helpers (MAIN world → ISOLATED world bridge)
  // =========================================================================
  function sendToBridge(type, payload) {
    window.postMessage({ source: 'x-tweet-export-main', type, payload }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'x-tweet-export-bridge') return;
    const { type, payload } = event.data;
    if (type === 'TRIGGER_EXPORT') {
      handleExportRequest(payload);
    }
  });

  // =========================================================================
  // Fetch hook — capture auth headers + request templates + userId
  // =========================================================================
  const originalFetch = window.fetch;

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));

    if (url.includes('/i/api/graphql/') || url.includes('/i/api/1.1/')) {
      // Extract headers from both init.headers and Request.headers
      const initHeaders = extractHeaders(init);
      const reqHeaders = (input instanceof Request) ? extractHeaders({ headers: input.headers }) : null;
      const headers = Object.assign({}, reqHeaders || {}, initHeaders || {});
      if (headers.authorization) state.auth.authorization = headers.authorization;
      if (headers['x-csrf-token']) state.auth.csrfToken = headers['x-csrf-token'];

      // Capture queryId/features/fieldToggles for ALL GraphQL endpoints
      if (url.includes('/i/api/graphql/')) {
        captureGraphQLTemplate(url);
      }
    }

    const response = await originalFetch.apply(this, arguments);

    // Extract userId from profile-related responses
    if (url.includes('/UserByScreenName') || url.includes('/UserTweets')) {
      try {
        const cloned = response.clone();
        const json = await cloned.json();
        extractUserIdFromResponse(json, url);
      } catch (e) {
        // ignore
      }
    }

    return response;
  };

  // =========================================================================
  // XHR hook — fallback to capture bearer from XMLHttpRequest
  // =========================================================================
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._xteUrl = url;
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._xteUrl && (this._xteUrl.includes('/i/api/graphql/') || this._xteUrl.includes('/i/api/1.1/'))) {
      const lower = name.toLowerCase();
      if (lower === 'authorization' && value) state.auth.authorization = value;
      if (lower === 'x-csrf-token' && value) state.auth.csrfToken = value;
    }
    return originalXHRSetHeader.apply(this, arguments);
  };

  // =========================================================================
  // Header / template extraction helpers
  // =========================================================================
  function extractHeaders(init) {
    if (!init || !init.headers) return null;
    if (init.headers instanceof Headers) {
      const obj = {};
      init.headers.forEach((v, k) => { obj[k.toLowerCase()] = v; });
      return obj;
    }
    if (typeof init.headers === 'object') {
      const obj = {};
      for (const [k, v] of Object.entries(init.headers)) {
        obj[k.toLowerCase()] = v;
      }
      return obj;
    }
    return null;
  }

  function captureGraphQLTemplate(url) {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/');
      const graphqlIdx = pathParts.indexOf('graphql');
      if (graphqlIdx < 0) return;

      const queryId = pathParts[graphqlIdx + 1];
      // Operation name is the last path segment (before query string)
      const opName = pathParts[graphqlIdx + 2];
      if (!queryId || !opName) return;

      state.queryIdMap[opName] = queryId;

      const features = urlObj.searchParams.get('features');
      if (features) state.featuresMap[opName] = features;

      const fieldToggles = urlObj.searchParams.get('fieldToggles');
      if (fieldToggles) state.fieldTogglesMap[opName] = fieldToggles;
    } catch (e) {
      // ignore
    }
  }

  function extractUserIdFromResponse(json, url) {
    try {
      if (url.includes('/UserByScreenName')) {
        const userResult = json?.data?.user?.result;
        if (userResult) {
          const userId = userResult.rest_id || userResult.id;
          if (userId) {
            state.profile.userId = userId;
          }
        }
      } else if (url.includes('/UserTweets') && !state.profile.userId) {
        const instructions = json?.data?.user?.result?.timeline_v2?.timeline?.instructions;
        if (instructions) {
          for (const inst of instructions) {
            for (const entry of (inst.entries || [])) {
              const result = entry?.content?.itemContent?.tweet_results?.result;
              if (result?.core?.user_results?.result?.rest_id) {
                state.profile.userId = result.core.user_results.result.rest_id;
                return;
              }
            }
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // =========================================================================
  // Fallback auth & template discovery
  // =========================================================================

  // csrf is always readable from the ct0 cookie
  function getCsrfFromCookie() {
    const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return match ? match[1] : null;
  }

  // Scan performance resource entries for GraphQL URLs we missed
  function discoverFromPerformanceEntries() {
    try {
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        if (entry.name.includes('/i/api/graphql/')) {
          captureGraphQLTemplate(entry.name);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // Collect all candidate JS bundle URLs from the page
  function getScriptBundleUrls() {
    var scripts = document.querySelectorAll('script[src]');
    var candidates = [];
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src;
      if (src.includes('/client-web') || src.includes('/responsive-web') || src.includes('abs.twimg.com')) {
        candidates.push(src);
      }
    }
    if (candidates.length === 0) {
      for (var j = 0; j < scripts.length; j++) {
        if (scripts[j].src.includes('.js')) {
          candidates.push(scripts[j].src);
        }
      }
    }
    return candidates;
  }

  // Cache fetched bundle text to avoid re-fetching
  var bundleTextCache = {};

  async function fetchBundleText(src) {
    if (bundleTextCache[src] !== undefined) return bundleTextCache[src];
    try {
      var resp = await originalFetch(src, { credentials: 'omit' });
      var text = await resp.text();
      bundleTextCache[src] = text;
      return text;
    } catch (e) {
      bundleTextCache[src] = null;
      return null;
    }
  }

  // Scan loaded JS bundles for the bearer token
  async function discoverBearerFromScripts() {
    if (state.auth.authorization) return;

    var candidates = getScriptBundleUrls();

    for (var i = 0; i < Math.min(candidates.length, 8); i++) {
      var text = await fetchBundleText(candidates[i]);
      if (!text) continue;
      var match = text.match(/"(AAAA[A-Za-z0-9%+\/=]{30,})"/);
      if (match) {
        state.auth.authorization = 'Bearer ' + match[1];
        return;
      }
    }
  }

  // Scan loaded JS bundles for GraphQL queryId + operationName mappings
  async function discoverQueryIdsFromBundles() {
    if (state.queryIdMap['UserTweets']) return;

    var candidates = getScriptBundleUrls();

    for (var i = 0; i < Math.min(candidates.length, 12); i++) {
      var text = await fetchBundleText(candidates[i]);
      if (!text) continue;

      // Pattern: {queryId:"...",operationName:"..."} (X webpack chunk format)
      var re1 = /queryId\s*:\s*"([^"]+)"\s*,\s*operationName\s*:\s*"([^"]+)"/g;
      var m;
      while ((m = re1.exec(text)) !== null) {
        state.queryIdMap[m[2]] = m[1];
      }

      // Reverse: operationName first, then queryId
      var re2 = /operationName\s*:\s*"([^"]+)"[^}]{0,200}queryId\s*:\s*"([^"]+)"/g;
      while ((m = re2.exec(text)) !== null) {
        if (!state.queryIdMap[m[1]]) {
          state.queryIdMap[m[1]] = m[2];
        }
      }

      if (state.queryIdMap['UserTweets']) return;
    }
  }

  // Actively fetch userId via UserByScreenName if we have auth + queryId for it
  async function discoverUserId(screenName) {
    if (state.profile.userId) return;
    if (!state.auth.authorization || !state.auth.csrfToken) return;

    const queryId = state.queryIdMap['UserByScreenName'];
    if (!queryId) return;
    // Prefer captured features from a live request; fall back to defaults for this endpoint
    const features = state.featuresMap['UserByScreenName'] || DEFAULT_USER_FEATURES;

    const variables = JSON.stringify({
      screen_name: screenName,
      withSafetyModeUserFields: true,
    });

    const params = new URLSearchParams();
    params.set('variables', variables);
    params.set('features', features);

    const apiUrl = 'https://x.com/i/api/graphql/' + queryId + '/UserByScreenName?' + params.toString();

    try {
      const resp = await originalFetch(apiUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'authorization': state.auth.authorization,
          'x-csrf-token': state.auth.csrfToken,
          'x-twitter-active-user': 'yes',
          'content-type': 'application/json',
        },
      });
      if (resp.ok) {
        const json = await resp.json();
        extractUserIdFromResponse(json, '/UserByScreenName');
      }
    } catch (e) {
      // ignore
    }
  }

  // Combined: try all fallbacks before giving up
  async function ensureReady() {
    // 1. csrf from cookie
    if (!state.auth.csrfToken) {
      state.auth.csrfToken = getCsrfFromCookie();
    }

    // 2. Scan performance entries for queryIds we missed
    discoverFromPerformanceEntries();

    // 3. Try to find bearer from JS bundles if still missing
    if (!state.auth.authorization) {
      await discoverBearerFromScripts();
    }

    // 4. Scan JS bundles for queryId mappings (UserTweets, UserByScreenName, etc.)
    if (!state.queryIdMap['UserTweets']) {
      await discoverQueryIdsFromBundles();
    }

    // 5. Try to get userId if we have auth
    if (!state.profile.userId && state.profile.screenName && isAuthReady()) {
      await discoverUserId(state.profile.screenName);
    }
  }

  // =========================================================================
  // Auth readiness check
  // =========================================================================
  function isAuthReady() {
    return !!(state.auth.authorization && state.auth.csrfToken);
  }

  function hasUserTweetsTemplate() {
    return !!state.queryIdMap['UserTweets'];
  }

  // =========================================================================
  // Default features / fieldToggles for UserTweets when not captured from a live request
  // =========================================================================
  const DEFAULT_FEATURES = JSON.stringify({
    "rweb_tipjar_consumption_enabled": true,
    "responsive_web_graphql_exclude_directive_enabled": true,
    "verified_phone_label_enabled": false,
    "creator_subscriptions_tweet_preview_api_enabled": true,
    "responsive_web_graphql_timeline_navigation_enabled": true,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
    "communities_web_enable_tweet_community_results_fetch": true,
    "c9s_tweet_anatomy_moderator_badge_enabled": true,
    "articles_preview_enabled": true,
    "responsive_web_edit_tweet_api_enabled": true,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": true,
    "view_counts_everywhere_api_enabled": true,
    "longform_notetweets_consumption_enabled": true,
    "responsive_web_twitter_article_tweet_consumption_enabled": true,
    "tweet_awards_web_tipping_enabled": false,
    "creator_subscriptions_quote_tweet_preview_enabled": false,
    "freedom_of_speech_not_reach_fetch_enabled": true,
    "standardized_nudges_misinfo": true,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": true,
    "rweb_video_timestamps_enabled": true,
    "longform_notetweets_rich_text_read_enabled": true,
    "longform_notetweets_inline_media_enabled": true,
    "responsive_web_enhance_cards_enabled": false
  });
  const DEFAULT_FIELD_TOGGLES = JSON.stringify({
    "withArticlePlainText": false
  });

  // UserByScreenName endpoint has a different features contract
  const DEFAULT_USER_FEATURES = JSON.stringify({
    "hidden_profile_likes_enabled": true,
    "hidden_profile_subscriptions_enabled": true,
    "responsive_web_graphql_exclude_directive_enabled": true,
    "verified_phone_label_enabled": false,
    "subscriptions_verification_info_is_identity_verified_enabled": true,
    "subscriptions_verification_info_verified_since_enabled": true,
    "highlights_tweets_tab_ui_enabled": true,
    "responsive_web_twitter_article_notes_tab_enabled": true,
    "creator_subscriptions_tweet_preview_api_enabled": true,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
    "responsive_web_graphql_timeline_navigation_enabled": true
  });

  // =========================================================================
  // UserTweets fetching with cursor pagination + adaptive rate limiting
  // =========================================================================
  const TWEETS_PER_PAGE = 20;
  const DEFAULT_MAX_TWEETS = 100;
  // Our safety cap for rate-limit exposure. X's own historical ceiling is ~3200 tweets
  // (cursor returns empty after that), so 3000 leaves a small buffer below the real wall.
  // At this size a single run is almost guaranteed to hit 429 once or twice — recovery
  // relies on progress persistence + resume to finish across multiple sessions.
  const HARD_MAX_TWEETS = 3000;

  // Adaptive delay bounds (ms). Actual delay derived from x-rate-limit-remaining ratio:
  //   < 20% → MAX, > 50% → MIN, otherwise → MID. Falls back to MID when headers absent.
  const MIN_FETCH_DELAY_MS = 2000;
  const MID_FETCH_DELAY_MS = 4000;
  const MAX_FETCH_DELAY_MS = 8000;

  // Exponential backoff schedule for 429 (with ±20% jitter)
  const RATE_LIMIT_BACKOFF_MS = [30000, 60000, 120000, 240000];
  const MAX_RATE_LIMIT_RETRIES = RATE_LIMIT_BACKOFF_MS.length;

  // Progress persistence — saved per userId, expires after 30 min
  const PROGRESS_RESUME_TTL_MS = 30 * 60 * 1000;
  const PROGRESS_KEY_PREFIX = 'progress:';

  function computeAdaptiveDelay(remaining, limit) {
    if (!remaining || !limit || limit <= 0) return MID_FETCH_DELAY_MS;
    const ratio = remaining / limit;
    if (ratio < 0.2) return MAX_FETCH_DELAY_MS;
    if (ratio > 0.5) return MIN_FETCH_DELAY_MS;
    return MID_FETCH_DELAY_MS;
  }

  function computeBackoffDelay(retryIdx) {
    const base = RATE_LIMIT_BACKOFF_MS[Math.min(retryIdx, RATE_LIMIT_BACKOFF_MS.length - 1)];
    const jitter = Math.floor(Math.random() * (base * 0.2));
    return base + jitter;
  }

  // =========================================================================
  // Storage bridge — chrome.storage.local lives in the isolated world,
  // so we relay through bridge.js with a request/response message id pairing.
  // Random ids prevent a co-resident page script from spoofing replies by
  // guessing a sequential counter.
  // =========================================================================
  const storagePending = new Map();

  function newMsgId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  }

  function callStorage(op, key, value) {
    return new Promise((resolve, reject) => {
      const id = newMsgId();
      const timer = setTimeout(() => {
        if (storagePending.has(id)) {
          storagePending.delete(id);
          reject(new Error('STORAGE_TIMEOUT'));
        }
      }, 15000);
      storagePending.set(id, { resolve, reject, timer });
      sendToBridge('STORAGE_REQUEST', { id, op, key, value });
    });
  }

  const storageGet = (key) => callStorage('get', key, null);
  const storageSet = (key, value) => callStorage('set', key, value);
  const storageDelete = (key) => callStorage('delete', key, null);

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'x-tweet-export-bridge') return;
    if (event.data.type !== 'STORAGE_RESULT') return;
    const { id, value, error } = event.data.payload || {};
    const pending = storagePending.get(id);
    if (!pending) return;
    storagePending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(error));
    else pending.resolve(value);
  });

  // Validate a stored snapshot's shape before trusting it on resume.
  // A malformed entry (manual storage write, schema drift, etc.) returns null
  // so we fall through to a fresh export instead of crashing fetchAllTweets.
  function isValidProgressSnapshot(data) {
    if (!data || typeof data !== 'object') return false;
    if (typeof data.timestamp !== 'number') return false;
    if (!Array.isArray(data.tweets)) return false;
    if (!Array.isArray(data.seenTweetIds)) return false;
    if (!Array.isArray(data.seenCursors)) return false;
    if (data.cursor != null && typeof data.cursor !== 'string') return false;
    if (data.minViews != null && typeof data.minViews !== 'number') return false;
    return true;
  }

  async function loadProgress(userId) {
    try {
      const data = await storageGet(PROGRESS_KEY_PREFIX + userId);
      if (!isValidProgressSnapshot(data)) {
        if (data) {
          // Drop malformed entry so it doesn't keep failing validation
          storageDelete(PROGRESS_KEY_PREFIX + userId).catch(() => {});
        }
        return null;
      }
      if (Date.now() - data.timestamp > PROGRESS_RESUME_TTL_MS) {
        storageDelete(PROGRESS_KEY_PREFIX + userId).catch(() => {});
        return null;
      }
      return data;
    } catch (e) {
      return null;
    }
  }

  // Fire-and-forget — chrome.storage.local serializes writes internally, so
  // back-to-back saves (one per page) are safe to enqueue without awaiting.
  // Awaiting here would stall the pagination critical path by an extra
  // postMessage round-trip + write latency on every page.
  function saveProgress(userId, snapshot) {
    storageSet(PROGRESS_KEY_PREFIX + userId, snapshot).catch(() => {});
  }

  function clearProgress(userId) {
    return storageDelete(PROGRESS_KEY_PREFIX + userId).catch(() => {});
  }

  async function fetchAllTweets(userId, onProgress, maxTweets, options) {
    options = options || {};
    var limit = Math.min(maxTweets || DEFAULT_MAX_TWEETS, HARD_MAX_TWEETS);
    var minViews = options.minViews && options.minViews > 0 ? options.minViews : 0;
    var rateLimitRetries = 0;
    var giveUpFromRateLimit = false;
    var timelineExhausted = false;
    var userPaused = false;
    if (!isAuthReady()) {
      throw new Error('AUTH_NOT_READY');
    }
    if (!hasUserTweetsTemplate()) {
      throw new Error('TEMPLATE_NOT_READY');
    }

    const queryId = state.queryIdMap['UserTweets'];
    // Resume snapshots may have been collected under a different (or no) views filter.
    // Re-apply the current minViews to keep the final output consistent with what the
    // user selected this run, instead of leaking stale low-views tweets from earlier runs.
    const rawResume = Array.isArray(options.resumeTweets) ? options.resumeTweets : [];
    const allTweets = minViews > 0
      ? rawResume.filter((t) => (t && t.views ? t.views : 0) >= minViews).slice()
      : rawResume.slice();
    const seenCursors = new Set(Array.isArray(options.resumeSeenCursors) ? options.resumeSeenCursors : []);
    // Fall back to deriving ids from resumeTweets when the snapshot's id list is missing OR empty
    // (an empty array would otherwise short-circuit the `||` and break dedup on resume).
    const resumeIds = Array.isArray(options.resumeSeenTweetIds) && options.resumeSeenTweetIds.length > 0
      ? options.resumeSeenTweetIds
      : allTweets.map((t) => t.id);
    const seenTweetIds = new Set(resumeIds);
    let cursor = options.resumeCursor || null;
    // Seed the resume cursor into seenCursors so that if X echoes it back as the
    // next-page pointer (timeline-ceiling case), we break on the very first page
    // instead of wasting a second request to detect the loop.
    if (cursor) seenCursors.add(cursor);
    let pageCount = 0;
    let nextDelay = MID_FETCH_DELAY_MS;
    let lastRlInfo = '';

    while (true) {
      // User-requested abort — bail out before issuing the next request, return
      // whatever was collected so far. Caller treats this like a partial result
      // (snapshot kept so the user can resume later).
      // Note: a request already in flight when the user clicks Stop will still be
      // awaited, parsed, and saved — we abort before issuing the *next* request,
      // not the current one. This means the user gets up to one extra page (~20
      // tweets) after clicking Stop. Deliberate: discarding an already-paid-for
      // page would waste a GraphQL request that already counted against the
      // rate-limit window.
      if (state.pauseRequested) {
        userPaused = true;
        break;
      }

      const variables = {
        userId: userId,
        count: TWEETS_PER_PAGE,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: false,
        withVoice: true,
        withV2Timeline: true,
      };
      if (cursor) {
        variables.cursor = cursor;
      }

      const params = new URLSearchParams();
      params.set('variables', JSON.stringify(variables));
      params.set('features', state.featuresMap['UserTweets'] || DEFAULT_FEATURES);
      params.set('fieldToggles', state.fieldTogglesMap['UserTweets'] || DEFAULT_FIELD_TOGGLES);

      const apiUrl = 'https://x.com/i/api/graphql/' + queryId + '/UserTweets?' + params.toString();

      let response;
      try {
        response = await originalFetch(apiUrl, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'authorization': state.auth.authorization,
            'x-csrf-token': state.auth.csrfToken,
            'x-twitter-active-user': 'yes',
            'x-twitter-client-language': 'en',
            'content-type': 'application/json',
          },
        });
      } catch (e) {
        throw new Error('NETWORK_ERROR');
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error('AUTH_EXPIRED');
      }
      if (response.status === 429) {
        if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
          giveUpFromRateLimit = true;
          if (allTweets.length > 0) break;
          throw new Error('RATE_LIMITED');
        }
        const wait = computeBackoffDelay(rateLimitRetries);
        rateLimitRetries++;
        if (onProgress) {
          // Short form to fit the button width — full retry info is logged via title attr
          onProgress(allTweets.length, pageCount, 'Wait ' + Math.round(wait / 1000) + 's');
        }
        await sleepCancellable(wait);
        continue;
      }
      if (!response.ok) {
        throw new Error('HTTP_' + response.status);
      }

      // Read rate-limit headers for next adaptive delay
      const rlRemaining = parseInt(response.headers.get('x-rate-limit-remaining') || '0', 10);
      const rlLimit = parseInt(response.headers.get('x-rate-limit-limit') || '0', 10);
      nextDelay = computeAdaptiveDelay(rlRemaining, rlLimit);
      lastRlInfo = rlLimit ? (' [' + rlRemaining + '/' + rlLimit + ']') : '';

      // Reset retry counter on a successful page
      rateLimitRetries = 0;

      let json;
      try {
        json = await response.json();
      } catch (e) {
        throw new Error('PARSE_ERROR');
      }

      const { tweets, nextCursor } = parseTweetsFromResponse(json);

      let newCount = 0;       // newly-matched tweets pushed to allTweets this page
      let newScanned = 0;     // newly-seen tweets this page (pre-filter), for scan-depth metric
      for (const tweet of tweets) {
        if (!seenTweetIds.has(tweet.id)) {
          seenTweetIds.add(tweet.id);
          newScanned++;
          // Apply min-views filter — non-matching tweets are dedup-tracked but not collected
          if (minViews === 0 || (tweet.views || 0) >= minViews) {
            allTweets.push(tweet);
            newCount++;
          }
        }
      }

      pageCount++;
      if (onProgress) {
        onProgress(allTweets.length, pageCount, null, lastRlInfo, seenTweetIds.size);
      }

      // Terminal-condition signals:
      //   - !nextCursor or cursor cycle → X has no more pages
      //   - newScanned === 0 on a non-first page → loop / dead-end (use scanned not collected,
      //     otherwise filtering would falsely trip this when no matches happen on a page)
      //   - allTweets.length >= limit → quota filled
      const cursorExhausted = !nextCursor || seenCursors.has(nextCursor);
      const noProgress = newScanned === 0 && pageCount > 1;
      const quotaFilled = limit > 0 && allTweets.length >= limit;
      if (cursorExhausted || noProgress) {
        timelineExhausted = !quotaFilled; // only mark exhausted if we stopped short of quota
      }
      const willStop = cursorExhausted || noProgress || quotaFilled;

      // Persist progress only when there's actually more work to resume.
      // Fire-and-forget: storage writes serialize internally; awaiting here
      // would stall pagination by a postMessage RTT + write latency per page.
      if (!willStop && typeof options.onPageDone === 'function') {
        options.onPageDone({
          tweets: allTweets,
          cursor: nextCursor,
          seenTweetIds: Array.from(seenTweetIds),
          // Include nextCursor in the saved seen-set so resume's loop guard
          // matches a fresh run's behavior on the next iteration.
          seenCursors: Array.from(seenCursors).concat([nextCursor]),
        });
      }

      if (willStop) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;

      await sleepCancellable(nextDelay);
    }

    if (limit > 0 && allTweets.length > limit) {
      allTweets.length = limit;
    }
    return {
      tweets: allTweets,
      partial: giveUpFromRateLimit,
      exhausted: timelineExhausted,
      paused: userPaused,
      scanned: seenTweetIds.size,
    };
  }

  function parseTweetsFromResponse(json) {
    const tweets = [];
    let nextCursor = null;

    try {
      // Try multiple response paths — X changes these periodically
      var userResult = json?.data?.user?.result;
      // Handle UserUnavailable
      if (userResult?.__typename === 'UserUnavailable') {
        return { tweets: [], nextCursor: null };
      }
      var timeline = userResult?.timeline_v2?.timeline
        || userResult?.timeline?.timeline;
      var instructions = timeline?.instructions || [];

      for (var ii = 0; ii < instructions.length; ii++) {
        var instruction = instructions[ii];
        var entries = instruction.entries || [];

        // Handle both TimelineAddEntries and TimelineReplaceEntry
        if (instruction.type === 'TimelineAddEntries' || entries.length > 0) {
          for (var ei = 0; ei < entries.length; ei++) {
            var entry = entries[ei];
            var entryId = entry.entryId || '';

            // Cursor entries (bottom cursor for next page)
            if (entryId.startsWith('cursor-bottom-')) {
              nextCursor = entry.content?.value;
              continue;
            }

            // Standard tweet entry
            var tweetResult = entry?.content?.itemContent?.tweet_results?.result;
            if (tweetResult) {
              var parsed = parseSingleTweet(tweetResult);
              if (parsed) tweets.push(parsed);
              continue;
            }

            // Module entries (e.g., conversation threads wrapped in TimelineModule)
            var items = entry?.content?.items;
            if (items) {
              for (var mi = 0; mi < items.length; mi++) {
                var moduleResult = items[mi]?.item?.itemContent?.tweet_results?.result;
                if (moduleResult) {
                  var moduleParsed = parseSingleTweet(moduleResult);
                  if (moduleParsed) tweets.push(moduleParsed);
                }
              }
            }
          }
        }
      }
    } catch (e) {
      // ignore
    }

    return { tweets, nextCursor };
  }

  // Extract direct media URLs from a tweet's legacy payload.
  // Photos: pbs.twimg.com/media/<id>.jpg with `?name=orig` for original resolution.
  // Videos / GIFs: highest-bitrate mp4 variant under video_info.variants.
  // Both URL forms are paste-into-browser playable and accepted by curl/wget/yt-dlp.
  // For X video specifically, the tweet's own URL is the most stable input for yt-dlp,
  // since direct mp4 links carry signed `?tag=` params that may expire.
  function extractMedia(legacy) {
    if (!legacy) return [];
    // `[] || x` returns `[]` because empty arrays are truthy in JS — so a tweet
    // with `extended_entities.media = []` would silently shadow `entities.media`.
    // Pick the first non-empty source explicitly.
    const ext = legacy.extended_entities && legacy.extended_entities.media;
    const ent = legacy.entities && legacy.entities.media;
    const list = (ext && ext.length ? ext : null)
      || (ent && ent.length ? ent : null)
      || [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m) continue;
      if (m.type === 'video' || m.type === 'animated_gif') {
        const variants = (m.video_info && m.video_info.variants) || [];
        let best = null;
        for (let j = 0; j < variants.length; j++) {
          const v = variants[j];
          if (!v || v.content_type !== 'video/mp4' || !v.url) continue;
          if (!best || (v.bitrate || 0) > (best.bitrate || 0)) best = v;
        }
        // Leave url empty when no mp4 variant exists (e.g. m3u8-only embeds) —
        // returning the still-frame URL while tagged 'video' would mislead consumers.
        // Users can still resolve the video via the tweet's own URL column.
        out.push({
          type: m.type === 'animated_gif' ? 'gif' : 'video',
          url: best ? best.url : '',
        });
      } else {
        // photo (or unknown type — fall back to the still URL).
        // Preserve any existing query string instead of clobbering it — defensive
        // against future X CDN format changes.
        const base = m.media_url_https || '';
        const sep = base.indexOf('?') >= 0 ? '&' : '?';
        out.push({
          type: 'photo',
          url: base ? base + sep + 'name=orig' : '',
        });
      }
    }
    return out;
  }

  function parseSingleTweet(tweetResult) {
    try {
      if (tweetResult.__typename === 'TweetTombstone') return null;

      const tweet = tweetResult.__typename === 'TweetWithVisibilityResults'
        ? tweetResult.tweet
        : tweetResult;

      if (!tweet || !tweet.legacy) return null;

      const legacy = tweet.legacy;
      const core = tweet.core?.user_results?.result;

      // Skip retweets
      if (legacy.retweeted_status_result) return null;

      // Skip replies to others (keep self-replies / threads)
      const authorScreenName = core?.legacy?.screen_name;
      if (legacy.in_reply_to_screen_name && legacy.in_reply_to_screen_name !== authorScreenName) {
        return null;
      }

      const views = tweet.views?.count;

      return {
        id: legacy.id_str || tweet.rest_id,
        date: legacy.created_at,
        text: legacy.full_text || '',
        likes: legacy.favorite_count || 0,
        retweets: legacy.retweet_count || 0,
        replies: legacy.reply_count || 0,
        views: views ? parseInt(views, 10) : 0,
        bookmarks: legacy.bookmark_count || 0,
        media: extractMedia(legacy),
        url: authorScreenName
          ? 'https://x.com/' + authorScreenName + '/status/' + (legacy.id_str || tweet.rest_id)
          : '',
      };
    } catch (e) {
      return null;
    }
  }

  // =========================================================================
  // CSV / JSON generation
  // =========================================================================
  function generateCSV(tweets) {
    // Append media columns AFTER `url` so existing column indices (1–8) stay stable
    // for any scripts parsing prior exports.
    const headers = ['date', 'text', 'likes', 'retweets', 'replies', 'views', 'bookmarks', 'url', 'media_count', 'media_urls'];
    const rows = [headers.join(',')];

    for (const t of tweets) {
      const media = Array.isArray(t.media) ? t.media : [];
      // Pipe-separated to avoid clashing with CSV commas. Each URL is a direct link
      // (pbs.twimg.com for photos, video.twimg.com mp4 for video/gif) — paste-into-browser
      // and curl/wget/yt-dlp friendly. For videos, the tweet's `url` column is the most
      // stable input for yt-dlp since direct mp4 links carry signed params that may expire.
      const mediaUrls = media.map((m) => m && m.url ? m.url : '').filter(Boolean).join('|');
      const row = [
        csvEscape(formatDate(t.date)),
        csvEscape(t.text),
        t.likes,
        t.retweets,
        t.replies,
        t.views,
        t.bookmarks,
        csvEscape(t.url),
        media.length,
        csvEscape(mediaUrls),
      ];
      rows.push(row.join(','));
    }

    return '\uFEFF' + rows.join('\n');
  }

  function csvEscape(value) {
    if (value == null) return '""';
    const str = String(value);
    return '"' + str.replace(/"/g, '""') + '"';
  }

  function formatDate(dateStr) {
    try {
      const d = new Date(dateStr);
      return d.toISOString().slice(0, 19).replace('T', ' ');
    } catch (e) {
      return dateStr || '';
    }
  }

  function generateJSON(tweets) {
    const cleaned = tweets.map(t => ({
      id: t.id,
      date: formatDate(t.date),
      text: t.text,
      likes: t.likes,
      retweets: t.retweets,
      replies: t.replies,
      views: t.views,
      bookmarks: t.bookmarks,
      media: Array.isArray(t.media) ? t.media : [],
      url: t.url,
    }));
    return JSON.stringify(cleaned, null, 2);
  }

  // =========================================================================
  // Export orchestration
  // =========================================================================
  async function handleExportRequest(payload) {
    if (state.exporting) return;

    const format = (payload && payload.format) || 'csv';
    const maxTweets = (payload && payload.maxTweets) || DEFAULT_MAX_TWEETS;
    const minViews = (payload && payload.minViews) || 0;
    const resume = payload && payload.resume;

    // Try all fallbacks before checking readiness
    updateButtonState('progress', 'Preparing...');
    await ensureReady();

    if (!isAuthReady()) {
      sendToBridge('EXPORT_ERROR', { error: 'NOT_READY' });
      return;
    }
    if (!hasUserTweetsTemplate()) {
      sendToBridge('EXPORT_ERROR', { error: 'TEMPLATE_NOT_READY' });
      return;
    }

    const userId = state.profile.userId;
    if (!userId) {
      sendToBridge('EXPORT_ERROR', { error: 'NO_USER_ID' });
      return;
    }
    // Capture screenName locally so a profile switch mid-export doesn't poison
    // the saved snapshot's tag or the final download filename.
    const screenName = state.profile.screenName || 'unknown';

    state.exporting = true;
    state.pauseRequested = false;
    sendToBridge('EXPORT_STARTED', {});

    const fetchOptions = {
      minViews: minViews,
      onPageDone: (snapshot) => {
        saveProgress(userId, {
          screenName: screenName,
          format: format,
          maxTweets: maxTweets,
          minViews: minViews,
          tweets: snapshot.tweets,
          cursor: snapshot.cursor,
          seenTweetIds: snapshot.seenTweetIds,
          seenCursors: snapshot.seenCursors,
          timestamp: Date.now(),
        });
      },
    };

    if (resume && resume.tweets) {
      fetchOptions.resumeTweets = resume.tweets;
      fetchOptions.resumeCursor = resume.cursor;
      fetchOptions.resumeSeenTweetIds = resume.seenTweetIds;
      fetchOptions.resumeSeenCursors = resume.seenCursors;
    }

    try {
      const result = await fetchAllTweets(userId, (count, pages, statusMsg, rlInfo, scanned) => {
        sendToBridge('EXPORT_PROGRESS', { count, pages, statusMsg, rlInfo, scanned, quota: maxTweets });
      }, maxTweets, fetchOptions);
      const tweets = result.tweets;
      const isPartial = result.partial;
      const isExhausted = result.exhausted;
      const isPaused = result.paused;
      const scannedTotal = result.scanned;

      if (tweets.length === 0) {
        await clearProgress(userId);
        sendToBridge('EXPORT_ERROR', { error: isPaused ? 'PAUSED_EMPTY' : 'NO_TWEETS' });
        state.exporting = false;
        return;
      }

      // Keep saved progress when the run was incomplete (rate-limited or user-paused),
      // so the user can resume. Clear it on a clean finish (or on exhausted, since
      // there's nothing more to fetch).
      if (!isPartial && !isPaused) {
        await clearProgress(userId);
      }

      let content, mimeType, ext;
      if (format === 'json') {
        content = generateJSON(tweets);
        mimeType = 'application/json';
        ext = 'json';
      } else {
        content = generateCSV(tweets);
        mimeType = 'text/csv;charset=utf-8';
        ext = 'csv';
      }

      const blob = new Blob([content], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);
      const tag = isPaused ? '_paused' : (isPartial ? '_partial' : (isExhausted ? '_exhausted' : ''));
      const filename = '@' + screenName + '_tweets' + tag + '_' + dateStr + '.' + ext;

      sendToBridge('EXPORT_DOWNLOAD', {
        url: blobUrl,
        filename: filename,
        tweetCount: tweets.length,
        partial: isPartial,
        exhausted: isExhausted,
        paused: isPaused,
        scanned: scannedTotal,
        minViews: minViews,
      });

      // Revoke Blob URL after a delay to allow download to start
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (e) {
      sendToBridge('EXPORT_ERROR', { error: e.message || 'UNKNOWN' });
    } finally {
      state.exporting = false;
    }
  }

  // =========================================================================
  // UI: Export button injection & SPA navigation handling
  // =========================================================================
  const BUTTON_ID = 'x-tweet-export-btn';
  const CONTAINER_ID = 'x-tweet-export-container';

  // Min-views slider snap points. Linear 0-1M would make 1k-10k almost unreachable
  // (occupies ~1% of the slider width), so we expose a curated ladder instead —
  // index in [0, length-1] maps to a threshold below.
  const VIEW_THRESHOLDS = [
    0, 500, 1000, 2000, 5000, 10000,
    25000, 50000, 100000, 250000, 500000, 1000000,
  ];

  function formatViewsLabel(n) {
    if (!n) return '';
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
    return String(n);
  }

  const PROFILE_SUB_ROUTES = new Set([
    '', 'with_replies', 'media', 'likes', 'highlights', 'articles',
  ]);
  const RESERVED_PATHS = new Set([
    'home', 'explore', 'search', 'notifications', 'messages',
    'settings', 'i', 'compose', 'lists', 'bookmarks', 'communities',
    'premium', 'jobs', 'flow', 'login', 'logout',
  ]);

  function getScreenNameFromURL() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length === 0 || parts.length > 2) return null;
    const name = parts[0];
    if (RESERVED_PATHS.has(name.toLowerCase())) return null;
    // If there's a second segment, it must be a known profile sub-route
    if (parts.length === 2 && !PROFILE_SUB_ROUTES.has(parts[1].toLowerCase())) return null;
    if (/^[A-Za-z0-9_]+$/.test(name)) return name;
    return null;
  }

  function isProfilePage() {
    return !!getScreenNameFromURL();
  }

  function makeSliderRow(labelText, id, min, max, step, defaultVal, formatValue) {
    const row = document.createElement('div');
    row.className = 'x-tweet-export-slider-row';

    const label = document.createElement('span');
    label.className = 'x-tweet-export-slider-label';
    label.textContent = labelText;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = id;
    slider.className = 'x-tweet-export-slider';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(defaultVal);

    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'x-tweet-export-slider-value';

    function refresh() {
      valueDisplay.textContent = formatValue(parseInt(slider.value, 10));
    }
    slider.addEventListener('input', refresh);
    refresh();

    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(valueDisplay);
    return { row, slider, refresh };
  }

  function createExportButton() {
    if (document.getElementById(CONTAINER_ID)) return;

    const container = document.createElement('div');
    container.id = CONTAINER_ID;

    // Count slider — 50 to 3000 tweets, step 50
    const countCtl = makeSliderRow(
      'Count',
      'x-tweet-export-count',
      50, 3000, 50, 100,
      (v) => v + ' tweets'
    );

    // Min-views slider — slider value is an INDEX into VIEW_THRESHOLDS, not the
    // raw views number. Lets us cover 0 → 1M with sane snap points instead of a
    // linear range where 1k-10k would be unreachably small (~1% of slider width).
    const minViewsCtl = makeSliderRow(
      'Min views',
      'x-tweet-export-min-views',
      0, VIEW_THRESHOLDS.length - 1, 1, 0,
      (idx) => {
        const v = VIEW_THRESHOLDS[idx] || 0;
        return v === 0 ? 'any' : '≥ ' + formatViewsLabel(v);
      }
    );

    // Format + Export button row
    const actionRow = document.createElement('div');
    actionRow.className = 'x-tweet-export-wrapper';

    const formatSelect = document.createElement('select');
    formatSelect.id = 'x-tweet-export-format';
    formatSelect.className = 'x-tweet-export-select';
    const csvOption = document.createElement('option');
    csvOption.value = 'csv';
    csvOption.textContent = 'CSV';
    const jsonOption = document.createElement('option');
    jsonOption.value = 'json';
    jsonOption.textContent = 'JSON';
    formatSelect.appendChild(csvOption);
    formatSelect.appendChild(jsonOption);

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.className = 'x-tweet-export-button';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'x-tweet-export-icon';
    iconSpan.textContent = '\u{1F4E5}';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'x-tweet-export-label';
    labelSpan.textContent = 'Export Tweets';
    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);

    actionRow.appendChild(formatSelect);
    actionRow.appendChild(btn);

    container.appendChild(countCtl.row);
    container.appendChild(minViewsCtl.row);
    container.appendChild(actionRow);

    // Warning shown when count or filtering raises rate-limit / completion risk
    const warning = document.createElement('div');
    warning.id = 'x-tweet-export-warning';
    warning.className = 'x-tweet-export-warning';
    warning.style.display = 'none';
    container.appendChild(warning);

    function refreshWarning() {
      const count = parseInt(countCtl.slider.value, 10);
      const idx = parseInt(minViewsCtl.slider.value, 10);
      const minViews = VIEW_THRESHOLDS[idx] || 0;
      if (minViews > 0) {
        // With filtering on, true scan depth is unbounded up to X's ~3200 ceiling
        warning.textContent = 'Filtering by views — may scan up to 3000 tweets to fill quota; result count may fall short if not enough match';
        warning.style.display = 'block';
      } else if (count > 1000) {
        warning.textContent = 'Very high count — likely needs multiple sessions; resume will pick up where it stops';
        warning.style.display = 'block';
      } else if (count > 200) {
        warning.textContent = 'High count — may take 5+ min, rate limit risk';
        warning.style.display = 'block';
      } else {
        warning.style.display = 'none';
      }
    }
    countCtl.slider.addEventListener('input', refreshWarning);
    minViewsCtl.slider.addEventListener('input', refreshWarning);
    refreshWarning();

    btn.addEventListener('click', async () => {
      // Mid-export click = pause request. fetchAllTweets polls state.pauseRequested
      // between pages and inside cancellable sleeps, then returns whatever it has
      // collected. No async work here — must respond instantly to the click.
      if (state.exporting) {
        if (state.pauseRequested) return; // already pausing
        state.pauseRequested = true;
        updateButtonState('progress', '⏹ Stopping…');
        return;
      }

      const format = formatSelect.value;
      const maxTweets = parseInt(countCtl.slider.value, 10);
      const minViewsIdx = parseInt(minViewsCtl.slider.value, 10);
      const minViews = VIEW_THRESHOLDS[minViewsIdx] || 0;
      const userId = state.profile.userId;

      // Check for resumable progress on this user before starting fresh
      let resume = null;
      if (userId) {
        const saved = await loadProgress(userId).catch(() => null);
        if (saved && Array.isArray(saved.tweets) && saved.tweets.length > 0) {
          const ageMin = Math.round((Date.now() - saved.timestamp) / 60000);
          const savedMinViews = typeof saved.minViews === 'number' ? saved.minViews : 0;
          const filterMismatch = savedMinViews !== minViews;
          let msg = 'Found unfinished export: ' + saved.tweets.length + ' tweets fetched ' + ageMin + ' min ago.\n';
          if (filterMismatch) {
            const savedLabel = savedMinViews ? formatViewsLabel(savedMinViews) : 'any';
            const currentLabel = minViews ? formatViewsLabel(minViews) : 'any';
            msg += '\nNote: saved snapshot used min-views = ' + savedLabel + ', current setting is ' + currentLabel + '.\n';
            if (minViews > savedMinViews) {
              // Tightening: re-filter narrows further — recoverable, just narrows.
              msg += 'Resuming will re-filter saved tweets with the stricter min-views and apply it to subsequent pages.\n';
            } else {
              // Loosening: previously-filtered-out tweets cannot be recovered (seenTweetIds blocks re-fetch).
              msg += 'WARNING: tweets that did not match the previous min-views (' + savedLabel + ') were not saved and CANNOT be recovered by resuming. New pages will use the looser filter, but historical low-views tweets are lost.\nIf you want all of them, click Cancel and start over.\n';
            }
          }
          msg += '\nOK = Resume from where it stopped\nCancel = Start over (discard saved progress)';
          if (window.confirm(msg)) {
            resume = saved;
          } else {
            await clearProgress(userId).catch(() => {});
          }
        }
      }

      sendToBridge('TRIGGER_EXPORT_FROM_UI', { format, maxTweets, minViews, resume });
    });

    injectButton(container);
  }

  function injectButton(container) {
    const tryInject = () => {
      // Target: right sidebar, above "What's happening"
      const sidebar = document.querySelector('[data-testid="sidebarColumn"]');
      if (sidebar) {
        // Try to find the "What's happening" or trend section
        var sections = sidebar.querySelectorAll('section');
        if (sections.length > 0) {
          var target = sections[0];
          if (!target.parentElement.querySelector('#' + CONTAINER_ID)) {
            target.parentElement.insertBefore(container, target);
            return true;
          }
        }
        // Fallback: insert at the top of the sidebar's scrollable area
        var scrollArea = sidebar.querySelector('div > div > div');
        if (scrollArea && !scrollArea.querySelector('#' + CONTAINER_ID)) {
          if (scrollArea.children.length > 1) {
            scrollArea.insertBefore(container, scrollArea.children[1]);
          } else {
            scrollArea.appendChild(container);
          }
          return true;
        }
      }

      return false;
    };

    if (!tryInject()) {
      let attempts = 0;
      const interval = setInterval(() => {
        if (tryInject() || ++attempts > 20) {
          clearInterval(interval);
        }
      }, 500);
    }
  }

  function updateButtonState(status, message) {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    const label = btn.querySelector('.x-tweet-export-label');
    if (!label) return;

    switch (status) {
      case 'ready':
        label.textContent = 'Export Tweets';
        btn.disabled = false;
        btn.title = '';
        btn.classList.remove('x-tweet-export-error', 'x-tweet-export-progress', 'x-tweet-export-done');
        break;
      case 'progress':
        // Once pauseRequested is set, lock the label to the Stopping message so
        // late-arriving progress events from the in-flight fetch don't overwrite it.
        // Otherwise, append a stop-hint glyph so the user knows the button stays clickable.
        var msg;
        if (state.pauseRequested) {
          msg = '⏹ Stopping…';
        } else {
          msg = message || 'Exporting...';
          if (msg.indexOf('⏹') === -1) msg += ' ⏹';
        }
        label.textContent = msg;
        btn.disabled = false;
        btn.title = state.pauseRequested ? 'Stopping…' : 'Click to stop and save what was fetched';
        btn.classList.add('x-tweet-export-progress');
        btn.classList.remove('x-tweet-export-error', 'x-tweet-export-done');
        break;
      case 'done':
        label.textContent = message || 'Done!';
        btn.disabled = false;
        btn.title = '';
        btn.classList.add('x-tweet-export-done');
        btn.classList.remove('x-tweet-export-error', 'x-tweet-export-progress');
        break;
      case 'error':
        label.textContent = message || 'Error';
        btn.disabled = false;
        btn.title = '';
        btn.classList.add('x-tweet-export-error');
        btn.classList.remove('x-tweet-export-progress', 'x-tweet-export-done');
        break;
    }
  }

  function removeExportButton() {
    const container = document.getElementById(CONTAINER_ID);
    if (container) container.remove();
  }

  // =========================================================================
  // SPA navigation detection
  // =========================================================================
  let lastUrl = window.location.href;
  let lastScreenName = null;

  function handleNavigation() {
    const currentUrl = window.location.href;
    if (currentUrl === lastUrl) return;
    lastUrl = currentUrl;

    const screenName = getScreenNameFromURL();

    if (isProfilePage()) {
      if (screenName !== lastScreenName) {
        state.profile.userId = null;
        state.profile.screenName = screenName;
        lastScreenName = screenName;
        removeExportButton();
        setTimeout(createExportButton, 1000);
      }
    } else {
      lastScreenName = null;
      removeExportButton();
    }
  }

  const originalPushState = history.pushState;
  history.pushState = function () {
    originalPushState.apply(this, arguments);
    setTimeout(handleNavigation, 100);
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function () {
    originalReplaceState.apply(this, arguments);
    setTimeout(handleNavigation, 100);
  };

  window.addEventListener('popstate', () => {
    setTimeout(handleNavigation, 100);
  });

  const navObserver = new MutationObserver(() => {
    handleNavigation();
  });

  // =========================================================================
  // Listen for export lifecycle messages (UI updates)
  // =========================================================================
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'x-tweet-export-main') return;

    const { type, payload } = event.data;

    switch (type) {
      case 'EXPORT_STARTED':
        updateButtonState('progress', 'Exporting...');
        break;
      case 'EXPORT_PROGRESS': {
        // Compact label: "23/100" so it fits the narrow sidebar button. Full context
        // (scanned depth, rate-limit headroom) lives in the hover tooltip instead.
        const compact = payload.statusMsg || (payload.count + '/' + (payload.quota || '?'));
        updateButtonState('progress', compact);

        // Tooltip carries the verbose info that no longer fits in the label
        const btn = document.getElementById(BUTTON_ID);
        if (btn && !state.pauseRequested) {
          let detail = 'Click to stop and save what was fetched';
          const parts = [];
          if (typeof payload.scanned === 'number' && payload.scanned > payload.count) {
            parts.push('scanned ' + payload.scanned);
          }
          if (payload.rlInfo) {
            // rlInfo looks like " [50/150]" — trim leading space + brackets for tooltip
            parts.push('rate ' + payload.rlInfo.replace(/^\s*\[|\]$/g, ''));
          }
          if (parts.length) detail += ' (' + parts.join(', ') + ')';
          btn.title = detail;
        }
        break;
      }
      case 'EXPORT_DOWNLOAD': {
        var doneMsg;
        if (payload.paused) {
          doneMsg = 'Stopped: ' + payload.tweetCount + ' tweets saved (resumable)';
        } else if (payload.partial) {
          doneMsg = 'Partial: ' + payload.tweetCount + ' tweets (rate limited)';
        } else if (payload.exhausted) {
          // Hit X's ~3200 timeline ceiling without filling the requested quota
          doneMsg = 'Done: ' + payload.tweetCount + ' tweets (timeline exhausted'
            + (payload.minViews > 0 ? ', scanned ' + payload.scanned : '')
            + ')';
        } else {
          doneMsg = 'Done! ' + payload.tweetCount + ' tweets exported';
        }
        updateButtonState('done', doneMsg);
        setTimeout(() => updateButtonState('ready'), 5000);
        break;
      }
      case 'EXPORT_ERROR': {
        const errorMessages = {
          NOT_READY: 'Auth not found \u2014 please refresh the page',
          NO_USER_ID: 'Could not resolve user ID \u2014 scroll timeline then retry',
          AUTH_NOT_READY: 'Auth not found \u2014 please refresh the page',
          TEMPLATE_NOT_READY: 'API template not captured \u2014 scroll timeline then retry',
          AUTH_EXPIRED: 'Auth expired \u2014 please refresh the page',
          RATE_LIMITED: 'Rate limited \u2014 please wait and try again',
          NETWORK_ERROR: 'Network error \u2014 check your connection',
          NO_TWEETS: 'No tweets found for this user',
          PARSE_ERROR: 'Failed to parse response',
          PAUSED_EMPTY: 'Stopped before any tweet was fetched',
        };
        const msg = errorMessages[payload.error] || ('Error: ' + payload.error);
        updateButtonState('error', msg);
        setTimeout(() => updateButtonState('ready'), 5000);
        break;
      }
    }
  });

  // =========================================================================
  // Initialization
  // =========================================================================
  function init() {
    const screenName = getScreenNameFromURL();
    if (screenName) {
      state.profile.screenName = screenName;
      lastScreenName = screenName;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(createExportButton, 1500));
      } else {
        setTimeout(createExportButton, 1500);
      }
    }

    if (document.body) {
      navObserver.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        navObserver.observe(document.body, { childList: true, subtree: true });
      });
    }
  }

  init();
})();
