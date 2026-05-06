export const STORAGE_KEYS = {
  llmConfig: 'termsLens.llmConfig',
  modelCache: 'termsLens.modelCache',
  uiPrefs: 'termsLens.uiPrefs',
  tabStatePrefix: 'termsLens.tabState:',
  policyCachePrefix: 'termsLens.policyCache:',
  signupDismissPrefix: 'termsLens.signupDismiss:',
};

export const DEFAULT_LLM_CONFIG = {
  provider: 'gemini',
  apiKey: '',
  analysisModel: '',
  chatModel: '',
  baseUrlOverride: '',
};

export const DEFAULT_UI_PREFS = {
  autoOpen: false,
  autoPopupOnSignup: true,
};

export const HIGH_CONFIDENCE_THRESHOLD = 0.6;

export const PAGE_TYPE_LABELS = {
  terms: 'Terms & Conditions',
  privacy: 'Privacy Policy',
  cookies: 'Cookie Policy',
  refund: 'Refund Policy',
  legal: 'Legal Policy',
  generic: 'Policy Page',
};

export const POLICY_CACHE_TTL_MS = 15 * 60 * 1000;
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
