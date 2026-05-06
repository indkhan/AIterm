import { callLLM, parseJsonContent } from './llm-client.js';
import {
  buildAnalyzerMessages,
  buildMapMessages,
  buildReduceMessages,
} from './prompts.js';

const SINGLE_PASS_CHAR_BUDGET = 90000;
const TARGET_CHUNK_CHARS = 24000;
const HARD_TRUNCATE_CHARS = 1200000;
const MAP_CONCURRENCY = 4;

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

export function buildSectionsText(sections) {
  return sections
    .map((section, index) => {
      const heading = section.heading || `Section ${index + 1}`;
      return `### ${heading}\n${section.text || ''}`;
    })
    .join('\n\n');
}

export function buildChunks(sections) {
  if (!sections.length) return [];

  const chunks = [];
  let buffer = [];
  let bufferChars = 0;
  let chunkIndex = 0;

  const flushBuffer = () => {
    if (!buffer.length) return;
    const heading = buffer.length === 1
      ? buffer[0].heading
      : `${buffer[0].heading} … ${buffer[buffer.length - 1].heading}`;
    chunks.push({
      chunkId: `chunk-${chunkIndex++}`,
      heading,
      sectionIndexes: buffer.map((s) => s.index),
      text: buffer
        .map((s) => `### ${s.heading || `Section ${s.index + 1}`}\n${s.text || ''}`)
        .join('\n\n'),
    });
    buffer = [];
    bufferChars = 0;
  };

  sections.forEach((section, index) => {
    const sectionChars = (section.text || '').length;
    const sectionEntry = { index, heading: section.heading || `Section ${index + 1}`, text: section.text || '' };

    if (sectionChars > TARGET_CHUNK_CHARS) {
      flushBuffer();
      const sliceSize = Math.floor(TARGET_CHUNK_CHARS * 0.9);
      const text = section.text || '';
      for (let start = 0; start < text.length; start += sliceSize) {
        const slice = text.slice(start, start + sliceSize);
        const partLabel = `${section.heading || `Section ${index + 1}`} (part ${Math.floor(start / sliceSize) + 1})`;
        chunks.push({
          chunkId: `chunk-${chunkIndex++}`,
          heading: partLabel,
          sectionIndexes: [index],
          text: `### ${partLabel}\n${slice}`,
        });
      }
      return;
    }

    if (bufferChars + sectionChars > TARGET_CHUNK_CHARS && buffer.length) {
      flushBuffer();
    }

    buffer.push(sectionEntry);
    bufferChars += sectionChars + 80;
  });

  flushBuffer();
  return chunks;
}

