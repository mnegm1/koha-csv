// backend/server.js
// ECSSR AI Assistant — v11.0 - Web Search with Direct Links
// - Library books cited as [1][2][3]
// - UAE websites with REAL links to actual articles
// - Maximum credibility and verifiability

const CODE_VERSION = "ecssr-backend-v11.0-web-search-links";

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-YOUR-API-KEY-HERE';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

// Perplexity API for web search (optional but recommended)
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

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

/* ========= Perplexity with citations ========= */
async function searchWithPerplexity(query) {
  if (!PERPLEXITY_API_KEY) return null;
  
  try {
    const isArabic = /[\u0600-\u06FF]/.test(query);
    
    const searchQuery = isArabic 
      ? `ابحث في المواقع الإماراتية الرسمية (.ae) فقط عن: ${query}. استخدم فقط: wam.ae, government.ae, uae.gov.ae, moe.gov.ae`
      : `Search ONLY UAE official (.ae) websites about: ${query}. Use only: wam.ae, government.ae, uae.gov.ae, moe.gov.ae`;

    const response = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-small-128k-online',
        messages: [{
          role: 'user',
          content: searchQuery
        }],
        temperature: 0.1,
        return_citations: true,
        search_domain_filter: ['wam.ae', 'government.ae', 'uae.gov.ae', 'moe.gov.ae', 'mohesr.gov.ae']
      })
    });

    if (!response.ok) {
      console.log('⚠️ Perplexity search failed');
      return null;
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || '';
    const citations = data.citations || [];
    
    console.log(`✅ Perplexity found ${citations.length} UAE sources`);
    
    return {
      answer,
      citations: citations.filter(url => 
        url.includes('wam.ae') || 
        url.includes('government.ae') || 
        url.includes('uae.gov.ae') ||
        url.includes('moe.gov.ae') ||
        url.includes('mohesr.gov.ae')
      )
    };
  } catch (error) {
    console.error('Perplexity error:', error);
    return null;
  }
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

/* ========= /api/chat - LIBRARY + WEB SEARCH ========= */
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

    let answer = '';
    let bookIds = [];
    let webSources = [];
    let answerSource = 'library';

    // If we have books, use them
    if (safeBooks.length > 0) {
      
      // Build book sources
      const bookSources = safeBooks.map((b, i) => {
        const num = i + 1;
        const title = (b.title || 'Untitled').toString();
        const author = (b.author || 'Unknown').toString();
        const summary = (b.summary || '').toString().substring(0, 400);
        
        return `SOURCE [${num}]:
Title: ${title}
Author: ${author}
Summary: ${summary}`;
      }).join('\n\n');

      // ALSO search web for UAE sources
      console.log('🌐 Searching UAE websites...');
      const webResults = await searchWithPerplexity(query);
      
      let webContext = '';
      if (webResults && webResults.citations.length > 0) {
        console.log(`✅ Found ${webResults.citations.length} web sources`);
        webSources = webResults.citations;
        webContext = `\n\nWEB SOURCES FOUND:\n${webResults.answer}\n\nAvailable links:\n${webSources.map((url, i) => `[W${i+1}] ${url}`).join('\n')}`;
      } else {
        console.log('⚠️ No web sources found, using library only');
      }

      const isArabic = /[\u0600-\u06FF]/.test(query);

      const systemPrompt = `You are a research assistant that combines library books and UAE official websites.

CITATION RULES:
1. Library books → Cite as [1], [2], [3]
2. Web sources → Create clickable markdown links like [text](url)

CRITICAL: When using web sources, you MUST use the EXACT URLs provided in the "Available links" section.

Format for web citations:
- Arabic: [النص من الموقع](https://actual-url-from-available-links)
- English: [text from website](https://actual-url-from-available-links)

Example:
"كان الشيخ زايد داعماً قوياً [وفقاً لوكالة أنباء الإمارات](https://wam.ae/ar/details/1234567890)"

YOU MUST:
- Use library book numbers [1][2][3] for book info
- Use markdown links [text](url) for web sources with REAL URLs from "Available links"
- Combine both sources naturally`;

      const userPrompt = `USER QUERY: "${query}"

LIBRARY SOURCES:
${bookSources}
${webContext}

Answer the question using BOTH library books and web sources:
1. Cite books with [1], [2], [3]
2. Link to web sources using markdown [text](actual-url) with URLs from "Available links" section
3. Answer in ${isArabic ? 'Arabic' : 'English'}
4. Be comprehensive and credible

Answer now:`;

      answer = await callOpenAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        OPENAI_MODEL,
        { temperature: 0.1, max_tokens: 2000 }
      );

      // Extract book citations
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

      console.log(`✅ Book citations: ${bookIds.join(', ')}`);
      console.log(`✅ Web sources: ${webSources.length} links`);

      answerSource = 'dual';
      
    } 
    // No books - web search only
    else {
      console.log('🌐 No books, searching web only...');
      const webResults = await searchWithPerplexity(query);
      
      if (webResults && webResults.citations.length > 0) {
        webSources = webResults.citations;
        answer = webResults.answer;
        answerSource = 'web';
        console.log(`✅ Found ${webSources.length} web sources`);
      } else {
        const isArabic = /[\u0600-\u06FF]/.test(query);
        answer = isArabic
          ? 'عذراً، لم أتمكن من العثور على معلومات كافية في المصادر المتاحة.'
          : 'Sorry, could not find sufficient information in available sources.';
        answerSource = 'none';
      }
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
    aiProvider: 'OpenAI',
    openaiConfigured: !!OPENAI_API_KEY && OPENAI_API_KEY !== 'sk-YOUR-API-KEY-HERE',
    perplexityConfigured: !!PERPLEXITY_API_KEY,
    modelVersion: OPENAI_MODEL,
    features: 'Library Books [1][2][3] • UAE Web Search • Direct Article Links • Maximum Credibility',
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
  console.log(`📚 Library books → [1][2][3] citations`);
  console.log(`🌐 UAE websites → Direct links to articles`);
  console.log(`✅ Maximum credibility with verifiable sources`);
  if (PERPLEXITY_API_KEY) {
    console.log(`🔍 Perplexity search: ENABLED`);
  } else {
    console.log(`⚠️ Perplexity search: DISABLED (set PERPLEXITY_API_KEY to enable)`);
  }
});
