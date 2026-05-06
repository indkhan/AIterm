const HTML_TEXT_TAGS = ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'td', 'th', 'blockquote'];
const MIN_USEFUL_CHARS = 1500;
const HIDDEN_TAB_TIMEOUT_MS = 30000;

export async function fetchPolicyContent({ url, originPageUrl }) {
  let primary;
  try {
    primary = await fetchAndParse(url);
  } catch (error) {
    primary = { sections: [], totalChars: 0, error: error.message };
  }

  if (primary.totalChars >= MIN_USEFUL_CHARS && primary.sections.length) {
    return shapeResult({ url, originPageUrl, ...primary, source: 'fetch' });
  }

  try {
    const fallback = await fetchViaHiddenTab(url);
    if (fallback.totalChars >= 200 && fallback.sections.length) {
      return shapeResult({ url, originPageUrl, ...fallback, source: 'hidden-tab' });
    }
  } catch (_error) {
    /* fall through */
  }

  if (primary.sections.length) {
    return shapeResult({ url, originPageUrl, ...primary, source: 'fetch-thin' });
  }

  throw new Error(primary.error || 'Could not fetch policy page contents.');
}

async function fetchAndParse(url) {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  const html = await response.text();
  return parseHtmlToSections(html);
}

function parseHtmlToSections(html) {
  if (typeof DOMParser === 'undefined') {
    return parseFallback(html);
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, svg, nav, header, footer, aside, [role="navigation"], [aria-hidden="true"]').forEach((node) => node.remove());

  const root = doc.querySelector('main, article, [role="main"], .policy, .legal, .terms, .privacy, .content, #content, #main') || doc.body;
  if (!root) return { sections: [], totalChars: 0, title: '' };

  const title = clean(doc.title || '');
  const sections = extractSections(root);
  const totalChars = sections.reduce((sum, s) => sum + s.text.length, 0);
  return { sections, totalChars, title };
}

function extractSections(root) {
  const nodes = Array.from(root.querySelectorAll(HTML_TEXT_TAGS.join(',')));
  if (!nodes.length) {
    const text = clean(root.textContent || '');
    return text ? [{ id: 'overview', heading: 'Overview', text, order: 0 }] : [];
  }

  const sections = [];
  let current = makeSection('Overview');
  let order = 0;

  for (const node of nodes) {
    const text = clean(node.textContent || '');
    if (!text) continue;

    if (/^H[1-4]$/.test(node.tagName)) {
      if (current.text.length >= 60) {
        current.order = order++;
        sections.push(current);
      }
      current = makeSection(text);
      continue;
    }

    current.text += `${text}\n\n`;
  }

  if (current.text.length >= 60) {
    current.order = order++;
    sections.push(current);
  }

  return sections.map((s) => ({ ...s, text: clean(s.text) })).slice(0, 200);
}

function parseFallback(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? clean(stripHtml(titleMatch[1])) : '';
  const text = clean(stripHtml(html));
  if (!text) return { sections: [], totalChars: 0, title };

  const sections = [{ id: 'overview', heading: title || 'Policy', text: text.slice(0, 80000), order: 0 }];
  return { sections, totalChars: sections[0].text.length, title };
}

async function fetchViaHiddenTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  if (!tabId) throw new Error('Failed to open background tab');

  try {
    await waitForTabComplete(tabId, HIDDEN_TAB_TIMEOUT_MS);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractInTab,
    });
    return result?.result || { sections: [], totalChars: 0, title: '' };
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Hidden tab load timeout'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function extractInTab() {
  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  document.querySelectorAll('script, style, noscript, svg').forEach((node) => node.remove());
  const root = document.querySelector('main, article, [role="main"], .policy, .legal, .terms, .privacy, .content, #content, #main') || document.body;
  if (!root) return { sections: [], totalChars: 0, title: document.title || '' };

  const tags = ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'td', 'th', 'blockquote'];
  const nodes = Array.from(root.querySelectorAll(tags.join(',')));
  const sections = [];
  let current = { heading: 'Overview', text: '' };
  let order = 0;

  for (const node of nodes) {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const text = clean(node.textContent || '');
    if (!text) continue;

    if (/^H[1-4]$/.test(node.tagName)) {
      if (current.text.length >= 60) {
        sections.push({ id: `section-${order}`, heading: current.heading, text: clean(current.text), order: order++ });
      }
      current = { heading: text, text: '' };
      continue;
    }

    current.text += `${text}\n\n`;
  }

  if (current.text.length >= 60) {
    sections.push({ id: `section-${order}`, heading: current.heading, text: clean(current.text), order: order++ });
  }

  const totalChars = sections.reduce((sum, s) => sum + s.text.length, 0);
  return { sections: sections.slice(0, 200), totalChars, title: document.title || '' };
}

function shapeResult({ url, originPageUrl, sections, totalChars, title, source }) {
  return {
    url,
    title: title || url,
    sections: sections.map((s, i) => ({
      id: s.id || `section-${i}`,
      heading: s.heading,
      text: s.text,
      order: i,
    })),
    totalChars,
    source,
    originPageUrl,
    fetchedAt: new Date().toISOString(),
  };
}

function makeSection(heading) {
  return { id: slugify(heading), heading, text: '', order: 0 };
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'section';
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
