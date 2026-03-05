
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({quiet: true});

const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});

async function main() {
    try {
        const response = await client.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [
                {
                    role: "user",
                    content: "Hello!"
                }
            ],
        });
        console.log(response.choices[0].message.content);
    } catch (error) {
        console.error("Error:", error);
    }
}

main();
