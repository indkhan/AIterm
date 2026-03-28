# Terms Lens

Terms Lens is a Chrome extension that detects Terms, Privacy, and other policy pages, opens a native side panel, summarizes the document, highlights consumer risks, and answers follow-up questions with clause citations.

## What It Does

- Detects likely legal and policy pages in the current tab
- Extracts structured sections from the page instead of flattening the whole document
- Sends extracted clauses to the backend for analysis
- Shows a summary, risk cards, key points, and grounded Q&A
- Lets you click citations to jump back to the relevant clause on the page

## Project Structure

- `manifest.json`, `background.js`, `content.js`
  Chrome extension shell, detection, extraction, and tab/session orchestration
- `sidepanel.html`, `sidepanel.css`, `sidepanel.js`
  Side panel UI
- `server.py`, `analysis_engine.py`
  Backend API and analysis pipeline
- `tests/`
  Backend and contract tests

## Requirements

- Python 3.11+
- Google Chrome
- Optional: an `OPENAI_API_KEY` or `GROQ_API_KEY` for model-backed responses

## How To Run

### 1. Install Python dependencies

From the project root:

```bash
python -m pip install -r requirements.txt
```

### 2. Configure environment variables

Copy the example env file:

```bash
copy .env.example .env
```

Then edit `.env`.

You can use either OpenAI or Groq.

For OpenAI:

```env
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4.1-mini
```

For Groq:

```env
GROQ_API_KEY=your_key_here
GROQ_MODEL=openai/gpt-oss-20b
GROQ_BASE_URL=https://api.groq.com/openai/v1
```

Provider priority is:

1. `GROQ_API_KEY`
2. `OPENAI_API_KEY`
3. heuristic fallback

If neither API key is set, the app still runs using the built-in heuristic fallback.

### 3. Start the backend

Run:

```bash
python server.py
```

The backend starts on:

```text
http://127.0.0.1:5000
```

You can check it with:

```bash
curl http://127.0.0.1:5000/health
```

### 4. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this project folder: `c:\codex\AIterm`

### 5. Use the extension

1. Open any `http` or `https` page with Terms, Privacy, Refund, Cookie, or similar policy text
2. Click the Terms Lens extension icon, or use the in-page badge if it appears
3. In the side panel, click `Analyze this page`
4. Review the summary and risk cards
5. Ask follow-up questions in the Q&A section
6. Click citation chips to jump to the matching clause on the page

## Default Behavior

- Backend URL defaults to `http://127.0.0.1:5000`
- Raw page text is kept in extension session storage by default
- Follow-up analysis context is stored in backend memory while the backend process is running
- If the backend restarts, active analysis sessions are cleared

## Running Tests

Run:

```bash
python -m pytest
```

## Troubleshooting

- If the side panel opens but analysis fails, make sure `python server.py` is still running
- If Chrome does not reflect code changes, reload the extension from `chrome://extensions`
- If model-backed output is not being used, check that `.env` contains a valid `GROQ_API_KEY` or `OPENAI_API_KEY`
- If you see no badge on a page, open the extension manually from the toolbar and run analysis anyway

## Notes

- This is Chrome-first and has not been fully validated on other Chromium browsers
- The backend currently uses in-memory session storage, not a database
- Outputs are informational and should not be treated as legal advice
