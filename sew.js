import fs from 'fs';
import { URL } from 'url';
import { chromium } from 'playwright';

// ============================================
// PLAYWRIGHT BROWSER MANAGEMENT (INTEGRATED)
// ============================================
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const BLOCKED = new Set(["image", "stylesheet", "font", "media", "ping"]);

let browser = null;
let activePages = 0;
const MAX_CONCURRENT_PAGES = 12;
const pageQueue = [];

async function acquirePage() {
  while (activePages >= MAX_CONCURRENT_PAGES) {
    await new Promise(resolve => pageQueue.push(resolve));
  }
  activePages++;
}

function releasePage() {
  activePages--;
  const resolve = pageQueue.shift();
  if (resolve) resolve();
}

async function initBrowser() {
  browser = await chromium.launch({ 
    headless: false,  // ✅ HEADLESS MODE - NO WINDOWS
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ]
  });
  console.log("🟢 Single browser instance initialized (headless)\n");

  browser.on("disconnected", async () => {
    console.log("🔴 Browser disconnected, restarting...");
    browser = await chromium.launch({ 
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
      ]
    });
    console.log("🟢 Browser restarted\n");
  });
}

async function scrapePageContent(url) {
  await acquirePage();
  
  let page = null;
  try {
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "User-Agent": UA });

    await page.route("**/*", (route) => {
      BLOCKED.has(route.request().resourceType()) ? route.abort() : route.continue();
    });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    } catch {
      // partial load is fine
    }

    const content = await page.evaluate(() => {
      const lines = [];

      function walk(node, depth = 0) {
        if (!node) return;
        const indent = "  ".repeat(depth);

        const skipTags = new Set([
          "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "HEAD", "META", "LINK", "TEMPLATE",
        ]);
        if (node.nodeType === 1 && skipTags.has(node.tagName)) return;

        if (node.nodeType === 1) {
          const style = window.getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") return;
        }

        const tag = node.tagName?.toLowerCase();

        if (tag === "img") {
          const alt = node.getAttribute("alt")?.trim();
          const src = node.getAttribute("src") || "";
          const hint = alt ? `alt="${alt}"` : src ? `src="${src.split("/").pop()}"` : "no description";
          lines.push(`${indent}[IMAGE: ${hint}]`);
          return;
        }

        if (tag === "video") {
          const src = node.getAttribute("src") || node.querySelector("source")?.getAttribute("src") || "";
          lines.push(`${indent}[VIDEO: ${src ? src.split("/").pop() : "embedded"}]`);
          return;
        }

        if (tag === "iframe") {
          const src = node.getAttribute("src") || "";
          const isVideo = /youtube|vimeo|loom|wistia|mux/.test(src);
          lines.push(`${indent}[${isVideo ? "VIDEO_EMBED" : "IFRAME"}: ${src || "no src"}]`);
          return;
        }

        if (tag === "audio") {
          lines.push(`${indent}[AUDIO]`);
          return;
        }

        const landmarks = { header: "HEADER", nav: "NAV", main: "MAIN", footer: "FOOTER", section: "SECTION", article: "ARTICLE", aside: "ASIDE", form: "FORM" };
        if (landmarks[tag]) {
          const label = node.getAttribute("aria-label") || node.getAttribute("id") || "";
          lines.push(`${indent}[${landmarks[tag]}${label ? `: ${label}` : ""}]`);
          for (const child of node.childNodes) walk(child, depth + 1);
          lines.push(`${indent}[/${landmarks[tag]}]`);
          return;
        }

        if (/^h[1-6]$/.test(tag)) {
          const text = node.innerText?.trim();
          if (text) lines.push(`${indent}[${tag.toUpperCase()}] ${text}`);
          return;
        }

        if (tag === "a") {
          const text = node.innerText?.trim();
          const href = node.getAttribute("href") || "";
          if (text) lines.push(`${indent}[LINK: ${text}${href ? ` → ${href}` : ""}]`);
          return;
        }

        if (tag === "button" || node.getAttribute?.("role") === "button") {
          const text = node.innerText?.trim();
          if (text) lines.push(`${indent}[BUTTON: ${text}]`);
          return;
        }

        if (tag === "input" || tag === "textarea" || tag === "select") {
          const type = node.getAttribute("type") || tag;
          const placeholder = node.getAttribute("placeholder") || node.getAttribute("name") || "";
          lines.push(`${indent}[INPUT: ${type}${placeholder ? ` "${placeholder}"` : ""}]`);
          return;
        }

        if (node.nodeType === 3) {
          const text = node.textContent?.trim();
          if (text && text.length > 1) lines.push(`${indent}${text}`);
          return;
        }

        for (const child of node.childNodes) walk(child, depth + 1);
      }

      walk(document.body);
      return lines.filter(Boolean).join("\n");
    });

    return content;
  } catch (error) {
    throw error;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // ignore
      }
    }
    releasePage();
  }
}

// ============================================
// CRAWLER LOGIC
// ============================================
const MAX_DEPTH = 2;
const MAX_LINKS_PER_PAGE = 3;
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;
const SAVE_INTERVAL = 5000; // Auto-save every 5 seconds

