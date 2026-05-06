const ICONS = {
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>`,
  spark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  zap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>`,
};

const state = {
  tabId: null,
  llmConfig: null,
  apiKeyConfigured: false,
  uiPrefs: {},
  page: null,
  labels: {},
  providers: {},
  modelCache: null,
  asking: false,
  view: 'main',
  modelList: [],
  modelListLoading: false,
  modelListError: null,
  testResult: null,
  testing: false,
  draftConfig: null,
  showApiKey: false,
  pendingQuestion: null,
};

const app = document.getElementById('app');
let _outsideClickHandler = null;

bootstrap().catch((error) => {
  console.error('Failed to start Terms Lens panel:', error);
  app.innerHTML = `<div class="shell"><div class="card"><h2>Panel failed to load</h2><p>${escapeHtml(error.message || 'Unknown error')}</p></div></div>`;
});

async function bootstrap() {
  bindRuntimeUpdates();
  await refreshState();
}

function bindRuntimeUpdates() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'PANEL_STATE_UPDATED') return;
    if (state.tabId && message.tabId !== state.tabId) return;
    Object.assign(state, message.payload);
    render();
  });
}

async function refreshState() {
  const response = await sendMessage({ type: 'GET_PANEL_STATE' });
  Object.assign(state, response);
  if (state.apiKeyConfigured && !state.modelList.length && !state.modelListLoading) {
    refreshModelList(false);
  }
  render();
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response) throw new Error('No response from background');
  if (!response.ok) {
    const error = new Error(response.error || 'Request failed');
    error.code = response.code;
    throw error;
  }
  return response;
}

function render() {
  const scrollTop = app.parentElement ? app.parentElement.scrollTop : 0;
  const docScrollY = document.documentElement.scrollTop || document.body.scrollTop;
  app.innerHTML = renderShell();
  document.documentElement.scrollTop = docScrollY;
  document.body.scrollTop = docScrollY;
  bindEvents();
  document.body.classList.add('app-loaded');
}

function renderShell() {
  if (state.view === 'settings') {
    return `<div class="shell">${renderHeader(true)}${renderSettings()}</div>`;
  }
  return `<div class="shell">${renderHeader(false)}${renderMain()}</div>`;
}

function renderHeader(inSettings) {
  return `
    <div class="header">
      <div class="brand">
        <div class="brand-mark">TL</div>
        <span>Terms Lens</span>
      </div>
      <button class="icon-btn" data-action="${inSettings ? 'go-main' : 'go-settings'}" title="${inSettings ? 'Back' : 'Settings'}" aria-label="${inSettings ? 'Back' : 'Settings'}">
        ${inSettings ? ICONS.back : ICONS.settings}
      </button>
    </div>
  `;
}

function renderMain() {
  if (!state.apiKeyConfigured) {
    return renderOnboardingBanner();
  }

  const page = state.page || {};
  const status = page.analysisStatus || 'idle';

  return `
    ${renderHero(page)}
    ${renderStatusOrError(page, status)}
    ${renderAnalysis(page, status)}
    <div class="footnote">${ICONS.shield} Analysis powered by your Gemini key. Page text leaves your browser only when you click Review.</div>
  `;
}

function renderOnboardingBanner() {
  return `
    <div class="banner">
      <div class="banner-icon">${ICONS.spark}</div>
      <div>
        <h3>Add your API key to start</h3>
        <p>Terms Lens runs entirely from your browser using your own Gemini key. Free tier available — get a key from Google AI Studio in under a minute.</p>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn-primary" data-action="go-settings">${ICONS.zap}<span>Open settings</span></button>
        </div>
      </div>
    </div>
  `;
}

function renderHero(page) {
  const detection = page.detection;
  const pageType = detection?.pageType ? (state.labels[detection.pageType] || detection.pageType) : 'Current page';
  const title = page.title || 'Current page';
  const url = page.url || '';
  const signupCount = detection?.signupForms?.length || 0;
  const linkCount = detection?.linkedPolicies?.length || 0;

  return `
    <div class="card hero">
      <div class="hero-glow" aria-hidden="true"></div>
      <div class="eyebrow eyebrow-accent">${escapeHtml(pageType)}</div>
      <h1>${escapeHtml(title)}</h1>
      ${url ? `<p class="subtitle">${escapeHtml(url)}</p>` : ''}
      <div class="status-row" style="margin-top:12px">
        ${signupCount ? `<span class="pill pill-accent pill-dot">Signup form detected</span>` : ''}
        ${linkCount ? `<span class="pill pill-dot">${linkCount} policy link${linkCount === 1 ? '' : 's'} found</span>` : ''}
      </div>
    </div>
  `;
}

