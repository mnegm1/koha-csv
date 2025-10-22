// backend/server.js
// ECSSR AI Assistant — Robust + Author Surname-Anchor Matching (Backend Parity)

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const PERPLEXITY_API_KEY =
  process.env.PERPLEXITY_API_KEY || 'pplx-YOUR-API-KEY-HERE';
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = process.env.PPLX_MODEL || 'sonar-pro';

app.set('trust proxy', true); // correct client IPs behind proxies/load balancers
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* =========================
   Rate limiting (simple in-memory)
========================= */
const requestCounts = new Map();
const RATE_LIMIT = 100;
const RATE_WINDOW = 60 * 60 * 1000;
function checkRateLimit(ip) {
  const now = Date.now();
  const userRequests = requestCounts.get(ip) || [];
  const recent = userRequests.filter((t) => now - t < RATE_WINDOW);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  requestCounts.set(ip, recent);
  return true;
}

/* =========================
   Perplexity wrapper
========================= */
async function callPerplexity(messages, model = PERPLEXITY_MODEL) {
  try {
    const response = await fetch(PERPLEXITY_URL, {
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

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Perplexity API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return (data.choices && data.choices[0]?.message?.content) || '';
  } catch (err) {
    console.error('Perplexity API Error:', err);
    throw err;
  }
}

/* ======================================================
   Arabic/EN normalization + AUTHOR SURNAME-ANCHOR MATCH
   (mirrors frontend logic; prevents wrong-family matches)
====================================================== */
function norm(s) {
  if (!s) return '';
  s = String(s).toLowerCase();
  try { s = s.normalize('NFKD'); } catch (_) {}
  return s
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/\s*و\s*/g, 'و')
    .replace(/[ىی]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ک/g, 'ك')
    .replace(/\bعبد\s+ال/g, 'عبدال')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .replace(/[\u0660-\u0669]/g, (d) =>
      String.fromCharCode(d.charCodeAt(0) - 1632 + 48)
    )
    .replace(/[\u06F0-\u06F9]/g, (d) =>
      String.fromCharCode(d.charCodeAt(0) - 1776 + 48)
    )
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokenizeName(n) {
  return norm(n)
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}
function tokenEq(a, b) {
  if (a === b) return true;
  if (a.length >= 3 && b.startsWith(a)) return true;
  if (b.length >= 3 && a.startsWith(b)) return true;
  return false;
}
// Arabic name stop-words (connectors)
const NAME_STOP = new Set([
  'بن',
  'بنت',
  'ابن',
  'أبن',
  'آل',
  'ال',
  'أبو',
  'ابو',
  'بو',
  'بنّ',
  'عبد',
  'عبدال',
]);
function extractSurname(tokens) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (!NAME_STOP.has(t)) return t;
  }
  return tokens[tokens.length - 1] || null;
}
function exactAuthorMatch(qTokens, name) {
  const aTokens = tokenizeName(name);
  if (qTokens.length !== aTokens.length) return false;
  return (
    qTokens.every((qt) => aTokens.some((at) => tokenEq(qt, at))) &&
    aTokens.every((at) => qTokens.some((qt) => tokenEq(qt, at)))
  );
}
/**
 * Flexible author match with required surname anchor.
 * Returns { hit:boolean, score:number }
 */
function flexibleAuthorMatch(qTokens, name) {
  const aTokens = tokenizeName(name);
  if (!aTokens.length || !qTokens.length) return { hit: false, score: 0 };

  // Anchor (surname) from query tokens must exist in author tokens
  const anchor = extractSurname(qTokens);
  const hasAnchor = anchor ? aTokens.some((at) => tokenEq(anchor, at)) : false;
  if (anchor && !hasAnchor) return { hit: false, score: 0 };

  // Greedy one-to-one overlap
  let overlap = 0;
  const used = new Array(aTokens.length).fill(false);
  for (const qt of qTokens) {
    const i = aTokens.findIndex((at, idx) => !used[idx] && tokenEq(qt, at));
    if (i >= 0) {
      used[i] = true;
      overlap++;
    }
  }

  const minLen = Math.min(qTokens.length, aTokens.length);
  const need = Math.max(2, Math.ceil(minLen * 0.66)); // >=2 and ~66% of shorter
  if (overlap >= need) {
    const closeness = 1 - Math.abs(qTokens.length - aTokens.length) / 5;
    const anchorBonus = hasAnchor ? 8 : 0;
    return { hit: true, score: 70 + overlap * 10 + closeness * 5 + anchorBonus };
  }
  return { hit: false, score: 0 };
}
/**
 * Backend filter to enforce author rules on incoming matchedBooks
 * (works even if client sent noisy candidates).
 */
