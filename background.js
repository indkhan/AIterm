import {
  DEFAULT_PREFS,
  HIGH_CONFIDENCE_THRESHOLD,
  PAGE_TYPE_LABELS,
  STORAGE_KEYS,
} from './shared/config.js';

const ANALYSIS_SCHEMA_VERSION = 2;
const HTML_TEXT_TAGS = ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'td', 'th', 'blockquote'];
const POLICY_TAG_HINT = /(terms|conditions|privacy|cookies?|policy|legal|consent|refund|billing|acceptable use|eula)/i;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await ensurePrefs();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensurePrefs();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await inspectTab(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    await clearTabState(tabId);
    return;
  }

  if (changeInfo.status === 'complete' || changeInfo.url) {
    await inspectTab(tabId, tab);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearTabState(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error('Terms Lens error:', error);
      sendResponse({
        ok: false,
        error: error.message || 'Unknown error',
      });
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'OPEN_SIDE_PANEL': {
      const tabId = sender.tab?.id ?? message.tabId;
      if (!tabId) {
        throw new Error('Missing tabId');
      }
      await chrome.sidePanel.open({ tabId });
      return {};
    }
    case 'GET_PANEL_STATE': {
      const tabId = await resolveActiveTabId(message.tabId);
      return await buildPanelState(tabId);
    }
    case 'RUN_ANALYSIS': {
      const tabId = await resolveActiveTabId(message.tabId);
      return await runAnalysis(tabId, message.policyUrl || null);
    }
    case 'ASK_FOLLOWUP': {
      const tabId = await resolveActiveTabId(message.tabId);
      return await askFollowup(tabId, message.question || '');
    }
    case 'OPEN_CITATION': {
      const tabId = await resolveActiveTabId(message.tabId);
      const state = await readTabState(tabId);
      if (state?.analysisSource?.type === 'linked-policy-fetch' && state.analysisSource.url) {
        await chrome.tabs.create({ url: state.analysisSource.url });
        return {};
      }
      await ensureContentScript(tabId);
      await chrome.tabs.sendMessage(tabId, {
        type: 'JUMP_TO_CITATION',
        clauseId: message.clauseId,
      });
      await updateTabState(tabId, { activeClauseId: message.clauseId });
      await broadcastState(tabId);
      return {};
    }
    case 'SAVE_PREFS': {
      const prefs = await getPrefs();
      const nextPrefs = {
        ...prefs,
        ...message.prefs,
      };
      await chrome.storage.local.set({ [STORAGE_KEYS.localPrefs]: nextPrefs });
      return { prefs: nextPrefs };
    }
    default:
      throw new Error(`Unsupported message type: ${message.type}`);
  }
}

async function ensurePrefs() {
  const prefs = await getPrefs();
  if (!prefs.apiBaseUrl) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.localPrefs]: { ...DEFAULT_PREFS, ...prefs },
    });
  }
}

async function getPrefs() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.localPrefs);
  return {
    ...DEFAULT_PREFS,
    ...(stored[STORAGE_KEYS.localPrefs] || {}),
  };
}

async function resolveActiveTabId(tabId) {
  if (tabId) {
    return tabId;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab found');
  }

  return tab.id;
}

function isHttpUrl(url = '') {
  return /^https?:/i.test(url);
}

function tabStateKey(tabId) {
  return `${STORAGE_KEYS.tabStatePrefix}${tabId}`;
}

async function readTabState(tabId) {
  const stored = await chrome.storage.session.get(tabStateKey(tabId));
  return stored[tabStateKey(tabId)] || null;
}

async function writeTabState(tabId, value) {
  await chrome.storage.session.set({ [tabStateKey(tabId)]: value });
}

async function clearTabState(tabId) {
  await chrome.storage.session.remove(tabStateKey(tabId));
  await chrome.sidePanel.setOptions({
    tabId,
    enabled: false,
    path: 'sidepanel.html',
  }).catch(() => {});
}

