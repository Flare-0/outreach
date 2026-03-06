import fs from 'fs';
import { URL } from 'url';
import { initScraper, scrapeUrl } from './webScraperModule.js';

// Configuration
const MAX_CONCURRENT = 12; // Match page pool limit (was 15)
const MAX_DEPTH = 2;
const TIMEOUT_PER_URL = 15000; // 15 seconds per URL
const MAX_LINKS_PER_PAGE = 3;
const MAX_RETRIES = 2; // Retry failed scrapes
const RETRY_DELAY = 1000; // Wait 1s before retry

// In-memory cache and concurrency management
const results = {};
const visited = new Set();
const urlCache = new Map();
const failedUrls = new Map(); // Track failed URL counts
const stats = { success: 0, failed: 0, cached: 0, timeout: 0 };

/**
 * Extract domain from URL for same-domain checking
 */
function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Extract all links from scraped content
 */
function extractLinks(content, baseUrl) {
  if (!content || typeof content !== 'string') {
    return [];
  }
  
  const links = [];
  const linkRegex = /\[LINK: (.+?) → (.+?)\]/g;
  let match;

  try {
    while ((match = linkRegex.exec(content)) !== null) {
      const href = match[2]?.trim();
      if (!href) continue;
      
      try {
        const absoluteUrl = new URL(href, baseUrl).href;
        links.push(absoluteUrl);
      } catch (e) {
        // Skip invalid URLs
      }
    }
  } catch (e) {
    console.warn(`⚠️  Error extracting links from ${baseUrl}: ${e.message}`);
  }

  return links;
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a single URL with caching and retry logic
 */
async function processUrl(url, companyName, depth = 0, retryCount = 0) {
  // Avoid infinite loops
  if (visited.has(url) || depth > MAX_DEPTH) {
    return [];
  }

  visited.add(url);

  try {
    // Check cache first
    let content;
    if (urlCache.has(url)) {
      content = urlCache.get(url);
      console.log(`  ${'  '.repeat(depth)}⚡ [${depth}] Cached: ${url.substring(0, 50)}...`);
      stats.cached++;
    } else {
      console.log(`  ${'  '.repeat(depth)}🌐 [${depth}] Scraping: ${url.substring(0, 50)}...`);
      
      try {
        content = await Promise.race([
          scrapeUrl(url),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_PER_URL)
          ),
        ]);
        
        if (!content || content.trim().length === 0) {
          throw new Error('Empty content received');
        }
        
        urlCache.set(url, content);
        stats.success++;
      } catch (scrapeError) {
        if (scrapeError.message === 'TIMEOUT') {
          stats.timeout++;
          throw new Error(`⏱️  Timeout after ${TIMEOUT_PER_URL}ms`);
        }
        throw scrapeError;
      }
    }

    const baseDomain = getDomain(url);
    if (!baseDomain) {
      throw new Error('Invalid domain');
    }
    
    const links = extractLinks(content, url);

    // Store result for this URL - include the full content
    if (!results[companyName]) results[companyName] = [];
    results[companyName].push({
      url,
      depth,
      content,  // ✅ NOW STORED: Full text content with text, images, videos, etc
      contentLength: content.length,
      linksFound: links.length,
      timestamp: new Date().toISOString(),
      status: 'success',
    });

    // Recursively process same-domain links in PARALLEL
    const sameDomainLinks = links.filter(
      (link) => {
        const linkDomain = getDomain(link);
        return linkDomain === baseDomain && !visited.has(link);
      }
    ).slice(0, MAX_LINKS_PER_PAGE);

    if (sameDomainLinks.length > 0) {
      console.log(`  ${'  '.repeat(depth)}🔗 [${depth}] Found ${sameDomainLinks.length} same-domain links`);
      await Promise.allSettled(
        sameDomainLinks.map((link) => processUrl(link, companyName, depth + 1, 0))
      );
    }

    console.log(`  ${'  '.repeat(depth)}✅ [${depth}] Success (${links.length} links)`);
  } catch (error) {
    // Retry logic
    if (retryCount < MAX_RETRIES) {
      console.warn(`  ${'  '.repeat(depth)}🔄 [${depth}] Retry ${retryCount + 1}/${MAX_RETRIES}: ${error.message}`);
      await sleep(RETRY_DELAY);
      return processUrl(url, companyName, depth, retryCount + 1);
    }
    
    // Final failure
    stats.failed++;
    failedUrls.set(url, error.message);
    console.error(`  ${'  '.repeat(depth)}❌ [${depth}] Failed: ${error.message}`);
    
    if (!results[companyName]) results[companyName] = [];
    results[companyName].push({
      url,
      depth,
      error: error.message,
      timestamp: new Date().toISOString(),
      status: 'failed',
      retries: retryCount,
    });
  }
}

