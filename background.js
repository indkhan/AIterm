import {
  DEFAULT_PREFS,
  HIGH_CONFIDENCE_THRESHOLD,
  PAGE_TYPE_LABELS,
  STORAGE_KEYS,
} from './shared/config.js';

const ANALYSIS_SCHEMA_VERSION = 1;

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
      return await runAnalysis(tabId);
    }
    case 'ASK_FOLLOWUP': {
      const tabId = await resolveActiveTabId(message.tabId);
      return await askFollowup(tabId, message.question || '');
    }
    case 'OPEN_CITATION': {
      const tabId = await resolveActiveTabId(message.tabId);
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
  } catch (error) {
    detection = {
      isLegalPage: false,
      pageType: 'generic',
      confidence: 0,
      signals: ['content-script-unavailable'],
      title: resolvedTab?.title || '',
      url,
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
    analysisStatus: detection.isLegalPage ? (previous?.analysis ? 'ready' : 'idle') : 'not-legal',
    lastError: null,
    activeClauseId: previous?.activeClauseId || null,
  });

  await chrome.sidePanel.setOptions({
    tabId,
    enabled: true,
    path: 'sidepanel.html',
  });

  const prefs = await getPrefs();
  if (detection.isLegalPage && detection.confidence >= HIGH_CONFIDENCE_THRESHOLD && prefs.autoOpen) {
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
      analysisStatus: 'idle',
      lastError: null,
      activeClauseId: null,
    },
    labels: PAGE_TYPE_LABELS,
  };
}

async function runAnalysis(tabId) {
  const current = await readTabState(tabId);
  const tab = await chrome.tabs.get(tabId);

  if (!tab?.url || !isHttpUrl(tab.url)) {
    throw new Error('Analysis is only available on HTTP(S) pages.');
  }

  await ensureContentScript(tabId);
  const extraction = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE' });
  const prefs = await getPrefs();

  await updateTabState(tabId, {
    extraction,
    analysisStatus: 'loading',
    lastError: null,
  });
  await broadcastState(tabId);

  try {
    const response = await fetch(`${prefs.apiBaseUrl.replace(/\/$/, '')}/v1/analyze-page`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: extraction.url,
        metadata: extraction.metadata,
        sections: extraction.sections,
        detection: current?.detection || extraction.detection,
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
      lastError: null,
      activeClauseId: null,
    });

    await broadcastState(tabId, nextState);
    return { analysis: payload };
  } catch (error) {
    const nextState = await updateTabState(tabId, {
      detection: extraction.detection,
      extraction,
      analysisStatus: 'error',
      lastError: error.message || 'Analysis failed',
    });
    await broadcastState(tabId, nextState);
    throw error;
  }
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
