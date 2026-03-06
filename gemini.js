import { GoogleGenAI, FunctionCallingConfigMode, Type } from "@google/genai";
import dotenv from "dotenv";
import { initScraper, scrapeUrl } from "./funcs/webScraperModule.js";
import readline from "readline";

dotenv.config();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
initScraper();

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

    // 1. Initial request
    let response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents,
        config: toolConfig,         
    });

    const functionCalls = response.functionCalls;

    if (functionCalls && functionCalls.length > 0) {
        const fn = functionCalls[0];
        console.log(`Calling tool: ${fn.name} with`, fn.args);

        const toolResult = await scrapeUrl(fn.args.url);

        // 2. Append model response + tool result to history
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

        // 3. Get final summary — no toolConfig needed here
        const finalResponse = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents,
        });

        console.log(finalResponse.text);
    } else {
        console.log(response.text);
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question("Enter your prompt: ", (answer) => {
    askGemini(answer).then(() => rl.close());
});
