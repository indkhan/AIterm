import { PAGE_TYPE_LABELS } from './shared/config.js';

const state = {
  tabId: null,
  prefs: {},
  page: null,
  labels: PAGE_TYPE_LABELS,
  asking: false,
};

const app = document.getElementById('app');

bootstrap().catch((error) => {
  console.error('Failed to start Terms Lens panel:', error);
  app.innerHTML = `<div class="shell"><section class="error-state"><h2>Panel failed to load</h2><p>${escapeHtml(error.message || 'Unknown error')}</p></section></div>`;
});

async function bootstrap() {
  bindRuntimeUpdates();
  await refreshState();
}

function bindRuntimeUpdates() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'PANEL_STATE_UPDATED') {
      return;
    }

    if (state.tabId && message.tabId !== state.tabId) {
      return;
    }

    Object.assign(state, message.payload);
    render();
  });
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_PANEL_STATE' });
  if (!response.ok) {
    throw new Error(response.error || 'Unable to fetch panel state');
  }
  Object.assign(state, response);
  render();
}

function render() {
  app.innerHTML = renderShell();
  bindEvents();
}

function renderShell() {
  const page = state.page || {};
  const detection = page.detection;
  const analysis = page.analysis;
  const pageTypeLabel = detection?.pageType ? (state.labels[detection.pageType] || detection.pageType) : 'Current page';
  const title = page.title || 'Current page';
  const statusText = getStatusText(page.analysisStatus, detection);

  return `
    <div class="shell">
      <section class="hero">
        <div class="eyebrow">Terms Lens</div>
        <h1>${escapeHtml(pageTypeLabel)}</h1>
        <p>${escapeHtml(title)}</p>
        <div class="status-row" style="margin-top:14px">
          <span class="status-pill">${escapeHtml(statusText)}</span>
          ${detection ? `<span class="status-pill">Confidence ${(detection.confidence * 100).toFixed(0)}%</span>` : ''}
          <span class="status-pill">Session only</span>
          ${page.analysisSource ? `<span class="status-pill">${escapeHtml(getSourceLabel(page.analysisSource))}</span>` : ''}
        </div>
        <div class="toolbar" style="margin-top:16px">
          <div class="button-row">
            <button class="primary-btn" data-action="analyze">${analysis ? 'Re-run analysis' : 'Analyze this page'}</button>
            ${analysis ? '<button class="soft-btn" data-action="refresh">Refresh state</button>' : ''}
          </div>
          <label class="toggle">
            <input type="checkbox" data-action="toggle-auto-open" ${state.prefs.autoOpen ? 'checked' : ''}>
            Auto-open on high-confidence policy pages
          </label>
        </div>
      </section>
      ${renderBody(page)}
    </div>
  `;
}

