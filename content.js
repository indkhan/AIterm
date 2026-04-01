(function () {
  const LEGAL_KEYWORDS = [
    { regex: /\bterms\b|\bconditions\b|\bterms-of-service\b|\btos\b/i, type: 'terms', weight: 0.32, signal: 'terms-keyword' },
    { regex: /\bprivacy\b|\bpersonal data\b|\bdata policy\b/i, type: 'privacy', weight: 0.34, signal: 'privacy-keyword' },
    { regex: /\bcookie\b|\bcookies\b|\bconsent\b/i, type: 'cookies', weight: 0.3, signal: 'cookie-keyword' },
    { regex: /\brefund\b|\breturns?\b|\bcancellation\b/i, type: 'refund', weight: 0.22, signal: 'refund-keyword' },
    { regex: /\blegal\b|\barbitration\b|\bliability\b|\bacceptable use\b|\beula\b|\bbilling\b/i, type: 'legal', weight: 0.22, signal: 'legal-keyword' }
  ];
  const POLICY_LINK_HINT = /\b(terms?|conditions?|privacy|cookies?|policy|legal|data policy|acceptable use|refund|billing|consent)\b/i;
  const ROUTE_POLICY_HINT = /(terms|conditions|privacy|cookies?|policy|legal|acceptable-use|data-policy|refund|billing|consent|eula)/i;
  const PRIMARY_CONTENT_SELECTORS = [
    'main',
    'article',
    '[role="main"]',
    '.terms',
    '.policy',
    '.legal',
    '.content',
    '.page-content',
    '.main-content',
    '.document',
    '#content',
    '#main'
  ];
  const MODAL_SELECTORS = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[data-testid*="cookie"]',
    '[data-cookiebanner]',
    '[id*="cookie"]',
    '[class*="cookie"]',
    '[class*="consent"]',
    '[id*="consent"]',
    '[class*="modal"]'
  ];
  const INLINE_POLICY_SELECTORS = [
    '.legal',
    '.policy',
    '.terms',
    '.privacy',
    '.cookies',
    '.consent',
    'footer',
    'section',
    'aside',
    '[data-testid]',
    '[class*="footer"]',
    '[class*="auth"]',
    '[class*="signup"]',
    '[class*="login"]',
    '[class*="register"]'
  ];
  const TEXT_SELECTORS = 'h1, h2, h3, h4, p, li, td, th, blockquote';
  const CLAUSE_ATTR = 'data-terms-lens-clause-id';
  const HIGHLIGHT_CLASS = 'terms-lens-highlight';
  let cachedDetection = null;

  ensureStyles();
  scheduleBadgeRefresh();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    Promise.resolve(handleMessage(message))
      .then((result) => sendResponse(result))
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
      case 'DETECT_PAGE':
        cachedDetection = detectPage();
        toggleBadge(cachedDetection);
        return cachedDetection;
      case 'EXTRACT_PAGE': {
        const extraction = extractPage();
        cachedDetection = extraction.detection;
        toggleBadge(cachedDetection);
        return extraction;
      }
      case 'JUMP_TO_CITATION':
        jumpToClause(message.clauseId);
        return { ok: true };
      default:
        throw new Error(`Unknown content message type: ${message.type}`);
    }
  }

  function detectPage() {
    const bodyText = cleanText(document.body?.innerText || '');
    const title = document.title || '';
    const url = location.href;
    const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map((node) => cleanText(node.textContent)).filter(Boolean);
    const linkedPolicies = discoverLinkedPolicies();
    const inlineSignals = findInlineLegalBlocks(linkedPolicies);
    const signalPool = [url, title, headings.join(' '), bodyText.slice(0, 2800)].join(' ');
    const lowerPath = `${location.pathname} ${location.hostname}`.toLowerCase();
    const signals = [];
    const weights = {};

    if (ROUTE_POLICY_HINT.test(lowerPath)) {
      addWeight(weights, 'generic', 0.28);
      signals.push('url-legal-pattern');
    }

    if (headings.some((heading) => POLICY_LINK_HINT.test(heading))) {
      addWeight(weights, 'generic', 0.24);
      signals.push('heading-match');
    }

    LEGAL_KEYWORDS.forEach((keyword) => {
      if (keyword.regex.test(signalPool)) {
        addWeight(weights, keyword.type, keyword.weight);
        signals.push(keyword.signal);
      }
    });

    if (bodyText.length > 4500) {
      addWeight(weights, 'generic', 0.1);
      signals.push('long-form-document');
    }

    if (inlineSignals.hasCookieBanner) {
      addWeight(weights, 'cookies', 0.34);
      signals.push('cookie-banner');
    }

    if (inlineSignals.hasInlineLegalText) {
      addWeight(weights, inlineSignals.dominantType || 'generic', 0.24);
      signals.push('inline-legal-copy');
    }

    if (inlineSignals.authLikePage && linkedPolicies.length) {
      addWeight(weights, linkedPolicies[0].pageType || 'generic', 0.16);
      signals.push('auth-page-legal-links');
    }

    linkedPolicies.slice(0, 3).forEach((policy, index) => {
      addWeight(weights, policy.pageType || 'generic', Math.max(0.08, policy.confidence - (index * 0.04)));
      signals.push(index === 0 ? 'best-legal-link' : 'legal-link');
    });

    if (/blog|docs|press|careers|about/.test(lowerPath) && !ROUTE_POLICY_HINT.test(lowerPath) && linkedPolicies.length === 0 && !inlineSignals.hasInlineLegalText) {
      addWeight(weights, 'generic', -0.18);
      signals.push('non-legal-route');
    }

    const ranked = Object.entries(weights).sort((a, b) => b[1] - a[1]);
    const top = ranked[0] || ['generic', 0];
    const confidence = Math.max(0, Math.min(0.99, top[1]));
    const pageType = top[0] === 'generic' ? inferGenericType(signalPool, linkedPolicies) : top[0];
    const bestPolicySource = inlineSignals.hasInlineLegalText
      ? 'current-page-inline'
      : linkedPolicies.length
        ? 'linked-policy-fetch'
        : 'current-page';

    return {
      isLegalPage: confidence >= 0.34 || inlineSignals.hasInlineLegalText || linkedPolicies.length > 0,
      pageType,
      confidence,
      signals: Array.from(new Set(signals)),
      title,
      url,
      hasInlineLegalText: inlineSignals.hasInlineLegalText,
      hasLegalLinks: linkedPolicies.length > 0,
      bestPolicySource,
      linkedPolicies
    };
  }

  function extractPage() {
    const detection = detectPage();
    const linkedPolicies = detection.linkedPolicies || [];
    const roots = pickExtractionRoots(linkedPolicies);
    const sections = extractSectionsFromRoots(roots);
    const metadata = buildMetadata(sections);

    return {
      url: location.href,
      title: document.title || '',
      detection,
      metadata,
      sections,
      linkedPolicies,
      sourceHints: collectSourceHints(roots, detection, linkedPolicies)
    };
  }

  function pickExtractionRoots(linkedPolicies) {
    const roots = [];
    const seen = new Set();

    PRIMARY_CONTENT_SELECTORS
      .map((selector) => document.querySelector(selector))
      .filter(Boolean)
      .forEach((node) => pushRoot(roots, seen, node, 'main-root', (node.innerText || '').length > 700));

    MODAL_SELECTORS
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .forEach((node) => pushRoot(roots, seen, node, 'modal', isVisiblePolicyNode(node)));

    INLINE_POLICY_SELECTORS
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .forEach((node) => pushRoot(roots, seen, node, classifyInlineRoot(node), isVisiblePolicyNode(node)));

    linkedPolicies.forEach((policy) => {
      if (!policy.anchorSelector) {
        return;
      }
      const anchor = document.querySelector(policy.anchorSelector);
      if (anchor?.parentElement) {
        pushRoot(roots, seen, anchor.parentElement, 'legal-link-context', true);
      }
    });

    if (!roots.length) {
      roots.push({ node: document.body, hint: 'body-fallback' });
    }

    return roots;
  }

  function extractSectionsFromRoots(roots) {
    const sections = [];
    const seenSectionText = new Set();
    let index = 0;

    roots.forEach((root) => {
      const extracted = extractSectionsFromNode(root.node, root.hint);
      extracted.forEach((section) => {
        const key = section.text.slice(0, 240);
        if (seenSectionText.has(key)) {
          return;
        }
        seenSectionText.add(key);
        section.order = index++;
        sections.push(section);
      });
    });

    return sections.slice(0, 80);
  }

  function extractSectionsFromNode(root, rootHint) {
    const elements = Array.from(root.querySelectorAll(TEXT_SELECTORS));
    const sections = [];
    let current = createSection('Overview', root, rootHint);
    let legalIntensity = scoreTextForPolicy(cleanText(root.innerText || ''));

    if (!elements.length) {
      const rootText = cleanText(root.innerText || '');
      if (rootText.length >= 40 && legalIntensity >= 0.34) {
        current.text = rootText;
        finalizeSection(current, sections, true);
      }
      return sections;
    }

    for (const node of elements) {
      if (shouldIgnoreNode(node)) {
        continue;
      }

      const text = cleanText(node.textContent);
      if (!text) {
        continue;
      }

      const legalScore = scoreTextForPolicy(text);
      if (text.length < 18 && legalScore < 0.4) {
        continue;
      }

      if (/^H[1-4]$/.test(node.tagName)) {
        finalizeSection(current, sections, legalIntensity >= 0.32);
        current = createSection(text, node, rootHint);
        legalIntensity = Math.max(legalIntensity, legalScore);
        continue;
      }

      const clauseId = ensureClauseId(node, current.heading);
      const entry = {
        clauseId,
        text,
        selector: buildSelector(node)
      };

      if (node.tagName === 'LI') {
        current.bullets.push(entry);
      } else {
        current.paragraphs.push(entry);
      }
      current.text += `${text}\n\n`;
      legalIntensity = Math.max(legalIntensity, legalScore);
    }

    finalizeSection(current, sections, legalIntensity >= 0.32);
    return sections;
  }

  function createSection(heading, anchorNode, rootHint) {
    return {
      id: slugify(heading),
      heading,
      text: '',
      paragraphs: [],
      bullets: [],
      jumpTarget: buildSelector(anchorNode),
      sourceHint: rootHint
    };
  }

  function finalizeSection(section, sections, allowShortLegalSection) {
    const text = cleanText(section.text);
    const minLength = allowShortLegalSection ? 40 : 80;
    if (text.length < minLength) {
      return;
    }

    sections.push({
      id: section.id,
      heading: section.heading,
      text,
      citations: [...section.paragraphs, ...section.bullets],
      jumpTarget: section.jumpTarget,
      sourceHint: section.sourceHint
    });
  }

  function discoverLinkedPolicies() {
    const policies = [];
    const seen = new Set();

    Array.from(document.querySelectorAll('a[href]')).forEach((anchor) => {
      const href = anchor.getAttribute('href');
      const label = cleanText(anchor.innerText || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || '');
      if (!href || (!label && !POLICY_LINK_HINT.test(href))) {
        return;
      }

      let absoluteUrl;
      try {
        absoluteUrl = new URL(href, location.href);
      } catch (_error) {
        return;
      }

      if (!/^https?:$/i.test(absoluteUrl.protocol)) {
        return;
      }

      const combined = `${label} ${absoluteUrl.href}`;
      if (!POLICY_LINK_HINT.test(combined)) {
        return;
      }

      const pageType = inferGenericType(combined, []);
      const confidence = computeLinkedPolicyConfidence(anchor, label, absoluteUrl.href, pageType);
      const normalized = normalizeUrlForDedup(absoluteUrl.href);
      if (seen.has(normalized)) {
        return;
      }

      seen.add(normalized);
      policies.push({
        url: absoluteUrl.href,
        label: label || pageType,
        pageType,
        confidence,
        sameOrigin: absoluteUrl.origin === location.origin,
        anchorSelector: buildSelector(anchor)
      });
    });

    return policies
      .sort((a, b) => {
        if (a.sameOrigin !== b.sameOrigin) {
          return a.sameOrigin ? -1 : 1;
        }
        return b.confidence - a.confidence;
      })
      .slice(0, 6);
  }

  function computeLinkedPolicyConfidence(anchor, label, href, pageType) {
    let confidence = 0.28;
    const combined = `${label} ${href}`;
    if (POLICY_LINK_HINT.test(label)) {
      confidence += 0.26;
    }
    if (ROUTE_POLICY_HINT.test(href)) {
      confidence += 0.24;
    }
    if (pageType === 'cookies' && /cookie|consent/i.test(combined)) {
      confidence += 0.14;
    }
    if (pageType === 'privacy' && /privacy|data/i.test(combined)) {
      confidence += 0.14;
    }
    if (isVisibleNode(anchor)) {
      confidence += 0.08;
    }
    return Math.min(0.95, confidence);
  }

  function findInlineLegalBlocks(linkedPolicies) {
    const candidates = [];
    MODAL_SELECTORS.concat(INLINE_POLICY_SELECTORS).forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (!isVisibleNode(node)) {
          return;
        }
        const text = cleanText(node.innerText || '');
        if (!text) {
          return;
        }
        const score = scoreTextForPolicy(text);
        if (score >= 0.34 || (text.length >= 35 && hasLocalPolicyLink(node))) {
          candidates.push({ node, score, text });
        }
      });
    });

    const text = candidates.map((item) => item.text).join(' ');
    return {
      hasInlineLegalText: candidates.length > 0,
      hasCookieBanner: candidates.some((item) => /cookie|consent/i.test(item.text)),
      authLikePage: /login|sign up|create account|password|submit/i.test(cleanText(document.body?.innerText || '').slice(0, 1800)),
      dominantType: inferGenericType(text, linkedPolicies),
      candidates
    };
  }

  function collectSourceHints(roots, detection, linkedPolicies) {
    const hints = new Set();
    roots.forEach((root) => hints.add(root.hint));
    if (detection.hasInlineLegalText) {
      hints.add('inline-policy-copy');
    }
    if (linkedPolicies.length) {
      hints.add('footer-links');
    }
    if ((document.body?.innerText || '').match(/allow the use of cookies|cookie policy|cookie preferences/i)) {
      hints.add('cookie-banner');
    }
    if ((document.body?.innerText || '').match(/sign up|log in|create account|submit/i)) {
      hints.add('auth-page');
    }
    return Array.from(hints);
  }

  function inferGenericType(text, linkedPolicies) {
    if (/privacy|personal data|data policy/i.test(text)) return 'privacy';
    if (/cookie|consent/i.test(text)) return 'cookies';
    if (/refund|return|cancellation/i.test(text)) return 'refund';
    if (/terms|conditions|service/i.test(text)) return 'terms';
    if (linkedPolicies?.length) {
      return linkedPolicies[0].pageType || 'generic';
    }
    return 'generic';
  }

  function scoreTextForPolicy(text) {
    const clean = cleanText(text);
    if (!clean) {
      return 0;
    }

    let score = 0;
    LEGAL_KEYWORDS.forEach((keyword) => {
      if (keyword.regex.test(clean)) {
        score += keyword.weight;
      }
    });

    if (/allow the use of cookies|cookie policy|privacy policy|terms and conditions|terms of service/i.test(clean)) {
      score += 0.18;
    }
    if (/we collect|we use|we may share|you agree|by tapping|by continuing|binding arbitration|class action/i.test(clean)) {
      score += 0.12;
    }
    return Math.min(1, score);
  }

  function hasLocalPolicyLink(node) {
    return Array.from(node.querySelectorAll('a[href]')).some((anchor) => POLICY_LINK_HINT.test(`${anchor.innerText} ${anchor.getAttribute('href') || ''}`));
  }

  function pushRoot(roots, seen, node, hint, include) {
    if (!node || !include) {
      return;
    }
    const key = buildSelector(node);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    roots.push({ node, hint });
  }

  function classifyInlineRoot(node) {
    const text = cleanText(node.innerText || '');
    if (/cookie|consent/i.test(text)) return 'cookie-banner';
    if (/sign up|login|create account|submit/i.test(text)) return 'auth-page';
    if (node.closest('footer')) return 'footer-links';
    return 'inline-policy-copy';
  }

  function isVisiblePolicyNode(node) {
    return isVisibleNode(node) && (
      scoreTextForPolicy(cleanText(node.innerText || '')) >= 0.34 ||
      hasLocalPolicyLink(node)
    );
  }

  function isVisibleNode(node) {
    if (!node || !node.isConnected) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function buildMetadata(sections) {
    const wordCount = sections.reduce((total, section) => total + section.text.split(/\s+/).filter(Boolean).length, 0);
    return {
      locale: document.documentElement.lang || 'unknown',
      wordCount,
      extractedAt: new Date().toISOString(),
      sectionCount: sections.length
    };
  }

  function ensureClauseId(node, heading) {
    if (node.getAttribute(CLAUSE_ATTR)) {
      return node.getAttribute(CLAUSE_ATTR);
    }

    const id = `${slugify(heading)}-${Math.random().toString(36).slice(2, 8)}`;
    node.setAttribute(CLAUSE_ATTR, id);
    return id;
  }

  function buildSelector(node) {
    if (!node || node === document.body) {
      return 'body';
    }

    if (node.id) {
      return `#${escapeCss(node.id)}`;
    }

    const parts = [];
    let current = node;
    while (current && current !== document.body && parts.length < 5) {
      let part = current.nodeName.toLowerCase();
      if (current.classList && current.classList.length) {
        part += `.${Array.from(current.classList).slice(0, 2).map(escapeCss).join('.')}`;
      } else {
        const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((child) => child.nodeName === current.nodeName) : [];
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(' > ');
  }

  function shouldIgnoreNode(node) {
    if (!node || !node.textContent) {
      return true;
    }

    const style = window.getComputedStyle(node);
    return style.display === 'none' || style.visibility === 'hidden';
  }

  function jumpToClause(clauseId) {
    if (!clauseId) {
      return;
    }

    const node = document.querySelector(`[${CLAUSE_ATTR}="${escapeCss(clauseId)}"]`);
    if (!node) {
      return;
    }

    clearHighlights();
    node.classList.add(HIGHLIGHT_CLASS);
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => {
      node.classList.remove(HIGHLIGHT_CLASS);
    }, 2800);
  }

  function clearHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((node) => node.classList.remove(HIGHLIGHT_CLASS));
  }

  function ensureStyles() {
    if (document.getElementById('terms-lens-styles')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'terms-lens-styles';
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        outline: 3px solid rgba(14, 116, 144, 0.34);
        background: rgba(253, 230, 138, 0.45);
        transition: background 220ms ease;
      }
      .terms-lens-badge {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        border-radius: 999px;
        background: rgba(255, 252, 245, 0.96);
        color: #0f172a;
        font: 600 13px/1.1 "Aptos", "Segoe UI", system-ui, sans-serif;
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.16);
        cursor: pointer;
        backdrop-filter: blur(10px);
      }
      .terms-lens-badge strong {
        font-weight: 700;
      }
      .terms-lens-badge[data-hidden="true"] {
        display: none;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function scheduleBadgeRefresh() {
    window.setTimeout(() => {
      cachedDetection = detectPage();
      toggleBadge(cachedDetection);
    }, 800);
  }

  function toggleBadge(detection) {
    let badge = document.getElementById('terms-lens-badge');
    if (!badge) {
      badge = document.createElement('button');
      badge.id = 'terms-lens-badge';
      badge.className = 'terms-lens-badge';
      badge.type = 'button';
      badge.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }).catch((error) => {
          console.error('Failed to open Terms Lens panel:', error);
        });
      });
      document.documentElement.appendChild(badge);
    }

    if (!detection || (!detection.isLegalPage && !detection.hasLegalLinks)) {
      badge.dataset.hidden = 'true';
      return;
    }

    badge.dataset.hidden = 'false';
    badge.innerHTML = `<strong>Terms Lens</strong><span>Review this ${detection.pageType} page</span>`;
  }

  function normalizeUrlForDedup(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.toString();
    } catch (_error) {
      return url;
    }
  }

  function addWeight(weights, key, value) {
    weights[key] = (weights[key] || 0) + value;
  }

  function cleanText(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function slugify(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'section';
  }

  function escapeCss(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
})();
