(function () {
  const LEGAL_KEYWORDS = [
    { regex: /\bterms\b|\bconditions\b|\bterms-of-service\b|\btos\b/i, type: 'terms', weight: 0.42, signal: 'terms-keyword' },
    { regex: /\bprivacy\b|\bpersonal data\b|\bdata policy\b/i, type: 'privacy', weight: 0.45, signal: 'privacy-keyword' },
    { regex: /\bcookie\b/i, type: 'cookies', weight: 0.28, signal: 'cookie-keyword' },
    { regex: /\brefund\b|\breturns?\b|\bcancellation\b/i, type: 'refund', weight: 0.22, signal: 'refund-keyword' },
    { regex: /\blegal\b|\barbitration\b|\bliability\b|\bacceptable use\b|\beula\b/i, type: 'legal', weight: 0.25, signal: 'legal-keyword' }
  ];
  const NOISE_SELECTORS = ['nav', 'header', 'footer', 'aside', 'form', 'script', 'style', 'noscript'];
  const CONTENT_SELECTORS = [
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
      case 'EXTRACT_PAGE':
        cachedDetection = detectPage();
        const sections = extractSections();
        toggleBadge(cachedDetection);
        return {
          url: location.href,
          title: document.title || '',
          detection: cachedDetection,
          metadata: buildMetadata(sections),
          sections
        };
      case 'JUMP_TO_CITATION':
        jumpToClause(message.clauseId);
        return { ok: true };
      default:
        throw new Error(`Unknown content message type: ${message.type}`);
    }
  }

  function detectPage() {
    const url = location.href;
    const title = document.title || '';
    const headings = Array.from(document.querySelectorAll('h1, h2')).map((node) => cleanText(node.textContent));
    const signalPool = [url, title, headings.join(' '), cleanText(document.body?.innerText || '').slice(0, 2400)].join(' ');
    const lowerPath = `${location.pathname} ${location.hostname}`.toLowerCase();
    const signals = [];
    const weights = {};

    if (/\/(terms|conditions|privacy|cookies?|refund|legal|policy|acceptable-use|eula|billing)/i.test(lowerPath)) {
      signals.push('url-legal-pattern');
      weights.generic = (weights.generic || 0) + 0.34;
    }

    if (headings.some((heading) => /terms|privacy|cookies?|refund|legal|policy|conditions/i.test(heading))) {
      signals.push('heading-match');
      weights.generic = (weights.generic || 0) + 0.26;
    }

    LEGAL_KEYWORDS.forEach((keyword) => {
      if (keyword.regex.test(signalPool)) {
        weights[keyword.type] = (weights[keyword.type] || 0) + keyword.weight;
        signals.push(keyword.signal);
      }
    });

    if ((document.body?.innerText || '').length > 5000) {
      signals.push('long-form-document');
      weights.generic = (weights.generic || 0) + 0.12;
    }

    if (/blog|docs|press|careers|about/.test(lowerPath) && !/privacy|terms|policy/.test(lowerPath)) {
      signals.push('non-legal-route');
      weights.generic = Math.max((weights.generic || 0) - 0.18, 0);
    }

    const ranked = Object.entries(weights).sort((a, b) => b[1] - a[1]);
    const top = ranked[0] || ['generic', 0];
    const confidence = Math.max(0, Math.min(0.99, top[1]));

    return {
      isLegalPage: confidence >= 0.42,
      pageType: top[0] === 'generic' ? inferGenericType(signalPool) : top[0],
      confidence,
      signals: Array.from(new Set(signals)),
      title,
      url
    };
  }

  function inferGenericType(text) {
    if (/privacy/i.test(text)) return 'privacy';
    if (/cookie/i.test(text)) return 'cookies';
    if (/refund|return|cancellation/i.test(text)) return 'refund';
    if (/terms|conditions|service/i.test(text)) return 'terms';
    return 'generic';
  }

  function extractSections() {
    const root = pickContentRoot();
    const elements = Array.from(root.querySelectorAll(TEXT_SELECTORS));
    const sections = [];
    let current = createSection('Overview', root);

    for (const node of elements) {
      if (shouldIgnoreNode(node)) {
        continue;
      }

      const text = cleanText(node.textContent);
      if (!text || text.length < 20) {
        continue;
      }

      if (/^H[1-4]$/.test(node.tagName)) {
        if (current.text.length > 80 || current.bullets.length) {
          finalizeSection(current, sections);
        }
        current = createSection(text, node);
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
    }

    finalizeSection(current, sections);
    return sections
      .map((section, index) => ({
        id: section.id || `section-${index + 1}`,
        heading: section.heading,
        text: cleanText(section.text),
        order: index,
        citations: [...section.paragraphs, ...section.bullets],
        jumpTarget: section.jumpTarget
      }))
      .filter((section) => section.text.length >= 80)
      .slice(0, 60);
  }

  function pickContentRoot() {
    const candidates = CONTENT_SELECTORS
      .map((selector) => document.querySelector(selector))
      .filter(Boolean)
      .filter((element) => (element.innerText || '').length > 1200);

    if (candidates.length) {
      candidates.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
      return candidates[0];
    }

    return document.body;
  }

  function createSection(heading, anchorNode) {
    return {
      id: slugify(heading),
      heading,
      text: '',
      paragraphs: [],
      bullets: [],
      jumpTarget: buildSelector(anchorNode)
    };
  }

  function finalizeSection(section, sections) {
    if (!section.text.trim()) {
      return;
    }
    sections.push(section);
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

    if (NOISE_SELECTORS.some((selector) => node.closest(selector))) {
      return true;
    }

    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return true;
    }

    return false;
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

    if (!detection || !detection.isLegalPage) {
      badge.dataset.hidden = 'true';
      return;
    }

    badge.dataset.hidden = 'false';
    badge.innerHTML = `<strong>Terms Lens</strong><span>Review this ${detection.pageType} page</span>`;
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
