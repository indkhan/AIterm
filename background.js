import {
  DEFAULT_LLM_CONFIG,
  DEFAULT_UI_PREFS,
  HIGH_CONFIDENCE_THRESHOLD,
  MODEL_CACHE_TTL_MS,
  PAGE_TYPE_LABELS,
  POLICY_CACHE_TTL_MS,
  STORAGE_KEYS,
} from './shared/config.js';
import {
  callLLM,
  listModels,
  parseJsonContent,
  pickRecommendedModel,
  PROVIDERS,
} from './shared/llm-client.js';
import {
  buildLexicalIndex,
  estimateTokens,
  runLongDocAnalysis,
  topSections,
} from './shared/long-doc.js';
import { fetchPolicyContent } from './shared/policy-fetch.js';
import { buildQAMessages } from './shared/prompts.js';

const SCHEMA_VERSION = 3;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await ensureDefaults();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await inspectTab(tabId).catch((e) => console.debug('Terms Lens inspect:', e?.message));
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    await clearTabState(tabId);
    return;
  }
  if (changeInfo.status === 'complete' || changeInfo.url) {
    await inspectTab(tabId, tab).catch((e) => console.debug('Terms Lens inspect:', e?.message));
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearTabState(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((error) => {
      console.error('Terms Lens error:', error);
      sendResponse({
        ok: false,
        error: error.message || 'Unknown error',
        code: error.code || null,
      });
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'OPEN_SIDE_PANEL': {
      const tabId = sender.tab?.id ?? message.tabId;
      if (!tabId) throw new Error('Missing tabId');
      await chrome.sidePanel.open({ tabId });
      return {};
    }
    case 'OPEN_PANEL_AND_ANALYZE': {
      const tabId = sender.tab?.id ?? message.tabId;
      if (!tabId) throw new Error('Missing tabId');
      await chrome.sidePanel.open({ tabId });
      await updateTabState(tabId, {
        pendingLinkUrl: message.linkUrl || null,
        pendingTrigger: 'signup-popup',
      });
      runAnalysis(tabId, { preferredLinkUrl: message.linkUrl || null }).catch((error) => {
        console.error('Auto-analysis failed:', error);
      });
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
      const state = await readTabState(tabId);
      const sectionIndex = typeof message.sectionIndex === 'number' ? message.sectionIndex : null;
      if (state?.analysisSource?.type === 'linked-policy-fetch' && state.analysisSource.url) {
        await chrome.tabs.create({ url: state.analysisSource.url });
        return {};
      }
      if (sectionIndex !== null) {
        await ensureContentScript(tabId);
        await chrome.tabs.sendMessage(tabId, {
          type: 'JUMP_TO_SECTION',
          sectionIndex,
        }).catch(() => {});
      }
      return {};
    }
    case 'SAVE_LLM_CONFIG': {
      const config = await getLlmConfig();
      const next = { ...config, ...(message.config || {}) };
      await chrome.storage.local.set({ [STORAGE_KEYS.llmConfig]: next });
      return { llmConfig: next };
    }
    case 'SAVE_UI_PREFS': {
      const prefs = await getUiPrefs();
      const next = { ...prefs, ...(message.prefs || {}) };
      await chrome.storage.local.set({ [STORAGE_KEYS.uiPrefs]: next });
      return { uiPrefs: next };
    }
    case 'LIST_MODELS': {
      const config = await getLlmConfig();
      const provider = message.provider || config.provider;
      const apiKey = message.apiKey || config.apiKey;
      const baseUrlOverride = message.baseUrlOverride ?? config.baseUrlOverride;
      const force = !!message.force;
      const result = await getModelList({ provider, apiKey, baseUrlOverride, force });
      return result;
    }
    case 'TEST_KEY': {
      const config = await getLlmConfig();
      const provider = message.provider || config.provider;
      const apiKey = message.apiKey || config.apiKey;
      const model = message.model || config.analysisModel;
      const baseUrlOverride = message.baseUrlOverride ?? config.baseUrlOverride;
      try {
        const response = await callLLM({
          provider,
          apiKey,
          model,
          baseUrlOverride,
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
          maxTokens: 5,
          temperature: 0,
        });
        return { success: true, sample: response.content?.trim().slice(0, 50) || '', usage: response.usage };
      } catch (error) {
        return { success: false, error: error.message, code: error.code || null };
      }
    }
    default:
      throw new Error(`Unsupported message type: ${message.type}`);
  }
}

async function ensureDefaults() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.llmConfig, STORAGE_KEYS.uiPrefs]);
  const updates = {};
  if (!stored[STORAGE_KEYS.llmConfig]) {
    updates[STORAGE_KEYS.llmConfig] = { ...DEFAULT_LLM_CONFIG };
  }
  if (!stored[STORAGE_KEYS.uiPrefs]) {
    updates[STORAGE_KEYS.uiPrefs] = { ...DEFAULT_UI_PREFS };
  }
  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }
}

