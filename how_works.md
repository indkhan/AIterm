# Terms Lens: Complete Architecture & Data Flow

Full technical breakdown of the Terms Lens Chrome extension—how it detects policy pages, fetches content, analyzes with LLM, extracts risks, and handles follow-up Q&A.

---

## 1. System Overview

**Terms Lens** is a Chrome extension (Manifest V3) that analyzes Terms, Privacy, and Cookie policies using Gemini API. It runs **entirely in the browser**—page text never leaves the client until the user explicitly clicks "Analyze."

### Core Components:
- **Content Script** (`content.js`) — Page inspection, link detection, popup UI, DOM manipulation
- **Background Service Worker** (`background.js`) — Orchestration, state management, LLM calls, tab lifecycle
- **UI Panel** (`sidepanel.js`) — React-like vanilla JS renderer for analysis results, Q&A, settings
- **Shared Utilities** — LLM client, prompt templates, document chunking, policy fetching
- **Storage** — Chrome Local Storage (LLM config, UI prefs), Session Storage (per-tab state)

---

## 2. Page Detection & User Entry Point

### 2.1 Content Script Page Detection (`content.js` → `detectPage()`)

On every page load/navigation, the content script runs:

**Detection Heuristics:**
1. **Keyword matching** on `<title>`, `<h1-h4>`, visible text
   - Terms keywords: `terms`, `conditions`, `TOS` (weight: 0.34)
   - Privacy keywords: `privacy`, `personal data` (weight: 0.34)
   - Cookies keywords: `cookies`, `consent` (weight: 0.30)
   - Legal keywords: `liability`, `arbitration`, `EULA` (weight: 0.22)
   - Refund keywords: `refund`, `returns`, `cancellation` (weight: 0.22)

2. **Link detection** on the page
   - Regex: `/\bterms?|conditions?|privacy|policy|legal|acceptable-use|eula|user-agreement/i`
   - Looks in `href`, `text`, URL path for policy-adjacent pages
   - Returns list of `linkedPolicies` with URL and label

3. **Form detection** for signup flows
   - Finds `<form>` elements
   - Returns `signupForms` list with detected links inside each form

4. **Page type classification**
   - If keyword score > threshold, classifies as `terms`, `privacy`, `cookies`, `refund`, `legal`, or `generic`
   - Calculates confidence score (0.0–1.0)

**Output:** `{ isLegalPage, pageType, confidence, linkedPolicies, signupForms, signals }`

### 2.2 User Triggers Analysis

Two entry paths:

**Path A: Manual (User clicks extension icon)**
- User clicks Terms Lens extension → side panel opens
- `sidepanel.js` calls `sendMessage({ type: 'GET_PANEL_STATE' })`
- If no API key configured → shows onboarding banner
- User clicks "Analyze Policy" button → calls `sendMessage({ type: 'RUN_ANALYSIS' })`

**Path B: Auto-popup (on signup forms)**
- If user enabled "Show floating prompt on signup pages" in settings
- Content script detects signup form with policy link
- Renders floating "Terms Lens found a policy" popup in shadow DOM
- User can dismiss or click to analyze → sends `OPEN_PANEL_AND_ANALYZE` message

---

## 3. Content Fetching & Parsing

### 3.1 Policy Page Extraction

When user clicks "Analyze," background service worker:

1. **Gets page content** via `content.js`:
   ```
   chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE' })
   ```
   Returns:
   - `url`: current page URL
   - `title`: document title
   - `detection`: page detection result (from 2.1)
   - `sections`: extracted text sections (see below)
   - `linkedPolicies`: detected links to other policies

2. **Extracts text sections** (`content.js` → `extractInlineSections()`):
   - Removes: `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`, `[aria-hidden]`
   - Finds: `<main>`, `<article>`, `.policy`, `.legal`, `.terms`, `#content`, etc.
   - Extracts headings (`<h1-h4>`) and body text (`<p>`, `<li>`, `<td>`, `<blockquote>`)
   - Groups by heading into `sections: [{ heading, text, order }, ...]`
   - Cleans: removes extra whitespace, HTML entities
   - Returns all sections up to **1.2M characters** (safety truncate)

**Character budget for inline (current page):** ~90,000 chars max
- If less, this content stays; if more, later chunking splits it