function renderBody(page) {
  if (!page.detection) {
    return renderLoadingState();
  }

  if (page.analysisStatus === 'loading') {
    return `
      <section class="panel">
        <h2>Analyzing this document</h2>
        <p class="muted">Reading visible legal text and all discovered linked Terms, Privacy, and Cookies pages in the background.</p>
        <div class="skeleton"></div>
        <div class="skeleton"></div>
        <div class="skeleton"></div>
      </section>
      ${renderTrustNote(page)}
    `;
  }

  if (page.analysisStatus === 'error') {
    return `
      <section class="error-state">
        <h2>Analysis unavailable</h2>
        <p>${escapeHtml(page.lastError || 'The backend could not analyze this page.')}</p>
        <div class="button-row" style="margin-top:12px">
          <button class="primary-btn" data-action="analyze">Try again</button>
        </div>
      </section>
      ${renderTrustNote(page)}
    `;
  }

  if (!page.detection.isLegalPage && !page.analysis) {
    return `
      <section class="empty-state">
        <h2>This page does not look like a policy page</h2>
        <p>The detector did not find a full standalone policy, but Terms Lens can still inspect inline legal text and automatically read discovered policy links in the background.</p>
        <div class="button-row" style="margin-top:12px">
          <button class="soft-btn" data-action="analyze">Analyze anyway</button>
        </div>
      </section>
      ${renderTrustNote(page)}
    `;
  }

  if (!page.analysis) {
    return `
      <section class="empty-state">
        <h2>Ready to review this document</h2>
        <p>Run analysis to inspect visible legal text and automatically read linked Terms, Privacy, and Cookies pages in the background.</p>
      </section>
      ${renderTrustNote(page)}
    `;
  }

  return `
    <div class="analysis-grid">
      <section class="panel">
        <div class="eyebrow">What matters most</div>
        <h2>Quick read</h2>
        <ul class="summary-list">
          ${(page.analysis.summary || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
        ${renderCitationRow(page.analysis.summaryCitations || [])}
      </section>
      <section class="panel">
        <div class="eyebrow">Risk cards</div>
        <h2>Watch for these terms</h2>
        <div class="cards">
          ${(page.analysis.riskCards || []).map(renderRiskCard).join('')}
        </div>
      </section>
      <section class="panel">
        <div class="eyebrow">Rights and obligations</div>
        <h2>What you can do</h2>
        <ul class="summary-list">
          ${(page.analysis.keyPoints || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </section>
      ${renderConversation(page.analysis)}
    </div>
    ${renderTrustNote(page)}
  `;
}

function renderRiskCard(card) {
  return `
    <article class="risk-card">
      <header>
        <div>
          <div class="eyebrow">${escapeHtml(card.category || 'Risk')}</div>
          <h3>${escapeHtml(card.title)}</h3>
        </div>
        <span class="severity severity-${escapeHtml(card.severity || 'low')}">${escapeHtml(card.severity || 'low')}</span>
      </header>
      <p>${escapeHtml(card.explanation)}</p>
      <footer>
        ${(card.citations || []).map(renderCitationChip).join('')}
      </footer>
    </article>
  `;
}

function renderConversation(analysis) {
  const conversation = analysis.conversation || [];
  return `
    <section class="conversation">
      <div class="eyebrow">Ask follow-up questions</div>
      <h2>Grounded Q&A</h2>
      <div class="chip-row" style="margin-bottom:14px">
        ${(analysis.suggestedQuestions || []).map((question) => `
          <button class="suggested-btn" data-action="ask-suggested" data-question="${escapeAttribute(question)}">${escapeHtml(question)}</button>
        `).join('')}
      </div>
      <div class="message-list">
        ${conversation.length ? conversation.map(renderMessage).join('') : '<div class="empty-state"><h2>No questions yet</h2><p>Ask about data sharing, cancellation, arbitration, refund rights, or account deletion.</p></div>'}
      </div>
      <form class="composer" data-action="ask-form">
        <input type="text" name="question" placeholder="Ask a grounded question about this policy" aria-label="Ask a grounded question about this policy">
        <button class="primary-btn" type="submit">${state.asking ? 'Asking...' : 'Ask'}</button>
      </form>
    </section>
  `;
}

function renderMessage(message) {
  const roleLabel = message.role === 'user' ? 'You' : (message.grounded === false ? 'Answer with caution' : 'Grounded answer');
  return `
    <article class="message ${message.role === 'user' ? 'message-user' : ''}">
      <header>${escapeHtml(roleLabel)}</header>
      <div>${escapeHtml(message.text)}</div>
      ${message.citations?.length ? `<footer>${message.citations.map(renderCitationChip).join('')}</footer>` : ''}
    </article>
  `;
}

