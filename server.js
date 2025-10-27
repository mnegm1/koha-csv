// backend/server.js
// ECSSR AI Assistant — v4.0 ENHANCED
// - STRICT citation validation and enforcement
// - Source data verification
// - Citation post-processing and cleanup
// - Disallowed external references detection
// - Rate limiting + robust guards

const CODE_VERSION = "ecssr-backend-v4.0-strict-citations";

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

/* ========= Citation Validation Engine ========= */
class CitationValidator {
  constructor(sourceBooks) {
    this.sourceBooks = sourceBooks || [];
    this.validCitationRange = this.sourceBooks.length;
  }

  /**
   * Extract all citation references [1], [2], etc. from text
   */
  extractCitations(text) {
    const pattern = /\[(\d+)\]/g;
    const citations = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const num = parseInt(match[1], 10);
      citations.push({
        original: match[0],
        number: num,
        position: match.index
      });
    }
    return citations;
  }

  /**
   * Check if a citation number is valid (within source book range)
   */
  isValidCitationNumber(num) {
    return num >= 1 && num <= this.validCitationRange;
  }

  /**
   * Get all invalid citations from text
   */
  findInvalidCitations(text) {
    const citations = this.extractCitations(text);
    return citations.filter(c => !this.isValidCitationNumber(c.number));
  }

  /**
   * Remove invalid citations and replace with plaintext
   */
  removeInvalidCitations(text) {
    const citations = this.extractCitations(text);
    const invalidCitations = citations.filter(c => !this.isValidCitationNumber(c.number));
    
    let cleanedText = text;
    // Sort in reverse order to maintain position accuracy
    invalidCitations.sort((a, b) => b.position - a.position);
    
    for (const citation of invalidCitations) {
      cleanedText = cleanedText.replace(citation.original, '');
    }
    
    return cleanedText.replace(/\s+/g, ' ').trim();
  }

  /**
   * Verify that every citation number has a corresponding source
   */
  validateAllCitations(text) {
    const citations = this.extractCitations(text);
    const issues = [];
    
    for (const citation of citations) {
      if (!this.isValidCitationNumber(citation.number)) {
        issues.push({
          type: 'INVALID_CITATION_NUMBER',
          citation: citation.number,
          validRange: `1-${this.validCitationRange}`,
          message: `Citation [${citation.number}] exceeds available sources (max: ${this.validCitationRange})`
        });
      }
    }
    
    return {
      isValid: issues.length === 0,
      totalCitationsFound: citations.length,
      validCitationsCount: citations.filter(c => this.isValidCitationNumber(c.number)).length,
      issues: issues
    };
  }

  /**
   * Create detailed validation report
   */
  getValidationReport(text) {
    const validation = this.validateAllCitations(text);
    const invalidCitations = this.findInvalidCitations(text);
    
    return {
      validation: validation,
      sourceCount: this.validCitationRange,
      invalidCitationsFound: invalidCitations.length,
      invalidCitationNumbers: invalidCitations.map(c => c.number),
      cleanedText: validation.isValid ? text : this.removeInvalidCitations(text),
      hasExternalReferences: invalidCitations.length > 0
    };
  }
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
  for (const qt of qTokens) if (!aTokens.includes(qt)) return false;
  for (const at of aTokens) if (!qTokens.includes(at)) return false;
  return true;
}

