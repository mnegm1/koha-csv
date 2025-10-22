// backend/server.js
// ECSSR AI Assistant - AI Uses ONLY Catalog Summaries with Search Intent Understanding

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

// NEW: Detect search intent from query
function detectSearchIntent(query) {
  const q = query.toLowerCase();
  
  // Question patterns (what/how/why/when/where/who)
  const questionWords = /^(what|how|why|when|where|who|which|ما|كيف|لماذا|متى|أين|من|ماذا|كيفية)\b/i;
  if (questionWords.test(query)) {
    return 'question';
  }
  
  // Check if it looks like a name (author search)
  const namePatterns = /\b(بن|ابن|محمد|أحمد|عبد|علي|حسن|خالد)\b/i;
  const words = query.trim().split(/\s+/);
  if (words.length >= 2 && words.length <= 4 && namePatterns.test(query)) {
    return 'author';
  }
  
  // Default to topic search
  return 'topic';
}

// ====== CHAT ENDPOINT - AI with Search Intent Understanding ======
app.post('/api/chat', async (req, res) => {
  const ip = req.ip;
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
  }

  try {
    const { query, matchedBooks, searchField } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const books = matchedBooks || [];

    if (books.length === 0) {
      return res.json({ 
        answer: "لم أجد كتباً تطابق سؤالك في الكتالوج.<br>I didn't find any matching books in the catalog.",
        bookIds: []
      });
    }

    // NEW: Detect search intent
    const intent = detectSearchIntent(query);
    
    // NEW: Build context-aware instructions for AI
    let contextInstruction = '';
    if (intent === 'question') {
      contextInstruction = `
🔍 SEARCH INTENT: QUESTION
The user is asking a question and wants ANSWERS from book content.

PRIORITY:
1. Look in SUMMARIES/ABSTRACTS first (main source of answers)
2. If not found, check TITLES for relevant topics
3. Provide factual answers based on the content

Focus on: Facts, explanations, definitions, and detailed information from the summaries.`;
    } else if (intent === 'author') {
      contextInstruction = `
🔍 SEARCH INTENT: AUTHOR SEARCH
The user is looking for books BY this specific author.

PRIORITY:
1. Match AUTHOR names in the provided books
2. List all books by this author

Focus on: Author names and their publications.`;
    } else {
      contextInstruction = `
🔍 SEARCH INTENT: TOPIC/SUBJECT SEARCH
The user wants books ABOUT this topic or subject.

PRIORITY:
1. Look in SUBJECT fields first
2. Check TITLES for topic relevance
3. Review summaries if needed

Focus on: Books that discuss, cover, or relate to this topic.`;
    }

    const prompt = `You are a library assistant. Answer the user's query using ONLY the book information below.

${contextInstruction}

CRITICAL RULES:
- ONLY use information from the summaries, titles, subjects, and authors provided below
- DO NOT use your general knowledge
- DO NOT invent or assume information
- If the information isn't in the provided data, say "المعلومات غير متوفرة في ملخصات الكتب / Information not available in book summaries"
- When mentioning books, include their ID number in parentheses like (ID: 123)
- Be concise and helpful
- Answer in the same language as the query (Arabic or English)

SEARCH FIELD USED: ${searchField || 'auto-detected'}

AVAILABLE BOOKS (${books.length} found):
${JSON.stringify(books.map(b => ({
  id: b.id,
  title: b.title,
  author: b.author,
  subject: b.subject || '',
  summary: b.summary || "No summary available"
})), null, 2)}

USER QUERY: "${query}"

${intent === 'question' ? '📖 Answer the question using information from the summaries above.' : intent === 'author' ? '👤 List the books by this author from the results above.' : '📚 List the books about this topic from the results above.'}`;

    const answer = await callPerplexity([
      { 
        role: 'system', 
        content: `You are a library assistant who ONLY uses provided book data. Never use external knowledge. Always cite book IDs. Understand search intent: questions need summary content, topics need subject/title matching, authors need author field matching.` 
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
    message: 'ECSSR AI Assistant Backend - Search Intent Understanding',
    perplexityConfigured: !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: 'sonar-pro',
    features: 'AI understands questions vs topics vs authors'
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
  console.log(`🎯 Features: Search intent detection (questions/topics/authors)`);
  
  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'pplx-YOUR-API-KEY-HERE') {
    console.warn('⚠️  WARNING: Perplexity API key not configured!');
  } else {
    console.log('✅ Perplexity API key configured');
  }
});
