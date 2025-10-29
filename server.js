// backend/server.js
// ECSSR AI Assistant — v4.0 - OpenAI Integration
// - Switched from Perplexity to OpenAI for better instruction following
// - Improved citation handling and UAE source compliance
// - Better Arabic language support

const CODE_VERSION = "ecssr-backend-v4.0-openai";

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// OpenAI Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-YOUR-API-KEY-HERE';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o'; // or 'gpt-4-turbo' or 'gpt-3.5-turbo'

/* ========= AUTHORIZED UAE .ae SOURCES ONLY ========= */
const AUTHORIZED_UAE_SOURCES = {
  'government.ae': { name: 'UAE Government', category: 'official' },
  'wam.ae': { name: 'Emirates News Agency (WAM)', category: 'news' },
  'mohesr.gov.ae': { name: 'Ministry of Higher Education', category: 'official' },
  'mofacdn.gov.ae': { name: 'Ministry of Foreign Affairs', category: 'official' },
  'dsc.gov.ae': { name: 'General Authority of Islamic Affairs', category: 'official' },
  'fcsa.gov.ae': { name: 'Federal Centre for Statistics', category: 'official' },
  'shaikh.ae': { name: 'Official Emirati Sources', category: 'official' }
};

function isAuthorizedUAESource(text) {
  // Check if text mentions any non-.ae external source
  const forbiddenPatterns = [
    /wikipedia/i, /bbc/i, /reuters/i, /aljazeera/i, /cnn/i,
    /google\.com/i, /youtube\.com/i, /facebook\.com/i,
    /\.uk\b/, /\.us\b/, /\.com\b/, /\.org\b/, /\.io\b/, /\.co\b/
  ];
  
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(text)) {
      return false; // Not authorized - uses non-.ae source
    }
  }
  
  // If mentions external source, must be .ae
  if (/according to|per|reports?|states?|from|website|source/i.test(text)) {
    if (!/\.ae(\s|$|\/)/i.test(text)) {
      return null; // Mentions external source but not .ae
    }
  }
  
  return true; // OK - either only library or .ae sources
}

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
    max_tokens: options.max_tokens || 1000,
  };

  // Add response_format for JSON mode if requested
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

    // For 3-token searches: strict exact matching only (skip flexible matching)
    if (qTokens.length === 3) {
      if (isExact && aLen === 3) out.push(b);
      continue;
    }

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

    const aiResponse = await callOpenAI(
      [
        { role: 'system', content: 'You are a library search query analyzer. Always respond with valid JSON only.' },
        { role: 'user', content: analysisPrompt }
      ],
      OPENAI_MODEL,
      { response_format: 'json', temperature: 0.1 }
    );

    let parsed;
    try {
      parsed = JSON.parse(aiResponse);
    } catch (e) {
      console.error('JSON parse error:', e);
      return res.status(500).json({ error: 'Invalid AI response format' });
    }

    res.json({
      intent: parsed.intent || 'question',
      field: parsed.field || 'default',
      keyTerms: parsed.key_terms || [],
      reasoning: parsed.reasoning || ''
    });
  } catch (err) {
    console.error('Understand query error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
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

    if (safeBooks.length === 0) {
      return res.json({ 
        answer: 'لا توجد كتب متاحة للإجابة على سؤالك.\nNo books available to answer your question.', 
        bookIds: [] 
      });
    }

    let fieldInstructions = '', availableData = '';

    if (searchField === 'summary') {
      fieldInstructions = `
⚠️ SUMMARY SEARCH - STRICT FIELD LIMITS
ALLOWED: summary, title, author for citation only.
FORBIDDEN: subject field.`;
      availableData = safeBooks.map((b,i)=>{
        const title=(b.title||'Untitled').toString(),author=(b.author||'Unknown').toString(),
              summary=(b.summary||'').toString();
        const publisher=(b.publisher||'').toString().trim();
        const year=(b.year||'').toString().trim();
        const citation = `${author}. ${title}.${publisher ? ' ' + publisher : ''}${publisher && year ? ',' : ''}${year ? ' ' + year : ''}.`;
        return `[${i+1}] Citation: ${citation}\nSummary: ${summary}\n---`;}).join('\n');

    } else if (searchField === 'subject') {
      fieldInstructions = `
⚠️ SUBJECT SEARCH
ALLOWED: subject, title, author for citation.
FORBIDDEN: summary.`;
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
        ? `You are a library assistant. Answer using ONLY summaries/contents from library books. Cite every fact with [number]. 
Books have been provided to you - answer based on them.
EXTERNAL SOURCES: ONLY official UAE .ae sites are permitted (government.ae, wam.ae, mohesr.gov.ae, etc). NO Wikipedia, BBC, Reuters, or international sites.`
        : searchField === 'subject'
        ? `You are a library assistant. Answer questions or list books using ONLY subject and title from library. Cite each fact with [number]. 
Books have been provided to you - use them to answer.
EXTERNAL SOURCES: ONLY official UAE .ae sites permitted. NO international sources.`
        : searchField === 'author'
        ? `You are a library assistant. List books BY the author using ONLY author and title from library. Cite each book with [number]. 
Books have been provided to you - list them.
EXTERNAL SOURCES: If biographical info needed, ONLY UAE .ae sites permitted.`
        : `You are a library assistant. Use only provided fields from library books. Cite all information with [number]. 
Books have been provided to you - answer based on them.
EXTERNAL SOURCES: ONLY official UAE .ae sites (government.ae, wam.ae, mohesr.gov.ae, fcsa.gov.ae, dsc.gov.ae, shaikh.ae) permitted. NO Wikipedia, BBC, Reuters, international sources.`;

    const userPrompt = `You are a library assistant. Follow the field rules STRICTLY.

${fieldInstructions}

CRITICAL RULES:
1) ONLY use allowed fields above.
2) NEVER use forbidden fields.
3) Do not invent info.
4) When providing information, ALWAYS cite your source using the reference numbers [1], [2], [3], etc. from the data above.
5) Place citation numbers [1], [2], [3] immediately after the information from that source.
6) Answer in the same language as the query.
7) NEVER say "I didn't find any books" or "لم أجد كتباً" - you have been provided with books data, so answer based on that data.
8) Every fact or piece of information MUST have a citation number [X] after it.

⚠️ EXTERNAL SOURCES - STRICT UAE REQUIREMENT:
If you use ANY external source information, it MUST be ONLY from official UAE (.ae) sites:
- government.ae
- wam.ae (Emirates News Agency)
- mohesr.gov.ae (Higher Education)
- mofacdn.gov.ae (Foreign Affairs)
- fcsa.gov.ae (Statistics)
- dsc.gov.ae (Islamic Affairs)
- shaikh.ae (Official Historical)

FORBIDDEN EXTERNAL SOURCES:
- Wikipedia
- BBC
- Reuters  
- Al Jazeera
- Google Scholar
- Any international sites
- Any non-.ae domains

If you cite external sources, provide the complete URL ending in .ae

USER QUERY: "${query}"
SEARCH FIELD: ${searchField}

AVAILABLE DATA (${safeBooks.length} books):
${availableData}

Answer now using ONLY the allowed fields above and ONLY official UAE .ae external sources if needed.`;

    const answer = await callOpenAI(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      OPENAI_MODEL,
      { temperature: 0.1, max_tokens: 1000 }
    );

    // best-effort ID extraction
    const ids = [];
    const m = answer.match(/\[(\d+)\]/g);
    if (m) {
      const uniqueIds = new Set();
      m.forEach(match => {
        const num = parseInt(match.replace(/[\[\]]/g, ''));
        if (num > 0 && num <= safeBooks.length) {
          uniqueIds.add(num);
        }
      });
      ids.push(...Array.from(uniqueIds));
    }

    // Check for UAE .ae source compliance
    const uaeCompliance = isAuthorizedUAESource(answer);

    res.json({ 
      answer, 
      bookIds: ids,
      sourceCompliance: {
        uaeSourcesOnly: uaeCompliance === true,
        hasUnauthorizedSources: uaeCompliance === false,
        warning: uaeCompliance === false ? 'Response contains non-.ae external sources (not permitted)' : null
      }
    });
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

    const response = await callOpenAI(
      [
        { role: 'system', content: 'You are a book ranking assistant. Rank only by provided summaries. Follow the exact output format requested.' },
        { role: 'user', content: prompt }
      ],
      OPENAI_MODEL,
      { temperature: 0.1 }
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

/* ========= /api/authorized-uae-sources ========= */
app.get('/api/authorized-uae-sources', (req, res) => {
  res.json({
    message: 'ONLY these official UAE (.ae) sources are permitted for external references',
    authorizedSources: AUTHORIZED_UAE_SOURCES,
    forbiddenSources: ['Wikipedia', 'BBC', 'Reuters', 'Al Jazeera', 'Google Scholar', 'Any non-.ae domain'],
    rule: 'All external sources MUST be official UAE .ae domains'
  });
});

/* ========= Health ========= */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    codeVersion: CODE_VERSION,
    aiProvider: 'OpenAI',
    openaiConfigured: !!OPENAI_API_KEY && OPENAI_API_KEY !== 'sk-YOUR-API-KEY-HERE',
    modelVersion: OPENAI_MODEL,
    features: 'Strict field separation • Exact 2-token author preference • Safe availableData • OpenAI GPT',
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
  console.log(`🤖 AI Provider: OpenAI (${OPENAI_MODEL})`);
});
