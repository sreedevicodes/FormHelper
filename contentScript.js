(() => {
  let fields = [];
  let userProfile = {};
  let suggestionCache = {}; // Cache for AI suggestions
  let pendingSuggestions = new Map(); // Track pending API calls
  let apiBackoffUntil = 0; // Timestamp until which API is disabled due to 429
  let lastApiRequestTime = 0; // Track last API request timestamp
  let minRequestInterval = 1000; // Minimum 1000ms (1 second) between API requests (throttle burst requests)
  let requestThrottleTimer = null; // Timer for throttling requests


  function loadProfile(callback) {
    if (!("chrome" in window) || !chrome.storage) {
      if (callback) callback();
      return;
    }
    const storage = chrome.storage.sync || chrome.storage.local;
    storage.get({ formHelperProfile: {} }, data => {
      if (data && typeof data.formHelperProfile === "object") {
        userProfile = data.formHelperProfile;
      }
      if (callback) callback();
    });
  }

  function saveProfile() {
    if (!("chrome" in window) || !chrome.storage) return;
    const storage = chrome.storage.sync || chrome.storage.local;
    storage.set({ formHelperProfile: userProfile });
  }

  function getProfileKeyForField(el) {
    if (!el) return null;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const name = (el.getAttribute("name") || el.getAttribute("id") || "").toLowerCase();
    const label = getFieldLabel(el).toLowerCase();
    const key = `${name} ${label}`.trim();

    if (type === "email" || /email/.test(key)) return "email";
    if (type === "tel" || /phone|mobile|contact/.test(key)) return "phone";
    if (/name|full name/.test(key) && !/user|username/.test(key)) return "fullName";
    if (/username|user name|handle/.test(key)) return "username";
    if (/city/.test(key)) return "city";
    if (/country/.test(key)) return "country";
    if (/zip|postal/.test(key)) return "zip";
    if (/address/.test(key)) return "address";
    if (/company|organization|organisation/.test(key)) return "company";
    if (type === "url" || /website|site/.test(key)) return "website";
    if (/age/.test(key)) return "age";

    return null;
  }

  function updateProfileForField(el, value) {
    const val = (value || "").trim();
    if (!el || !val) return;
    const profileKey = getProfileKeyForField(el);
    if (!profileKey) return;
    userProfile[profileKey] = val;
    saveProfile();
  }

  function loadOverrideHistory() {
    try {
      const stored = localStorage.getItem("formHelperOverrides");
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  }

  function saveOverrideHistory(history) {
    try {
      localStorage.setItem("formHelperOverrides", JSON.stringify(history));
    } catch (e) {
      console.warn("Failed to save override history:", e);
    }
  }

  function recordOverride(field, suggestedValue, action, userValue = null) {
    if (!field || !suggestedValue) return;

    const overrideRecord = {
      timestamp: new Date().toISOString(),
      fieldLabel: getFieldLabel(field),
      fieldName: field.getAttribute("name") || field.getAttribute("id") || "",
      fieldType: field.getAttribute("type") || field.tagName.toLowerCase(),
      profileKey: getProfileKeyForField(field),
      suggestedValue: suggestedValue,
      action: action, // "override" (filled manually) or "ignore" (skipped)
      userValue: userValue || null,
      pageUrl: window.location.href,
      pageTitle: document.title
    };

    const history = loadOverrideHistory();
    history.push(overrideRecord);

    // Keep only last 1000 overrides to prevent localStorage bloat
    if (history.length > 1000) {
      history.splice(0, history.length - 1000);
    }

    saveOverrideHistory(history);
  }

  function getOverrideHistory() {
    return loadOverrideHistory();
  }

  // ========== IndexedDB Storage Module ==========
  let db = null;
  const DB_NAME = "FormHelperDB";
  const DB_VERSION = 1;
  const STORE_NAME = "formData";

  function initIndexedDB() {
    return new Promise((resolve, reject) => {
      if (db) {
        resolve(db);
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error("Form Helper: IndexedDB error:", request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        db = request.result;
        console.log("Form Helper: IndexedDB initialized");
        resolve(db);
      };

      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const objectStore = database.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
          objectStore.createIndex("pageUrl", "pageUrl", { unique: false });
          objectStore.createIndex("timestamp", "timestamp", { unique: false });
          objectStore.createIndex("fieldName", "fieldName", { unique: false });
        }
      };
    });
  }

  function storeFormData(fieldData) {
    if (!db) {
      console.warn("Form Helper: IndexedDB not initialized");
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      
      const data = {
        fieldLabel: fieldData.label || "",
        fieldName: fieldData.name || "",
        fieldType: fieldData.type || "",
        fieldId: fieldData.id || "",
        value: fieldData.value || "",
        pageUrl: fieldData.pageUrl || window.location.href,
        pageTitle: fieldData.pageTitle || document.title,
        timestamp: fieldData.timestamp || new Date().toISOString()
      };

      const request = store.add(data);

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        console.warn("Form Helper: Failed to store form data:", request.error);
        reject(request.error);
      };
    });
  }

  function storeFormSubmission(formData) {
    if (!db) {
      console.warn("Form Helper: IndexedDB not initialized");
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      
      const timestamp = new Date().toISOString();
      const pageUrl = window.location.href;
      const pageTitle = document.title;

      // Store each field
      const promises = formData.fields.map(field => {
        const data = {
          fieldLabel: field.label || "",
          fieldName: field.name || "",
          fieldType: field.type || "",
          fieldId: field.id || "",
          value: field.value || "",
          pageUrl: pageUrl,
          pageTitle: pageTitle,
          timestamp: timestamp,
          formSubmission: true
        };
        return new Promise((res, rej) => {
          const req = store.add(data);
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
      });

      Promise.all(promises)
        .then(() => {
          console.log(`Form Helper: Stored ${formData.fields.length} fields in IndexedDB`);
          resolve();
        })
        .catch((error) => {
          console.warn("Form Helper: Failed to store form submission:", error);
          reject(error);
        });
    });
  }

  function getStoredFormData(limit = 100) {
    if (!db) {
      console.warn("Form Helper: IndexedDB not initialized");
      return Promise.resolve([]);
    }

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("timestamp");
      const request = index.openCursor(null, "prev"); // Get most recent first

      const results = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      request.onerror = () => {
        console.warn("Form Helper: Failed to retrieve form data:", request.error);
        reject(request.error);
      };
    });
  }

  function getCacheKeyForField(el) {
    if (!el) return null;
    const type = el.getAttribute("type") || "";
    const name = el.getAttribute("name") || "";
    const id = el.getAttribute("id") || "";
    const label = getFieldLabel(el);
    return `${type}|${name}|${id}|${label}`.toLowerCase();
  }

  async function getGeminiSuggestion(field) {
    if (!field) return null;

    // Check cache first (memory + local storage)
    const cacheKey = getCacheKeyForField(field);

    // Memory cache
    if (cacheKey && suggestionCache[cacheKey]) {
      return suggestionCache[cacheKey];
    }

    // Local Storage cache (persist across reloads)
    try {
      const storedCache = localStorage.getItem("fh_suggestion_cache");
      if (storedCache) {
        const parsed = JSON.parse(storedCache);
        if (parsed[cacheKey]) {
          suggestionCache[cacheKey] = parsed[cacheKey]; // Hydrate memory cache
          return parsed[cacheKey];
        }
      }
    } catch (e) {
      console.warn("Form Helper: Failed to read local cache", e);
    }

    // Check if we are in a backoff period
    if (Date.now() < apiBackoffUntil) {
      console.warn("Form Helper: API is cooling down due to rate limits.");
      return null; // Force fallback to local logic
    }

    // Check if API is configured
    if (!FORM_HELPER_CONFIG || !FORM_HELPER_CONFIG.GEMINI_API_KEY || !FORM_HELPER_CONFIG.USE_AI_SUGGESTIONS) {
      return null;
    }

    // Check chrome runtime context before proceeding
    if (!chrome.runtime?.id) {
      console.warn("Form Helper: Extension context invalidated.");
      return null;
    }

    // Check if there's already a pending request for this field
    if (pendingSuggestions.has(cacheKey)) {
      return pendingSuggestions.get(cacheKey);
    }

    // Build context for the AI (needed before throttling check)
    const fieldType = field.getAttribute("type") || field.tagName.toLowerCase();
    const fieldName = field.getAttribute("name") || "";
    const fieldId = field.getAttribute("id") || "";
    const fieldLabel = getFieldLabel(field);
    const placeholder = field.getAttribute("placeholder") || "";
    const isRequired = field.hasAttribute("required");
    const pageTitle = document.title;
    const pageUrl = window.location.href;

    // Get form context - all other fields in the same form
    const form = field.closest("form");
    const formContext = form ? getFormContext(form, field) : "";

    // Get user profile context
    const profileContext = Object.keys(userProfile).length > 0
      ? `User's previously stored information: ${JSON.stringify(userProfile)}`
      : "";

    // Get IndexedDB stored form data context
    let indexedDBContext = "";
    try {
      const storedData = await getStoredFormData(20);
      if (storedData && storedData.length > 0) {
        const recentData = storedData.slice(0, 10).map(d => 
          `"${d.fieldLabel}" (${d.fieldName}): "${d.value}"`
        ).join("; ");
        indexedDBContext = `User previously entered: ${recentData}`;
      }
    } catch (e) {
      console.warn("Form Helper: Failed to load IndexedDB context:", e);
    }

    // Get override history context
    const overrideHistory = getOverrideHistory();
    const recentOverrides = overrideHistory.slice(-5).map(ov =>
      `Field "${ov.fieldLabel}": User overrode suggestion "${ov.suggestedValue}" with "${ov.userValue || 'skipped'}"`
    ).join("; ");
    const overrideContext = recentOverrides ? `Recent user preferences: ${recentOverrides}` : "";

    // Get page context (headings, nearby text)
    const pageContext = getPageContext(field);

    const prompt = `You are an intelligent form-filling assistant. Generate a single, contextually appropriate value for a form field based on all available context.

CURRENT FIELD TO FILL:
- Label: "${fieldLabel}"
- Name attribute: "${fieldName}"
- ID attribute: "${fieldId}"
- Type: "${fieldType}"
- Placeholder: "${placeholder}"
- Required: ${isRequired}

PAGE CONTEXT:
- Page Title: "${pageTitle}"
- Page URL: "${pageUrl}"
${pageContext ? `- Page Content Context: ${pageContext}\n` : ""}

${formContext ? `OTHER FIELDS IN THIS FORM:\n${formContext}\n` : ""}
${profileContext ? `USER PROFILE (previously saved data):\n${profileContext}\n` : ""}
${indexedDBContext ? `USER PREVIOUSLY ENTERED DATA:\n${indexedDBContext}\n` : ""}
${overrideContext ? `USER PREFERENCES (recent overrides):\n${overrideContext}\n` : ""}

INSTRUCTIONS:
1. Analyze ALL context above to generate the most appropriate value
2. Use relationships between fields (e.g., if "First Name" is "John", suggest "John" for "Username" or "john.doe@example.com" for email)
3. Use form context to understand the purpose (e.g., if it's a registration form, generate registration-appropriate values)
4. Use user profile data when relevant and available
5. Return ONLY the value, no explanation, no quotes, no markdown
6. For email fields: generate a realistic email (can derive from name fields if available)
7. For phone fields: generate a valid phone number format
8. For URL fields: generate a valid URL format
9. For number fields: generate an appropriate number
10. For text fields: generate realistic text based on label and context
11. Keep values concise (max 50 characters for text fields)
12. If you cannot determine an appropriate value, return "null"

Generate the value:`;

    // Throttle API requests to prevent bursts
    const now = Date.now();
    const timeSinceLastRequest = now - lastApiRequestTime;
    
    // If request is too soon after last request, delay it
    if (timeSinceLastRequest < minRequestInterval && lastApiRequestTime > 0) {
      const delay = minRequestInterval - timeSinceLastRequest;
      console.log(`Form Helper: Throttling API request for "${getFieldLabel(field)}" (${delay}ms delay to prevent burst)`);
      
      // Create a delayed promise wrapper
      const delayedPromise = new Promise((resolve) => {
        requestThrottleTimer = setTimeout(async () => {
          // Re-check cache in case it was populated during the delay
          if (cacheKey && suggestionCache[cacheKey]) {
            resolve(suggestionCache[cacheKey]);
            return;
          }
          // Make the actual API call
          const result = await makeGeminiApiCall(field, cacheKey, prompt);
          resolve(result);
        }, delay);
      });
      
      pendingSuggestions.set(cacheKey, delayedPromise);
      return delayedPromise;
    }

    // Make the actual API call (extracted to separate function for reuse)
    return makeGeminiApiCall(field, cacheKey, prompt);
  }

  async function makeGeminiApiCall(field, cacheKey, prompt) {
    if (!field || !cacheKey || !prompt) return null;

    try {
      const apiKey = FORM_HELPER_CONFIG.GEMINI_API_KEY;
      const apiUrl = FORM_HELPER_CONFIG.GEMINI_API_URL.replace(/\?.*$/, ""); // base URL without key

      // Update last request time before making the request
      lastApiRequestTime = Date.now();
      console.log(`Form Helper: Making API request for field: ${getFieldLabel(field)}`);
      console.log(`Form Helper: API URL: ${apiUrl.replace(/\?.*$/, "")}`);
      console.log(`Form Helper: Sending message to background script...`);

      const suggestionPromise = new Promise((resolve, reject) => {
        if (!chrome.runtime?.id) {
          return reject(new Error("Extension context invalidated"));
        }
        chrome.runtime.sendMessage({
          type: "GEMINI_SUGGESTION",
          apiUrl,
          apiKey,
          prompt
        }, (response) => {
          if (chrome.runtime.lastError) {
            return reject(chrome.runtime.lastError);
          }
          resolve(response);
        });
      })
        .then((res) => {
          if (res.error) {
            console.warn("Form Helper Gemini API:", res.error);
            // Check for Rate Limit (429)
            if (String(res.error).includes("429")) {
              console.warn("Form Helper: Rate limit hit. Backing off for 60 seconds.");
              apiBackoffUntil = Date.now() + 60000; // 60s cooldown
            }
            return null;
          }
          const cleanText = (res.value || "").trim();
          if (!cleanText || cleanText.toLowerCase() === "null") return null;

          if (cacheKey && FORM_HELPER_CONFIG.CACHE_SUGGESTIONS) {
            // Update memory cache
            suggestionCache[cacheKey] = cleanText;
            const keys = Object.keys(suggestionCache);
            if (keys.length > FORM_HELPER_CONFIG.MAX_CACHE_SIZE) {
              delete suggestionCache[keys[0]];
            }

            // Update local storage cache
            try {
              const stored = localStorage.getItem("fh_suggestion_cache");
              const parsed = stored ? JSON.parse(stored) : {};
              parsed[cacheKey] = cleanText;

              // Keep local storage from growing indefinitely (simple strategy)
              const storedKeys = Object.keys(parsed);
              if (storedKeys.length > 500) {
                // remove oldest 100 roughly (keys order not guaranteed but okay for simple cache)
                for (let i = 0; i < 100; i++) delete parsed[storedKeys[i]];
              }
              localStorage.setItem("fh_suggestion_cache", JSON.stringify(parsed));
            } catch (e) {
              console.warn("Failed to write to local cache", e);
            }
          }
          return cleanText;
        })
        .catch((err) => {
          console.warn("Form Helper Gemini API Error:", err?.message || err);
          return null;
        })
        .finally(() => {
          pendingSuggestions.delete(cacheKey);
        });

      pendingSuggestions.set(cacheKey, suggestionPromise);
      return suggestionPromise;
    } catch (error) {
      console.warn("Form Helper Gemini API Critical Error:", error);
      pendingSuggestions.delete(cacheKey);
      return null;
    }
  }

  /**
   * Set value on an input/textarea/select. Uses execCommand('insertText') for INPUT/TEXTAREA
   * because it simulates user input and works with React/Vue controlled components in
   * Chrome extension content scripts (isolated world). Falls back to value + events if needed.
   */
  function setFieldValue(el, value) {
    if (!el || value == null) return;
    const strVal = String(value).trim();
    if (strVal === "") return;

    const tag = el.tagName.toUpperCase();

    if (tag === "SELECT") {
      const options = Array.from(el.options || []);
      let option = options.find((o) => o.value === strVal) ||
        options.find((o) => o.text.trim() === strVal) ||
        options.find((o) => o.text.trim().toLowerCase() === strVal.toLowerCase());
      if (option) {
        el.value = option.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    if (tag === "INPUT" || tag === "TEXTAREA") {
      el.focus();
      // Select all existing content so insertText replaces it; skip for types that don't support selection (email, number, etc.)
      try {
        el.setSelectionRange(0, (el.value || "").length);
      } catch (_) { /* email, number, etc. don't support setSelectionRange */ }
      const success = document.execCommand("insertText", false, strVal);
      if (!success) {
        el.value = strVal;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }

  function getFallbackSuggestion(el) {
    if (!el) return null;

    const type = (el.getAttribute("type") || "").toLowerCase();
    const name = (el.getAttribute("name") || el.getAttribute("id") || "").toLowerCase();
    const label = getFieldLabel(el).toLowerCase();
    const key = `${name} ${label}`.trim();

    // Match by type first (most specific)
    if (type === "email") {
      return "user@example.com";
    }
    if (type === "tel") {
      return "+1 555 123 4567";
    }
    if (type === "url") {
      return "https://example.com";
    }
    if (type === "number" && /age/.test(key)) {
      return "25";
    }

    // Then match by name/label patterns (more specific patterns first)
    if (/^email|emailaddress|e-mail/i.test(name) || /^email|e-mail/i.test(label)) {
      return "user@example.com";
    }
    if (/^phone|tel|mobile|contact/i.test(name) || /^phone|mobile|contact/i.test(label)) {
      return "+1 555 123 4567";
    }
    if (/^fullname|full_name|fullname/i.test(name) || /^full\s+name/i.test(label)) {
      return "John Doe";
    }
    if (/^username|user_name|user_name/i.test(name) || /^username|user\s+name|handle/i.test(label)) {
      return "john_doe_01";
    }
    if (/^city/i.test(name) || /^city$/i.test(label)) {
      return "New York";
    }
    if (/^country/i.test(name) || /^country$/i.test(label)) {
      return "United States";
    }
    if (/^zip|postal|postcode/i.test(name) || /^zip|postal/i.test(label)) {
      return "12345";
    }
    if (/^address|street/i.test(name) || /^address|street/i.test(label)) {
      return "123 Example Street";
    }
    if (/^company|organization|organisation/i.test(name) || /^company|organization/i.test(label)) {
      return "Example Corp";
    }
    if (/^website|site|url/i.test(name) || /^website|site/i.test(label)) {
      return "https://example.com";
    }
    if (/^age/i.test(name) || /^age$/i.test(label)) {
      return "25";
    }

    // Fallback: check if label contains common patterns (less specific)
    if (/email/i.test(label) && !/username/i.test(label)) {
      return "user@example.com";
    }
    if (/phone|mobile|contact/i.test(label)) {
      return "+1 555 123 4567";
    }
    if (/name/i.test(label) && !/user|username/i.test(label)) {
      return "John Doe";
    }

    return null;
  }

  // Init function is now at the end of the file


  function isFieldRelevant(el) {
    if (!(el instanceof HTMLElement)) return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (["hidden", "button", "submit", "reset", "image"].includes(type)) return false;
    if (el.disabled || el.hasAttribute("readonly")) return false;
    return true;
  }

  function isFieldEmptyOrIncomplete(el) {
    if (!el) return false;
    if (el.tagName === "SELECT") {
      return !el.value || el.value === "";
    }
    const value = (el.value || "").trim();
    if (!value) return true;
    if (el.hasAttribute("required") && !el.checkValidity()) {
      return true;
    }
    return false;
  }

  function getFieldLabel(el) {
    if (!el) return "Field";
    const id = el.id;
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label && label.textContent) return label.textContent.trim();
    }
    const parentLabel = el.closest("label");
    if (parentLabel && parentLabel.textContent) {
      return parentLabel.textContent.trim();
    }
    const name = el.getAttribute("name") || el.getAttribute("id");
    if (name) return name.replace(/[_\-]+/g, " ");
    return "Field";
  }

  function getHelpText(el) {
    if (!el) return "";
    const ariaDescId = el.getAttribute("aria-describedby");
    if (ariaDescId) {
      const described = document.getElementById(ariaDescId);
      if (described && described.textContent) {
        return described.textContent.trim();
      }
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) {
      return `Hint: ${placeholder}`;
    }
    if (el.hasAttribute("required")) {
      return "This field is required. Please provide a valid value.";
    }
    return "You can fill this field manually or use the suggested value.";
  }

  function getFormContext(form, currentField) {
    if (!form) return "";
    
    const allFields = Array.from(form.querySelectorAll("input, textarea, select")).filter(isFieldRelevant);
    const filledFields = allFields
      .filter(f => f !== currentField && f.value && f.value.trim())
      .map(f => {
        const label = getFieldLabel(f);
        const value = f.value.trim();
        const type = f.getAttribute("type") || f.tagName.toLowerCase();
        return `  - "${label}" (${type}): "${value}"`;
      });

    const emptyFields = allFields
      .filter(f => f !== currentField && (!f.value || !f.value.trim()))
      .map(f => {
        const label = getFieldLabel(f);
        const type = f.getAttribute("type") || f.tagName.toLowerCase();
        return `  - "${label}" (${type}): [empty]`;
      });

    let context = "";
    if (filledFields.length > 0) {
      context += "Already filled fields:\n" + filledFields.join("\n");
    }
    if (emptyFields.length > 0 && filledFields.length > 0) {
      context += "\n\n";
    }
    if (emptyFields.length > 0) {
      context += "Other empty fields:\n" + emptyFields.slice(0, 10).join("\n"); // Limit to 10 to avoid token bloat
    }

    // Get form name/description if available
    const formName = form.getAttribute("name") || form.getAttribute("id") || "";
    const formTitle = form.querySelector("h1, h2, h3, legend, .form-title, [class*='title']");
    if (formTitle && formTitle.textContent) {
      context = `Form Purpose: "${formTitle.textContent.trim()}"\n\n${context}`;
    }

    return context;
  }

  function getPageContext(field) {
    // Get nearby headings and text to understand page context
    const context = [];
    
    // Get page heading
    const h1 = document.querySelector("h1");
    if (h1 && h1.textContent) {
      context.push(`Page heading: "${h1.textContent.trim()}"`);
    }

    // Get form section/container context
    const container = field.closest("section, div[class*='form'], div[class*='field'], fieldset");
    if (container) {
      const containerHeading = container.querySelector("h2, h3, h4, legend, [class*='title'], [class*='heading']");
      if (containerHeading && containerHeading.textContent) {
        const headingText = containerHeading.textContent.trim();
        if (headingText && headingText.length < 100) {
          context.push(`Section: "${headingText}"`);
        }
      }
    }

    // Get nearby description text
    const fieldset = field.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector("legend");
      if (legend && legend.textContent) {
        context.push(`Fieldset: "${legend.textContent.trim()}"`);
      }
    }

    return context.length > 0 ? context.join("; ") : "";
  }

  function shouldAutoFillField(field, suggestion, fieldType) {
    // Auto-fill fields with high confidence patterns
    if (!suggestion || suggestion.toLowerCase() === "null") return false;
    
    // High confidence patterns that are safe to auto-fill
    const highConfidencePatterns = {
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, // Valid email format
      tel: /^[\d\s\-\+\(\)]+$/, // Phone number pattern
      url: /^https?:\/\/.+/, // URL pattern
      number: /^\d+$/, // Simple number
    };

    // Check if suggestion matches high-confidence pattern
    if (fieldType === "email" && highConfidencePatterns.email.test(suggestion)) {
      return true;
    }
    if (fieldType === "tel" && highConfidencePatterns.tel.test(suggestion) && suggestion.length >= 10) {
      return true;
    }
    if (fieldType === "url" && highConfidencePatterns.url.test(suggestion)) {
      return true;
    }
    if (fieldType === "number" && highConfidencePatterns.number.test(suggestion)) {
      return true;
    }

    // Don't auto-fill text fields (too risky)
    return false;
  }

  // ========== Intent Detection ==========
  function detectFillIntent(message) {
    const lowerMessage = message.toLowerCase().trim();
    
    // Explicit commands
    const explicitPatterns = [
      /fill\s+(the\s+)?form/i,
      /autofill/i,
      /fill\s+all\s+fields/i,
      /complete\s+(the\s+)?form/i,
      /fill\s+everything/i,
      /auto\s+fill/i
    ];
    
    // Implicit intent patterns
    const implicitPatterns = [
      /help\s+me\s+fill/i,
      /fill\s+this/i,
      /complete\s+this/i,
      /i\s+need\s+to\s+fill/i,
      /can\s+you\s+fill/i,
      /please\s+fill/i,
      /fill\s+it/i
    ];
    
    // Check explicit first
    for (const pattern of explicitPatterns) {
      if (pattern.test(lowerMessage)) {
        return { intent: "fill_form", confidence: "high" };
      }
    }
    
    // Check implicit
    for (const pattern of implicitPatterns) {
      if (pattern.test(lowerMessage)) {
        return { intent: "fill_form", confidence: "medium" };
      }
    }
    
    // Check for single field fill intent
    const fieldPatterns = [
      /fill\s+(the\s+)?(\w+)\s+field/i,
      /what\s+should\s+i\s+put\s+in\s+(the\s+)?(\w+)/i
    ];
    
    for (const pattern of fieldPatterns) {
      const match = lowerMessage.match(pattern);
      if (match) {
        return { intent: "fill_field", confidence: "medium", fieldName: match[2] };
      }
    }
    
    return { intent: "question", confidence: "low" };
  }

  // ========== Auto-Fill All Fields ==========
  async function autoFillAllFields() {
    if (!fields || fields.length === 0) {
      appendMessage("No form fields found on this page.", "system");
      return;
    }

    const emptyFields = fields.filter(f => isFieldEmptyOrIncomplete(f));
    
    if (emptyFields.length === 0) {
      appendMessage("All form fields are already filled!", "bot");
      return;
    }

    appendMessage(`Found ${emptyFields.length} empty field(s). Filling them now...`, "bot");
    
    let filledCount = 0;
    let errorCount = 0;

    // Get IndexedDB context for better suggestions
    const storedData = await getStoredFormData(50).catch(() => []);

    for (let i = 0; i < emptyFields.length; i++) {
      const field = emptyFields[i];
      const fieldLabel = getFieldLabel(field);
      
      try {
        // Get suggestion with full context
        const suggestion = await getSuggestedValue(field);
        
        if (suggestion && suggestion.toLowerCase() !== "null") {
          setFieldValue(field, suggestion);
          updateProfileForField(field, suggestion);
          
          // Store in IndexedDB
          await storeFormData({
            label: fieldLabel,
            name: field.name || field.id,
            type: field.type || field.tagName.toLowerCase(),
            id: field.id,
            value: suggestion,
            pageUrl: window.location.href,
            pageTitle: document.title
          }).catch(() => {}); // Ignore storage errors
          
          filledCount++;
          
          // Update progress in chat
          if ((i + 1) % 3 === 0 || i === emptyFields.length - 1) {
            appendMessage(`Filled ${filledCount}/${emptyFields.length} fields...`, "system");
          }
        } else {
          errorCount++;
        }
      } catch (error) {
        console.warn(`Form Helper: Failed to fill field "${fieldLabel}":`, error);
        errorCount++;
      }
      
      // Throttle requests
      if (i < emptyFields.length - 1) {
        await new Promise(resolve => setTimeout(resolve, minRequestInterval));
      }
    }

    // Final message
    if (filledCount > 0) {
      appendMessage(`✅ Successfully filled ${filledCount} field(s)! ${errorCount > 0 ? `${errorCount} field(s) could not be filled.` : ''}`, "bot");
    } else {
      appendMessage("❌ Could not fill any fields. Please try again or fill manually.", "bot");
    }
  }

  async function getSuggestedValue(el) {
    if (!el) return null;

    // First check user profile (most accurate)
    const profileKey = getProfileKeyForField(el);
    if (profileKey && userProfile[profileKey]) {
      return userProfile[profileKey];
    }

    // Try Gemini API suggestion if enabled
    if (FORM_HELPER_CONFIG && FORM_HELPER_CONFIG.USE_AI_SUGGESTIONS) {
      const aiSuggestion = await getGeminiSuggestion(el);
      if (aiSuggestion) {
        return aiSuggestion;
      }
    }

    // Fallback to rule-based suggestions
    return getFallbackSuggestion(el);
  }

  // Overlay functions removed - using chat-only interface

  // Expose override history function globally for API calls

  // --- Chatbot Implementation ---

  let chatWindowEl = null;
  let chatMessagesEl = null;
  let chatInputEl = null;

  function buildChatUI() {
    if (document.querySelector(".fh-chat-fab")) return;

    // Floating Action Button
    const fab = document.createElement("button");
    fab.className = "fh-chat-fab";
    fab.title = "Ask Form Helper";
    fab.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;
    fab.addEventListener("click", toggleChatWindow);
    document.body.appendChild(fab);

    // Chat Window
    chatWindowEl = document.createElement("div");
    chatWindowEl.className = "fh-chat-window";
    chatWindowEl.innerHTML = `
      <div class="fh-chat-header">
        <div class="fh-chat-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
          Form Helper Chat
        </div>
        <button class="fh-chat-close" title="Close">&times;</button>
      </div>
      <div class="fh-chat-messages">
        <div class="fh-chat-msg bot">
          Hi! I can help you fill out this form. Ask me anything about the fields, or need help with file uploads?
        </div>
      </div>
      <div class="fh-chat-input-area">
        <input type="text" class="fh-chat-input" placeholder="Type your question..." />
        <button class="fh-chat-send" disabled>
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    `;
    document.body.appendChild(chatWindowEl);

    // Elements
    chatMessagesEl = chatWindowEl.querySelector(".fh-chat-messages");
    chatInputEl = chatWindowEl.querySelector(".fh-chat-input");
    const sendBtn = chatWindowEl.querySelector(".fh-chat-send");
    const closeBtn = chatWindowEl.querySelector(".fh-chat-close");

    // Event Listeners
    closeBtn.addEventListener("click", toggleChatWindow);

    chatInputEl.addEventListener("input", () => {
      sendBtn.disabled = !chatInputEl.value.trim();
    });

    chatInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });

    sendBtn.addEventListener("click", sendChatMessage);
  }

  function toggleChatWindow() {
    if (!chatWindowEl) return;
    chatWindowEl.classList.toggle("open");
    if (chatWindowEl.classList.contains("open")) {
      setTimeout(() => chatInputEl.focus(), 100);
    }
  }

  function appendMessage(text, type) {
    if (!chatMessagesEl) return;
    const msgDiv = document.createElement("div");
    msgDiv.className = `fh-chat-msg ${type}`;

    // Simple markdown support
    let html = text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") // Escape HTML
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>") // Bold
      .replace(/`(.*?)`/g, "<code>$1</code>") // Code
      .replace(/\\n/g, "<br>"); // Newlines

    msgDiv.innerHTML = html;
    chatMessagesEl.appendChild(msgDiv);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    return msgDiv;
  }

  function showTyping() {
    if (!chatMessagesEl) return null;
    const typingDiv = document.createElement("div");
    typingDiv.className = "fh-typing";
    typingDiv.innerHTML = `<div class="fh-typing-dot"></div><div class="fh-typing-dot"></div><div class="fh-typing-dot"></div>`;
    chatMessagesEl.appendChild(typingDiv);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    return typingDiv;
  }

  async function sendChatMessage() {
    const text = chatInputEl.value.trim();
    if (!text) return;

    chatInputEl.value = "";
    chatWindowEl.querySelector(".fh-chat-send").disabled = true;
    appendMessage(text, "user");

    // Detect intent first
    const detectedIntent = detectFillIntent(text);
    
    // If intent is to fill form, do it immediately
    if (detectedIntent.intent === "fill_form") {
      await autoFillAllFields();
      chatWindowEl.querySelector(".fh-chat-send").disabled = false;
      return;
    }

    const typingIndicator = showTyping();

    // Gather context including IndexedDB data
    const storedData = await getStoredFormData(20).catch(() => []);
    const context = {
      pageTitle: document.title,
      pageUrl: window.location.href,
      fileUploads: Array.from(document.querySelectorAll('input[type="file"]')).map(f => ({
        label: getFieldLabel(f),
        accept: f.accept,
        multiple: f.multiple,
        id: f.id
      })),
      allFields: fields.map(f => ({
        label: getFieldLabel(f),
        name: f.name || f.id,
        type: f.type || f.tagName.toLowerCase(),
        placeholder: f.placeholder,
        required: f.required,
        value: f.value
      })),
      storedFormData: storedData.slice(0, 10).map(d => ({
        fieldLabel: d.fieldLabel,
        fieldName: d.fieldName,
        value: d.value
      })),
      detectedIntent: detectedIntent
    };

    try {
      const response = await chrome.runtime.sendMessage({
        type: "GEMINI_CHAT",
        prompt: text,
        context: context,
        apiKey: FORM_HELPER_CONFIG ? FORM_HELPER_CONFIG.GEMINI_API_KEY : null,
        apiUrl: FORM_HELPER_CONFIG ? FORM_HELPER_CONFIG.GEMINI_API_URL : null
      });

      if (typingIndicator) typingIndicator.remove();

      if (response && response.text) {
        appendMessage(response.text, "bot");
        
        // Check if response contains fill intent
        if (response.intent === "fill_form" || detectFillIntent(response.text).intent === "fill_form") {
          setTimeout(() => autoFillAllFields(), 500);
        }
      } else if (response && response.error) {
        appendMessage("Sorry, I encountered an error: " + response.error, "system");
      } else {
        appendMessage("Sorry, I couldn't get a response.", "system");
      }
    } catch (err) {
      if (typingIndicator) typingIndicator.remove();
      appendMessage("Error sending message: " + err.message, "system");
    }
    
    chatWindowEl.querySelector(".fh-chat-send").disabled = false;
  }

  function init() {
    const allForms = Array.from(document.forms || []);
    fields = allForms.flatMap(form =>
      Array.from(form.querySelectorAll("input, textarea, select")).filter(isFieldRelevant)
    );

    // Always build chat UI if configured
    if (FORM_HELPER_CONFIG && FORM_HELPER_CONFIG.USE_AI_SUGGESTIONS) {
      buildChatUI();
    }

    // Initialize IndexedDB
    initIndexedDB().catch(err => {
      console.warn("Form Helper: Failed to initialize IndexedDB:", err);
    });

    // Add form submit listeners to store data
    allForms.forEach(form => {
      form.addEventListener("submit", async (e) => {
        const formData = {
          fields: Array.from(form.querySelectorAll("input, textarea, select"))
            .filter(isFieldRelevant)
            .map(field => ({
              label: getFieldLabel(field),
              name: field.name || field.id,
              type: field.type || field.tagName.toLowerCase(),
              id: field.id,
              value: field.value
            })),
          pageUrl: window.location.href,
          pageTitle: document.title,
          timestamp: new Date().toISOString()
        };
        
        try {
          await storeFormSubmission(formData);
        } catch (err) {
          console.warn("Form Helper: Failed to store form submission:", err);
        }
      });
    });
  }

  // Expose override history function globally for API calls
  window.formHelperGetOverrideHistory = getOverrideHistory;

  if (document.readyState === "complete" || document.readyState === "interactive") {
    // Inject CSS manually as fallback
    function injectCSS() {
      if (document.getElementById("fh-styles-injected")) return;
      const link = document.createElement("link");
      link.id = "fh-styles-injected";
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("formHelper.css");
      (document.head || document.documentElement).appendChild(link);
    }

    injectCSS();
    init();
  } else {
    window.addEventListener("DOMContentLoaded", () => {
      // Inject CSS manually as fallback
      function injectCSS() {
        if (document.getElementById("fh-styles-injected")) return;
        const link = document.createElement("link");
        link.id = "fh-styles-injected";
        link.rel = "stylesheet";
        link.href = chrome.runtime.getURL("formHelper.css");
        (document.head || document.documentElement).appendChild(link);
      }
      injectCSS();
      init();
    }, { once: true });
  }
})();