function renderTrustNote(page) {
  const analysisSource = page.analysisSource;
  const groundedText = page.analysis?.groundingNote || 'Terms Lens sends extracted page sections to your configured analysis backend. Raw page text is kept only in session storage inside the extension by default.';
  const sourceText = analysisSource
    ? `Analysis source: ${getSourceLabel(analysisSource)}${analysisSource.url ? ` (${analysisSource.url})` : ''}.`
    : 'Analysis source: not selected yet.';

  return `
    <section class="panel trust-note">
      <div class="eyebrow">Trust layer</div>
      <p style="margin:0 0 8px 0">${escapeHtml(sourceText)}</p>
      <p style="margin:0">${escapeHtml(groundedText)}</p>
    </section>
  `;
}

function renderLoadingState() {
  return `
    <section class="panel">
      <h2>Loading page context</h2>
      <div class="skeleton"></div>
      <div class="skeleton"></div>
    </section>
  `;
}

function renderCitationRow(citations) {
  if (!citations.length) {
    return '';
  }
  return `<div class="chip-row" style="margin-top:14px">${citations.map(renderCitationChip).join('')}</div>`;
}

function renderCitationChip(citation) {
  return `<button class="citation-chip" data-action="open-citation" data-clause-id="${escapeAttribute(citation.clauseId || '')}" title="${escapeAttribute(citation.quoteSnippet || '')}">${escapeHtml(citation.label || citation.clauseId || 'Clause')}</button>`;
}

function bindEvents() {
  app.querySelectorAll('[data-action="analyze"]').forEach((button) => {
    button.addEventListener('click', async () => {
      await sendBackgroundMessage({ type: 'RUN_ANALYSIS' });
    });
  });

  app.querySelectorAll('[data-action="refresh"]').forEach((button) => {
    button.addEventListener('click', refreshState);
  });

  app.querySelectorAll('[data-action="open-citation"]').forEach((button) => {
    button.addEventListener('click', async () => {
      await sendBackgroundMessage({
        type: 'OPEN_CITATION',
        clauseId: button.dataset.clauseId,
      });
    });
  });

  app.querySelectorAll('[data-action="ask-suggested"]').forEach((button) => {
    button.addEventListener('click', async () => {
      await submitQuestion(button.dataset.question || '');
    });
  });

  app.querySelector('[data-action="ask-form"]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.question;
    const question = input.value.trim();
    if (!question) {
      return;
    }
    input.value = '';
    await submitQuestion(question);
  });

  app.querySelector('[data-action="toggle-auto-open"]')?.addEventListener('change', async (event) => {
    await sendBackgroundMessage({
      type: 'SAVE_PREFS',
      prefs: {
        autoOpen: event.currentTarget.checked,
      },
    });
    await refreshState();
  });
}

async function submitQuestion(question) {
  state.asking = true;
  render();
  try {
    await sendBackgroundMessage({
      type: 'ASK_FOLLOWUP',
      question,
    });
  } finally {
    state.asking = false;
    await refreshState();
  }
}

async function sendBackgroundMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response.ok) {
    throw new Error(response.error || 'Request failed');
  }
  return response;
}

function getStatusText(status, detection) {
  if (status === 'loading') {
    return 'Analyzing now';
  }
  if (status === 'ready') {
    return 'Analysis ready';
  }
  if (status === 'error') {
    return 'Analysis error';
  }
  if (status === 'not-legal') {
    return detection?.hasLegalLinks ? 'Linked policy detected' : 'Low legal-page confidence';
  }
  if (detection?.isLegalPage) {
    return 'Policy page detected';
  }
  if (detection?.hasLegalLinks) {
    return 'Linked policy detected';
  }
  return 'Ready';
}

function getSourceLabel(source) {
  if (!source) {
    return 'Source unknown';
  }
  if (source.type === 'linked-policy-fetch') {
    return `Using linked ${state.labels[source.pageType] || source.label || 'policy'}`;
  }
  if (source.type === 'current-page-inline') {
    return `Using inline ${state.labels[source.pageType] || source.label || 'policy'} text`;
  }
  return `Using current ${state.labels[source.pageType] || source.label || 'page'}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
