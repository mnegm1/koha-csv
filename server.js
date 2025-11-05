// backend/server.js
// ECSSR AI Assistant — v15.0 - IMPROVED Query Type Detection
// - Better distinction between famous people vs regular authors
// - Location as subject vs location as publisher location
// - Content/summary search for famous people

const CODE_VERSION = "ecssr-backend-v15.0-improved-query-types";

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');


// === UAE-only domain helpers (STRICT) ===
const UAE_SUFFIX = '.ae';
function isUaeDomain(urlStr) {
  try {
    const { hostname } = new URL(String(urlStr).trim().toLowerCase());
    return hostname.endsWith(UAE_SUFFIX);
  } catch {
    return false;
  }
}
function filterUaeDomains(urls = []) {
  const unique = Array.from(new Set((urls || []).filter(Boolean)));
  return unique.filter(isUaeDomain);
}

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

/* ========= Verify URL (check if it returns 200) ========= */
async function verifyURL(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache'
      }
    });
    
    clearTimeout(timeout);
    
    if (response.ok) {
      console.log(`✅ Valid URL: ${url}`);
      return true;
    } else if (response.status === 405) {
      console.log(`⚠️ HEAD not allowed, trying GET: ${url}`);
      return await verifyURLWithGET(url);
    } else {
      console.log(`❌ Invalid URL (${response.status}): ${url}`);
      return false;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`⚠️ Timeout (10s), trying GET: ${url}`);
      return await verifyURLWithGET(url);
    } else {
      console.log(`⚠️ HEAD failed, trying GET: ${url} - ${error.message}`);
      return await verifyURLWithGET(url);
    }
  }
}

async function verifyURLWithGET(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
      }
    });
    
    clearTimeout(timeout);
    
    if (response.ok) {
      console.log(`✅ Valid URL (GET): ${url}`);
      return true;
    } else {
      console.log(`❌ Invalid URL (${response.status}): ${url}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ GET also failed: ${url} - ${error.message}`);
    return false; // strict: do not assume validity even if .ae
  }
}

