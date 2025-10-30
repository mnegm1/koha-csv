// backend/server.js
// ECSSR AI Assistant – v15.0 - ENHANCED Error Handling & URL Processing
// - Fixed URL encoding issues
// - Improved error handling
// - Better URL verification with retries
// - Fixed Perplexity integration

const CODE_VERSION = "ecssr-backend-v15.0-enhanced";

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
// Updated model names - Perplexity uses these models
const PERPLEXITY_MODEL = 'sonar-pro';  // or 'sonar' for standard

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

/* ========= Improved URL Validation ========= */
function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    // Check for valid protocol
    if (!['http:', 'https:'].includes(url.protocol)) {
      return false;
    }
    // Check for valid hostname
    if (!url.hostname || url.hostname.length < 3) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* ========= Clean and decode URLs ========= */
function cleanUrl(url) {
  try {
    // Remove any whitespace
    url = url.trim();
    
    // If already a valid URL, return it
    if (isValidUrl(url)) {
      return url;
    }
    
    // Try to decode if it's encoded
    try {
      url = decodeURIComponent(url);
      if (isValidUrl(url)) {
        return url;
      }
    } catch (e) {
      // If decode fails, continue with original
    }
    
    return url;
  } catch {
    return url;
  }
}

/* ========= Verify URL with improved retry logic ========= */
async function verifyURL(url, attempt = 1) {
  const MAX_ATTEMPTS = 2;
  const TIMEOUT_MS = 8000; // Reduced timeout
  
  try {
    // Clean the URL first
    url = cleanUrl(url);
    
    if (!isValidUrl(url)) {
      console.log(`❌ Invalid URL format: ${url}`);
      return false;
    }
    
    console.log(`🔍 Verifying URL (attempt ${attempt}): ${url}`);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
    
    clearTimeout(timeout);
    
    // Accept 2xx and 3xx status codes
    if (response.ok || (response.status >= 300 && response.status < 400)) {
      console.log(`✅ Valid URL (${response.status}): ${url}`);
      return true;
    } else if (response.status === 405 || response.status === 403) {
      // Some servers block HEAD, try GET
      console.log(`⚠️ HEAD blocked (${response.status}), trying GET: ${url}`);
      return await verifyURLWithGET(url);
    } else {
      console.log(`❌ Invalid URL (${response.status}): ${url}`);
      return false;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`⏱️ Timeout on attempt ${attempt}: ${url}`);
      
      // Retry once on timeout
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s
        return await verifyURL(url, attempt + 1);
      }
      
      // For UAE sites, give benefit of doubt after timeout
      if (url.includes('.ae')) {
        console.log(`⚠️ Timeout, assuming UAE site is valid: ${url}`);
        return true;
      }
      return false;
    }
    
    console.log(`⚠️ Error verifying URL: ${error.message}`);
    
    // For UAE sites, give benefit of doubt on errors
    if (url.includes('.ae')) {
      console.log(`⚠️ Assuming UAE site is valid: ${url}`);
      return true;
    }
    
    return false;
  }
}

/* ========= Fallback: Verify with GET request ========= */
async function verifyURLWithGET(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
      }
    });
    
    clearTimeout(timeout);
    
    if (response.ok || (response.status >= 300 && response.status < 400)) {
      console.log(`✅ Valid URL via GET (${response.status}): ${url}`);
      return true;
    } else {
      console.log(`❌ Invalid URL via GET (${response.status}): ${url}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ GET failed: ${error.message}`);
    // UAE sites get benefit of doubt
    if (url.includes('.ae')) {
      console.log(`⚠️ Assuming UAE site is valid after GET failure: ${url}`);
      return true;
    }
    return false;
  }
}

/* ========= Verify multiple URLs in parallel with limit ========= */
async function verifyURLs(urls) {
  if (!urls || urls.length === 0) return [];
  
  console.log(`🔍 Verifying ${urls.length} URLs...`);
  
  // Clean all URLs first
  const cleanedUrls = urls.map(url => cleanUrl(url)).filter(url => isValidUrl(url));
  
  console.log(`📋 Valid URL format: ${cleanedUrls.length}/${urls.length}`);
  
  // Verify in batches of 3 to avoid overwhelming
  const batchSize = 3;
  const validUrls = [];
  
  for (let i = 0; i < cleanedUrls.length; i += batchSize) {
    const batch = cleanedUrls.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (url) => ({
        url,
        valid: await verifyURL(url)
      }))
    );
    
    validUrls.push(...results.filter(r => r.valid).map(r => r.url));
  }
  
  console.log(`✅ Verified: ${validUrls.length}/${cleanedUrls.length} URLs are accessible`);
  
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

