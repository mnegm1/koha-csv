// backend/server.js
// ECSSR AI Assistant Backend with Perplexity API
// FINAL VERSION - Based on your working code
// Changes: Search ALL books, No recommend, No AI hallucinations

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || 'pplx-YOUR-API-KEY-HERE';
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // CHANGED: Increased from 10mb for large catalogs

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

// Helper: Call Perplexity API
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
        temperature: 0.1, // CHANGED: Lower from 0.2 for more accuracy
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

// 1. Chat endpoint - UPDATED: Uses ALL books
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

    // CHANGED: Use ALL books from catalog (frontend sends all)
    const allBooks = context.sampleBooks || [];

    // CHANGED: Added strict instructions to prevent hallucinations
    const contextMsg = `You are a helpful library assistant for ECSSR (Emirates Center for Strategic Studies and Research).

CRITICAL RULES:
- ONLY answer using the catalog books listed below
- DO NOT use your general knowledge about books or authors
- If a book/author is not in the list below, say "لا أجد هذا في كتالوج المكتبة / Not found in our catalog"
- When mentioning books, include their ID number

COMPLETE CATALOG (${context.totalBooks} books):
${JSON.stringify(allBooks)}

Previous conversation: ${JSON.stringify(context.conversationHistory || [])}

Instructions:
- Help users find relevant books
- Answer questions about the catalog
- Be concise and helpful
- Support both Arabic and English
- If recommending books, mention their IDs from the sample

User question: ${query}

Answer ONLY based on the catalog above.`;

    const answer = await callPerplexity([
      { role: 'system', content: 'You are a library assistant for ECSSR. ONLY use provided catalog data.' },
      { role: 'user', content: contextMsg }
    ], 'sonar-pro');

    const bookIds = [];
    const idMatches = answer.match(/\b(\d+)\b/g);
    if (idMatches) {
      bookIds.push(...idMatches.slice(0, 20).map(Number)); // CHANGED: Up to 20 results
    }

    res.json({ answer, bookIds });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Search endpoint - UPDATED: Searches ALL books
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

    // CHANGED: Use ALL books (no limit!)
    const allBooks = catalog || [];

    // CHANGED: Updated prompt to search ALL books
    const prompt = `You are analyzing a search query for a library catalog.

CRITICAL RULES:
- ONLY identify books from the exact catalog below
- DO NOT invent book IDs or suggest books not in this list
- Search thoroughly through ALL books

Query: "${query}"

COMPLETE CATALOG (${allBooks.length} books):
${JSON.stringify(allBooks)}

Task:
1. Find ALL books matching the query from the catalog above
2. Identify the most relevant books by their exact IDs
3. Explain your reasoning briefly

If no matches: say "لا توجد نتائج / No results found"

Format your response as:
EXPLANATION: [brief explanation]
BOOK_IDS: [comma-separated list of relevant book IDs from catalog]`;

    const response = await callPerplexity([
      { role: 'system', content: 'Only identify books from provided catalog. Never invent IDs.' },
      { role: 'user', content: prompt }
    ], 'sonar-pro');

    const explanationMatch = response.match(/EXPLANATION:\s*(.+?)(?=BOOK_IDS:|$)/s);
    const idsMatch = response.match(/BOOK_IDS:\s*([\d,\s]+)/);

    const explanation = explanationMatch ? explanationMatch[1].trim() : 'Found relevant results';
    const bookIds = idsMatch 
      ? idsMatch[1].split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
      : [];

    res.json({ explanation, bookIds: bookIds.slice(0, 50) }); // CHANGED: Return up to 50 results

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// REMOVED: Recommendations endpoint (lines 197-241 deleted)
// You said you don't need recommendations, so this entire section is removed

// 3. Auto-suggestions endpoint (same as before)
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

// Health check - UPDATED
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'ECSSR AI Assistant Backend is running',
    perplexityConfigured: !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: 'sonar-pro',
    features: 'Search ALL books, Chat & Search only, No hallucinations' // CHANGED
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server - UPDATED
app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🤖 Using Perplexity model: sonar-pro`);
  console.log(`📚 NEW: Searches ALL books, No recommend endpoint`); // CHANGED
  
  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'pplx-YOUR-API-KEY-HERE') {
    console.warn('⚠️  WARNING: Perplexity API key not configured!');
    console.warn('   Set PERPLEXITY_API_KEY environment variable');
  } else {
    console.log('✅ Perplexity API key configured');
  }
});