/* ========= Author filter with "exact 2-token preferred" ========= */
function filterAuthorBooks(query, books) {
  const qTokens = tokenizeName(query);
  if (qTokens.length === 0) return [];
  const list = (Array.isArray(books) ? books : []).filter(b => b && typeof b === 'object');

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

    if (qTokens.length === 3) {
      if (isExact && aLen === 3) out.push(b);
      continue;
    }

    if (qTokens.length === 2 && exactTwoTokenExists) {
      if (isExact && aLen === 2) out.push(b);
      continue;
    }

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

    let analysis;
    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found');
      }
    } catch (parseError) {
      console.error('Failed to parse AI analysis:', aiResponse);
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

/* ========= /api/chat WITH STRICT CITATION VALIDATION ========= */
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

    if (!matchedBooks.length) {
      return res.json({
        answer: "لم أجد كتباً تطابق سؤالك في الكتالوج.<br>I didn't find any matching books in the catalog.",
        bookIds: [],
        validationReport: {
          citationValidation: 'NO_SOURCES_PROVIDED',
          externalReferencesFound: false
        }
      });
    }

    const safeBooks = matchedBooks.filter(b => b && typeof b === 'object');
    
    // Initialize citation validator with the number of source books
    const citationValidator = new CitationValidator(safeBooks);

    // Build field-specific data
    let fieldInstructions = '';
    let availableData = '';

    if (searchField === 'summary') {
      fieldInstructions = `
⚠️ CRITICAL CITATION RULES:
- You MUST cite EVERY fact with [1], [2], [3], etc.
- Citation numbers MUST be between [1] and [${safeBooks.length}] ONLY
- FORBIDDEN: Any citation outside this range
- FORBIDDEN: References to external sources, Wikipedia, or internet
- If information is not in the provided summaries, say "المعلومات غير متوفرة / Information not available"
- NEVER invent or assume information`;
      
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
⚠️ CRITICAL CITATION RULES:
- You MUST cite EVERY fact with [1], [2], [3], etc.
- Citation numbers MUST be between [1] and [${safeBooks.length}] ONLY
- FORBIDDEN: Any citation outside this range
- FORBIDDEN: References to external sources, Wikipedia, or internet
- Use ONLY subject and title fields
- If the user asks a question, answer using the subjects and titles`;
      
      availableData = safeBooks.map((b,i)=>{
        const title=(b.title||'Untitled').toString(),subject=(b.subject||'No subject').toString();
        const author=(b.author||'Unknown Author').toString().trim();
        const publisher=(b.publisher||'').toString().trim();
        const year=(b.year||'').toString().trim();
        const citation = `${author}. ${title}.${publisher ? ' ' + publisher : ''}${publisher && year ? ',' : ''}${year ? ' ' + year : ''}.`;
        return `[${i+1}] Citation: ${citation}\nSubject: ${subject}\n---`;}).join('\n');

    } else if (searchField === 'author') {
      fieldInstructions = `
⚠️ CRITICAL CITATION RULES:
- You MUST cite EVERY book with [1], [2], [3], etc.
- Citation numbers MUST be between [1] and [${safeBooks.length}] ONLY
- FORBIDDEN: Any citation outside this range
- FORBIDDEN: References to external sources or additional information
- Use ONLY author and title fields`;
      
      availableData = safeBooks.map((b,i)=>{
        const title=(b.title||'Untitled').toString(),author=(b.author||'Unknown').toString();
        const publisher=(b.publisher||'').toString().trim();
        const year=(b.year||'').toString().trim();
        const citation = `${author}. ${title}.${publisher ? ' ' + publisher : ''}${publisher && year ? ',' : ''}${year ? ' ' + year : ''}.`;
        return `[${i+1}] Citation: ${citation}\n---`;}).join('\n');

    } else {
      fieldInstructions = `
⚠️ CRITICAL CITATION RULES:
- You MUST cite EVERY fact with [1], [2], [3], etc.
- Citation numbers MUST be between [1] and [${safeBooks.length}] ONLY
- FORBIDDEN: Any citation outside this range
- FORBIDDEN: References to external sources, Wikipedia, or internet
- Use only provided book data`;
      
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
        ? 'You are a strict library assistant. Answer using ONLY summaries/contents. Cite every fact with [number]. FORBIDDEN: External sources.'
        : searchField === 'subject'
        ? 'You are a strict library assistant. Answer using ONLY subject and title. Cite each fact with [number]. FORBIDDEN: External sources.'
        : searchField === 'author'
        ? 'You are a strict library assistant. List books BY the author using ONLY author and title. Cite each book with [number]. FORBIDDEN: External sources.'
        : 'You are a strict library assistant. Use only provided fields. Cite all information with [number]. FORBIDDEN: External sources.';

    const userPrompt = `${fieldInstructions}

CRITICAL RULES:
1) ONLY cite sources from the AVAILABLE DATA below [1-${safeBooks.length}]
2) NEVER reference external websites, Wikipedia, internet sources, or any source not in AVAILABLE DATA
3) NEVER use citations like [100] or any number outside the provided range
4) Do not invent information
5) When providing information, ALWAYS cite your source using [1], [2], [3], etc.
6) Place citation numbers [X] immediately after the information from that source
7) Answer in the same language as the query
8) Every fact or piece of information MUST have a citation number [X]

