// ==UserScript==
// @name         Web Scrabber [Full Version]
// @description  Advanced client-side activity logger (Network, Events, Storage State) and recursive script dependency crawler.
// @author       airmagicty
// @version      2.4.0
// @license      MIT
// ==UserScript==

// =============================================================================
// WebScrabberFull — расширенный логгер клиентской активности
//   1. Сеть: fetch / XHR / sendBeacon / WebSocket (+ заголовки, cookies, storage)
//   2. События: все JS-события (клики, ввод, submit, ошибки, history и т.д.)
//   3. Состояние: cookies / localStorage / sessionStorage (начальный снимок + диффы)
//   4. Зависимости: рекурсивная выгрузка HTML + JS (+ CSS по галочке) в один файл
//   5. Единый хронологический JSON со всем сразу (для передачи нейросети)
// Вставляется в консоль страницы или подключается как userscript.
// =============================================================================
(function () {
    'use strict';

    const VERSION = '2.4.0';   // версия скрипта (держать в синхроне с @version в шапке)
    const TAG = `[WebScrabberFull v${VERSION}]`;   // префикс всех сообщений в консоли

    if (window.__webScrabberFull) {
        console.warn(`${TAG} уже запущен на этой странице`);
        return;
    }

    // ------------------------------------------------------------------ настройки
    const CFG = {
        maxBodyChars: 300000,      // максимум символов тела ответа в логе
        maxValueChars: 5000,       // максимум символов одного значения (cookie/storage/input)
        maxDepFiles: 500,          // лимит файлов при рекурсивной выгрузке
        depConcurrency: 6,         // параллельных загрузок
        statePollMs: 1000,         // период проверки изменений cookies/storage
        throttleMs: 300            // троттлинг scroll / wheel / resize
    };

    const S = {
        startedAt: new Date().toISOString(),
        seq: 0,                    // сквозной номер для всех логов -> хронология
        network: [],
        events: [],
        state: [],
        depsCount: 0,
        crawling: false,
        includeCss: false,         // галочка: собирать CSS
        includeLibraries: false,   // галочка: включать популярные библиотеки/CDN
        includeBase64: false,      // галочка: включать содержимое base64 (выкл. = заменять на BASE64CODESKIP)
        snapshotInRequests: true,  // галочка: cookies/storage в каждый сетевой запрос
        consoleLog: true,          // галочка: дублировать лог в консоль браузера
        navigationGuard: true,     // галочка: остановить уход со страницы, чтобы сохранить логи
        // группы шумных событий: true = записывать. По умолчанию все выключены
        noise: { scroll: false, emptyClick: false, pointer: false, focus: false, select: false, keyLow: false, hover: false },
        // группы шумных сетевых запросов (трекеры, метрики): true = записывать. По умолчанию все выключены
        noiseNet: { metrika: false, analytics: false, mailru: false, sentry: false, other: false },
        compact: true,             // галочка: сжимать экспорт (шапка с повторами, повторы подряд, дельты состояния)
        eventsTotal: 0,            // сколько событий произошло всего (с учётом повторов подряд)
        networkTotal: 0,           // сколько запросов выполнено всего (с учётом повторов подряд)
        _evtSig: null, _netSig: null  // сигнатуры последних записей — для схлопывания повторов подряд
    };

    // элементы панели и таймер отрисовки объявлены заранее: scheduleRender() может вызваться во время загрузки скрипта
    const ui = {};
    let renderTimer = null;

    // вывод в консоль, включается/выключается галочкой в панели
    const clog = (...a) => { if (S.consoleLog) console.log(...a); };

    const nextSeq = () => ++S.seq;
    const now = () => new Date().toISOString();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const clip = (v, n = CFG.maxValueChars) =>
        (typeof v === 'string' && v.length > n) ? v.slice(0, n) + `…[+${v.length - n} симв.]` : v;

    const jsonReplacer = (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v;
    const absUrl = u => { try { return new URL(u, location.href).href; } catch (e) { return String(u); } };
    function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; }
    const hashVal = v => { try { const s = JSON.stringify(v); return s === undefined ? '' : s.length + ':' + hashStr(s); } catch (e) { return ''; } };

    // оригинальные функции (чтобы краулер не попадал в собственный лог)
    const origFetch = window.fetch ? window.fetch.bind(window) : null;

    // ------------------------------------------------------------------ утилиты
    function safe(v, depth = 0, seen = new WeakSet()) {
        if (v === null || v === undefined) return v;
        const t = typeof v;
        if (t === 'string') return clip(v);
        if (t === 'number' || t === 'boolean') return v;
        if (t === 'bigint') return v.toString() + 'n';
        if (t === 'function') return `[Function ${v.name || 'anonymous'}]`;
        if (t === 'symbol') return v.toString();
        if (v === window) return '[window]';
        if (v instanceof Node) return describeTarget(v);
        if (v instanceof Error) return { name: v.name, message: v.message, stack: clip(v.stack) };
        if (depth > 4) return '[depth limit]';
        if (seen.has(v)) return '[circular]';
        seen.add(v);
        if (Array.isArray(v)) return v.slice(0, 100).map(x => safe(x, depth + 1, seen));
        try {
            const o = {};
            Object.keys(v).slice(0, 100).forEach(k => { o[k] = safe(v[k], depth + 1, seen); });
            return o;
        } catch (e) { return String(v); }
    }

    function cssPath(el) {
        const parts = [];
        let n = el;
        while (n && n.nodeType === 1 && parts.length < 8) {
            let s = n.tagName.toLowerCase();
            if (n.id) {
                s += '#' + (window.CSS && CSS.escape ? CSS.escape(n.id) : n.id);
                parts.unshift(s);
                break;
            }
            const p = n.parentElement;
            if (p) {
                const sib = Array.from(p.children).filter(c => c.tagName === n.tagName);
                if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(n) + 1})`;
            }
            parts.unshift(s);
            n = p;
        }
        return parts.join(' > ');
    }

    function describeTarget(t) {
        if (t === window) return { kind: 'window' };
        if (t === document) return { kind: 'document' };
        if (!(t instanceof Element)) return { kind: Object.prototype.toString.call(t) };
        const o = { tag: t.tagName.toLowerCase(), selector: cssPath(t) };
        if (t.id) o.id = t.id;
        if (typeof t.className === 'string' && t.className) o.class = t.className;
        ['name', 'type', 'href', 'src', 'role', 'placeholder', 'title', 'aria-label', 'data-testid']
            .forEach(a => { const v = t.getAttribute(a); if (v) o[a] = clip(v, 300); });
        const txt = (t.textContent || '').trim().replace(/\s+/g, ' ');
        if (txt) o.text = clip(txt, 120);
        return o;
    }

    // поля, значения которых маскируем (пароли, одноразовые коды, карты)
    function isSecret(t) {
        if (!(t instanceof HTMLInputElement)) return false;
        const ac = (t.getAttribute('autocomplete') || '').toLowerCase();
        return t.type === 'password' || ac.includes('cc-') || ac.includes('one-time-code');
    }

    // ------------------------------------------------------------------ состояние
    function readStorage(getter) {
        const o = {};
        try {
            const st = getter();
            for (let i = 0; i < st.length; i++) {
                const k = st.key(i);
                o[k] = clip(st.getItem(k));
            }
        } catch (e) { o.__error = String(e); }
        return o;
    }

    function readCookies() {
        const o = {};
        try {
            document.cookie.split(';').forEach(p => {
                p = p.trim();
                if (!p) return;
                const i = p.indexOf('=');
                o[i < 0 ? p : p.slice(0, i)] = clip(i < 0 ? '' : p.slice(i + 1));
            });
        } catch (e) { o.__error = String(e); }
        return o;
    }

    function stateSnapshot() {
        return {
            cookies: readCookies(), // HttpOnly-куки из JS не видны — это ограничение браузера
            localStorage: readStorage(() => localStorage),
            sessionStorage: readStorage(() => sessionStorage)
        };
    }

    let prevState = stateSnapshot();

    function diffArea(a, b) {
        const ch = [];
        Object.keys(b).forEach(k => {
            if (!(k in a)) ch.push({ op: 'added', key: k, value: b[k] });
            else if (a[k] !== b[k]) ch.push({ op: 'changed', key: k, oldValue: a[k], newValue: b[k] });
        });
        Object.keys(a).forEach(k => { if (!(k in b)) ch.push({ op: 'removed', key: k, oldValue: a[k] }); });
        return ch;
    }

    function checkState(reason) {
        const cur = stateSnapshot();
        const changes = {};
        let any = false;
        ['cookies', 'localStorage', 'sessionStorage'].forEach(area => {
            const d = diffArea(prevState[area], cur[area]);
            if (d.length) { changes[area] = d; any = true; }
        });
        prevState = cur;
        if (any) {
            S.state.push({
                seq: nextSeq(), timestamp: now(), type: 'STATE_CHANGE',
                reason: reason || 'poll', pageUrl: location.href, changes
            });
            scheduleRender();
        }
    }

    let stateTimer = null, pendingReasons = [];
    function scheduleStateCheck(reason) {
        pendingReasons.push(reason);
        if (stateTimer) return;
        stateTimer = setTimeout(() => {
            stateTimer = null;
            const r = pendingReasons.slice(0, 5).join('; ');
            pendingReasons = [];
            checkState(r);
        }, 100);
    }

    // начальный снимок (полный)
    (async function initialSnapshot() {
        const entry = {
            seq: nextSeq(), timestamp: now(), type: 'INITIAL_SNAPSHOT',
            pageUrl: location.href, ...prevState
        };
        try {
            if (indexedDB.databases) entry.indexedDB = (await indexedDB.databases()).map(d => d.name);
        } catch (e) {}
        S.state.push(entry);
        scheduleRender();
    })();

    setInterval(() => checkState('poll'), CFG.statePollMs);
    window.addEventListener('storage', e => {
        S.state.push({
            seq: nextSeq(), timestamp: now(), type: 'STORAGE_EVENT_OTHER_TAB',
            key: e.key, oldValue: clip(e.oldValue), newValue: clip(e.newValue), url: e.url
        });
        scheduleRender();
    });

    // ------------------------------------------------------------------ сеть: хелперы
    const isTextual = ct => /text|json|xml|javascript|x-www-form-urlencoded|html|svg|graphql/i.test(ct) &&
        !/event-stream/i.test(ct);

    function normHeaders(h) {
        const o = {};
        try {
            if (!h) return o;
            if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => { o[k] = v; });
            else if (Array.isArray(h)) h.forEach(([k, v]) => { o[k] = v; });
            else Object.keys(h).forEach(k => { o[k] = h[k]; });
        } catch (e) {}
        return o;
    }

    function parseRawHeaders(raw) {
        const o = {};
        (raw || '').trim().split(/[\r\n]+/).forEach(l => {
            const i = l.indexOf(':');
            if (i > 0) o[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
        });
        return o;
    }

    function parseMaybeJson(text) {
        if (typeof text !== 'string') return text;
        const s = text.trimStart();
        if (text.length <= CFG.maxBodyChars && (s[0] === '{' || s[0] === '[')) {
            try { return JSON.parse(text); } catch (e) {}
        }
        return clip(text, CFG.maxBodyChars);
    }

    function describeBody(body) {
        if (body === null || body === undefined) return null;
        try {
            if (typeof body === 'string') {
                try { return JSON.parse(body); } catch (e) { return clip(body, CFG.maxBodyChars); }
            }
            if (body instanceof URLSearchParams) return { __type: 'URLSearchParams', data: body.toString() };
            if (body instanceof FormData) {
                const o = {};
                body.forEach((v, k) => {
                    const val = (v instanceof File) ? `[File ${v.name} ${v.size}b ${v.type}]` : clip(String(v));
                    if (k in o) o[k] = [].concat(o[k], val); else o[k] = val;
                });
                return { __type: 'FormData', data: o };
            }
            if (body instanceof Blob) return `[Blob ${body.size}b ${body.type}]`;
            if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[Binary ${body.byteLength}b]`;
        } catch (e) {}
        return '[не сериализуемое тело]';
    }

    // Группы шумных сетевых запросов (трекеры, метрики). Включаются галочками в панели, по умолчанию выключены.
    const NET_NOISE = {
        metrika: {
            label: 'Яндекс Метрика',
            test: (h, u) => /(^|\.)mc\.yandex\.[a-z.]+$/.test(h) || /(^|\.)(mc\.)?webvisor\.com$/.test(h)
                || /(^|\.)metrika\.yandex\.[a-z.]+$/.test(h)
                || (/(^|\.)yandex\.[a-z.]+$/.test(h) && /^\/(clck|metrika|watch)\//.test(u.pathname))
        },
        analytics: {
            label: 'Google Analytics / Tag Manager',
            test: (h, u) => /(^|\.)(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com)$/.test(h)
                || (/(^|\.)google\.[a-z.]+$/.test(h) && /^\/(g\/collect|ccm\/collect|pagead\/)/.test(u.pathname))
        },
        mailru: {
            label: 'Top.Mail.ru / VK / счётчики',
            test: h => /(^|\.)(top-fwz\d*\.mail\.ru|top\.mail\.ru|counter\.yadro\.ru|tns-counter\.ru|mediascope\.net)$/.test(h)
        },
        sentry: {
            label: 'Sentry (ошибки и телеметрия)',
            test: (h, u) => /sentry/i.test(h) || /sentry_(key|version)=/.test(u.search) || /\/api\/\d+\/(envelope|store)\/?$/.test(u.pathname)
        },
        other: {
            label: 'Прочие трекеры (hotjar, clarity, FB…)',
            test: (h, u) => /(^|\.)(hotjar\.(com|io)|clarity\.ms|mixpanel\.com|segment\.(io|com)|amplitude\.com|fullstory\.com|bat\.bing\.com|connect\.facebook\.net|adfox\.ru|tiktok\.com)$/.test(h)
                || (/(^|\.)facebook\.com$/.test(h) && /^\/tr\/?/.test(u.pathname))
        }
    };
    function netNoiseGroup(url) {
        try {
            const u = new URL(url, location.href), h = u.hostname.toLowerCase();
            for (const k in NET_NOISE) if (NET_NOISE[k].test(h, u)) return k;
        } catch (e) {}
        return null;
    }
    // true, если запрос относится к выключенной группе шума (такие запросы вообще не логируются)
    const netSkip = url => { const g = netNoiseGroup(url); return !!g && !S.noiseNet[g]; };

    // сигнатура запроса для схлопывания повторов подряд
    function netSig(e) {
        return [e.type, e.method, e.url, e.responseStatus, e.error || '', hashVal(e.requestBody), hashVal(e.responseBody)].join('|');
    }

    function pushNetwork(entry) {
        S.networkTotal++;
        const sig = netSig(entry);
        const last = S.network[S.network.length - 1];
        if (last && S._netSig === sig) {
            // такой же запрос подряд: только увеличиваем счётчик
            last.repeat = (last.repeat || 1) + 1;
            last.lastSeq = Math.max(last.lastSeq || last.seq, entry.seq);
            last.lastStartedAt = entry.startedAt;
        } else {
            S.network.push(entry);
            S._netSig = sig;
        }
        clog(`${TAG}[net] ${entry.method || ''} ${entry.url} -> ${entry.responseStatus ?? ''}`);
        scheduleRender();
    }

    // ------------------------------------------------------------------ сеть: fetch
    if (origFetch) {
        window.fetch = function (input, init) {
            try { // запросы выключенных групп шума пропускаем без записи
                if (netSkip((typeof Request !== 'undefined' && input instanceof Request) ? input.url : String(input))) return origFetch(input, init);
            } catch (e) {}
            const seq = nextSeq(), t0 = performance.now(), startedAt = now();
            let url = '', method = 'GET', reqHeaders = {}, credentials, bodyP = Promise.resolve(null);
            try {
                const isReq = typeof Request !== 'undefined' && input instanceof Request;
                url = absUrl(isReq ? input.url : String(input));
                method = (init && init.method) || (isReq ? input.method : 'GET');
                reqHeaders = normHeaders((init && init.headers) || (isReq ? input.headers : null));
                credentials = (init && init.credentials) || (isReq ? input.credentials : undefined);
                if (init && init.body !== undefined && init.body !== null) {
                    bodyP = Promise.resolve(describeBody(init.body));
                } else if (isReq && method !== 'GET' && method !== 'HEAD' && !input.bodyUsed) {
                    bodyP = input.clone().text().then(describeBody).catch(() => '[не удалось прочитать]');
                }
            } catch (e) {}
            const reqState = S.snapshotInRequests ? stateSnapshot() : undefined;

            const base = () => ({
                seq, startedAt, durationMs: Math.round(performance.now() - t0),
                type: 'FETCH', method: String(method).toUpperCase(), url,
                pageUrl: location.href, credentials,
                requestHeaders: reqHeaders, requestState: reqState
            });

            const p = origFetch(input, init);
            p.then(async resp => {
                // clone() вызывается синхронно, до того как страница начнет читать тело
                let clone = null;
                const ct = resp.headers.get('content-type') || '';
                const textual = isTextual(ct);
                try { if (textual) clone = resp.clone(); } catch (e) {}
                let respBody;
                try {
                    respBody = clone ? parseMaybeJson(await clone.text())
                        : `[нетекстовое тело: ${ct || 'unknown'}, ${resp.headers.get('content-length') || '?'} байт]`;
                } catch (e) { respBody = '[ошибка чтения: ' + e.message + ']'; }
                pushNetwork({
                    ...base(), requestBody: await bodyP,
                    responseStatus: resp.status, responseStatusText: resp.statusText,
                    responseUrl: resp.url, redirected: resp.redirected,
                    responseHeaders: normHeaders(resp.headers), responseBody: respBody
                });
                scheduleStateCheck(`fetch ${method} ${url}`);
            }, async err => {
                pushNetwork({
                    ...base(), requestBody: await bodyP,
                    responseStatus: 'FAILED', error: String(err && err.message || err)
                });
            });
            return p;
        };
    }

    // ------------------------------------------------------------------ сеть: XHR
    (function patchXHR() {
        const XP = XMLHttpRequest.prototype;
        const xOpen = XP.open, xSend = XP.send, xSet = XP.setRequestHeader;

        XP.open = function (method, url) {
            this.__sf = { method: String(method).toUpperCase(), url: absUrl(url), headers: {} };
            return xOpen.apply(this, arguments);
        };
        XP.setRequestHeader = function (k, v) {
            if (this.__sf) this.__sf.headers[k] = v;
            return xSet.apply(this, arguments);
        };
        XP.send = function (body) {
            const m = this.__sf, xhr = this;
            if (m && !netSkip(m.url)) {
                m.seq = nextSeq();
                m.t0 = performance.now();
                m.startedAt = now();
                m.body = describeBody(body);
                m.withCredentials = xhr.withCredentials;
                m.state = S.snapshotInRequests ? stateSnapshot() : undefined;
                ['error', 'abort', 'timeout'].forEach(k => xhr.addEventListener(k, () => { m.errorKind = k; }));
                xhr.addEventListener('loadend', () => {
                    let respBody;
                    try {
                        const rt = xhr.responseType;
                        if (rt === '' || rt === 'text') respBody = parseMaybeJson(xhr.responseText);
                        else if (rt === 'json') respBody = safe(xhr.response);
                        else respBody = `[${rt} response]`;
                    } catch (e) { respBody = '[не удалось прочитать]'; }
                    pushNetwork({
                        seq: m.seq, startedAt: m.startedAt,
                        durationMs: Math.round(performance.now() - m.t0),
                        type: 'XHR', method: m.method, url: m.url, pageUrl: location.href,
                        withCredentials: m.withCredentials,
                        requestHeaders: m.headers, requestBody: m.body, requestState: m.state,
                        responseStatus: xhr.status === 0 ? 'FAILED' : xhr.status,
                        responseStatusText: xhr.statusText, responseUrl: xhr.responseURL,
                        responseHeaders: parseRawHeaders(xhr.getAllResponseHeaders()),
                        responseBody: respBody, error: m.errorKind
                    });
                    scheduleStateCheck(`xhr ${m.method} ${m.url}`);
                });
            }
            return xSend.apply(this, arguments);
        };
    })();

    // ------------------------------------------------------------------ сеть: sendBeacon
    if (navigator.sendBeacon) {
        const ob = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) {
            if (netSkip(String(url))) return ob(url, data);
            pushNetwork({
                seq: nextSeq(), startedAt: now(), type: 'BEACON', method: 'POST',
                url: absUrl(url), pageUrl: location.href, requestBody: describeBody(data),
                requestState: S.snapshotInRequests ? stateSnapshot() : undefined
            });
            return ob(url, data);
        };
    }

    // ------------------------------------------------------------------ сеть: WebSocket
    if (window.WebSocket) {
        window.WebSocket = new Proxy(window.WebSocket, {
            construct(target, args, newTarget) {
                const ws = Reflect.construct(target, args, newTarget);
                const url = String(args[0]);
                if (netSkip(url)) return ws;
                const log = (direction, data) => pushNetwork({
                    seq: nextSeq(), startedAt: now(), type: 'WS', method: direction, url,
                    pageUrl: location.href,
                    [direction === 'SEND' ? 'requestBody' : 'responseBody']:
                        data === undefined ? undefined : (typeof data === 'string' ? parseMaybeJson(data) : describeBody(data))
                });
                log('OPEN');
                ws.addEventListener('message', e => log('RECV', e.data));
                ws.addEventListener('close', e => log('CLOSE', `code=${e.code} reason=${e.reason}`));
                ws.addEventListener('error', () => log('ERROR'));
                const os = ws.send;
                ws.send = function (d) { log('SEND', d); return os.call(ws, d); };
                return ws;
            }
        });
    }

    // ------------------------------------------------------------------ события
    const OWN_UI_ID = '__sf_panel';
    // элементы самого скрипта (панель и временная ссылка скачивания) в логи не попадают
    const isOwnUi = t => t instanceof Element && !!t.closest('#' + OWN_UI_ID + ',[data-sf-own]');

    // Группы шумных событий. Каждая включается отдельной галочкой в панели (по умолчанию выключены).
    const NOISE_GROUPS = {
        scroll: { label: 'Скролл и колесо мыши', types: ['scroll', 'scrollend', 'wheel'] },
        emptyClick: { label: 'Клики «в никуда» (не по кнопке/ссылке/полю)', types: [] }, // особый случай, см. isEmptyClick
        pointer: { label: 'Нажатия мыши (pointer/mouse down/up)', types: ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup'] },
        focus: { label: 'Фокус (focus / blur)', types: ['focus', 'blur', 'focusin', 'focusout'] },
        select: { label: 'Выделение текста', types: ['selectstart', 'select', 'selectionchange'] },
        keyLow: { label: 'keyup / keypress (оставляя keydown)', types: ['keyup', 'keypress'] },
        hover: {
            label: 'Движение мыши, drag, медиа, анимации',
            types: [
                'mousemove', 'pointermove', 'pointerrawupdate', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
                'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'touchmove', 'drag', 'dragover',
                'dragenter', 'dragleave', 'timeupdate', 'progress', 'loadeddata', 'loadedmetadata',
                'loadstart', 'durationchange', 'canplay', 'canplaythrough', 'seeking', 'seeked', 'playing', 'waiting',
                'stalled', 'suspend', 'emptied', 'ratechange', 'volumechange', 'animationstart', 'animationend',
                'animationiteration', 'animationcancel', 'transitionstart', 'transitionend', 'transitionrun',
                'transitioncancel', 'devicemotion', 'deviceorientation', 'deviceorientationabsolute', 'beforeinput',
                'gamepadconnected', 'gamepaddisconnected'
            ]
        }
    };
    const TYPE_GROUP = {};
    Object.keys(NOISE_GROUPS).forEach(g => NOISE_GROUPS[g].types.forEach(t => { TYPE_GROUP[t] = g; }));
    // true, если событие относится к выключенной группе шума
    const noiseOff = type => { const g = TYPE_GROUP[type]; return !!g && !S.noise[g]; };

    // «Клик в никуда»: цель не интерактивна (нет ссылки/кнопки/поля/обработчика, курсор не pointer)
    const EMPTY_CLICK_TYPES = new Set(['click', 'dblclick', 'auxclick']);
    const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,option,video,audio,'
        + '[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=switch],[role=option],'
        + '[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]';
    function isEmptyClick(t) {
        if (!(t instanceof Element)) return true;
        try {
            if (t.closest(INTERACTIVE)) return false;
            return getComputedStyle(t).cursor !== 'pointer'; // cursor наследуется от родителей
        } catch (e) { return false; }
    }
    const NEVER = new Set(['unload']); // вызывает предупреждения Permissions-Policy
    const THROTTLED = new Set(['scroll', 'wheel', 'resize']);
    const STATE_TRIGGERS = new Set(['click', 'dblclick', 'change', 'submit', 'input', 'paste', 'drop', 'contextmenu']);

    function discoverEventNames() {
        const set = new Set([
            'click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu', 'auxclick', 'keydown', 'keyup', 'keypress',
            'input', 'change', 'submit', 'reset', 'invalid', 'focus', 'blur', 'focusin', 'focusout', 'scroll',
            'wheel', 'resize', 'copy', 'cut', 'paste', 'dragstart', 'dragend', 'drop', 'touchstart', 'touchend',
            'touchcancel', 'pointerdown', 'pointerup', 'pointercancel', 'select', 'toggle', 'hashchange',
            'popstate', 'visibilitychange', 'beforeunload', 'pagehide', 'pageshow', 'load', 'DOMContentLoaded',
            'readystatechange', 'error', 'unhandledrejection', 'rejectionhandled', 'online', 'offline',
            'message', 'languagechange', 'fullscreenchange', 'securitypolicyviolation'
        ]);
        const add = obj => { try { for (const k in obj) if (k.startsWith('on')) set.add(k.slice(2)); } catch (e) {} };
        add(window); add(document); add(HTMLElement.prototype);
        return Array.from(set).filter(n => n && !n.startsWith('webkit') && !NEVER.has(n));
    }

    const lastFire = {};
    const listened = new Set();

    function describeEvent(e) {
        const t = e.target;
        const rec = {
            seq: nextSeq(), timestamp: now(), type: e.type,
            isTrusted: e.isTrusted, // true = реальное действие пользователя, false = программно вызвано скриптом
            target: describeTarget(t), pageUrl: location.href
        };
        try {
            if (e instanceof MouseEvent) {
                rec.mouse = {
                    x: e.clientX, y: e.clientY, pageX: e.pageX, pageY: e.pageY, button: e.button,
                    ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey
                };
            }
            if (e instanceof KeyboardEvent) {
                rec.key = isSecret(t) ? '[masked]' : {
                    key: e.key, code: e.code, repeat: e.repeat,
                    ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey
                };
            }
            if (e.type === 'input' || e.type === 'change') {
                if (isSecret(t)) rec.value = '[masked]';
                else if ('value' in t) rec.value = clip(String(t.value));
                if ('checked' in t && (t.type === 'checkbox' || t.type === 'radio')) rec.checked = t.checked;
                if (t instanceof HTMLSelectElement) {
                    rec.selected = Array.from(t.selectedOptions).map(o => o.value);
                }
            }
            if (e.type === 'submit' && t instanceof HTMLFormElement) {
                rec.form = { action: t.action, method: t.method, fields: {} };
                new FormData(t).forEach((v, k) => {
                    const el = t.elements[k];
                    rec.form.fields[k] = (el && isSecret(el)) ? '[masked]'
                        : (v instanceof File ? `[File ${v.name}]` : clip(String(v)));
                });
            }
            if (e.type === 'wheel') rec.wheel = { dx: e.deltaX, dy: e.deltaY };
            if (e.type === 'scroll') {
                rec.scroll = (t === document || t === window)
                    ? { x: scrollX, y: scrollY }
                    : { top: t.scrollTop, left: t.scrollLeft };
            }
            if (e.type === 'resize') rec.viewport = { w: innerWidth, h: innerHeight };
            if (e.type === 'copy' || e.type === 'cut') rec.selection = clip(String(getSelection()));
            if (e.type === 'paste' && e.clipboardData) rec.pasted = clip(e.clipboardData.getData('text/plain'));
            if (e.type === 'hashchange') { rec.oldURL = e.oldURL; rec.newURL = e.newURL; }
            if (e.type === 'popstate') rec.historyState = safe(e.state);
            if (e.type === 'visibilitychange') rec.visibilityState = document.visibilityState;
            if (e.type === 'message') { rec.origin = e.origin; rec.data = safe(e.data); }
            if (e.type === 'error') {
                rec.error = {
                    message: e.message, filename: e.filename, line: e.lineno, col: e.colno,
                    stack: e.error && clip(e.error.stack)
                };
                if (t instanceof Element) rec.error.resource = t.src || t.href;
            }
            if (e.type === 'unhandledrejection') rec.reason = safe(e.reason);
            if (e.type === 'securitypolicyviolation') {
                rec.csp = { blockedURI: e.blockedURI, directive: e.violatedDirective };
            }
            if (typeof CustomEvent !== 'undefined' && e instanceof CustomEvent) rec.detail = safe(e.detail);
        } catch (err) { rec.describeError = String(err); }
        return rec;
    }

    // Сигнатура события для схлопывания повторов подряд. Координаты мыши, позиция скролла и время не учитываются.
    function eventSig(r) {
        const { seq, timestamp, mouse, scroll, wheel, lastSeq, lastTimestamp, repeat, ...rest } = r;
        if (mouse) rest._m = [mouse.button, mouse.ctrl, mouse.shift, mouse.alt, mouse.meta].join();
        return JSON.stringify(rest);
    }

    function pushEvent(rec) {
        S.eventsTotal++;
        const sig = eventSig(rec);
        const last = S.events[S.events.length - 1];
        if (last && S._evtSig === sig) {
            // то же событие подряд: увеличиваем счётчик, запоминаем последнее вхождение
            last.repeat = (last.repeat || 1) + 1;
            last.lastSeq = rec.seq;
            last.lastTimestamp = rec.timestamp;
            if (rec.mouse) last.mouse = rec.mouse;      // координаты мыши — последние
            if (rec.scroll) last.scroll = rec.scroll;   // позиция скролла — последняя
            if (rec.wheel && last.wheel) last.wheel = { dx: last.wheel.dx + rec.wheel.dx, dy: last.wheel.dy + rec.wheel.dy }; // колесо — сумма
        } else {
            S.events.push(rec);
            S._evtSig = sig;
        }
        scheduleRender();
    }

    function onEvent(e) {
        const t = e.target;
        if (isOwnUi(t)) return;
        if (noiseOff(e.type)) return;
        if (!S.noise.emptyClick && EMPTY_CLICK_TYPES.has(e.type) && isEmptyClick(t)) return;
        if (e.type === 'load' && t !== window && t !== document) return; // load ресурсов — шум
        if (THROTTLED.has(e.type)) {
            const n = performance.now();
            if (n - (lastFire[e.type] || 0) < CFG.throttleMs) return;
            lastFire[e.type] = n;
        }
        pushEvent(describeEvent(e));
        if (STATE_TRIGGERS.has(e.type)) scheduleStateCheck('event ' + e.type);
    }

    function attachEventListeners() {
        discoverEventNames().forEach(name => {
            if (noiseOff(name)) return;
            if (listened.has(name)) return;
            listened.add(name);
            window.addEventListener(name, onEvent, { capture: true, passive: true });
        });
    }
    attachEventListeners();

    // события, которые сайт сам генерирует через dispatchEvent (кастомные и т.п.)
    (function patchDispatch() {
        const od = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function (ev) {
            try {
                if (ev && !listened.has(ev.type) && !noiseOff(ev.type) && !isOwnUi(this)) {
                    pushEvent({
                        seq: nextSeq(), timestamp: now(), type: ev.type, source: 'dispatchEvent',
                        isTrusted: false, target: describeTarget(this),
                        detail: safe(ev.detail), pageUrl: location.href
                    });
                }
            } catch (e) {}
            return od.call(this, ev);
        };
    })();

    // навигация SPA (history API)
    ['pushState', 'replaceState'].forEach(fn => {
        const orig = history[fn];
        history[fn] = function (state, title, url) {
            pushEvent({
                seq: nextSeq(), timestamp: now(), type: 'history.' + fn, isTrusted: false,
                target: { kind: 'history' }, state: safe(state), url: url === undefined ? null : String(url),
                pageUrl: location.href
            });
            const r = orig.apply(this, arguments);
            scheduleStateCheck('history.' + fn);
            return r;
        };
    });

    // ------------------------------------------------------------------ скачивание
    function download(name, text, mime) {
        const blob = new Blob([text], { type: mime || 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.setAttribute('data-sf-own', '1'); // чтобы клик по этой ссылке не попал в лог событий
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    const stamp = () => Date.now();

    // ------------------------------------------------------------------ сжатие логов при экспорте
    // Идея: в самих записях остаётся только уникальное, а всё повторяющееся выносится в шапку (header):
    //   1) заголовки, одинаковые у всех запросов одного origin  -> header.commonHeaders
    //   2) cookies/storage в запросах: полный снимок только у первого (header.stateBase), дальше stateDiff
    //   3) адреса своего origin пишутся без домена; pageUrl — только при смене
    //   4) любые длинные строки, встречающиеся 2+ раза, -> "@N" и таблица header.dict
    // <compact>
    const REF_RE = /^@\d+$/;
    const NET_TYPES = new Set(['FETCH', 'XHR', 'BEACON', 'WS']);
    const isNetRec = r => r.log === 'network' || NET_TYPES.has(r.type);

    function mapDeep(v, f) {
        if (Array.isArray(v)) return v.map(x => mapDeep(x, f));
        if (v && typeof v === 'object') {
            const o = {};
            for (const k in v) o[k] = mapDeep(v[k], f);
            return o;
        }
        return f(v);
    }

    function originOf(u) { try { return new URL(u).origin; } catch (e) { return null; } }

    // 1) общие заголовки по origin (запись без поля = «нет заголовков сверх общих»)
    function factorHeaders(records, field, common) {
        const groups = {};
        records.forEach(r => {
            if (!isNetRec(r) || typeof r.url !== 'string') return;
            const o = originOf(r.url);
            if (o) (groups[o] = groups[o] || []).push(r);
        });
        Object.keys(groups).forEach(o => {
            const g = groups[o];
            if (g.length < 2) return;
            const first = g[0][field] || {}, same = {};
            Object.keys(first).forEach(k => { if (g.every(r => r[field] && r[field][k] === first[k])) same[k] = first[k]; });
            if (!Object.keys(same).length) return;
            (common[o] = common[o] || {})[field] = same;
            g.forEach(r => {
                const rest = {};
                Object.keys(r[field]).forEach(k => { if (!(k in same)) rest[k] = r[field][k]; });
                r[field] = rest;
            });
        });
    }

    // 2) cookies/localStorage/sessionStorage в запросах: база + изменения относительно предыдущего запроса
    function chainState(records, header) {
        let prev = null;
        records.forEach(r => {
            if (!isNetRec(r) || !r.requestState) return;
            const cur = r.requestState;
            delete r.requestState;
            if (!prev) header.stateBase = cur;
            else {
                const d = {};
                ['cookies', 'localStorage', 'sessionStorage'].forEach(a => {
                    const ch = diffArea(prev[a] || {}, cur[a] || {});
                    if (ch.length) d[a] = ch;
                });
                if (Object.keys(d).length) r.stateDiff = d;
            }
            prev = cur;
        });
    }

    // 3) адреса своего origin без домена; pageUrl только при смене
    function shortenUrls(records, origin) {
        const strip = v => {
            if (typeof v !== 'string' || !v.startsWith(origin)) return v;
            let rest = v.slice(origin.length);
            if (rest && '/?#'.indexOf(rest[0]) < 0) return v; // это другой домен (origin — только префикс)
            if (rest[0] !== '/') rest = '/' + rest;
            return rest;
        };
        let prevPage = null;
        records.forEach(r => {
            ['url', 'responseUrl', 'pageUrl', 'oldURL', 'newURL'].forEach(k => { if (typeof r[k] === 'string') r[k] = strip(r[k]); });
            if (r.target) ['href', 'src'].forEach(k => { if (typeof r.target[k] === 'string') r.target[k] = strip(r.target[k]); });
            if (r.form && typeof r.form.action === 'string') r.form.action = strip(r.form.action);
            if (r.pageUrl !== undefined) {
                if (r.pageUrl === prevPage) delete r.pageUrl; else prevPage = r.pageUrl;
            }
        });
    }

    // 4) повторяющиеся длинные строки -> ссылки "@N"
    function dedupeStrings(data) {
        const count = new Map();
        mapDeep(data, v => {
            if (typeof v === 'string' && (v.length >= 24 || REF_RE.test(v))) count.set(v, (count.get(v) || 0) + 1);
            return v;
        });
        const ids = new Map(), dict = {};
        let n = 0;
        count.forEach((c, s) => {
            // строки, похожие на ссылку, обязательно уходят в словарь, чтобы их нельзя было спутать со ссылкой
            if (REF_RE.test(s) || (c - 1) * s.length > c * 6 + 8) {
                const id = '@' + (++n);
                ids.set(s, id);
                dict[id] = s;
            }
        });
        return { data: mapDeep(data, v => (typeof v === 'string' && ids.has(v)) ? ids.get(v) : v), dict };
    }

    function compactRecords(recordsIn, origin) {
        const records = JSON.parse(JSON.stringify(recordsIn, jsonReplacer)); // глубокая копия: оригинальные логи не трогаем
        const header = {}, common = {};
        factorHeaders(records, 'requestHeaders', common);
        factorHeaders(records, 'responseHeaders', common);
        records.forEach(r => ['requestHeaders', 'responseHeaders'].forEach(f => {
            if (r[f] && typeof r[f] === 'object' && !Object.keys(r[f]).length) delete r[f];
        }));
        chainState(records, header);
        if (Object.keys(common).length) header.commonHeaders = common;
        shortenUrls(records, origin);
        const res = dedupeStrings({ header, records });
        if (Object.keys(res.dict).length) res.data.header.dict = res.dict;
        return res.data;
    }
    // </compact>

    const KIND_FILE = { network: 'network_logs', events: 'event_logs', state: 'state_logs', full: 'full_session' };
    const KIND_EMPTY = {
        network: () => S.network.length, events: () => S.events.length, state: () => S.state.length
    };
    const KIND_EMPTY_MSG = {
        network: 'Сетевых логов пока нет.', events: 'Событий пока нет.', state: 'Изменений состояния пока нет.'
    };

    function exportMeta(kind) {
        const compact = S.compact;
        const guide = [
            'records отсортированы по seq (хронология). seq/timestamp — первое вхождение записи.',
            'repeat = сколько раз подряд повторилась такая же запись (если поля нет — 1); lastSeq/lastTimestamp/lastStartedAt — последнее вхождение; '
            + 'у повторов mouse и scroll — последние значения, wheel — суммарный сдвиг. Время и счётчик нужны, чтобы видеть темп действий.',
            'isTrusted=true — реальное действие пользователя, false — вызвано скриптом сайта.',
            'log=network — сетевые запросы, log=event — JS-события, log=state — изменения cookies/localStorage/sessionStorage (reason — что их вызвало); '
            + 'у log=network в requestState/stateBase — состояние в момент запроса.'
        ];
        if (compact) {
            guide.push(
                'Сжатие: (1) строка вида "@N" — ссылка на header.dict["@N"]; '
                + '(2) адрес, начинающийся с "/", относится к pageOrigin; '
                + '(3) pageUrl указан только там, где он изменился относительно предыдущей записи; '
                + '(4) header.stateBase — cookies/localStorage/sessionStorage у первого запроса, stateDiff — изменения относительно предыдущего запроса '
                + '(нет stateDiff — состояние то же); '
                + '(5) header.commonHeaders[origin].requestHeaders/responseHeaders — заголовки, общие для всех запросов этого origin; '
                + 'у записи указаны только отличающиеся (нет поля — только общие).'
            );
        }
        guide.push('Поля type=password, одноразовые коды и данные карт замаскированы. HttpOnly-cookies из JS не видны. '
            + 'recordedGroups: false = события/запросы этой группы не записывались (шум отключён).');
        return {
            tool: 'WebScrabberFull', kind, startedAt: S.startedAt, exportedAt: now(),
            pageOrigin: location.origin, pageUrl: location.href, title: document.title,
            referrer: document.referrer, userAgent: navigator.userAgent, language: navigator.language,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            viewport: { w: innerWidth, h: innerHeight }, screen: { w: screen.width, h: screen.height },
            counts: {
                network: { total: S.networkTotal, withoutConsecutiveRepeats: S.network.length },
                events: { total: S.eventsTotal, withoutConsecutiveRepeats: S.events.length },
                state: S.state.length
            },
            recordedGroups: { events: { ...S.noise }, network: { ...S.noiseNet } },
            howToRead: guide
        };
    }

    // собирает текст файла экспорта: kind = network | events | state | full
    function buildExport(kind) {
        checkState('export');
        let recs;
        if (kind === 'network') recs = S.network;
        else if (kind === 'events') recs = S.events;
        else if (kind === 'state') recs = S.state;
        else {
            recs = []
                .concat(S.network.map(x => ({ log: 'network', ...x })))
                .concat(S.events.map(x => ({ log: 'event', ...x })))
                .concat(S.state.map(x => ({ log: 'state', ...x })))
                .sort((a, b) => a.seq - b.seq);
        }
        const meta = exportMeta(kind);
        const name = `${KIND_FILE[kind]}_${stamp()}.json`;
        if (!S.compact) return { name, text: JSON.stringify({ meta, records: recs }, jsonReplacer, 2) };
        const { header, records } = compactRecords(recs, location.origin);
        const text = '{\n"meta": ' + JSON.stringify(meta, jsonReplacer, 2)
            + ',\n"header": ' + JSON.stringify(header, jsonReplacer, 1)
            + ',\n"records": [\n' + records.map(r => JSON.stringify(r)).join(',\n') + '\n]\n}\n';
        return { name, text };
    }

    function downloadKind(kind) {
        if (KIND_EMPTY[kind] && !KIND_EMPTY[kind]()) { alert(KIND_EMPTY_MSG[kind]); return; }
        const { name, text } = buildExport(kind);
        download(name, text);
    }
    const downloadNetworkLogs = () => downloadKind('network');
    const downloadEventLogs = () => downloadKind('events');
    const downloadStateLogs = () => downloadKind('state');
    const downloadFullSession = () => downloadKind('full');

    function clearAll() {
        if (!confirm('Очистить все логи?')) return;
        S.network.length = 0;
        S.events.length = 0;
        S.state.length = 0;
        S.depsCount = 0;
        S.eventsTotal = 0;
        S.networkTotal = 0;
        S._evtSig = S._netSig = null;
        prevState = stateSnapshot();
        render();
    }

    // ------------------------------------------------------------------ рекурсивная выгрузка зависимостей
    function scanJs(text) {
        const out = [];
        const add = (ref, kind, guess) => out.push({ ref, kind, guess });
        let m;
        const reStatic = /\b(?:import|export)\s+(?:[^'"`;()]*?\s+from\s+)?["']([^"']+)["']/g;
        while ((m = reStatic.exec(text))) add(m[1], 'js', false);
        const reDyn = /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
        while ((m = reDyn.exec(text))) add(m[1], 'js', false);
        const reWorker = /importScripts\(([^)]*)\)/g;
        while ((m = reWorker.exec(text))) {
            const reStr = /["'`]([^"'`]+)["'`]/g;
            let s;
            while ((s = reStr.exec(m[1]))) add(s[1], 'js', false);
        }
        // догадки: строковые литералы, похожие на пути к js (webpack-чанки и т.п.)
        const reGuess = /["'`]((?:https?:)?\/\/[^"'`\s]+?\.m?js(?:\?[^"'`\s]*)?|(?:\.{0,2}\/)?[\w\-./@~%]+?\.m?js(?:\?[^"'`\s]*)?)["'`]/g;
        while ((m = reGuess.exec(text))) add(m[1], 'js', true);
        return out;
    }

    function scanCss(text) {
        const out = [];
        const re = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/g;
        let m;
        while ((m = re.exec(text))) out.push({ ref: m[1], kind: 'css', guess: false });
        return out;
    }

    // Популярные библиотеки и CDN считаются внешним шумом по умолчанию.
    // При включении includeLibraries они снова попадают в выгрузку.
    function isPopularLibraryUrl(rawUrl) {
        try {
            const u = new URL(rawUrl, location.href);
            const host = u.hostname.toLowerCase().replace(/^www\./, '');
            const path = u.pathname.toLowerCase();
            const cdnHosts = [
                'fonts.googleapis.com', 'fonts.gstatic.com',
                'ajax.googleapis.com', 'ajax.aspnetcdn.com',
                'cdnjs.cloudflare.com', 'cdn.jsdelivr.net',
                'unpkg.com', 'code.jquery.com', 'stackpath.bootstrapcdn.com',
                'maxcdn.bootstrapcdn.com', 'use.fontawesome.com',
                'kit.fontawesome.com', 'cdnjs.com'
            ];
            if (cdnHosts.some(h => host === h || host.endsWith('.' + h))) return true;

            const libraryHosts = [
                'jquery.com', 'getbootstrap.com', 'fontawesome.com',
                'react.dev', 'reactjs.org', 'vuejs.org'
            ];
            if (libraryHosts.some(h => host === h || host.endsWith('.' + h))) return true;

            // Часто библиотеки размещены на собственном домене сайта или в локальном каталоге.
            return /(?:^|\/)(?:jquery(?:[-.]|\/)|bootstrap(?:[-.]|\/)|popper(?:[-.]|\/)|fontawesome(?:[-.]|\/)|font-awesome(?:[-.]|\/)|lodash(?:[-.]|\/)|moment(?:[-.]|\/)|dayjs(?:[-.]|\/)|axios(?:[-.]|\/)|react(?:[-.]|\/)|react-dom(?:[-.]|\/)|vue(?:[-.]|\/)|angular(?:[-.]|\/)|swiper(?:[-.]|\/)|slick(?:[-.]|\/)|normalize(?:[-.]|\/)|tailwind(?:[-.]|\/))/.test(path)
                || /(?:^|[?&])(?:family|libraries|library)=/i.test(u.search) && /fonts\.googleapis\.com$/.test(host);
        } catch (e) {
            return false;
        }
    }

    // Замена содержимого base64 (картинки, шрифты и т.п., вставленные прямо в код) на короткую метку.
    //  1) data-URI:  ";base64,<данные>"  -> ";base64,BASE64CODESKIP"  (от 100 символов)
    //  2) длинные строки-литералы из одних base64-символов (от 300 символов) -> "BASE64CODESKIP"
    const B64_SKIP = 'BASE64CODESKIP';
    const RE_B64_URI = /(;base64,)(?:[A-Za-z0-9+\/_\-=%]|\\\/){100,}/gi;
    const RE_B64_STR = /(["'`])(?=[A-Za-z0-9+\/=]*[a-z])(?=[A-Za-z0-9+\/=]*[A-Z])[A-Za-z0-9+\/=]{300,}\1/g;
    function skipBase64(text, counter) {
        if (S.includeBase64 || !text) return text;
        let n = 0;
        text = text.replace(RE_B64_URI, (m, pre) => { n++; return pre + B64_SKIP; });
        text = text.replace(RE_B64_STR, (m, q) => { n++; return q + B64_SKIP + q; });
        if (counter) counter.n += n;
        return text;
    }

    // Полный «живой» HTML страницы — то же, что в Inspector: <html> → Edit as HTML → копировать всё.
    // Это DOM после выполнения JS (outerHTML корневого элемента). Собственная панель скрипта вырезается.
    function liveHtmlSnapshot() {
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('#' + OWN_UI_ID + ',[data-sf-own]').forEach(n => n.remove());
        const dt = document.doctype;
        let doctype = '';
        if (dt) {
            doctype = '<!DOCTYPE ' + dt.name
                + (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : (dt.systemId ? ' SYSTEM' : ''))
                + (dt.systemId ? ' "' + dt.systemId + '"' : '') + '>\n';
        }
        return doctype + clone.outerHTML;
    }

    async function collectDeps() {
        if (S.crawling) return;
        if (!origFetch) { alert('fetch недоступен'); return; }
        S.crawling = true;
        S.depsCount = 0;

        // FILE0: снимок живого DOM на момент клика (до сетевых запросов обхода)
        const b64 = { n: 0 };            // сколько base64-вставок заменено
        let liveHtml = '';
        try { liveHtml = liveHtmlSnapshot(); }
        catch (e) { liveHtml = document.documentElement.outerHTML; }
        liveHtml = skipBase64(liveHtml, b64);

        const includeCss = S.includeCss;
        const files = [], failed = [], seen = new Set(), queue = [];
        let active = 0, guessMisses = 0;

        const pageBase = location.href;
        const toUrl = (ref, base) => {
            try {
                const u = new URL(ref, base);
                u.hash = '';
                return /^https?:$/.test(u.protocol) ? u.href : null;
            } catch (e) { return null; }
        };
        const enqueue = (ref, base, from, kind, guess) => {
            if (kind === 'css' && !includeCss) return;
            if (!guess && !/^(\.|\/|https?:)/.test(ref)) return;           // голые npm-имена модулей пропускаем
            if (guess && !/^(\.|\/|https?:)/.test(ref)) base = pageBase;   // webpack-подобные пути — от страницы
            const url = toUrl(ref, base);
            if (!url || (!S.includeLibraries && isPopularLibraryUrl(url)) || seen.has(url) || seen.size >= CFG.maxDepFiles) return;
            seen.add(url);
            queue.push({ url, from, kind, guess });
        };

        // 1) HTML-документ: исходник с сервера, при неудаче — текущий DOM
        let html = '';
        try {
            const r = await origFetch(location.href, { credentials: 'include' });
            html = await r.text();
        } catch (e) { html = document.documentElement.outerHTML; }
        html = skipBase64(html, b64);
        files.push({ label: pageBase.split('#')[0], content: html });
        seen.add(toUrl(pageBase, pageBase));

        const baseTag = document.querySelector('base[href]');
        const base = baseTag ? toUrl(baseTag.getAttribute('href'), pageBase) || pageBase : pageBase;
        const doc = new DOMParser().parseFromString(html, 'text/html');

        // 2) из исходного HTML и из живого DOM (динамически добавленные теги)
        [doc, document].forEach(d => {
            d.querySelectorAll('script[src]').forEach(el => enqueue(el.getAttribute('src'), base, 'html', 'js', false));
            d.querySelectorAll('link[rel~="modulepreload"][href]').forEach(el => enqueue(el.getAttribute('href'), base, 'html', 'js', false));
            d.querySelectorAll('link[rel~="preload"][as="script"][href]').forEach(el => enqueue(el.getAttribute('href'), base, 'html', 'js', false));
            if (includeCss) {
                d.querySelectorAll('link[rel~="stylesheet"][href]').forEach(el => enqueue(el.getAttribute('href'), base, 'html', 'css', false));
            }
        });

        // 3) всё, что браузер реально загрузил (Resource Timing)
        performance.getEntriesByType('resource').forEach(r => {
            const n = r.name;
            if (r.initiatorType === 'script' || /\.m?js(\?|$)/i.test(n)) enqueue(n, pageBase, 'resource-timing', 'js', false);
            else if (includeCss && (r.initiatorType === 'css' || /\.css(\?|$)/i.test(n)) && r.initiatorType !== 'img') {
                enqueue(n, pageBase, 'resource-timing', 'css', false);
            }
        });

        // 4) inline-скрипты (и inline-стили при включенном CSS) — как отдельные «файлы»
        let inlineN = 0;
        doc.querySelectorAll('script:not([src])').forEach(el => {
            const txt = el.textContent;
            if (!txt || !txt.trim()) return;
            files.push({ label: `inline <script${el.type ? ' type=' + el.type : ''}> #${++inlineN} of ${pageBase}`, content: txt });
            if (!el.type || /javascript|module/.test(el.type)) scanJs(txt).forEach(d => enqueue(d.ref, base, 'inline', d.kind, d.guess));
        });
        if (includeCss) {
            let styleN = 0;
            doc.querySelectorAll('style').forEach(el => {
                if (!el.textContent.trim()) return;
                files.push({ label: `inline <style> #${++styleN} of ${pageBase}`, content: el.textContent });
                scanCss(el.textContent).forEach(d => enqueue(d.ref, base, 'inline', 'css', false));
            });
        }

        // 5) рекурсивный обход
        async function worker() {
            while (true) {
                const item = queue.shift();
                if (!item) { if (active === 0) return; await sleep(30); continue; }
                active++;
                try {
                    const r = await origFetch(item.url, { credentials: 'include' });
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    const text = skipBase64(await r.text(), b64);
                    files.push({ label: item.url, content: text });
                    const deps = item.kind === 'css' ? scanCss(text) : scanJs(text);
                    deps.forEach(d => enqueue(d.ref, item.url, item.url, d.kind, d.guess));
                } catch (e) {
                    if (item.guess) guessMisses++;
                    else failed.push({ url: item.url, from: item.from, reason: String(e && e.message || e) });
                } finally {
                    active--;
                    S.depsCount = files.length;
                    scheduleRender();
                }
            }
        }
        try {
            await Promise.all(Array.from({ length: CFG.depConcurrency }, worker));
        } finally {
            S.crawling = false;
        }

        // 6) сборка итогового файла: FILE1 [url]: ...
        let out = `FILE0 [${pageBase.split('#')[0]} — live DOM: document.documentElement.outerHTML]:\n${liveHtml}\n\n`;
        files.forEach((f, i) => { out += `FILE${i + 1} [${f.label}]:\n${f.content}\n\n`; });
        if (failed.length) {
            out += 'NOT DOWNLOADED:\n' + failed.map(f => `- [${f.url}] (${f.reason}; from ${f.from})`).join('\n') + '\n';
        }
        S.depsCount = files.length;
        render();
        download(`fullsitelist_${location.hostname}_${stamp()}.txt`, out, 'text/plain');
        clog(`${TAG} fullsitelist: FILE0 (live DOM) + ${files.length} файлов, ошибок: ${failed.length}, неподтвержденных догадок: ${guessMisses}, base64 заменено: ${b64.n}`);
    }

    // ------------------------------------------------------------------ защита логов при навигации
    // Обычные ссылки / window.open откладываются до нажатия «Продолжить».
    // Для location.href/assign/replace, form.submit(), reload и закрытия вкладки
    // работает beforeunload: браузер покажет стандартное «Остаться / Покинуть».
    // Программно вызвать скачивание внутри beforeunload надёжно нельзя.
    const guard = { pending: null, bypass: false, overlay: null };
    const nativeOpen = window.open;

    function guardLog(type, details) {
        pushEvent({ seq: nextSeq(), timestamp: now(), type,
            source: 'navigationGuard', isTrusted: false,
            target: { kind: 'navigation' }, pageUrl: location.href, ...details });
    }

    function guardHide() {
        if (guard.overlay) guard.overlay.hidden = true;
        guard.pending = null;
    }

    function guardShow(kind, destination, proceed) {
        if (!S.navigationGuard || guard.bypass) { proceed(); return; }
        guard.pending = { kind, destination, proceed };
        guardLog('NAVIGATION_PAUSED', { kind, destination });
        if (guard.overlay) {
            guard.overlay.querySelector('[data-sf-destination]').textContent =
                `${kind}: ${clip(String(destination), 300)}`;
            guard.overlay.hidden = false;
        }
    }

    // Browser-level fallback: covers reload, JS redirects, native form submits, tab close.
    window.addEventListener('beforeunload', event => {
        if (!S.navigationGuard || guard.bypass) return;
        checkState('beforeunload');
        guardLog('BEFORE_UNLOAD', { destination: '(browser-controlled)' });
        event.preventDefault();
        event.returnValue = ''; // стандартный диалог (текст задаёт браузер)
    });

    // Only intercept genuine user link clicks with normal navigation defaults.
    // preventDefault does NOT stop click listeners / fetch / XHR triggered by the site.
    window.addEventListener('click', event => {
        if (!S.navigationGuard || guard.bypass || event.defaultPrevented ||
            event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
            isOwnUi(event.target)) return;
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (!anchor || anchor.hasAttribute('download')) return;
        const raw = anchor.getAttribute('href') || '';
        if (!raw || /^(javascript:|mailto:|tel:|data:)/i.test(raw)) return;
        let dest;
        try { dest = new URL(raw, location.href); } catch (e) { return; }
        if (!/^https?:$/.test(dest.protocol)) return;
        const here = new URL(location.href);
        if (dest.origin === here.origin && dest.pathname === here.pathname &&
            dest.search === here.search && dest.hash !== here.hash) return;
        const target = anchor.getAttribute('target') || '_self';
        if (target !== '_self' && target !== '') return;
        event.preventDefault();
        // run after the site's remaining click listeners (so their network requests fire)
        setTimeout(() => {
            if (!S.navigationGuard) { guard.bypass = true; location.assign(dest.href); return; }
            guardShow('Ссылка', dest.href, () => location.assign(dest.href));
        }, 0);
    }, true);

    // Defer script-requested new tabs/windows instead of silently discarding them.
    // Some browsers block the deferred open without a new user gesture; Continue is one.
    window.open = function (...args) {
        if (!S.navigationGuard || guard.bypass) return nativeOpen.apply(window, args);
        const dest = args[0] == null ? 'about:blank' : String(args[0]);
        guardShow('window.open', dest, () => nativeOpen.apply(window, args));
        return null; // synchronous WindowProxy cannot be supplied after a pause
    };

    function guardContinue() {
        const pending = guard.pending;
        if (!pending) return;
        guardHide();
        guardLog('NAVIGATION_CONTINUED', { kind: pending.kind, destination: pending.destination });
        checkState('navigation continued');
        guard.bypass = true;
        try { pending.proceed(); }
        finally { setTimeout(() => { guard.bypass = false; }, 1000); }
    }

    function guardDownload() {
        if (!guard.pending) return;
        downloadFullSession();
    }

    function createGuardOverlay() {
        const div = document.createElement('div');
        div.id = '__sf_nav_guard';
        div.setAttribute('data-sf-own', '1');
        div.hidden = true;
        div.innerHTML = `
          <div class="sf-nav-card">
            <strong>Переход приостановлен</strong>
            <p>События и запросы, выполненные обработчиками клика, уже могли отправиться.
               Перед уходом сохраните текущие логи.</p>
            <p class="sf-nav-dest" data-sf-destination></p>
            <button type="button" data-sf-nav="save">💾 Скачать полный JSON</button>
            <button type="button" data-sf-nav="continue">Продолжить переход</button>
            <button type="button" data-sf-nav="cancel">Отменить переход</button>
          </div>`;
        div.addEventListener('click', event => {
            const action = event.target.closest('[data-sf-nav]')?.dataset.sfNav;
            if (action === 'save') guardDownload();
            if (action === 'continue') guardContinue();
            if (action === 'cancel') { guardLog('NAVIGATION_CANCELLED', {}); guardHide(); }
        });
        document.body.appendChild(div);
        guard.overlay = div;
    }

    // ------------------------------------------------------------------ панель управления

    function scheduleRender() {
        if (renderTimer) return;
        renderTimer = setTimeout(() => { renderTimer = null; render(); }, 100);
    }
    function render() {
        if (!ui.panel) return;
        ui.net.textContent = `${S.networkTotal} / ${S.network.length}`;   // все / без повторов подряд
        ui.evt.textContent = `${S.eventsTotal} / ${S.events.length}`;
        ui.st.textContent = S.state.length;
        ui.dep.textContent = S.crawling ? `${S.depsCount}…` : S.depsCount;
        ui.depBtn.disabled = S.crawling;
    }

    function createPanel() {
        const style = document.createElement('style');
        style.textContent = `
            #${OWN_UI_ID}{position:fixed;bottom:16px;right:16px;z-index:2147483647;width:290px;
                font:13px/1.3 system-ui,sans-serif;background:#1e2128;color:#e8eaf0;border-radius:10px;
                box-shadow:0 6px 24px rgba(0,0,0,.35);padding:10px;box-sizing:border-box}
            #${OWN_UI_ID} *{box-sizing:border-box;font:inherit}
            #${OWN_UI_ID} .sf-title{display:flex;justify-content:space-between;font-weight:600;margin-bottom:8px;cursor:pointer}
            #${OWN_UI_ID} button{width:100%;display:flex;justify-content:space-between;align-items:center;
                margin:0 0 6px;padding:8px 10px;border:0;border-radius:6px;background:#2f6fed;color:#fff;cursor:pointer}
            #${OWN_UI_ID} button:disabled{opacity:.6;cursor:progress}
            #${OWN_UI_ID} button.sf-alt{background:#3a3f4b}
            #${OWN_UI_ID} button.sf-danger{background:#7a2f2f}
            #${OWN_UI_ID} .sf-badge{background:rgba(255,255,255,.22);border-radius:10px;padding:0 8px;min-width:24px;text-align:center}
            #${OWN_UI_ID} label{display:flex;gap:6px;align-items:center;margin:2px 0 4px;cursor:pointer;color:#c9cdd8}
            #${OWN_UI_ID} details{margin:0 0 6px 4px;padding-left:8px;border-left:2px solid #3a3f4b}
            #${OWN_UI_ID} summary{cursor:pointer;color:#c9cdd8;margin-bottom:4px}
            #${OWN_UI_ID} .sf-legend{font-size:11px;color:#98a0b3;margin:-4px 0 8px}
            #${OWN_UI_ID} .sf-body.sf-hidden{display:none}
            #__sf_nav_guard[hidden]{display:none!important}
            #__sf_nav_guard{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;
                background:rgba(0,0,0,.7);font:14px/1.45 system-ui,sans-serif;color:#e8eaf0}
            #__sf_nav_guard .sf-nav-card{background:#1e2128;padding:22px;border-radius:12px;
                width:min(440px,calc(100vw - 32px));box-shadow:0 12px 40px #0008}
            #__sf_nav_guard p{margin:10px 0}
            #__sf_nav_guard .sf-nav-dest{overflow-wrap:anywhere;color:#aeb9cd;font-size:12px}
            #__sf_nav_guard button{padding:10px;border:0;border-radius:6px;margin:4px 5px 4px 0;
                background:#2f6fed;color:white;cursor:pointer}
            #__sf_nav_guard button:last-child{background:#515765}`;
        style.setAttribute('data-sf-own', '1');
        document.head.appendChild(style);

        const noiseHtml = Object.keys(NOISE_GROUPS).map(k =>
            `<label><input type="checkbox" data-n="${k}"> ${NOISE_GROUPS[k].label}</label>`).join('');
        const netNoiseHtml = Object.keys(NET_NOISE).map(k =>
            `<label><input type="checkbox" data-nn="${k}"> ${NET_NOISE[k].label}</label>`).join('');

        const p = document.createElement('div');
        p.id = OWN_UI_ID;
        p.innerHTML = `
            <div class="sf-title"><span>WebScrabberFull v${VERSION}</span><span class="sf-toggle">—</span></div>
            <div class="sf-body">
                <div class="sf-legend">счётчики: все / без повторов подряд</div>
                <button data-a="net" title="всего запросов / записей без повторов подряд">💾 Логи сети <span class="sf-badge" data-c="net">0 / 0</span></button>
                <details data-d="net"><summary>Шум сети (все выкл.)</summary>${netNoiseHtml}</details>
                <button data-a="evt" title="всего событий / записей без повторов подряд">💾 Логи событий <span class="sf-badge" data-c="evt">0 / 0</span></button>
                <details data-d="evt"><summary>Шумные события (все выкл.)</summary>${noiseHtml}</details>
                <button data-a="st" class="sf-alt">💾 Cookies / storage <span class="sf-badge" data-c="st">0</span></button>
                <button data-a="dep">🌐 Скачать зависимости <span class="sf-badge" data-c="dep">0</span></button>
                <details data-d="dep"><summary>Шум зависимостей</summary>
                    <label><input type="checkbox" data-o="includeCss"> включать CSS в зависимости</label>
                    <label><input type="checkbox" data-o="includeLibraries"> включать популярные библиотеки/CDN</label>
                    <label><input type="checkbox" data-o="includeBase64"> включать содержимое base64</label>
                </details>
                <button data-a="all" class="sf-alt">📦 Всё в один JSON</button>
                <label><input type="checkbox" data-o="snapshotInRequests" checked> cookies/storage в каждый запрос</label>
                <label><input type="checkbox" data-o="compact" checked> сжимать логи (шапка с повторами)</label>
                <label><input type="checkbox" data-o="consoleLog" checked> лог в консоль браузера</label>
                <label><input type="checkbox" data-o="navigationGuard" checked> останавливать переходы со страницы</label>
                <button data-a="clear" class="sf-danger">🗑 Очистить</button>
            </div>`;
        document.body.appendChild(p);
        createGuardOverlay();

        ui.panel = p;
        ui.net = p.querySelector('[data-c=net]');
        ui.evt = p.querySelector('[data-c=evt]');
        ui.st = p.querySelector('[data-c=st]');
        ui.dep = p.querySelector('[data-c=dep]');
        ui.depBtn = p.querySelector('[data-a=dep]');

        const actions = {
            net: downloadNetworkLogs, evt: downloadEventLogs, st: downloadStateLogs,
            dep: collectDeps, all: downloadFullSession, clear: clearAll
        };
        p.addEventListener('click', e => {
            const b = e.target.closest('button[data-a]');
            if (b) actions[b.dataset.a]();
        });
        p.addEventListener('change', e => {
            const ds = e.target.dataset || {};
            const sum = (d, obj, title) => {             // заголовок раскрывающегося блока: сколько групп включено
                const on = Object.keys(obj).filter(k => obj[k]).length;
                p.querySelector(`details[data-d=${d}] summary`).textContent = on ? `${title} (вкл.: ${on})` : `${title} (все выкл.)`;
            };
            if (ds.n) {                                  // галочка группы шумных событий
                S.noise[ds.n] = e.target.checked;
                attachEventListeners();                  // дописать слушатели для включённых групп
                sum('evt', S.noise, 'Шумные события');
            } else if (ds.nn) {                          // галочка группы шума сети
                S.noiseNet[ds.nn] = e.target.checked;
                sum('net', S.noiseNet, 'Шум сети');
            } else if (ds.o) {
                S[ds.o] = e.target.checked;
                if (ds.o === 'navigationGuard' && !S.navigationGuard) guardHide();
            }
        });
        p.querySelector('.sf-title').addEventListener('click', () => {
            const body = p.querySelector('.sf-body');
            body.classList.toggle('sf-hidden');
            p.querySelector('.sf-toggle').textContent = body.classList.contains('sf-hidden') ? '+' : '—';
        });
        render();
    }

    if (document.body) createPanel();
    else document.addEventListener('DOMContentLoaded', createPanel, { once: true });

    window.__webScrabberFull = {
        state: S, downloadNetworkLogs, downloadEventLogs, downloadStateLogs,
        collectDeps, downloadFullSession, clearAll, buildExport, compactRecords,
        navigationGuard: { continue: guardContinue, cancel: guardHide, download: guardDownload }
    };
    clog(`${TAG} запущен`);
})();