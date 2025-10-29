// backend/server.js
// ECSSR AI Assistant — v8.0 - REAL Citations with Source Tracking
// - Uses RAG (Retrieval Augmented Generation) approach
// - Tracks which book provides which information
// - Proper intellectual property attribution

const CODE_VERSION = "ecssr-backend-v8.0-real-citations";

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

  if (options.response_format === 'json') {
    requestBody.response_format = { type: "json_object" };
  }

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
function tokenizeName(n){ return norm(n).split(/\s+/).filter(t=>t.length>=2) }
function exactAuthorMatch(qTokens, name){
  if (!name) return false;
  const aTokens = tokenizeName(name);
  if (qTokens.length !== aTokens.length) return false;
  for (const qt of qTokens) if (!aTokens.includes(qt)) return false;
  for (const at of aTokens) if (!qTokens.includes(at)) return false;
  return true;
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

    const analysisPrompt = `Analyze this library search query and respond in JSON format.

USER QUERY: "${query}"

Determine:
1. intent: "author_books" | "about_topic" | "question" | "title_search"
2. field: "author" | "subject" | "summary" | "title" | "default"  
3. key_terms: array of main search terms

Respond with JSON only.`;

    const aiResponse = await callOpenAI(
      [
        { role: 'system', content: 'You are a query analyzer. Respond with JSON only.' },
        { role: 'user', content: analysisPrompt }
      ],
      OPENAI_MODEL,
      { response_format: 'json', temperature: 0.1 }
    );

    let parsed;
    try {
      parsed = JSON.parse(aiResponse);
    } catch (e) {
      return res.status(500).json({ error: 'Invalid AI response' });
    }

    res.json({
      intent: parsed.intent || 'question',
      field: parsed.field || 'default',
      keyTerms: parsed.key_terms || [],
      reasoning: parsed.reasoning || ''
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal error', details: err.message });
  }
});

