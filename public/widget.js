/**
 * CS Pintar — embeddable web-chat widget.
 *
 * Drop this on any page:
 *
 *   <script src="https://api.example.com/widget.js"
 *           data-csp-key="YOUR_WIDGET_KEY" defer></script>
 *
 * It talks to the real public API (`/api/public/**`), so every message lands in
 * the operator console inbox. Styles are scoped in a shadow root, so the host
 * page's CSS can never bleed in and the widget cannot bleed out.
 */
(function () {
  'use strict';

  var script =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if ((all[i].src || '').indexOf('widget.js') !== -1) return all[i];
      }
      return null;
    })();

  if (!script) return;
  var widgetKey = script.getAttribute('data-csp-key');
  if (!widgetKey) {
    console.warn('[csp] widget.js requires a data-csp-key attribute.');
    return;
  }

  var API = new URL(script.src, location.href).origin;
  var STORAGE_KEY = 'csp:widget:' + widgetKey;
  var POLL_INTERVAL_MS = 1500;
  var POLL_MAX_ATTEMPTS = 40;

  var state = {
    open: false,
    config: null,
    conversationId: null,
    visitorToken: null,
    messages: [],
    pending: false,
    pollAttempts: 0,
    pollTimer: null,
  };

  /* ----------------------------------------------------------------- api --- */

  function apiFetch(path, options) {
    options = options || {};
    var headers = { Accept: 'application/json' };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (options.token) headers.Authorization = 'Bearer ' + options.token;
    return fetch(API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'omit',
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (payload) {
          if (!response.ok) {
            var detail =
              (payload && (payload.detail || payload.message)) ||
              'Permintaan gagal (' + response.status + ')';
            throw new Error(detail);
          }
          // Every successful API response is `{ success, message, data }`.
          return payload && 'data' in payload ? payload.data : payload;
        });
    });
  }

  /* -------------------------------------------------------------- storage --- */

  function loadStoredSession() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && parsed.visitorToken ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function storeSession(session) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          conversationId: session.conversationId,
          visitorToken: session.visitorToken,
        }),
      );
    } catch (error) {
      /* private mode — the session simply will not survive a reload */
    }
  }

  /* ----------------------------------------------------------------- dom --- */

  var host = document.createElement('div');
  host.setAttribute('data-csp-widget', widgetKey);
  host.style.position = 'fixed';
  host.style.zIndex = '2147483000';
  host.style.bottom = '20px';
  host.style.right = '20px';
  var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var style = document.createElement('style');
  style.textContent = [
    ':host{all:initial;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '*{box-sizing:border-box}',
    '.launcher{display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:12px 18px;',
    'background:#5d5f5f;color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer;',
    'box-shadow:0 8px 24px rgba(31,27,22,.24)}',
    '.launcher:hover{background:#4a4c4c}',
    '.launcher:focus-visible{outline:2px solid #1f1b16;outline-offset:2px}',
    '.launcher__mark{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:rgba(255,255,255,.18);font-size:12px}',
    '.panel{position:absolute;right:0;bottom:64px;width:min(360px,calc(100vw - 32px));height:min(520px,calc(100vh - 120px));',
    'display:flex;flex-direction:column;background:#fff8f3;color:#1f1b16;border:1px solid #e1d9d1;',
    'border-radius:14px;overflow:hidden;box-shadow:0 24px 48px -16px rgba(31,27,22,.35)}',
    '.panel[hidden]{display:none}',
    '.header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;',
    'background:#5d5f5f;color:#fff}',
    '.header__title{font-size:14px;font-weight:600;margin:0}',
    '.header__meta{font-size:11px;opacity:.75;margin:2px 0 0}',
    '.icon-button{border:0;background:rgba(255,255,255,.14);color:#fff;border-radius:6px;width:28px;height:28px;',
    'cursor:pointer;font-size:14px;line-height:1}',
    '.icon-button:hover{background:rgba(255,255,255,.26)}',
    '.log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:#fbf2ea}',
    '.bubble{max-width:82%;padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}',
    '.bubble--customer{align-self:flex-end;background:#5d5f5f;color:#fff;border-bottom-right-radius:4px}',
    '.bubble--assistant{align-self:flex-start;background:#fff;border:1px solid #e1d9d1;border-bottom-left-radius:4px}',
    '.bubble--system{align-self:center;background:transparent;color:#747878;font-size:11.5px;text-align:center;max-width:90%}',
    '.meta{align-self:flex-start;font-size:10.5px;color:#747878;margin-top:-6px}',
    '.typing{align-self:flex-start;display:flex;gap:4px;padding:10px 12px;background:#fff;border:1px solid #e1d9d1;border-radius:12px}',
    '.typing span{width:6px;height:6px;border-radius:50%;background:#c4c7c8;animation:bounce 1.1s infinite}',
    '.typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}',
    '@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
    '.composer{display:flex;gap:8px;padding:12px;border-top:1px solid #e1d9d1;background:#fff}',
    '.composer textarea{flex:1;border:1px solid #c4c7c8;border-radius:8px;padding:9px 11px;font:inherit;font-size:13.5px;',
    'resize:none;height:42px;background:#fff;color:#1f1b16}',
    '.composer textarea:focus{outline:2px solid #5d5f5f;outline-offset:-1px}',
    '.composer button{border:0;border-radius:8px;padding:0 15px;background:#5d5f5f;color:#fff;font:inherit;',
    'font-size:13.5px;font-weight:600;cursor:pointer}',
    '.composer button:disabled{opacity:.45;cursor:not-allowed}',
    '.notice{padding:8px 16px;font-size:11.5px;background:#fef3c7;color:#78350f}',
    '.empty{margin:auto;text-align:center;color:#747878;font-size:12.5px;padding:24px}',
    '@media (max-width:480px){.panel{width:calc(100vw - 24px);height:min(70vh,460px)}.launcher span.label{display:none}}',
  ].join('');

  var launcher = document.createElement('button');
  launcher.className = 'launcher';
  launcher.type = 'button';
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'csp-panel');
  launcher.innerHTML =
    '<span class="launcher__mark" aria-hidden="true">CS</span><span class="label">Chat</span>';

  var panel = document.createElement('section');
  panel.className = 'panel';
  panel.id = 'csp-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Live chat');
  panel.innerHTML = [
    '<header class="header">',
    '  <div><h2 class="header__title">Live chat</h2><p class="header__meta" data-role="status">Connecting…</p></div>',
    '  <button class="icon-button" type="button" data-action="close" aria-label="Close chat">&times;</button>',
    '</header>',
    '<div class="log" data-role="log" role="log" aria-live="polite" aria-relevant="additions"></div>',
    '<form class="composer" data-role="composer">',
    '  <label class="visually-hidden" for="csp-input" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Your message</label>',
    '  <textarea id="csp-input" data-role="input" placeholder="Write a message…" rows="1" required></textarea>',
    '  <button type="submit">Send</button>',
    '</form>',
  ].join('');

  shadow.appendChild(style);
  shadow.appendChild(panel);
  shadow.appendChild(launcher);

  var logEl = panel.querySelector('[data-role="log"]');
  var formEl = panel.querySelector('[data-role="composer"]');
  var inputEl = panel.querySelector('[data-role="input"]');
  var statusEl = panel.querySelector('[data-role="status"]');
  var submitEl = formEl.querySelector('button[type="submit"]');

  /* -------------------------------------------------------------- render --- */

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function systemNote(text) {
    var note = document.createElement('div');
    note.className = 'bubble bubble--system';
    note.textContent = text;
    logEl.appendChild(note);
    scrollToEnd();
  }

  function scrollToEnd() {
    logEl.scrollTop = logEl.scrollHeight;
  }

  function appendMessage(message) {
    var isCustomer = message.role === 'CUSTOMER';
    var bubble = document.createElement('div');
    bubble.className =
      'bubble ' + (isCustomer ? 'bubble--customer' : 'bubble--assistant');
    bubble.textContent = message.content || '…';
    logEl.appendChild(bubble);
    if (!isCustomer && typeof message.confidence === 'number') {
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = 'confidence ' + Math.round(message.confidence * 100) + '%';
      logEl.appendChild(meta);
    }
    scrollToEnd();
  }

  function renderTranscript(messages) {
    logEl.textContent = '';
    if (!messages.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent =
        'Ask a question and the assistant answers from this team’s knowledge base.';
      logEl.appendChild(empty);
      return;
    }
    messages.forEach(appendMessage);
  }

  function showTyping(show) {
    var existing = logEl.querySelector('[data-role="typing"]');
    if (!show) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var typing = document.createElement('div');
    typing.className = 'typing';
    typing.setAttribute('data-role', 'typing');
    typing.setAttribute('aria-label', 'Assistant is typing');
    typing.innerHTML = '<span></span><span></span><span></span>';
    logEl.appendChild(typing);
    scrollToEnd();
  }

  /* ----------------------------------------------------------- sessions --- */

  function ensureSession() {
    if (state.conversationId && state.visitorToken) {
      return Promise.resolve();
    }
    var stored = loadStoredSession();
    if (stored) {
      state.conversationId = stored.conversationId;
      state.visitorToken = stored.visitorToken;
      return apiFetch('/api/public/conversations/' + state.conversationId + '/messages', {
        token: state.visitorToken,
      })
        .then(function (data) {
          renderTranscript(data.messages);
          setStatus('Online · ' + (state.config ? state.config.tenantName : ''));
        })
        .catch(function () {
          // Stored session expired or was revoked — start a fresh one.
          state.conversationId = null;
          state.visitorToken = null;
          return ensureSession();
        });
    }
    return apiFetch('/api/public/widgets/' + encodeURIComponent(widgetKey) + '/sessions', {
      method: 'POST',
      body: { subject: document.title || undefined },
    }).then(function (data) {
      state.conversationId = data.conversation.id;
      state.visitorToken = data.visitorToken;
      storeSession(state);
      renderTranscript([]);
      setStatus('Online · ' + (state.config ? state.config.tenantName : ''));
    });
  }

  function sendMessage(content) {
    if (state.pending || !content.trim()) return;
    state.pending = true;
    submitEl.disabled = true;
    showTyping(true);
    appendMessage({ role: 'CUSTOMER', content: content });

    ensureSession()
      .then(function () {
        return apiFetch(
          '/api/public/conversations/' + state.conversationId + '/messages',
          { method: 'POST', token: state.visitorToken, body: { content: content } },
        );
      })
      .then(function () {
        pollForReply();
      })
      .catch(function (error) {
        showTyping(false);
        systemNote(error.message || 'Could not send your message. Please try again.');
      })
      .then(function () {
        state.pending = false;
        submitEl.disabled = false;
      });
  }

  /** Reply generation is queued server-side, so poll the transcript briefly. */
  function pollForReply() {
    state.pollAttempts = 0;
    clearTimeout(state.pollTimer);
    var baseline = state.messages.length;

    function tick() {
      state.pollAttempts += 1;
      apiFetch('/api/public/conversations/' + state.conversationId + '/messages', {
        token: state.visitorToken,
      })
        .then(function (data) {
          var incoming = data.messages.slice(baseline);
          state.messages = data.messages;
          if (incoming.length) {
            showTyping(false);
            renderTranscript(data.messages);
            state.pending = false;
            submitEl.disabled = false;
            if (data.status === 'HANDOFF' || data.status === 'HUMAN') {
              systemNote('A human agent has joined this conversation.');
              clearTimeout(state.pollTimer);
            }
            return;
          }
          if (state.pollAttempts < POLL_MAX_ATTEMPTS) {
            state.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
          } else {
            showTyping(false);
            systemNote('Still working on it — check back in a moment.');
            state.pending = false;
            submitEl.disabled = false;
          }
        })
        .catch(function () {
          showTyping(false);
          state.pending = false;
          submitEl.disabled = false;
        });
    }

    state.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  /* --------------------------------------------------------------- shell --- */

  function open() {
    state.open = true;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    launcher.querySelector('.label').textContent = 'Close';
    inputEl.focus();
    if (state.config) setStatus('Online · ' + state.config.tenantName);
    ensureSession().catch(function (error) {
      setStatus('Unavailable');
      systemNote(error.message || 'Chat is unavailable right now.');
    });
  }

  function close() {
    state.open = false;
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.querySelector('.label').textContent = 'Chat';
    launcher.focus();
  }

  launcher.addEventListener('click', function () {
    if (state.open) close();
    else open();
  });
  panel.querySelector('[data-action="close"]').addEventListener('click', close);
  formEl.addEventListener('submit', function (event) {
    event.preventDefault();
    var content = inputEl.value;
    inputEl.value = '';
    sendMessage(content);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.open) close();
  });

  /* ---------------------------------------------------------------- boot --- */

  document.body.appendChild(host);
  apiFetch('/api/public/widgets/' + encodeURIComponent(widgetKey))
    .then(function (config) {
      state.config = config;
      setStatus('Online · ' + config.tenantName);
      if (!config.autoReplyEnabled) {
        setStatus('Agents online · ' + config.tenantName);
      }
    })
    .catch(function (error) {
      setStatus('Unavailable');
      systemNote(error.message || 'This chat widget is not configured.');
    });
})();