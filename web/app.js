(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);

  const els = {
    sidebar: $('.sidebar'),
    menuBtn: $('#menuBtn'),
    sidebarClose: $('#sidebarClose'),
    drawerBackdrop: $('#drawerBackdrop'),
    readerBackBtn: $('#readerBackBtn'),
    providerList: $('#providerList'),
    providerHint: $('#providerHint'),
    nameField: $('#nameField'),
    nameInput: $('#nameInput'),
    domainField: $('#domainField'),
    domainSelect: $('#domainSelect'),
    caps: $('#caps'),
    createBtn: $('#createBtn'),
    composeHint: $('#composeHint'),
    composeNote: $('#composeNote'),
    historyList: $('#historyList'),
    clearHistory: $('#clearHistory'),
    address: $('#address'),
    copyBtn: $('#copyBtn'),
    mailboxMeta: $('#mailboxMeta'),
    providerPill: $('#providerPill'),
    autoRefresh: $('#autoRefresh'),
    refreshBtn: $('#refreshBtn'),
    countdown: $('#countdown'),
    deleteMailboxBtn: $('#deleteMailboxBtn'),
    listCount: $('#listCount'),
    lastUpdated: $('#lastUpdated'),
    messageList: $('#messageList'),
    readerEmpty: $('#readerEmpty'),
    reader: $('#reader'),
    readerSubject: $('#readerSubject'),
    readerAvatar: $('#readerAvatar'),
    readerFrom: $('#readerFrom'),
    readerTo: $('#readerTo'),
    readerTime: $('#readerTime'),
    viewTabs: $('#viewTabs'),
    emlBtn: $('#emlBtn'),
    deleteMsgBtn: $('#deleteMsgBtn'),
    readerLoading: $('#readerLoading'),
    mailFrame: $('#mailFrame'),
    mailText: $('#mailText'),
    attachments: $('#attachments'),
    toasts: $('#toasts'),
    modalBackdrop: $('#modalBackdrop'),
    modalTitle: $('#modalTitle'),
    modalMessage: $('#modalMessage'),
    modalCancel: $('#modalCancel'),
    modalConfirm: $('#modalConfirm'),
    captchaBackdrop: $('#captchaBackdrop'),
    captchaImage: $('#captchaImage'),
    captchaInput: $('#captchaInput'),
    captchaError: $('#captchaError'),
    captchaRefresh: $('#captchaRefresh'),
    captchaCancel: $('#captchaCancel'),
    captchaSubmit: $('#captchaSubmit'),
  };

  const state = {
    providers: [],
    providerId: storeGet('provider', 'tempmail_io'),
    mailbox: null,
    history: [],
    messages: [],
    selectedId: null,
    detail: null,
    detailView: 'html',
    domains: {},
    domainLoading: {},
    autoRefresh: true,
    pollTimer: null,
    countdown: 0,
    loading: false,
    listLoaded: false,
    readMap: storeGet('read', {}),
    lastFetchAt: 0,
    captcha: { id: null, pending: null, wasAutoRefresh: false, busy: false },
  };

  // ---------------- 基础工具 ----------------

  const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
  }

  function storeGet(key, fallback) {
    try {
      const raw = localStorage.getItem(`mailhub.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function storeSet(key, value) {
    try {
      localStorage.setItem(`mailhub.${key}`, JSON.stringify(value));
    } catch (error) {
      /* 忽略配额异常 */
    }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const contentType = response.headers.get('content-type') || '';
    let data = null;
    if (contentType.includes('application/json')) {
      data = await response.json().catch(() => null);
    } else {
      data = await response.text().catch(() => '');
    }
    if (!response.ok) {
      const message =
        (data && data.error && data.error.message) ||
        (typeof data === 'object' && data && data.detail) ||
        `请求失败（HTTP ${response.status}）`;
      const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
      error.code = (data && data.error && data.error.code) || 'http_error';
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function providerById(id) {
    return state.providers.find((provider) => provider.id === id) || null;
  }

  function currentProvider() {
    return providerById(state.providerId);
  }

  function mailboxProvider() {
    return state.mailbox ? providerById(state.mailbox.provider) : null;
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function fmtTime(seconds) {
    if (!seconds) return '';
    const date = new Date(seconds * 1000);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function fmtFull(seconds) {
    if (!seconds) return '未知时间';
    const date = new Date(seconds * 1000);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function fmtClock(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function fmtRelative(seconds) {
    if (!seconds) return '';
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
    return fmtTime(seconds);
  }

  function fmtSize(bytes) {
    const size = Number(bytes) || 0;
    if (!size) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  function hueOf(text) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) % 360;
    }
    return hash;
  }

  function initialOf(name) {
    const chars = Array.from(String(name || '?').trim());
    return escapeHtml((chars[0] || '?').toUpperCase());
  }

  // ---------------- 移动端抽屉 ----------------

  function openDrawer() {
    els.sidebar.classList.add('open');
    els.drawerBackdrop.classList.add('show');
  }

  function closeDrawer() {
    els.sidebar.classList.remove('open');
    els.drawerBackdrop.classList.remove('show');
  }

  // ---------------- 渲染：平台 ----------------

  function renderProviders() {
    els.providerHint.textContent = `${state.providers.length} 个可用`;
    els.providerList.innerHTML = state.providers
      .map(
        (provider) => `
        <button class="provider ${provider.id === state.providerId ? 'active' : ''}" type="button"
                data-id="${escapeHtml(provider.id)}" style="--p-accent:${escapeHtml(provider.accent)}">
          <span class="provider-icon">${initialOf(provider.name)}</span>
          <span class="provider-info">
            <span class="provider-name">${escapeHtml(provider.name)}</span>
            <span class="provider-desc">${escapeHtml(provider.tagline)}</span>
          </span>
          <span class="provider-check">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5 5L20 6"/></svg>
          </span>
        </button>`,
      )
      .join('');
  }

  function renderCompose() {
    const provider = currentProvider();
    if (!provider) return;
    els.composeHint.textContent = provider.name;
    els.nameField.classList.toggle('hidden', !provider.custom_name);
    els.domainField.classList.toggle('hidden', !(provider.custom_domain || provider.domain_switch));
    els.composeNote.textContent = provider.note || '';

    const caps = [];
    if (provider.custom_name) caps.push('自定义前缀');
    if (provider.custom_domain || provider.domain_switch) caps.push('指定域名');
    if (provider.eml) caps.push('EML 导出');
    if (provider.attachments) caps.push('附件下载');
    if (provider.delete_mailbox) caps.push('可删除邮箱');
    els.caps.innerHTML = (caps.length ? caps : ['基础收发'])
      .map((cap) => `<span class="cap on">${escapeHtml(cap)}</span>`)
      .join('');

    if (provider.custom_domain || provider.domain_switch) {
      ensureDomains(provider.id);
    }
  }

  function fillDomains(providerId) {
    const list = state.domains[providerId] || [];
    const current = els.domainSelect.value;
    els.domainSelect.innerHTML =
      '<option value="">随机域名</option>' +
      list
        .map(
          (item) =>
            `<option value="${escapeHtml(item.domain)}">${escapeHtml(item.domain)}</option>`,
        )
        .join('');
    if (current && list.some((item) => item.domain === current)) {
      els.domainSelect.value = current;
    }
  }

  async function ensureDomains(providerId) {
    if (state.domains[providerId]) {
      fillDomains(providerId);
      return;
    }
    if (state.domainLoading[providerId]) return;
    state.domainLoading[providerId] = true;
    els.domainSelect.innerHTML = '<option value="">正在加载域名…</option>';
    try {
      const data = await api(`/api/domains/${encodeURIComponent(providerId)}`);
      state.domains[providerId] = (data && data.domains) || [];
    } catch (error) {
      state.domains[providerId] = [];
      if (error.code === 'captcha_required') {
        delete state.domains[providerId];
        showCaptcha(() => ensureDomains(providerId));
      }
    } finally {
      state.domainLoading[providerId] = false;
    }
    if (state.providerId === providerId) fillDomains(providerId);
  }

  // ---------------- 渲染：历史 ----------------

  function renderHistory() {
    if (!state.history.length) {
      els.historyList.innerHTML =
        '<div class="history-empty">还没有邮箱记录。创建后会自动保存到本地 SQLite，刷新页面也能找回。</div>';
      return;
    }
    els.historyList.innerHTML = state.history
      .map(
        (item) => `
        <div class="history-item ${state.mailbox && state.mailbox.handle === item.handle ? 'active' : ''}"
             data-handle="${escapeHtml(item.handle)}" style="--p-accent:${escapeHtml(item.accent || '#6366f1')}">
          <span class="history-dot"></span>
          <span class="history-info">
            <span class="history-addr">${escapeHtml(item.address)}</span>
            <span class="history-meta">${escapeHtml(item.provider_name)} · ${fmtRelative(item.last_used_at)}</span>
          </span>
          <button class="history-x" type="button" title="从历史中移除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
        </div>`,
      )
      .join('');
  }

  async function loadHistory() {
    try {
      const data = await api('/api/mailboxes');
      state.history = (data && data.mailboxes) || [];
    } catch (error) {
      state.history = [];
    }
    renderHistory();
  }

  // ---------------- 渲染：顶栏 / 列表 ----------------

  function renderMailboxHeader() {
    if (!state.mailbox) {
      renderPlaceholder();
      return;
    }
    const provider = mailboxProvider();
    const accent = (provider && provider.accent) || '#6366f1';

    els.address.textContent = state.mailbox.address;
    els.address.classList.remove('dim');
    els.copyBtn.disabled = false;
    els.refreshBtn.disabled = false;
    els.deleteMailboxBtn.disabled = !(provider && provider.delete_mailbox);
    els.deleteMailboxBtn.title =
      provider && provider.delete_mailbox ? '' : '该平台不提供删除邮箱接口';

    els.providerPill.hidden = false;
    els.providerPill.textContent = (provider && provider.name) || state.mailbox.provider;
    els.providerPill.style.setProperty('--p-accent', accent);

    const created = state.mailbox.created_at ? `创建于 ${fmtFull(state.mailbox.created_at)}` : '';
    els.mailboxMeta.textContent = `${state.messages.length} 封邮件${created ? ` · ${created}` : ''}`;
  }

  function renderPlaceholder() {
    const mobile = window.matchMedia('(max-width: 720px)').matches;
    els.address.textContent = '尚未创建邮箱';
    els.address.classList.add('dim');
    els.copyBtn.disabled = true;
    els.refreshBtn.disabled = true;
    els.deleteMailboxBtn.disabled = true;
    els.providerPill.hidden = true;
    els.mailboxMeta.textContent = mobile ? '点击左上角菜单创建邮箱' : '从左侧选择平台并创建邮箱';
    els.listCount.textContent = '0 封邮件';
    els.lastUpdated.textContent = '';
    els.countdown.textContent = '';
    els.messageList.innerHTML = `
      <div class="list-empty">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 8 8 5 8-5"/>
          </svg>
        </div>
        <h4>还没有邮箱</h4>
        <p>${
          mobile
            ? '点击左上角菜单，选择平台并创建邮箱。'
            : '在左侧选择平台并点击「创建新邮箱」，<br>收到的邮件会自动出现在这里。'
        }</p>
      </div>`;
    closeReader(true);
  }

  function renderListMeta() {
    const count = state.messages.length;
    els.listCount.textContent = `${count} 封邮件${state.loading ? ' · 刷新中' : ''}`;
  }

  function renderSkeleton() {
    els.messageList.innerHTML = Array.from({ length: 4 })
      .map(
        () => `
        <div class="skeleton-item">
          <div class="sk avatar-sk"></div>
          <div>
            <div class="sk line"></div>
            <div class="sk line short"></div>
            <div class="sk line" style="width:76%"></div>
          </div>
        </div>`,
      )
      .join('');
  }

  function readKey() {
    if (!state.mailbox) return '';
    return `${state.mailbox.provider}:${state.mailbox.address}`;
  }

  function isUnread(message) {
    if (message.is_read === true) return false;
    if (message.is_read === false) return true;
    const seen = state.readMap[readKey()] || [];
    return !seen.includes(message.id);
  }

  function renderMessages() {
    if (!state.mailbox) {
      renderPlaceholder();
      return;
    }
    if (state.loading && !state.listLoaded) {
      renderSkeleton();
      return;
    }
    if (!state.messages.length) {
      els.messageList.innerHTML = `
        <div class="list-empty">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 8 8 5 8-5"/>
            </svg>
          </div>
          <h4>收件箱为空</h4>
          <p>把上面的邮箱地址填到注册页或收件人，<br>邮件到达后会自动出现。</p>
        </div>`;
      return;
    }

    els.messageList.innerHTML = state.messages
      .map((message, index) => {
        const unread = isUnread(message);
        const hue = hueOf(message.from_name || message.from_email || message.id);
        const extras = [];
        if (message.attachments_count) {
          extras.push(`
            <span class="chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.5 12.5 21a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 1 1 5 5L10 19a2 2 0 0 1-3-3l8.5-8.5"/></svg>
              ${message.attachments_count}
            </span>`);
        }
        if (message.gmail) extras.push('<span class="chip">Gmail</span>');
        return `
          <button class="msg-item ${unread ? 'msg-unread' : ''} ${state.selectedId === message.id ? 'active' : ''}"
                  type="button" data-id="${escapeHtml(message.id)}"
                  style="--av-h:${hue}; animation-delay:${Math.min(index * 18, 160)}ms">
            <span class="avatar" style="--av-h:${hue}">${initialOf(message.from_name || message.from_email)}</span>
            <span class="msg-main">
              <span class="msg-top">
                <span class="msg-from">${escapeHtml(message.from_name || message.from_email || '未知发件人')}</span>
                ${unread ? '<span class="unread-dot"></span>' : ''}
                <span class="msg-time">${escapeHtml(fmtTime(message.received_at))}</span>
              </span>
              <span class="msg-subject">${escapeHtml(message.subject || '(无主题)')}</span>
              ${message.preview ? `<span class="msg-preview">${escapeHtml(message.preview)}</span>` : ''}
              ${extras.length ? `<span class="msg-extras">${extras.join('')}</span>` : ''}
            </span>
          </button>`;
      })
      .join('');
  }

  // ---------------- 轮询 ----------------

  function resetCountdown() {
    if (!state.mailbox || !state.autoRefresh) return;
    const provider = mailboxProvider();
    state.countdown = Math.max(5, Math.round(((provider && provider.poll_interval_ms) || 8000) / 1000));
    renderCountdown();
  }

  function renderCountdown() {
    if (!state.mailbox || !state.autoRefresh) {
      els.countdown.textContent = '';
      return;
    }
    els.countdown.textContent = `${state.countdown}s`;
  }

  function startPolling() {
    stopPolling();
    if (!state.mailbox || !state.autoRefresh) {
      renderCountdown();
      return;
    }
    resetCountdown();
    state.pollTimer = setInterval(() => {
      if (state.loading) return;
      state.countdown -= 1;
      if (state.countdown <= 0) {
        resetCountdown();
        loadMessages({ silent: true });
      }
      renderCountdown();
    }, 1000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  // ---------------- 邮箱操作 ----------------

  async function selectProvider(providerId) {
    if (!providerById(providerId)) return;
    state.providerId = providerId;
    storeSet('provider', providerId);
    renderProviders();
    renderCompose();
    if (providerById(providerId).custom_domain || providerById(providerId).domain_switch) {
      ensureDomains(providerId);
    }
  }

  async function createMailbox() {
    const provider = currentProvider();
    if (!provider) return;
    setCreating(true);
    try {
      const payload = { provider: provider.id };
      if (provider.custom_name) {
        payload.name = els.nameInput.value.trim() || null;
      }
      if (provider.custom_domain || provider.domain_switch) {
        payload.domain = els.domainSelect.value || null;
      }
      const data = await api('/api/mailboxes', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      state.mailbox = {
        handle: data.handle,
        provider: data.provider,
        provider_name: data.provider_name,
        address: data.address,
        created_at: data.created_at,
        capabilities: data.capabilities,
      };
      state.messages = [];
      state.selectedId = null;
      state.detail = null;
      state.listLoaded = false;
      state.lastFetchAt = 0;
      storeSet('handle', data.handle);
      state.autoRefresh = storeGet(`auto.${provider.id}`, provider.auto_refresh);
      els.autoRefresh.checked = state.autoRefresh;

      renderMailboxHeader();
      renderMessages();
      closeReader(true);
      closeDrawer();
      await loadHistory();
      toast('邮箱创建成功', 'success', data.address);
      await loadMessages({ silent: true });
      startPolling();
    } catch (error) {
      if (error.code === 'captcha_required') {
        showCaptcha(() => createMailbox());
        return;
      }
      toast(error.message, 'error');
    } finally {
      setCreating(false);
    }
  }

  function setCreating(loading) {
    els.createBtn.disabled = loading;
    els.createBtn.classList.toggle('loading', loading);
    els.createBtn.querySelector('.spinner').classList.toggle('hidden', !loading);
  }

  async function activateMailbox(item) {
    const provider = providerById(item.provider);
    if (!provider) {
      toast('该平台已不可用', 'error');
      return;
    }
    closeDrawer();
    stopPolling();
    state.mailbox = {
      handle: item.handle,
      provider: item.provider,
      provider_name: item.provider_name,
      address: item.address,
      created_at: item.created_at,
      capabilities: provider,
    };
    state.messages = [];
    state.selectedId = null;
    state.detail = null;
    state.listLoaded = false;
    state.lastFetchAt = 0;
    storeSet('handle', item.handle);
    state.autoRefresh = storeGet(`auto.${provider.id}`, provider.auto_refresh);
    els.autoRefresh.checked = state.autoRefresh;

    els.reader.classList.add('hidden');
    els.readerEmpty.classList.remove('hidden');
    renderMailboxHeader();
    renderHistory();
    renderMessages();
    await loadMessages({ silent: false });
    startPolling();
    if (!state.autoRefresh) renderCountdown();
  }

  function detachMailbox() {
    stopPolling();
    state.mailbox = null;
    state.messages = [];
    state.selectedId = null;
    state.detail = null;
    state.listLoaded = false;
    storeSet('handle', null);
    renderPlaceholder();
  }

  async function loadMessages({ silent = false } = {}) {
    if (!state.mailbox || state.loading) return;
    state.loading = true;
    if (!state.listLoaded) renderSkeleton();
    renderListMeta();
    try {
      const data = await api(`/api/mailboxes/${encodeURIComponent(state.mailbox.handle)}/messages`);
      const previousIds = new Set(state.messages.map((message) => message.id));
      const firstLoad = !state.listLoaded;
      state.messages = (data && data.messages) || [];
      state.listLoaded = true;
      state.lastFetchAt = Date.now();
      if (data && data.mailbox) state.mailbox.address = data.mailbox;

      const fresh = state.messages.filter((message) => !previousIds.has(message.id));
      if (!firstLoad && fresh.length) {
        toast(`收到 ${fresh.length} 封新邮件`, 'success', fresh[0].subject || '');
      }

      if (state.selectedId && !state.messages.some((message) => message.id === state.selectedId)) {
        closeReader();
      }
      renderMessages();
      renderMailboxHeader();
      renderHistory();
      els.lastUpdated.textContent = `更新于 ${fmtClock(new Date())}`;

      if (firstLoad && state.messages.length && !state.selectedId) {
        openMessage(state.messages[0].id);
      }
    } catch (error) {
      if (error.code === 'captcha_required') {
        showCaptcha(() => loadMessages({ silent: false }));
        return;
      }
      if (!silent) toast(error.message, 'error');
      if (error.code === 'rate_limited') {
        if (silent) toast(error.message, 'error');
        state.autoRefresh = false;
        els.autoRefresh.checked = false;
        storeSet(`auto.${state.mailbox.provider}`, false);
        stopPolling();
        renderCountdown();
      } else if (error.code === 'mailbox_not_found' || error.code === 'mailbox_gone') {
        detachMailbox();
        await loadHistory();
      }
    } finally {
      state.loading = false;
      renderListMeta();
      resetCountdown();
    }
  }

  async function deleteMailbox() {
    if (!state.mailbox) return;
    const provider = mailboxProvider();
    if (!provider || !provider.delete_mailbox) {
      toast('该平台不提供删除邮箱接口', 'info', '可直接从左侧历史记录移除本地会话。');
      return;
    }
    const handle = state.mailbox.handle;
    const confirmed = await confirmDialog({
      title: '删除这个邮箱？',
      message: `将从 ${provider.name} 删除 ${state.mailbox.address}，其中的邮件会一并清除，无法恢复。`,
      confirmText: '删除邮箱',
    });
    if (!confirmed) return;

    try {
      await api(`/api/mailboxes/${encodeURIComponent(handle)}`, { method: 'DELETE' });
      toast('邮箱已删除', 'success');
    } catch (error) {
      if (error.code === 'mailbox_gone' || error.code === 'mailbox_not_found') {
        toast('平台侧邮箱已不存在，已从本地移除', 'info');
      } else {
        toast(error.message, 'error');
        return;
      }
    }
    detachMailbox();
    await loadHistory();
  }

  async function removeLocalHandle(handle) {
    try {
      await api(`/api/mailboxes/${encodeURIComponent(handle)}?local_only=1`, { method: 'DELETE' });
    } catch (error) {
      /* 本地记录不存在时忽略 */
    }
    if (state.mailbox && state.mailbox.handle === handle) detachMailbox();
    await loadHistory();
    renderHistory();
    toast('已从历史中移除', 'info');
  }

  async function clearHistory() {
    if (!state.history.length) {
      toast('历史记录已经是空的', 'info');
      return;
    }
    const confirmed = await confirmDialog({
      title: '清空邮箱历史？',
      message: '只会移除本地记录，平台侧邮箱仍会自然过期回收。',
      confirmText: '清空',
    });
    if (!confirmed) return;
    const handles = state.history.map((item) => item.handle);
    await Promise.all(
      handles.map((handle) =>
        api(`/api/mailboxes/${encodeURIComponent(handle)}?local_only=1`, { method: 'DELETE' }).catch(
          () => null,
        ),
      ),
    );
    if (state.mailbox) detachMailbox();
    state.readMap = {};
    storeSet('read', {});
    state.history = [];
    renderHistory();
    toast('历史记录已清空', 'success');
  }

  // ---------------- 阅读 ----------------

  function closeReader(skipRender = false) {
    state.selectedId = null;
    state.detail = null;
    document.body.classList.remove('reader-open');
    els.reader.classList.add('hidden');
    els.readerEmpty.classList.remove('hidden');
    els.mailFrame.srcdoc = '';
    els.mailFrame.classList.add('hidden');
    els.mailText.classList.add('hidden');
    els.attachments.classList.add('hidden');
    els.readerLoading.classList.add('hidden');
    if (!skipRender) renderMessages();
  }

  function markRead(messageId) {
    const message = state.messages.find((item) => item.id === messageId);
    const unknownState = !message || message.is_read === null || message.is_read === undefined;
    if (message) message.is_read = true;
    if (unknownState) {
      const key = readKey();
      const seen = state.readMap[key] || [];
      if (!seen.includes(messageId)) {
        seen.push(messageId);
        state.readMap[key] = seen.slice(-800);
        storeSet('read', state.readMap);
      }
    }
    renderMessages();
  }

  function renderReaderShell(message) {
    els.readerEmpty.classList.add('hidden');
    els.reader.classList.remove('hidden');
    els.readerSubject.textContent = message.subject || '(无主题)';
    els.readerFrom.textContent =
      message.from_name && message.from_email && message.from_name !== message.from_email
        ? `${message.from_name} <${message.from_email}>`
        : message.from || message.from_email || '未知发件人';
    els.readerTo.textContent = `发送至 ${state.mailbox ? state.mailbox.address : ''}`;
    els.readerTime.textContent = fmtFull(message.received_at);
    const hue = hueOf(message.from_name || message.from_email || message.id);
    els.readerAvatar.style.setProperty('--av-h', hue);
    els.readerAvatar.textContent = initialOf(message.from_name || message.from_email);

    els.readerLoading.classList.remove('hidden');
    els.mailFrame.classList.add('hidden');
    els.mailText.classList.add('hidden');
    els.attachments.classList.add('hidden');
    els.emlBtn.hidden = true;
  }

  async function openMessage(messageId) {
    const summary = state.messages.find((message) => message.id === messageId);
    if (!summary || !state.mailbox) return;
    state.selectedId = messageId;
    state.detail = null;
    state.detailView = summary.has_html === false ? 'text' : 'html';
    document.body.classList.add('reader-open');
    renderMessages();
    renderReaderShell(summary);
    markRead(messageId);

    try {
      const query = summary.gmail ? '?gmail=1' : '';
      const data = await api(
        `/api/mailboxes/${encodeURIComponent(state.mailbox.handle)}/messages/${encodeURIComponent(
          messageId,
        )}${query}`,
      );
      if (state.selectedId !== messageId) return;
      state.detail = { ...summary, ...(data && data.message) };
      if (!state.detail.body_html) state.detailView = 'text';
      renderReaderBody();
      loadHistory();
    } catch (error) {
      if (state.selectedId !== messageId) return;
      if (error.code === 'captcha_required') {
        els.readerLoading.innerHTML = '<span class="spinner dark"></span><span>需要完成人机验证</span>';
        showCaptcha(() => openMessage(messageId));
        return;
      }
      els.readerLoading.innerHTML = `<span class="spinner dark"></span><span>${escapeHtml(
        error.message,
      )}</span>`;
      toast(error.message, 'error');
    }
  }

  function renderReaderBody() {
    const detail = state.detail;
    if (!detail) return;
    els.readerLoading.classList.add('hidden');
    updateTabs();
    els.emlBtn.hidden = !detail.raw_available;

    if (state.detailView === 'text' || !detail.body_html) {
      els.mailFrame.classList.add('hidden');
      els.mailText.classList.remove('hidden');
      els.mailText.textContent = detail.body_text || '(这封邮件没有可显示的正文)';
    } else {
      els.mailText.classList.add('hidden');
      els.mailFrame.classList.remove('hidden');
      mountEmail(detail.body_html);
    }

    renderAttachments(detail);
  }

  function updateTabs() {
    const detail = state.detail;
    els.viewTabs.querySelectorAll('button').forEach((button) => {
      const view = button.dataset.view;
      button.classList.toggle('active', view === state.detailView);
      if (view === 'html') {
        button.disabled = !(detail && detail.body_html);
        button.style.opacity = button.disabled ? '0.4' : '1';
      }
      if (view === 'text') {
        button.disabled = !(detail && (detail.body_text || detail.body_html));
        button.style.opacity = button.disabled ? '0.4' : '1';
      }
    });
  }

  function renderAttachments(detail) {
    const list = detail.attachments || [];
    if (!list.length || !detail.can_download_attachments) {
      els.attachments.classList.add('hidden');
      els.attachments.innerHTML = '';
      return;
    }
    els.attachments.classList.remove('hidden');
    els.attachments.innerHTML =
      `<div class="attachments-title">附件 ${list.length}</div>` +
      list
        .map((attachment) => {
          const url = `/api/mailboxes/${encodeURIComponent(
            state.mailbox.handle,
          )}/messages/${encodeURIComponent(detail.id)}/attachments/${encodeURIComponent(
            attachment.id,
          )}`;
          return `
            <a class="attachment" href="${url}" download title="下载 ${escapeHtml(attachment.name)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.5 12.5 21a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 1 1 5 5L10 19a2 2 0 0 1-3-3l8.5-8.5"/></svg>
              <span class="att-name">${escapeHtml(attachment.name)}</span>
              ${attachment.size ? `<span class="att-size">${fmtSize(attachment.size)}</span>` : ''}
            </a>`;
        })
        .join('');
  }

  function mountEmail(html) {
    const frame = els.mailFrame;
    frame.style.height = '320px';
    frame.srcdoc = sanitizeEmailHtml(html);
    frame.onload = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        const resize = () => {
          const height = Math.max(
            doc.documentElement ? doc.documentElement.scrollHeight : 0,
            doc.body ? doc.body.scrollHeight : 0,
          );
          frame.style.height = `${Math.min(Math.max(height + 28, 260), 9000)}px`;
        };
        resize();
        if (window.ResizeObserver && doc.body) {
          new ResizeObserver(resize).observe(doc.body);
        }
      } catch (error) {
        /* 沙箱隔离时无法测量，保持默认高度 */
      }
    };
  }

  function sanitizeEmailHtml(rawHtml) {
    const doc = new DOMParser().parseFromString(rawHtml || '', 'text/html');
    doc
      .querySelectorAll('script,iframe,object,embed,link,meta,base,form,input,button,textarea,select')
      .forEach((node) => node.remove());
    doc.querySelectorAll('*').forEach((element) => {
      Array.from(element.attributes).forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const value = (attribute.value || '').trim();
        if (name.startsWith('on') || name === 'formaction' || name === 'srcdoc') {
          element.removeAttribute(attribute.name);
          return;
        }
        if (
          (name === 'href' || name === 'src' || name === 'xlink:href') &&
          /^\s*(javascript|vbscript|data:text\/html)/i.test(value)
        ) {
          element.removeAttribute(attribute.name);
          return;
        }
        if (name === 'style' && /expression\s*\(|javascript:/i.test(value)) {
          element.removeAttribute(attribute.name);
        }
      });
    });

    const style = `
      html, body { margin: 0; padding: 0; background: #ffffff; }
      body {
        padding: 24px 26px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
        font-size: 14px;
        line-height: 1.7;
        color: #1f2937;
        word-break: break-word;
        overflow-wrap: anywhere;
      }
      img { max-width: 100%; height: auto; }
      a { color: #2563eb; }
      table { max-width: 100%; }
      pre { white-space: pre-wrap; }
    `;
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${style}</style></head><body>${
      doc.body ? doc.body.innerHTML : ''
    }</body></html>`;
  }

  async function deleteCurrentMessage() {
    if (!state.mailbox || !state.selectedId) return;
    const messageId = state.selectedId;
    const confirmed = await confirmDialog({
      title: '删除这封邮件？',
      message: '邮件会从平台侧删除，无法恢复。',
      confirmText: '删除',
    });
    if (!confirmed) return;
    await performDeleteMessage(messageId);
  }

  async function performDeleteMessage(messageId) {
    if (!state.mailbox) return;
    try {
      await api(
        `/api/mailboxes/${encodeURIComponent(state.mailbox.handle)}/messages/${encodeURIComponent(
          messageId,
        )}`,
        { method: 'DELETE' },
      );
      state.messages = state.messages.filter((message) => message.id !== messageId);
      closeReader();
      toast('邮件已删除', 'success');
      loadMessages({ silent: true });
      loadHistory();
    } catch (error) {
      if (error.code === 'captcha_required') {
        showCaptcha(() => performDeleteMessage(messageId));
        return;
      }
      toast(error.message, 'error');
    }
  }

  function openEml() {
    if (!state.mailbox || !state.selectedId) return;
    const url = `/api/mailboxes/${encodeURIComponent(state.mailbox.handle)}/messages/${encodeURIComponent(
      state.selectedId,
    )}/eml`;
    window.open(url, '_blank', 'noopener');
  }

  // ---------------- Toast / Modal ----------------

  const TOAST_ICONS = {
    success:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5 5L20 6"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg>',
    info:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 11v6M12 7h.01"/></svg>',
  };

  function toast(title, type = 'info', detail = '') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.innerHTML = `
      <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
      <span class="toast-content">
        <div class="toast-title"></div>
        ${detail ? '<div class="toast-detail"></div>' : ''}
      </span>
      <span class="toast-progress"></span>`;
    node.querySelector('.toast-title').textContent = title;
    if (detail) node.querySelector('.toast-detail').textContent = detail;
    els.toasts.appendChild(node);

    const remove = () => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 240);
    };
    setTimeout(remove, 3800);

    while (els.toasts.children.length > 4) {
      els.toasts.firstElementChild.remove();
    }
  }

  let modalResolve = null;

  function confirmDialog({ title, message, confirmText = '确认' }) {
    els.modalTitle.textContent = title;
    els.modalMessage.textContent = message;
    els.modalConfirm.textContent = confirmText;
    els.modalBackdrop.classList.remove('hidden');
    return new Promise((resolve) => {
      modalResolve = resolve;
    });
  }

  function closeModal(result) {
    els.modalBackdrop.classList.add('hidden');
    const resolve = modalResolve;
    modalResolve = null;
    if (resolve) resolve(result);
  }

  // ---------------- 人机验证 ----------------

  function setCaptchaError(message) {
    els.captchaError.textContent = message || '';
    els.captchaError.classList.toggle('hidden', !message);
  }

  async function showCaptcha(pendingAction) {
    if (pendingAction) state.captcha.pending = pendingAction;
    if (!els.captchaBackdrop.classList.contains('hidden')) return;

    state.captcha.wasAutoRefresh = state.autoRefresh;
    state.autoRefresh = false;
    els.autoRefresh.checked = false;
    if (state.mailbox) storeSet(`auto.${state.mailbox.provider}`, false);
    stopPolling();
    renderCountdown();

    els.captchaBackdrop.classList.remove('hidden');
    els.captchaInput.value = '';
    setCaptchaError('');
    await loadCaptchaImage();
  }

  async function loadCaptchaImage() {
    els.captchaImage.removeAttribute('src');
    els.captchaImage.style.opacity = '0.35';
    setCaptchaError('');
    try {
      const data = await api(`/api/captcha?t=${Date.now()}`);
      state.captcha.id = data.id;
      els.captchaImage.src = data.image;
      els.captchaImage.style.opacity = '1';
      els.captchaInput.focus();
    } catch (error) {
      setCaptchaError(error.message);
    }
  }

  function closeCaptcha() {
    els.captchaBackdrop.classList.add('hidden');
    state.captcha.id = null;
    state.captcha.pending = null;
    state.captcha.busy = false;
    els.captchaSubmit.disabled = false;
    els.captchaSubmit.textContent = '验证并继续';
  }

  async function submitCaptcha() {
    if (state.captcha.busy) return;
    const answer = els.captchaInput.value.trim();
    if (!/^\d{4}$/.test(answer)) {
      setCaptchaError('请输入图中 4 位数字');
      els.captchaInput.focus();
      return;
    }
    if (!state.captcha.id) {
      await loadCaptchaImage();
      return;
    }

    state.captcha.busy = true;
    els.captchaSubmit.disabled = true;
    els.captchaSubmit.textContent = '验证中…';
    try {
      await api('/api/captcha/verify', {
        method: 'POST',
        body: JSON.stringify({ id: state.captcha.id, answer }),
      });
      const wasAutoRefresh = state.captcha.wasAutoRefresh;
      const action = state.captcha.pending;
      closeCaptcha();
      toast('验证通过', 'success');
      if (wasAutoRefresh && state.mailbox) {
        state.autoRefresh = true;
        els.autoRefresh.checked = true;
        storeSet(`auto.${state.mailbox.provider}`, true);
        startPolling();
      }
      if (action) {
        setTimeout(action, 120);
      } else if (state.mailbox) {
        loadMessages({ silent: false });
      }
    } catch (error) {
      state.captcha.busy = false;
      els.captchaSubmit.disabled = false;
      els.captchaSubmit.textContent = '验证并继续';
      setCaptchaError(error.message);
      if (error.code === 'captcha_invalid' || error.code === 'captcha_expired') {
        els.captchaInput.value = '';
        await loadCaptchaImage();
      }
    }
  }

  // ---------------- 事件 ----------------

  function bindEvents() {
    els.menuBtn.addEventListener('click', openDrawer);
    els.sidebarClose.addEventListener('click', closeDrawer);
    els.drawerBackdrop.addEventListener('click', closeDrawer);
    els.readerBackBtn.addEventListener('click', () => closeReader());

    window.addEventListener('resize', () => {
      if (window.innerWidth > 720) closeDrawer();
    });

    els.providerList.addEventListener('click', (event) => {
      const card = event.target.closest('.provider');
      if (card) selectProvider(card.dataset.id);
    });

    els.createBtn.addEventListener('click', createMailbox);

    els.refreshBtn.addEventListener('click', () => {
      loadMessages({ silent: false });
    });

    els.copyBtn.addEventListener('click', async () => {
      if (!state.mailbox) return;
      try {
        await navigator.clipboard.writeText(state.mailbox.address);
        toast('邮箱地址已复制', 'success', state.mailbox.address);
      } catch (error) {
        const textarea = document.createElement('textarea');
        textarea.value = state.mailbox.address;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        toast('邮箱地址已复制', 'success', state.mailbox.address);
      }
    });

    els.autoRefresh.addEventListener('change', () => {
      state.autoRefresh = els.autoRefresh.checked;
      if (state.mailbox) storeSet(`auto.${state.mailbox.provider}`, state.autoRefresh);
      if (state.autoRefresh) {
        startPolling();
        loadMessages({ silent: true });
      } else {
        stopPolling();
        renderCountdown();
      }
    });

    els.deleteMailboxBtn.addEventListener('click', deleteMailbox);

    els.clearHistory.addEventListener('click', clearHistory);

    els.messageList.addEventListener('click', (event) => {
      const item = event.target.closest('.msg-item');
      if (item && item.dataset.id) openMessage(item.dataset.id);
    });

    els.historyList.addEventListener('click', (event) => {
      const removeButton = event.target.closest('.history-x');
      if (removeButton) {
        event.stopPropagation();
        const item = removeButton.closest('.history-item');
        if (item) removeLocalHandle(item.dataset.handle);
        return;
      }
      const item = event.target.closest('.history-item');
      if (!item) return;
      const target = state.history.find((entry) => entry.handle === item.dataset.handle);
      if (target && (!state.mailbox || state.mailbox.handle !== target.handle)) {
        activateMailbox(target);
      }
    });

    els.viewTabs.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-view]');
      if (!button || button.disabled) return;
      state.detailView = button.dataset.view;
      renderReaderBody();
    });

    els.emlBtn.addEventListener('click', openEml);
    els.deleteMsgBtn.addEventListener('click', deleteCurrentMessage);

    els.modalConfirm.addEventListener('click', () => closeModal(true));
    els.modalCancel.addEventListener('click', () => closeModal(false));
    els.modalBackdrop.addEventListener('click', (event) => {
      if (event.target === els.modalBackdrop) closeModal(false);
    });

    els.captchaRefresh.addEventListener('click', loadCaptchaImage);
    els.captchaImage.addEventListener('click', loadCaptchaImage);
    els.captchaSubmit.addEventListener('click', submitCaptcha);
    els.captchaInput.addEventListener('input', () => {
      els.captchaInput.value = els.captchaInput.value.replace(/\D/g, '').slice(0, 4);
    });
    els.captchaInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitCaptcha();
      }
    });
    els.captchaCancel.addEventListener('click', () => {
      closeCaptcha();
      toast('已取消验证，自动刷新保持关闭', 'info');
    });
    els.captchaBackdrop.addEventListener('click', (event) => {
      if (event.target === els.captchaBackdrop) closeCaptcha();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!els.captchaBackdrop.classList.contains('hidden')) {
          closeCaptcha();
        } else if (!els.modalBackdrop.classList.contains('hidden')) {
          closeModal(false);
        } else if (els.sidebar.classList.contains('open')) {
          closeDrawer();
        } else if (state.selectedId) {
          closeReader();
        }
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.mailbox) {
        if (state.autoRefresh && Date.now() - state.lastFetchAt > 20000) {
          loadMessages({ silent: true });
        }
      }
    });
  }

  // ---------------- 启动 ----------------

  async function init() {
    bindEvents();
    try {
      const data = await api('/api/providers');
      state.providers = (data && data.providers) || [];
    } catch (error) {
      toast('无法连接后端服务', 'error', error.message);
      return;
    }
    if (!providerById(state.providerId)) {
      state.providerId = state.providers[0] ? state.providers[0].id : '';
    }
    renderProviders();
    renderCompose();
    ensureDomains(state.providerId).catch(() => null);

    await loadHistory();

    const savedHandle = storeGet('handle', null);
    const saved = savedHandle && state.history.find((item) => item.handle === savedHandle);
    if (saved) {
      await activateMailbox(saved);
    } else {
      renderPlaceholder();
    }
  }

  init();
})();