/**
 * Process items with concurrency limit using Promise.allSettled for robustness
 */
async function processConcurrently(items, processor) {
  for (let i = 0; i < items.length; i += MAX_CONCURRENT) {
    const batch = items.slice(i, i + MAX_CONCURRENT);
    const batchNum = Math.floor(i / MAX_CONCURRENT) + 1;
    const totalBatches = Math.ceil(items.length / MAX_CONCURRENT);
    
    console.log(`\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} items)\n`);
    
    await Promise.allSettled(batch.map(processor));
    
    if (i + MAX_CONCURRENT < items.length) {
      await sleep(500); // Small delay between batches to let browser recover
    }
  }
}

/**
 * Main execution
 */
async function main() {
  const startTime = Date.now();
  console.log('\n🚀 Starting web scraper with recursive domain crawling...\n');
  console.log(`⚙️  Configuration: Single browser + ${MAX_CONCURRENT} concurrent tabs, MAX_DEPTH=${MAX_DEPTH}, MAX_RETRIES=${MAX_RETRIES}\n`);

  try {
    // Initialize browser
    console.log('🔧 Initializing single browser instance...');
    await initScraper();
    console.log('✨ Browser ready (headless mode, max 5 concurrent tabs)!\n');

    // Load company data
    console.log('📂 Loading company data...');
    const companies = JSON.parse(fs.readFileSync('./ycURL.json', 'utf-8'));
    
    // Pre-filter valid companies
    const validCompanies = companies
      .filter((c) => {
        const url = c['Website URL']?.trim();
        return url && url.startsWith('http');
      })
      .map((c) => ({
        name: c.Name,
        url: c['Website URL'].trim(),
      }));

    const skipped = companies.length - validCompanies.length;
    console.log(`📊 Loaded ${companies.length} companies`);
    console.log(`✅ ${validCompanies.length} valid URLs`);
    if (skipped > 0) console.log(`⏭️  ${skipped} skipped (invalid URLs)\n`);

    // Process all companies with concurrency limit
    await processConcurrently(
      validCompanies,
      (company) => {
        console.log(`🏢 ${company.name}`);
        return processUrl(company.url, company.name, 0);
      }
    );

    // Save results
    const totalScraped = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
    const output = {
      timestamp: new Date().toISOString(),
      totalCompanies: companies.length,
      validCompanies: validCompanies.length,
      scrapedCompanies: Object.keys(results).length,
      totalUrlsScraped: totalScraped,
      stats: {
        successful: stats.success,
        failed: stats.failed,
        cached: stats.cached,
        timedout: stats.timeout,
        failedUrls: Array.from(failedUrls.entries()).map(([url, error]) => ({url, error}))
      },
      results,
    };

    fs.writeFileSync(
      './scrapeResults.json',
      JSON.stringify(output, null, 2)
    );

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    
    console.log('\n\n' + '='.repeat(70));
    console.log('✅ SCRAPING COMPLETE');
    console.log('='.repeat(70));
    console.log(`\n📈 Final Results:`);
    console.log(`   🏢 Companies with results: ${Object.keys(results).length}/${validCompanies.length}`);
    console.log(`   🌐 Total URLs scraped: ${totalScraped}`);
    console.log(`   ✨ Successful scrapes: ${stats.success}`);
    console.log(`   ❌ Failed scrapes: ${stats.failed}`);
    console.log(`   ⏱️  Timeouts: ${stats.timeout}`);
    console.log(`   ⚡ Cached hits: ${stats.cached}`);
    console.log(`   ⏰ Time elapsed: ${elapsed}s`);
    console.log(`   📊 Speed: ${(totalScraped / elapsed).toFixed(2)} URLs/sec`);
    console.log(`   💾 Results: ./scrapeResults.json`);
    console.log(`\n📝 Each URL result now includes:`);
    console.log(`   • url: Page address`);
    console.log(`   • content: Full text, headings, images, videos, links, buttons`);
    console.log(`   • contentLength: Size of extracted content`);
    console.log(`   • linksFound: Number of same-domain links detected`);
    console.log(`   • status: success|failed`);
    console.log(`   • timestamp: When scraped`);
    console.log('\n' + '='.repeat(70));
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
  }
}

main().catch(console.error);
