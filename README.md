<p align="center">
  <img src="./img.png" alt="Project Banner" width="100%">
</p>

# Forms Helper

## Basic Details

### Team Name: KACHRA

### Team Members
- Member 1: Sreedevi S - Christ College of Engineering
- Member 2: Ishitha K - Christ College of Engineering

### Hosted Project Link
(https://github.com/sreedevicodes/FormHelper.git)

### Project Description
Form Helper is a browser extension that assists users while filling out web forms.  
It scans forms on any webpage, walks through each empty or incomplete field, and provides inline help and smart suggested values so users can complete forms faster and with fewer errors.

### The Problem statement
Many users find long or complex forms confusing and time‑consuming.  
They are often unsure what is expected in each field, leading to mistakes, rejections, or simply abandoning the form.

### The Solution
The Form Helper extension automatically detects forms and applies a guided, field‑by‑field flow (as designed in the workflow diagram).  
For each field, it checks whether the value is empty or invalid, shows helpful guidance, and optionally proposes a suggested value that the user can accept or ignore before moving on to the next field.

---

## Technical Details

### Technologies/Components Used

**For Software:**
- Languages used: JavaScript
- Frameworks used:
  - Chrome Extensions API (Manifest V3)
- Libraries used:
  - Google Gemini API (for AI-powered field suggestions)
  - Chrome Storage API (for persisting learned form data)
  - IndexedDB (for storing form submissions and field mappings)
- Tools used: 
  - Visual Studio Code
  - Git & GitHub
  - Chrome DevTools
  - Google AI Studio (for API key generation)

---

## Features

List the key features of your project:
- Feature 1:  Automatically scans any webpage for forms and suggests autofill based on previously entered data

- Feature 2: Works on any website without manual configuration; adaptive field discovery, dynamic listener attachment, and MutationObserver ensure the extension remains active even as page content changes.

- Feature 3: analyze form context, field attributes, and page content to suggest accurate values.(e.g., calculating age from date of birth)

- Feature 4: User can ask doubts about fields they are uncertain of

---

## Implementation

### For Software (Browser Extension):

#### Installation (Development)
1. Clone or download this repository to your machine.
2. **Configure Gemini API (Optional but Recommended):**
   - Get your free Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
   - Open `config.js` in the FormHelper folder
   - Paste your API key: `GEMINI_API_KEY: "AIzaSyAEfMvSJ3Hsl462l6LuhiJnONUl7YIjKec"`
   - The extension will use AI-powered suggestions. Without an API key, it falls back to rule-based suggestions.
3. Open your browser (Chrome/Edge/Brave) and go to `chrome://extensions/`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the `FormHelper` folder containing `manifest.json`.

#### Usage
1. Visit any website that contains a form.
2. Once the page loads, the **Form Helper** overlay appears in the bottom‑right corner if form fields are detected.
3. The helper highlights one field at a time:
   - **Use suggestion**: fills the field with a context‑aware suggested value (e.g., sample email, phone, name).
   - **Fill myself**: skips the suggestion and lets the user type manually.
   - **Ignore**: skips the field without changes.
4. After all empty/incomplete fields are processed, the overlay shows a completion message so the user can review and submit the form.


## Project Documentation

### For Software:

#### Screenshots (Add at least 3)
![Form Helper Chat Interface](./images/ss_chatbot.png)
![Form Autofill in Action](./images/ss_autofill.png)
![Extension working on other webpage form](./images/ss_otherpages.png)



#### Diagrams

**Application Workflow:**

![Workflow](./images/flowchart.jpeg)
Learning Phase — Extension monitors when users manually fill form fields and blur (leave) them. It detects the field type (email, phone, name, DOB, etc.) based on field attributes and value patterns, then stores learned values in chrome.storage.local.

Detection Phase — When a user visits a new webpage, the extension scans for all forms and input fields (including shadow DOM and same-origin iframes) using adaptive field discovery and MutationObserver to catch dynamically added forms.

Suggestion Phase — For each empty field, the extension retrieves a suggestion from previously learned data or calls Google Gemini API for AI-powered, context-aware suggestions (e.g., calculating age from DOB).

Confirmation Phase — The user is prompted field-by-field with visual highlighting and auto-scrolling. For each field, they can Confirm (accept suggestion), Edit (modify the value), or Skip (leave empty).

Storage Phase — Once confirmed, the value is filled into the field and upserted (saved/updated) to IndexedDB with metadata (field name, type, page URL, timestamp) for future reference and learning.

Key Result: Users fill forms faster with fewer errors, and the extension learns their patterns over time to improve future suggestions.



#### Installation Guide

**For Android (APK):**
1. Download the APK from [Release Link]
2. Enable "Install from Unknown Sources" in your device settings:
   - Go to Settings > Security
   - Enable "Unknown Sources"
3. Open the downloaded APK file
4. Follow the installation prompts
5. Open the app and enjoy!



## Project Demo

### Video
https://drive.google.com/drive/folders/15BEATz2_ZdSCZU2egEhVs8_Rs0cQ8zYU
THE VIDEO DEMONSTRATES THE BASIC USE OF THE EXTENSION. Fills forms based on past inputs and its useable across any platform, we can ask the chatbot to help us with fields we dont understand.
---

## AI Tools Used (Optional - For Transparency Bonus)

If you used AI tools during development, document them here for transparency:

**Tool Used:** [e.g., GitHub Copilot,Cursor, ChatGPT]

**Purpose:**
-DEBUGGING AND ERROR DETECTION
-HELP WITH JAVASCRIPT 
-

**Key Prompts Used:**
- "fix errors in contentScript.js"
- "what are errors 429 , 404"
- 

**Percentage of AI-generated code:** 60%

**Human Contributions:**
- Architecture design and planning
- Integration and testing
- UI/UX design decisions


*Note: Proper documentation of AI usage demonstrates transparency and earns bonus points in evaluation!*

---

## Team Contributions

- Sreedevi S: Extension development
- Ishitha K: API integration


**Common License Options:**
- MIT License (Permissive, widely used)
- Apache 2.0 (Permissive with patent grant)
- GPL v3 (Copyleft, requires derivative works to be open source)

---

Made with ❤️ at TinkerHub