function renderStatusOrError(page, status) {
  if (status === 'fetching') {
    return `
      <div class="card">
        <div class="eyebrow">Fetching</div>
        <h2>Reading the policy page</h2>
        <p>Pulling the linked Terms or Privacy document and stripping nav/ads.</p>
        <div class="skeleton"></div>
        <div class="skeleton short"></div>
      </div>
    `;
  }

  if (status === 'analyzing') {
    return renderAnalyzingState(page);
  }

  if (status === 'error') {
    return `
      <div class="card" style="border-color: rgba(251,113,133,0.25)">
        <div class="eyebrow" style="color: var(--danger)">Analysis stopped</div>
        <h2>Something went wrong</h2>
        <p>${escapeHtml(page.lastError || 'Unknown error')}</p>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn-primary" data-action="analyze">${ICONS.refresh}<span>Try again</span></button>
          <button class="btn-secondary" data-action="go-settings">${ICONS.settings}<span>Settings</span></button>
        </div>
      </div>
    `;
  }

  if (status === 'idle' || status === 'not-legal') {
    if (page.analysis) return '';
    return `
      <div class="card">
        ${renderReadyToAnalyze(page)}
      </div>
    `;
  }

  return '';
}

function renderAnalyzingState(page) {
  const progress = page.progress || {};
  const stage = progress.stage || 'starting';
  const total = progress.total || 1;
  const completed = progress.completed || 0;
  const pct = Math.round((completed / total) * 100);

  let title = 'Analyzing';
  let detail = 'Running policy text through your selected model.';
  if (stage === 'map') {
    title = 'Reading the document section by section';
    detail = `Section ${completed} / ${total}`;
  } else if (stage === 'reduce') {
    title = 'Combining findings';
    detail = 'Merging section findings into one summary.';
  } else if (stage === 'single-pass') {
    title = 'Analyzing the document';
    detail = progress.tokenEstimate ? `≈${progress.tokenEstimate.toLocaleString()} tokens` : '';
  }

  return `
    <div class="card">
      <div class="eyebrow eyebrow-accent"><span class="pill pill-accent pill-dot pill-pulse" style="padding:2px 8px;font-size:10px">In progress</span></div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(detail)}</p>
      <div class="progress">
        <div class="progress-bar${pct === 0 ? ' indeterminate' : ''}">
          <div class="progress-bar-fill${pct > 0 ? ' has-progress' : ''}" style="width:${pct}%"></div>
        </div>
        <span class="progress-text">${pct > 0 ? `${pct}%` : '…'}</span>
      </div>
      <div class="skeleton"></div>
      <div class="skeleton short"></div>
    </div>
  `;
}

function renderReadyToAnalyze(page) {
  const detection = page.detection;
  const linkCount = detection?.linkedPolicies?.length || 0;
  const signupCount = detection?.signupForms?.length || 0;

  if (!linkCount && !signupCount && !detection?.isLegalPage) {
    return `
      <div class="eyebrow">Idle</div>
      <h2>No policy detected here</h2>
      <p>Open a Terms, Privacy, or signup page to analyze. Or run analysis on the visible text anyway.</p>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn-secondary" data-action="analyze">${ICONS.zap}<span>Analyze visible text</span></button>
      </div>
    `;
  }

  const description = signupCount
    ? `This signup form links to ${linkCount} policy page${linkCount === 1 ? '' : 's'}. Click Analyze to read them for you.`
    : linkCount
      ? `Found ${linkCount} policy link${linkCount === 1 ? '' : 's'}. Click Analyze to fetch and summarize.`
      : `This looks like a policy page. Click Analyze to summarize.`;

  return `
    <div class="eyebrow eyebrow-accent">Ready</div>
    <h2>Ready to analyze</h2>
    <p>${escapeHtml(description)}</p>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn-primary" data-action="analyze">${ICONS.zap}<span>Analyze policy</span></button>
    </div>
  `;
}

