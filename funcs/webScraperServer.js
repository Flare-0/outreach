import { chromium } from "playwright";
import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3333;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const BLOCKED = new Set(["image", "stylesheet", "font", "media", "ping"]);

let browser = null;

// --- boot browser immediately on startup ---
async function initBrowser() {
  browser = await chromium.launch({ headless: true });
  console.log("🟢 Browser ready");

  browser.on("disconnected", async () => {
    console.log("🔴 Browser disconnected, restarting...");
    browser = await chromium.launch({ headless: true });
    console.log("🟢 Browser restarted");
  });
}

async function scrapeUrl(url) {
  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({ "User-Agent": UA });

  await page.route("**/*", (route) => {
    BLOCKED.has(route.request().resourceType()) ? route.abort() : route.continue();
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
  } catch {
    // partial load is fine, we just need the DOM
  }

  const result = await page.evaluate(() => {
    const lines = [];

    function walk(node, depth = 0) {
      if (!node) return;
      const indent = "  ".repeat(depth);

      const skipTags = new Set([
        "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH",
        "HEAD", "META", "LINK", "TEMPLATE",
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

  await page.close();
  return result;
}

// --- routes ---

app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  const start = Date.now();
  try {
    const text = await scrapeUrl(url);
    res.json({ url, text, ms: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: err.message, ms: Date.now() - start });
  }
});

app.get("/health", (_, res) => {
  res.json({ status: "ok", browser: !!browser?.isConnected() });
});

// --- start ---
initBrowser().then(() => {
  app.listen(PORT, () => console.log(`🚀 Scraper API running on http://localhost:${PORT}`));
});