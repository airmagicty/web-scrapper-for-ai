// ==UserScript==
// @name         Web Scrabber [Lite Version]
// @description  Basic client-side network interceptor and JSON logger for fetch and XHR requests.
// @author       airmagicty
// @version      1.0.0
// @license      MIT
// ==UserScript==

// Объект для хранения всех логов сетевой активности
const networkLogs = [];

// Функция для добавления записи в лог
function logNetworkActivity(type, url, method, requestData, responseStatus, responseData) {
    networkLogs.push({
        timestamp: new Date().toISOString(),
        type: type, // 'FETCH' или 'XHR'
        method: method || 'GET',
        url: url,
        requestData: requestData || null,
        responseStatus: responseStatus,
        responseData: responseData || null
    });
    console.log(`[Network Logged] ${method || 'GET'} -> ${url}`);
}

// =========================================================================
// 1. ПЕРЕХВАТ FETCH ЗАПРОСОВ
// =========================================================================
const originalFetch = window.fetch;
window.fetch = async function(...args) {
    const url = args[0];
    const options = args[1] || {};
    const method = options.method || 'GET';
    let requestBody = null;

    if (options.body) {
        try {
            requestBody = typeof options.body === 'string' ? JSON.parse(options.body) : 'Binary/FormData';
        } catch (e) {
            requestBody = options.body;
        }
    }

    try {
        const response = await originalFetch.apply(this, args);
        // Клонируем ответ, так как тело ответа можно прочесть только один раз
        const clone = response.clone();
        let responseData = null;

        try {
            responseData = await clone.json();
        } catch (e) {
            try { responseData = await clone.text(); } catch (err) {}
        }

        logNetworkActivity('FETCH', url, method, requestBody, response.status, responseData);
        return response;
    } catch (error) {
        logNetworkActivity('FETCH', url, method, requestBody, 'FAILED', error.message);
        throw error;
    }
};

// =========================================================================
// 2. ПЕРЕХВАТ XHR ЗАПРОСОВ (XMLHttpRequest)
// =========================================================================
const originalXHR = window.XMLHttpRequest;
window.XMLHttpRequest = function() {
    const xhr = new originalXHR();
    const originalOpen = xhr.open;
    const originalSend = xhr.send;
    let xhrUrl = '';
    let xhrMethod = '';
    let xhrBody = null;

    xhr.open = function(method, url, ...args) {
        xhrMethod = method;
        xhrUrl = url;
        return originalOpen.apply(this, [method, url, ...args]);
    };

    xhr.send = function(body) {
        if (body) {
            try {
                xhrBody = typeof body === 'string' ? JSON.parse(body) : 'Binary/FormData';
            } catch (e) {
                xhrBody = body;
            }
        }

        xhr.addEventListener('load', function() {
            let responseData = null;
            try {
                responseData = JSON.parse(xhr.responseText);
            } catch (e) {
                responseData = xhr.responseText;
            }
            logNetworkActivity('XHR', xhrUrl, xhrMethod, xhrBody, xhr.status, responseData);
        });

        xhr.addEventListener('error', function() {
            logNetworkActivity('XHR', xhrUrl, xhrMethod, xhrBody, 'FAILED', 'Network Error');
        });

        return originalSend.apply(this, arguments);
    };

    return xhr;
};

// =========================================================================
// 3. ФУНКЦИЯ ДЛЯ СКАЧИВАНИЯ СОБРАННОГО JSON
// =========================================================================
function downloadNetworkLogs() {
    if (networkLogs.length === 0) {
        alert("Логов пока нет. Сделайте какие-нибудь действия на сайте.");
        return;
    }

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(networkLogs, null, 2));
    const downloadAnchor = document.createElement('a');
    
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `network_logs_${new Date().getTime()}.json`);
    document.body.appendChild(downloadAnchor);
    
    downloadAnchor.click();
    downloadAnchor.remove();
}

// Создаем плавающую кнопку «Скачать логи» в углу экрана для удобства тестирования
(function createDownloadButton() {
    const btn = document.createElement('button');
    btn.innerText = '💾 Скачать логи сети';
    btn.style.position = 'fixed';
    btn.style.bottom = '20px';
    btn.style.right = '20px';
    btn.style.zIndex = '99999';
    btn.style.padding = '10px 15px';
    btn.style.backgroundColor = '#007bff';
    btn.style.color = '#fff';
    btn.style.border = 'none';
    btn.style.borderRadius = '5px';
    btn.style.cursor = 'pointer';
    btn.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
    
    btn.onclick = downloadNetworkLogs;
    document.body.appendChild(btn);
})();