async function getLlmConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.llmConfig);
  return { ...DEFAULT_LLM_CONFIG, ...(stored[STORAGE_KEYS.llmConfig] || {}) };
}

async function getUiPrefs() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.uiPrefs);
  return { ...DEFAULT_UI_PREFS, ...(stored[STORAGE_KEYS.uiPrefs] || {}) };
}

async function resolveActiveTabId(tabId) {
  if (tabId) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
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
}

async function updateTabState(tabId, patch) {
  const current = (await readTabState(tabId)) || {};
  const next = { ...current, ...patch };
  await writeTabState(tabId, next);
  return next;
}

async function inspectTab(tabId, tab = null) {
  const resolvedTab = tab || (await chrome.tabs.get(tabId).catch(() => null));
  const url = resolvedTab?.url || '';

  if (!isHttpUrl(url)) {
    await clearTabState(tabId);
    return;
  }

  await chrome.sidePanel.setOptions({ tabId, enabled: true, path: 'sidepanel.html' }).catch(() => {});

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
      linkedPolicies: [],
      signupForms: [],
    };
  }

  const previous = await readTabState(tabId);
  const state = await updateTabState(tabId, {
    schemaVersion: SCHEMA_VERSION,
    url,
    title: resolvedTab?.title || detection.title || '',
    detection,
    analysis: previous?.analysis || null,
    analysisSource: previous?.analysisSource || null,
    analysisSections: previous?.analysisSections || null,
    analysisStatus: previous?.analysis ? 'ready' : (detection.isLegalPage || detection.hasLegalLinks || (detection.signupForms || []).length ? 'idle' : 'not-legal'),
    lastError: null,
    progress: null,
  });

  await broadcastState(tabId, state);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch (_error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
    } catch (e) {
      console.debug('content script inject failed:', e?.message);
    }
  }
}

async function buildPanelState(tabId) {
  const [llmConfig, uiPrefs, state, modelCache] = await Promise.all([
    getLlmConfig(),
    getUiPrefs(),
    readTabState(tabId),
    chrome.storage.local.get(STORAGE_KEYS.modelCache).then((r) => r[STORAGE_KEYS.modelCache] || {}),
  ]);

  const tab = await chrome.tabs.get(tabId).catch(() => null);

  return {
    tabId,
    llmConfig: { ...llmConfig, apiKey: llmConfig.apiKey ? '*'.repeat(Math.min(llmConfig.apiKey.length, 12)) : '' },
    apiKeyConfigured: !!llmConfig.apiKey,
    uiPrefs,
    page: state || {
      schemaVersion: SCHEMA_VERSION,
      url: tab?.url || '',
      title: tab?.title || '',
      detection: null,
      analysis: null,
      analysisSource: null,
      analysisStatus: 'idle',
      lastError: null,
      progress: null,
    },
    labels: PAGE_TYPE_LABELS,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([key, value]) => [key, {
      label: value.label,
      keyHelpUrl: value.keyHelpUrl,
      defaultBaseUrl: value.defaultBaseUrl,
    }])),
    modelCache: modelCache[llmConfig.provider] || null,
  };
}

async function getModelList({ provider, apiKey, baseUrlOverride, force }) {
  const cacheStore = await chrome.storage.local.get(STORAGE_KEYS.modelCache);
  const cache = cacheStore[STORAGE_KEYS.modelCache] || {};
  const cacheKey = provider;
  const cached = cache[cacheKey];
  const now = Date.now();

  if (!force && cached && now - cached.fetchedAt < MODEL_CACHE_TTL_MS && cached.models?.length) {
    return { models: cached.models, recommendedAnalysis: pickRecommendedModel(provider, cached.models, 'analysis'), recommendedChat: pickRecommendedModel(provider, cached.models, 'chat'), cached: true };
  }

  if (!apiKey) {
    return { models: [], recommendedAnalysis: '', recommendedChat: '', cached: false, error: 'API key not set' };
  }

  const models = await listModels({ provider, apiKey, baseUrlOverride });
  cache[cacheKey] = { models, fetchedAt: now };
  await chrome.storage.local.set({ [STORAGE_KEYS.modelCache]: cache });

  return {
    models,
    recommendedAnalysis: pickRecommendedModel(provider, models, 'analysis'),
    recommendedChat: pickRecommendedModel(provider, models, 'chat'),
    cached: false,
  };
}