### 3.2 Linked Policy Fetching

For each policy link detected (from `linkedPolicies`):

```
fetchPolicyContent({ url, originPageUrl })
```

**Fetch strategies (in order):**

1. **Direct fetch + HTML parse** (`fetchAndParse()`)
   - `fetch(url, { credentials: 'omit', redirect: 'follow' })`
   - Parse HTML with `DOMParser`
   - Remove nav/script/footer/ads
   - Find content root (`<main>`, `.policy`, etc.)
   - Extract sections (same as inline)
   - **Success if:** ≥1,500 chars + has sections

2. **Fallback: Hidden tab fetch** (`fetchViaHiddenTab()`)
   - Creates invisible browser tab
   - Navigates to policy URL
   - Uses content script extraction from tab
   - Timeout: 30 seconds
   - **Success if:** ≥200 chars + has sections

3. **Partial content** (`fetch-thin`)
   - If direct fetch got sections but < 1,500 chars, still use it
   - Risk: analysis may be incomplete

4. **Error** if all fail

**Result:** `{ sections, totalChars, title, source: 'fetch' | 'hidden-tab' | 'fetch-thin' }`

---

## 4. LLM Analysis Pipeline

### 4.1 Chunking & Long-Document Strategy

**Input:** All sections combined (inline + linked policies)

**Character threshold for strategy choice:**
- **Single-pass**: ≤ 90,000 chars
  - Send entire policy to LLM in one call
  - Prompt: `ANALYZER_SYSTEM_PROMPT` + full text
  - Returns: summary, risks, key points, suggested questions

- **Map-Reduce**: > 90,000 chars
  - **Map phase:** Split into overlapping chunks, analyze each independently
  - **Reduce phase:** Merge all findings into final analysis

### 4.2 Chunking Algorithm (`buildChunks()`)

```
Target chunk size: 24,000 chars
Hard max: 1,200,000 chars
```

Process:
1. Take sections in order
2. Group sections into chunks ≤ 24,000 chars (with 80-char buffer per section)
3. If one section > 24,000 chars → split it into 21,600-char slices
4. Each chunk gets heading (single or range: "Section A … Section C")
5. Each chunk includes `sectionIndexes: [0, 1, 2]` for later citation

**Example:**
```
Chunk 1: "Terms of Service" (15,000 chars)
Chunk 2: "Privacy Policy (part 1)" (24,000 chars, from Privacy Policy sliced)
Chunk 3: "Privacy Policy (part 2)" (21,600 chars)
Chunk 4: "Data Retention" (18,000 chars)
```

### 4.3 Map Phase: Per-Chunk Analysis

For each chunk:

```javascript
callLLM({
  model: state.llmConfig.analysisModel,  // e.g., gemini-2.5-flash
  messages: buildMapMessages(chunk),
  jsonMode: true,
  maxTokens: 1500,
  temperature: 0.2
})
```

**System prompt** (`MAP_SYSTEM_PROMPT`):
- Instruction: "Extract key facts from ONE SECTION only"
- Output schema: `{ chunkSummary, keyPoints: [...], risks: [...] }`
- Rules:
  - Only extract from this chunk (no speculation)
  - 0–5 key points, 0–5 risks per chunk
  - All `sourceQuote` fields must be verbatim ≤200 chars from the chunk
  - Return JSON only (no markdown)

**Concurrency:** 4 chunks in parallel

**Progress tracking:**
- `page.progress = { stage: 'map', completed: N, total: M }`
- UI shows animated progress bar

### 4.4 Reduce Phase: Merging Findings

Once all chunks analyzed:

```javascript
callLLM({
  model: state.llmConfig.analysisModel,
  messages: buildReduceMessages(allChunkResults),
  jsonMode: true,
  maxTokens: 2500,
  temperature: 0.2
})
```

**Input:** Array of per-chunk results
```json
[
  { chunkSummary: "...", keyPoints: [...], risks: [...] },
  { chunkSummary: "...", keyPoints: [...], risks: [...] },
  ...
]
```

**System prompt** (`REDUCE_SYSTEM_PROMPT`):
- Instruction: "Merge partial extractions from multiple sections into final analysis"
- Output schema: `{ summary, keyPoints, risks, pageType, suggestedQuestions }`
- Rules:
  - Deduplicate risks by meaning (keep highest severity)
  - Keep most striking quotes for each risk
  - 5–8 final key points, 3–10 final risks
  - Never invent information
  - Return JSON only

