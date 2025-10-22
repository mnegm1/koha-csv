// backend/server.js
// ECSSR AI Assistant - AI Uses ONLY Catalog Summaries
// Frontend searches → Backend gets summaries → AI answers from summaries ONLY

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
        temperature: 0.05, // VERY LOW = stick to provided data
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

// ====== CHAT ENDPOINT - AI Reads Summaries ONLY ======
app.post('/api/chat', async (req, res) => {
  const ip = req.ip;
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
  }

  try {
    const { query, matchedBooks } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Frontend already searched and sends ONLY matched books
    const books = matchedBooks || [];

    if (books.length === 0) {
      return res.json({ 
        answer: "لم أجد كتباً تطابق سؤالك في الكتالوج.<br>I didn't find any matching books in the catalog.",
        bookIds: []
      });
    }

    // Build STRICT prompt - AI can ONLY use these summaries
    const prompt = `You are a library assistant. Answer the user's question using ONLY the book summaries below.

CRITICAL RULES:
- ONLY use information from the summaries provided below
- DO NOT use your general knowledge
- DO NOT invent or assume information
- If the summaries don't contain the answer, say "المعلومات غير متوفرة في ملخصات الكتب / Information not available in book summaries"
- When mentioning books, include their ID number
- Be concise and helpful

AVAILABLE BOOKS (with summaries from catalog):
${JSON.stringify(books.map(b => ({
  id: b.id,
  title: b.title,
  author: b.author,
  summary: b.summary || "No summary available"
})))}

User question: ${query}

Answer using ONLY the summaries above. Start your answer with the number of relevant books found.`;

    const answer = await callPerplexity([
      { 
        role: 'system', 
        content: 'You ONLY answer based on provided book summaries. Never use external knowledge. Always cite book IDs.' 
      },
      { role: 'user', content: prompt }
    ], 'sonar-pro');

    // Extract book IDs mentioned in answer
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

// ====== ENHANCE SEARCH - AI Ranks by Summary Relevance ======
app.post('/api/enhance-search', async (req, res) => {
  const ip = req.ip;
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const { query, preFilteredBooks } = req.body;
    
    if (!query || !preFilteredBooks || preFilteredBooks.length === 0) {
      return res.json({ rankedBooks: preFilteredBooks || [], explanation: "" });
    }

    // AI reads summaries and ranks by relevance
    const prompt = `You are analyzing book summaries for a library search.

User searched for: "${query}"

BOOKS WITH SUMMARIES:
${JSON.stringify(preFilteredBooks.slice(0, 50).map(b => ({
  id: b.id,
  title: b.title,
  author: b.author,
  summary: b.summary || ""
})))}

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

    // Return books in AI-ranked order
    const rankedBooks = bookIds
      .map(id => preFilteredBooks.find(b => b.id === id))
      .filter(Boolean);

    res.json({ rankedBooks, explanation });

  } catch (error) {
    console.error('Enhance search error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'ECSSR AI Assistant Backend - Summary-only mode',
    perplexityConfigured: !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: 'sonar-pro',
    features: 'AI uses ONLY catalog summaries, no external knowledge'
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🤖 Model: sonar-pro (temperature: 0.05)`);
  console.log(`📚 AI uses ONLY catalog summaries - NO external knowledge`);
  
  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'pplx-YOUR-API-KEY-HERE') {
    console.warn('⚠️  WARNING: Perplexity API key not configured!');
  } else {
    console.log('✅ Perplexity API key configured');
  }
});
