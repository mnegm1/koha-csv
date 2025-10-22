// backend/server.js
// ECSSR AI Assistant - FIXED v3.1
// - Strict author matching
// - Field-based search
// - NO sampleBooks reference!

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || 'pplx-YOUR-API-KEY-HERE';
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar-pro';

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const requestCounts = new Map();
const RATE_LIMIT = 100;
const RATE_WINDOW = 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const userRequests = requestCounts.get(ip) || [];
  const recentRequests = userRequests.filter(time => now - time < RATE_WINDOW);
  
  if (recentRequests.length >= RATE_LIMIT) {
    return false;
  }
  
  recentRequests.push(now);
  requestCounts.set(ip, recentRequests);
  return true;
}

// Perplexity API wrapper
async function callPerplexity(messages, model = PERPLEXITY_MODEL) {
  try {
    const response = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.05,
        max_tokens: 800
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Perplexity API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error('Perplexity API Error:', error);
    throw error;
  }
}

// Normalization functions (matching frontend)
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
    .replace(/[\u0660-\u0669]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 1632 + 48))
    .replace(/[\u06F0-\u06F9]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 1776 + 48))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeName(n) {
  return norm(n).split(/\s+/).filter(t => t.length >= 2);
}

// Exact author matching
function exactAuthorMatch(qTokens, name) {
  if (!name) return false;
  const aTokens = tokenizeName(name);
  
  // Must have same number of tokens
  if (qTokens.length !== aTokens.length) return false;
  
  // All query tokens must exist in author tokens
  for (const qt of qTokens) {
    if (!aTokens.includes(qt)) return false;
  }
  
  // All author tokens must exist in query tokens
  for (const at of aTokens) {
    if (!qTokens.includes(at)) return false;
  }
  
  return true;
}

// Filter books by exact author match
function filterAuthorBooks(query, books) {
  const qTokens = tokenizeName(query);
  if (qTokens.length === 0) return [];
  
  return (Array.isArray(books) ? books : [])
    .filter(b => b && typeof b === 'object')
    .filter(b => {
      const author = b.author || '';
      return exactAuthorMatch(qTokens, author);
    });
}