**Result structure:**
```json
{
  "summary": "3-5 sentences about the document",
  "keyPoints": [
    { "text": "You agree to ...", "sourceQuote": "verbatim ≤200 chars" }
  ],
  "risks": [
    {
      "category": "privacy|data_sharing|arbitration|...",
      "severity": "low|medium|high",
      "title": "User data sold to 3rd parties",
      "explanation": "plain English explanation",
      "sourceQuote": "verbatim quote from policy"
    }
  ],
  "pageType": "terms|privacy|cookies|refund|legal|generic",
  "suggestedQuestions": ["Is my email visible...", "..."]
}
```

### 4.5 Single-Pass (Short Documents)

For ≤90,000 chars:

```javascript
callLLM({
  model: state.llmConfig.analysisModel,
  messages: buildAnalyzerMessages({
    url: page.url,
    title: page.title,
    sectionsText: buildSectionsText(sections)  // plain text, markdown formatted
  }),
  jsonMode: true,
  maxTokens: 2500,
  temperature: 0.2
})
```

**System prompt** (`ANALYZER_SYSTEM_PROMPT`):
- Same output schema as reduce phase
- Instruction: "Read the policy text and return analysis JSON"

---

## 5. Risk Categories & Severity

### Risk Categories (13 types):
```
privacy              → personal data handling
data_sharing         → 3rd-party sharing
arbitration          → forced arbitration clause
auto_renewal         → auto-billing/renewal traps
liability            → limitation of liability
content_license      → company owns user content
termination          → account termination rights
minor_data           → how children's data is handled
tracking             → tracking/analytics
jurisdiction         → which court has jurisdiction
payment              → payment terms/disputes
other                → doesn't fit above
```

### Severity Levels:
```
low    → annoying but manageable (e.g., "data shared with analytics")
medium → concerning (e.g., "auto-renewal unless you cancel")
high   → critical red flag (e.g., "forced arbitration + no class actions")
```

**Scoring note:** LLM assigns severity based on user impact, not legal strictness

---

## 6. Follow-up Q&A System

### 6.1 Question Submission Flow

User types question in composer, hits "Ask":

1. **Optimistic UI:**
   - Shows user's question immediately in chat bubble
   - Shows assistant avatar with bouncing dots + "Thinking…"
   - Input disabled, send button shows spinner

2. **Backend (`askFollowup()`):**
   ```javascript
   sendMessage({ type: 'ASK_FOLLOWUP', question: "Can I delete my account?" })
   ```
   - Sets `state.asking = true`
   - Calls background service worker

### 6.2 Context Retrieval

Background service worker:

1. Gets analysis sections (from previous analysis)
2. **Builds lexical index** (`buildLexicalIndex(sections)`):
   - Tokenizes each section
   - Builds word-to-sections map
   - Purpose: fast retrieval of relevant sections

3. **Retrieves relevant excerpts** (`topSections(index, question, topK=5)`):
   - Tokenizes user question
   - Scores each section: `overlap / union of tokens`
   - Returns top 5 sections with highest overlap
   - Each excerpt includes: `{ heading, text, sectionIndex, order }`

**Example:**
- Question: "Can I delete my account?"
- Matched sections: "Account Termination", "Data Deletion Rights", "User Data", etc.

### 6.3 LLM-Grounded Answer

```javascript
callLLM({
  model: state.llmConfig.chatModel,  // typically a faster model
  messages: buildQAMessages({
    question,
    excerpts: topSections  // 5 relevant sections
  }),
  jsonMode: true,
  maxTokens: 500,
  temperature: 0.2
})
```

**System prompt** (`QA_SYSTEM_PROMPT`):
```
You are answering a user's question using ONLY provided excerpts.
Return JSON: { answer, citations, grounded }

- If answer is in excerpts: grounded=true, include 1–3 citations
- If NOT in excerpts: grounded=false, answer="Not addressed in the document."
```

**Output schema:**
```json
{
  "answer": "Yes, you can request account deletion per Section 5.2. Your data will be retained for 30 days before permanent deletion.",
  "citations": [
    {
      "quote": "verbatim ≤200 chars from excerpt",
      "sectionIndex": 2
    }
  ],
  "grounded": true
}
```

