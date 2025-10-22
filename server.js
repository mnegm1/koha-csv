/* eslint-disable no-console */
// backend/server.js
// ECSSR AI Assistant — Arabic Question Detection + Author/Subject Disambiguation
// Strict Field Boundaries + Lightweight "Learning" (memory.json)

const express = require('express');
const cors = require('cors');
let fetchFn = global.fetch;
try {
  if (!fetchFn) {
    // Node <18 fallback
    // eslint-disable-next-line import/no-extraneous-dependencies
    fetchFn = require('node-fetch');
  }
} catch (_) { /* ignore */ }

const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || 'pplx-YOUR-API-KEY-HERE';
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

// ---------- App middleware ----------
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- Simple rate limit ----------
const requestCounts = new Map();
const RATE_LIMIT = 100; // req/hour per IP
const RATE_WINDOW = 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const userRequests = requestCounts.get(ip) || [];
  const recentRequests = userRequests.filter((t) => now - t < RATE_WINDOW);
  if (recentRequests.length >= RATE_LIMIT) return false;
  recentRequests.push(now);
  requestCounts.set(ip, recentRequests);
  return true;
}

// ---------- Tiny learning memory (file-backed) ----------
const MEMORY_FILE = path.join(__dirname, 'memory.json');
let memory = {
  // key: normalizedQuery
  // value: { count, lastField: 'summary'|'author'|'subject', lastAtISO, lastAnswerPreview }
};

try {
  if (fs.existsSync(MEMORY_FILE)) {
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    memory = JSON.parse(raw);
  }
} catch (e) {
  console.warn('⚠️ Could not read memory.json; starting fresh.', e.message);
}

let dirtyWrites = 0;
function persistMemory(throttle = true) {
  try {
    if (throttle) {
      dirtyWrites += 1;
      if (dirtyWrites < 10) return; // flush every ~10 writes
      dirtyWrites = 0;
    }
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ Could not write memory.json:', e.message);
  }
}

// ---------- Arabic utils & classification ----------
const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g;
const TATWEEL = /\u0640/g;