// ====== CHAT ENDPOINT ======
app.post('/api/chat', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
  }

  try {
    const body = req.body || {};
    const query = body.query || '';
    let matchedBooks = Array.isArray(body.matchedBooks) ? body.matchedBooks : [];
    const searchField = body.searchField || 'default';

    console.log(`[CHAT] query="${query}" field=${searchField} books=${matchedBooks.length}`);

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Apply strict author filtering if author search
    if (searchField === 'author' && matchedBooks.length > 0) {
      matchedBooks = filterAuthorBooks(query, matchedBooks);
      console.log(`[CHAT] After author filter: ${matchedBooks.length} books`);
    }

    if (matchedBooks.length === 0) {
      return res.json({ 
        answer: "لم أجد كتباً تطابق سؤالك في الكتالوج.<br>I didn't find any matching books in the catalog.",
        bookIds: []
      });
    }

    // Build field-specific data (SAFE - no sampleBooks!)
    const safeBooks = matchedBooks.filter(b => b && typeof b === 'object');
    let fieldInstructions = '';
    let availableData = '';

    if (searchField === 'summary') {
      fieldInstructions = `
⚠️ CRITICAL: SUMMARY SEARCH
Use ONLY: summary, contents.
FORBIDDEN: author, subject, title.
If info not in summaries, say "المعلومات غير متوفرة / Information not available".`;

      availableData = safeBooks.map((b, i) => {
        const id = b.id ?? i;
        const summary = (b.summary || b.contents || b.content || '').toString().trim() || 'No summary';
        return `Book ID ${id}:\nSummary: ${summary}\n---`;
      }).join('\n');

    } else if (searchField === 'subject') {
      fieldInstructions = `
⚠️ CRITICAL: SUBJECT/TOPIC SEARCH
Use ONLY: subject, title.
FORBIDDEN: author, summary.`;

      availableData = safeBooks.map((b, i) => {
        const id = b.id ?? i;
        const title = (b.title || 'Untitled').toString();
        const subject = (b.subject || 'No subject').toString();
        return `Book ID ${id}:\nTitle: ${title}\nSubject: ${subject}\n---`;
      }).join('\n');

    } else if (searchField === 'author') {
      fieldInstructions = `
⚠️ CRITICAL: AUTHOR SEARCH
Use ONLY: author, title.
FORBIDDEN: subject, summary.`;

      availableData = safeBooks.map((b, i) => {
        const id = b.id ?? i;
        const title = (b.title || 'Untitled').toString();
        const author = (b.author || 'Unknown').toString();
        return `Book ID ${id}:\nTitle: ${title}\nAuthor: ${author}\n---`;
      }).join('\n');

    } else {
      // Default: all fields
      availableData = safeBooks.map((b, i) => {
        const id = b.id ?? i;
        const title = (b.title || 'Untitled').toString();
        const author = (b.author || 'Unknown').toString();
        const subject = (b.subject || '').toString();
        const summary = (b.summary || '').toString();
        return `Book ID ${id}:\nTitle: ${title}\nAuthor: ${author}\nSubject: ${subject}\nSummary: ${summary}\n---`;
      }).join('\n');
    }

    const systemPrompt = searchField === 'summary'
      ? 'Answer using ONLY summaries/contents. Never mention authors unless in summary text.'
      : searchField === 'subject'
      ? 'List books about the topic using ONLY subject and title. Do not mention authors.'
      : searchField === 'author'
      ? 'List books BY the author using ONLY author and title.'
      : 'Use only provided data. No external knowledge.';

    const userPrompt = `You are a library assistant. Follow field rules STRICTLY.

${fieldInstructions}

RULES:
1) ONLY use ALLOWED fields above
2) NEVER use FORBIDDEN fields
3) NEVER use external knowledge
4) If can't answer from allowed fields, say "المعلومات غير متوفرة / Information not available"
5) When mentioning books, include ID like: (ID: 123)
6) Answer in SAME language as query

USER QUERY: "${query}"
SEARCH FIELD: ${searchField}

AVAILABLE DATA (${safeBooks.length} books):
${availableData}

Answer using ONLY allowed fields above.`;

    const answer = await callPerplexity([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], PERPLEXITY_MODEL);

    // Extract book IDs
    const bookIds = [];
    const idMatches = answer.match(/\b(\d+)\b/g);
    if (idMatches) {
      bookIds.push(...idMatches.slice(0, 10).map(Number));
    }

    res.json({ answer, bookIds });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// ====== ENHANCE SEARCH ENDPOINT ======
app.post('/api/enhance-search', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const body = req.body || {};
    const query = body.query || '';
    const preFilteredBooks = Array.isArray(body.preFilteredBooks) ? body.preFilteredBooks : [];

    if (!query || preFilteredBooks.length === 0) {
      return res.json({ rankedBooks: preFilteredBooks, explanation: "" });
    }

    const booksData = preFilteredBooks.slice(0, 50).map((b, idx) => ({
      id: b?.id ?? idx,
      title: b?.title || 'Untitled',
      author: b?.author || 'Unknown',
      summary: b?.summary || ''
    }));

    const prompt = `You are analyzing book summaries for a library search.

User searched for: "${query}"

BOOKS WITH SUMMARIES:
${JSON.stringify(booksData, null, 2)}

Task:
1) Read each book's SUMMARY only
2) Rank books by how well SUMMARY matches query
3) Return top 20 most relevant book IDs

IMPORTANT: Only use provided summaries. No external knowledge.

Format:
EXPLANATION: [brief explanation in same language as query]
BOOK_IDS: [comma-separated IDs, most relevant first]`;

    const response = await callPerplexity([
      { role: 'system', content: 'Rank books based ONLY on provided summaries. Never use external knowledge.' },
      { role: 'user', content: prompt }
    ], PERPLEXITY_MODEL);

    const explanationMatch = response.match(/EXPLANATION:\s*(.+?)(?=BOOK_IDS:|$)/s);
    const idsMatch = response.match(/BOOK_IDS:\s*([\d,\s]+)/);

    const explanation = explanationMatch ? explanationMatch[1].trim() : '';
    const bookIds = idsMatch 
      ? idsMatch[1].split(',').map(id => parseInt(id.trim(), 10)).filter(n => !isNaN(n))
      : [];

    const rankedBooks = bookIds
      .map(id => preFilteredBooks.find(b => b && b.id === id))
      .filter(Boolean);

    res.json({ rankedBooks, explanation });

  } catch (error) {
    console.error('Enhance search error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// ====== HEALTH CHECK ======
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    version: 'v3.1-fixed',
    perplexityConfigured: !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: PERPLEXITY_MODEL,
    features: 'Strict author matching • Field-based search • No sampleBooks bug!'
  });
});

// ====== ERROR HANDLER ======
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend running on http://localhost:${PORT}`);
  console.log(`📊 Version: v3.1-fixed`);
  console.log(`🔍 Health: /api/health`);
  console.log(`🤖 Model: ${PERPLEXITY_MODEL}`);
  console.log(`✅ NO sampleBooks bug!`);
  
  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'pplx-YOUR-API-KEY-HERE') {
    console.warn('⚠️  WARNING: Perplexity API key not configured!');
  } else {
    console.log('✅ Perplexity API key configured');
  }
});