async function runAnalysis(tabId, options = {}) {
  const llmConfig = await getLlmConfig();
  if (!llmConfig.apiKey) {
    const errorState = await updateTabState(tabId, {
      analysisStatus: 'error',
      lastError: 'Add your API key in settings to start analyzing.',
      progress: null,
    });
    await broadcastState(tabId, errorState);
    throw new Error('API key missing');
  }
  if (!llmConfig.analysisModel) {
    const errorState = await updateTabState(tabId, {
      analysisStatus: 'error',
      lastError: 'Pick an analysis model in settings.',
      progress: null,
    });
    await broadcastState(tabId, errorState);
    throw new Error('Analysis model missing');
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !isHttpUrl(tab.url)) {
    throw new Error('Analysis is only available on HTTP(S) pages.');
  }

  await updateTabState(tabId, {
    analysisStatus: 'fetching',
    lastError: null,
    progress: null,
  });
  await broadcastState(tabId);

  await ensureContentScript(tabId);
  let extraction;
  try {
    extraction = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE' });
  } catch (error) {
    const errorState = await updateTabState(tabId, {
      analysisStatus: 'error',
      lastError: 'Could not read this page. Try reloading the tab.',
    });
    await broadcastState(tabId, errorState);
    throw error;
  }

  const linkedPolicies = extraction.linkedPolicies || [];
  const preferredLinkUrl = options.preferredLinkUrl;
  const orderedPolicies = preferredLinkUrl
    ? [{ url: preferredLinkUrl, label: 'Selected policy', pageType: 'terms', confidence: 0.95, sameOrigin: true }, ...linkedPolicies.filter((p) => p.url !== preferredLinkUrl)]
    : rankLinkedPolicies(linkedPolicies);

  let sourceSections = null;
  let analysisSource = null;
  let fetchedTitle = '';

  for (const policy of orderedPolicies) {
    const cacheKey = policyCacheKey(policy.url);
    const cacheStore = await chrome.storage.session.get(cacheKey);
    const cached = cacheStore[cacheKey];
    if (cached && Date.now() - cached.fetchedAt < POLICY_CACHE_TTL_MS && cached.sections?.length) {
      sourceSections = cached.sections;
      fetchedTitle = cached.title || policy.label || '';
      analysisSource = {
        type: 'linked-policy-fetch',
        url: policy.url,
        label: policy.label || 'Linked policy',
        pageType: policy.pageType || 'terms',
        originPageUrl: tab.url,
        cached: true,
      };
      break;
    }

    try {
      const fetched = await fetchPolicyContent({ url: policy.url, originPageUrl: tab.url });
      if (fetched.sections.length) {
        await chrome.storage.session.set({ [cacheKey]: { ...fetched, fetchedAt: Date.now() } });
        sourceSections = fetched.sections;
        fetchedTitle = fetched.title || policy.label || '';
        analysisSource = {
          type: 'linked-policy-fetch',
          url: policy.url,
          label: policy.label || 'Linked policy',
          pageType: policy.pageType || 'terms',
          originPageUrl: tab.url,
          fetchSource: fetched.source,
        };
        break;
      }
    } catch (error) {
      console.debug('Policy fetch failed:', policy.url, error.message);
    }
  }

  if (!sourceSections && extraction.sections?.length) {
    sourceSections = extraction.sections.map((section, index) => ({
      id: section.id || `section-${index}`,
      heading: section.heading || `Section ${index + 1}`,
      text: section.text,
      order: index,
    }));
    analysisSource = {
      type: 'current-page',
      url: tab.url,
      label: extraction.title || tab.title || 'Current page',
      pageType: extraction.detection?.pageType || 'generic',
      originPageUrl: tab.url,
    };
    fetchedTitle = extraction.title || tab.title || '';
  }

  if (!sourceSections || !sourceSections.length) {
    const errorState = await updateTabState(tabId, {
      analysisStatus: 'error',
      lastError: linkedPolicies.length
        ? 'Found policy links but could not extract usable text from them.'
        : 'No policy text found on this page.',
      progress: null,
    });
    await broadcastState(tabId, errorState);
    throw new Error('No usable policy text');
  }

  const totalChars = sourceSections.reduce((sum, s) => sum + (s.text || '').length, 0);
  const tokenEstimate = estimateTokens(sourceSections.map((s) => s.text).join(' '));

  await updateTabState(tabId, {
    analysisStatus: 'analyzing',
    progress: { stage: 'starting', completed: 0, total: 1, totalChars, tokenEstimate },
    analysisSource,
  });
  await broadcastState(tabId);

  let analysisResult;
  try {
    analysisResult = await runLongDocAnalysis({
      sections: sourceSections,
      url: analysisSource.url,
      title: fetchedTitle,
      llmConfig,
      onProgress: async (progress) => {
        await updateTabState(tabId, {
          progress: { ...progress, totalChars, tokenEstimate },
        });
        await broadcastState(tabId);
      },
    });
  } catch (error) {
    const errorState = await updateTabState(tabId, {
      analysisStatus: 'error',
      lastError: friendlyError(error),
      progress: null,
    });
    await broadcastState(tabId, errorState);
    throw error;
  }

  if (analysisResult?.summary === 'insufficient_text') {
    const errorState = await updateTabState(tabId, {
      analysisStatus: 'error',
      lastError: 'The fetched text was too short or unrelated to a policy. Try opening the actual T&C page.',
      progress: null,
    });
    await broadcastState(tabId, errorState);
    throw new Error('Insufficient text');
  }

  const analysis = {
    summary: analysisResult.summary || '',
    keyPoints: Array.isArray(analysisResult.keyPoints) ? analysisResult.keyPoints : [],
    risks: Array.isArray(analysisResult.risks) ? analysisResult.risks : [],
    pageType: analysisResult.pageType || analysisSource.pageType || 'generic',
    suggestedQuestions: Array.isArray(analysisResult.suggestedQuestions) ? analysisResult.suggestedQuestions : [],
    conversation: [],
    analysisId: `${tabId}-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    sourceUrl: analysisSource.url,
    diagnostics: analysisResult._mapDiagnostics || null,
  };

  const nextState = await updateTabState(tabId, {
    analysis,
    analysisSections: sourceSections,
    analysisStatus: 'ready',
    analysisSource,
    progress: null,
    lastError: null,
  });

  await broadcastState(tabId, nextState);
  return { analysis };
}

async function askFollowup(tabId, question) {
  const trimmed = (question || '').trim();
  if (!trimmed) throw new Error('Question is required.');

  const state = await readTabState(tabId);
  if (!state?.analysis || !state.analysisSections?.length) {
    throw new Error('Run an analysis before asking a question.');
  }

  const llmConfig = await getLlmConfig();
  if (!llmConfig.apiKey) throw new Error('API key missing.');
  const chatModel = llmConfig.chatModel || llmConfig.analysisModel;
  if (!chatModel) throw new Error('Pick a chat model in settings.');

  const index = buildLexicalIndex(state.analysisSections);
  let excerpts = topSections(index, trimmed, 3).map((doc) => ({
    sectionIndex: doc.index,
    heading: doc.heading,
    text: doc.text,
  }));

  if (!excerpts.length) {
    excerpts = state.analysisSections.slice(0, 3).map((s, i) => ({
      sectionIndex: i,
      heading: s.heading,
      text: s.text,
    }));
  }

  const conversation = state.analysis.conversation || [];
  const history = conversation.slice(-6);

  let response;
  try {
    response = await callLLM({
      provider: llmConfig.provider,
      apiKey: llmConfig.apiKey,
      model: chatModel,
      baseUrlOverride: llmConfig.baseUrlOverride,
      messages: buildQAMessages({ question: trimmed, excerpts, history }),
      jsonMode: true,
      maxTokens: 800,
      temperature: 0.2,
    });
  } catch (error) {
    throw new Error(friendlyError(error));
  }

  let parsed;
  try {
    parsed = parseJsonContent(response.content);
  } catch (_error) {
    parsed = { answer: response.content, citations: [], grounded: false };
  }

  const nextConversation = [
    ...conversation,
    { role: 'user', text: trimmed },
    {
      role: 'assistant',
      text: parsed.answer || '',
      citations: Array.isArray(parsed.citations) ? parsed.citations : [],
      grounded: parsed.grounded !== false,
    },
  ];

  const nextAnalysis = { ...state.analysis, conversation: nextConversation };
  const nextState = await updateTabState(tabId, {
    analysis: nextAnalysis,
    lastError: null,
  });

  await broadcastState(tabId, nextState);
  return { answer: parsed.answer || '', citations: parsed.citations || [], grounded: parsed.grounded !== false };
}

function rankLinkedPolicies(policies) {
  return [...(policies || [])].sort((a, b) => {
    if (a.sameOrigin !== b.sameOrigin) return a.sameOrigin ? -1 : 1;
    return (b.confidence || 0) - (a.confidence || 0);
  });
}

function policyCacheKey(url) {
  return `${STORAGE_KEYS.policyCachePrefix}${url}`;
}

async function broadcastState(tabId, state = null) {
  const payload = await buildPanelState(tabId);
  if (state) payload.page = state;
  chrome.runtime.sendMessage({
    type: 'PANEL_STATE_UPDATED',
    tabId,
    payload,
  }).catch(() => {});
}

function friendlyError(error) {
  if (!error) return 'Unknown error';
  switch (error.code) {
    case 'auth':
      return 'Provider rejected your API key. Open settings and check it.';
    case 'rate_limit':
      return 'Provider is rate-limiting. Wait a few seconds and try again.';
    case 'network':
      return `Network error: ${error.message}`;
    case 'parse':
      return 'Model returned an unreadable response. Try a different model in settings.';
    case 'config':
      return error.message;
    default:
      return error.message || 'Analysis failed.';
  }
}
