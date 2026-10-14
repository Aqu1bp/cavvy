const baseUrl = process.env.BASE_URL;
const model = process.env.MODEL;
const apiKey = process.env.API_KEY;

const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: model,
    messages: [
      { role: "user", content: "Say hi in 5 words" },
    ],
  }),
});

console.log("Status:", response.status);

const data = await response.json();

const reply = data.choices[0].message.content;

console.log("Claude reply:", reply);
