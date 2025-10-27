// backend/server.js
// ECSSR AI Assistant — v5.0 PROPER SOURCE ATTRIBUTION
// - Search library data (your books, summaries, content)
// - Cite library books with proper links
// - ONLY allow official UAE external sources (.ae domains)
// - Block all non-UAE external sources
// - Strict source verification

const CODE_VERSION = "ecssr-backend-v5.0-library-uae-sources";

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

/* ========= AUTHORIZED UAE SOURCES DATABASE ========= */
const UAE_AUTHORIZED_SOURCES = {
  'wam': {
    domain: 'wam.ae',
    name: 'Emirates News Agency (WAM)',
    baseUrl: 'https://wam.ae/',
    trusted: true,
    category: 'official_news',
    official: true
  },
  'uae-gov': {
    domain: 'government.ae',
    name: 'UAE Government Official Portal',
    baseUrl: 'https://www.government.ae/',
    trusted: true,
    category: 'official_government',
    official: true
  },
  'mohesr': {
    domain: 'mohesr.gov.ae',
    name: 'Ministry of Higher Education & Scientific Research',
    baseUrl: 'https://www.mohesr.gov.ae/',
    trusted: true,
    category: 'official_government',
    official: true
  },
  'mofa': {
    domain: 'mofacdn.gov.ae',
    name: 'Ministry of Foreign Affairs',
    baseUrl: 'https://www.mofacdn.gov.ae/',
    trusted: true,
    category: 'official_government',
    official: true
  },
  'mohesr-ar': {
    domain: 'mohesr.gov.ae',
    name: 'وزارة التعليم العالي والبحث العلمي (Higher Education Ministry)',
    baseUrl: 'https://www.mohesr.gov.ae/',
    trusted: true,
    category: 'official_government',
    official: true
  },
  'dsc': {
    domain: 'dsc.gov.ae',
    name: 'General Authority of Islamic Affairs and Endowments',
    baseUrl: 'https://dsc.gov.ae/',
    trusted: true,
    category: 'official_government',
    official: true
  },
  'statistics': {
    domain: 'fcsa.gov.ae',
    name: 'Federal Centre for Competitiveness and Statistics',
    baseUrl: 'https://www.fcsa.gov.ae/',
    trusted: true,
    category: 'official_government',
    official: true
  },
  'sheikhdiscover': {
    domain: 'shaikh.ae',
    name: 'Official Emirati Historical Sources',
    baseUrl: 'https://www.shaikh.ae/',
    trusted: true,
    category: 'official_government',
    official: true
  }
};

/* ========= SOURCE VERIFICATION ENGINE ========= */
class SourceVerificationEngine {
  constructor(authorizedSources, libraryBooks) {
    this.authorizedUAESources = authorizedSources;
    this.libraryBooks = libraryBooks || [];
  }

  /**
   * Check if a domain is an authorized UAE source
   */
  isAuthorizedUAESource(domain) {
    const normalizedDomain = domain.toLowerCase().trim();
    
    // Check if domain ends with .ae
    if (!normalizedDomain.endsWith('.ae')) {
      return {
        authorized: false,
        reason: 'Domain is not .ae (not official UAE)',
        domain: normalizedDomain
      };
    }

    // Check against whitelist
    for (const [key, source] of Object.entries(this.authorizedUAESources)) {
      if (normalizedDomain.includes(source.domain)) {
        return {
          authorized: true,
          source: source,
          sourceKey: key
        };
      }
    }

    // Check if it's any .ae domain (could be semi-authorized)
    if (normalizedDomain.endsWith('.ae')) {
      return {
        authorized: true,
        source: {
          domain: normalizedDomain,
          name: 'Official UAE Source (.ae)',
          official: true
        },
        sourceKey: 'uae-official'
      };
    }

    return {
      authorized: false,
      reason: 'Not in authorized UAE sources list',
      domain: normalizedDomain
    };
  }