let lastSaveTime = Date.now();
const OUTPUT_FILE = './ycURL_with_crawler_data.json';

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function extractLinks(content, baseUrl) {
  if (!content || typeof content !== 'string') return [];
  
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
        // Skip invalid
      }
    }
  } catch (e) {
    // Skip error
  }

  return links;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function crawlPage(url, visitedInCrawl, depth = 0) {
  if (visitedInCrawl.has(url) || depth > MAX_DEPTH) {
    return [];
  }

  visitedInCrawl.add(url);

  let retries = 0;
  while (retries <= MAX_RETRIES) {
    try {
      console.log(`  ${'  '.repeat(depth)}🌐 [D${depth}] Crawling: ${url.substring(0, 50)}...`);
      
      const content = await scrapePageContent(url);
      
      if (!content || content.trim().length === 0) {
        throw new Error('Empty content');
      }

      const baseDomain = getDomain(url);
      if (!baseDomain) {
        throw new Error('Invalid domain');
      }

      const links = extractLinks(content, url);
      
      console.log(`  ${'  '.repeat(depth)}✅ [D${depth}] Success (${content.length} chars, ${links.length} links)`);

      // Recursively crawl same-domain links
      const sameDomainLinks = links.filter(
        (link) => getDomain(link) === baseDomain && !visitedInCrawl.has(link)
      ).slice(0, MAX_LINKS_PER_PAGE);

      const crawledPages = [{
        page: url,
        data: content,
        links_found: links.length,
      }];

      if (sameDomainLinks.length > 0 && depth < MAX_DEPTH) {
        for (const link of sameDomainLinks) {
          const subPages = await crawlPage(link, visitedInCrawl, depth + 1);
          crawledPages.push(...subPages);
        }
      }

      return crawledPages;

    } catch (error) {
      retries++;
      if (retries <= MAX_RETRIES) {
        console.warn(`  ${'  '.repeat(depth)}🔄 [D${depth}] Retry ${retries}: ${error.message}`);
        await sleep(RETRY_DELAY);
      } else {
        console.error(`  ${'  '.repeat(depth)}❌ [D${depth}] Failed: ${error.message}`);
        return [];
      }
    }
  }

  return [];
}

// Save data with verification
async function saveAndVerify(data) {
  const jsonString = JSON.stringify(data, null, 2);
  fs.writeFileSync(OUTPUT_FILE, jsonString);
  
  // Verify save
  try {
    const readBack = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    return readBack.length === data.length;
  } catch (e) {
    return false;
  }
}

async function processBatch(companies, startIndex, visitedInCrawl) {
  const promises = companies.slice(startIndex, startIndex + MAX_CONCURRENT_PAGES).map(async (company) => {
    try {
      const crawlData = await crawlPage(company['Website URL'], visitedInCrawl, 0);
      company.crawlerData = crawlData;
      return { index: startIndex + companies.indexOf(company), company, crawlData };
    } catch (error) {
      company.crawlerData = [];
      return { index: startIndex + companies.indexOf(company), company, crawlData: [] };
    }
  });
  return Promise.all(promises);
}

async function main() {
  const startTime = Date.now();
  console.log('\n🚀 Starting crawler with integrated browser management...');
  console.log(`📁 Output: ${OUTPUT_FILE}`);
  console.log(`🔢 Max concurrent pages: ${MAX_CONCURRENT_PAGES}\n`);

  try {
    // Initialize browser ONCE
    await initBrowser();

    // Load original data
    const companies = JSON.parse(fs.readFileSync('./ycURL.json', 'utf-8'));
    console.log(`📊 Loaded ${companies.length} companies\n`);

    // Filter valid ones
    const validCompanies = companies.filter(c => {
      const url = c['Website URL']?.trim();
      return url && url.startsWith('http');
    });

    console.log(`✅ ${validCompanies.length} valid URLs\n`);

    const visitedInCrawl = new Set();
    let processed = 0;

    // Process in batches of MAX_CONCURRENT_PAGES (12)
    while (processed < validCompanies.length) {
      const batchSize = Math.min(MAX_CONCURRENT_PAGES, validCompanies.length - processed);
      const batch = validCompanies.slice(processed, processed + batchSize);
      
      console.log(`\n📦 Processing batch ${Math.floor(processed / MAX_CONCURRENT_PAGES) + 1} (${processed + 1}-${processed + batchSize})...`);
      
      await Promise.all(batch.map(async (company) => {
        try {
          const crawlData = await crawlPage(company['Website URL'], visitedInCrawl, 0);
          company.crawlerData = crawlData;
          console.log(`   ✅ ${company.Name}: ${crawlData.length} pages crawled`);
        } catch (error) {
          company.crawlerData = [];
          console.log(`   ❌ ${company.Name}: ${error.message}`);
        }
      }));

      processed += batchSize;
      console.log(`   💾 Saving progress...`);
      const verified = await saveAndVerify(validCompanies.slice(0, processed));
      if (verified) {
        console.log(`   ✓ Verified: ${processed} companies\n`);
      } else {
        console.log(`   ⚠️  Save verification failed!\n`);
      }
      lastSaveTime = Date.now();
    }

    // Final save
    console.log('\n💾 Final save and verification...');
    const finalVerified = await saveAndVerify(validCompanies);

    const elapsed = Math.round((Date.now() - startTime) / 1000);

    console.log('\n' + '='.repeat(70));
    console.log('✅ CRAWL COMPLETE!');
    console.log('='.repeat(70));
    console.log(`\n📈 Results:`);
    console.log(`   🏢 Companies: ${validCompanies.length}`);
    const totalPages = validCompanies.reduce((sum, c) => sum + (c.crawlerData?.length || 0), 0);
    console.log(`   📄 Total pages crawled: ${totalPages}`);
    console.log(`   ⏱️  Time: ${elapsed}s`);
    console.log(`   ✅ Final verification: ${finalVerified ? 'PASSED ✓' : 'FAILED ✗'}`);
    console.log(`   💾 Saved to: ${OUTPUT_FILE}`);
    console.log(`\n📋 File format:`);
    console.log(`   Each company preserves original fields + new crawlerData`);
    console.log(`   crawlerData: [{page: url, data: content, links_found: count}, ...]`);
    console.log('\n' + '='.repeat(70));

  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
  }
}

main();
