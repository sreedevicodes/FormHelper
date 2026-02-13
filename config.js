// Configuration for Form Helper Extension
// Add your Gemini API key here
// Get your API key from: https://makersuite.google.com/app/apikey

const FORM_HELPER_CONFIG = {
  GEMINI_API_KEY: "", // Add your Gemini API key here
  GEMINI_API_URL: "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
  USE_AI_SUGGESTIONS: true, // Set to false to use fallback suggestions
  CACHE_SUGGESTIONS: true, // Cache suggestions to reduce API calls
  MAX_CACHE_SIZE: 100 // Maximum number of cached suggestions
};
