require('dotenv').config();

async function check() {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      console.log("❌ .env file me GEMINI_API_KEY nahi mili!");
      return;
    }

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    const data = await res.json();

    if (data.error) {
      console.error("❌ API ERROR:", data.error.message);
      return;
    }

    console.log("✅ TERI KEY PAR YE MODELS AVAILABLE HAIN:\n");
    data.models.forEach(m => {
      if (m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent")) {
        console.log("👉 " + m.name.replace("models/", ""));
      }
    });
  } catch (err) {
    console.error("❌ ERROR:", err.message);
  }
}

check();