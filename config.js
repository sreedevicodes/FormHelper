// Configuration for Form Helper Extension
// Add your Gemini API key here
// Get your API key from: https://makersuite.google.com/app/apikey

window.FORM_HELPER_CONFIG = {
  GEMINI_API_KEY: "AIzaSyAEfMvSJ3Hsl462l6LuhiJnONUl7YIjKec", // Add your Gemini API key here
  // Using gemini-3-flash-preview (available in v1beta, optimized for speed and scale)
  // Using v1beta endpoint with header-based authentication
  GEMINI_API_URL: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
  USE_AI_SUGGESTIONS: true, // Set to false to use fallback suggestions
  CACHE_SUGGESTIONS: true, // Cache suggestions to reduce API calls
  MAX_CACHE_SIZE: 100, // Maximum number of cached suggestions
  AUTO_FILL_HIGH_CONFIDENCE: false // Auto-fill fields when LLM confidence is high (email, phone, etc.)
};