async function updateTabState(tabId, patch) {
  const current = (await readTabState(tabId)) || {};
  const next = {
    ...current,
    ...patch,
  };
  await writeTabState(tabId, next);
  return next;
}

async function inspectTab(tabId, tab = null) {
  const resolvedTab = tab || (await chrome.tabs.get(tabId));
  const url = resolvedTab?.url || '';

  if (!isHttpUrl(url)) {
    await clearTabState(tabId);
    return;
  }

  await ensureContentScript(tabId);

  let detection;
  try {
    detection = await chrome.tabs.sendMessage(tabId, { type: 'DETECT_PAGE' });
  } catch (_error) {
    detection = {
      isLegalPage: false,
      pageType: 'generic',
      confidence: 0,
      signals: ['content-script-unavailable'],
      title: resolvedTab?.title || '',
      url,
      hasInlineLegalText: false,
      hasLegalLinks: false,
      bestPolicySource: 'current-page',
      linkedPolicies: [],
    };
  }

  const previous = await readTabState(tabId);
  const state = await updateTabState(tabId, {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    url,
    title: resolvedTab?.title || detection.title || '',
    detection,
    analysis: previous?.analysis || null,
    extraction: previous?.extraction || null,
    analysisSource: previous?.analysisSource || null,
    linkedPolicyCandidates: detection.linkedPolicies || [],
    linkedPolicyCache: previous?.linkedPolicyCache || {},
    analysisStatus: detection.isLegalPage || detection.hasLegalLinks ? (previous?.analysis ? 'ready' : 'idle') : 'not-legal',
    lastError: null,
    activeClauseId: previous?.activeClauseId || null,
  });

  await chrome.sidePanel.setOptions({
    tabId,
    enabled: true,
    path: 'sidepanel.html',
  });

  const prefs = await getPrefs();
  if ((detection.isLegalPage || detection.hasLegalLinks) && detection.confidence >= HIGH_CONFIDENCE_THRESHOLD && prefs.autoOpen) {
    await chrome.sidePanel.open({ tabId });
  }

  await broadcastState(tabId, state);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return;
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  }
}

async function buildPanelState(tabId) {
  const prefs = await getPrefs();
  const state = await readTabState(tabId);
  const tab = await chrome.tabs.get(tabId);

  return {
    tabId,
    prefs,
    page: state || {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      url: tab?.url || '',
      title: tab?.title || '',
      detection: null,
      extraction: null,
      analysis: null,
      analysisSource: null,
      linkedPolicyCandidates: [],
      analysisStatus: 'idle',
      lastError: null,
      activeClauseId: null,
    },
    labels: PAGE_TYPE_LABELS,
  };
}

async function runAnalysis(tabId, requestedPolicyUrl = null) {
  const current = await readTabState(tabId);
  const tab = await chrome.tabs.get(tabId);

  if (!tab?.url || !isHttpUrl(tab.url)) {
    throw new Error('Analysis is only available on HTTP(S) pages.');
  }

  await ensureContentScript(tabId);
  const extraction = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE' });
  const linkedPolicyCandidates = extraction.linkedPolicies || [];

  await updateTabState(tabId, {
    extraction,
    linkedPolicyCandidates,
    analysisStatus: 'loading',
    lastError: null,
  });
  await broadcastState(tabId);

  const { sourceInput, analysisSource, updatedCache, fallbackError } = await resolveAnalysisInput(
    tab.url,
    extraction,
    current?.linkedPolicyCache || {},
    requestedPolicyUrl,
  );

  if (!sourceInput || !sourceInput.sections?.length) {
    const noContentMessage = linkedPolicyCandidates.length
      ? (fallbackError || 'Policy links were found, but Terms Lens could not extract usable content from this page or its linked policy pages.')
      : 'No usable policy sections were found on this page.';
    const errorState = await updateTabState(tabId, {
      detection: extraction.detection,
      extraction,
      linkedPolicyCandidates,
      linkedPolicyCache: updatedCache,
      analysisSource: null,
      analysisStatus: 'error',
      lastError: noContentMessage,
    });
    await broadcastState(tabId, errorState);
    throw new Error(noContentMessage);
  }

  const prefs = await getPrefs();

  try {
    const response = await fetch(`${prefs.apiBaseUrl.replace(/\/$/, '')}/v1/analyze-page`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: sourceInput.url,
        metadata: sourceInput.metadata,
        sections: sourceInput.sections,
        detection: sourceInput.detection,
        sourceContext: analysisSource.type,
        originPageUrl: tab.url,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Analysis request failed');
    }

    const nextState = await updateTabState(tabId, {
      detection: extraction.detection,
      extraction,
      analysisStatus: 'ready',
      analysis: payload,
      analysisSource,
      linkedPolicyCandidates,
      linkedPolicyCache: updatedCache,
      lastError: null,
      activeClauseId: null,
    });

    await broadcastState(tabId, nextState);
    return { analysis: payload };
  } catch (error) {
    const nextState = await updateTabState(tabId, {
      detection: extraction.detection,
      extraction,
      linkedPolicyCandidates,
      linkedPolicyCache: updatedCache,
      analysisSource,
      analysisStatus: 'error',
      lastError: error.message || 'Analysis failed',
    });
    await broadcastState(tabId, nextState);
    throw error;
  }
}

