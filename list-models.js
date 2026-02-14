// Script to list available Gemini models
// Run this in Node.js or browser console with your API key

const API_KEY = "AIzaSyAETrp1leG3Z7MniBnDT42tLS-c0wLRq-Q"; // Replace with your API key

async function listModels() {
  try {
    const url = "https://generativelanguage.googleapis.com/v1beta/models";
    const response = await fetch(`${url}?key=${API_KEY}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error:", response.status, errorText);
      return;
    }
    
    const data = await response.json();
    console.log("Available Models:");
    console.log("=================");
    
    if (data.models) {
      data.models.forEach(model => {
        console.log(`\nModel: ${model.name}`);
        console.log(`  Display Name: ${model.displayName || 'N/A'}`);
        console.log(`  Description: ${model.description || 'N/A'}`);
        console.log(`  Supported Methods: ${model.supportedGenerationMethods?.join(', ') || 'N/A'}`);
        console.log(`  Input Token Limit: ${model.inputTokenLimit || 'N/A'}`);
        console.log(`  Output Token Limit: ${model.outputTokenLimit || 'N/A'}`);
      });
    } else {
      console.log("No models found or unexpected response:", data);
    }
  } catch (error) {
    console.error("Failed to fetch models:", error);
  }
}

// For browser console usage
if (typeof window !== 'undefined') {
  window.listGeminiModels = listModels;
  console.log("Run listGeminiModels() to see available models");
}

// For Node.js usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { listModels };
}