async function verifyURLs(urls) {
  urls = filterUaeDomains(urls); // keep only .ae
  if (!urls || urls.length === 0) return [];
  
  console.log(`🔍 Verifying ${urls.length} URLs...`);
  
  const results = await Promise.all(
    urls.map(async (url) => ({
      url,
      valid: await verifyURL(url)
    }))
  );
  
  const validUrls = results.filter(r => r.valid).map(r => r.url);
  console.log(`✅ Valid: ${validUrls.length}/${urls.length} URLs`);
  
  return validUrls;
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

/* ========= Perplexity Search ========= */
async function searchWithPerplexity(query) {
  if (!PERPLEXITY_API_KEY) {
    console.log('⚠️ Perplexity API key not set');
    return null;
  }
  
  try {
    const isArabic = /[\u0600-\u06FF]/.test(query);
    
    const searchQuery = isArabic 
      ? `ابحث في المواقع الإماراتية عن: ${query}`
      : `Search UAE websites for: ${query}`;

    console.log(`🌐 Perplexity search: "${searchQuery}"`);

    const requestBody = {
      model: 'sonar',
      messages: [{
        role: 'user',
        content: searchQuery
      }],
      temperature: 0.1,
      max_tokens: 1500,
      return_citations: true
    };

    const response = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`❌ Perplexity error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || '';
    let citations = data.citations || [];
    
    const uaeCitations = filterUaeDomains(citations);
    
    if (uaeCitations.length === 0) {
      return null;
    }
    
    const validUrls = await verifyURLs(uaeCitations);
    
    if (validUrls.length === 0) {
      return null;
    }
    
    return {
      answer,
      citations: validUrls
    };
    
  } catch (error) {
    console.error('❌ Perplexity exception:', error.message);
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

/* ========= Famous People Detection ========= */
const FAMOUS_PEOPLE = [
  'محمد بن زايد', 'محمد بن راشد', 'خليفة بن زايد', 'زايد بن سلطان',
  'الشيخ زايد', 'الشيخ محمد', 'الشيخ خليفة', 
  'sheikh zayed', 'sheikh mohammed', 'sheikh khalifa', 'sheikh mohamed'
];

function isFamousPerson(query) {
  const nq = norm(query);
  return FAMOUS_PEOPLE.some(person => nq.includes(norm(person)));
}

/* ========= /api/understand-query - IMPROVED ANALYZER ========= */
app.post('/api/understand-query', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Query required' });

    console.log(`\n🔍 Analyzing query: "${query}"`);

    const isArabic = /[\u0600-\u06FF]/.test(query);

    // Check if it's a famous person first
    const isFamous = isFamousPerson(query);
    if (isFamous) {
      console.log('⭐ Detected FAMOUS PERSON - will search content/summary');
      return res.json({
        intent: 'famous_person',
        field: 'famous_person',
        searchFields: ['summary', 'content', 'title', 'subject'],
        keyTerms: [query],
        reasoning: 'Famous person detected - searching in content and summary for books ABOUT them'
      });
    }

    const systemPrompt = `You are a library search expert. Analyze the search query and determine which database fields to search.

AVAILABLE FIELDS:
- author (author name - books BY this person)
- title (book title)
- subject (book topic/subject)
- summary (book description)
- content (book full content - use for famous people)
- publisher (publisher name)
- publisher_location (city/country where published)
- year (publication year)

CRITICAL DISTINCTIONS:
1. FAMOUS PERSON (Sheikh, President, Well-known figure):
   → Search: content, summary, title, subject
   → These are people who are SUBJECTS of books, not authors
   → Example: "الشيخ زايد" should search content/summary

2. REGULAR AUTHOR NAME (Unknown person, 2-3 names):
   → Search: author, co-author, organization
   → These are people who WRITE books
   → Example: "أحمد محمد علي" should search author

3. LOCATION AS SUBJECT (talking ABOUT a place):
   → Search: subject, title, summary
   → Example: "تاريخ دبي" (history of Dubai)

4. LOCATION AS PUBLISHER (WHERE book was published):
   → Search: publisher_location
   → Example: "كتب منشورة في أبوظبي"

5. TOPIC/SUBJECT → Search: subject, title, summary
6. BOOK TITLE → Search: title
7. ORGANIZATION → Search: publisher, author, subject
8. YEAR/DATE → Search: year

Respond with JSON only.`;

    const userPrompt = `Query: "${query}"

Analyze this query carefully:
1. Is it a FAMOUS PERSON (well-known figure like Sheikh, President)? → use "famous_person"
2. Is it a REGULAR AUTHOR name (unknown person)? → use "person" with author fields
3. Is it a LOCATION as a subject/topic? → use "place" with subject fields
4. Is it a LOCATION as publisher location? → use "place" with publisher_location
5. Or is it a topic, title, organization, or year?

Respond in JSON format:
{
  "queryType": "famous_person|person|place|topic|title|organization|year",
  "searchFields": ["field1", "field2", ...],
  "keyTerms": ["term1", "term2", ...],
  "reasoning": "brief explanation",
  "isFamousPerson": true/false,
  "isPublisherLocation": true/false
}`;

    const aiResponse = await callOpenAI(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      OPENAI_MODEL,
      { temperature: 0.1, max_tokens: 500 }
    );

    let analysis;
    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found');
      }
    } catch (e) {
      console.log('⚠️ Failed to parse AI response, using defaults');
      analysis = {
        queryType: 'topic',
        searchFields: ['title', 'subject', 'summary'],
        keyTerms: [query],
        reasoning: 'Default search'
      };
    }

    console.log(`📊 Query type: ${analysis.queryType}`);
    console.log(`📋 Search fields: ${analysis.searchFields.join(', ')}`);
    console.log(`🔑 Key terms: ${analysis.keyTerms.join(', ')}`);
    console.log(`💡 Reasoning: ${analysis.reasoning}\n`);

    res.json({
      intent: analysis.queryType,
      field: analysis.searchFields[0] || 'default',
      searchFields: analysis.searchFields,
      keyTerms: analysis.keyTerms,
      reasoning: analysis.reasoning,
      isFamousPerson: analysis.isFamousPerson || false,
      isPublisherLocation: analysis.isPublisherLocation || false
    });

  } catch (err) {
    console.error('❌ Query analysis error:', err);
    res.status(500).json({ error: 'Error', details: err.message });
  }
});

/* ========= /api/chat - Books + Verified Web Links ========= */
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
    console.log(`📚 Books: ${safeBooks.length}`);
    console.log(`========================================\n`);

    let answer = '';
    let bookIds = [];
    let webSources = [];
    let answerSource = 'library';

    if (safeBooks.length > 0) {
      
      const bookContext = safeBooks.map((b, i) => {
        const num = i + 1;
        return `[${num}] ${b.title || 'Untitled'} by ${b.author || 'Unknown'}\n${(b.summary || '').substring(0, 400)}`;
      }).join('\n\n');

      const webResults = await searchWithPerplexity(query);
      
      let webContext = '';
      if (webResults && webResults.citations.length > 0) {
        webSources = filterUaeDomains(webResults.citations);
        console.log(`✅ Got ${webSources.length} VERIFIED web links (.ae only)`);
        webContext = `\n\nVERIFIED WEB LINKS (these URLs work):\n${webSources.map((url, i) => `[W${i+1}] ${url}`).join('\n')}`;
      }

      const isArabic = /[\u0600-\u06FF]/.test(query);

      const prompt = `You are answering: "${query}"

LIBRARY BOOKS:
${bookContext}
${webContext}

RULES:
1. For book info → cite [1], [2], [3]
2. For web info → create markdown links: [text](url) using ONLY URLs from "VERIFIED WEB LINKS"
3. Answer in ${isArabic ? 'Arabic' : 'English'}

Example:
"الشيخ زايد [كان مؤسس دولة الإمارات](https://wam.ae/actual-url) وفقاً لوكالة أنباء الإمارات [1]."

Answer now:`;

      answer = await callOpenAI(
        [{ role: 'user', content: prompt }],
        OPENAI_MODEL,
        { temperature: 0.1 }
      );

      const matches = answer.match(/\[(\d+)\]/g);
      if (matches) {
        bookIds = [...new Set(matches.map(m => parseInt(m.replace(/[\[\]]/g, ''))))].filter(n => n > 0 && n <= safeBooks.length).sort((a,b) => a-b);
      }

      console.log(`✅ Books cited: ${bookIds.join(', ')}`);
      console.log(`✅ Web links: ${webSources.length}`);

      answerSource = webSources.length > 0 ? 'dual' : 'library';
      
    } else {
      const webResults = await searchWithPerplexity(query);
      
      if (webResults && webResults.citations.length > 0) {
        webSources = webResults.citations;
        answer = webResults.answer;
        answerSource = 'web';
      } else {
        answer = 'عذراً، لم أتمكن من العثور على معلومات موثوقة.';
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
    console.error('❌ Error:', err);
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
    features: 'Famous Person Detection • Location Type Detection • Content Search • Verified URLs',
  });
});

/* ========= Error ========= */
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Error' });
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`\n🚀 ECSSR Backend http://localhost:${PORT}`);
  console.log(`🔖 Version: ${CODE_VERSION}`);
  console.log(`✅ Famous person detection`);
  console.log(`✅ Location type detection`);
  console.log(`✅ Content/summary search for famous people\n`);
});
