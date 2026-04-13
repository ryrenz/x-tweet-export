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
  };

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
    // Only make active request if we have the real features for this endpoint
    const features = state.featuresMap['UserByScreenName'];
    if (!features) return;

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

  // =========================================================================
  // UserTweets fetching with cursor pagination
  // =========================================================================
  const FETCH_DELAY_MS = 3000;
  const TWEETS_PER_PAGE = 20;
  const DEFAULT_MAX_TWEETS = 100;
  const HARD_MAX_TWEETS = 200;  // absolute ceiling, never exceed
  const RATE_LIMIT_PAUSE_MS = 60000; // wait 60s on 429
  const MAX_RATE_LIMIT_RETRIES = 2;  // max 429 retries per export

  async function fetchAllTweets(userId, onProgress, maxTweets) {
    var limit = Math.min(maxTweets || DEFAULT_MAX_TWEETS, HARD_MAX_TWEETS);
    var rateLimitRetries = 0;
    if (!isAuthReady()) {
      throw new Error('AUTH_NOT_READY');
    }
    if (!hasUserTweetsTemplate()) {
      throw new Error('TEMPLATE_NOT_READY');
    }

    const queryId = state.queryIdMap['UserTweets'];
    const allTweets = [];
    const seenCursors = new Set();
    const seenTweetIds = new Set();
    let cursor = null;
    let pageCount = 0;

    while (true) {
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
        rateLimitRetries++;
        if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
          // Already retried enough — save what we have
          if (allTweets.length > 0) break;
          throw new Error('RATE_LIMITED');
        }
        // Pause and retry this page
        if (onProgress) {
          onProgress(allTweets.length, pageCount, 'Rate limited, waiting 60s...');
        }
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_PAUSE_MS));
        continue;
      }
      if (!response.ok) {
        throw new Error('HTTP_' + response.status);
      }

      let json;
      try {
        json = await response.json();
      } catch (e) {
        throw new Error('PARSE_ERROR');
      }

      const { tweets, nextCursor } = parseTweetsFromResponse(json);

      let newCount = 0;
      for (const tweet of tweets) {
        if (!seenTweetIds.has(tweet.id)) {
          seenTweetIds.add(tweet.id);
          allTweets.push(tweet);
          newCount++;
        }
      }

      pageCount++;
      if (onProgress) {
        onProgress(allTweets.length, pageCount);
      }

      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) break;
      if (newCount === 0 && pageCount > 1) break;
      if (limit > 0 && allTweets.length >= limit) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;

      await new Promise(resolve => setTimeout(resolve, FETCH_DELAY_MS));
    }

    if (limit > 0 && allTweets.length > limit) {
      allTweets.length = limit;
    }
    return { tweets: allTweets, partial: rateLimitRetries > MAX_RATE_LIMIT_RETRIES };
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
    const headers = ['date', 'text', 'likes', 'retweets', 'replies', 'views', 'bookmarks', 'url'];
    const rows = [headers.join(',')];

    for (const t of tweets) {
      const row = [
        csvEscape(formatDate(t.date)),
        csvEscape(t.text),
        t.likes,
        t.retweets,
        t.replies,
        t.views,
        t.bookmarks,
        csvEscape(t.url),
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

    state.exporting = true;
    sendToBridge('EXPORT_STARTED', {});

    try {
      const result = await fetchAllTweets(userId, (count, pages, statusMsg) => {
        sendToBridge('EXPORT_PROGRESS', { count, pages, statusMsg });
      }, maxTweets);
      const tweets = result.tweets;
      const isPartial = result.partial;

      if (tweets.length === 0) {
        sendToBridge('EXPORT_ERROR', { error: 'NO_TWEETS' });
        state.exporting = false;
        return;
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
      const screenName = state.profile.screenName || 'unknown';
      const dateStr = new Date().toISOString().slice(0, 10);
      const partialTag = isPartial ? '_partial' : '';
      const filename = '@' + screenName + '_tweets' + partialTag + '_' + dateStr + '.' + ext;

      sendToBridge('EXPORT_DOWNLOAD', {
        url: blobUrl,
        filename: filename,
        tweetCount: tweets.length,
        partial: isPartial,
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

  function createExportButton() {
    if (document.getElementById(CONTAINER_ID)) return;

    const container = document.createElement('div');
    container.id = CONTAINER_ID;

    const wrapper = document.createElement('div');
    wrapper.className = 'x-tweet-export-wrapper';

    // Count selector
    const countSelect = document.createElement('select');
    countSelect.id = 'x-tweet-export-count';
    countSelect.className = 'x-tweet-export-select';
    var countOptions = [
      { value: '50', label: '50' },
      { value: '100', label: '100' },
      { value: '200', label: '200' },
    ];
    for (var ci = 0; ci < countOptions.length; ci++) {
      var opt = document.createElement('option');
      opt.value = countOptions[ci].value;
      opt.textContent = countOptions[ci].label;
      if (countOptions[ci].value === '100') opt.selected = true;
      countSelect.appendChild(opt);
    }

    // Format selector
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

    wrapper.appendChild(countSelect);
    wrapper.appendChild(formatSelect);
    wrapper.appendChild(btn);
    container.appendChild(wrapper);

    btn.addEventListener('click', () => {
      if (state.exporting) return;
      const format = formatSelect.value;
      const maxTweets = parseInt(countSelect.value, 10);
      sendToBridge('TRIGGER_EXPORT_FROM_UI', { format, maxTweets });
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
        btn.classList.remove('x-tweet-export-error', 'x-tweet-export-progress', 'x-tweet-export-done');
        break;
      case 'progress':
        label.textContent = message || 'Exporting...';
        btn.disabled = true;
        btn.classList.add('x-tweet-export-progress');
        btn.classList.remove('x-tweet-export-error', 'x-tweet-export-done');
        break;
      case 'done':
        label.textContent = message || 'Done!';
        btn.disabled = false;
        btn.classList.add('x-tweet-export-done');
        btn.classList.remove('x-tweet-export-error', 'x-tweet-export-progress');
        break;
      case 'error':
        label.textContent = message || 'Error';
        btn.disabled = false;
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
      case 'EXPORT_PROGRESS':
        updateButtonState('progress', payload.statusMsg || ('Exporting... ' + payload.count + ' tweets fetched'));
        break;
      case 'EXPORT_DOWNLOAD': {
        var doneMsg = payload.partial
          ? 'Partial: ' + payload.tweetCount + ' tweets (rate limited)'
          : 'Done! ' + payload.tweetCount + ' tweets exported';
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