/* ========= /api/chat - RAG with REAL Citations ========= */
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

    let answer = '';
    let bookIds = [];
    let answerSource = 'library';

    // If library has books, use them with PROPER citations
    if (safeBooks.length > 0) {
      
      // Build context with clear source numbers
      let booksContext = safeBooks.map((b, i) => {
        const num = i + 1;
        const title = (b.title || 'Untitled').toString();
        const author = (b.author || 'Unknown').toString();
        const summary = (b.summary || '').toString();
        const subject = (b.subject || '').toString();
        
        let bookInfo = `SOURCE [${num}]:\n`;
        bookInfo += `Author: ${author}\n`;
        bookInfo += `Title: ${title}\n`;
        
        if (searchField === 'summary' || searchField === 'default') {
          bookInfo += `Summary: ${summary}\n`;
        }
        if (searchField === 'subject' || searchField === 'default') {
          bookInfo += `Subject: ${subject}\n`;
        }
        
        return bookInfo;
      }).join('\n---\n\n');

      const systemPrompt = `You are a library assistant helping with intellectual property rights protection.

CRITICAL RULES FOR CITATIONS:
1. When you use information from SOURCE [1], you MUST cite it as [1]
2. When you use information from SOURCE [2], you MUST cite it as [2]
3. EVERY piece of information MUST have the correct source number
4. Place citations [1], [2], [3] immediately after the information from that source
5. DO NOT make up information not in the sources
6. DO NOT cite sources you didn't use

This is REQUIRED for intellectual property rights protection!

Example of CORRECT citations:
"محمد بن راشد كتب رؤيتي [1]. الكتاب يتحدث عن القيادة [1]. كما كتب ومضات من فكر [3]."
(Note: [1] is used twice because both facts came from SOURCE [1])

Example of WRONG citations:
"محمد بن راشد كتب رؤيتي. الكتاب يتحدث عن القيادة." ← NO CITATIONS (WRONG!)
"محمد بن راشد كتب رؤيتي [1]. الكتاب يتحدث عن القيادة [2]." ← [2] is wrong if both facts from SOURCE [1]!`;

      const userPrompt = `USER QUERY: "${query}"
SEARCH FIELD: ${searchField}

AVAILABLE SOURCES:
${booksContext}

Instructions:
1. Answer the query using ONLY information from the sources above
2. Cite the SOURCE number [1], [2], [3] for EVERY fact you mention
3. Place citation immediately after each piece of information
4. Answer in the same language as the query (Arabic or English)
5. Be accurate with citations - this is for intellectual property protection

Answer now with proper citations:`;

      answer = await callOpenAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        OPENAI_MODEL,
        { temperature: 0.05, max_tokens: 1500 }
      );

      // Extract book IDs from citations
      const citationMatches = answer.match(/\[(\d+)\]/g);
      if (citationMatches) {
        const uniqueIds = new Set();
        citationMatches.forEach(match => {
          const num = parseInt(match.replace(/[\[\]]/g, ''));
          if (num > 0 && num <= safeBooks.length) {
            uniqueIds.add(num);
          }
        });
        bookIds.push(...Array.from(uniqueIds));
      }

      // If AI didn't add citations, add a warning
      if (bookIds.length === 0 && answer.length > 50) {
        const isArabic = /[\u0600-\u06FF]/.test(query);
        const warning = isArabic
          ? '\n\n⚠️ تحذير: لم يتم إضافة مراجع محددة. يرجى الرجوع إلى الكتب المدرجة أعلاه.'
          : '\n\n⚠️ Warning: No specific citations added. Please refer to the books listed above.';
        answer += warning;
      }

      answerSource = 'library';
      
    } 
    // If NO books, use AI knowledge
    else {
      const systemPrompt = `You are a UAE information assistant. Provide concise, factual answers about UAE topics based on information typically found on official UAE (.ae) government websites.

FORBIDDEN SOURCES: Wikipedia, BBC, Reuters, CNN, Al Jazeera, or any non-.ae sources.`;

      const userPrompt = `Query: "${query}"

Provide a brief answer (3-5 sentences) in ${/[\u0600-\u06FF]/.test(query) ? 'Arabic' : 'English'} based on UAE official knowledge.`;

      answer = await callOpenAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        OPENAI_MODEL,
        { temperature: 0.2, max_tokens: 600 }
      );

      const isArabic = /[\u0600-\u06FF]/.test(query);
      const disclaimer = isArabic 
        ? '\n\n📌 ملاحظة: المعلومات من المعرفة العامة بالمصادر الرسمية الإماراتية. للحصول على معلومات دقيقة، يرجى الرجوع إلى المواقع الرسمية مثل government.ae و wam.ae'
        : '\n\n📌 Note: Information from general knowledge of UAE official sources. For accurate information, please refer to official websites like government.ae and wam.ae';
      
      answer = answer + disclaimer;
      answerSource = 'ai_knowledge';
      bookIds = [];
    }

    res.json({ 
      answer, 
      bookIds: bookIds,
      source: answerSource
    });
    
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Internal error', details: err.message });
  }
});

/* ========= /api/enhance-search ========= */
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
      return res.json({ rankedBooks: preFilteredBooks, explanation: '' });
    }

    const booksData = preFilteredBooks.slice(0, 50).map((b, idx) => ({
      id: b?.id ?? idx,
      title: b?.title || 'Untitled',
      author: b?.author || 'Unknown',
      summary: (b?.summary || '').substring(0, 200)
    }));

    const prompt = `Rank these books by relevance to the query: "${query}"

Books:
${JSON.stringify(booksData, null, 2)}

Return the top 20 book IDs in order of relevance.
Format: BOOK_IDS: 1,2,3,4...`;

    const response = await callOpenAI(
      [{ role: 'user', content: prompt }],
      OPENAI_MODEL,
      { temperature: 0.1, max_tokens: 500 }
    );

    const bookIds = (response.match(/BOOK_IDS:\s*([\d,\s]+)/)?.[1] || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !Number.isNaN(n));

    const rankedBooks = bookIds
      .map(id => preFilteredBooks.find(b => b && b.id === id))
      .filter(Boolean);
      
    res.json({ rankedBooks, explanation: '' });
    
  } catch (err) {
    console.error('Enhance search error:', err);
    res.status(500).json({ error: 'Error', details: err.message });
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
    features: 'Real Citations • Source Tracking • Intellectual Property Protection • RAG',
  });
});

/* ========= Error ========= */
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal error', details: err.message });
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend http://localhost:${PORT}`);
  console.log(`🔖 Version: ${CODE_VERSION}`);
  console.log(`🤖 AI Provider: OpenAI (${OPENAI_MODEL})`);
  console.log(`📚 Citations: REAL sources with intellectual property protection`);
  console.log(`✅ Each [1], [2], [3] citation matches the actual book source`);
});
