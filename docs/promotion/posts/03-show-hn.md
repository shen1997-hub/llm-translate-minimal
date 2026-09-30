# Show HN（选题 7）

> 发布时间：北京时间 21:00–23:00（美国工作日上午）。发完首日盯评论。

## Title（≤80 chars，二选一，发布时用第一个）

Show HN: Minimal LLM web translation extension – your own key, free models work
Show HN: No-subscription web translation extension powered by your own LLM key

## Post body（或首条评论，视发布形式）

I got tired of paying a subscription for web page translation when I already had
API keys for DeepSeek/GLM, and free-tier models (SiliconFlow offers several) turned
out to be good enough for reading. So I built a minimal extension:

- Full-page bilingual translation: detects the article body (nav/sidebars skipped),
  inserts the translation under each paragraph
- Selection translation: select text and a small cat walks over — click it for a popup
  with the translation (there's a plain-dot mode if you dislike cats)
- Any OpenAI-compatible API (DeepSeek, GLM, OpenAI, Moonshot, Ollama/local), plus the
  Claude protocol; 12 target languages
- IndexedDB cache so re-reading costs zero tokens; concurrency limit + 429 backoff
- Keys stay in chrome.storage.local; requests go only to the provider you configured

TypeScript + WXT (MV3), runtime deps limited to idb-keyval and sql.js, Vitest unit
tests and Playwright e2e against a stub LLM server.

GitHub: https://github.com/shen1997-hub/llm-translate-minimal
Feedback very welcome — especially on the content extraction heuristics.

## 首条自评草稿（发布后立即自评）

Backstory: the cat started as a joke — I wanted the selection button to feel less
like UI chrome and more like a companion. It docks at the screen edge, follows your
selection, and trots to the end of it. Happy to share how the drag geometry works
(clientWidth vs innerWidth was a fun scrollbar bug).
