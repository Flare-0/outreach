import { GoogleGenAI, FunctionCallingConfigMode, Type } from "@google/genai";
import dotenv from "dotenv";
import { initScraper, scrapeUrl } from "./funcs/webScraperModule.js";
import readline from "readline";

dotenv.config();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
initScraper();

// Cache for scraped URLs to avoid re-fetching
const scrapedUrlCache = new Map();

const scraperTool = {
    name: 'Get_webpage_content',
    description: 'Returns simplified text of a webpage.',
    parameters: {
        type: Type.OBJECT,           // ✅ use Type import
        properties: {
            url: { type: Type.STRING, description: 'The URL to scrape' },
        },
        required: ['url'],
    },
};

const toolConfig = {
    tools: [{ functionDeclarations: [scraperTool] }],
    toolConfig: {
        functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,           // ✅ FORCES tool use
            allowedFunctionNames: ['Get_webpage_content'],
        },
    },
};

async function askGemini(msg) {
    const contents = [{ role: 'user', parts: [{ text: msg }] }];

    // 1. Initial request with faster model
    console.log('🤖 Sending request to Gemini...');
    let response = await ai.models.generateContent({
        model: "gemini-2.0-flash",  // Faster than gemini-3-flash-preview
        contents,
        config: toolConfig,         
    });

    const functionCalls = response.functionCalls;

    if (functionCalls && functionCalls.length > 0) {
        const fn = functionCalls[0];
        console.log(`📞 Calling tool: ${fn.name}`);
        console.log(`🔗 URL: ${fn.args.url}`);

        // Check cache first (avoid re-scraping same URLs)
        let toolResult;
        if (scrapedUrlCache.has(fn.args.url)) {
            console.log('⚡ Using cached page content');
            toolResult = scrapedUrlCache.get(fn.args.url);
        } else {
            console.log('🌐 Scraping page...');
            toolResult = await scrapeUrl(fn.args.url);
            scrapedUrlCache.set(fn.args.url, toolResult); // Cache for future reuse
        }

        // 2. Append model response + tool result to history
        console.log('📝 Processing results...');
        contents.push({ role: 'model', parts: response.candidates[0].content.parts });
        contents.push({
            role: 'user',
            parts: [{
                functionResponse: {
                    name: fn.name,
                    response: { content: toolResult }
                }
            }]
        });

        // 3. Get final summary with faster model
        console.log('💭 Generating summary...');
        const finalResponse = await ai.models.generateContent({
            model: "gemini-2.0-flash",  // Faster model
            contents,
        });

        console.log('✅ Done!\n');
        console.log(finalResponse.text);
    } else {
        console.log('✅ Done!\n');
        console.log(response.text);
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log('🚀 Gemini Web Scraper Initialized\n');
rl.question("❓ Enter your prompt: ", (answer) => {
    askGemini(answer).then(() => {
        console.log('\n👋 Goodbye!');
        rl.close();
    }).catch(err => {
        console.error('❌ Error:', err);
        rl.close();
    });
});
