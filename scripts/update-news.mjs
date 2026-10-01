#!/usr/bin/env node
/**
 * Quarterly regulatory/statistical news updater for the Share section.
 *
 * Pipeline: Firecrawl fetches candidate articles -> keyword pre-filter ->
 * Claude API judges relevance + writes bilingual tag/summary -> merge into
 * data/news.json (deduped by link, newest first, capped per channel) ->
 * the same JSON is mirrored into index.html's #news-data-fallback script
 * (used only when the page is opened via file:// and fetch() can't run).
 *
 * Required environment variables (set as GitHub Actions secrets):
 *   FIRECRAWL_API_KEY   - https://www.firecrawl.dev/
 *   ANTHROPIC_API_KEY   - https://console.anthropic.com/
 * Optional:
 *   ANTHROPIC_MODEL     - defaults to claude-haiku-4-5-20251001
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NEWS_JSON_PATH = path.join(ROOT, 'data', 'news.json');
const INDEX_HTML_PATH = path.join(ROOT, 'index.html');

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const MAX_NEW_PER_CHANNEL = 5; // cap Claude calls / noise per run
const MAX_ITEMS_PER_CHANNEL = 15; // cap total feed length

const KEYWORDS_EN = [
  'statistical', 'biostatistics', 'endpoint', 'estimand', 'sample size',
  'adaptive design', 'trial design', 'subgroup analysis', 'missing data',
  'multiplicity', 'real-world evidence', 'bayesian'
];
const KEYWORDS_ZH = [
  '統計', '生物統計', '終點', '樣本數', '檢定力', '調整性設計', '適應性設計',
  '試驗設計', '次族群', '亞群', '遺漏值', '缺失資料', '多重性', '多重比較', '真實世界'
];

function isRelevantByKeyword(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return KEYWORDS_EN.some((k) => lower.includes(k)) || KEYWORDS_ZH.some((k) => text.includes(k));
}

function assertEnv() {
  const missing = [];
  if (!FIRECRAWL_API_KEY) missing.push('FIRECRAWL_API_KEY');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
    process.exit(1);
  }
}

async function firecrawlSearch(query, opts = {}) {
  const res = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${FIRECRAWL_API_KEY}`
    },
    body: JSON.stringify({ query, limit: opts.limit || 8 })
  });
  if (!res.ok) throw new Error(`Firecrawl search failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return json?.data?.web || [];
}

async function firecrawlScrape(url) {
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${FIRECRAWL_API_KEY}`
    },
    body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true })
  });
  if (!res.ok) throw new Error(`Firecrawl scrape failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return json?.data?.markdown || '';
}

async function claudeJudgeAndSummarize(article) {
  const prompt = `You help curate a "Regulatory & Statistical News" feed for a clinical biostatistics consulting website aimed at biotech/pharma sponsors.

Article title: ${article.title}
Source: ${article.source}
URL: ${article.url}
Context/snippet: ${article.snippet || '(none)'}

Relevant topics (the article should genuinely relate to at least one, not just mention in passing): ${[...KEYWORDS_EN, ...KEYWORDS_ZH].join(', ')}

Decide if this is genuinely useful for a biostatistician audience (trial design, analysis methodology, regulatory statistics) — NOT general drug-approval news, procurement notices, job postings, or unrelated administrative announcements.

Respond with ONLY a raw JSON object (no markdown fences, no commentary):
{
  "relevant": true or false,
  "tag_zh": "short 2-6 character Chinese tag, e.g. 貝氏統計",
  "tag_en": "short 2-4 word English tag, e.g. Bayesian Statistics",
  "summary_zh": "1-2 sentence Traditional Chinese summary written for a biostatistics consulting audience",
  "summary_en": "1-2 sentence English summary written for a biostatistics consulting audience"
}
If relevant is false, still return the shape but the other fields may be empty strings.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const text = data?.content?.[0]?.text || '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : text);
}

// Same document often appears under different URLs (guidance page vs. PDF
// download) with suffixes like "(Draft Guidance)" or "(January 2026)".
function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\([^)]*\)|（[^）]*）/g, '')
    .replace(/[^a-z0-9一-鿿]+/g, '');
}

function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

// ---------------- FDA ----------------
async function fetchFdaCandidates() {
  const candidates = [];

  // Primary source: FDA Office of Biostatistics' curated "Recent Statistical
  // Guidance Documents" list — already scoped to the right topic.
  try {
    const markdown = await firecrawlScrape('https://www.fda.gov/about-fda/cder-offices-and-divisions/office-biostatistics');
    const section = markdown.split('Recent Statistical Guidance Documents')[1]?.split('## ')[0] || '';
    const linkRe = /-\s*\[([^\]]+)\]\((https:\/\/www\.fda\.gov[^\s)]+)/g;
    let m;
    while ((m = linkRe.exec(section))) {
      candidates.push({
        title: m[1].trim(),
        url: m[2].trim(),
        source: 'FDA — Office of Biostatistics, CDER',
        snippet: ''
      });
    }
  } catch (e) {
    console.warn('FDA Office of Biostatistics scrape failed:', e.message);
  }

  // Supplementary: broader search for recent press announcements / guidance news.
  try {
    const results = await firecrawlSearch('FDA guidance biostatistics clinical trial statistical methods', { limit: 6 });
    for (const r of results) {
      if (!/fda\.gov/.test(r.url)) continue;
      candidates.push({ title: r.title, url: r.url, source: 'FDA', snippet: r.description || '' });
    }
  } catch (e) {
    console.warn('FDA search failed:', e.message);
  }

  return candidates;
}

// ---------------- Taiwan (CDE) ----------------
async function fetchTaiwanCandidates() {
  const candidates = [];
  try {
    const markdown = await firecrawlScrape('https://www.cde.org.tw/');
    const itemRe = /\[(\d{4}-\d{2}-\d{2})\\*\n+([^\]]+)\]\((https:\/\/www\.cde\.org\.tw[^\s)]+)/g;
    let m;
    while ((m = itemRe.exec(markdown))) {
      candidates.push({
        title: m[2].trim(),
        url: m[3].trim(),
        date: m[1].trim(),
        source: '財團法人醫藥品查驗中心（CDE）',
        snippet: ''
      });
    }
  } catch (e) {
    console.warn('CDE homepage scrape failed:', e.message);
  }
  return candidates;
}

function mergeChannel(existing, newItems) {
  const byLink = new Map();
  for (const item of existing) byLink.set(item.link, item);
  for (const item of newItems) if (!byLink.has(item.link)) byLink.set(item.link, item);
  return Array.from(byLink.values())
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, MAX_ITEMS_PER_CHANNEL);
}

async function processChannel(channelName, candidates, existingItems) {
  const existingLinks = new Set(existingItems.map((i) => i.link));
  const existingTitles = new Set(existingItems.map((i) => titleKey(i.title)));
  const fresh = candidates.filter(
    (c) => c.url && !existingLinks.has(c.url) && !existingTitles.has(titleKey(c.title))
  );

  // De-dupe candidates from multiple sources by URL and title, then keyword pre-filter.
  const seen = new Set();
  const deduped = [];
  for (const c of fresh) {
    const key = titleKey(c.title);
    if (seen.has(c.url) || seen.has(key)) continue;
    seen.add(c.url);
    seen.add(key);
    if (isRelevantByKeyword(`${c.title} ${c.snippet || ''}`)) deduped.push(c);
  }

  const accepted = [];
  for (const candidate of deduped.slice(0, MAX_NEW_PER_CHANNEL)) {
    try {
      const judged = await claudeJudgeAndSummarize({ ...candidate, source: candidate.source });
      if (!judged.relevant) {
        console.log(`[${channelName}] skipped (not relevant): ${candidate.title}`);
        continue;
      }
      accepted.push({
        id: slugify(candidate.url),
        title: candidate.title,
        source: candidate.source,
        date: candidate.date || new Date().toISOString().slice(0, 10),
        link: candidate.url,
        tag_zh: judged.tag_zh || '',
        tag_en: judged.tag_en || '',
        summary_zh: judged.summary_zh || '',
        summary_en: judged.summary_en || ''
      });
      console.log(`[${channelName}] added: ${candidate.title}`);
    } catch (e) {
      console.warn(`[${channelName}] Claude judging failed for "${candidate.title}":`, e.message);
    }
  }

  return mergeChannel(existingItems, accepted);
}

async function syncIndexHtmlFallback(newsData) {
  let html;
  try {
    html = await readFile(INDEX_HTML_PATH, 'utf8');
  } catch (e) {
    console.warn('Could not read index.html to sync fallback data — skipping.', e.message);
    return;
  }
  const jsonStr = JSON.stringify(newsData, null, 2);
  const re = /(<script id="news-data-fallback" type="application\/json">\s*)([\s\S]*?)(\s*<\/script>)/;
  if (!re.test(html)) {
    console.warn('news-data-fallback script block not found in index.html — skipping sync.');
    return;
  }
  const updated = html.replace(re, `$1${jsonStr}\n  $3`);
  await writeFile(INDEX_HTML_PATH, updated, 'utf8');
}

async function main() {
  assertEnv();

  let existing = { updated: '', fda: [], taiwan: [] };
  try {
    existing = JSON.parse(await readFile(NEWS_JSON_PATH, 'utf8'));
  } catch (e) {
    console.warn('No existing data/news.json found (or unreadable) — starting fresh.');
  }

  const [fdaCandidates, taiwanCandidates] = await Promise.all([
    fetchFdaCandidates(),
    fetchTaiwanCandidates()
  ]);

  const fda = await processChannel('fda', fdaCandidates, existing.fda || []);
  const taiwan = await processChannel('taiwan', taiwanCandidates, existing.taiwan || []);

  const result = { updated: new Date().toISOString().slice(0, 10), fda, taiwan };

  await writeFile(NEWS_JSON_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await syncIndexHtmlFallback(result);

  console.log(`Done. FDA: ${fda.length} items, Taiwan: ${taiwan.length} items.`);
}

main().catch((err) => {
  console.error('update-news failed:', err);
  process.exit(1);
});