async function resolveAnalysisInput(originPageUrl, extraction, cache, requestedPolicyUrl) {
  const updatedCache = { ...cache };
  const currentPreferred = isStrongCurrentExtraction(extraction);
  const candidateList = rankLinkedPolicies(extraction.linkedPolicies || [], requestedPolicyUrl);

  if (!requestedPolicyUrl && currentPreferred) {
    return {
      sourceInput: extraction,
      analysisSource: describeCurrentSource(extraction),
      updatedCache,
      fallbackError: null,
    };
  }

  for (const policy of candidateList) {
    const cached = updatedCache[policy.url];
    if (cached?.sections?.length) {
      return {
        sourceInput: cached,
        analysisSource: {
          type: 'linked-policy-fetch',
          label: policy.label || policy.pageType,
          pageType: policy.pageType,
          url: policy.url,
          originPageUrl,
        },
        updatedCache,
        fallbackError: null,
      };
    }

    try {
      const fetched = await fetchLinkedPolicyExtraction(policy, originPageUrl);
      if (fetched?.sections?.length) {
        updatedCache[policy.url] = fetched;
        return {
          sourceInput: fetched,
          analysisSource: {
            type: 'linked-policy-fetch',
            label: policy.label || policy.pageType,
            pageType: policy.pageType,
            url: policy.url,
            originPageUrl,
          },
          updatedCache,
          fallbackError: null,
        };
      }
    } catch (_error) {
      updatedCache[policy.url] = { error: true };
    }
  }

  if (extraction.sections?.length) {
    return {
      sourceInput: extraction,
      analysisSource: describeCurrentSource(extraction),
      updatedCache,
      fallbackError: 'Linked policy pages were found but could not be fetched. Terms Lens fell back to the visible page.',
    };
  }

  return {
    sourceInput: null,
    analysisSource: null,
    updatedCache,
    fallbackError: 'Policy links were found but none of the linked pages produced usable policy content.',
  };
}

function describeCurrentSource(extraction) {
  const sourceHints = extraction.sourceHints || [];
  if (sourceHints.includes('cookie-banner') || sourceHints.includes('modal') || extraction.detection?.bestPolicySource === 'current-page-inline') {
    return {
      type: 'current-page-inline',
      label: extraction.detection?.pageType || 'inline policy',
      pageType: extraction.detection?.pageType || 'generic',
      url: extraction.url,
      originPageUrl: extraction.url,
    };
  }

  return {
    type: 'current-page',
    label: extraction.detection?.pageType || 'current page',
    pageType: extraction.detection?.pageType || 'generic',
    url: extraction.url,
    originPageUrl: extraction.url,
  };
}

