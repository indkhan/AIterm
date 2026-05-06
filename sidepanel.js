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
};

const app = document.getElementById('app');

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
  app.innerHTML = renderShell();
  bindEvents();
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
        ${inSettings ? '←' : '⚙'}
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
    <div class="footnote">Analysis powered by your Gemini key. Page text leaves your browser only when you click Analyze.</div>
  `;
}

function renderOnboardingBanner() {
  return `
    <div class="banner">
      <div class="banner-icon">!</div>
      <div>
        <h3>Add your API key to start</h3>
        <p>Terms Lens runs entirely from your browser using your own Gemini key. Free tier available — get a key from Google AI Studio in under a minute.</p>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn-primary" data-action="go-settings">Open settings</button>
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
      <div class="eyebrow">${escapeHtml(pageType)}</div>
      <h1>${escapeHtml(title)}</h1>
      <p class="subtitle">${escapeHtml(url)}</p>
      <div class="status-row" style="margin-top:12px">
        ${signupCount ? `<span class="pill pill-accent">Signup form detected</span>` : ''}
        ${linkCount ? `<span class="pill">${linkCount} policy link${linkCount === 1 ? '' : 's'} found</span>` : ''}
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
      <div class="card" style="border-color: rgba(185,28,28,0.2)">
        <div class="eyebrow" style="color: var(--danger)">Analysis stopped</div>
        <h2>Something went wrong</h2>
        <p>${escapeHtml(page.lastError || 'Unknown error')}</p>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn-primary" data-action="analyze">Try again</button>
          <button class="btn-secondary" data-action="go-settings">Settings</button>
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
      <div class="eyebrow">In progress</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(detail)}</p>
      <div class="progress">
        <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        <span class="progress-text">${pct}%</span>
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
      <h2>No policy detected here</h2>
      <p>Open a Terms, Privacy, or signup page to analyze. Or run analysis on the visible text anyway.</p>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn-secondary" data-action="analyze">Analyze visible text</button>
      </div>
    `;
  }

  const description = signupCount
    ? `This signup form links to ${linkCount} policy page${linkCount === 1 ? '' : 's'}. Click Analyze to read them for you.`
    : linkCount
      ? `Found ${linkCount} policy link${linkCount === 1 ? '' : 's'}. Click Analyze to fetch and summarize.`
      : `This looks like a policy page. Click Analyze to summarize.`;

  return `
    <h2>Ready to analyze</h2>
    <p>${escapeHtml(description)}</p>
    <div class="btn-row" style="margin-top:8px">
      <button class="btn-primary" data-action="analyze">Analyze policy</button>
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
      <button class="btn-secondary" data-action="analyze">Re-run analysis</button>
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
        ${conversation.length ? conversation.map(renderMessage).join('') : '<p class="subtitle" style="font-size:12.5px">No questions yet. Try one of the suggestions, or ask your own.</p>'}
      </div>
      <form class="composer" data-action="ask-form">
        <input type="text" name="question" placeholder="Ask anything about this policy..." aria-label="Ask a question" ${state.asking ? 'disabled' : ''}>
        <button class="btn-primary" type="submit" ${state.asking ? 'disabled' : ''}>${state.asking ? 'Asking…' : 'Ask'}</button>
      </form>
    </div>
  `;
}

function renderMessage(message) {
  const isUser = message.role === 'user';
  const ungrounded = !isUser && message.grounded === false;
  const role = isUser ? 'You' : (ungrounded ? 'Not in document' : 'From the document');
  const citations = (message.citations || []).filter((c) => c.quote);

  return `
    <div class="message ${isUser ? 'user' : ''} ${ungrounded ? 'ungrounded' : ''}">
      <div class="message-role">${escapeHtml(role)}</div>
      <div>${escapeHtml(message.text || '')}</div>
      ${citations.length ? `
        <div class="citations">
          ${citations.map((c) => `<button class="citation-chip" data-action="open-citation" data-section-index="${escapeAttribute(c.sectionIndex ?? '')}" title="${escapeAttribute(c.quote)}">${escapeHtml(truncate(c.quote, 60))}</button>`).join('')}
        </div>` : ''}
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
        <select name="analysisModel" ${!models.length ? 'disabled' : ''}>
          ${models.length ? renderModelOptions(models, draft.analysisModel, 'analysis') : '<option>Paste API key above — models load automatically</option>'}
        </select>
        <div class="field-help">Used for full document summary &amp; risks.</div>
      </div>

      <div class="field">
        <label>Chat model</label>
        <select name="chatModel" ${!models.length ? 'disabled' : ''}>
          ${models.length ? renderModelOptions(models, draft.chatModel, 'chat') : '<option>Paste API key above — models load automatically</option>'}
        </select>
        <div class="field-help">Used for follow-up Q&amp;A. Faster model is fine.</div>
      </div>

      <div class="field">
        <label>Custom base URL (optional)</label>
        <input type="text" name="baseUrlOverride" value="${escapeAttribute(draft.baseUrlOverride || '')}" placeholder="${escapeAttribute(providerInfo.defaultBaseUrl || '')}" spellcheck="false">
        <div class="field-help">Leave blank unless using a custom proxy.</div>
      </div>

      ${state.modelListError ? `<div class="test-result error">${escapeHtml(state.modelListError)}</div>` : ''}

      <div class="btn-row" style="margin-top: var(--space-3)">
        <button class="btn-primary" data-action="save-config">Save</button>
        <button class="btn-secondary" data-action="refresh-models">${state.modelListLoading ? 'Loading…' : 'Refresh models'}</button>
        <button class="btn-secondary" data-action="test-key" ${state.testing ? 'disabled' : ''}>${state.testing ? 'Testing…' : 'Test key'}</button>
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
        <li>Nothing is sent to Anthropic, the extension author, or any third party.</li>
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

  app.querySelector('select[name="analysisModel"]')?.addEventListener('change', (event) => {
    state.draftConfig = { ...(state.draftConfig || state.llmConfig), analysisModel: event.target.value };
  });

  app.querySelector('select[name="chatModel"]')?.addEventListener('change', (event) => {
    state.draftConfig = { ...(state.draftConfig || state.llmConfig), chatModel: event.target.value };
  });

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
  render();
  try {
    await sendMessage({ type: 'ASK_FOLLOWUP', question });
  } catch (error) {
    state.page = state.page || {};
    state.page.lastError = error.message;
  } finally {
    state.asking = false;
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
