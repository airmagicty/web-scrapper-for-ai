# WebScrabber Tools

[Читать на русском (Russian Version)](README-RU.md)

A set of lightweight JavaScript utilities for network activity logging, DOM event tracking, state monitoring, and page dependency downloading. Designed to be run directly in the browser DevTools Console or injected automatically using browser extensions like **Custom JS and CSS**.

---

## Recommended Setup

For the best experience, it is recommended to use these scripts alongside the **Custom JS and CSS** browser extension (or userscript managers like Tampermonkey / Violentmonkey):
* **Automatic Early Injection:** Runs immediately as the page loads to intercept early network requests and startup events.
* **Console Execution:** Alternatively, you can copy and paste the code directly into the browser DevTools Console (`F12` -> `Console`).

---

## Metadata Header Standard

All scripts in this repository include a standard UserScript-style header format at the top of each file:

```javascript
// ==UserScript==
// @name         WebScrabber / WebScrabberFull
// @description  Brief overview of the tool's capabilities
// @author       airmagicty
// @version      2.X.X
// @license      MIT
// ==UserScript==
```

---

## Available Variants

### 1. `WebScrabber.js` (Basic Network Logger)
A lightweight network interceptor that captures API traffic and provides a quick UI button to export logs as JSON.

* **Features:**
  * Intercepts `fetch` and `XMLHttpRequest` (XHR) requests.
  * Captures HTTP methods, URLs, payload data, response statuses, and response bodies.
  * Floating UI button (`💾 Скачать логи сети`) in the bottom-right corner for one-click JSON export.
* **Header Information:**
  * **Name:** WebScrabber
  * **Description:** Basic client-side network interceptor and JSON logger for fetch and XHR requests.
  * **Author:** Developer
  * **Version:** 1.0.0
  * **License:** MIT

### 2. `WebScrabberFull.js` (Full Session & Dependency Crawler)
An advanced client-side monitoring toolkit designed for comprehensive debugging, full session recording, and LLM/AI context preparation.

* **Features:**
  * **Network Interception:** `fetch`, `XHR`, `sendBeacon`, and `WebSocket` message logging.
  * **DOM & User Events:** Intercepts clicks, keyboard inputs, form submissions, SPA history navigation (`pushState`/`replaceState`), window resizing, JS errors, and custom events.
  * **State Tracking:** Takes initial snapshots and tracks changes (`diffs`) in `document.cookie`, `localStorage`, `sessionStorage`, and `IndexedDB`.
  * **Security & Privacy:** Sensitive input fields (passwords, credit card numbers, one-time codes) are automatically masked.
  * **Recursive Dependency Crawler:** Downloads page HTML, scripts, and optional CSS dependencies into a consolidated text file. The output starts with `FILE0` — the full live DOM (`document.documentElement.outerHTML`, the same as copying `<html>` via *Edit as HTML* in the Inspector, with the scraper's own panel removed), followed by `FILE1`, `FILE2`, … (server HTML, inline scripts/styles, and fetched files).
  * **Dependency noise options** (the collapsible *«Шум зависимостей»* block in the panel):
    * *include CSS in dependencies* — off by default;
    * *include popular libraries/CDN* — off by default;
    * *include base64 content* — off by default. While off, base64 payloads (`data:...;base64,...` and long base64 string literals) are replaced with `BASE64CODESKIP` to keep the output free of noise.
  * **Unified Export:** Option to bundle all chronological activity into a single JSON file formatted for LLM analysis.
  * **Floating Control Panel:** Fully featured UI panel to toggle features, inspect counters, and trigger exports. The panel title and all console messages show the script version (`WebScrabberFull vX.X.X`, `[WebScrabberFull vX.X.X]`), defined by the `VERSION` constant at the top of the file.
* **Header Information:**
  * **Name:** WebScrabberFull
  * **Description:** Advanced client-side activity logger (Network, Events, Storage State) and recursive script dependency crawler.
  * **Author:** airmagicty
  * **Version:** 2.2.0
  * **License:** MIT

---

## License

Distributed under the MIT License.