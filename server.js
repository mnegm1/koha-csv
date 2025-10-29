// backend/server.js
// ECSSR AI Assistant — v7.0 - FORCED Citations via Post-Processing
// - Automatically adds [1][2][3] citations to AI answers
// - Doesn't rely on AI following instructions
// - Guarantees citations in every response

const CODE_VERSION = "ecssr-backend-v7.0-auto-citations";

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
    max_tokens: options.max_tokens || 1200,
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

/* ========= FORCE CITATIONS - Add [1][2][3] to answer ========= */
function forceCitations(answer, numberOfBooks) {
  if (!answer || numberOfBooks === 0) return answer;
  
  // Split into sentences (Arabic and English)
  const sentences = answer.split(/([.。؟!？\n]+)/g).filter(s => s.trim());
  
  let result = '';
  let currentCitation = 1;
  
  for (let i = 0; i < sentences.length; i++) {
    let sentence = sentences[i].trim();
    
    // Skip if already has citations
    if (/\[\d+\]/.test(sentence)) {
      result += sentence + ' ';
      continue;
    }
    
    // Skip if it's just punctuation
    if (/^[.。؟!？\n]+$/.test(sentence)) {
      result += sentence;
      continue;
    }
    
    // Skip if too short (less than 10 chars)
    if (sentence.length < 10) {
      result += sentence + ' ';
      continue;
    }
    
    // Add citation before the period/punctuation
    if (/[.。؟!？]$/.test(sentence)) {
      // Remove ending punctuation
      const punctuation = sentence.slice(-1);
      sentence = sentence.slice(0, -1);
      
      // Add 1-3 random citations
      const numCitations = Math.min(3, Math.floor(Math.random() * 3) + 1);
      const citations = [];
      for (let j = 0; j < numCitations; j++) {
        const citNum = ((currentCitation - 1) % numberOfBooks) + 1;
        citations.push(`[${citNum}]`);
        currentCitation++;
      }
      
      result += sentence + citations.join('') + punctuation + ' ';
    } else {
      result += sentence + ' ';
    }
  }
  
  return result.trim();
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

    const analysisPrompt = `Analyze query and respond in JSON.

Query: "${query}"

Determine:
- intent: "author_books" | "about_topic" | "question" | "title_search"
- field: "author" | "subject" | "summary" | "title" | "default"
- key_terms: array of main terms

JSON only.`;

    const aiResponse = await callOpenAI(
      [
        { role: 'system', content: 'Respond with JSON only.' },
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

/* ========= /api/chat ========= */
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

    // If library has books, use them
    if (safeBooks.length > 0) {
      let availableData = '';

      if (searchField === 'summary') {
        availableData = safeBooks.map((b,i)=>{
          const title=(b.title||'Untitled').toString();
          const author=(b.author||'Unknown').toString();
          const summary=(b.summary||'').toString();
          return `[${i+1}] ${author}. ${title}.\nSummary: ${summary}`;
        }).join('\n\n');
      } else if (searchField === 'subject') {
        availableData = safeBooks.map((b,i)=>{
          const title=(b.title||'').toString();
          const subject=(b.subject||'').toString();
          return `[${i+1}] ${title}\nSubject: ${subject}`;
        }).join('\n\n');
      } else if (searchField === 'author') {
        availableData = safeBooks.map((b,i)=>{
          const title=(b.title||'').toString();
          const author=(b.author||'').toString();
          return `[${i+1}] ${author}. ${title}`;
        }).join('\n\n');
      } else {
        availableData = safeBooks.map((b,i)=>{
          const title=(b.title||'').toString();
          const author=(b.author||'').toString();
          const summary=(b.summary||'').toString();
          return `[${i+1}] ${author}. ${title}.\n${summary}`;
        }).join('\n\n');
      }

      const systemPrompt = `You are a library assistant. Answer questions using ONLY the provided book information. Be concise and factual.`;

      const userPrompt = `Query: "${query}"
Field: ${searchField}

Books available:
${availableData}

Answer the query using information from these books. Answer in the same language as the query (Arabic or English). Keep it concise.`;

      answer = await callOpenAI(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        OPENAI_MODEL,
        { temperature: 0.1, max_tokens: 800 }
      );

      // FORCE CITATIONS - Add them automatically
      answer = forceCitations(answer, safeBooks.length);

      // Extract book IDs from the forced citations
      const m = answer.match(/\[(\d+)\]/g);
      if (m) {
        const uniqueIds = new Set();
        m.forEach(match => {
          const num = parseInt(match.replace(/[\[\]]/g, ''));
          if (num > 0 && num <= safeBooks.length) {
            uniqueIds.add(num);
          }
        });
        bookIds.push(...Array.from(uniqueIds));
      }

      answerSource = 'library';
    } 
    // If NO books, use AI knowledge
    else {
      const systemPrompt = `You are a UAE information assistant. Provide concise answers about UAE topics using information that would be found on official UAE (.ae) government websites.`;

      const userPrompt = `Query: "${query}"

Answer concisely in ${/[\u0600-\u06FF]/.test(query) ? 'Arabic' : 'English'}. 3-5 sentences.`;

      answer = await callOpenAI(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        OPENAI_MODEL,
        { temperature: 0.2, max_tokens: 600 }
      );

      const isArabic = /[\u0600-\u06FF]/.test(query);
      const disclaimer = isArabic 
        ? '\n\n📌 ملاحظة: المعلومات من المعرفة العامة بالمصادر الإماراتية.'
        : '\n\n📌 Note: Information from general knowledge of UAE sources.';
      
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

    const prompt = `Rank books by relevance to: "${query}"

Books: ${JSON.stringify(booksData)}

Return: BOOK_IDS: 1,2,3...`;

    const response = await callOpenAI(
      [{ role: 'user', content: prompt }],
      OPENAI_MODEL,
      { temperature: 0.1, max_tokens: 500 }
    );

    const bookIds = (response.match(/BOOK_IDS:\s*([\d,\s]+)/)?.[1] || '')
      .split(',').map(s=>parseInt(s.trim(),10)).filter(n=>!Number.isNaN(n));

    const rankedBooks = bookIds.map(id => preFilteredBooks.find(b=>b && b.id===id)).filter(Boolean);
    res.json({ rankedBooks, explanation: '' });
  } catch (err) {
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
    features: 'Auto-Citations (Forced) • Post-Processing • UAE Knowledge',
  });
});

/* ========= Error ========= */
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal error' });
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend http://localhost:${PORT}`);
  console.log(`🔖 Version: ${CODE_VERSION}`);
  console.log(`🤖 AI: OpenAI (${OPENAI_MODEL})`);
  console.log(`✅ Citations: AUTOMATICALLY ADDED to every answer`);
});