### 6.4 Citation Rendering

When user clicks a citation chip in the UI:

1. If answer from **current page** (analyzed inline):
   - Calls `chrome.tabs.sendMessage(tabId, { type: 'JUMP_TO_SECTION', sectionIndex })`
   - Content script finds section by index and scrolls to it
   
2. If answer from **linked policy** (fetched separately):
   - Opens new tab with policy URL

---

## 7. State Management & Storage

### 7.1 Chrome Storage

**Local Storage** (persistent):
```javascript
{
  'terms-lens:llm-config': {
    provider: 'gemini',
    apiKey: 'AIza...',
    analysisModel: 'gemini-2.5-flash',
    chatModel: 'gemini-2.5-flash-lite',
    baseUrlOverride: ''  // for custom proxy
  },
  'terms-lens:ui-prefs': {
    autoPopupOnSignup: true,
    autoOpen: true  // auto-open panel on policy pages
  }
}
```

**Session Storage** (per-tab, cleared on tab close):
```javascript
{
  'terms-lens:tab-state:{tabId}': {
    tabId,
    url: 'https://example.com/terms',
    title: 'Terms of Service',
    detection: { isLegalPage, pageType, confidence, ... },
    analysisStatus: 'idle' | 'fetching' | 'analyzing' | 'error' | 'done',
    analysisSource: { type: 'inline' | 'linked-policy-fetch', url },
    page: {
      analysis: { summary, risks, keyPoints, suggestedQuestions, ... },
      conversation: [
        { role: 'user', text, grounded },
        { role: 'assistant', text, citations, grounded }
      ],
      lastError: null,
      progress: { stage, completed, total, tokenEstimate }
    }
  }
}
```

### 7.2 Tab Lifecycle

**On tab load/navigate:**
```
→ clearTabState(tabId)
→ inspectTab(tabId)
  → ensureContentScript(tabId)
  → DETECT_PAGE message
  → store detection in tab state
  → if autoOpen && isLegalPage → chrome.sidePanel.open()
```

**On tab close:**
```
→ chrome.tabs.onRemoved
→ clearTabState(tabId)
```

---

## 8. LLM Client & API Integration

### 8.1 Provider Setup

Currently supports **Gemini** only:

```javascript
PROVIDERS.gemini = {
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  modelPreference: [
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash'
  ],
  chatModelPreference: [
    'gemini-3.1-flash-lite',
    'gemini-3-flash',
    'gemini-2.5-flash-lite'
  ]
}
```

### 8.2 callLLM() Function

```javascript
callLLM({
  provider: 'gemini',
  apiKey: 'AIza...',
  model: 'gemini-2.5-flash',
  messages: [
    { role: 'system', content: 'You are a policy analyzer...' },
    { role: 'user', content: 'Analyze this: ...' }
  ],
  jsonMode: true,           // response_format: { type: 'json_object' }
  maxTokens: 1500,
  temperature: 0.2,         // Low for deterministic analysis
  baseUrlOverride: null,
  signal: abortController.signal,  // for cancellation
  timeoutMs: 90000
})
```

**Request:**
```
POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json

{
  "model": "gemini-2.5-flash",
  "messages": [...],
  "max_tokens": 1500,
  "temperature": 0.2,
  "response_format": { "type": "json_object" }
}
```

**Response parsing:**
```javascript
const parsed = parseJsonContent(response.content);
// response.content is the full reply text
// extracts JSON object from markdown (if wrapped) or raw JSON
```

### 8.3 Error Handling

**Error codes:**
- `auth` → Invalid API key (HTTP 401/403)
- `rate_limit` → Rate limited (HTTP 429)
- `network` → Timeout, fetch failure, parsing error
- `config` → Missing model/key config

**Retry strategy:**
- No automatic retries (user must click "Try again")
- Rate limit error includes `retryAfter` header value
- Timeout: 90 seconds per request

---

## 9. UI Rendering Pipeline

### 9.1 State-Driven Rendering (`sidepanel.js`)

State object:
```javascript
{
  view: 'main' | 'settings',
  apiKeyConfigured: boolean,
  page: { analysis, conversation, progress, ... },
  asking: boolean,
  pendingQuestion: string | null,
  testResult: { success, sample/error }
}
```

