(() => {
  let currentFieldIndex = -1;
  let fields = [];
  let overlayEl = null;
  let activeField = null;
  let activeFieldBlurHandler = null;
  let flowActive = false;
  let userProfile = {};
  let currentSuggestion = null; // Track the current suggestion shown to the user
  let suggestionCache = {}; // Cache for AI suggestions
  let pendingSuggestions = new Map(); // Track pending API calls
  let apiBackoffUntil = 0; // Timestamp until which API is disabled due to 429


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

    // Build context for the AI
    const fieldType = field.getAttribute("type") || field.tagName.toLowerCase();
    const fieldName = field.getAttribute("name") || "";
    const fieldId = field.getAttribute("id") || "";
    const fieldLabel = getFieldLabel(field);
    const placeholder = field.getAttribute("placeholder") || "";
    const isRequired = field.hasAttribute("required");
    const pageTitle = document.title;
    const pageUrl = window.location.href;

    // Get user profile context
    const profileContext = Object.keys(userProfile).length > 0
      ? `User's previously stored information: ${JSON.stringify(userProfile)}`
      : "";

    // Get override history context
    const overrideHistory = getOverrideHistory();
    const recentOverrides = overrideHistory.slice(-5).map(ov =>
      `Field "${ov.fieldLabel}": User overrode suggestion "${ov.suggestedValue}" with "${ov.userValue || 'skipped'}"`
    ).join("; ");
    const overrideContext = recentOverrides ? `Recent user preferences: ${recentOverrides}` : "";

    const prompt = `You are a form-filling assistant. Generate a single, appropriate example value for a form field.

Field Information:
- Label: "${fieldLabel}"
- Name attribute: "${fieldName}"
- ID attribute: "${fieldId}"
- Type: "${fieldType}"
- Placeholder: "${placeholder}"
- Required: ${isRequired}
- Page Title: "${pageTitle}"
- Page URL: "${pageUrl}"

${profileContext ? profileContext + "\n" : ""}
${overrideContext ? overrideContext + "\n" : ""}

Instructions:
1. Generate ONE realistic example value that matches the field type and context
2. Return ONLY the value, no explanation or quotes
3. If the field type is email, return a valid email format
4. If the field type is tel/phone, return a valid phone number format
5. If the field type is url, return a valid URL format
6. If the field type is number, return a valid number
7. For text fields, return a realistic example based on the label/name
8. Keep it concise (max 50 characters)
9. If you cannot determine an appropriate value, return "null"

Example value:`;

    try {
      const apiKey = FORM_HELPER_CONFIG.GEMINI_API_KEY;
      const apiUrl = FORM_HELPER_CONFIG.GEMINI_API_URL.replace(/\?.*$/, ""); // base URL without key

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

  function buildOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement("div");
    overlayEl.className = "fh-overlay";
    overlayEl.innerHTML = `
      <div class="fh-overlay-header">
        <span>
          <span class="fh-badge">Form Helper</span>
        </span>
        <button class="fh-close" title="Close helper">&times;</button>
      </div>
      <div class="fh-overlay-body">
        <div class="fh-field-label"></div>
        <div class="fh-help-text"></div>
        <div class="fh-suggestion" style="display:none;">
          <div class="fh-suggestion-label">Suggested value</div>
          <div class="fh-suggestion-value"></div>
        </div>
      </div>
      <div class="fh-overlay-footer">
        <button type="button" class="fh-btn fh-btn-primary fh-btn-use">Use suggestion</button>
        <button type="button" class="fh-btn fh-btn-secondary fh-btn-skip">Fill myself</button>
        <button type="button" class="fh-btn fh-btn-quiet fh-btn-ignore">Ignore</button>
      </div>
    `;

    document.body.appendChild(overlayEl);

    // Ensure logic handles removed overlay gracefully
    if (!document.body.contains(overlayEl)) {
      // Fallback if append failed for some reason
      try {
        document.documentElement.appendChild(overlayEl);
      } catch (e) { }
    }

    overlayEl.querySelector(".fh-close").addEventListener("click", () => {
      teardown();
    });

    const useBtn = overlayEl.querySelector(".fh-btn-use");
    if (!useBtn) {
      console.error("Form Helper: Use button not found!");
      return;
    }

    useBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!activeField) {
        console.warn("Form Helper: No active field");
        return;
      }

      // Check if button is disabled
      const btn = overlayEl.querySelector(".fh-btn-use");
      if (btn && btn.disabled) {
        console.warn("Form Helper: Button is disabled");
        return;
      }

      if (currentSuggestion != null && currentSuggestion !== "") {
        // Use the displayed suggestion value, not recalculate it
        setFieldValue(activeField, currentSuggestion);
        updateProfileForField(activeField, currentSuggestion);
        console.log("Form Helper: Applied suggestion:", currentSuggestion);
      } else {
        console.warn("Form Helper: No suggestion available");
      }

      const usedSuggestion = currentSuggestion;
      currentSuggestion = null; // Clear suggestion tracking
      await goToNextField();
    });

    overlayEl.querySelector(".fh-btn-skip").addEventListener("click", () => {
      if (activeField) {
        if (currentSuggestion != null) {
          recordOverride(activeField, currentSuggestion, "override", null);
        }
        activeField.focus();
        // Don't advance yet - let user type. Blur handler will save profile and advance when done.
      }
      currentSuggestion = null;
    });

    overlayEl.querySelector(".fh-btn-ignore").addEventListener("click", async () => {
      if (activeField && currentSuggestion != null) {
        // Record that user ignored the suggestion
        recordOverride(activeField, currentSuggestion, "ignore", null);
      }
      currentSuggestion = null; // Clear suggestion tracking
      await goToNextField();
    });
  }

  async function updateOverlayForField(field) {
    if (!overlayEl) return;
    const labelEl = overlayEl.querySelector(".fh-field-label");
    const helpEl = overlayEl.querySelector(".fh-help-text");
    const suggestionBox = overlayEl.querySelector(".fh-suggestion");
    const suggestionValueEl = overlayEl.querySelector(".fh-suggestion-value");
    const useBtn = overlayEl.querySelector(".fh-btn-use");

    const label = getFieldLabel(field);
    const help = getHelpText(field);

    // Clear any pending debounce
    if (window.fh_debounceTimer) {
      clearTimeout(window.fh_debounceTimer);
    }

    // Update label and help immediately
    labelEl.textContent = label;
    helpEl.textContent = help;

    // Check if we have a cached value ready-to-go (synchronous check mostly)
    // If we have it in memory cache, show immediately without debounce
    const cacheKey = getCacheKeyForField(field);
    if (cacheKey && suggestionCache[cacheKey]) {
      const suggestion = suggestionCache[cacheKey];
      currentSuggestion = suggestion;
      suggestionBox.style.display = "block";
      suggestionValueEl.textContent = suggestion;
      useBtn.disabled = false;
      useBtn.style.pointerEvents = "auto";
      useBtn.style.cursor = "pointer";
      return;
    }

    // Otherwise, delayed fetch
    if (FORM_HELPER_CONFIG && FORM_HELPER_CONFIG.USE_AI_SUGGESTIONS && FORM_HELPER_CONFIG.GEMINI_API_KEY) {
      suggestionBox.style.display = "block";
      suggestionValueEl.textContent = "..."; // minimal indicator
      useBtn.disabled = true;
      useBtn.style.cursor = "wait";

      window.fh_debounceTimer = setTimeout(async () => {
        // Show actual loading state
        suggestionValueEl.textContent = "Thinking...";

        try {
          const suggestion = await getSuggestedValue(field);

          // Verify we are still on the same field before updating (simple check)
          if (activeField !== field) return;

          currentSuggestion = suggestion;
          if (suggestion != null && suggestion !== "") {
            suggestionBox.style.display = "block";
            suggestionValueEl.textContent = suggestion;
            useBtn.disabled = false;
            useBtn.style.pointerEvents = "auto";
            useBtn.style.cursor = "pointer";
          } else {
            suggestionBox.style.display = "none";
            suggestionValueEl.textContent = "";
            useBtn.disabled = true;
            useBtn.style.pointerEvents = "none";
            useBtn.style.cursor = "not-allowed";
          }
        } catch (e) {
          console.warn("Form Helper: Suggestion failed", e);
          suggestionValueEl.textContent = "Error";
        }
      }, 1000); // 1 second debounce
    } else {
      // Fallback logic (instant)
      const suggestion = await getSuggestedValue(field);
      currentSuggestion = suggestion;
      if (suggestion != null && suggestion !== "") {
        suggestionBox.style.display = "block";
        suggestionValueEl.textContent = suggestion;
        useBtn.disabled = false;
        useBtn.style.pointerEvents = "auto";
        useBtn.style.cursor = "pointer";
      } else {
        suggestionBox.style.display = "none";
        suggestionValueEl.textContent = "";
        useBtn.disabled = true;
        useBtn.style.pointerEvents = "none";
        useBtn.style.cursor = "not-allowed";
      }
    }
  }

  function highlightField(field) {
    if (activeField && activeField !== field) {
      activeField.classList.remove("fh-active-field");
      if (activeFieldBlurHandler) {
        activeField.removeEventListener("blur", activeFieldBlurHandler);
        activeFieldBlurHandler = null;
      }
    }
    activeField = field;
    if (!field) return;
    field.classList.add("fh-active-field");
    field.scrollIntoView({ behavior: "smooth", block: "center" });
    field.focus();

    activeFieldBlurHandler = (e) => {
      if (!activeField) return;
      if (overlayEl && e.relatedTarget && overlayEl.contains(e.relatedTarget)) {
        return;
      }
      const value = (activeField.value || "").trim();
      if (value) {
        if (currentSuggestion != null && value !== currentSuggestion) {
          recordOverride(activeField, currentSuggestion, "override", value);
        }
        updateProfileForField(activeField, value);
      }
      currentSuggestion = null;
      // Advance to next field when user leaves (filled manually or tabbed away)
      goToNextField();
    };
    field.addEventListener("blur", activeFieldBlurHandler);
  }

  async function goToNextField() {
    if (!fields.length) {
      teardown();
      return;
    }
    let nextIndex = currentFieldIndex + 1;
    let found = null;

    while (nextIndex < fields.length) {
      const candidate = fields[nextIndex];
      if (candidate && candidate.isConnected && isFieldRelevant(candidate)) {
        if (isFieldEmptyOrIncomplete(candidate)) {
          found = candidate;
          break;
        }
      }
      nextIndex++;
    }

    if (!found) {
      showCompletionState();
      return;
    }

    currentFieldIndex = nextIndex;
    highlightField(found);
    await updateOverlayForField(found);
  }

  function showCompletionState() {
    if (!overlayEl) return;
    if (activeField) {
      activeField.classList.remove("fh-active-field");
      activeField = null;
    }
    const labelEl = overlayEl.querySelector(".fh-field-label");
    const helpEl = overlayEl.querySelector(".fh-help-text");
    const suggestionBox = overlayEl.querySelector(".fh-suggestion");
    const footer = overlayEl.querySelector(".fh-overlay-footer");

    labelEl.textContent = "All fields reviewed";
    helpEl.textContent = "You can now review the form and submit it when you're ready.";
    suggestionBox.style.display = "none";

    footer.innerHTML = "";
    const closeBtn = document.createElement("button");
    closeBtn.className = "fh-btn fh-btn-primary";
    closeBtn.textContent = "Close helper";
    closeBtn.addEventListener("click", teardown);
    footer.appendChild(closeBtn);
  }

  function teardown() {
    flowActive = false;
    if (activeField) {
      activeField.classList.remove("fh-active-field");
      if (activeFieldBlurHandler) {
        activeField.removeEventListener("blur", activeFieldBlurHandler);
        activeFieldBlurHandler = null;
      }
      activeField = null;
    }
    if (overlayEl && overlayEl.parentNode) {
      overlayEl.parentNode.removeChild(overlayEl);
    }
    overlayEl = null;
    fields = [];
    currentFieldIndex = -1;
  }

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

    const typingIndicator = showTyping();

    // Gather context
    const context = {
      pageTitle: document.title,
      pageUrl: window.location.href,
      activeField: activeField ? {
        label: getFieldLabel(activeField),
        name: activeField.name || activeField.id,
        type: activeField.type,
        placeholder: activeField.placeholder,
        required: activeField.required,
        value: activeField.value
      } : null,
      fileUploads: Array.from(document.querySelectorAll('input[type="file"]')).map(f => ({
        label: getFieldLabel(f),
        accept: f.accept,
        multiple: f.multiple,
        id: f.id
      }))
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
      } else if (response && response.error) {
        appendMessage("Sorry, I encountered an error: " + response.error, "system");
      } else {
        appendMessage("Sorry, I couldn't get a response.", "system");
      }
    } catch (err) {
      if (typingIndicator) typingIndicator.remove();
      appendMessage("Error sending message: " + err.message, "system");
    }
  }

  function init() {
    if (flowActive) return;
    const allForms = Array.from(document.forms || []);
    fields = allForms.flatMap(form =>
      Array.from(form.querySelectorAll("input, textarea, select")).filter(isFieldRelevant)
    );

    // Always build chat UI if configured
    if (FORM_HELPER_CONFIG && FORM_HELPER_CONFIG.USE_AI_SUGGESTIONS) {
      buildChatUI();
    }

    if (!fields.length) return;

    // Load profile first, then start the form filling process
    loadProfile(() => {
      flowActive = true;
      buildOverlay();
      goToNextField();
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