USER QUERY: "${query}"
SEARCH FIELD: ${searchField}

AVAILABLE DATA (${safeBooks.length} books ONLY):
${availableData}

Answer now. REMEMBER: Only use citations [1] through [${safeBooks.length}].`;

    const aiResponse = await callPerplexity(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      PERPLEXITY_MODEL
    );

    // ===== STRICT CITATION VALIDATION =====
    const validationReport = citationValidator.getValidationReport(aiResponse);
    
    console.log('=== CITATION VALIDATION REPORT ===');
    console.log(`Total sources available: ${validationReport.sourceCount}`);
    console.log(`Citations found in response: ${validationReport.validation.totalCitationsFound}`);
    console.log(`Valid citations: ${validationReport.validation.validCitationsCount}`);
    console.log(`Invalid citations: ${validationReport.invalidCitationsFound}`);
    if (validationReport.invalidCitationNumbers.length > 0) {
      console.log(`Invalid citation numbers detected: ${validationReport.invalidCitationNumbers.join(', ')}`);
    }
    console.log(`Has external references: ${validationReport.hasExternalReferences}`);
    if (validationReport.validation.issues.length > 0) {
      console.log('Issues found:');
      validationReport.validation.issues.forEach(issue => {
        console.log(`  - ${issue.message}`);
      });
    }

    // Use cleaned text if there are invalid citations
    const finalAnswer = validationReport.hasExternalReferences 
      ? validationReport.cleanedText 
      : aiResponse;

    // Extract valid book IDs from citations
    const validCitations = validationReport.validation.validCitationsCount > 0 
      ? validationReport.validation.validCitationsCount 
      : 0;
    const ids = [];
    const pattern = /\[(\d+)\]/g;
    let match;
    while ((match = pattern.exec(finalAnswer)) !== null) {
      const num = parseInt(match[1], 10);
      if (num >= 1 && num <= safeBooks.length) {
        ids.push(num);
      }
    }

    res.json({ 
      answer: finalAnswer,
      bookIds: ids,
      validationReport: {
        citationsFound: validationReport.validation.totalCitationsFound,
        validCitations: validationReport.validation.validCitationsCount,
        invalidCitationsRemoved: validationReport.invalidCitationsFound,
        externalReferencesDetected: validationReport.hasExternalReferences,
        validationIssues: validationReport.validation.issues,
        sourceCount: validationReport.sourceCount
      }
    });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: err.message,
      validationReport: {
        status: 'ERROR',
        message: 'Citation validation could not be completed'
      }
    });
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

IMPORTANT: Only use provided summaries. Do not reference external sources.

Format:
EXPLANATION: <brief, same language as query>
BOOK_IDS: <comma separated IDs>`;

    const response = await callPerplexity(
      [{ role: 'system', content: 'Rank only by provided summaries. Do not reference external sources.' },
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
    features: 'STRICT citation validation • Source enforcement • External reference detection • Invalid citation removal',
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
  console.log(`✅ STRICT CITATION VALIDATION ENABLED`);
});