function normalizeArabic(s = '') {
  return String(s)
    .replace(ARABIC_DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[إأٱآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

function isArabicText(s = '') {
  return /[\u0600-\u06FF]/.test(s);
}

function isArabicQuestion(s = '') {
  // leading interrogatives (Arabic), also accept “هل”
  const q = normalizeArabic(s);
  return /^(ما|ماذا|كيف|اين|متى|من|لماذا|هل)\b/.test(q);
}

function isEnglishQuestion(s = '') {
  return /^\s*(what|how|where|when|who|why|which)\b/i.test(s);
}

function looksLikeAuthorQuery(s = '') {
  // cues: "by X", "تأليف", "لـ", "ل ", "كتاب [اسم]" (weak), two–three name tokens, commas between names
  const txt = s.trim();

  if (/\bby\s+[\p{L}\s\.\-']{2,}$/iu.test(txt)) return true;
  if (/[،,]\s*[\p{L}\-'.]+\s*$/u.test(txt) && /\bby\b/i.test(txt)) return true;

  const n = normalizeArabic(txt);
  if (/(تأليف|لـ|لِ|بقلم)\s+[\p{L}\s\.\-']{2,}$/u.test(n)) return true;

  // Heuristic: Latin name shape => 2–4 capitalized tokens
  const latinNameTokens = txt.match(/\b[A-Z][a-z\-']+\b/g);
  if (latinNameTokens && latinNameTokens.length >= 2 && latinNameTokens.length <= 4) return true;

  // Heuristic: Arabic name shape (contains بن/ابن/آل)
  if (/\b(بن|ابن|آل)\b/.test(n) && n.split(/\s+/).length >= 2) return true;

  return false;
}

function classifyField(query, hintedField) {
  // Priority: hintedField (from UI) > learned memory > question → summary > author heuristic > subject
  if (hintedField && ['summary', 'author', 'subject'].includes(hintedField)) return hintedField;

  const key = normalizeArabic(query).toLowerCase();
  if (memory[key]?.lastField) return memory[key].lastField;

  if (isArabicQuestion(query) || isEnglishQuestion(query)) return 'summary';
  if (looksLikeAuthorQuery(query)) return 'author';
  return 'subject';
}

// ---------- Perplexity call ----------
async function callPerplexity(messages, model = 'sonar-pro') {
  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'pplx-YOUR-API-KEY-HERE') {
    throw new Error('Perplexity API key not configured (PERPLEXITY_API_KEY).');
  }

  const resp = await fetchFn(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.05,
      max_tokens: 800,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Perplexity API error: ${resp.status} - ${errText}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

// ---------- Prompt builders (strict boundaries) ----------
function buildFieldInstructions(searchField, books) {
  let fieldInstructions = '';
  let availableData = '';

  if (searchField === 'summary') {
    fieldInstructions =
      `⚠️ CRITICAL FIELD RULE: SUMMARY Q&A
You are answering a QUESTION. Use ONLY these fields:
✅ ALLOWED: summary, contents
❌ FORBIDDEN: Do NOT use author or subject or title fields
❌ Do NOT mention author names unless they appear in the summary text`;

    availableData = books.map(b =>
      `Book ID ${b.id}:
Summary: ${b.summary || 'No summary'}
Contents: ${b.contents || ''}
---`).join('\n');
  } else if (searchField === 'subject') {
    fieldInstructions =
      `⚠️ CRITICAL FIELD RULE: SUBJECT/TOPIC SEARCH
You are searching for books ABOUT a topic. Use ONLY these fields:
✅ ALLOWED: subject, title
❌ FORBIDDEN: Do NOT use author or summary`;

    availableData = books.map(b =>
      `Book ID ${b.id}:
Title: ${b.title || ''}
Subject: ${b.subject || 'No subject'}
---`).join('\n');
  } else if (searchField === 'author') {
    fieldInstructions =
      `⚠️ CRITICAL FIELD RULE: AUTHOR SEARCH
You are listing books BY an author. Use ONLY these fields:
✅ ALLOWED: author, title (to show book names)
❌ FORBIDDEN: Do NOT use subject or summary`;

    availableData = books.map(b =>
      `Book ID ${b.id}:
Title: ${b.title || ''}
Author: ${b.author || ''}
---`).join('\n');
  } else {
    fieldInstructions =
      `⚠️ FIELD RULE: DEFAULT VIEW
Prefer ALLOWED fields for the task. Do NOT mix in forbidden fields.`;
    availableData = books.map(b =>
      `Book ID ${b.id}:
Title: ${b.title || ''}
Author: ${b.author || ''}
Subject: ${b.subject || ''}
Summary: ${b.summary || ''}
---`).join('\n');
  }

  return { fieldInstructions, availableData };
}

function buildSystemPrompt(searchField) {
  if (searchField === 'summary') {
    return 'You answer questions using ONLY summaries/contents. NEVER mention authors unless they appear in the summary.';
  }
  if (searchField === 'subject') {
    return 'You list books about topics using ONLY subject and title. NEVER use author or summary.';
  }
  if (searchField === 'author') {
    return 'You list books BY authors using ONLY author and title.';
  }
  return 'Use only provided data fields and follow boundary rules.';
}

// ---------- Routes ----------

// Field classifier (optional for frontend to call)
app.post('/api/classify', (req, res) => {
  try {
    const { query, searchField } = req.body || {};
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: 'Query is required' });
    }
    const chosen = classifyField(String(query), searchField);
    return res.json({
      chosenField: chosen,
      reason: chosen === 'summary'
        ? 'Detected question form (Arabic/English interrogatives).'
        : chosen === 'author'
          ? 'Detected author-like query (name cues / by/تأليف/لـ).'
          : 'Defaulted to topic search (subject).',
    });
  } catch (e) {
    console.error('Classify error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// Main chat endpoint
app.post('/api/chat', async (req, res) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
  }

  try {
    const { query, matchedBooks = [], searchField: hintedField } = req.body || {};
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Auto-classify if the UI didn't provide it
    const searchField = classifyField(String(query), hintedField);

    if (!Array.isArray(matchedBooks) || matchedBooks.length === 0) {
      // No candidate books from frontend filter
      return res.json({
        answer: 'لم أجد كتباً تطابق سؤالك في الكتالوج.<br/>I did not find any matching books in the catalog.',
        bookIds: [],
        chosenField: searchField,
      });
    }

    // Build strict prompts
    const { fieldInstructions, availableData } = buildFieldInstructions(searchField, matchedBooks);

    const prompt = `
You are a library assistant. Follow the field rules STRICTLY.

${fieldInstructions}

CRITICAL RULES:
1) ONLY use the fields specified as ALLOWED above
2) NEVER use fields marked as FORBIDDEN
3) NEVER use your general knowledge
4) NEVER invent information
5) If you cannot answer from ALLOWED fields, say exactly: "المعلومات غير متوفرة / Information not available"
6) When mentioning books, include their ID like this: (ID: 123)
7) Answer in the SAME language as the query

USER QUERY: "${query}"
SEARCH FIELD: ${searchField}

AVAILABLE DATA (${matchedBooks.length} books):
${availableData}

Now answer using ONLY the allowed fields shown above.
`.trim();

    const systemPrompt = buildSystemPrompt(searchField);

    const answer = await callPerplexity(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      'sonar-pro'
    );

    // Extract up to 10 IDs
    const bookIds = [];
    // Matches (ID: 123) or bare numbers with surrounding word boundary
    const idTagMatches = [...answer.matchAll(/\(ID:\s*(\d+)\)/g)].map(m => Number(m[1]));
    const bareMatches = [...answer.matchAll(/\b(\d{1,9})\b/g)].map(m => Number(m[1]));

    const seen = new Set();
    for (const id of idTagMatches.concat(bareMatches)) {
      if (!Number.isNaN(id) && !seen.has(id)) {
        seen.add(id);
        bookIds.push(id);
      }
      if (bookIds.length >= 10) break;
    }

    // Learn: store last used field + tiny preview
    const key = normalizeArabic(String(query)).toLowerCase();
    memory[key] = {
      count: (memory[key]?.count || 0) + 1,
      lastField: searchField,
      lastAtISO: new Date().toISOString(),
      lastAnswerPreview: String(answer).slice(0, 240),
    };
    persistMemory(true);

    return res.json({ answer, bookIds, chosenField: searchField });
  } catch (error) {
    console.error('Chat error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Rank by summary relevance (unchanged, with small hardening)
app.post('/api/enhance-search', async (req, res) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded.' });
  }

  try {
    const { query, preFilteredBooks } = req.body || {};
    if (!query || !preFilteredBooks || !Array.isArray(preFilteredBooks) || preFilteredBooks.length === 0) {
      return res.json({ rankedBooks: preFilteredBooks || [], explanation: '' });
    }

    const payloadBooks = preFilteredBooks.slice(0, 50).map(b => ({
      id: b.id,
      title: b.title,
      author: b.author,
      summary: b.summary || '',
    }));

    const prompt = `
You are analyzing book summaries for a library search.
User searched for: "${query}"

BOOKS WITH SUMMARIES:
${JSON.stringify(payloadBooks)}

Task:
1) Read each book's SUMMARY
2) Rank books by how well the SUMMARY matches the query
3) Return the top 20 most relevant book IDs

CRITICAL: Only use information from the summaries provided. Do not use external knowledge.

Format:
EXPLANATION: [brief explanation in same language as query]
BOOK_IDS: [comma-separated IDs, most relevant first]
`.trim();

    const response = await callPerplexity(
      [
        { role: 'system', content: 'Rank books based ONLY on provided summaries. Never use external knowledge.' },
        { role: 'user', content: prompt },
      ],
      'sonar-pro'
    );

    const explanationMatch = response.match(/EXPLANATION:\s*(.+?)(?=BOOK_IDS:|$)/s);
    const idsMatch = response.match(/BOOK_IDS:\s*([\d,\s]+)/);

    const explanation = explanationMatch ? explanationMatch[1].trim() : '';
    const bookIds = idsMatch
      ? idsMatch[1]
          .split(',')
          .map((id) => parseInt(id.trim(), 10))
          .filter((id) => Number.isInteger(id))
      : [];

    const rankedBooks = bookIds
      .map((id) => preFilteredBooks.find((b) => b.id === id))
      .filter(Boolean);

    return res.json({ rankedBooks, explanation });
  } catch (error) {
    console.error('Enhance search error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Utilities: health + memory
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ECSSR AI Assistant Backend',
    perplexityConfigured:
      !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: 'sonar-pro',
    features: [
      'Arabic/English question detection → summary Q&A',
      'Author/Subject disambiguation',
      'Strict field boundaries',
      'Ranking by summary relevance',
      'Lightweight learning cache (memory.json)',
      'Rate limiting',
    ],
  });
});

app.get('/api/learned', (req, res) => {
  // Inspect top learned queries (safe to expose)
  const items = Object.entries(memory)
    .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0))
    .slice(0, 50)
    .map(([q, v]) => ({ query: q, ...v }));
  res.json({ total: Object.keys(memory).length, top: items });
});

app.post('/api/reset-memory', (req, res) => {
  memory = {};
  persistMemory(false);
  res.json({ ok: true });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend running on http://localhost:${PORT}`);
  console.log(`📊 Health check:       http://localhost:${PORT}/api/health`);
  console.log(`🤖 Model:              sonar-pro (temperature: 0.05)`);
  console.log(`🎯 Features:           Strict field boundaries + Arabic Q&A + Learning`);
  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'pplx-YOUR-API-KEY-HERE') {
    console.warn('⚠️ WARNING: Perplexity API key not configured!');
  } else {
    console.log('✅ Perplexity API key configured');
  }
});