function filterAuthorBooks(query, books) {
  const qTokens = tokenizeName(query);
  if (qTokens.length === 0) return [];

  return books
    .map((b, idx) => {
      const author = (b && b.author) || '';
      // 1) exact, then 2) flexible
      if (exactAuthorMatch(qTokens, author)) {
        return { book: b, score: 120, idx };
      }
      const flex = flexibleAuthorMatch(qTokens, author);
      if (flex.hit) {
        return { book: b, score: flex.score, idx };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.book);
}

/* =========================
   /api/chat  (STRICT FIELDS)
========================= */
app.post('/api/chat', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) {
    return res
      .status(429)
      .json({ error: 'Rate limit exceeded. Please try again later.' });
  }

  try {
    const body = req.body || {};
    const query = body.query || '';
    let matchedBooks = Array.isArray(body.matchedBooks) ? body.matchedBooks : [];
    const searchField = body.searchField || 'default';

    console.log(
      `[CHAT] Query="${query}" Field=${searchField} Books=${matchedBooks.length}`
    );

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Backend enforcement: if author search, apply surname-anchored filter
    if (searchField === 'author' && matchedBooks.length) {
      matchedBooks = filterAuthorBooks(query, matchedBooks);
    }

    if (matchedBooks.length === 0) {
      return res.json({
        answer:
          "لم أجد كتباً تطابق سؤالك في الكتالوج.<br>I didn't find any matching books in the catalog.",
        bookIds: [],
      });
    }

    // Build STRICT field-specific instructions and the data payload
    let fieldInstructions = '';
    let availableData = '';

    if (searchField === 'summary') {
      fieldInstructions = `
⚠️ CRITICAL FIELD RULE: SUMMARY SEARCH
Use ONLY: summary, contents.
FORBIDDEN: author, subject, title.
If info not present in summaries, say "المعلومات غير متوفرة / Information not available".`;

      availableData = matchedBooks
        .map((b, i) => `Book ID ${b.id ?? i}:
Summary: ${b.summary || 'No summary'}
---`)
        .join('\n');
    } else if (searchField === 'subject') {
      fieldInstructions = `
⚠️ CRITICAL FIELD RULE: SUBJECT/TOPIC SEARCH
Use ONLY: subject, title.
FORBIDDEN: author, summary.
List books about the topic.`;

      availableData = matchedBooks
        .map(
          (b, i) => `Book ID ${b.id ?? i}:
Title: ${b.title || 'Untitled'}
Subject: ${b.subject || 'No subject'}
---`
        )
        .join('\n');
    } else if (searchField === 'author') {
      fieldInstructions = `
⚠️ CRITICAL FIELD RULE: AUTHOR SEARCH
Use ONLY: author (to match), title (to list).
FORBIDDEN: subject, summary.`;

      availableData = matchedBooks
        .map(
          (b, i) => `Book ID ${b.id ?? i}:
Title: ${b.title || 'Untitled'}
Author: ${b.author || 'Unknown'}
---`
        )
        .join('\n');
    } else {
      // default (fallback)
      availableData = matchedBooks
        .map(
          (b, i) => `Book ID ${b.id ?? i}:
Title: ${b.title || 'Untitled'}
Author: ${b.author || 'Unknown'}
Subject: ${b.subject || ''}
Summary: ${b.summary || ''}
---`
        )
        .join('\n');
    }

    const systemPrompt =
      searchField === 'summary'
        ? 'Answer using ONLY summaries/contents. Never mention authors unless they appear in the summary text.'
        : searchField === 'subject'
        ? 'List books about the topic using ONLY subject and title fields. Do not mention authors.'
        : searchField === 'author'
        ? 'List books BY the author using ONLY author and title fields.'
        : 'Use only the provided data fields. Do not use external knowledge.';

    const userPrompt = `You are a library assistant. Follow the field rules STRICTLY.

${fieldInstructions}

RULES:
1) ONLY use the ALLOWED fields above.
2) NEVER use FORBIDDEN fields.
3) NEVER use general knowledge or invent info.
4) If you can't answer from allowed fields, say "المعلومات غير متوفرة / Information not available".
5) When mentioning books, include their ID like: (ID: 123)
6) Answer in the SAME language as the user query.

USER QUERY: "${query}"
SEARCH FIELD: ${searchField}

AVAILABLE DATA (${matchedBooks.length} books):
${availableData}

Now answer using ONLY the allowed fields above.`;

    const answer = await callPerplexity(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      PERPLEXITY_MODEL
    );

    // Try to collect any IDs referenced in the text, cap to 10
    const bookIds = [];
    const idMatches = answer.match(/\b(\d+)\b/g);
    if (idMatches) bookIds.push(...idMatches.slice(0, 10).map(Number));

    console.log(`[CHAT] Response ready. IDs: ${bookIds.join(',')}`);
    res.json({ answer, bookIds });
  } catch (err) {
    console.error('[CHAT ERROR]', err);
    res
      .status(500)
      .json({ error: 'Internal server error', details: err.message });
  }
});