export async function runLongDocAnalysis({
  sections,
  url,
  title,
  llmConfig,
  onProgress,
}) {
  if (!sections.length) {
    throw new Error('No policy sections to analyze.');
  }

  const totalChars = sections.reduce((sum, s) => sum + (s.text || '').length, 0);

  if (totalChars <= SINGLE_PASS_CHAR_BUDGET) {
    onProgress?.({ stage: 'single-pass', completed: 0, total: 1 });
    const sectionsText = buildSectionsText(sections);
    const result = await callLLM({
      provider: llmConfig.provider,
      apiKey: llmConfig.apiKey,
      model: llmConfig.analysisModel,
      baseUrlOverride: llmConfig.baseUrlOverride,
      messages: buildAnalyzerMessages({ url, title, sectionsText }),
      jsonMode: true,
      maxTokens: 2200,
      temperature: 0.2,
    });
    onProgress?.({ stage: 'single-pass', completed: 1, total: 1 });
    return parseJsonContent(result.content);
  }

  let workingSections = sections;
  if (totalChars > HARD_TRUNCATE_CHARS) {
    let running = 0;
    workingSections = [];
    for (const section of sections) {
      const len = (section.text || '').length;
      if (running + len > HARD_TRUNCATE_CHARS) break;
      workingSections.push(section);
      running += len;
    }
  }

  const chunks = buildChunks(workingSections);
  onProgress?.({ stage: 'map', completed: 0, total: chunks.length });

  const mapResults = new Array(chunks.length);
  let completed = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const chunk = chunks[idx];
      try {
        const response = await callLLM({
          provider: llmConfig.provider,
          apiKey: llmConfig.apiKey,
          model: llmConfig.analysisModel,
          baseUrlOverride: llmConfig.baseUrlOverride,
          messages: buildMapMessages({ heading: chunk.heading, text: chunk.text, chunkId: chunk.chunkId }),
          jsonMode: true,
          maxTokens: 1400,
          temperature: 0.2,
        });
        const parsed = parseJsonContent(response.content);
        mapResults[idx] = {
          chunkId: chunk.chunkId,
          heading: chunk.heading,
          sectionIndexes: chunk.sectionIndexes,
          ...parsed,
        };
      } catch (error) {
        mapResults[idx] = {
          chunkId: chunk.chunkId,
          heading: chunk.heading,
          sectionIndexes: chunk.sectionIndexes,
          chunkSummary: '',
          keyPoints: [],
          risks: [],
          error: error.message,
        };
      } finally {
        completed += 1;
        onProgress?.({ stage: 'map', completed, total: chunks.length });
      }
    }
  }

  const workers = Array.from({ length: Math.min(MAP_CONCURRENCY, chunks.length) }, worker);
  await Promise.all(workers);

  onProgress?.({ stage: 'reduce', completed: 0, total: 1 });

  const reduceResponse = await callLLM({
    provider: llmConfig.provider,
    apiKey: llmConfig.apiKey,
    model: llmConfig.analysisModel,
    baseUrlOverride: llmConfig.baseUrlOverride,
    messages: buildReduceMessages({ url, title, mapResults }),
    jsonMode: true,
    maxTokens: 2400,
    temperature: 0.2,
  });

  onProgress?.({ stage: 'reduce', completed: 1, total: 1 });
  const reduced = parseJsonContent(reduceResponse.content);
  reduced._mapDiagnostics = mapResults.map((r) => ({
    chunkId: r.chunkId,
    heading: r.heading,
    error: r.error || null,
  }));
  return reduced;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'doing', 'will', 'would',
  'should', 'could', 'may', 'might', 'must', 'can', 'shall', 'to', 'of', 'in',
  'on', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'from', 'up', 'down',
  'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here',
  'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'this', 'that', 'these', 'those',
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'them', 'us', 'me', 'my', 'your',
  'our', 'their', 'his', 'her', 'its',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => stem(w));
}

function stem(word) {
  if (word.length <= 4) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('es')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  return word;
}

export function buildLexicalIndex(sections) {
  const docs = sections.map((section, index) => ({
    index,
    heading: section.heading || `Section ${index + 1}`,
    text: section.text || '',
    tokens: tokenize(`${section.heading || ''} ${section.text || ''}`),
  }));

  const docFreq = new Map();
  for (const doc of docs) {
    const seen = new Set();
    for (const token of doc.tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }

  const N = docs.length || 1;
  const avgLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / N || 1;
  return { docs, docFreq, N, avgLen };
}

export function topSections(index, query, k = 3) {
  if (!index || !index.docs.length) return [];
  const queryTokens = tokenize(query);
  if (!queryTokens.length) {
    return index.docs.slice(0, k).map((doc) => ({ ...doc, score: 0 }));
  }

  const k1 = 1.5;
  const b = 0.75;
  const scored = index.docs.map((doc) => {
    let score = 0;
    const docLen = doc.tokens.length || 1;
    const tf = new Map();
    for (const token of doc.tokens) tf.set(token, (tf.get(token) || 0) + 1);
    for (const token of queryTokens) {
      const f = tf.get(token) || 0;
      if (!f) continue;
      const df = index.docFreq.get(token) || 0;
      const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
      const num = f * (k1 + 1);
      const denom = f + k1 * (1 - b + b * (docLen / index.avgLen));
      score += idf * (num / denom);
    }
    return { ...doc, score };
  });

  return scored
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function summarizeIndex(index, excludeIndexes = []) {
  const exclude = new Set(excludeIndexes);
  return index.docs
    .filter((doc) => !exclude.has(doc.index))
    .map((doc) => ({ index: doc.index, heading: doc.heading, preview: doc.text.slice(0, 140) }));
}
