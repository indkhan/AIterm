(function () {
  if (window.__termsLensContentLoaded) return;
  window.__termsLensContentLoaded = true;

  const LEGAL_KEYWORDS = [
    { regex: /\bterms\b|\bconditions\b|\bterms[- ]of[- ]service\b|\btos\b/i, type: 'terms', weight: 0.34, signal: 'terms-keyword' },
    { regex: /\bprivacy\b|\bpersonal data\b|\bdata policy\b/i, type: 'privacy', weight: 0.34, signal: 'privacy-keyword' },
    { regex: /\bcookies?\b|\bconsent\b/i, type: 'cookies', weight: 0.3, signal: 'cookie-keyword' },
    { regex: /\brefund\b|\breturns?\b|\bcancellation\b/i, type: 'refund', weight: 0.22, signal: 'refund-keyword' },
    { regex: /\blegal\b|\barbitration\b|\bliability\b|\bacceptable use\b|\beula\b/i, type: 'legal', weight: 0.22, signal: 'legal-keyword' },
  ];
  const POLICY_LINK_HINT = /\b(terms?|conditions?|privacy|cookies?|policy|legal|data policy|acceptable use|refund|billing|consent|user agreement|community guidelines)\b/i;
  const ROUTE_POLICY_HINT = /(terms|conditions|privacy|cookies?|policy|legal|acceptable-use|data-policy|refund|billing|consent|eula|user-agreement)/i;
  const PRIMARY_CONTENT_SELECTORS = ['main', 'article', '[role="main"]', '.terms', '.policy', '.legal', '.privacy', '.content', '.page-content', '.main-content', '.document', '#content', '#main'];
  const TEXT_SELECTORS = 'h1, h2, h3, h4, p, li, td, th, blockquote';
  const POPUP_HOST_ID = 'terms-lens-popup-host';

  let cachedDetection = null;
  let popupHost = null;
  let popupShadow = null;
  let popupRetargetTimer = null;

  ensureLegacyStyles();
  scheduleInitialDetection();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    Promise.resolve(handleMessage(message))
      .then((result) => sendResponse(result || {}))
      .catch((error) => {
        console.error('Terms Lens content error:', error);
        sendResponse({ error: error.message || 'Unknown error' });
      });
    return true;
  });

  async function handleMessage(message) {
    switch (message.type) {
      case 'PING':
        return { pong: true };
      case 'DETECT_PAGE': {
        cachedDetection = detectPage();
        renderPopupForDetection(cachedDetection);
        return cachedDetection;
      }
      case 'EXTRACT_PAGE': {
        const detection = detectPage();
        cachedDetection = detection;
        renderPopupForDetection(detection);
        const sections = extractInlineSections();
        return {
          url: location.href,
          title: document.title || '',
          detection,
          sections,
          linkedPolicies: detection.linkedPolicies,
          signupForms: detection.signupForms,
        };
      }
      case 'JUMP_TO_SECTION':
        // sections from linked-policy fetches don't exist in this DOM; nothing to do
        return { ok: true };
      case 'DISMISS_POPUP':
        await dismissPopupForCurrentForm();
        return { ok: true };
      default:
        return {};
    }
  }

  function scheduleInitialDetection() {
    const run = () => {
      try {
        cachedDetection = detectPage();
        renderPopupForDetection(cachedDetection);
      } catch (e) {
        console.debug('Terms Lens detect failed:', e?.message);
      }
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      window.setTimeout(run, 600);
    } else {
      window.addEventListener('DOMContentLoaded', () => window.setTimeout(run, 600), { once: true });
    }
  }

  function detectPage() {
    const linkedPolicies = discoverLinkedPolicies();
    const signupForms = detectSignupForms(linkedPolicies);
    const rawBodyText = clean(document.body?.innerText || '');
    const bodyText = rawBodyText.slice(0, 4000);
    const signalPool = `${location.href} ${document.title} ${bodyText}`;
    const lowerPath = `${location.pathname} ${location.hostname}`.toLowerCase();
    const signals = [];
    const weights = {};

    if (ROUTE_POLICY_HINT.test(lowerPath)) {
      addWeight(weights, 'generic', 0.3);
      signals.push('url-legal-pattern');
    }

    LEGAL_KEYWORDS.forEach((keyword) => {
      if (keyword.regex.test(signalPool)) {
        addWeight(weights, keyword.type, keyword.weight);
        signals.push(keyword.signal);
      }
    });

    if (rawBodyText.length > 4000) {
      addWeight(weights, 'generic', 0.1);
      signals.push('long-form-document');
    }

    linkedPolicies.slice(0, 3).forEach((policy, index) => {
      addWeight(weights, policy.pageType || 'generic', Math.max(0.08, policy.confidence - index * 0.04));
      signals.push(index === 0 ? 'best-legal-link' : 'legal-link');
    });

    if (signupForms.length) {
      signals.push('signup-form-detected');
    }

    const ranked = Object.entries(weights).sort((a, b) => b[1] - a[1]);
    const top = ranked[0] || ['generic', 0];
    const confidence = Math.max(0, Math.min(0.99, top[1]));
    const pageType = inferType(signalPool, linkedPolicies, top[0]);

    return {
      isLegalPage: confidence >= 0.5,
      pageType,
      confidence,
      signals: Array.from(new Set(signals)),
      title: document.title || '',
      url: location.href,
      hasLegalLinks: linkedPolicies.length > 0,
      linkedPolicies,
      signupForms,
    };
  }

  function discoverLinkedPolicies() {
    const policies = [];
    const seen = new Set();

    Array.from(document.querySelectorAll('a[href]')).forEach((anchor) => {
      const href = anchor.getAttribute('href');
      const label = clean(anchor.innerText || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || '');
      if (!href) return;

      let absoluteUrl;
      try {
        absoluteUrl = new URL(href, location.href);
      } catch (_e) {
        return;
      }
      if (!/^https?:$/i.test(absoluteUrl.protocol)) return;

      const combined = `${label} ${absoluteUrl.href}`;
      if (!POLICY_LINK_HINT.test(combined)) return;

      const pageType = guessPolicyType(combined);
      const confidence = scorePolicyAnchor(anchor, label, absoluteUrl.href, pageType);
      const dedup = normalizeUrl(absoluteUrl.href);
      if (seen.has(dedup)) return;
      seen.add(dedup);

      policies.push({
        url: absoluteUrl.href,
        label: label || pageType,
        pageType,
        confidence,
        sameOrigin: absoluteUrl.origin === location.origin,
        anchorRect: rectOrNull(anchor),
      });
    });

    return policies
      .sort((a, b) => {
        if (a.sameOrigin !== b.sameOrigin) return a.sameOrigin ? -1 : 1;
        return b.confidence - a.confidence;
      })
      .slice(0, 12);
  }

  function detectSignupForms(linkedPolicies) {
    const forms = Array.from(document.querySelectorAll('form'));
    const candidates = [];

    forms.forEach((form, formIndex) => {
      if (!isVisibleNode(form)) return;

      const passwordFields = form.querySelectorAll('input[type="password"]');
      const emailFields = form.querySelectorAll('input[type="email"], input[autocomplete*="username" i], input[autocomplete*="email" i], input[name*="email" i], input[id*="email" i]');
      const idAction = `${form.id || ''} ${form.getAttribute('action') || ''} ${form.className || ''}`.toLowerCase();

      const hasSignupHint = /signup|sign[- ]up|register|create[- ]account|join/i.test(idAction);
      const hasFieldHint = passwordFields.length > 0 && (emailFields.length > 0 || form.querySelector('input[name*="user" i], input[autocomplete*="username" i]'));

      if (!hasSignupHint && !hasFieldHint) return;

      const formRect = form.getBoundingClientRect();
      const linksInOrNear = collectNearbyPolicyLinks(form, formRect);

      let confidence = 0;
      if (hasSignupHint) confidence += 0.4;
      if (hasFieldHint) confidence += 0.45;
      if (linksInOrNear.length) confidence += 0.25;

      if (confidence < 0.6) return;

      const formId = `form-${formIndex}-${(form.id || form.name || idAction).slice(0, 40)}`;

      candidates.push({
        formId,
        rect: serializeRect(formRect),
        confidence: Math.min(0.99, confidence),
        nearbyPolicyLinks: linksInOrNear,
        hasSignupHint,
        hasFieldHint,
      });
    });

    if (!candidates.length && linkedPolicies.length) {
      // No form found, but page has legal links and looks like an auth page
      const bodyText = clean(document.body?.innerText || '').slice(0, 1800);
      if (/sign up|create account|register|join now/i.test(bodyText)) {
        const passwordField = document.querySelector('input[type="password"]');
        if (passwordField && isVisibleNode(passwordField)) {
          const rect = passwordField.getBoundingClientRect();
          candidates.push({
            formId: 'auth-page-fallback',
            rect: serializeRect(rect),
            confidence: 0.65,
            nearbyPolicyLinks: linkedPolicies.slice(0, 3),
            hasSignupHint: false,
            hasFieldHint: true,
          });
        }
      }
    }

    return candidates;
  }

  function collectNearbyPolicyLinks(form, formRect) {
    const links = [];
    const seen = new Set();

    Array.from(form.querySelectorAll('a[href]')).forEach((anchor) => {
      addPolicyLinkIfMatch(anchor, links, seen, 'inside');
    });

    const allAnchors = Array.from(document.querySelectorAll('a[href]'));
    for (const anchor of allAnchors) {
      if (form.contains(anchor)) continue;
      const rect = anchor.getBoundingClientRect();
      const verticalDistance = rect.top - formRect.bottom;
      if (verticalDistance < -100 || verticalDistance > 500) continue;
      const horizontalOverlap = Math.min(rect.right, formRect.right) - Math.max(rect.left, formRect.left);
      if (horizontalOverlap < -200) continue;
      addPolicyLinkIfMatch(anchor, links, seen, 'near');
    }

    return links.slice(0, 6);
  }

  function addPolicyLinkIfMatch(anchor, links, seen, position) {
    const href = anchor.getAttribute('href');
    const label = clean(anchor.innerText || anchor.getAttribute('aria-label') || '');
    if (!href) return;

    let absoluteUrl;
    try {
      absoluteUrl = new URL(href, location.href);
    } catch (_e) {
      return;
    }
    if (!/^https?:$/i.test(absoluteUrl.protocol)) return;

    const combined = `${label} ${absoluteUrl.href}`;
    if (!POLICY_LINK_HINT.test(combined)) return;

    const dedup = normalizeUrl(absoluteUrl.href);
    if (seen.has(dedup)) return;
    seen.add(dedup);

    links.push({
      url: absoluteUrl.href,
      label: label || guessPolicyType(combined),
      pageType: guessPolicyType(combined),
      position,
    });
  }

  function extractInlineSections() {
    const root = PRIMARY_CONTENT_SELECTORS.map((sel) => document.querySelector(sel)).find(Boolean) || document.body;
    if (!root) return [];

    const nodes = Array.from(root.querySelectorAll(TEXT_SELECTORS)).filter((node) => isVisibleNode(node));
    const sections = [];
    let current = { heading: 'Overview', text: '', order: 0 };

    for (const node of nodes) {
      const text = clean(node.textContent || '');
      if (!text) continue;

      if (/^H[1-4]$/.test(node.tagName)) {
        if (current.text.length >= 60) {
          sections.push({ ...current, id: slug(current.heading), text: clean(current.text), order: sections.length });
        }
        current = { heading: text, text: '', order: sections.length };
        continue;
      }

      current.text += `${text}\n\n`;
    }

    if (current.text.length >= 60) {
      sections.push({ ...current, id: slug(current.heading), text: clean(current.text), order: sections.length });
    }

    return sections.slice(0, 80);
  }

  // ===== Floating popup =====

  async function renderPopupForDetection(detection) {
    if (!detection?.signupForms?.length) {
      hidePopup();
      return;
    }

    const form = detection.signupForms[0];
    if (!form.nearbyPolicyLinks?.length) {
      hidePopup();
      return;
    }

    const dismissed = await isPopupDismissed(form.formId);
    if (dismissed) {
      hidePopup();
      return;
    }

    showPopup(form);
  }

  function showPopup(form) {
    const formNode = locateFormNode(form);
    if (!formNode) {
      hidePopup();
      return;
    }

    if (!popupHost || !popupHost.isConnected) {
      popupHost = document.createElement('div');
      popupHost.id = POPUP_HOST_ID;
      popupHost.style.cssText = 'position:absolute;top:0;left:0;z-index:2147483646;pointer-events:none;';
      popupShadow = popupHost.attachShadow({ mode: 'closed' });
      document.documentElement.appendChild(popupHost);
    }

    const link = form.nearbyPolicyLinks[0];
    const linkLabel = link.label && link.label.length < 40 ? link.label : 'this policy';

    popupShadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }
        .card {
          pointer-events: auto;
          font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif;
          background: #ffffff;
          color: #0f172a;
          border: 1px solid rgba(15, 23, 42, 0.12);
          border-radius: 14px;
          padding: 12px 14px;
          box-shadow: 0 18px 44px rgba(15, 23, 42, 0.18);
          display: flex;
          gap: 10px;
          align-items: center;
          width: 320px;
          max-width: calc(100vw - 24px);
        }
        .icon {
          width: 32px;
          height: 32px;
          flex-shrink: 0;
          background: linear-gradient(135deg, #4f46e5, #7c3aed);
          color: #fff;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          font-size: 14px;
        }
        .body { flex: 1; min-width: 0; }
        .title {
          font-weight: 600;
          margin: 0 0 2px;
          font-size: 13px;
          color: #0f172a;
        }
        .sub {
          margin: 0;
          font-size: 12px;
          color: #475569;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .actions { display: flex; gap: 6px; flex-shrink: 0; }
        button {
          font: inherit;
          border: 0;
          border-radius: 999px;
          padding: 7px 12px;
          cursor: pointer;
          font-weight: 600;
        }
        .primary {
          background: linear-gradient(135deg, #4f46e5, #7c3aed);
          color: #fff;
        }
        .primary:hover { filter: brightness(1.05); }
        .ghost {
          background: transparent;
          color: #64748b;
          padding: 7px 8px;
        }
        .ghost:hover { color: #0f172a; }
      </style>
      <div class="card" role="dialog" aria-label="Terms Lens prompt">
        <div class="icon">TL</div>
        <div class="body">
          <p class="title">Review terms before signing up</p>
          <p class="sub">Get a plain-English summary of ${escapeHtml(linkLabel)}.</p>
        </div>
        <div class="actions">
          <button class="primary" data-action="analyze">Review</button>
          <button class="ghost" data-action="dismiss" aria-label="Dismiss">×</button>
        </div>
      </div>
    `;

    const root = popupShadow;
    root.querySelector('[data-action="analyze"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'OPEN_PANEL_AND_ANALYZE',
        linkUrl: link.url,
      }).catch((e) => console.error('Terms Lens open panel:', e));
    });
    root.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
      await persistDismissal(form.formId);
      hidePopup();
    });

    positionPopup(formNode);
    bindRepositionListeners(formNode);
  }

  function locateFormNode(form) {
    if (form.formId === 'auth-page-fallback') {
      return document.querySelector('input[type="password"]')?.closest('form, section, div, main, body') || document.body;
    }
    const forms = Array.from(document.querySelectorAll('form'));
    const targetIndex = parseInt(form.formId.split('-')[1], 10);
    return forms[targetIndex] || forms.find((f) => isVisibleNode(f)) || document.body;
  }

  function positionPopup(formNode) {
    if (!popupHost || !formNode) return;
    const rect = formNode.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    const cardWidth = 320;
    const cardHeight = 70;
    const margin = 12;

    let top = rect.top + scrollY - cardHeight - margin;
    let left = rect.left + scrollX + (rect.width / 2) - (cardWidth / 2);

    if (top < scrollY + 8) {
      top = rect.bottom + scrollY + margin;
    }
    left = Math.max(scrollX + 8, Math.min(left, scrollX + window.innerWidth - cardWidth - 8));

    popupHost.style.top = `${top}px`;
    popupHost.style.left = `${left}px`;
  }

  function bindRepositionListeners(formNode) {
    if (popupRetargetTimer) {
      clearInterval(popupRetargetTimer);
    }
    popupRetargetTimer = setInterval(() => {
      if (!popupHost?.isConnected || !formNode?.isConnected) {
        clearInterval(popupRetargetTimer);
        popupRetargetTimer = null;
        return;
      }
      positionPopup(formNode);
    }, 700);
  }

  function hidePopup() {
    if (popupHost?.isConnected) {
      popupHost.remove();
    }
    popupHost = null;
    popupShadow = null;
    if (popupRetargetTimer) {
      clearInterval(popupRetargetTimer);
      popupRetargetTimer = null;
    }
  }

  async function isPopupDismissed(formId) {
    const key = `termsLens.signupDismiss:${location.origin}:${formId}`;
    try {
      const stored = await chrome.storage.session.get(key);
      return !!stored[key];
    } catch (_e) {
      return false;
    }
  }

  async function persistDismissal(formId) {
    const key = `termsLens.signupDismiss:${location.origin}:${formId}`;
    try {
      await chrome.storage.session.set({ [key]: true });
    } catch (_e) {
      /* ignore */
    }
  }

  async function dismissPopupForCurrentForm() {
    if (!cachedDetection?.signupForms?.length) return;
    await persistDismissal(cachedDetection.signupForms[0].formId);
    hidePopup();
  }

  // ===== Helpers =====

  function ensureLegacyStyles() {
    if (document.getElementById('terms-lens-legacy-styles')) return;
    const style = document.createElement('style');
    style.id = 'terms-lens-legacy-styles';
    style.textContent = `
      .terms-lens-highlight {
        outline: 3px solid rgba(79, 70, 229, 0.34);
        background: rgba(196, 181, 253, 0.45);
        transition: background 220ms ease;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function isVisibleNode(node) {
    if (!node || !node.isConnected) return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function rectOrNull(node) {
    try {
      return serializeRect(node.getBoundingClientRect());
    } catch (_e) {
      return null;
    }
  }

  function serializeRect(rect) {
    if (!rect) return null;
    return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  }

  function scorePolicyAnchor(anchor, label, href, pageType) {
    let confidence = 0.3;
    if (POLICY_LINK_HINT.test(label)) confidence += 0.26;
    if (ROUTE_POLICY_HINT.test(href)) confidence += 0.24;
    if (pageType === 'cookies' && /cookie|consent/i.test(`${label} ${href}`)) confidence += 0.12;
    if (pageType === 'privacy' && /privacy|data/i.test(`${label} ${href}`)) confidence += 0.12;
    if (isVisibleNode(anchor)) confidence += 0.08;
    return Math.min(0.95, confidence);
  }

  function guessPolicyType(text) {
    if (/privacy|personal data|data policy/i.test(text)) return 'privacy';
    if (/cookies?|consent/i.test(text)) return 'cookies';
    if (/refund|return|cancellation/i.test(text)) return 'refund';
    if (/terms|conditions|service|user agreement/i.test(text)) return 'terms';
    return 'legal';
  }

  function inferType(signalPool, linkedPolicies, fallback) {
    if (/privacy|personal data|data policy/i.test(signalPool)) return 'privacy';
    if (/cookies?|consent/i.test(signalPool)) return 'cookies';
    if (/refund|return|cancellation/i.test(signalPool)) return 'refund';
    if (/terms|conditions|service|user agreement/i.test(signalPool)) return 'terms';
    if (linkedPolicies?.length) return linkedPolicies[0].pageType || 'generic';
    return fallback || 'generic';
  }

  function normalizeUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.toString();
    } catch (_e) {
      return url;
    }
  }

  function addWeight(weights, key, value) {
    weights[key] = (weights[key] || 0) + value;
  }

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function slug(value) {
    return clean(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'section';
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
