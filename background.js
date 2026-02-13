// Background service worker - makes Gemini API calls to avoid CORS (content script fetch is blocked)
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === "GEMINI_CHAT") {
    const { apiUrl, apiKey, prompt, context } = request;
    if (!apiUrl || !apiKey || !prompt) {
      sendResponse({ error: "Missing apiUrl, apiKey, or prompt" });
      return true;
    }

    // Construct a rich prompt with context
    let systemPrompt = "You are a helpful form-filling assistant. User is filling out a form on '" + (context.pageTitle || "a website") + "'.\\n";

    if (context.activeField) {
      systemPrompt += "\\nCurrently Active Field:\\n";
      systemPrompt += "- Label: " + context.activeField.label + "\\n";
      systemPrompt += "- Type: " + context.activeField.type + "\\n";
      systemPrompt += "- Required: " + context.activeField.required + "\\n";
      systemPrompt += "- Current Value: " + context.activeField.value + "\\n";
    }

    if (context.fileUploads && context.fileUploads.length > 0) {
      systemPrompt += "\\nFile Upload Fields on Page:\\n";
      context.fileUploads.forEach(f => {
        systemPrompt += "- " + f.label + " (Accepts: " + (f.accept || "any") + ")\\n";
      });
      systemPrompt += "\\nIf the user asks about file uploads, explain restrictions, help with file conversion (e.g. 'You can use an online tool to convert PNG to JPG'), or compressing files if they are too large (mention likely limits like 5MB or 10MB if not specified).\\n";
    }

    systemPrompt += "\\nAnswer the user's question concisely. If they ask for a value, suggest one. If they ask for help, explain what the field likely expects.";

    const fullPrompt = systemPrompt + "\\n\\nUser Question: " + prompt;

    const url = `${apiUrl}?key=${apiKey}`;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }]
      })
    })
      .then((res) => {
        if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
        return res.json();
      })
      .then((data) => {
        if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
          sendResponse({ text: data.candidates[0].content.parts[0].text.trim() });
        } else {
          const err = data.error?.message || JSON.stringify(data);
          sendResponse({ error: err });
        }
      })
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }

  if (request.type !== "GEMINI_SUGGESTION") return;

  const { apiUrl, apiKey, prompt } = request;
  if (!apiUrl || !apiKey || !prompt) {
    sendResponse({ error: "Missing apiUrl, apiKey, or prompt" });
    return true;
  }
  const url = `${apiUrl}?key=${apiKey}`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  })
    .then((res) => {
      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
      return res.json();
    })
    .then((data) => {
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        const text = data.candidates[0].content.parts[0].text.trim();
        const clean = text.replace(/^["']|["']$/g, "").trim();
        sendResponse({ value: clean.toLowerCase() === "null" || !clean ? null : clean });
      } else {
        const err = data.error?.message || JSON.stringify(data);
        sendResponse({ error: err });
      }
    })
    .catch((err) => sendResponse({ error: err.message || String(err) }));
  return true; // async response
});
