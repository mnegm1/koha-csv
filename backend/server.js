// backend/server.js
// ECSSR AI Assistant Backend with Perplexity API
// UPDATED 2025-10: Valid Perplexity model names + safe fallbacks

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || 'pplx-YOUR-API-KEY-HERE';
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

// === Choose defaults (env overridable) ===
const DEFAULT_PRIMARY_MODEL = process.env.PPLX_MODEL_PRIMARY || 'sonar-pro';
const DEFAULT_FALLBACK_MODEL = process.env.PPLX_MODEL_FALLBACK || 'sonar';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting (simple in-memory)
const requestCounts = new Map();
const RATE_LIMIT = 100;                 // requests per window
const RATE_WINDOW = 60 * 60 * 1000;     // 1 hour

function checkRateLimit(ip) {
  const now = Date.now();
  const userRequests = requestCounts.get(ip) || [];
  const recent = userRequests.filter(t => now - t < RATE_WINDOW);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  requestCounts.set(ip, recent);
  return true;
}

// ---- Model name utilities ----

// Map any legacy/invalid names to current ones.
function normalizeModelName(name) {
  if (!name) return DEFAULT_PRIMARY_MODEL;
  const n = String(name).toLowerCase();

  // Known invalid/old aliases seen in the wild:
  const legacyMap = {
    // old llama 3.1 sonar aliases
    'llama-3.1-sonar-small-128k-online': DEFAULT_PRIMARY_MODEL,
    'llama-3.1-sonar-large-128k-online': 'sonar-pro',
    'sonar-small': DEFAULT_FALLBACK_MODEL,  // no longer valid
    'sonar-large': 'sonar-pro',
    'sonar-online': DEFAULT_FALLBACK_MODEL,
  };

  if (legacyMap[n]) return legacyMap[n];

  // Only allow known current models; otherwise fallback.
  const allowed = new Set([
    'sonar',
    'sonar-pro',
    'sonar-reasoning',
    'sonar-reasoning-pro',
    'sonar-deep-research'
  ]);

  return allowed.has(n) ? n : DEFAULT_PRIMARY_MODEL;
}

// Low-level fetch to Perplexity
async function pplxFetch({ messages, model, temperature = 0.2, max_tokens = 1000 }) {
  const response = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: normalizeModelName(model),
      messages,
      temperature,
      max_tokens
    })
  });

  const text = await response.text(); // read once
  if (!response.ok) {
    // Try to expose brief structured reason
    let reason = text;
    try {
      const j = JSON.parse(text);
      reason = j?.error?.message || j?.message || text;
    } catch (_) {}
    const err = new Error(`Perplexity error ${response.status}: ${reason}`);
    err.status = response.status;
    throw err;
  }

  let data;
  try { data = JSON.parse(text); }
  catch (e) {
    const err = new Error(`Perplexity returned non-JSON response`);
    err.status = 502;
    throw err;
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    const err = new Error(`Perplexity returned no content`);
    err.status = 502;
    throw err;
  }
  return content;
}

// Helper with auto-fallback on invalid_model/400
async function callPerplexity(messages, model = DEFAULT_PRIMARY_MODEL, fallback = DEFAULT_FALLBACK_MODEL) {
  try {
    return await pplxFetch({ messages, model });
  } catch (e) {
    const msg = String(e?.message || '');
    if (e?.status === 400 && /invalid_model/i.test(msg)) {
      // Retry once with fallback
      return await pplxFetch({ messages, model: fallback });
    }
    throw e;
  }
}

// ====== ENDPOINTS ======

// 1) Chat
app.post('/api/chat', async (req, res) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });

  try {
    const { query, context = {} } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Query is required' });

    const { totalBooks = 0, sampleBooks = [], conversationHistory = [] } = context;

    const contextMsg =
`You are a helpful library assistant for ECSSR (Emirates Center for Strategic Studies and Research).

Catalog Information:
- Total books: ${Number(totalBooks) || 0}
- Sample books in collection: ${JSON.stringify((sampleBooks || []).slice(0, 20))}

Previous conversation: ${JSON.stringify(conversationHistory || [])}

Instructions:
- Help users find relevant books
- Answer questions about the catalog
- Provide book recommendations
- Be concise and helpful
- Support both Arabic and English
- If recommending books, mention their IDs from the sample

User question: ${query}`;

    const answer = await callPerplexity(
      [
        { role: 'system', content: 'You are a library assistant for ECSSR.' },
        { role: 'user', content: contextMsg }
      ],
      DEFAULT_PRIMARY_MODEL,
      DEFAULT_FALLBACK_MODEL
    );

    // naive ID extraction
    const bookIds = [];
    const idMatches = answer.match(/\b(\d+)\b/g);
    if (idMatches) bookIds.push(...idMatches.slice(0, 5).map(Number));

    res.json({ answer, bookIds });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'AI chat failed. The assistant is temporarily unavailable.',
      detail: String(error.message || error)
    });
  }
});

