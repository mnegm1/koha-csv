// backend/server.js
// ECSSR AI Assistant — v3.2
// - Health shows codeVersion
// - Strict author matching with "exact 2-token author preferred" rule
// - Safe availableData builders (no sampleBooks)
// - Rate limiting + robust guards

const CODE_VERSION = "ecssr-backend-v3.2-2token-prefer";

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const PERPLEXITY_API_KEY =
  process.env.PERPLEXITY_API_KEY || 'pplx-YOUR-API-KEY-HERE';
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = process.env.PPLX_MODEL || 'sonar-pro';

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

/* ========= Perplexity wrapper ========= */
async function callPerplexity(messages, model = PERPLEXITY_MODEL) {
  const resp = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model, messages, temperature: 0.05, max_tokens: 800,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Perplexity API error: ${resp.status} - ${txt}`);
  }
  const data = await resp.json();
  return (data.choices && data.choices[0]?.message?.content) || '';
}

/* ========= Normalization + author utils ========= */
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
  
  // For 3-name searches, require EXACT positional order
  if(qTokens.length === 3 && aTokens.length === 3) {
    return qTokens[0] === aTokens[0] && 
           qTokens[1] === aTokens[1] && 
           qTokens[2] === aTokens[2];
  }
  
  // For other cases (1, 2, 4+ names), use flexible token matching
  for (const qt of qTokens) if (!aTokens.includes(qt)) return false;
  for (const at of aTokens) if (!qTokens.includes(at)) return false;
  return true;
}

/* ========= Author filter with "exact 2-token preferred" ========= */
function filterAuthorBooks(query, books) {
  const qTokens = tokenizeName(query);
  if (qTokens.length === 0) return [];
  const list = (Array.isArray(books) ? books : []).filter(b => b && typeof b === 'object');

  // Check if any exact 2-token author exists when query has 2 tokens
  let exactTwoTokenExists = false;
  if (qTokens.length === 2) {
    for (const b of list) {
      const aLen = tokenizeName(b.author || '').length;
      if (aLen === 2 && exactAuthorMatch(qTokens, b.author || '')) {
        exactTwoTokenExists = true; break;
      }
    }
  }

  const out = [];
  for (const b of list) {
    const author = b.author || '';
    const isExact = exactAuthorMatch(qTokens, author);
    const aLen    = tokenizeName(author).length;

    if (qTokens.length === 2 && exactTwoTokenExists) {
      // only allow exact 2-token matches
      if (isExact && aLen === 2) out.push(b);
      continue;
    }

    // Otherwise, only exact (as per your last backend version)
    if (isExact) out.push(b);
  }
  return out;
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

    const analysisPrompt = `You are a search query analyzer for a library system. Analyze the following query and respond in JSON format.

USER QUERY: "${query}"

Determine:
1. INTENT: What is the user looking for?
   - "author_books" = books BY this author
   - "about_topic" = books ABOUT this topic/person
   - "question" = answering a specific question
   - "title_search" = looking for a specific book title

2. FIELD: Which field to search?
   - "author" = search by author name
   - "subject" = search by subject/topic
   - "summary" = search in book summaries/contents
   - "title" = search by book title
   - "default" = search all fields

3. KEY_TERMS: Extract the main search terms (names, topics, keywords)

4. REASONING: Brief explanation of your decision

EXAMPLES:
Query: "كتب محمد بن راشد"
Response: {"intent":"author_books","field":"author","key_terms":["محمد بن راشد"],"reasoning":"User wants books BY Mohammed bin Rashid"}

Query: "معلومات عن الشيخ زايد"
Response: {"intent":"question","field":"summary","key_terms":["الشيخ زايد"],"reasoning":"User wants information ABOUT Sheikh Zayed from book content"}

Query: "كتب عن التراث الإماراتي"
Response: {"intent":"about_topic","field":"subject","key_terms":["التراث الإماراتي"],"reasoning":"User wants books about UAE heritage topic"}

Query: "ما هو دور الشيخ زايد في التنمية"
Response: {"intent":"question","field":"summary","key_terms":["الشيخ زايد","التنمية"],"reasoning":"Specific question needs answer from summaries"}

Respond ONLY with valid JSON. No other text.`;

    const aiResponse = await callPerplexity([
      { role: 'system', content: 'You are a JSON-only response system. Return only valid JSON.' },
      { role: 'user', content: analysisPrompt }
    ], PERPLEXITY_MODEL);

    // Parse AI response
    let analysis;
    try {
      // Try to extract JSON from response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found');
      }
    } catch (parseError) {
      console.error('Failed to parse AI analysis:', aiResponse);
      // Fallback to default
      return res.json({
        intent: 'default',
        field: 'default',
        key_terms: [query],
        reasoning: 'AI analysis failed, using default',
        fallback: true
      });
    }

    res.json(analysis);
  } catch (err) {
    console.error('Query understanding error:', err);
    res.json({
      intent: 'default',
      field: 'default',
      key_terms: [req.body.query],
      reasoning: 'Error occurred, using default',
      fallback: true
    });
  }
});

/* ========= /api/chat ========= */
app.post('/api/chat', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
  }

  try {
    const body = req.body || {};
    const query = body.query || '';
    let matchedBooks = Array.isArray(body.matchedBooks) ? body.matchedBooks : [];
    const searchField = body.searchField || 'default';

    if (!query) return res.status(400).json({ error: 'Query is required' });

    // Frontend already did the filtering, so we don't filter again
    // Author filtering removed - trust frontend results

    if (!matchedBooks.length) {
      return res.json({
        answer: "لم أجد كتباً تطابق سؤالك في الكتالوج.<br>I didn't find any matching books in the catalog.",
        bookIds: []
      });
    }

    const safeBooks = matchedBooks.filter(b => b && typeof b === 'object');

    // Build field-specific data
    let fieldInstructions = '';
    let availableData = '';

    if (searchField === 'summary') {
      fieldInstructions = `
⚠️ SUMMARY SEARCH
Use ONLY: summary, contents.
FORBIDDEN: author, subject, title.
If info not present in summaries, say "المعلومات غير متوفرة / Information not available".`;
      availableData = safeBooks.map((b,i)=>{
        const summary=(b.summary||b.contents||b.content||'').toString().trim()||'No summary';
        const author=(b.author||'Unknown Author').toString().trim();
        const title=(b.title||'Untitled').toString().trim();
        const publisher=(b.publisher||'').toString().trim();
        const year=(b.year||'').toString().trim();
        const citation = `${author}. ${title}.${publisher ? ' ' + publisher : ''}${publisher && year ? ',' : ''}${year ? ' ' + year : ''}.`;
        return `[${i+1}] Citation: ${citation}\nSummary: ${summary}\n---`;}).join('\n');

    } else if (searchField === 'subject') {
      fieldInstructions = `
⚠️ SUBJECT/TOPIC SEARCH
Use ONLY: subject, title.
FORBIDDEN: author, summary.
If the user asks a question, answer it using the subjects and titles. Cite every fact with [number].`;
      availableData = safeBooks.map((b,i)=>{
        const title=(b.title||'Untitled').toString(),subject=(b.subject||'No subject').toString();
        const author=(b.author||'Unknown Author').toString().trim();
        const publisher=(b.publisher||'').toString().trim();
        const year=(b.year||'').toString().trim();
        const citation = `${author}. ${title}.${publisher ? ' ' + publisher : ''}${publisher && year ? ',' : ''}${year ? ' ' + year : ''}.`;
        return `[${i+1}] Citation: ${citation}\nSubject: ${subject}\n---`;}).join('\n');

    } else if (searchField === 'author') {
      fieldInstructions = `
⚠️ AUTHOR SEARCH
Use ONLY: author, title.
FORBIDDEN: subject, summary.`;
      availableData = safeBooks.map((b,i)=>{
        const title=(b.title||'Untitled').toString(),author=(b.author||'Unknown').toString();
        const publisher=(b.publisher||'').toString().trim();
        const year=(b.year||'').toString().trim();
        const citation = `${author}. ${title}.${publisher ? ' ' + publisher : ''}${publisher && year ? ',' : ''}${year ? ' ' + year : ''}.`;
        return `[${i+1}] Citation: ${citation}\n---`;}).join('\n');

    } else {
      availableData = safeBooks.map((b,i)=>{
        const title=(b.title||'Untitled').toString(),author=(b.author||'Unknown').toString(),
              subject=(b.subject||'').toString(),summary=(b.summary||'').toString();
        const publisher=(b.publisher||'').toString().trim();
        const year=(b.year||'').toString().trim();
        const citation = `${author}. ${title}.${publisher ? ' ' + publisher : ''}${publisher && year ? ',' : ''}${year ? ' ' + year : ''}.`;
        return `[${i+1}] Citation: ${citation}\nSubject: ${subject}\nSummary: ${summary}\n---`;}).join('\n');
    }

    const systemPrompt =
      searchField === 'summary'
        ? 'Answer using ONLY summaries/contents. Cite every fact with [number]. Books have been provided to you - answer based on them.'
        : searchField === 'subject'
        ? 'Answer questions or list books using ONLY subject and title. Cite each fact with [number]. Books have been provided to you - use them to answer.'
        : searchField === 'author'
        ? 'List books BY the author using ONLY author and title. Cite each book with [number]. Books have been provided to you - list them.'
        : 'Use only provided fields. Cite all information with [number]. Books have been provided to you - answer based on them.';

    const userPrompt = `You are a library assistant. Follow the field rules STRICTLY.

${fieldInstructions}

RULES:
1) ONLY use allowed fields above.
2) NEVER use forbidden fields.
3) Do not invent info.
4) When providing information, ALWAYS cite your source using the reference numbers [1], [2], [3], etc. from the data above.
5) Place citation numbers [1], [2], [3] immediately after the information from that source.
6) Answer in the same language as the query.
7) NEVER say "I didn't find any books" or "لم أجد كتباً" - you have been provided with books data, so answer based on that data.
8) Every fact or piece of information MUST have a citation number [X] after it.