function isStrongCurrentExtraction(extraction) {
  const sectionCount = extraction.sections?.length || 0;
  const wordCount = extraction.metadata?.wordCount || 0;
  const sourceHints = extraction.sourceHints || [];
  return (
    sectionCount >= 2 ||
    wordCount >= 160 ||
    (sectionCount >= 1 && sourceHints.some((hint) => ['cookie-banner', 'inline-policy-copy', 'auth-page', 'modal'].includes(hint)))
  );
}

function rankLinkedPolicies(policies, requestedPolicyUrl) {
  const list = [...(policies || [])];
  list.sort((a, b) => {
    const aRequested = requestedPolicyUrl && a.url === requestedPolicyUrl ? 1 : 0;
    const bRequested = requestedPolicyUrl && b.url === requestedPolicyUrl ? 1 : 0;
    if (aRequested !== bRequested) {
      return bRequested - aRequested;
    }
    if (a.sameOrigin !== b.sameOrigin) {
      return a.sameOrigin ? -1 : 1;
    }
    return (b.confidence || 0) - (a.confidence || 0);
  });
  return list;
}

async function fetchLinkedPolicyExtraction(policy, originPageUrl) {
  const response = await fetch(policy.url, {
    method: 'GET',
    credentials: 'omit',
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${policy.url}`);
  }

  const html = await response.text();
  return extractPolicyFromHtml(html, policy, originPageUrl);
}

function extractPolicyFromHtml(html, policy, originPageUrl) {
  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return extractPolicyFromDocument(doc, policy, originPageUrl);
  }

  return extractPolicyFromFallbackHtml(html, policy, originPageUrl);
}

function extractPolicyFromDocument(doc, policy, originPageUrl) {
  doc.querySelectorAll('script, style, noscript, svg').forEach((node) => node.remove());
  const root = doc.querySelector('main, article, [role="main"], .policy, .legal, .content') || doc.body;
  const title = cleanText(doc.title || policy.label || '');
  const sections = extractSectionsFromStaticRoot(root);
  const text = cleanText(root?.innerText || '');
  return {
    url: policy.url,
    title,
    detection: {
      isLegalPage: true,
      pageType: policy.pageType || inferPolicyType(`${title} ${policy.url} ${text.slice(0, 1200)}`),
      confidence: Math.max(0.72, policy.confidence || 0.72),
      signals: ['linked-policy-fetch'],
      title,
      url: policy.url,
      hasInlineLegalText: false,
      hasLegalLinks: false,
      bestPolicySource: 'linked-policy-fetch',
      linkedPolicies: [],
    },
    metadata: {
      locale: doc.documentElement?.lang || 'unknown',
      wordCount: sections.reduce((total, section) => total + section.text.split(/\s+/).filter(Boolean).length, 0),
      extractedAt: new Date().toISOString(),
      sectionCount: sections.length,
    },
    sections,
    linkedPolicies: [],
    sourceHints: ['linked-policy-fetch'],
    originPageUrl,
  };
}

function extractPolicyFromFallbackHtml(html, policy, originPageUrl) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = cleanText(titleMatch ? stripHtml(titleMatch[1]) : policy.label || '');
  const text = cleanText(stripHtml(html));
  const sectionText = text.slice(0, 10000);
  const sections = sectionText
    ? [
        {
          id: 'linked-policy',
          heading: title || 'Policy document',
          text: sectionText,
          order: 0,
          citations: [],
          jumpTarget: 'body',
        },
      ]
    : [];

  return {
    url: policy.url,
    title,
    detection: {
      isLegalPage: true,
      pageType: policy.pageType || inferPolicyType(`${title} ${policy.url} ${sectionText.slice(0, 1200)}`),
      confidence: Math.max(0.72, policy.confidence || 0.72),
      signals: ['linked-policy-fetch-fallback'],
      title,
      url: policy.url,
      hasInlineLegalText: false,
      hasLegalLinks: false,
      bestPolicySource: 'linked-policy-fetch',
      linkedPolicies: [],
    },
    metadata: {
      locale: 'unknown',
      wordCount: sectionText.split(/\s+/).filter(Boolean).length,
      extractedAt: new Date().toISOString(),
      sectionCount: sections.length,
    },
    sections,
    linkedPolicies: [],
    sourceHints: ['linked-policy-fetch'],
    originPageUrl,
  };
}

function extractSectionsFromStaticRoot(root) {
  if (!root) {
    return [];
  }

  const nodes = Array.from(root.querySelectorAll(HTML_TEXT_TAGS.join(',')));
  const sections = [];
  let current = createStaticSection('Overview');
  let order = 0;

  for (const node of nodes) {
    const text = cleanText(node.textContent || '');
    if (!text) {
      continue;
    }

    if (/^H[1-4]$/.test(node.tagName)) {
      if (current.text.length >= 40) {
        current.order = order++;
        sections.push(current);
      }
      current = createStaticSection(text, buildStaticSelector(node));
      continue;
    }

    const entry = {
      clauseId: `${slugify(current.heading)}-${current.citations.length + 1}`,
      text,
      selector: buildStaticSelector(node),
    };
    current.citations.push(entry);
    current.text += `${text}\n\n`;
  }

  if (current.text.length >= 40) {
    current.order = order++;
    sections.push(current);
  }

  return sections.slice(0, 60);
}

function createStaticSection(heading, jumpTarget = 'body') {
  return {
    id: slugify(heading),
    heading,
    text: '',
    citations: [],
    jumpTarget,
    order: 0,
  };
}

function buildStaticSelector(node) {
  if (!node) {
    return 'body';
  }
  if (node.id) {
    return `#${escapeCss(node.id)}`;
  }
  const tag = node.tagName ? node.tagName.toLowerCase() : 'body';
  return tag;
}

async function askFollowup(tabId, question) {
  const trimmed = question.trim();
  if (!trimmed) {
    throw new Error('Question is required.');
  }

  const state = await readTabState(tabId);
  if (!state?.analysis?.analysisId) {
    throw new Error('Run an analysis before asking a question.');
  }

  const prefs = await getPrefs();
  const response = await fetch(`${prefs.apiBaseUrl.replace(/\/$/, '')}/v1/ask-followup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      analysisId: state.analysis.analysisId,
      question: trimmed,
      activeClauseId: state.activeClauseId || null,
      visibleCitations: collectVisibleCitationIds(state.analysis),
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Question request failed');
  }

  const conversation = [
    ...(state.analysis.conversation || []),
    {
      role: 'user',
      text: trimmed,
    },
    {
      role: 'assistant',
      text: payload.answer,
      citations: payload.citations || [],
      grounded: payload.grounded,
    },
  ];

  const nextAnalysis = {
    ...state.analysis,
    conversation,
  };

  const nextState = await updateTabState(tabId, {
    analysis: nextAnalysis,
    analysisStatus: 'ready',
    lastError: null,
  });

  await broadcastState(tabId, nextState);
  return payload;
}

function collectVisibleCitationIds(analysis) {
  const citations = new Set();
  for (const card of analysis.riskCards || []) {
    for (const citation of card.citations || []) {
      if (citation.clauseId) {
        citations.add(citation.clauseId);
      }
    }
  }

  for (const citation of analysis.summaryCitations || []) {
    if (citation.clauseId) {
      citations.add(citation.clauseId);
    }
  }

  return Array.from(citations);
}

async function broadcastState(tabId, state = null) {
  const payload = await buildPanelState(tabId);
  payload.page = state || payload.page;
  await chrome.runtime.sendMessage({
    type: 'PANEL_STATE_UPDATED',
    tabId,
    payload,
  }).catch(() => {});
}

function inferPolicyType(text) {
  if (/privacy|personal data|data policy/i.test(text)) return 'privacy';
  if (/cookie|consent/i.test(text)) return 'cookies';
  if (/refund|return|cancellation/i.test(text)) return 'refund';
  if (/terms|conditions|service/i.test(text)) return 'terms';
  return 'generic';
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'policy';
}

function escapeCss(value) {
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
