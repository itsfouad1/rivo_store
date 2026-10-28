window.RivoChatNotifications = (() => {
  let enabled = false,
    inFlight = false,
    timer,
    baseTitle = document.title;
  function paint(count) {
    document.querySelectorAll('a[href="/chat.html"],a[href="#chat"]').forEach((a) => {
      let badge = a.querySelector('[data-chat-unread]');
      if (!badge) {
        badge = document.createElement('span');
        badge.dataset.chatUnread = '';
        badge.className = 'rivo-unread';
        a.append(badge);
      }
      badge.hidden = !count;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.setAttribute('aria-label', count + ' رسالة غير مقروءة');
    });
    document.title = count ? '(' + count + ') ' + baseTitle : baseTitle;
  }
  async function refresh() {
    if (!enabled || inFlight || document.hidden) return;
    inFlight = true;
    try {
      const r = await fetch('/api/chat/summary', { cache: 'no-store' });
      if (!r.ok) {
        paint(0);
        return;
      }
      const d = await r.json();
      paint(d.unread_messages);
    } catch {
    } finally {
      inFlight = false;
    }
  }
  async function tick() {
    await refresh();
    timer = setTimeout(tick, 30000);
  }
  return {
    start(user) {
      if (enabled || !['owner', 'admin', 'support'].includes(user?.role)) return;
      enabled = true;
      baseTitle = document.title;
      tick();
      window.addEventListener('pagehide', () => clearTimeout(timer));
    },
    refresh,
  };
})();
