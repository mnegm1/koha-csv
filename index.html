// backend/server.js
// ECSSR AI Assistant — v10.0 - Dual Sources with Proper Attribution
// - Library books cited as [1][2][3]
// - UAE websites mentioned in text with links
// - Proper intellectual property protection

const CODE_VERSION = "ecssr-backend-v10.0-dual-sources";

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
    max_tokens: options.max_tokens || 1500,
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

/* ========= /api/chat - DUAL SOURCES ========= */
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

    console.log(`📚 Query: "${query}"`);
    console.log(`📚 Number of books: ${safeBooks.length}`);
    console.log(`📚 Search field: ${searchField}`);

    let answer = '';
    let bookIds = [];
    let answerSource = 'library';
    let uaeSources = [];

    // If we have books, use them WITH UAE website references
    if (safeBooks.length > 0) {
      
      // Build book sources with clear numbering
      const bookSources = safeBooks.map((b, i) => {
        const num = i + 1;
        const title = (b.title || 'Untitled').toString();
        const author = (b.author || 'Unknown').toString();
        const summary = (b.summary || '').toString().substring(0, 400);
        const subject = (b.subject || '').toString();
        
        return `SOURCE [${num}]:
Author: ${author}
Title: ${title}
Subject: ${subject}
Summary: ${summary}`;
      }).join('\n\n---\n\n');

      const isArabic = /[\u0600-\u06FF]/.test(query);

      const systemPrompt = `You are a library assistant that provides comprehensive answers using BOTH library books AND official UAE (.ae) websites.

CITATION RULES:
1. For information from library books → Use [1], [2], [3] numbers
2. For information from UAE websites → Mention the website in text

CRITICAL INSTRUCTIONS:
- When citing library books, use [1], [2], [3] immediately after the information
- When referencing UAE websites, write it in the text like:
  ${isArabic ? '• "وفقاً لوكالة أنباء الإمارات (wam.ae)..."' : '• "According to Emirates News Agency (wam.ae)..."'}
  ${isArabic ? '• "حسب البوابة الرسمية لحكومة الإمارات (government.ae)..."' : '• "According to UAE Government Portal (government.ae)..."'}
  ${isArabic ? '• "بحسب وزارة التربية والتعليم (moe.gov.ae)..."' : '• "According to Ministry of Education (moe.gov.ae)..."'}

AUTHORIZED UAE WEBSITES:
- government.ae (UAE Government Portal)
- wam.ae (Emirates News Agency)
- uae.gov.ae (UAE Official Portal)
- moe.gov.ae (Ministry of Education)
- mohesr.gov.ae (Ministry of Higher Education)

FORBIDDEN: Wikipedia, BBC, Reuters, Al Jazeera, CNN, any non-.ae sources

YOU MUST:
- Combine library book information with UAE website information
- Cite books with [numbers]
- Mention UAE websites by name in the text
- Provide comprehensive answers using both sources`;

      const userPrompt = `USER QUERY: "${query}"
SEARCH FIELD: ${searchField}

LIBRARY SOURCES AVAILABLE:
${bookSources}

INSTRUCTIONS:
1. Answer the question using the library sources above AND your knowledge of UAE official websites
2. For book information: cite with [1], [2], [3]
3. For UAE website information: mention the website name in text like "${isArabic ? 'وفقاً لـ wam.ae' : 'according to wam.ae'}"
4. Provide a comprehensive answer combining both sources
5. Answer in ${isArabic ? 'Arabic' : 'English'}

Example format:
"${isArabic 
  ? 'كتب محمد بن راشد العديد من الكتب [1][2]. وفقاً لوكالة أنباء الإمارات (wam.ae)، يعتبر من أبرز القادة. تتناول كتبه موضوعات القيادة [1] والتنمية [3].' 
  : 'Mohammed bin Rashid wrote many books [1][2]. According to Emirates News Agency (wam.ae), he is a prominent leader. His books cover leadership [1] and development [3].'}"

Answer now with BOTH book citations [1][2][3] AND UAE website mentions:`;

      answer = await callOpenAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        OPENAI_MODEL,
        { temperature: 0.1, max_tokens: 1500 }
      );

      console.log(`📝 AI answer: ${answer}`);

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

      // Extract UAE website mentions
      const uaeWebsites = ['wam.ae', 'government.ae', 'uae.gov.ae', 'moe.gov.ae', 'mohesr.gov.ae'];
      uaeWebsites.forEach(site => {
        if (answer.toLowerCase().includes(site)) {
          uaeSources.push(site);
        }
      });

      console.log(`✅ Book citations: ${bookIds.join(', ')}`);
      console.log(`✅ UAE sources mentioned: ${uaeSources.join(', ')}`);

      answerSource = 'dual'; // Both library and web
      
    } 
    // No books - use AI knowledge only
    else {
      const isArabic = /[\u0600-\u06FF]/.test(query);
      
      const systemPrompt = `You are a UAE information assistant. Provide answers based on UAE official websites.

When mentioning information, cite the UAE website source in your text like:
${isArabic ? '- "وفقاً لوكالة أنباء الإمارات (wam.ae)..."' : '- "According to Emirates News Agency (wam.ae)..."'}
${isArabic ? '- "حسب حكومة الإمارات (government.ae)..."' : '- "According to UAE Government (government.ae)..."'}

ONLY use: wam.ae, government.ae, uae.gov.ae, moe.gov.ae
NEVER use: Wikipedia, BBC, Reuters, non-.ae sources`;

      const userPrompt = `Query: "${query}"

Answer in ${isArabic ? 'Arabic' : 'English'} (3-5 sentences). Mention UAE website sources in your text.`;

      answer = await callOpenAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        OPENAI_MODEL,
        { temperature: 0.2, max_tokens: 600 }
      );

      // Extract UAE sources
      const uaeWebsites = ['wam.ae', 'government.ae', 'uae.gov.ae', 'moe.gov.ae'];
      uaeWebsites.forEach(site => {
        if (answer.toLowerCase().includes(site)) {
          uaeSources.push(site);
        }
      });

      answerSource = 'ai_knowledge';
      bookIds = [];
    }

    res.json({ 
      answer, 
      bookIds,
      source: answerSource,
      uaeSources: uaeSources
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
    aiProvider: 'OpenAI',
    openaiConfigured: !!OPENAI_API_KEY && OPENAI_API_KEY !== 'sk-YOUR-API-KEY-HERE',
    modelVersion: OPENAI_MODEL,
    features: 'Dual Sources • Library Books [1][2][3] • UAE Websites in Text',
  });
});

/* ========= Error ========= */
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Error' });
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend http://localhost:${PORT}`);
  console.log(`🔖 Version: ${CODE_VERSION}`);
  console.log(`📚 Library books → Cited as [1][2][3]`);
  console.log(`🌐 UAE websites → Mentioned in text with links`);
  console.log(`✅ Dual source attribution for IP protection`);
});
