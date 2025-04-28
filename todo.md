
# ToDo List for AI-Powered T&C Summarizer Extension
Use html , css ,Vanilla javascript , tailwind css , (flask for backend if needed)
## Step 1: Requirements & Planning
- [ ] **1.1 Define detection criteria**
  - [ ] List URL patterns (`/terms`, `/privacy`, etc.)
  - [ ] Identify DOM markers (meta tags, headings `<h1>`, `<title>`)
- [ ] **1.2 Sketch the UX flow**
  - [ ] Wireframe sidebar views: summary vs. chat
  - [ ] Define clause highlighting and anchoring interactions


## Step 2: Set Up Development Environment
- [ ] **2.1 Scaffold extension boilerplate**
  - [ ] Create `manifest.json` with content scripts & sidebar settings

## Step 3: Content Script & Page Detection
- [ ] **3.1 Write content script**
  - [ ] Inject script on all pages; hook into `DOMContentLoaded`
- [ ] **3.2 Implement detection logic**
  - [ ] Check `window.location.pathname` for patterns
  - [ ] Fallback: scan `<h1>`/`<title>` for keywords
- [ ] **3.3 Trigger sidebar injection**
  - [ ] Use messaging or `chrome.sidebarAction` to open sidebar

## Step 4: Sidebar UI Development
- [ ] **4.1 Build sidebar component**
  - [ ] Layout: header, summary list, chat area, input box
- [ ] **4.2 Style & accessibility**
  - [ ] Apply Tailwind styling and responsive design
  - [ ] Ensure ARIA labels and keyboard navigation
- [ ] **4.3 Highlighting & anchoring**
  - [ ] Implement scroll-to and CSS highlight for clauses

## Step 5: AI Summarization Integration
- [ ] **5.1  LLM service**
  - [ ] Gemini (using langchain Search web to find the best implementation)
- [ ] **5.2 Design prompt templates**
  - [ ] Summary prompt focusing on obligations, data use, risks
  - [ ] Q&A prompt including history and clause excerpt
- [ ] **5.3 Implement API layer**
  - [ ] Create backend endpoint `/api/summarize`
  - [ ] Handle API keys, rate limits, and error cases

## Step 6: Context Persistence & Q&A
- [ ] **6.1 Maintain message history**
  - [ ] Store chat turns and clause mappings (React state or IndexedDB)
- [ ] **6.2 Clause excerpt retrieval**
  - [ ] Mark paragraphs with IDs for precise text retrieval
- [ ] **6.3 Follow-up handling**
  - [ ] Send history and excerpt in new LLM calls

## Step 7: Testing & Quality Assurance
- [ ] **7.1 Unit tests**
  - [ ] Test detection logic, prompt generation, error handling
- [ ] **7.2 Integration/E2E tests**
  - [ ] Automate with Puppeteer: load sample page & verify flow
- [ ] **7.3 Cross-browser checks**
  - [ ] Test on Chrome, Edge, and Brave
- [ ] **7.4 Usability testing**
  - [ ] Collect feedback on summaries, chat accuracy, UX

## Step 8: Deployment & Maintenance
- [ ] **8.1 Prepare for Chrome Web Store**
  - [ ] Build production bundle, add icons, write store listing
  - [ ] Draft privacy policy and complete review checklist
- [ ] **8.2 Monitoring & analytics**
  - [ ] Integrate Sentry for errors and analytics tool for usage
- [ ] **8.3 Iteration & updates**
  - [ ] Plan enhancements: multi-page support, offline mode, parser updates


