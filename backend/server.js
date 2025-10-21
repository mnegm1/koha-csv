// backend/server.js
// ECSSR AI Assistant Backend with Perplexity API
// UPDATED: Fixed model names for 2025

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || 'pplx-YOUR-API-KEY-HERE';
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

// Middleware
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

// Helper: Call Perplexity API with UPDATED model names
async function callPerplexity(messages, model = 'sonar') {
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
        temperature: 0.2,
        max_tokens: 1000
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

// ====== ENDPOINTS ======

// 1. Chat endpoint
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

    const contextMsg = `You are a helpful library assistant for ECSSR (Emirates Center for Strategic Studies and Research).

Catalog Information:
- Total books: ${context.totalBooks}
- Sample books in collection: ${JSON.stringify(context.sampleBooks.slice(0, 20))}

Previous conversation: ${JSON.stringify(context.conversationHistory || [])}

Instructions:
- Help users find relevant books
- Answer questions about the catalog
- Provide book recommendations
- Be concise and helpful
- Support both Arabic and English
- If recommending books, mention their IDs from the sample

User question: ${query}`;

    const answer = await callPerplexity([
      { role: 'system', content: 'You are a library assistant for ECSSR.' },
      { role: 'user', content: contextMsg }
    ], 'sonar');

    const bookIds = [];
    const idMatches = answer.match(/\b(\d+)\b/g);
    if (idMatches) {
      bookIds.push(...idMatches.slice(0, 5).map(Number));
    }

    res.json({ answer, bookIds });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Search endpoint
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

    const prompt = `You are analyzing a search query for a library catalog.

Query: "${query}"

Available books (first 100):
${JSON.stringify(catalog.slice(0, 30))}

Task:
1. Understand what the user is looking for
2. Identify the most relevant books by their IDs
3. Explain your reasoning

Format your response as:
EXPLANATION: [brief explanation]
BOOK_IDS: [comma-separated list of relevant book IDs]`;

    const response = await callPerplexity([
      { role: 'user', content: prompt }
    ], 'sonar-small');

    const explanationMatch = response.match(/EXPLANATION:\s*(.+?)(?=BOOK_IDS:|$)/s);
    const idsMatch = response.match(/BOOK_IDS:\s*([\d,\s]+)/);

    const explanation = explanationMatch ? explanationMatch[1].trim() : 'Found relevant results';
    const bookIds = idsMatch 
      ? idsMatch[1].split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
      : [];

    res.json({ explanation, bookIds: bookIds.slice(0, 20) });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Recommendations endpoint
app.post('/api/recommend', async (req, res) => {
  const ip = req.ip;
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const { bookTitle, catalog } = req.body;
    
    if (!bookTitle) {
      return res.status(400).json({ error: 'Book title is required' });
    }

    const prompt = `A user is interested in books similar to: "${bookTitle}"

Available books in catalog:
${JSON.stringify(catalog.slice(0, 50))}

Task:
1. Find 5 books similar to the given title
2. Consider: topic, author style, subject area, publication period
3. Provide reasoning for each recommendation

Format:
EXPLANATION: [why these books are similar]
BOOK_IDS: [comma-separated IDs]`;

    const response = await callPerplexity([
      { role: 'user', content: prompt }
    ], 'sonar-small');

    const explanationMatch = response.match(/EXPLANATION:\s*(.+?)(?=BOOK_IDS:|$)/s);
    const idsMatch = response.match(/BOOK_IDS:\s*([\d,\s]+)/);

    const explanation = explanationMatch ? explanationMatch[1].trim() : 'Recommendations based on similarity';
    const bookIds = idsMatch 
      ? idsMatch[1].split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
      : [];

    res.json({ explanation, bookIds: bookIds.slice(0, 10) });

  } catch (error) {
    console.error('Recommend error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Auto-suggestions endpoint
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

Generate 5 complete search queries for a library catalog. Mix Arabic and English suggestions based on the input language.

Return ONLY a comma-separated list of suggestions, nothing else.`;

    const response = await callPerplexity([
      { role: 'user', content: prompt }
    ], 'sonar-small');

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
    modelVersion: 'sonar/sonar-small (2025)'
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
  console.log(`🤖 Using Perplexity models: sonar, sonar-small`);
  
  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'pplx-YOUR-API-KEY-HERE') {
    console.warn('⚠️  WARNING: Perplexity API key not configured!');
    console.warn('   Set PERPLEXITY_API_KEY environment variable');
  } else {
    console.log('✅ Perplexity API key configured');
  }
});
