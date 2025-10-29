// backend/server.js
// ECSSR AI Assistant — v13.0 - ChatGPT Only (No Perplexity)
// - Uses ChatGPT for library books
// - Uses ChatGPT for UAE website information
// - Simple, reliable, one API

const CODE_VERSION = "ecssr-backend-v13.0-chatgpt-only";

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-YOUR-API-KEY-HERE';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* ========= Rate limiting ========= */
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

/* ========= OpenAI wrapper ========= */
async function callOpenAI(messages, model = OPENAI_MODEL, options = {}) {
  const requestBody = {
    model,
    messages,
    temperature: options.temperature || 0.1,
    max_tokens: options.max_tokens || 2000,
  };

  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI API error: ${resp.status} - ${txt}`);
  }

  const data = await resp.json();
  return (data.choices && data.choices[0]?.message?.content) || '';
}

/* ========= Normalization ========= */
function norm(s) {
  if (!s) return '';
  s = String(s).toLowerCase();
  try { s = s.normalize('NFKD'); } catch {}
  return s
    .replace(/[إأآٱ]/g,'ا').replace(/\s*و\s*/g,'و').replace(/[ىی]/g,'ي')
    .replace(/ة/g,'ه').replace(/ک/g,'ك').replace(/\bعبد\s+ال/g,'عبدال')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g,'')
    .replace(/[\u0660-\u0669]/g, d => String.fromCharCode(d.charCodeAt(0)-1632+48))
    .replace(/[\u06F0-\u06F9]/g, d => String.fromCharCode(d.charCodeAt(0)-1776+48))
    .replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
}

/* ========= Extract web sources from answer ========= */
function extractWebSources(answer) {
  // Extract all markdown links [text](url)
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
  const sources = [];
  let match;
  
  while ((match = linkRegex.exec(answer)) !== null) {
    const url = match[2];
    // Only UAE .ae domains
    if (url.includes('.ae')) {
      sources.push(url);
    }
  }
  
  // Remove duplicates
  return [...new Set(sources)];
}

/* ========= /api/understand-query ========= */
app.post('/api/understand-query', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Query required' });

    res.json({
      intent: 'question',
      field: 'default',
      keyTerms: [],
      reasoning: 'Processing query'
    });
  } catch (err) {
    res.status(500).json({ error: 'Error', details: err.message });
  }
});

/* ========= /api/chat - ChatGPT Only ========= */
app.post('/api/chat', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const { query, books, searchField } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Query required' });

    const safeBooks = (Array.isArray(books) ? books : [])
      .filter(b => b && typeof b === 'object')
      .slice(0, 30);

    console.log(`\n========================================`);
    console.log(`📚 Query: "${query}"`);
    console.log(`📚 Number of books: ${safeBooks.length}`);
    console.log(`========================================\n`);

    let answer = '';
    let bookIds = [];
    let webSources = [];
    let answerSource = 'library';

    // If we have books
    if (safeBooks.length > 0) {
      
      // Build book sources
      const bookSources = safeBooks.map((b, i) => {
        const num = i + 1;
        const title = (b.title || 'Untitled').toString();
        const author = (b.author || 'Unknown').toString();
        const summary = (b.summary || '').toString().substring(0, 500);
        
        return `SOURCE [${num}]:
Title: ${title}
Author: ${author}
Summary: ${summary}`;
      }).join('\n\n---\n\n');

      const isArabic = /[\u0600-\u06FF]/.test(query);

      const systemPrompt = `You are a professional research assistant for UAE libraries.

CITATION RULES:
1. For library books → Cite as [1], [2], [3]
2. For UAE official websites → Mention in text with general references

UAE WEBSITE REFERENCES:
When you reference information that would typically be found on UAE official websites, mention the source naturally:
- Arabic: "وفقاً لوكالة أنباء الإمارات" or "حسب البوابة الرسمية لحكومة الإمارات"
- English: "according to Emirates News Agency" or "as per UAE Government Portal"

AUTHORIZED UAE SOURCES TO MENTION:
- wam.ae (وكالة أنباء الإمارات / Emirates News Agency)
- government.ae (البوابة الرسمية لحكومة الإمارات / UAE Government Portal)
- uae.gov.ae (البوابة الرسمية لدولة الإمارات / UAE Official Portal)
- moe.gov.ae (وزارة التربية والتعليم / Ministry of Education)

NEVER mention: Wikipedia, BBC, Reuters, or non-.ae sources

YOUR TASK:
1. Answer using library books primarily
2. Supplement with general knowledge about UAE from official sources
3. Cite books with [numbers]
4. Mention UAE sources by name when relevant
5. Be accurate and professional`;

      const userPrompt = `USER QUERY: "${query}"

LIBRARY BOOKS AVAILABLE:
${bookSources}

INSTRUCTIONS:
1. Answer the question comprehensively
2. Use library books as primary sources → cite with [1], [2], [3]
3. Supplement with UAE official knowledge when relevant → mention source name
4. Answer in ${isArabic ? 'Arabic' : 'English'}
5. Be concise but thorough (4-6 sentences)

Answer now:`;

      console.log('🤖 Calling ChatGPT...');
      
      answer = await callOpenAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        OPENAI_MODEL,
        { temperature: 0.1, max_tokens: 2000 }
      );

      console.log('✅ ChatGPT response received');

      // Extract book citations [1], [2], [3]
      const citationMatches = answer.match(/\[(\d+)\]/g);
      if (citationMatches) {
        const uniqueIds = new Set();
        citationMatches.forEach(match => {
          const num = parseInt(match.replace(/[\[\]]/g, ''));
          if (num > 0 && num <= safeBooks.length) {
            uniqueIds.add(num);
          }
        });
        bookIds = Array.from(uniqueIds).sort((a, b) => a - b);
      }

      // Extract mentioned UAE sources
      const uaeSites = ['wam.ae', 'government.ae', 'uae.gov.ae', 'moe.gov.ae'];
      const mentionedSites = [];
      uaeSites.forEach(site => {
        if (answer.toLowerCase().includes(site) || 
            answer.includes('وكالة أنباء الإمارات') ||
            answer.includes('حكومة الإمارات') ||
            answer.includes('emirates news') ||
            answer.includes('government portal')) {
          mentionedSites.push(site);
        }
      });
      
      webSources = mentionedSites;

      console.log(`\n✅ Response complete:`);
      console.log(`📚 Book citations: ${bookIds.join(', ') || 'none'}`);
      console.log(`🌐 UAE sources mentioned: ${webSources.join(', ') || 'none'}\n`);

      answerSource = 'library';
      
    } 
    // No books - general UAE knowledge
    else {
      console.log('🤖 No books, using general UAE knowledge...');
      
      const isArabic = /[\u0600-\u06FF]/.test(query);

      const systemPrompt = `You are a UAE information assistant. Provide accurate information about UAE topics based on official sources.

When providing information, mention the authoritative source:
- Arabic: "وفقاً لوكالة أنباء الإمارات" or "حسب البوابة الرسمية لحكومة الإمارات"
- English: "according to Emirates News Agency" or "as per UAE Government Portal"

Only reference UAE official .ae websites.`;

      const userPrompt = `Query: "${query}"

Provide a concise answer (3-5 sentences) in ${isArabic ? 'Arabic' : 'English'}, mentioning UAE official sources when relevant.`;

      answer = await callOpenAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        OPENAI_MODEL,
        { temperature: 0.2, max_tokens: 600 }
      );

      console.log('✅ ChatGPT response received');

      answerSource = 'ai_knowledge';
      bookIds = [];
      webSources = [];
    }

    res.json({ 
      answer, 
      bookIds,
      webSources,
      source: answerSource
    });
    
  } catch (err) {
    console.error('❌ Chat error:', err);
    res.status(500).json({ error: 'Error', details: err.message });
  }
});

/* ========= /api/enhance-search ========= */
app.post('/api/enhance-search', async (req, res) => {
  try {
    const { preFilteredBooks } = req.body || {};
    res.json({ rankedBooks: preFilteredBooks || [], explanation: '' });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

/* ========= Health ========= */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    codeVersion: CODE_VERSION,
    aiProvider: 'OpenAI ChatGPT Only',
    openaiConfigured: !!OPENAI_API_KEY && OPENAI_API_KEY !== 'sk-YOUR-API-KEY-HERE',
    modelVersion: OPENAI_MODEL,
    features: 'ChatGPT Only • Library Books [1][2][3] • UAE Knowledge • No Perplexity',
  });
});

/* ========= Error ========= */
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Error' });
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`\n🚀 ECSSR AI Backend http://localhost:${PORT}`);
  console.log(`🔖 Version: ${CODE_VERSION}`);
  console.log(`🤖 AI: ChatGPT Only (no Perplexity)`);
  console.log(`📚 Library books → [1][2][3] citations`);
  console.log(`🌐 UAE sources → Mentioned by name`);
  console.log(`✅ Simple, reliable, one API\n`);
});
