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
  * **Recursive Dependency Crawler:** Downloads page HTML, scripts, and optional CSS dependencies into a consolidated text file.
  * **Unified Export:** Option to bundle all chronological activity into a single JSON file formatted for LLM analysis.
  * **Floating Control Panel:** Fully featured UI panel to toggle features, inspect counters, and trigger exports.
* **Header Information:**
  * **Name:** WebScrabberFull
  * **Description:** Advanced client-side activity logger (Network, Events, Storage State) and recursive script dependency crawler.
  * **Author:** Developer
  * **Version:** 1.0.0
  * **License:** MIT

---

## License

Distributed under the MIT License.