USER QUERY: "${query}"
SEARCH FIELD: ${searchField}

AVAILABLE DATA (${safeBooks.length} books):
${availableData}

Answer now using ONLY the allowed fields above.`;

    const answer = await callPerplexity(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      PERPLEXITY_MODEL
    );

    // best-effort ID extraction
    const ids = [];
    const m = answer.match(/\b(\d+)\b/g);
    if (m) ids.push(...m.slice(0,10).map(Number));

    res.json({ answer, bookIds: ids });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
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
      id: b?.id ?? idx, title: b?.title || 'Untitled',
      author: b?.author || 'Unknown', summary: b?.summary || ''
    }));

    const prompt = `You are analyzing book summaries for a library search.

User searched for: "${query}"

BOOKS WITH SUMMARIES:
${JSON.stringify(booksData,null,2)}

Task:
1) Read each SUMMARY.
2) Rank by how well the SUMMARY matches the query.
3) Return the top 20 IDs.

IMPORTANT: Only use provided summaries.

Format:
EXPLANATION: <brief, same language as query>
BOOK_IDS: <comma separated IDs>`;

    const response = await callPerplexity(
      [{ role: 'system', content: 'Rank only by provided summaries.' },
       { role: 'user', content: prompt }],
      PERPLEXITY_MODEL
    );

    const explanation = (response.match(/EXPLANATION:\s*(.+?)(?=BOOK_IDS:|$)/s)?.[1] || '').trim();
    const bookIds = (response.match(/BOOK_IDS:\s*([\d,\s]+)/)?.[1] || '')
      .split(',').map(s=>parseInt(s.trim(),10)).filter(n=>!Number.isNaN(n));

    const rankedBooks = bookIds.map(id => preFilteredBooks.find(b=>b && b.id===id)).filter(Boolean);
    res.json({ rankedBooks, explanation });
  } catch (err) {
    console.error('Enhance search error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

/* ========= Health ========= */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    codeVersion: CODE_VERSION,
    perplexityConfigured: !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: PERPLEXITY_MODEL,
    features: 'Strict field separation • Exact 2-token author preference • Safe availableData',
  });
});

/* ========= Error middleware ========= */
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`🚀 ECSSR AI Backend http://localhost:${PORT}`);
  console.log(`🔖 Version: ${CODE_VERSION}`);
});
