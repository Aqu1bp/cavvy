const baseUrl = process.env.BASE_URL;
const model = process.env.MODEL;
const apiKey = process.env.API_KEY;


type Message = {
    role: "user" | "assistant";
    content: string;
}

type ChatResponse = {
    choices: {
        message: Message;
        finish_reason: string;
    }[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
    };
}

const messages: Message[] = [];

console.log('Chat started. Type "exit" to quit.\n');

while (true) {

    const input = prompt("You:");

    if (input === null || input.toLowerCase() === "exit") {
        console.log("Exiting chat...");
        break;
    }

    messages.push({ role: "user", content: input });

    const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: model, messages: messages }),
    });

    if (!response.ok) {
        console.error(`Error: ${response.status}`, await response.text());
        messages.pop(); // Remove the last user message if the request failed
        continue;
    }
    const data = (await response.json()) as ChatResponse;

    const choice = data.choices[0];
    const tokensIn = data.usage?.prompt_tokens ?? 0;
    const tokensOut = data.usage?.completion_tokens ?? 0;

    if (!choice) {
        console.error("Error: No choices returned from the API.");
        messages.pop(); // Remove the last user message if no choices were returned
        continue;
    }

    const assistantMessage = choice.message.content;
    messages.push({ role: "assistant", content: assistantMessage });
    console.log("\nClaude:", assistantMessage,"");
    console.log(`(Tokens: ${tokensIn} in, ${tokensOut} out)\n`);
}

console.log("Chat ended.");