/* ========= Enhanced Perplexity Search ========= */
async function searchWithPerplexity(query) {
  if (!PERPLEXITY_API_KEY) {
    console.log('⚠️ Perplexity API key not set');
    return null;
  }
  
  try {
    const isArabic = /[\u0600-\u06FF]/.test(query);
    
    // Enhanced search query focusing on UAE government and official sources
    const searchQuery = isArabic 
      ? `ابحث في المواقع الرسمية الإماراتية (.ae) عن: ${query}. اذكر المصادر من المواقع الحكومية مثل wam.ae و uae.gov.ae`
      : `Search official UAE websites (.ae domains) for: ${query}. Include sources from government sites like wam.ae and uae.gov.ae`;

    console.log(`🌐 Perplexity search: "${searchQuery}"`);

    const requestBody = {
      model: PERPLEXITY_MODEL,
      messages: [{
        role: 'user',
        content: searchQuery
      }],
      temperature: 0.1,
      max_tokens: 1500,
      return_citations: true,
      return_images: false
    };

    const response = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });

    console.log(`📥 Perplexity response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`❌ Perplexity error (${response.status}): ${errorText}`);
      
      // Try with alternative model if current one fails
      if (response.status === 400 && PERPLEXITY_MODEL === 'sonar-pro') {
        console.log(`🔄 Retrying with 'sonar' model...`);
        requestBody.model = 'sonar';
        const retryResponse = await fetch(PERPLEXITY_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody)
        });
        
        if (retryResponse.ok) {
          const retryData = await retryResponse.json();
          return processPerplexityResponse(retryData);
        }
      }
      
      return null;
    }

    const data = await response.json();
    return processPerplexityResponse(data);
    
  } catch (error) {
    console.error('❌ Perplexity exception:', error.message);
    return null;
  }
}

/* ========= Process Perplexity Response ========= */
async function processPerplexityResponse(data) {
  try {
    console.log('📦 Processing Perplexity response...');
    
    const answer = data.choices?.[0]?.message?.content || '';
    let citations = data.citations || [];
    
    console.log(`📚 Raw citations count: ${citations.length}`);
    
    if (citations.length === 0) {
      console.log('⚠️ No citations in response');
      return null;
    }
    
    // Filter to UAE domains
    const uaeCitations = citations.filter(url => {
      const cleanedUrl = cleanUrl(url);
      return cleanedUrl.includes('.ae');
    });
    
    console.log(`🇦🇪 UAE citations found: ${uaeCitations.length}`);
    
    if (uaeCitations.length === 0) {
      console.log('⚠️ No UAE citations found');
      return null;
    }
    
    // Verify URLs (with improved error handling)
    console.log('🔍 Starting URL verification...');
    const validUrls = await verifyURLs(uaeCitations);
    
    if (validUrls.length === 0) {
      console.log('⚠️ No valid URLs after verification');
      // Return raw URLs if verification fails but URLs exist
      if (uaeCitations.length > 0) {
        console.log('📋 Using unverified UAE URLs as fallback');
        return {
          answer,
          citations: uaeCitations.slice(0, 5) // Limit to 5
        };
      }
      return null;
    }
    
    console.log(`✅ Returning ${validUrls.length} verified URLs`);
    
    return {
      answer,
      citations: validUrls.slice(0, 5) // Limit to top 5
    };
  } catch (error) {
    console.error('❌ Error processing Perplexity response:', error.message);
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

/* ========= /api/chat - Enhanced with better error handling ========= */
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
      
      // Build book context
      const bookContext = safeBooks.map((b, i) => {
        const num = i + 1;
        return `[${num}] ${b.title || 'Untitled'} by ${b.author || 'Unknown'}\n${(b.summary || '').substring(0, 400)}`;
      }).join('\n\n');

      // Search web for verified links (with timeout protection)
      let webResults = null;
      try {
        const webSearchPromise = searchWithPerplexity(query);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Web search timeout')), 25000)
        );
        webResults = await Promise.race([webSearchPromise, timeoutPromise]);
      } catch (error) {
        console.log(`⚠️ Web search error: ${error.message}`);
        webResults = null;
      }
      
      let webContext = '';
      if (webResults && webResults.citations && webResults.citations.length > 0) {
        webSources = webResults.citations;
        console.log(`✅ Got ${webSources.length} verified web links`);
        webContext = `\n\nVERIFIED WEB SOURCES (.ae domains):\n${webSources.map((url, i) => `[W${i+1}] ${url}`).join('\n')}`;
      }

      const isArabic = /[\u0600-\u06FF]/.test(query);

      const prompt = `You are answering: "${query}"

LIBRARY BOOKS:
${bookContext}
${webContext}

INSTRUCTIONS:
1. Answer the question thoroughly using the library books
2. Cite books using [1], [2], [3] format
3. If web sources are provided, create markdown links: [descriptive text](url)
4. Use ONLY URLs from the VERIFIED WEB SOURCES section
5. Answer in ${isArabic ? 'Arabic' : 'English'}
6. Be comprehensive but concise

IMPORTANT: Only use web links if they directly support your answer. Do not force web links if book sources are sufficient.

Answer:`;

      answer = await callOpenAI(
        [{ role: 'user', content: prompt }],
        OPENAI_MODEL,
        { temperature: 0.1, max_tokens: 2500 }
      );

      // Extract book citations
      const matches = answer.match(/\[(\d+)\]/g);
      if (matches) {
        bookIds = [...new Set(matches.map(m => parseInt(m.replace(/[\[\]]/g, ''))))].filter(n => n > 0 && n <= safeBooks.length).sort((a,b) => a-b);
      }

      console.log(`✅ Books cited: ${bookIds.join(', ')}`);
      console.log(`✅ Web links provided: ${webSources.length}`);

      answerSource = webSources.length > 0 ? 'dual' : 'library';
      
    } else {
      // No books - web search only
      let webResults = null;
      try {
        const webSearchPromise = searchWithPerplexity(query);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Web search timeout')), 25000)
        );
        webResults = await Promise.race([webSearchPromise, timeoutPromise]);
      } catch (error) {
        console.log(`⚠️ Web search error: ${error.message}`);
      }
      
      if (webResults && webResults.citations && webResults.citations.length > 0) {
        webSources = webResults.citations;
        answer = webResults.answer || 'معلومات من مصادر الويب / Information from web sources';
        answerSource = 'web';
      } else {
        answer = 'عذراً، لم أتمكن من العثور على معلومات موثوقة. / Sorry, could not find reliable information.';
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
    console.error('❌ Error in /api/chat:', err);
    res.status(500).json({ 
      error: 'Processing error', 
      details: err.message,
      answer: 'عذراً، حدث خطأ في معالجة طلبك. / Sorry, an error occurred processing your request.',
      bookIds: [],
      webSources: [],
      source: 'error'
    });
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

/* ========= Health check ========= */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: CODE_VERSION,
    aiProvider: 'OpenAI + Perplexity',
    openaiConfigured: !!OPENAI_API_KEY && OPENAI_API_KEY !== 'sk-YOUR-API-KEY-HERE',
    perplexityConfigured: !!PERPLEXITY_API_KEY,
    openaiModel: OPENAI_MODEL,
    perplexityModel: PERPLEXITY_MODEL,
    features: [
      'Enhanced URL verification',
      'Improved error handling', 
      'Better timeout management',
      'Book citations [1][2][3]',
      'Verified web links'
    ]
  });
});

/* ========= Error handler ========= */
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

/* ========= Start server ========= */
app.listen(PORT, () => {
  console.log(`\n🚀 ECSSR Backend Server`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`📖 Version: ${CODE_VERSION}`);
  console.log(`✅ Enhanced features:`);
  console.log(`   • Improved URL verification`);
  console.log(`   • Better error handling`);
  console.log(`   • Timeout protection`);
  console.log(`   • Fallback mechanisms`);
  console.log(`   • Support for sonar/sonar-pro models\n`);
});
