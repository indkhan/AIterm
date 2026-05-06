# Terms Lens

Chrome extension that detects Terms, Privacy, and policy pages, shows a signup-page popup, fetches linked policy documents, and answers follow-up questions with grounded clause citations — **no server needed**.

## What It Does

- Detects signup forms and nearby T&C links on any page (Instagram, Reddit, GitHub, Substack, etc.)
- Shows a floating "Review terms before signing up" prompt near the form
- One click opens the side panel, fetches the linked policy page, and runs AI analysis
- Summarises the document in plain English — key points, risk cards with severity, verbatim source quotes
- Answers follow-up questions strictly from the policy text (no hallucinated answers)
- Handles huge documents (Google ToS, Meta ToS, AWS) via parallel map-reduce chunking
- Works entirely from your browser with your own Gemini API key

## Requirements

- Google Chrome 116+
- A free [Google AI Studio](https://aistudio.google.com/app/apikey) Gemini API key (`AIza…`)

No Python. No server. No `.env` file.

## Install

### 1. Load unpacked

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder: `C:\codex\wooo\AIterm`

### 2. Add your API key

1. Click the Terms Lens icon in the Chrome toolbar → side panel opens
2. Click **⚙ Settings**
3. Paste your Gemini API key (`AIza…`) — model list loads automatically
4. Pick an **Analysis model** and **Chat model** (default: `gemini-3.1-flash-lite` for both)
5. Click **Test key** → green pill means it works
6. Click **Save**

Free tier is enough — [get a key at Google AI Studio](https://aistudio.google.com/app/apikey).

## Usage

### Signup pages

Navigate to any signup page (Instagram, X, Reddit, LinkedIn, Substack, GitHub…).

- A floating card appears near the form: **"Review terms before signing up"**
- Click **Review** → side panel opens, fetches the linked Terms/Privacy page, and analyzes it
- Read the summary, key points, and risk cards
- Ask follow-up questions — answers cite verbatim quotes from the document

### Policy pages directly

Open any Terms or Privacy page and click the Terms Lens extension icon.

Click **Analyze policy** to fetch and summarize.

### Large documents

For docs over ~100k characters (Google ToS, AWS Customer Agreement):

- Extension shows a progress bar: **"Analyzing 3 / 12 sections…"**
- Sections are analyzed in parallel then merged into a single coherent summary
- Q&A still works — relevant sections are retrieved by keyword search

## Project Layout

```
AIterm/
├── manifest.json          Chrome MV3 manifest
├── background.js          Service worker — LLM calls, analysis orchestration, tab state
├── content.js             Content script — page detection, signup form popup, inline extraction
├── sidepanel.html/css/js  Side panel UI
└── shared/
    ├── config.js          Storage keys, defaults, TTL constants
    ├── llm-client.js      Groq + Gemini API abstraction, model listing, JSON parse
    ├── prompts.js         System prompts for analyzer, map, reduce, Q&A
    ├── long-doc.js        Tiered analysis: single-pass / map-reduce, BM25 Q&A retrieval
    └── policy-fetch.js    Two-stage fetch: direct HTTP + hidden-tab fallback for SPAs
```

## Privacy & Security

- Your API key is stored in `chrome.storage.local` — local to your browser profile only
- Page text is sent to your selected provider (Groq or Gemini) over HTTPS **only when you click Analyze**
- Nothing is sent to any third party, analytics service, or the extension author
- Do not install on a shared computer where you don't trust other extensions (any extension with the `storage` permission can read local storage on the same profile)

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Side panel shows "Add your API key" | Open Settings → paste key → Save |
| Model dropdown empty | Paste API key first, then click "Refresh model list" |
| "Provider rejected your API key" | Check key is valid and not expired |
| Floating popup doesn't appear | Check Settings → "Show floating prompt on signup pages" is on |
| Fetch fails on some T&C pages | Extension retries via a background tab (handles Cloudflare/SPAs) |
| Analysis returns "insufficient text" | Open the actual T&C page directly and click Analyze |

## Notes

- Chrome 116+ required for `chrome.sidePanel` API
- Extension is read-only — it never modifies any page, never submits forms
- Analysis output is informational and should not be treated as legal advice