function renderAnalysis(page, status) {
  const analysis = page.analysis;
  if (!analysis) return '';
  if (status === 'fetching' || status === 'analyzing') return '';

  return `
    ${renderSummary(analysis, page)}
    ${renderRisks(analysis)}
    ${renderKeyPoints(analysis)}
    ${renderConversation(analysis)}
    <div class="btn-row" style="justify-content:center;margin-top:4px">
      <button class="btn-secondary" data-action="analyze">${ICONS.refresh}<span>Re-run analysis</span></button>
    </div>
  `;
}

function renderSummary(analysis, page) {
  const source = page.analysisSource;
  const sourceLine = source?.url
    ? `Source: <a href="${escapeAttribute(source.url)}" target="_blank" rel="noopener">${escapeHtml(truncate(source.url, 60))}</a>`
    : '';

  return `
    <div class="card">
      <div class="eyebrow">Summary</div>
      <h2>What this document says</h2>
      <p>${escapeHtml(analysis.summary || 'No summary generated.')}</p>
      ${sourceLine ? `<p class="subtitle" style="font-size:12px;margin-top:8px">${sourceLine}</p>` : ''}
    </div>
  `;
}

function renderRisks(analysis) {
  const risks = analysis.risks || [];
  if (!risks.length) return '';

  return `
    <div class="card">
      <div class="eyebrow">Risks &amp; surprises</div>
      <h2>Things to know before agreeing</h2>
      <div>
        ${risks.map(renderRiskCard).join('')}
      </div>
    </div>
  `;
}

function renderRiskCard(risk) {
  const severity = ['low', 'medium', 'high'].includes(risk.severity) ? risk.severity : 'low';
  return `
    <article class="risk-card severity-${severity}">
      <div class="risk-card-header">
        <div>
          <div class="category-tag">${escapeHtml(formatCategory(risk.category))}</div>
          <h4>${escapeHtml(risk.title || risk.text || 'Risk')}</h4>
        </div>
        <span class="severity-tag">${escapeHtml(severity)}</span>
      </div>
      <p>${escapeHtml(risk.explanation || risk.text || '')}</p>
      ${risk.sourceQuote ? `<div class="risk-quote quote-truncate">"${escapeHtml(risk.sourceQuote)}"</div>` : ''}
    </article>
  `;
}

function renderKeyPoints(analysis) {
  const points = analysis.keyPoints || [];
  if (!points.length) return '';

  return `
    <div class="card">
      <div class="eyebrow">Key points</div>
      <h2>What you're agreeing to</h2>
      <ul class="key-points">
        ${points.map((point) => `<li>${escapeHtml(point.text || point)}</li>`).join('')}
      </ul>
    </div>
  `;
}

function renderConversation(analysis) {
  const conversation = analysis.conversation || [];
  const suggested = analysis.suggestedQuestions || [];

  return `
    <div class="card conversation">
      <div class="eyebrow">Q&amp;A</div>
      <h2>Ask about this document</h2>
      <p>Answers come only from the policy text. If something isn't covered, the chatbot will say so.</p>
      ${suggested.length ? `
        <div class="suggested-row">
          ${suggested.map((q) => `<button class="suggested-btn" data-action="ask-suggested" data-question="${escapeAttribute(q)}">${escapeHtml(q)}</button>`).join('')}
        </div>` : ''}
      <div class="messages">
        ${conversation.length ? conversation.map(renderMessage).join('') : (!state.pendingQuestion ? '<p class="subtitle" style="font-size:12.5px">No questions yet. Try one of the suggestions, or ask your own.</p>' : '')}
        ${state.pendingQuestion ? `
          ${renderMessage({ role: 'user', text: state.pendingQuestion })}
          <div class="message">
            <div class="avatar avatar-assistant" aria-hidden="true">TL</div>
            <div class="message-bubble thinking-bubble">
              <div class="thinking-dots"><span></span><span></span><span></span></div>
              <span class="thinking-label">Thinking…</span>
            </div>
          </div>` : ''}
      </div>
      <form class="composer" data-action="ask-form">
        <input type="text" name="question" placeholder="Ask anything about this policy…" aria-label="Ask a question" ${state.asking ? 'disabled' : ''}>
        <button class="btn-primary" type="submit" aria-label="Ask" ${state.asking ? 'disabled' : ''}>${state.asking ? '<div class="spinner"></div>' : ICONS.send}</button>
      </form>
    </div>
  `;
}

