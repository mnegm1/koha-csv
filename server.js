// backend/server.js
// ECSSR AI Assistant - Robust Error Handling

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || 'pplx-YOUR-API-KEY-HERE';
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

async function callPerplexity(messages, model = 'sonar-pro') {
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

// ====== CHAT ENDPOINT - STRICT FIELD BOUNDARIES ======
app.post('/api/chat', async (req, res) => {
  const ip = req.ip;
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
  }

  try {
    // ROBUST: Safe extraction with defaults
    const body = req.body || {};
    const query = body.query || '';
    const matchedBooks = Array.isArray(body.matchedBooks) ? body.matchedBooks : [];
    const searchField = body.searchField || 'default';
    
    console.log(`[CHAT] Query: "${query}", Field: ${searchField}, Books: ${matchedBooks.length}`);
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    if (matchedBooks.length === 0) {
      return res.json({ 
        answer: "لم أجد كتباً تطابق سؤالك في الكتالوج.<br>I didn't find any matching books in the catalog.",
        bookIds: []
      });
    }

    // Build STRICT field-specific instructions
    let fieldInstructions = '';
    let availableData = '';
    
    if (searchField === 'summary') {
      // QUESTIONS: Only use summaries
      fieldInstructions = `
⚠️ CRITICAL FIELD RULE: SUMMARY SEARCH
You are answering a QUESTION. Use ONLY these fields:
✅ ALLOWED: summary, contents
❌ FORBIDDEN: Do NOT look at author, subject, or title fields
❌ FORBIDDEN: Do NOT mention author names unless specifically in the summary text

Your task: Answer the question using ONLY the summary/contents text provided.`;

      availableData = matchedBooks.map((b, idx) => {
        const book = b || {};
        return `
Book ID ${book.id || idx}:
Summary: ${book.summary || "No summary"}
---`;
      }).join('\n');

    } else if (searchField === 'subject') {
      // TOPICS: Only use subject and title
      fieldInstructions = `
⚠️ CRITICAL FIELD RULE: SUBJECT/TOPIC SEARCH
You are searching for books ABOUT a topic. Use ONLY these fields:
✅ ALLOWED: subject, title
❌ FORBIDDEN: Do NOT look at author fields
❌ FORBIDDEN: Do NOT mention authors unless the query asks about them

Your task: List books whose SUBJECT or TITLE relates to the topic.`;

      availableData = matchedBooks.map((b, idx) => {
        const book = b || {};
        return `
Book ID ${book.id || idx}:
Title: ${book.title || "Untitled"}
Subject: ${book.subject || "No subject"}
---`;
      }).join('\n');

    } else if (searchField === 'author') {
      // AUTHORS: Only use author fields
      fieldInstructions = `
⚠️ CRITICAL FIELD RULE: AUTHOR SEARCH
You are searching for books BY an author. Use ONLY these fields:
✅ ALLOWED: author, title (for listing books)
❌ FORBIDDEN: Do NOT look at subject or summary fields

Your task: List books BY this author.`;

      availableData = matchedBooks.map((b, idx) => {
        const book = b || {};
        return `
Book ID ${book.id || idx}:
Title: ${book.title || "Untitled"}
Author: ${book.author || "Unknown"}
---`;
      }).join('\n');

    } else {
      // DEFAULT: Show all fields
      availableData = matchedBooks.map((b, idx) => {
        const book = b || {};
        return `
Book ID ${book.id || idx}:
Title: ${book.title || "Untitled"}
Author: ${book.author || "Unknown"}
Subject: ${book.subject || ""}
Summary: ${book.summary || ""}
---`;
      }).join('\n');
    }

    const prompt = `You are a library assistant. Follow the field rules STRICTLY.

${fieldInstructions}

CRITICAL RULES:
1. ONLY use the fields specified as ALLOWED above
2. NEVER use fields marked as FORBIDDEN
3. NEVER use your general knowledge
4. NEVER invent information
5. If you cannot answer from allowed fields, say "المعلومات غير متوفرة / Information not available"
6. When mentioning books, include their ID like this: (ID: 123)
7. Answer in the SAME language as the query

USER QUERY: "${query}"

SEARCH FIELD: ${searchField}

AVAILABLE DATA (${matchedBooks.length} books found):
${availableData}

Now answer using ONLY the allowed fields shown above.`;

    const systemPrompt = searchField === 'summary' 
      ? 'You answer questions using ONLY summaries. NEVER mention authors unless they appear in the summary text itself.'
      : searchField === 'subject'
      ? 'You list books about topics using ONLY subject and title fields. NEVER mention authors.'
      : searchField === 'author'
      ? 'You list books BY authors using ONLY author and title fields.'
      : 'You use only the provided data fields.';

    const answer = await callPerplexity([
      { 
        role: 'system', 
        content: systemPrompt
      },
      { role: 'user', content: prompt }
    ], 'sonar-pro');

    // Extract book IDs mentioned in answer
    const bookIds = [];
    const idMatches = answer.match(/\b(\d+)\b/g);
    if (idMatches) {
      bookIds.push(...idMatches.slice(0, 10).map(Number));
    }

    console.log(`[CHAT] Response generated, IDs: ${bookIds.join(',')}`);
    res.json({ answer, bookIds });

  } catch (error) {
    console.error('[CHAT ERROR]', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// ====== ENHANCE SEARCH - AI Ranks by Summary Relevance ======
app.post('/api/enhance-search', async (req, res) => {
  const ip = req.ip;
  
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

    const booksData = preFilteredBooks.slice(0, 50).map((b, idx) => {
      const book = b || {};
      return {
        id: book.id || idx,
        title: book.title || "Untitled",
        author: book.author || "Unknown",
        summary: book.summary || ""
      };
    });

    const prompt = `You are analyzing book summaries for a library search.

User searched for: "${query}"

BOOKS WITH SUMMARIES:
${JSON.stringify(booksData, null, 2)}

Task:
1. Read each book's SUMMARY
2. Rank books by how well the SUMMARY matches the query
3. Return the top 20 most relevant book IDs

CRITICAL: Only use information from the summaries provided. Do not use external knowledge.

Format:
EXPLANATION: [brief explanation in same language as query]
BOOK_IDS: [comma-separated IDs, most relevant first]`;

    const response = await callPerplexity([
      { 
        role: 'system', 
        content: 'Rank books based ONLY on provided summaries. Never use external knowledge.' 
      },
      { role: 'user', content: prompt }
    ], 'sonar-pro');

    const explanationMatch = response.match(/EXPLANATION:\s*(.+?)(?=BOOK_IDS:|$)/s);
    const idsMatch = response.match(/BOOK_IDS:\s*([\d,\s]+)/);

    const explanation = explanationMatch ? explanationMatch[1].trim() : '';
    const bookIds = idsMatch 
      ? idsMatch[1].split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
      : [];

    const rankedBooks = bookIds
      .map(id => preFilteredBooks.find(b => b && b.id === id))
      .filter(Boolean);

    res.json({ rankedBooks, explanation });

  } catch (error) {
    console.error('Enhance search error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'ECSSR AI Assistant Backend - Robust & Fixed',
    perplexityConfigured: !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: 'sonar-pro',
    features: 'Strict field separation + Robust error handling'
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    details: err.message 
  });
});

app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🤖 Model: sonar-pro (temperature: 0.05)`);
  console.log(`🎯 Features: STRICT field boundaries + Error handling`);
  
  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'pplx-YOUR-API-KEY-HERE') {
    console.warn('⚠️  WARNING: Perplexity API key not configured!');
  } else {
    console.log('✅ Perplexity API key configured');
  }
});
