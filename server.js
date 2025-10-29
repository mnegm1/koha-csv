// backend/server.js
// ECSSR AI Assistant — v12.0 - Verified Web Links Only
// - Checks all URLs before using them
// - No more 404 errors!
// - Only shows links that actually work

const CODE_VERSION = "ecssr-backend-v12.0-verified-links";

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-YOUR-API-KEY-HERE';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

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

/* ========= Verify URL exists (returns 200 OK) ========= */
async function verifyURL(url) {
  try {
    console.log(`🔍 Checking URL: ${url}`);
    const response = await fetch(url, {
      method: 'HEAD',
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ECSSR-Bot/1.0)'
      }
    });
    
    if (response.ok) {
      console.log(`✅ URL valid: ${url}`);
      return true;
    } else {
      console.log(`❌ URL invalid (${response.status}): ${url}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ URL check failed: ${url} - ${error.message}`);
    return false;
  }
}

/* ========= Verify multiple URLs in parallel ========= */
async function verifyURLs(urls) {
  console.log(`🔍 Verifying ${urls.length} URLs...`);
  const results = await Promise.all(
    urls.map(async (url) => ({
      url,
      valid: await verifyURL(url)
    }))
  );
  
  const validUrls = results.filter(r => r.valid).map(r => r.url);
  console.log(`✅ Valid URLs: ${validUrls.length}/${urls.length}`);
  
  return validUrls;
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

/* ========= Perplexity with verified citations ========= */
async function searchWithPerplexity(query) {
  if (!PERPLEXITY_API_KEY) {
    console.log('⚠️ Perplexity API key not configured');
    return null;
  }
  
  try {
    const isArabic = /[\u0600-\u06FF]/.test(query);
    
    const searchQuery = isArabic 
      ? `ابحث في المواقع الإماراتية الرسمية (.ae) فقط عن: ${query}`
      : `Search ONLY UAE official (.ae) websites about: ${query}`;

    console.log(`🌐 Searching Perplexity: "${searchQuery}"`);

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
      const errorText = await response.text();
      console.log(`❌ Perplexity failed: ${response.status} - ${errorText}`);
      return null;
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || '';
    const citations = data.citations || [];
    
    console.log(`📚 Perplexity returned ${citations.length} citations`);
    
    // Filter to UAE domains only
    const uaeCitations = citations.filter(url => 
      url.includes('wam.ae') || 
      url.includes('government.ae') || 
      url.includes('uae.gov.ae') ||
      url.includes('moe.gov.ae') ||
      url.includes('mohesr.gov.ae')
    );
    
    console.log(`🇦🇪 UAE citations: ${uaeCitations.length}`);
    
    // VERIFY URLs before using them!
    const validUrls = await verifyURLs(uaeCitations);
    
    if (validUrls.length === 0) {
      console.log('⚠️ No valid URLs found after verification');
      return null;
    }
    
    return {
      answer,
      citations: validUrls
    };
  } catch (error) {
    console.error('❌ Perplexity error:', error);
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

/* ========= /api/chat - VERIFIED LINKS ONLY ========= */
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

      // Search web for VERIFIED UAE sources
      const webResults = await searchWithPerplexity(query);
      
      let webContext = '';
      if (webResults && webResults.citations.length > 0) {
        webSources = webResults.citations;
        console.log(`✅ Using ${webSources.length} VERIFIED web sources`);
        webContext = `\n\nVERIFIED WEB SOURCES (these URLs are confirmed to exist):\n${webSources.map((url, i) => `[W${i+1}] ${url}`).join('\n')}`;
      } else {
        console.log('⚠️ No verified web sources, using library only');
      }

      const isArabic = /[\u0600-\u06FF]/.test(query);

      const systemPrompt = `You are a research assistant combining library books and verified UAE websites.

CITATION RULES:
1. Library books → [1], [2], [3]
2. Web sources → [text](url) with ONLY URLs from "VERIFIED WEB SOURCES" list

CRITICAL: 
- Only use URLs from the "VERIFIED WEB SOURCES" section - these are confirmed to work
- Never make up URLs
- If no web sources available, use books only

Format:
Arabic: [النص](https://verified-url)
English: [text](https://verified-url)`;

      const userPrompt = `Query: "${query}"

LIBRARY SOURCES:
${bookSources}
${webContext}

Answer using both library books and verified web sources:
1. Cite books with [1], [2], [3]
2. Link web info using markdown [text](url) - ONLY use URLs from "VERIFIED WEB SOURCES"
3. Answer in ${isArabic ? 'Arabic' : 'English'}

Answer:`;

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

      console.log(`\n✅ Response complete:`);
      console.log(`📚 Book citations: ${bookIds.join(', ')}`);
      console.log(`🌐 Web sources: ${webSources.length} verified links\n`);

      answerSource = webSources.length > 0 ? 'dual' : 'library';
      
    } 
    // No books - web search only
    else {
      console.log('🌐 No books, searching web only...');
      const webResults = await searchWithPerplexity(query);
      
      if (webResults && webResults.citations.length > 0) {
        webSources = webResults.citations;
        answer = webResults.answer;
        answerSource = 'web';
        console.log(`✅ Found ${webSources.length} verified web sources`);
      } else {
        const isArabic = /[\u0600-\u06FF]/.test(query);
        answer = isArabic
          ? 'عذراً، لم أتمكن من العثور على معلومات موثوقة في المصادر المتاحة.'
          : 'Sorry, could not find reliable information in available sources.';
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
    aiProvider: 'OpenAI + Perplexity',
    openaiConfigured: !!OPENAI_API_KEY && OPENAI_API_KEY !== 'sk-YOUR-API-KEY-HERE',
    perplexityConfigured: !!PERPLEXITY_API_KEY,
    modelVersion: OPENAI_MODEL,
    features: 'Verified Links Only • No 404 Errors • Library [1][2][3] + UAE Websites',
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
  console.log(`📚 Library books → [1][2][3] citations`);
  console.log(`🌐 UAE websites → VERIFIED links only (no 404!)`);
  console.log(`✅ All URLs checked before use\n`);
  
  if (PERPLEXITY_API_KEY) {
    console.log(`🔍 Perplexity search: ENABLED`);
    console.log(`🔒 URL verification: ENABLED\n`);
  } else {
    console.log(`⚠️ Perplexity search: DISABLED (library only)\n`);
  }
});