function renderMessage(message) {
  const isUser = message.role === 'user';
  const ungrounded = !isUser && message.grounded === false;
  const role = isUser ? 'You' : (ungrounded ? 'Not in document' : 'From the document');
  const citations = (message.citations || []).filter((c) => c.quote);
  const avatar = isUser
    ? `<div class="avatar avatar-user" aria-hidden="true">U</div>`
    : `<div class="avatar avatar-assistant" aria-hidden="true">TL</div>`;

  return `
    <div class="message ${isUser ? 'user' : ''} ${ungrounded ? 'ungrounded' : ''}" aria-label="${escapeAttribute(role)}">
      ${avatar}
      <div class="message-bubble">
        <div>${escapeHtml(message.text || '')}</div>
        ${citations.length ? `
          <div class="citations">
            ${citations.map((c) => `<button class="citation-chip" data-action="open-citation" data-section-index="${escapeAttribute(c.sectionIndex ?? '')}" title="${escapeAttribute(c.quote)}">${escapeHtml(truncate(c.quote, 60))}</button>`).join('')}
          </div>` : ''}
      </div>
    </div>
  `;
}

function formatCategory(value) {
  if (!value) return 'Risk';
  return String(value).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ===== Settings =====

function renderSettings() {
  const draft = state.draftConfig || state.llmConfig || {};
  const providerInfo = state.providers['gemini'] || {};
  const models = state.modelList || [];
  const modelsStatus = state.modelListLoading
    ? '<span class="pill" style="margin-left:6px;font-size:10px">loading…</span>'
    : (!models.length && !state.modelListError ? '<span class="pill" style="margin-left:6px;font-size:10px">paste key to load</span>' : '');

  return `
    <div class="card">
      <div class="eyebrow">Gemini API</div>
      <h2>Connect your Google AI Studio key</h2>

      <div class="field">
        <label>API key ${state.modelListLoading ? '<span class="pill" style="margin-left:6px;font-size:10px">loading models…</span>' : ''}</label>
        <div class="input-with-button">
          <input type="${state.showApiKey ? 'text' : 'password'}" name="apiKey" value="${escapeAttribute(draft.apiKey || '')}" placeholder="${escapeAttribute(state.apiKeyConfigured ? '••••••••••' : 'Paste your AIza… key')}" autocomplete="off" spellcheck="false">
          <button class="btn-secondary" type="button" data-action="toggle-show-key">${state.showApiKey ? 'Hide' : 'Show'}</button>
        </div>
        <div class="field-help">
          <a href="${escapeAttribute(providerInfo.keyHelpUrl || 'https://aistudio.google.com/app/apikey')}" target="_blank" rel="noopener">Get a free Gemini key at Google AI Studio →</a>
        </div>
      </div>

      <div class="field">
        <label>Analysis model ${modelsStatus}</label>
        ${renderCustomSelect(
          'analysisModel',
          models.length ? buildSortedOptions(models, 'analysis') : [{ value: '', label: 'Paste API key above — models load automatically' }],
          draft.analysisModel || '',
          !models.length
        )}
        <div class="field-help">Used for full document summary &amp; risks.</div>
      </div>

      <div class="field">
        <label>Chat model</label>
        ${renderCustomSelect(
          'chatModel',
          models.length ? buildSortedOptions(models, 'chat') : [{ value: '', label: 'Paste API key above — models load automatically' }],
          draft.chatModel || '',
          !models.length
        )}
        <div class="field-help">Used for follow-up Q&amp;A. Faster model is fine.</div>
      </div>

      <div class="field">
        <label>Custom base URL (optional)</label>
        <input type="text" name="baseUrlOverride" value="${escapeAttribute(draft.baseUrlOverride || '')}" placeholder="${escapeAttribute(providerInfo.defaultBaseUrl || '')}" spellcheck="false">
        <div class="field-help">Leave blank unless using a custom proxy.</div>
      </div>

      ${state.modelListError ? `<div class="test-result error">${escapeHtml(state.modelListError)}</div>` : ''}

      <div class="btn-row" style="margin-top: var(--space-3)">
        <button class="btn-primary" data-action="save-config">${ICONS.check}<span>Save</span></button>
        <button class="btn-secondary" data-action="refresh-models">${state.modelListLoading ? '<div class="spinner" style="border-color:rgba(139,92,246,0.3);border-top-color:var(--accent)"></div><span>Loading…</span>' : `${ICONS.refresh}<span>Refresh models</span>`}</button>
        <button class="btn-secondary" data-action="test-key" ${state.testing ? 'disabled' : ''}>${state.testing ? '<div class="spinner" style="border-color:rgba(139,92,246,0.3);border-top-color:var(--accent)"></div><span>Testing…</span>' : `${ICONS.zap}<span>Test key</span>`}</button>
      </div>

      ${renderTestResult()}

      <div class="field" style="margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--line)">
        <label class="toggle">
          <input type="checkbox" name="autoPopupOnSignup" ${state.uiPrefs.autoPopupOnSignup ? 'checked' : ''}>
          Show floating prompt on signup pages
        </label>
        <label class="toggle" style="margin-top: var(--space-2)">
          <input type="checkbox" name="autoOpen" ${state.uiPrefs.autoOpen ? 'checked' : ''}>
          Auto-open side panel on policy pages
        </label>
      </div>
    </div>

    <div class="card">
      <div class="eyebrow">Privacy</div>
      <h2>How your data is handled</h2>
      <ul class="key-points">
        <li>Your API key is stored locally in this browser profile only.</li>
        <li>Page text is sent to your selected provider over HTTPS only when you click Analyze.</li>
        <li>Don't install on a shared computer where you don't trust other extensions.</li>
      </ul>
    </div>
  `;
}

function renderModelOptions(models, selected, kind) {
  const sorted = [
    ...models.filter((id) => isRecommended(id, kind)),
    ...models.filter((id) => !isRecommended(id, kind)),
  ];
  return sorted.map((id) => `<option value="${escapeAttribute(id)}" ${selected === id ? 'selected' : ''}>${escapeHtml(id)}${isRecommended(id, kind) ? ' ★' : ''}</option>`).join('');
}

function buildSortedOptions(models, kind) {
  return [
    ...models.filter((id) => isRecommended(id, kind)),
    ...models.filter((id) => !isRecommended(id, kind)),
  ].map((id) => ({ value: id, label: id, recommended: isRecommended(id, kind) }));
}

function renderCustomSelect(name, options, selected, disabled) {
  const selectedOpt = options.find((o) => o.value === selected);
  const displayLabel = selectedOpt ? selectedOpt.label : (options[0]?.label || '—');
  return `
    <div class="custom-select${disabled ? ' custom-select-disabled' : ''}" data-name="${escapeAttribute(name)}">
      <button class="custom-select-trigger" type="button" ${disabled ? 'disabled' : ''} aria-haspopup="listbox" aria-expanded="false">
        <span class="custom-select-value">${escapeHtml(displayLabel)}</span>
        <svg class="custom-select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="custom-select-dropdown" role="listbox">
        ${options.map((o) => `
          <div class="custom-select-option${o.value === selected ? ' selected' : ''}"
               data-value="${escapeAttribute(o.value)}"
               role="option"
               aria-selected="${o.value === selected}">
            <span class="custom-select-option-label">${escapeHtml(o.label)}</span>
            ${o.recommended ? '<span class="custom-select-star">★</span>' : ''}
          </div>`).join('')}
      </div>
    </div>
  `;
}

function isRecommended(id, kind) {
  const geminiAnalysis = ['gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash', 'gemini-2.5-pro'];
  const geminiChat = ['gemini-3.1-flash-lite', 'gemini-3-flash', 'gemini-2.5-flash-lite'];
  return (kind === 'chat' ? geminiChat : geminiAnalysis).includes(id);
}

function renderTestResult() {
  if (!state.testResult) return '';
  if (state.testResult.success) {
    return `<div class="test-result success">Key works ✓ ${state.testResult.sample ? `Model replied: "${escapeHtml(truncate(state.testResult.sample, 60))}"` : ''}</div>`;
  }
  return `<div class="test-result error">${escapeHtml(state.testResult.error || 'Test failed')}</div>`;
}

// ===== Events =====

function bindEvents() {
  app.querySelectorAll('[data-action="go-settings"]').forEach((btn) => btn.addEventListener('click', () => {
    state.view = 'settings';
    state.draftConfig = state.draftConfig || { ...(state.llmConfig || {}), apiKey: '' };
    state.testResult = null;
    render();
  }));

  app.querySelectorAll('[data-action="go-main"]').forEach((btn) => btn.addEventListener('click', () => {
    state.view = 'main';
    state.draftConfig = null;
    state.testResult = null;
    render();
  }));

  app.querySelectorAll('[data-action="analyze"]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await sendMessage({ type: 'RUN_ANALYSIS' });
    } catch (error) {
      console.error('Analysis failed:', error);
    }
  }));

  app.querySelectorAll('[data-action="ask-suggested"]').forEach((btn) => btn.addEventListener('click', async () => {
    await submitQuestion(btn.dataset.question || '');
  }));

  app.querySelectorAll('[data-action="open-citation"]').forEach((btn) => btn.addEventListener('click', async () => {
    const sectionIndex = btn.dataset.sectionIndex;
    await sendMessage({
      type: 'OPEN_CITATION',
      sectionIndex: sectionIndex !== '' ? Number(sectionIndex) : null,
    }).catch((e) => console.error('Open citation:', e));
  }));

  app.querySelector('[data-action="ask-form"]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = event.currentTarget.elements.question;
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    await submitQuestion(question);
  });

  // Settings events — API key: update draft + auto-load models after short debounce
  let _keyDebounce = null;
  const apiKeyInput = app.querySelector('input[name="apiKey"]');
  if (apiKeyInput) {
    apiKeyInput.addEventListener('input', (event) => {
      const key = event.target.value;
      state.draftConfig = { ...(state.draftConfig || state.llmConfig), provider: 'gemini', apiKey: key };
      clearTimeout(_keyDebounce);
      if (key.length >= 20) {
        _keyDebounce = setTimeout(() => {
          refreshModelList(false, 'gemini', key);
        }, 600);
      }
    });
    apiKeyInput.addEventListener('blur', (event) => {
      const key = event.target.value;
      clearTimeout(_keyDebounce);
      if (key.length >= 20 && !state.modelListLoading) {
        refreshModelList(false, 'gemini', key);
      }
    });
  }

  // Custom select — toggle open/close
  app.querySelectorAll('.custom-select-trigger').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const select = trigger.closest('.custom-select');
      const isOpen = select.classList.contains('open');
      app.querySelectorAll('.custom-select.open').forEach((s) => {
        s.classList.remove('open');
        s.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false');
      });
      if (!isOpen) {
        select.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
  });

  // Custom select — option pick
  app.querySelectorAll('.custom-select-option').forEach((option) => {
    option.addEventListener('click', () => {
      const select = option.closest('.custom-select');
      const name = select.dataset.name;
      const value = option.dataset.value;
      const label = option.querySelector('.custom-select-option-label')?.textContent || value;
      select.querySelector('.custom-select-value').textContent = label;
      select.querySelectorAll('.custom-select-option').forEach((o) => {
        o.classList.toggle('selected', o.dataset.value === value);
        o.setAttribute('aria-selected', String(o.dataset.value === value));
      });
      select.classList.remove('open');
      select.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false');
      if (name === 'analysisModel') {
        state.draftConfig = { ...(state.draftConfig || state.llmConfig), analysisModel: value };
      } else if (name === 'chatModel') {
        state.draftConfig = { ...(state.draftConfig || state.llmConfig), chatModel: value };
      }
    });
  });

  // Close custom selects on outside click
  if (_outsideClickHandler) document.removeEventListener('click', _outsideClickHandler);
  _outsideClickHandler = (e) => {
    if (!e.target.closest('.custom-select')) {
      app.querySelectorAll('.custom-select.open').forEach((s) => {
        s.classList.remove('open');
        s.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false');
      });
    }
  };
  document.addEventListener('click', _outsideClickHandler);

  app.querySelector('input[name="baseUrlOverride"]')?.addEventListener('input', (event) => {
    state.draftConfig = { ...(state.draftConfig || state.llmConfig), baseUrlOverride: event.target.value };
  });

  app.querySelector('[data-action="toggle-show-key"]')?.addEventListener('click', () => {
    state.showApiKey = !state.showApiKey;
    render();
  });

  app.querySelector('[data-action="save-config"]')?.addEventListener('click', async () => {
    if (!state.draftConfig) return;
    const config = {
      provider: 'gemini',
      analysisModel: state.draftConfig.analysisModel,
      chatModel: state.draftConfig.chatModel,
      baseUrlOverride: state.draftConfig.baseUrlOverride || '',
    };
    if (state.draftConfig.apiKey && state.draftConfig.apiKey.length > 4) {
      config.apiKey = state.draftConfig.apiKey;
    }
    try {
      await sendMessage({ type: 'SAVE_LLM_CONFIG', config });
      state.draftConfig = null;
      state.view = 'main';
      await refreshState();
    } catch (error) {
      state.testResult = { success: false, error: error.message };
      render();
    }
  });

  app.querySelector('[data-action="refresh-models"]')?.addEventListener('click', async () => {
    const draft = state.draftConfig || state.llmConfig;
    await refreshModelList(true, 'gemini', draft?.apiKey || null);
  });

  app.querySelector('[data-action="test-key"]')?.addEventListener('click', async () => {
    state.testing = true;
    state.testResult = null;
    render();
    try {
      const draft = state.draftConfig || state.llmConfig;
      const response = await sendMessage({
        type: 'TEST_KEY',
        provider: 'gemini',
        apiKey: draft.apiKey || undefined,
        model: draft.analysisModel,
        baseUrlOverride: draft.baseUrlOverride || '',
      });
      state.testResult = response.success ? { success: true, sample: response.sample } : { success: false, error: response.error };
    } catch (error) {
      state.testResult = { success: false, error: error.message };
    } finally {
      state.testing = false;
      render();
    }
  });

  app.querySelector('input[name="autoPopupOnSignup"]')?.addEventListener('change', async (event) => {
    await sendMessage({ type: 'SAVE_UI_PREFS', prefs: { autoPopupOnSignup: event.target.checked } });
    await refreshState();
  });

  app.querySelector('input[name="autoOpen"]')?.addEventListener('change', async (event) => {
    await sendMessage({ type: 'SAVE_UI_PREFS', prefs: { autoOpen: event.target.checked } });
    await refreshState();
  });
}

