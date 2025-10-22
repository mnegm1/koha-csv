// backend/server.js
// ECSSR AI Assistant Backend - FIXED VERSION
// Solution: Frontend pre-filters, backend refines with AI

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
        temperature: 0.1,
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

// 1. Chat endpoint - Works with pre-filtered results
app.post('/api/chat', async (req, res) => {
  const ip = req.ip;
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
  }

  try {
    const { query, context } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Use reasonable sample (max 100 books to avoid token limit)
    const sampleBooks = (context.sampleBooks || []).slice(0, 100);

    const contextMsg = `You are a library assistant for ECSSR with ${context.totalBooks} books total.

RULES:
- Answer based on these sample books from our catalog
- Be helpful and concise
- Support Arabic and English
- If asked about books not in sample, say "يمكنني البحث عن المزيد / I can search for more"

SAMPLE FROM CATALOG (100 of ${context.totalBooks} books):
${JSON.stringify(sampleBooks)}

Previous conversation: ${JSON.stringify(context.conversationHistory || [])}

User question: ${query}`;

    const answer = await callPerplexity([
      { role: 'system', content: 'You are a library assistant for ECSSR.' },
      { role: 'user', content: contextMsg }
    ], 'sonar-pro');

    const bookIds = [];
    const idMatches = answer.match(/\b(\d+)\b/g);
    if (idMatches) {
      bookIds.push(...idMatches.slice(0, 10).map(Number));
    }

    res.json({ answer, bookIds });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Search endpoint - Frontend sends PRE-FILTERED results only
app.post('/api/search', async (req, res) => {
  const ip = req.ip;
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const { query, catalog } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Frontend already filtered - we receive only matching books (max 200)
    const preFiltered = (catalog || []).slice(0, 200);

    if (preFiltered.length === 0) {
      return res.json({ 
        explanation: 'لا توجد نتائج / No results found', 
        bookIds: [] 
      });
    }

    const prompt = `Refine search results for library catalog.

User searched for: "${query}"

PRE-FILTERED RESULTS (${preFiltered.length} books):
${JSON.stringify(preFiltered)}

Task:
1. Rank these books by relevance to the query
2. Select the MOST relevant ones
3. Explain briefly

Format:
EXPLANATION: [brief reasoning in same language as query]
BOOK_IDS: [top 20 most relevant IDs from list above]`;

    const response = await callPerplexity([
      { role: 'system', content: 'Rank provided books by relevance. Use only IDs from the list.' },
      { role: 'user', content: prompt }
    ], 'sonar-pro');

    const explanationMatch = response.match(/EXPLANATION:\s*(.+?)(?=BOOK_IDS:|$)/s);
    const idsMatch = response.match(/BOOK_IDS:\s*([\d,\s]+)/);

    const explanation = explanationMatch ? explanationMatch[1].trim() : 'وجدت نتائج ذات صلة / Found relevant results';
    const bookIds = idsMatch 
      ? idsMatch[1].split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
      : [];

    res.json({ explanation, bookIds: bookIds.slice(0, 30) });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Auto-suggestions
app.post('/api/suggest', async (req, res) => {
  const ip = req.ip;
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const { partial } = req.body;
    
    if (!partial || partial.length < 3) {
      return res.json({ suggestions: [] });
    }

    const prompt = `User typed: "${partial}"

Generate 5 search queries for a library. Same language as input.

Return ONLY comma-separated queries.`;

    const response = await callPerplexity([
      { role: 'user', content: prompt }
    ], 'sonar-pro');

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

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'ECSSR AI Assistant Backend is running',
    perplexityConfigured: !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: 'sonar-pro',
    features: 'Smart search with pre-filtering (no token limits)'
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🤖 Model: sonar-pro`);
  console.log(`📚 Smart search: Frontend filters → AI refines`);
  
  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'pplx-YOUR-API-KEY-HERE') {
    console.warn('⚠️  WARNING: Perplexity API key not configured!');
  } else {
    console.log('✅ Perplexity API key configured');
  }
});