/* ==========================================================
   /api/enhance-search — AI ranks by summary relevance only
========================================================== */
app.post('/api/enhance-search', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const body = req.body || {};
    const query = body.query || '';
    const preFilteredBooks = Array.isArray(body.preFilteredBooks)
      ? body.preFilteredBooks
      : [];

    if (!query || preFilteredBooks.length === 0) {
      return res.json({ rankedBooks: preFilteredBooks, explanation: '' });
    }

    const booksData = preFilteredBooks.slice(0, 50).map((b, idx) => ({
      id: b?.id ?? idx,
      title: b?.title || 'Untitled',
      author: b?.author || 'Unknown',
      summary: b?.summary || '',
    }));

    const prompt = `You are analyzing book summaries for a library search.

User searched for: "${query}"

BOOKS WITH SUMMARIES:
${JSON.stringify(booksData, null, 2)}

Task:
1) Read each book's SUMMARY only.
2) Rank books by how well the SUMMARY matches the query.
3) Return the top 20 most relevant book IDs.

IMPORTANT: Only use the provided summaries. No external knowledge.

Format:
EXPLANATION: [brief explanation in same language as query]
BOOK_IDS: [comma-separated IDs, most relevant first]`;

    const response = await callPerplexity(
      [
        {
          role: 'system',
          content:
            'Rank books based ONLY on provided summaries. Never use external knowledge.',
        },
        { role: 'user', content: prompt },
      ],
      PERPLEXITY_MODEL
    );

    const explanationMatch = response.match(
      /EXPLANATION:\s*(.+?)(?=BOOK_IDS:|$)/s
    );
    const idsMatch = response.match(/BOOK_IDS:\s*([\d,\s]+)/);

    const explanation = explanationMatch ? explanationMatch[1].trim() : '';
    const bookIds = idsMatch
      ? idsMatch[1]
          .split(',')
          .map((id) => parseInt(id.trim(), 10))
          .filter((n) => !Number.isNaN(n))
      : [];

    const rankedBooks = bookIds
      .map((id) => preFilteredBooks.find((b) => b && b.id === id))
      .filter(Boolean);

    res.json({ rankedBooks, explanation });
  } catch (err) {
    console.error('Enhance search error:', err);
    res
      .status(500)
      .json({ error: 'Internal server error', details: err.message });
  }
});

/* =========================
   Health check
========================= */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ECSSR AI Assistant Backend — Robust & Fixed',
    perplexityConfigured:
      !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: PERPLEXITY_MODEL,
    features:
      'Strict field separation • Author surname-anchored matching • Error handling',
  });
});

/* =========================
   Error middleware
========================= */
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res
    .status(500)
    .json({ error: 'Internal server error', details: err.message });
});

/* =========================
   Start server
========================= */
app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend running on http://localhost:${PORT}`);
  console.log(`📊 Health:           /api/health`);
  console.log(
    `🤖 Model: ${PERPLEXITY_MODEL} (temperature: 0.05) — key ${
      PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE'
        ? 'OK'
        : 'NOT SET'
    }`
  );
  console.log(
    `🎯 Features: STRICT field boundaries + Surname-anchored author matching + Error handling`
  );
});
