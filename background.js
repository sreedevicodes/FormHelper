// Background service worker - makes Gemini API calls to avoid CORS (content script fetch is blocked)
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === "GEMINI_CHAT") {
    const { apiUrl, apiKey, prompt, context } = request;
    if (!apiUrl || !apiKey || !prompt) {
      sendResponse({ error: "Missing apiUrl, apiKey, or prompt" });
      return true;
    }

    // Construct a rich prompt with context
    let systemPrompt = "You are a helpful form-filling assistant. User is filling out a form on '" + (context.pageTitle || "a website") + "'.\\n\\n";

    // Add form fields context
    if (context.allFields && context.allFields.length > 0) {
      systemPrompt += "FORM FIELDS ON THIS PAGE:\\n";
      context.allFields.forEach(f => {
        const status = f.value ? `[filled: "${f.value}"]` : "[empty]";
        systemPrompt += `- "${f.label}" (${f.type}) ${status}\\n`;
      });
      systemPrompt += "\\n";
    }

    // Add stored form data context
    if (context.storedFormData && context.storedFormData.length > 0) {
      systemPrompt += "USER'S PREVIOUSLY ENTERED DATA:\\n";
      context.storedFormData.forEach(d => {
        systemPrompt += `- "${d.fieldLabel}" (${d.fieldName}): "${d.value}"\\n`;
      });
      systemPrompt += "\\n";
    }

    if (context.fileUploads && context.fileUploads.length > 0) {
      systemPrompt += "FILE UPLOAD FIELDS:\\n";
      context.fileUploads.forEach(f => {
        systemPrompt += "- " + f.label + " (Accepts: " + (f.accept || "any") + ")\\n";
      });
      systemPrompt += "\\n";
    }

    // Intent classification instructions
    systemPrompt += "INSTRUCTIONS:\\n";
    systemPrompt += "1. Classify the user's intent:\\n";
    systemPrompt += "   - 'fill_form': User wants to fill/complete the entire form\\n";
    systemPrompt += "   - 'fill_field': User wants to fill a specific field\\n";
    systemPrompt += "   - 'question': User is asking a question or needs help\\n";
    systemPrompt += "2. If intent is 'fill_form', respond with: INTENT:fill_form\\n";
    systemPrompt += "3. If intent is 'fill_field', respond with: INTENT:fill_field [field name]\\n";
    systemPrompt += "4. Otherwise, answer the question helpfully.\\n";
    systemPrompt += "5. Use stored form data to provide better suggestions when relevant.\\n\\n";

    const fullPrompt = systemPrompt + "User Question: " + prompt;

    // Google Gemini REST API uses header-based authentication: x-goog-api-key
    const url = apiUrl;
    console.log("Form Helper Background: Making Gemini CHAT API request to:", url);
    
    fetch(url, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }]
      })
    })
      .then(async (res) => {
        console.log("Form Helper Background: CHAT API Response status:", res.status, res.statusText);
        if (!res.ok) {
          const errorText = await res.text();
          console.error("Form Helper Background: CHAT API Error Response:", errorText);
          throw new Error(`API ${res.status}: ${res.statusText} - ${errorText.substring(0, 200)}`);
        }
        return res.json();
      })
      .then((data) => {
        if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
          const responseText = data.candidates[0].content.parts[0].text.trim();
          
          // Parse intent from response
          let intent = "question";
          const intentMatch = responseText.match(/INTENT:(fill_form|fill_field|question)(?:\s+([^\n]+))?/i);
          if (intentMatch) {
            intent = intentMatch[1].toLowerCase();
            const cleanText = responseText.replace(/INTENT:[^\n]+\n?/gi, "").trim();
            sendResponse({ 
              text: cleanText || responseText, 
              intent: intent,
              fieldName: intentMatch[2] || null
            });
          } else {
            // Check if response suggests filling form
            const lowerText = responseText.toLowerCase();
            if (lowerText.includes("filling") || lowerText.includes("fill the form") || lowerText.includes("autofill")) {
              sendResponse({ text: responseText, intent: "fill_form" });
            } else {
              sendResponse({ text: responseText, intent: "question" });
            }
          }
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
  
  // Google Gemini REST API uses header-based authentication: x-goog-api-key
  const url = apiUrl;
  console.log("Form Helper Background: Making Gemini API request to:", url);
  console.log("Form Helper Background: Request payload:", JSON.stringify({ contents: [{ parts: [{ text: prompt.substring(0, 100) + "..." }] }] }));
  
  fetch(url, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  })
    .then(async (res) => {
      console.log("Form Helper Background: API Response status:", res.status, res.statusText);
      if (!res.ok) {
        const errorText = await res.text();
        console.error("Form Helper Background: API Error Response:", errorText);
        throw new Error(`API ${res.status}: ${res.statusText} - ${errorText.substring(0, 200)}`);
      }
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
