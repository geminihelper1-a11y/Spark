require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function test() {
  try {
    console.log("Testing API Key...");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });

    console.log("Fetching response...");
    const result = await model.generateContent("Say 'Hello' if this works.");
    console.log("✅ SUCCESS! Response:", result.response.text());
  } catch (err) {
    console.error("❌ FAILED. Error details:", err.message);
  }
}

test();