// backend/server.js
// ECSSR AI Assistant - FIXED v3.2-CLEAN
// - Strict author matching
// - Field-based search
// - Beautiful citations
// - UTF-8 CLEAN (no encoding issues!)

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

// Text normalization for search
function norm(s) {
  if (!s) return '';
  s = String(s).toLowerCase();
  try { s = s.normalize('NFKD'); } catch (_) {}
  
  // Remove diacritics and normalize Arabic characters
  return s
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\u0660/g, '0').replace(/\u0661/g, '1').replace(/\u0662/g, '2')
    .replace(/\u0663/g, '3').replace(/\u0664/g, '4').replace(/\u0665/g, '5')
    .replace(/\u0666/g, '6').replace(/\u0667/g, '7').replace(/\u0668/g, '8')
    .replace(/\u0669/g, '9')
    .replace(/\u06F0/g, '0').replace(/\u06F1/g, '1').replace(/\u06F2/g, '2')
    .replace(/\u06F3/g, '3').replace(/\u06F4/g, '4').replace(/\u06F5/g, '5')
    .replace(/\u06F6/g, '6').replace(/\u06F7/g, '7').replace(/\u06F8/g, '8')
    .replace(/\u06F9/g, '9')
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
  
  if (qTokens.length !== aTokens.length) return false;
  
  for (const qt of qTokens) {
    if (!aTokens.includes(qt)) return false;
  }
  
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

// Helper: Build citation from book object
function buildCitation(book) {
  if (!book) return null;
  const author = (book.author || 'Unknown Author').toString().trim();
  const title = (book.title || 'Untitled').toString().trim();
  const publisher = (book.publisher || '').toString().trim();
  const year = (book.year || '').toString().trim();
  
  let citation = `${author} - "${title}"`;
  if (publisher || year) {
    citation += ` (${[publisher, year].filter(Boolean).join(', ')})`;
  }
  return citation;
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
        answer: "لم أجد كتاب يطابق سؤالك في الكتالوج. I didn't find any matching books in the catalog.",
        bookIds: [],
        citationMap: {}
      });
    }

    // Build field-specific data
    const safeBooks = matchedBooks.filter(b => b && typeof b === 'object');
    let fieldInstructions = '';
    let availableData = '';

    if (searchField === 'summary') {
      fieldInstructions = `
WARNING: SUMMARY SEARCH ONLY
Use ONLY: summary, contents.
FORBIDDEN: author, subject, title.
If info not available, say "Information not available".`;

      availableData = safeBooks.map((b, i) => {
        const id = b.id ?? i;
        const summary = (b.summary || b.contents || b.content || '').toString().trim() || 'No summary';
        return `Book ID ${id}:\nSummary: ${summary}\n---`;
      }).join('\n');

    } else if (searchField === 'subject') {
      fieldInstructions = `
WARNING: SUBJECT/TOPIC SEARCH
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
WARNING: AUTHOR SEARCH ONLY
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
4) If can't answer from allowed fields, say "Information not available"
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

    // Extract book IDs and build citation map
    const bookIds = [];
    const citationMap = {};
    const idMatches = answer.match(/\(ID:\s*(\d+)\)/g);
    
    if (idMatches) {
      for (const match of idMatches) {
        const bookId = parseInt(match.replace(/[^\d]/g, ''), 10);
        if (!isNaN(bookId) && !bookIds.includes(bookId)) {
          bookIds.push(bookId);
          
          // Find matching book and create citation
          const book = safeBooks.find(b => (b.id ?? safeBooks.indexOf(b)) === bookId);
          if (book) {
            citationMap[bookId] = buildCitation(book);
          }
        }
      }
    }

    res.json({ answer, bookIds, citationMap });

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
    version: 'v3.2-clean',
    perplexityConfigured: !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: PERPLEXITY_MODEL,
    features: 'Strict author matching | Field-based search | Beautiful citations | UTF-8 CLEAN'
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
  console.log(`📊 Version: v3.2-clean`);
  console.log(`🔗 Health: /api/health`);
  console.log(`🤖 Model: ${PERPLEXITY_MODEL}`);
  console.log(`✅ UTF-8 CLEAN - No encoding issues!`);
  
  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'pplx-YOUR-API-KEY-HERE') {
    console.warn('⚠️  WARNING: Perplexity API key not configured!');
  } else {
    console.log('✅ Perplexity API key configured');
  }
});