**Render cycle:**
```
State change → render()
  → buildPanelState(tabId)
  → renderShell()
    → if view='settings' → renderSettings()
    → else → renderHeader() + renderMain()
      → renderHero(page)
      → renderStatusOrError(page, status)
      → renderAnalysis(page, status)
        → renderSummary()
        → renderRisks()
        → renderKeyPoints()
        → renderConversation()
```

### 9.2 Real-time Progress Display

During analysis (`status='analyzing'`):
```
renderAnalyzingState(page)
→ Get page.progress = { stage, completed, total }
→ Show:
   - Title: "Reading the document section by section" (if stage='map')
   - Detail: "Section 5 / 12"
   - Progress bar: width={pct}%, animated stripes
   - Skeleton loaders (shimmer animation)
```

### 9.3 Message Rendering with Avatars

User & assistant messages with optimistic UI:

```javascript
renderMessage(message)
→ isUser ? rightAlign : leftAlign
→ render avatar (U or TL conic gradient)
→ render bubble with message text
→ if citations: render cite chips
→ if ungrounded: show "Not in document" warning
```

**Thinking state** (while `state.asking = true`):
```
Show user's message immediately
Show assistant avatar + bouncing dots + "Thinking…"
```

---

## 10. Architecture Recommendations for AI Architect

### 10.1 Current Strengths
✅ **Content safety:** Never sends data without user explicit action  
✅ **Offline-first:** No backend dependency, runs entirely in browser  
✅ **Efficient chunking:** Map-reduce handles documents up to 1.2M chars  
✅ **Grounded Q&A:** Always answers from document text, flags when out-of-scope  
✅ **Configurable LLM:** Works with any Gemini model, supports custom API endpoints  

### 10.2 Optimization Opportunities

**1. Retrieval-Augmented Generation (RAG)**
- **Current:** Lexical token overlap (baseline TF-IDF-like)
- **Suggested:** Semantic embeddings + vector similarity
  - Embed sections at analysis time (one call, 1.2M chars in batches)
  - On Q&A, embed question, find top-k by cosine similarity
  - Benefits: handles synonyms, semantic drift ("delete account" ≈ "remove profile")
  - Cost: ~0.001 more API calls per analysis (embeddings API)
  - Tradeoff: adds complexity, requires embedding model choice

**2. Summary Caching**
- **Current:** Re-analyze each time tab is revisited
- **Suggested:** Cache final `analysis` object keyed by `(url, hash(text))`
  - Store in IndexedDB with TTL (7 days)
  - Benefits: instant reload on repeat visits
  - Cost: storage complexity

**3. Incremental Analysis**
- **Current:** Reanalyze from scratch on page updates
- **Suggested:** Diff sections, re-analyze changed chunks only
  - Use hash of section text to detect changes
  - Merge updated risks with cached ones
  - Benefits: faster for content updates
  - Cost: merge logic complexity

**4. Structured Extraction → Type Validation**
- **Current:** LLM returns JSON, no schema validation
- **Suggested:** Use JSON Schema in `response_format` with stricter validation
  - Or: post-process with Zod/ts-json-validator to catch malformed output
  - Benefits: fewer analysis retries, better debugging
  - Cost: adds validation library

**5. Fallback to Free LLM**
- **Current:** Single Gemini provider
- **Suggested:** Support Claude API / GPT-4o as fallback
  - On Gemini rate-limit → prompt user to add alternate key
  - Or add Ollama/local LLM support for privacy-first deployments
  - Cost: broader API support, more complex config UX

**6. Streaming Analysis**
- **Current:** Waits for full LLM response before rendering
- **Suggested:** Use streaming API (SSE/WebSocket)
  - Render summary as it streams, then risks, then Q&A suggestions
  - Benefits: perceived speed, better UX for slow connections
  - Cost: streaming parsing, incomplete JSON handling

### 10.3 Specific File Recommendations

**`shared/long-doc.js`:**
- Add `buildEmbeddings(sections)` → Call embedding API, return `[{ sectionIndex, embedding }]`
- Add `retrieveBySemanticSimilarity(question, embeddings, topK)` → Return top-K sections