// 2) Search (analysis + IDs)
app.post('/api/search', async (req, res) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Rate limit exceeded' });

  try {
    const { query, catalog = [] } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Query is required' });

    const prompt =
`You are analyzing a search query for a library catalog.

Query: "${query}"

Available books (first 100):
${JSON.stringify((catalog || []).slice(0, 30))}

Task:
1. Understand what the user is looking for
2. Identify the most relevant books by their IDs
3. Explain your reasoning

Format your response as:
EXPLANATION: [brief explanation]
BOOK_IDS: [comma-separated list of relevant book IDs]`;

    const response = await callPerplexity(
      [{ role: 'user', content: prompt }],
      DEFAULT_PRIMARY_MODEL,
      DEFAULT_FALLBACK_MODEL
    );

    const explanationMatch = response.match(/EXPLANATION:\s*(.+?)(?=BOOK_IDS:|$)/s);
    const idsMatch = response.match(/BOOK_IDS:\s*([\d,\s]+)/);

    const explanation = explanationMatch ? explanationMatch[1].trim() : 'Found relevant results';
    const bookIds = idsMatch
      ? idsMatch[1].split(',').map(x => parseInt(x.trim(), 10)).filter(n => !Number.isNaN(n))
      : [];

    res.json({ explanation, bookIds: bookIds.slice(0, 20) });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      error: 'AI search failed.',
      detail: String(error.message || error)
    });
  }
});

// 3) Recommendations
app.post('/api/recommend', async (req, res) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Rate limit exceeded' });

  try {
    const { bookTitle, catalog = [] } = req.body || {};
    if (!bookTitle) return res.status(400).json({ error: 'Book title is required' });

    const prompt =
`A user is interested in books similar to: "${bookTitle}"

Available books in catalog:
${JSON.stringify((catalog || []).slice(0, 50))}

Task:
1. Find 5 books similar to the given title
2. Consider: topic, author style, subject area, publication period
3. Provide reasoning for each recommendation

Format:
EXPLANATION: [why these books are similar]
BOOK_IDS: [comma-separated IDs]`;

    const response = await callPerplexity(
      [{ role: 'user', content: prompt }],
      DEFAULT_PRIMARY_MODEL,
      DEFAULT_FALLBACK_MODEL
    );

    const explanationMatch = response.match(/EXPLANATION:\s*(.+?)(?=BOOK_IDS:|$)/s);
    const idsMatch = response.match(/BOOK_IDS:\s*([\d,\s]+)/);

    const explanation = explanationMatch ? explanationMatch[1].trim() : 'Recommendations based on similarity';
    const bookIds = idsMatch
      ? idsMatch[1].split(',').map(x => parseInt(x.trim(), 10)).filter(n => !Number.isNaN(n))
      : [];

    res.json({ explanation, bookIds: bookIds.slice(0, 10) });
  } catch (error) {
    console.error('Recommend error:', error);
    res.status(500).json({
      error: 'AI recommend failed.',
      detail: String(error.message || error)
    });
  }
});

// 4) Auto-suggestions
app.post('/api/suggest', async (req, res) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Rate limit exceeded' });

  try {
    const { partial } = req.body || {};
    if (!partial || partial.length < 3) return res.json({ suggestions: [] });

    const prompt =
`User typed: "${partial}"

Generate 5 complete search queries for a library catalog. Mix Arabic and English suggestions based on the input language.

Return ONLY a comma-separated list of suggestions, nothing else.`;

    const response = await callPerplexity(
      [{ role: 'user', content: prompt }],
      DEFAULT_PRIMARY_MODEL,
      DEFAULT_FALLBACK_MODEL
    );

    const suggestions = response
      .split(/[,\n]/)
      .map(s => s.trim())
      .filter(s => s.length > 0 && s.length < 100)
      .slice(0, 5);

    res.json({ suggestions });
  } catch (error) {
    console.error('Suggest error:', error);
    res.json({ suggestions: [] });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ECSSR AI Assistant Backend is running',
    perplexityConfigured: !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: `${DEFAULT_PRIMARY_MODEL} (fallback: ${DEFAULT_FALLBACK_MODEL})`
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🤖 Perplexity models: primary=${DEFAULT_PRIMARY_MODEL}, fallback=${DEFAULT_FALLBACK_MODEL}`);

  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'pplx-YOUR-API-KEY-HERE') {
    console.warn('⚠️  WARNING: Perplexity API key not configured!');
    console.warn('   Set PERPLEXITY_API_KEY environment variable');
  } else {
    console.log('✅ Perplexity API key configured');
  }
});