async function refreshModelList(force, _provider, apiKey) {
  state.modelListLoading = true;
  state.modelListError = null;
  render();
  try {
    const response = await sendMessage({
      type: 'LIST_MODELS',
      force,
      provider: 'gemini',
      apiKey,
    });
    state.modelList = response.models || [];
    if (state.draftConfig) {
      if (!state.draftConfig.analysisModel || !state.modelList.includes(state.draftConfig.analysisModel)) {
        state.draftConfig.analysisModel = response.recommendedAnalysis || state.modelList[0] || '';
      }
      if (!state.draftConfig.chatModel || !state.modelList.includes(state.draftConfig.chatModel)) {
        state.draftConfig.chatModel = response.recommendedChat || state.modelList[0] || '';
      }
    }
    if (response.error) state.modelListError = response.error;
  } catch (error) {
    state.modelListError = error.message;
  } finally {
    state.modelListLoading = false;
    render();
  }
}

async function submitQuestion(question) {
  if (!question) return;
  state.asking = true;
  state.pendingQuestion = question;
  render();
  try {
    await sendMessage({ type: 'ASK_FOLLOWUP', question });
  } catch (error) {
    state.page = state.page || {};
    state.page.lastError = error.message;
  } finally {
    state.asking = false;
    state.pendingQuestion = null;
    await refreshState();
  }
}

// ===== Helpers =====

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function truncate(value, maxLen) {
  const s = String(value || '');
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}
