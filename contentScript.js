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

    // Check cache first
    const cacheKey = getCacheKeyForField(field);
    if (cacheKey && suggestionCache[cacheKey]) {
      return suggestionCache[cacheKey];
    }

    // Check if API is configured
    if (!FORM_HELPER_CONFIG || !FORM_HELPER_CONFIG.GEMINI_API_KEY || !FORM_HELPER_CONFIG.USE_AI_SUGGESTIONS) {
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
      const apiUrl = `${FORM_HELPER_CONFIG.GEMINI_API_URL}?key=${apiKey}`;

      const requestBody = {
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      };

      // Create a promise for this request
      const suggestionPromise = fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      })
      .then(response => {
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const text = data.candidates[0].content.parts[0].text.trim();
          // Remove quotes if present
          const cleanText = text.replace(/^["']|["']$/g, "").trim();
          
          // Check if it's "null" or empty
          if (cleanText.toLowerCase() === "null" || !cleanText) {
            return null;
          }
          
          // Cache the result
          if (cacheKey && FORM_HELPER_CONFIG.CACHE_SUGGESTIONS) {
            suggestionCache[cacheKey] = cleanText;
            // Limit cache size
            const keys = Object.keys(suggestionCache);
            if (keys.length > FORM_HELPER_CONFIG.MAX_CACHE_SIZE) {
              delete suggestionCache[keys[0]];
            }
          }
          
          return cleanText;
        }
        return null;
      })
      .catch(error => {
        console.warn("Gemini API error:", error);
        return null;
      })
      .finally(() => {
        // Remove from pending requests
        pendingSuggestions.delete(cacheKey);
      });

      // Store promise in pending map
      pendingSuggestions.set(cacheKey, suggestionPromise);
      
      return suggestionPromise;
    } catch (error) {
      console.warn("Failed to call Gemini API:", error);
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

  function init() {
    if (flowActive) return;
    const allForms = Array.from(document.forms || []);
    fields = allForms.flatMap(form =>
      Array.from(form.querySelectorAll("input, textarea, select")).filter(isFieldRelevant)
    );
    if (!fields.length) return;
    
    // Load profile first, then start the form filling process
    loadProfile(() => {
      flowActive = true;
      buildOverlay();
      goToNextField();
    });
  }

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

    document.documentElement.appendChild(overlayEl);

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

    // Update label and help immediately
    labelEl.textContent = label;
    helpEl.textContent = help;

    // Show loading state if using AI
    if (FORM_HELPER_CONFIG && FORM_HELPER_CONFIG.USE_AI_SUGGESTIONS && FORM_HELPER_CONFIG.GEMINI_API_KEY) {
      suggestionBox.style.display = "block";
      suggestionValueEl.textContent = "Generating suggestion...";
      useBtn.disabled = true;
      useBtn.style.pointerEvents = "none";
      useBtn.style.cursor = "not-allowed";
    } else {
      // If not using AI, ensure button is enabled if we have a fallback suggestion
      useBtn.disabled = false;
      useBtn.style.pointerEvents = "auto";
      useBtn.style.cursor = "pointer";
    }

    // Get suggestion (async)
    const suggestion = await getSuggestedValue(field);

    // Store current suggestion for override tracking
    currentSuggestion = suggestion;

    // Update UI with suggestion
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
  window.formHelperGetOverrideHistory = getOverrideHistory;

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init, { once: true });
  }
})();