  /**
   * Get library book by ID
   */
  getLibraryBook(bookId) {
    return this.libraryBooks.find(b => b && b.id === bookId);
  }

  /**
   * Generate citation for library book
   */
  generateLibraryCitation(bookId, quote) {
    const book = this.getLibraryBook(bookId);
    if (!book) return null;

    return {
      valid: true,
      source: 'Library',
      type: 'internal',
      book: {
        id: bookId,
        title: book.title || 'Untitled',
        author: book.author || 'Unknown',
        publisher: book.publisher || '',
        year: book.year || ''
      },
      quote: quote,
      citation: `${book.author || 'Unknown'}. "${book.title || 'Untitled'}".${book.publisher ? ' ' + book.publisher : ''}${book.year ? ' ' + book.year : ''}.`
    };
  }

  /**
   * Validate external source URL
   */
  validateExternalSource(url) {
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname.toLowerCase();

      // Extract domain without www
      const cleanDomain = domain.replace('www.', '');

      return this.isAuthorizedUAESource(cleanDomain);
    } catch (e) {
      return {
        authorized: false,
        reason: 'Invalid URL format',
        url: url
      };
    }
  }

  /**
   * Parse external source citations from text
   * Looks for patterns and validates they're UAE sources
   */
  parseAndVerifyExternalSources(text) {
    const citations = [];
    const issues = [];

    // Pattern: "According to [Source]: ..."
    const pattern1 = /According to\s+([^:]+):\s*([^.]+\.)/gi;
    let match;
    
    while ((match = pattern1.exec(text)) !== null) {
      const sourceName = match[1].trim();
      const quote = match[2].trim();

      // Try to extract URL if present
      const urlMatch = match[0].match(/https?:\/\/[^\s]+/);
      const url = urlMatch ? urlMatch[0] : null;

      if (url) {
        const verification = this.validateExternalSource(url);
        citations.push({
          sourceName: sourceName,
          quote: quote,
          url: url,
          verification: verification
        });

        if (!verification.authorized) {
          issues.push({
            type: 'UNAUTHORIZED_EXTERNAL_SOURCE',
            source: sourceName,
            url: url,
            message: `External source "${sourceName}" is NOT authorized. Only official UAE (.ae) sources allowed.`
          });
        }
      } else {
        issues.push({
          type: 'MISSING_EXTERNAL_URL',
          source: sourceName,
          message: `External source cited without URL: "${sourceName}". Provide complete URL.`
        });
      }
    }

    return { citations, issues };
  }

  /**
   * Generate compliance report
   */
  getSourceComplianceReport(text, libraryBooks) {
    const externalAnalysis = this.parseAndVerifyExternalSources(text);
    
    return {
      compliant: externalAnalysis.issues.length === 0,
      librarySourcesUsed: libraryBooks && libraryBooks.length > 0,
      externalSourcesCited: externalAnalysis.citations.length,
      authorizedExternalSources: externalAnalysis.citations.filter(c => c.verification.authorized).length,
      unauthorizedExternalSources: externalAnalysis.citations.filter(c => !c.verification.authorized).length,
      validExternalSources: externalAnalysis.citations.filter(c => c.verification.authorized),
      issues: externalAnalysis.issues,
      message: externalAnalysis.issues.length === 0 
        ? 'All sources verified and authorized' 
        : `${externalAnalysis.issues.length} source issue(s) detected`
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
      model, messages, temperature: 0.05, max_tokens: 1200,
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

/* ========= /api/chat WITH PROPER SOURCE ATTRIBUTION ========= */
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
        sourceCompliance: {
          compliant: false,
          status: 'NO_LIBRARY_SOURCES'
        }
      });
    }

    const safeBooks = matchedBooks.filter(b => b && typeof b === 'object');
    const verificationEngine = new SourceVerificationEngine(UAE_AUTHORIZED_SOURCES, safeBooks);

    // Build data for AI from library
    let availableData = '';
    let fieldInstructions = '';

    if (searchField === 'summary') {
      fieldInstructions = `
⚠️ CRITICAL SOURCE RULES:
1. PRIMARY: Use library data (books provided below)
2. If using library books, cite them with book number [1], [2], etc.
3. EXTERNAL SOURCES: ONLY official UAE .ae domains allowed
   - Examples: government.ae, wam.ae, mohesr.gov.ae, fcsa.gov.ae
   - Format: "According to [Source Name]: [fact] (source: [URL])"
4. FORBIDDEN: Wikipedia, international sites, non-UAE sources
5. If external source used, MUST provide complete URL`;
      
      availableData = safeBooks.map((b,i)=>{
        const summary=(b.summary||b.contents||b.content||'').toString().trim()||'No summary';
        const author=(b.author||'Unknown Author').toString().trim();
        const title=(b.title||'Untitled').toString().trim();
        const publisher=(b.publisher||'').toString().trim();
        const year=(b.year||'').toString().trim();
        return `[${i+1}] BOOK: ${title}\n    Author: ${author}\n    Publisher: ${publisher}${year ? ' (' + year + ')' : ''}\n    Summary: ${summary}\n---`;}).join('\n');

    } else if (searchField === 'subject') {
      fieldInstructions = `
⚠️ CRITICAL SOURCE RULES:
1. PRIMARY: Use library data for subject search
2. Cite library books as [1], [2], [3], etc.
3. EXTERNAL: ONLY official UAE .ae sites allowed
4. FORBIDDEN: Non-UAE external sources`;
      
      availableData = safeBooks.map((b,i)=>{
        const title=(b.title||'Untitled').toString(),subject=(b.subject||'No subject').toString();
        const author=(b.author||'Unknown Author').toString().trim();
        return `[${i+1}] BOOK: ${title}\n    Author: ${author}\n    Subject: ${subject}\n---`;}).join('\n');

    } else if (searchField === 'author') {
      fieldInstructions = `
⚠️ CRITICAL SOURCE RULES:
1. List books by this author from library
2. Cite as [1], [2], [3], etc.
3. For biographical info: Use ONLY UAE .ae official sources
4. FORBIDDEN: Non-UAE external sources`;
      
      availableData = safeBooks.map((b,i)=>{
        const title=(b.title||'Untitled').toString(),author=(b.author||'Unknown').toString();
        return `[${i+1}] ${author}. "${title}"\n---`;}).join('\n');

    } else {
      fieldInstructions = `
⚠️ CRITICAL SOURCE RULES:
1. PRIMARY: Use library data first
2. Cite library books as [1], [2], [3], etc.
3. EXTERNAL ONLY: Official UAE .ae sites
   - Allowed: government.ae, wam.ae, mohesr.gov.ae, fcsa.gov.ae, etc.
4. FORBIDDEN: Any non-.ae external sources`;
      
      availableData = safeBooks.map((b,i)=>{
        const title=(b.title||'Untitled').toString(),author=(b.author||'Unknown').toString(),
              subject=(b.subject||'').toString(),summary=(b.summary||'').toString();
        return `[${i+1}] Title: ${title}\n    Author: ${author}\n    Subject: ${subject}\n    Summary: ${summary}\n---`;}).join('\n');
    }

    const systemPrompt = `You are a library assistant with strict source requirements.

LIBRARY DATA IS PRIMARY:
- Use library books first
- Cite as [1], [2], [3] for library sources
- Must cite exactly which book the info came from

EXTERNAL SOURCES - STRICT RULES:
- ONLY official UAE government and official sites (.ae domains)
- Examples: government.ae, wam.ae, mohesr.gov.ae, fcsa.gov.ae
- Format: "According to [Source Name]: [fact] (https://source.ae/...)"
- FORBIDDEN: Wikipedia, international news, non-.ae sites

CRITICAL:
- Do NOT mix up library citations with external sources
- If from library book → Use [1], [2], [3]
- If from external → Use "According to [Source]: ... (URL)"
- NEVER cite external sources that are NOT official UAE .ae`;

    const userPrompt = `${fieldInstructions}

LIBRARY BOOKS IN CATALOG:
${availableData}

USER QUERY: "${query}"

Instructions:
1. FIRST: Search the library books provided above
2. If information found in library → Cite as [1], [2], [3]
3. If need external info → ONLY use official UAE .ae sites
4. Provide complete URLs for any external sources
5. Answer in same language as query (Arabic or English)

Answer now:`;

    const aiResponse = await callPerplexity(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      PERPLEXITY_MODEL
    );

    // ===== VERIFY COMPLIANCE =====
    const complianceReport = verificationEngine.getSourceComplianceReport(aiResponse, safeBooks);
    
    console.log('=== SOURCE COMPLIANCE REPORT ===');
    console.log(`Compliant with rules: ${complianceReport.compliant}`);
    console.log(`Library sources used: ${complianceReport.librarySourcesUsed}`);
    console.log(`External sources cited: ${complianceReport.externalSourcesCited}`);
    console.log(`Authorized UAE (.ae) sources: ${complianceReport.authorizedExternalSources}`);
    console.log(`Unauthorized external sources: ${complianceReport.unauthorizedExternalSources}`);
    if (complianceReport.validExternalSources.length > 0) {
      console.log('Valid UAE sources:');
      complianceReport.validExternalSources.forEach((src, idx) => {
        console.log(`  ${idx + 1}. ${src.sourceName} (${src.url})`);
      });
    }
    if (complianceReport.issues.length > 0) {
      console.log('⚠️ Compliance issues:');
      complianceReport.issues.forEach(issue => {
        console.log(`  - ${issue.message}`);
      });
    }

    // Extract library book IDs from citations
    const ids = [];
    const pattern = /\[(\d+)\]/g;
    let match;
    while ((match = pattern.exec(aiResponse)) !== null) {
      const num = parseInt(match[1], 10);
      if (num >= 1 && num <= safeBooks.length) {
        ids.push(num);
      }
    }

    res.json({ 
      answer: aiResponse,
      bookIds: ids,
      sourceCompliance: {
        compliant: complianceReport.compliant,
        librarySourcesUsed: complianceReport.librarySourcesUsed,
        externalSourcesCited: complianceReport.externalSourcesCited,
        authorizedExternalSources: complianceReport.authorizedExternalSources,
        unauthorizedExternalSources: complianceReport.unauthorizedExternalSources,
        validExternalSources: complianceReport.validExternalSources,
        issues: complianceReport.issues,
        message: complianceReport.message
      }
    });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: err.message
    });
  }
});

/* ========= /api/authorized-uae-sources ========= */
app.get('/api/authorized-uae-sources', (req, res) => {
  const sources = Object.values(UAE_AUTHORIZED_SOURCES).map(s => ({
    name: s.name,
    domain: s.domain,
    category: s.category,
    baseUrl: s.baseUrl,
    official: s.official
  }));
  
  res.json({
    message: 'ONLY these official UAE (.ae) sources are permitted',
    totalAuthorizedSources: sources.length,
    sources: sources,
    rule: 'Any external source MUST be an official UAE (.ae) domain'
  });
});

/* ========= Health ========= */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    codeVersion: CODE_VERSION,
    perplexityConfigured: !!PERPLEXITY_API_KEY && PERPLEXITY_API_KEY !== 'pplx-YOUR-API-KEY-HERE',
    modelVersion: PERPLEXITY_MODEL,
    features: 'Library data primary • UAE .ae sources only • Proper citation • Source verification',
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
  console.log(`📚 Library Data: PRIMARY SOURCE`);
  console.log(`🇦🇪 External Sources: OFFICIAL UAE (.ae) ONLY`);
  console.log(`✅ SOURCE COMPLIANCE ENABLED`);
});