**`shared/prompts.js`:**
- Add `JSON_SCHEMA_STRICT` constant with JSON Schema for each prompt
- Use in `response_format` for stricter LLM output compliance

**`background.js` → `askFollowup()`:**
- Replace `topSections(lexicalIndex, ...)` with:
  ```javascript
  const embeddings = state.page.sectionEmbeddings || [];
  const results = embeddings.length > 0
    ? retrieveBySemanticSimilarity(question, embeddings, 5)
    : topSections(buildLexicalIndex(sections), question, 5);
  ```

**New file: `shared/embeddings.js`:**
- Export `embedText(text, apiKey, model)` → Gemini Embeddings API
- Batch embed sections at analysis time
- Store in `state.page.sectionEmbeddings`

---

## 11. Security & Privacy Notes

### 11.1 Data Isolation
- API key stored locally in Chrome Storage (per-profile, not synced)
- No backend server; all processing happens in extension
- Network only to: Gemini API, policy URL fetches (user-initiated)

### 11.2 Content Security
- Removes XSS vectors from fetched HTML (script, style, onclick handlers)
- Message passing via Chrome message API (same-origin policy enforced)
- Side panel runs in isolated context (own DOM, CSS, JS scope)

### 11.3 API Key Safety
- Never logged, never sent to non-Gemini endpoints (unless `baseUrlOverride`)
- User can revoke at any time → stored key becomes invalid immediately
- Test key feature validates without storing responses

---

## 12. Glossary

| Term | Definition |
|------|-----------|
| **Map-Reduce** | Analyze chunks independently (map), then merge (reduce) |
| **Lexical Index** | Word-to-sections map for token overlap retrieval |
| **Grounded** | Answer extracted from policy text (vs. general knowledge) |
| **Chunk** | 24K-char slice of policy, analyzed by LLM |
| **Section** | Heading + body text (from DOM extraction) |
| **Source quote** | Verbatim text ≤200 chars from policy (for citations) |
| **Severity** | low/medium/high risk impact assessment |
| **Confidence** | 0–1 score on whether page is a legal document |

---

## 13. Example End-to-End Flow

### Scenario: User visits `example.com/terms`, clicks "Analyze"

1. **Page load** (bg.js):
   ```
   → inspectTab() calls content script
   → DETECT_PAGE returns { isLegalPage: true, pageType: 'terms', ... }
   → stored in session storage
   ```

2. **User clicks "Analyze Policy"** (sidepanel.js):
   ```
   → RUN_ANALYSIS message
   → fetchPolicyContent() downloads inline + linked policies
   ```

3. **Analysis** (background.js):
   ```
   → sections combined, total 140K chars
   → Trigger MAP-REDUCE (> 90K)
   → buildChunks() → 6 chunks
   → MAP: Analyze each chunk in parallel (4 concurrency)
     Each returns { chunkSummary, keyPoints, risks }
   → REDUCE: Merge findings
     Result: { summary, keyPoints, risks, pageType, suggestedQuestions }
   ```

4. **Result stored** (background.js):
   ```
   → updateTabState(tabId, { analysis, analysisStatus: 'done' })
   → sidepanel re-renders
   ```

5. **User reads results** (sidepanel.js):
   ```
   → Hero card: title + URL + status pills
   → Summary card: 3-5 sentence overview
   → Risks card: sorted by severity, 3-10 cards
   → Key points: 5-8 bullets with → arrow
   → Q&A section: empty, suggested questions visible
   ```

6. **User asks "Can I delete my account?"** (sidepanel.js):
   ```
   → Optimistic UI: show user question immediately + thinking avatar
   → ASK_FOLLOWUP message
   → background.js:
      - topSections(lexicalIndex, question) → ["Account Termination", "Data Rights", ...]
      - callLLM with QA_SYSTEM_PROMPT + excerpts
      - Returns { answer, citations, grounded }
   → sidepanel renders answer + cite chips
   ```

7. **User clicks citation** (sidepanel.js):
   ```
   → OPEN_CITATION message + sectionIndex
   → If inline section: JUMP_TO_SECTION content script message
   → If linked policy: chrome.tabs.create(url)
   ```

---

**End of Architecture Document**

For more details on specific LLM prompts, chunking tuning, or caching strategies, refer to respective source files.
