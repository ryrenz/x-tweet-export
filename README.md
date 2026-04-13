# X Tweet Export

一键导出任意 X（Twitter）用户的推文为 CSV 或 JSON。无需 API Key、无需 Python、零配置 —— 利用你浏览器中已登录的 X 会话直接工作。

[English](#english) | 中文

---

## 功能特性

- **一键导出** —— 访问任意用户主页，点击按钮即可导出
- **CSV + JSON** —— CSV 可直接在 Excel 中打开，JSON 方便开发者处理
- **数量可选** —— 支持导出 50 / 100 / 200 条推文
- **智能认证** —— 多层 fallback 自动获取认证，无需手动配置
- **限流保护** —— 请求间隔 3 秒 + 429 自动暂停 60 秒重试
- **SPA 适配** —— 站内跳转自动刷新按钮，无需刷新页面
- **隐私安全** —— 所有数据本地处理，不上传任何服务器
- **零依赖** —— 纯 JavaScript，无 npm，无构建步骤

## 安装

1. 克隆或下载本仓库
   ```bash
   git clone https://github.com/ryrenz/x-tweet-export.git
   ```
2. 打开 Chrome，进入 `chrome://extensions/`
3. 右上角开启**开发者模式**
4. 点击**加载已解压的扩展程序**，选择 `x-tweet-export` 目录
5. 访问任意 X 用户主页（如 `x.com/elonmusk`）

## 使用方法

1. 访问任意用户主页 `x.com/<username>`
2. 等待页面加载完成，右侧栏 "What's happening" 上方会出现导出工具栏
3. 选择数量（50 / 100 / 200）和格式（CSV / JSON）
4. 点击 **Export Tweets**
5. 按钮会显示进度（如 `Exporting... 42 tweets fetched`）
6. 完成后自动弹出保存对话框

### 提示

- 如果提示 "Auth not found"，刷新页面即可 —— 扩展需要从 X 的 API 请求中捕获认证信息
- 如果提示 "Could not resolve user ID"，滚动一下 timeline 让扩展捕获用户 ID
- 大量导出（200 条）大约需要 30 秒 - 1 分钟

## 导出格式

### CSV

```csv
date,text,likes,retweets,replies,views,bookmarks,url
"2026-04-12 15:30:00","推文内容...",150,20,5,12000,30,"https://x.com/user/status/123"
```

- UTF-8 编码 + BOM，Excel 直接打开不乱码
- 所有文本字段正确转义（逗号、换行、双引号）
- 文件名格式：`@username_tweets_2026-04-13.csv`

### JSON

```json
[
  {
    "id": "123456789",
    "date": "2026-04-12 15:30:00",
    "text": "推文内容...",
    "likes": 150,
    "retweets": 20,
    "replies": 5,
    "views": 12000,
    "bookmarks": 30,
    "url": "https://x.com/user/status/123456789"
  }
]
```

## 导出范围

| 包含 | 不包含 |
|------|--------|
| 原创推文 | 纯转推（Retweets） |
| 引用推文（Quote Tweets） | 回复他人的推文 |
| 自己的 thread（自回复） | 广告 |
| 置顶推文 | |

## 工作原理

本扩展运行在浏览器页面上下文（MAIN world），通过以下方式工作：

1. **拦截认证** —— Hook `window.fetch` 和 `XMLHttpRequest`，从 X 自身的 API 请求中提取 Bearer token 和 CSRF token
2. **多层 fallback** —— 如果 hook 没有捕获到（页面加载时序问题），从 cookie 读取 csrf、从 JS bundle 中扫描 bearer token 和 GraphQL queryId
3. **分页抓取** —— 使用捕获的认证信息调用 X 的内部 GraphQL API，通过游标分页获取推文
4. **本地生成** —— 在浏览器中生成 CSV/JSON，通过 Service Worker 触发下载

**所有数据在本地处理，不发送到任何外部服务器。**

## 项目结构

```
x-tweet-export/
├── manifest.json    # Manifest V3 配置
├── background.js    # Service Worker：处理 chrome.downloads
├── content.js       # MAIN world：认证捕获 + 导出逻辑 + UI 注入
├── bridge.js        # ISOLATED world：消息中转
├── styles.css       # 导出工具栏样式
├── icons/           # 扩展图标
├── TBD.md           # 未来功能路线图
├── LICENSE          # MIT
└── README.md
```

## 路线图

详见 [TBD.md](TBD.md)

- **P1**: 媒体导出（图片/视频 URL）、多语言（中/英/日）
- **P2**: 日期筛选、搜索结果导出、点赞/书签导出
- **P3**: 批量导出

## 许可证

[MIT](LICENSE)

---

<a name="english"></a>

## English

### What is this?

A Chrome extension that exports any X (Twitter) user's tweets to CSV or JSON with one click. No API key, no Python, no configuration — works because you're already logged into X in your browser.

### Features

- **One-click export** — visit any profile, click the button
- **CSV + JSON** — CSV for Excel, JSON for developers
- **Configurable count** — export 50 / 100 / 200 tweets
- **Smart auth** — multi-layer fallback for automatic credential capture
- **Rate limit protection** — 3s delay + auto-pause on 429
- **SPA-aware** — button auto-refreshes when switching profiles
- **Privacy-first** — all data processed locally, nothing uploaded
- **Zero dependencies** — pure JavaScript, no npm, no build step

### Install

1. Clone this repo
   ```bash
   git clone https://github.com/ryrenz/x-tweet-export.git
   ```
2. Go to `chrome://extensions/`
3. Enable **Developer mode** (top-right)
4. Click **Load unpacked**, select the `x-tweet-export` directory
5. Visit any X profile (e.g., `x.com/elonmusk`)

### Usage

1. Visit `x.com/<username>`
2. The export toolbar appears in the right sidebar, above "What's happening"
3. Select count (50 / 100 / 200) and format (CSV / JSON)
4. Click **Export Tweets**
5. Progress shows in the button (`Exporting... 42 tweets fetched`)
6. Download dialog appears when complete

### Tips

- "Auth not found" → refresh the page
- "Could not resolve user ID" → scroll the timeline once
- 200 tweets takes about 30s - 1 min

### What Gets Exported

Included: original tweets, quote tweets, self-replies (threads), pinned tweets

Not included: pure retweets, replies to others, ads

### How It Works

The extension runs in the page context (MAIN world) and:

1. Hooks `window.fetch` + `XMLHttpRequest` to capture auth headers from X's own API requests
2. Falls back to reading csrf from cookies, bearer token from JS bundles, queryIds from bundle regex
3. Paginates through `UserTweets` GraphQL API using captured credentials (`credentials: 'include'`)
4. Generates CSV/JSON locally and triggers download via the extension's service worker

**All data stays in your browser — nothing is sent to external servers.**

### License

[MIT](LICENSE)
