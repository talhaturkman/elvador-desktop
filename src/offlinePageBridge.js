function getOfflinePageBridgeScript() {
  return `(function () {
  if (window.__elvadorOfflineBridgeInstalled) {
    return;
  }
  window.__elvadorOfflineBridgeInstalled = true;
  window.__elvadorOfflineActive = false;

  var desktop = window.elvadorDesktop;
  if (!desktop || typeof desktop.getCachedApiResponse !== 'function') {
    return;
  }

  var OFFLINE_WRITE_FALLBACK = 'Bu işlem çevrimdışı modda yapılamaz.';
  var OFFLINE_MISS_MESSAGE = 'Bu görünüm için çevrimdışı önbellek bulunamadı.';
  var BANNER_HEIGHT_PX = 34;

  var state = {
    simulatedOffline: false,
    autoOffline: false,
    recovered: false,
    apiBaseUrl: '',
    meta: null,
    outboxSummary: { pendingCount: 0, conflictCount: 0, totalCount: 0, syncing: false },
    modalOpen: false,
    modalItems: [],
    originalHtmlPaddingTop: null,
    recoveryTimerId: null
  };

  function isOfflineActive() {
    return Boolean(state.simulatedOffline || state.autoOffline);
  }

  function syncGlobalOfflineFlag() {
    var prev = Boolean(window.__elvadorOfflineActive);
    var next = isOfflineActive();
    window.__elvadorOfflineActive = next;
    if (prev !== next) {
      try {
        window.dispatchEvent(new CustomEvent('elvador:offline-state-changed', { detail: { offline: next } }));
      } catch (_) {}
    }
  }

  function isMutatingMethod(method) {
    var m = String(method || 'GET').toUpperCase();
    return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
  }

  function resolveUrl(rawUrl) {
    try {
      return new URL(String(rawUrl || ''), window.location.href);
    } catch (_) {
      return null;
    }
  }

  function isTargetApiUrl(rawUrl) {
    var url = resolveUrl(rawUrl);
    if (!url) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!url.pathname || url.pathname.indexOf('/api/') !== 0) return false;
    if (url.origin === window.location.origin) return true;
    if (state.apiBaseUrl && url.origin === state.apiBaseUrl) return true;
    return false;
  }

  function formatTime(iso) {
    if (!iso) return '';
    var ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    try {
      return new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  function parseRequestBody(rawBody) {
    if (rawBody === undefined || rawBody === null || rawBody === '') return {};
    if (typeof rawBody === 'string') {
      try {
        return JSON.parse(rawBody);
      } catch (_) {
        return {};
      }
    }
    if (typeof rawBody === 'object' && typeof FormData !== 'undefined' && !(rawBody instanceof FormData)) {
      return rawBody;
    }
    return {};
  }

  function ensureBannerStyles() {
    if (document.getElementById('elvador-offline-bridge-style')) return;
    var style = document.createElement('style');
    style.id = 'elvador-offline-bridge-style';
    style.textContent = [
      '#elvador-offline-top-banner {',
      '  position: fixed;',
      '  top: 0;',
      '  left: 0;',
      '  right: 0;',
      '  height: 34px;',
      '  z-index: 2147483640;',
      '  display: none;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 12px;',
      '  padding: 0 14px;',
      '  background: #18181b;',
      '  color: #fafafa;',
      '  border-bottom: 1px solid #27272a;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;',
      '  font-size: 12.5px;',
      '  font-weight: 500;',
      '  box-sizing: border-box;',
      '}',
      '#elvador-offline-top-banner.visible { display: flex; }',
      '#elvador-offline-top-banner.recovered { background: #064e3b; border-bottom-color: #065f46; }',
      '#elvador-offline-top-banner .elv-off-left { display: flex; align-items: center; gap: 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }',
      '#elvador-offline-top-banner .elv-off-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; flex-shrink: 0; }',
      '#elvador-offline-top-banner.recovered .elv-off-dot { background: #22c55e; }',
      '#elvador-offline-top-banner.has-conflict .elv-off-dot { background: #f59e0b; }',
      '#elvador-offline-top-banner.syncing .elv-off-dot { background: #3b82f6; }',
      '#elvador-offline-top-banner .elv-off-title { font-weight: 600; letter-spacing: -0.01em; }',
      '#elvador-offline-top-banner .elv-off-meta { color: #a1a1aa; font-weight: 400; font-size: 12px; }',
      '#elvador-offline-top-banner .elv-off-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }',
      '#elvador-offline-top-banner .elv-off-pill-btn {',
      '  background: #27272a;',
      '  color: #fafafa;',
      '  border: 1px solid #3f3f46;',
      '  border-radius: 999px;',
      '  padding: 2px 9px;',
      '  font-size: 11.5px;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '}',
      '#elvador-offline-top-banner .elv-off-pill-btn.conflict { border-color: #f59e0b; color: #fde68a; }',
      '#elvador-offline-top-banner .elv-off-btn {',
      '  background: #ffffff;',
      '  color: #111111;',
      '  border: 0;',
      '  border-radius: 999px;',
      '  padding: 3px 11px;',
      '  font-size: 11.5px;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '}',
      '#elvador-offline-top-banner button:hover { opacity: 0.9; }',
      '#elvador-offline-outbox-modal {',
      '  position: fixed;',
      '  inset: 0;',
      '  z-index: 2147483645;',
      '  background: rgba(0, 0, 0, 0.45);',
      '  display: none;',
      '  align-items: center;',
      '  justify-content: center;',
      '  padding: 20px;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;',
      '}',
      '#elvador-offline-outbox-modal.open { display: flex; }',
      '#elvador-offline-outbox-card {',
      '  width: min(560px, 100%);',
      '  max-height: 82vh;',
      '  background: #ffffff;',
      '  color: #111111;',
      '  border: 1px solid #e5e5e5;',
      '  border-radius: 10px;',
      '  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);',
      '  display: flex;',
      '  flex-direction: column;',
      '  overflow: hidden;',
      '}',
      '#elvador-offline-outbox-card .elv-m-head {',
      '  padding: 12px 16px;',
      '  border-bottom: 1px solid #e5e5e5;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  background: #fafafa;',
      '}',
      '#elvador-offline-outbox-card .elv-m-title { font-size: 14px; font-weight: 700; }',
      '#elvador-offline-outbox-card .elv-m-head-actions { display: flex; gap: 8px; }',
      '#elvador-offline-outbox-card .elv-m-body { padding: 12px 16px; overflow-y: auto; flex: 1; }',
      '#elvador-offline-outbox-card .elv-m-item {',
      '  border: 1px solid #e5e5e5;',
      '  border-radius: 8px;',
      '  padding: 10px 12px;',
      '  margin-bottom: 8px;',
      '  background: #ffffff;',
      '}',
      '#elvador-offline-outbox-card .elv-m-item.conflict { border-color: #f59e0b; background: #fffbeb; }',
      '#elvador-offline-outbox-card .elv-m-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }',
      '#elvador-offline-outbox-card .elv-m-label { font-weight: 600; font-size: 13px; }',
      '#elvador-offline-outbox-card .elv-m-time { font-size: 11.5px; color: #666666; }',
      '#elvador-offline-outbox-card .elv-m-err { margin-top: 6px; font-size: 12px; color: #92400e; }',
      '#elvador-offline-outbox-card .elv-m-item-actions { margin-top: 8px; display: flex; gap: 6px; justify-content: flex-end; }',
      '#elvador-offline-outbox-card button {',
      '  border: 1px solid #d4d4d4;',
      '  background: #ffffff;',
      '  color: #111111;',
      '  border-radius: 6px;',
      '  padding: 4px 10px;',
      '  font-size: 12px;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '}',
      '#elvador-offline-outbox-card button.primary { background: #111111; color: #ffffff; border-color: #111111; }',
      '#elvador-offline-outbox-card button:disabled { opacity: 0.45; cursor: not-allowed; }',
      '#elvador-offline-outbox-card .elv-m-empty { text-align: center; padding: 24px 12px; color: #666666; font-size: 13px; }',
      'html.elvador-desktop-offline-active .admin-visual-alert-ribbon,',
      'html.elvador-desktop-offline-active .floating-orb-assistant,',
      'html.elvador-desktop-offline-active .panel-assistant,',
      'html.elvador-desktop-offline-active .enhanced-pricing-admin .import-file-btn,',
      'html.elvador-desktop-offline-active [data-elvador-offline-hidden="1"] { display: none !important; }'
    ].join('\\n');
    (document.head || document.documentElement).appendChild(style);
  }

  var HIDDEN_NAV_LABELS = {
    'gelen kutusu': 1, 'inbox': 1,
    'sosyal medya': 1, 'social media': 1,
    'hizmetler': 1, 'services': 1,
    'kat': 1, 'housekeeping': 1,
    'teknik': 1, 'technical': 1,
    'kayıplar': 1, 'lost & found': 1,
    'analitik': 1, 'analytics': 1,
    'spa': 1,
    'menü': 1, 'menu': 1,
    'stok': 1, 'stock': 1,
    'mekanlar': 1, 'venues': 1,
    'eğitim': 1, 'training': 1
  };
  var HIDDEN_PRICING_LABELS = {
    'odalar': 1, 'oda bilgileri': 1, 'rooms': 1, 'room info': 1, 'room information': 1,
    'kurallar': 1, 'doğrulama kuralları': 1, 'rules': 1, 'validation rules': 1,
    'diğer bilgiler': 1, 'other information': 1,
    'yönlendirmeler': 1, 'response guidance': 1
  };
  var domFilterTimer = null;

  function normalizeLabel(el) {
    return String((el && el.textContent) || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  }

  function applyOfflineDomFiltering(offlineNow) {
    var root = document.documentElement;
    if (root) {
      if (offlineNow) root.classList.add('elvador-desktop-offline-active');
      else root.classList.remove('elvador-desktop-offline-active');
    }
    if (!document.body) return;
    if (!offlineNow) {
      var hiddenEls = document.querySelectorAll('[data-elvador-offline-hidden="1"]');
      for (var i = 0; i < hiddenEls.length; i++) {
        hiddenEls[i].removeAttribute('data-elvador-offline-hidden');
      }
      return;
    }

    var navItems = document.querySelectorAll('nav .nav-tabs > button, nav .nav-tabs .tab-dropdown, .tab-dropdown__menu button, .mobile-bottom-nav__item');
    for (var j = 0; j < navItems.length; j++) {
      var item = navItems[j];
      var labelNode = item.classList && item.classList.contains('tab-dropdown')
        ? (item.querySelector('.tab-dropdown__trigger, button') || item)
        : item;
      var lbl = normalizeLabel(labelNode);
      if (HIDDEN_NAV_LABELS[lbl]) {
        item.setAttribute('data-elvador-offline-hidden', '1');
      }
    }

    var pricingBtns = document.querySelectorAll('.pricing-tab-btn');
    for (var k = 0; k < pricingBtns.length; k++) {
      var pBtn = pricingBtns[k];
      var pLbl = normalizeLabel(pBtn);
      if (HIDDEN_PRICING_LABELS[pLbl]) {
        pBtn.setAttribute('data-elvador-offline-hidden', '1');
        if (pBtn.classList.contains('active') && pricingBtns[0] && pricingBtns[0] !== pBtn) {
          try { pricingBtns[0].click(); } catch (_) {}
        }
      }
    }
  }

  function installDomFilterObserver() {
    if (state.domObserverInstalled || typeof MutationObserver === 'undefined' || !document.body) return;
    state.domObserverInstalled = true;
    var obs = new MutationObserver(function () {
      if (!isOfflineActive()) return;
      if (domFilterTimer) return;
      domFilterTimer = window.setTimeout(function () {
        domFilterTimer = null;
        applyOfflineDomFiltering(isOfflineActive());
      }, 80);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function applyHtmlTopOffset(showBanner) {
    var root = document.documentElement;
    if (!root) return;
    if (showBanner) {
      if (state.originalHtmlPaddingTop === null) {
        state.originalHtmlPaddingTop = root.style.paddingTop || '';
      }
      root.style.paddingTop = BANNER_HEIGHT_PX + 'px';
    } else if (state.originalHtmlPaddingTop !== null) {
      root.style.paddingTop = state.originalHtmlPaddingTop;
      state.originalHtmlPaddingTop = null;
    }
  }

  async function refreshOutboxModal() {
    if (!state.modalOpen || typeof desktop.getOfflineOutbox !== 'function') return;
    try {
      var res = await desktop.getOfflineOutbox();
      state.modalItems = Array.isArray(res && res.items) ? res.items : [];
      if (res && res.summary) {
        state.outboxSummary = res.summary;
      }
    } catch (_) {
      state.modalItems = [];
    }
    renderOutboxModal();
    renderBanner();
  }

  function openOutboxModal() {
    state.modalOpen = true;
    renderOutboxModal();
    void refreshOutboxModal();
  }

  function closeOutboxModal() {
    state.modalOpen = false;
    var overlay = document.getElementById('elvador-offline-outbox-modal');
    if (overlay) overlay.classList.remove('open');
  }

  function notifyCacheReverted() {
    try {
      window.dispatchEvent(new CustomEvent('elvador:offline-cache-reverted'));
    } catch (_) {}
    if (!window.__elvadorOfflineTabListenerReady) {
      window.setTimeout(function () {
        try {
          window.location.reload();
        } catch (_) {}
      }, 60);
    }
  }

  function renderOutboxModal() {
    if (!document.body) return;
    ensureBannerStyles();
    var overlay = document.getElementById('elvador-offline-outbox-modal');
    if (!state.modalOpen) {
      if (overlay) overlay.classList.remove('open');
      return;
    }

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'elvador-offline-outbox-modal';
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeOutboxModal();
      });
      document.body.appendChild(overlay);
    }

    overlay.textContent = '';
    overlay.classList.add('open');

    var card = document.createElement('div');
    card.id = 'elvador-offline-outbox-card';

    var head = document.createElement('div');
    head.className = 'elv-m-head';
    var title = document.createElement('div');
    title.className = 'elv-m-title';
    title.textContent = 'Bekleyen İşlemler ve Çakışmalar';
    head.appendChild(title);

    var headActions = document.createElement('div');
    headActions.className = 'elv-m-head-actions';
    if (!isOfflineActive() && state.modalItems.length > 0 && typeof desktop.retryOfflineOutbox === 'function') {
      var retryAllBtn = document.createElement('button');
      retryAllBtn.type = 'button';
      retryAllBtn.className = 'primary';
      retryAllBtn.textContent = 'Tümünü Gönder';
      retryAllBtn.addEventListener('click', function () {
        retryAllBtn.disabled = true;
        void desktop.retryOfflineOutbox(null)
          .then(function (res) {
            if (res && res.syncedCount > 0) notifyCacheReverted();
          })
          .finally(function () {
            void refreshOutboxModal();
          });
      });
      headActions.appendChild(retryAllBtn);
    }
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Kapat';
    closeBtn.addEventListener('click', closeOutboxModal);
    headActions.appendChild(closeBtn);
    head.appendChild(headActions);
    card.appendChild(head);

    var body = document.createElement('div');
    body.className = 'elv-m-body';

    if (state.modalItems.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'elv-m-empty';
      empty.textContent = 'Bekleyen veya çakışan işlem yok.';
      body.appendChild(empty);
    } else {
      state.modalItems.forEach(function (item) {
        var rowCard = document.createElement('div');
        rowCard.className = 'elv-m-item' + (item.status === 'conflict' ? ' conflict' : '');

        var row = document.createElement('div');
        row.className = 'elv-m-row';
        var labelSpan = document.createElement('span');
        labelSpan.className = 'elv-m-label';
        labelSpan.textContent = item.label || 'İşlem';
        var timeSpan = document.createElement('span');
        timeSpan.className = 'elv-m-time';
        var statusWord = item.status === 'conflict' ? 'Çakışma' : (item.status === 'syncing' ? 'Gönderiliyor' : 'Bekliyor');
        timeSpan.textContent = statusWord + ' · ' + formatTime(item.createdAt);
        row.appendChild(labelSpan);
        row.appendChild(timeSpan);
        rowCard.appendChild(row);

        if (item.errorMessage) {
          var errDiv = document.createElement('div');
          errDiv.className = 'elv-m-err';
          errDiv.textContent = item.errorMessage;
          rowCard.appendChild(errDiv);
        }

        var itemActions = document.createElement('div');
        itemActions.className = 'elv-m-item-actions';

        if (!isOfflineActive() && typeof desktop.retryOfflineOutbox === 'function') {
          var retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.className = 'primary';
          retryBtn.textContent = 'Tekrar Dene';
          retryBtn.addEventListener('click', function () {
            retryBtn.disabled = true;
            void desktop.retryOfflineOutbox(item.id)
              .then(function (res) {
                if (res && res.syncedCount > 0) notifyCacheReverted();
              })
              .finally(function () {
                void refreshOutboxModal();
              });
          });
          itemActions.appendChild(retryBtn);
        }

        if (typeof desktop.discardOfflineOutboxItem === 'function') {
          var discardBtn = document.createElement('button');
          discardBtn.type = 'button';
          discardBtn.textContent = 'Geri Al';
          discardBtn.addEventListener('click', function () {
            discardBtn.disabled = true;
            void desktop.discardOfflineOutboxItem(item.id)
              .then(function (res) {
                if (res && res.ok) notifyCacheReverted();
              })
              .finally(function () {
                void refreshOutboxModal();
              });
          });
          itemActions.appendChild(discardBtn);
        }

        rowCard.appendChild(itemActions);
        body.appendChild(rowCard);
      });
    }

    card.appendChild(body);
    overlay.appendChild(card);
  }

  function renderBanner() {
    if (!document.body) return;
    ensureBannerStyles();
    installDomFilterObserver();
    var banner = document.getElementById('elvador-offline-top-banner');
    var summary = state.outboxSummary || { pendingCount: 0, conflictCount: 0, totalCount: 0, syncing: false };
    var pendingCount = Number(summary.pendingCount) || 0;
    var conflictCount = Number(summary.conflictCount) || 0;
    var isSyncing = Boolean(summary.syncing);
    var offlineNow = isOfflineActive();
    applyOfflineDomFiltering(offlineNow);

    var shouldShow = offlineNow || state.recovered || pendingCount > 0 || conflictCount > 0 || isSyncing;

    if (!shouldShow) {
      if (banner) banner.classList.remove('visible', 'recovered', 'has-conflict', 'syncing');
      applyHtmlTopOffset(false);
      return;
    }

    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'elvador-offline-top-banner';
      banner.setAttribute('role', 'status');
      document.body.appendChild(banner);
    }

    banner.textContent = '';
    banner.className = 'visible';
    if (!offlineNow && state.recovered && pendingCount === 0 && conflictCount === 0) {
      banner.classList.add('recovered');
    } else if (!offlineNow && conflictCount > 0) {
      banner.classList.add('has-conflict');
    } else if (!offlineNow && (isSyncing || pendingCount > 0)) {
      banner.classList.add('syncing');
    }
    applyHtmlTopOffset(true);

    var left = document.createElement('div');
    left.className = 'elv-off-left';

    var dot = document.createElement('span');
    dot.className = 'elv-off-dot';
    left.appendChild(dot);

    var title = document.createElement('span');
    title.className = 'elv-off-title';
    if (offlineNow) {
      title.textContent = 'Çevrimdışı';
    } else if (conflictCount > 0) {
      title.textContent = conflictCount + ' çakışma';
    } else if (isSyncing || pendingCount > 0) {
      title.textContent = pendingCount + ' işlem gönderiliyor...';
    } else {
      title.textContent = 'Bağlantı geldi';
    }
    left.appendChild(title);

    var savedTime = formatTime(state.meta && state.meta.savedAt);
    if (offlineNow && savedTime) {
      var metaSpan = document.createElement('span');
      metaSpan.className = 'elv-off-meta';
      metaSpan.textContent = '· Son yedek ' + savedTime;
      left.appendChild(metaSpan);
    }

    banner.appendChild(left);

    var actions = document.createElement('div');
    actions.className = 'elv-off-actions';

    if (offlineNow && (pendingCount > 0 || conflictCount > 0)) {
      var queuePill = document.createElement('button');
      queuePill.type = 'button';
      queuePill.className = 'elv-off-pill-btn' + (conflictCount > 0 ? ' conflict' : '');
      queuePill.textContent = conflictCount > 0
        ? (pendingCount + ' bekliyor · ' + conflictCount + ' çakışma')
        : (pendingCount + ' bekliyor');
      queuePill.addEventListener('click', openOutboxModal);
      actions.appendChild(queuePill);
    } else if (!offlineNow && conflictCount > 0) {
      var reviewBtn = document.createElement('button');
      reviewBtn.type = 'button';
      reviewBtn.className = 'elv-off-pill-btn conflict';
      reviewBtn.textContent = 'İncele';
      reviewBtn.addEventListener('click', openOutboxModal);
      actions.appendChild(reviewBtn);
    }

    if (state.simulatedOffline) {
      var exitBtn = document.createElement('button');
      exitBtn.type = 'button';
      exitBtn.className = 'elv-off-btn';
      exitBtn.textContent = 'Canlıya Dön';
      exitBtn.addEventListener('click', function () {
        if (typeof desktop.exitManualOfflineMode === 'function') {
          void desktop.exitManualOfflineMode();
        }
      });
      actions.appendChild(exitBtn);
    } else if (state.recovered && !offlineNow && pendingCount === 0 && conflictCount === 0) {
      var reloadBtn = document.createElement('button');
      reloadBtn.type = 'button';
      reloadBtn.className = 'elv-off-btn';
      reloadBtn.textContent = 'Yenile';
      reloadBtn.addEventListener('click', function () {
        window.location.reload();
      });
      actions.appendChild(reloadBtn);
    } else if (offlineNow) {
      var checkBtn = document.createElement('button');
      checkBtn.type = 'button';
      checkBtn.className = 'elv-off-btn';
      checkBtn.textContent = 'Tekrar Dene';
      checkBtn.addEventListener('click', function () {
        checkBtn.textContent = '...';
        void runRecoveryCheck().finally(function () {
          checkBtn.textContent = 'Tekrar Dene';
        });
      });
      actions.appendChild(checkBtn);
    }

    banner.appendChild(actions);
  }

  function stopRecoveryPolling() {
    if (state.recoveryTimerId) {
      clearInterval(state.recoveryTimerId);
      state.recoveryTimerId = null;
    }
  }

  async function runRecoveryCheck() {
    if (state.simulatedOffline || typeof desktop.checkOnline !== 'function') {
      return;
    }
    try {
      var res = await desktop.checkOnline();
      if (res && res.online) {
        state.autoOffline = false;
        state.recovered = true;
        syncGlobalOfflineFlag();
        stopRecoveryPolling();
        renderBanner();
        if (typeof desktop.retryOfflineOutbox === 'function' && (state.outboxSummary?.pendingCount || 0) > 0) {
          void desktop.retryOfflineOutbox(null);
        }
      }
    } catch (_) {
      // Remain offline until connection is reachable.
    }
  }

  function markAutoOffline() {
    if (state.simulatedOffline) return;
    if (!state.autoOffline) {
      state.autoOffline = true;
      state.recovered = false;
      syncGlobalOfflineFlag();
      renderBanner();
      if (!state.recoveryTimerId) {
        state.recoveryTimerId = setInterval(function () {
          void runRecoveryCheck();
        }, 15000);
      }
    }
  }

  function clearAutoOffline() {
    if (state.autoOffline || state.recovered) {
      state.autoOffline = false;
      state.recovered = false;
      syncGlobalOfflineFlag();
      stopRecoveryPolling();
      renderBanner();
    }
  }

  function buildJsonResponse(status, payload) {
    return new Response(JSON.stringify(payload || {}), {
      status: Number(status) || 200,
      statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
      headers: { 'Content-Type': 'application/json' }
    });
  }

  function buildJsonErrorResponse(status, message) {
    return buildJsonResponse(status, {
      success: false,
      offline: true,
      error: message,
      message: message
    });
  }

  function buildCachedFetchResponse(cached) {
    return new Response(cached.body || '{}', {
      status: Number(cached.status) || 200,
      statusText: 'OK',
      headers: {
        'Content-Type': cached.contentType || 'application/json',
        'X-Elvador-Offline-Cache': 'HIT'
      }
    });
  }

  function cacheResponsePayload(urlStr, status, contentType, bodyText) {
    if (!bodyText || typeof desktop.cacheApiResponse !== 'function') return;
    var ct = String(contentType || '').toLowerCase();
    if (ct.indexOf('application/json') === -1) return;
    void desktop.cacheApiResponse({
      url: urlStr,
      status: status,
      contentType: contentType,
      body: bodyText
    });
  }

  async function handleOfflineWrite(method, fullUrl, rawBody) {
    if (typeof desktop.queueOfflineWrite !== 'function') {
      return { status: 503, body: { success: false, offline: true, error: OFFLINE_WRITE_FALLBACK } };
    }
    var parsedBody = parseRequestBody(rawBody);
    try {
      var res = await desktop.queueOfflineWrite({
        method: method,
        url: fullUrl,
        body: parsedBody
      });
      return {
        status: Number(res && res.status) || 503,
        body: (res && res.body) || { success: false, offline: true, error: OFFLINE_WRITE_FALLBACK }
      };
    } catch (_) {
      return { status: 503, body: { success: false, offline: true, error: OFFLINE_WRITE_FALLBACK } };
    }
  }

  var originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch) {
    window.fetch = async function (input, init) {
      var reqUrl = (typeof Request !== 'undefined' && input instanceof Request) ? input.url : String(input || '');
      if (!isTargetApiUrl(reqUrl)) {
        return originalFetch(input, init);
      }

      var method = String((init && init.method) || (typeof Request !== 'undefined' && input instanceof Request && input.method) || 'GET').toUpperCase();
      var resolved = resolveUrl(reqUrl);
      var fullUrl = resolved ? resolved.toString() : reqUrl;
      var rawBody = init && init.body !== undefined ? init.body : undefined;

      if (isMutatingMethod(method)) {
        if (isOfflineActive()) {
          var offWrite = await handleOfflineWrite(method, fullUrl, rawBody);
          return buildJsonResponse(offWrite.status, offWrite.body);
        }
        try {
          return await originalFetch(input, init);
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          markAutoOffline();
          var fallbackWrite = await handleOfflineWrite(method, fullUrl, rawBody);
          return buildJsonResponse(fallbackWrite.status, fallbackWrite.body);
        }
      }

      if (method === 'GET' && isOfflineActive()) {
        var cachedWhileOffline = await desktop.getCachedApiResponse(fullUrl);
        if (cachedWhileOffline && cachedWhileOffline.hit) {
          return buildCachedFetchResponse(cachedWhileOffline);
        }
        return buildJsonErrorResponse(503, OFFLINE_MISS_MESSAGE);
      }

      try {
        var response = await originalFetch(input, init);
        if (method === 'GET' && response && response.ok) {
          clearAutoOffline();
          var contentType = response.headers ? response.headers.get('content-type') : '';
          if (String(contentType || '').toLowerCase().indexOf('application/json') !== -1) {
            response.clone().text().then(function (text) {
              cacheResponsePayload(fullUrl, response.status, contentType, text);
            }).catch(function () {});
          }
        }
        return response;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw err;
        }
        markAutoOffline();
        if (method === 'GET') {
          var fallbackCached = await desktop.getCachedApiResponse(fullUrl);
          if (fallbackCached && fallbackCached.hit) {
            return buildCachedFetchResponse(fallbackCached);
          }
        }
        return buildJsonErrorResponse(503, OFFLINE_MISS_MESSAGE);
      }
    };
  }

  var OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    var XHR_PASSTHROUGH_EVENTS = ['readystatechange', 'loadstart', 'progress', 'load', 'loadend', 'error', 'timeout', 'abort'];

    function ElvadorXMLHttpRequest() {
      var real = new OrigXHR();
      var self = this;
      var listeners = new Map();
      var method = 'GET';
      var fullUrl = '';
      var isAsync = true;
      var targetApi = false;
      var emulated = false;
      var emulatedProps = null;
      var lastSentBody = null;

      function emitEvent(type, eventObj) {
        var evt = eventObj || new Event(type);
        var propHandler = self['on' + type];
        if (typeof propHandler === 'function') {
          try { propHandler.call(self, evt); } catch (_) {}
        }
        var list = listeners.get(type);
        if (list) {
          list.slice().forEach(function (entry) {
            try {
              if (typeof entry.listener === 'function') {
                entry.listener.call(self, evt);
              } else if (entry.listener && typeof entry.listener.handleEvent === 'function') {
                entry.listener.handleEvent(evt);
              }
            } catch (_) {}
            if (entry.once) {
              self.removeEventListener(type, entry.listener, entry.capture);
            }
          });
        }
      }

      function emulateJsonResponse(status, contentType, bodyText) {
        emulated = true;
        var parsedResponse = bodyText;
        if (real.responseType === 'json') {
          try { parsedResponse = JSON.parse(bodyText); } catch (_) { parsedResponse = null; }
        }
        emulatedProps = {
          readyState: 4,
          status: status,
          statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
          responseText: real.responseType && real.responseType !== 'text' ? '' : bodyText,
          response: parsedResponse,
          responseURL: fullUrl,
          contentType: contentType || 'application/json'
        };
        emitEvent('readystatechange', new Event('readystatechange'));
        emitEvent('load', new ProgressEvent('load'));
        emitEvent('loadend', new ProgressEvent('loadend'));
      }

      XHR_PASSTHROUGH_EVENTS.forEach(function (evtName) {
        real.addEventListener(evtName, function (evt) {
          if (emulated || !targetApi) {
            if (!emulated) emitEvent(evtName, evt);
            return;
          }

          if (evtName === 'error' || evtName === 'timeout') {
            markAutoOffline();
            if (method === 'GET') {
              void desktop.getCachedApiResponse(fullUrl).then(function (cached) {
                if (cached && cached.hit) {
                  emulateJsonResponse(Number(cached.status) || 200, cached.contentType, cached.body || '{}');
                } else {
                  emitEvent(evtName, evt);
                }
              }).catch(function () {
                emitEvent(evtName, evt);
              });
              return;
            }
            void handleOfflineWrite(method, fullUrl, lastSentBody).then(function (offRes) {
              emulateJsonResponse(offRes.status, 'application/json', JSON.stringify(offRes.body || {}));
            });
            return;
          }

          if (evtName === 'readystatechange' && real.readyState === 4 && real.status === 0) {
            return;
          }

          if (evtName === 'loadend' && real.status === 0) {
            return;
          }

          if (evtName === 'load' && real.status >= 200 && real.status < 300) {
            clearAutoOffline();
            if (method === 'GET') {
              try {
                var ct = real.getResponseHeader('content-type') || '';
                var bodyStr = '';
                if (real.responseType === 'json' && real.response !== null && real.response !== undefined) {
                  bodyStr = JSON.stringify(real.response);
                } else if (!real.responseType || real.responseType === 'text') {
                  bodyStr = real.responseText;
                }
                if (bodyStr) {
                  cacheResponsePayload(fullUrl, real.status, ct, bodyStr);
                }
              } catch (_) {}
            }
          }

          emitEvent(evtName, evt);
        });
      });

      this.open = function (reqMethod, reqUrl, asyncFlag) {
        method = String(reqMethod || 'GET').toUpperCase();
        var resolved = resolveUrl(reqUrl);
        fullUrl = resolved ? resolved.toString() : String(reqUrl || '');
        isAsync = asyncFlag !== false;
        targetApi = isAsync && isTargetApiUrl(fullUrl);
        emulated = false;
        emulatedProps = null;
        return real.open.apply(real, arguments);
      };

      this.send = function (body) {
        lastSentBody = body;
        if (!targetApi) {
          return real.send.apply(real, arguments);
        }

        if (isMutatingMethod(method) && isOfflineActive()) {
          void handleOfflineWrite(method, fullUrl, body).then(function (offRes) {
            emulateJsonResponse(offRes.status, 'application/json', JSON.stringify(offRes.body || {}));
          });
          return;
        }

        if (method === 'GET' && isOfflineActive()) {
          void desktop.getCachedApiResponse(fullUrl).then(function (cached) {
            if (cached && cached.hit) {
              emulateJsonResponse(Number(cached.status) || 200, cached.contentType, cached.body || '{}');
            } else {
              emulateJsonResponse(503, 'application/json', JSON.stringify({
                success: false,
                offline: true,
                error: OFFLINE_MISS_MESSAGE,
                message: OFFLINE_MISS_MESSAGE
              }));
            }
          }).catch(function () {
            emulateJsonResponse(503, 'application/json', JSON.stringify({
              success: false,
              offline: true,
              error: OFFLINE_MISS_MESSAGE,
              message: OFFLINE_MISS_MESSAGE
            }));
          });
          return;
        }

        return real.send.apply(real, arguments);
      };

      this.abort = function () { return real.abort(); };
      this.setRequestHeader = function (name, value) { return real.setRequestHeader(name, value); };
      this.overrideMimeType = function (mime) { return real.overrideMimeType(mime); };
      this.getResponseHeader = function (name) {
        if (emulated && emulatedProps) {
          return String(name || '').toLowerCase() === 'content-type' ? emulatedProps.contentType : null;
        }
        return real.getResponseHeader(name);
      };
      this.getAllResponseHeaders = function () {
        if (emulated && emulatedProps) {
          return 'content-type: ' + emulatedProps.contentType + '\\r\\n';
        }
        return real.getAllResponseHeaders();
      };

      this.addEventListener = function (type, listener, options) {
        if (!listener) return;
        var once = Boolean(options && typeof options === 'object' && options.once);
        var capture = Boolean(typeof options === 'boolean' ? options : (options && options.capture));
        var list = listeners.get(type);
        if (!list) {
          list = [];
          listeners.set(type, list);
        }
        if (!list.some(function (e) { return e.listener === listener && e.capture === capture; })) {
          list.push({ listener: listener, once: once, capture: capture });
        }
      };

      this.removeEventListener = function (type, listener, options) {
        var capture = Boolean(typeof options === 'boolean' ? options : (options && options.capture));
        var list = listeners.get(type);
        if (!list) return;
        listeners.set(type, list.filter(function (e) { return !(e.listener === listener && e.capture === capture); }));
      };

      this.dispatchEvent = function (evt) {
        emitEvent(evt.type, evt);
        return true;
      };

      Object.defineProperties(this, {
        readyState: { get: function () { return emulated && emulatedProps ? emulatedProps.readyState : real.readyState; } },
        status: { get: function () { return emulated && emulatedProps ? emulatedProps.status : real.status; } },
        statusText: { get: function () { return emulated && emulatedProps ? emulatedProps.statusText : real.statusText; } },
        responseText: { get: function () { return emulated && emulatedProps ? emulatedProps.responseText : real.responseText; } },
        response: { get: function () { return emulated && emulatedProps ? emulatedProps.response : real.response; } },
        responseURL: { get: function () { return emulated && emulatedProps ? emulatedProps.responseURL : real.responseURL; } },
        responseXML: { get: function () { return emulated ? null : real.responseXML; } },
        upload: { get: function () { return real.upload; } },
        timeout: {
          get: function () { return real.timeout; },
          set: function (v) { real.timeout = v; }
        },
        withCredentials: {
          get: function () { return real.withCredentials; },
          set: function (v) { real.withCredentials = v; }
        },
        responseType: {
          get: function () { return real.responseType; },
          set: function (v) { real.responseType = v; }
        }
      });
    }

    ElvadorXMLHttpRequest.UNSENT = 0;
    ElvadorXMLHttpRequest.OPENED = 1;
    ElvadorXMLHttpRequest.HEADERS_RECEIVED = 2;
    ElvadorXMLHttpRequest.LOADING = 3;
    ElvadorXMLHttpRequest.DONE = 4;
    window.XMLHttpRequest = ElvadorXMLHttpRequest;
  }

  function applyOfflineStateSnapshot(next) {
    if (!next || typeof next !== 'object') return;
    if (next.apiBaseUrl) {
      try { state.apiBaseUrl = new URL(next.apiBaseUrl).origin; } catch (_) {}
    }
    if (next.meta !== undefined) {
      state.meta = next.meta;
    }
    if (next.outboxSummary) {
      state.outboxSummary = next.outboxSummary;
    }
    var wasSim = state.simulatedOffline;
    state.simulatedOffline = Boolean(next.simulatedOffline);
    if (state.simulatedOffline) {
      state.recovered = false;
      stopRecoveryPolling();
    } else if (wasSim && !state.simulatedOffline) {
      state.autoOffline = false;
      state.recovered = false;
      stopRecoveryPolling();
    }
    syncGlobalOfflineFlag();
    try {
      window.dispatchEvent(new CustomEvent('elvador:offline-state-changed', { detail: { offline: isOfflineActive() } }));
    } catch (_) {}
    renderBanner();
    if (state.modalOpen) {
      void refreshOutboxModal();
    }
  }

  if (typeof desktop.onOfflineStateChanged === 'function') {
    desktop.onOfflineStateChanged(function (next) {
      applyOfflineStateSnapshot(next);
    });
  }

  if (typeof desktop.getOfflineState === 'function') {
    void desktop.getOfflineState().then(function (initialState) {
      applyOfflineStateSnapshot(initialState);
    }).catch(function () {});
  }

  window.addEventListener('offline', function () {
    markAutoOffline();
  });

  window.addEventListener('online', function () {
    void runRecoveryCheck();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderBanner);
  } else {
    renderBanner();
  }
})();`;
}

module.exports = {
  getOfflinePageBridgeScript
};
