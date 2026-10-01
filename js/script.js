(function () {
  'use strict';

  /* ---------------- Cached DOM refs ---------------- */
  var root = document.documentElement;
  var langToggle = document.getElementById('lang-toggle');
  var header = document.querySelector('.site-header');
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-links a'));
  var sections = navLinks
    .map(function (a) {
      var id = a.getAttribute('href').replace('#', '');
      return document.getElementById(id);
    })
    .filter(Boolean);
  var track = document.querySelector('.process-track');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('#process .process-tab'));
  var prevBtn = document.querySelector('.process-arrow--prev');
  var nextBtn = document.querySelector('.process-arrow--next');
  var panels = Array.prototype.slice.call(document.querySelectorAll('.process-panel'));
  var panelCount = panels.length;

  /* ---------------- Language toggle ---------------- */
  var STORAGE_KEY = 'we-lang';

  var metaTitles = {
    zh: 'W.E. — 生物統計顧問｜與您並肩合作',
    en: 'W.E. — Clinical Biostatistics Consulting, Partnered With You'
  };
  var metaDescriptions = {
    zh: 'W.E. 由資深生物統計師親自主導，提供臨床試驗統計設計、SAP、SDTM/ADaM、統計程式與品質審查等顧問服務。',
    en: 'W.E. offers clinical biostatistics consulting for biotech and pharma sponsors — study design, SAP, SDTM/ADaM, statistical programming, and quality review, led personally by a senior biostatistician.'
  };

  function getSavedLang() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function saveLang(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      /* private browsing / storage blocked — ignore */
    }
  }

  function applyLang(lang) {
    var isEn = lang === 'en';
    root.setAttribute('lang', isEn ? 'en' : 'zh-Hant');
    root.setAttribute('data-lang', lang);

    document.querySelectorAll('[data-zh]').forEach(function (el) {
      el.textContent = isEn ? el.getAttribute('data-en') : el.getAttribute('data-zh');
    });
    document.querySelectorAll('[data-zh-html]').forEach(function (el) {
      el.innerHTML = isEn ? el.getAttribute('data-en-html') : el.getAttribute('data-zh-html');
    });

    document.title = metaTitles[lang] || metaTitles.zh;
    var metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute('content', metaDescriptions[lang] || metaDescriptions.zh);

    if (langToggle) langToggle.textContent = isEn ? '中文' : 'EN';
    document.body.setAttribute('data-current-lang', lang);

    renderNewsChannel();

    // Text length changes can reflow section heights; resync scrollspy and header shadow.
    window.requestAnimationFrame(function () {
      updateActiveSection();
      onScrollHeader();
    });
  }

  /* ---------------- Sticky header shadow ---------------- */
  function onScrollHeader() {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 8);
  }

  /* ---------------- Scrollspy ---------------- */
  var navHeightPx = header ? header.offsetHeight : 68;
  var spyTicking = false;

  var navLinksEl = document.querySelector('.nav-links');

  function scrollNavLinkIntoView(link) {
    if (!navLinksEl) return;
    var containerRect = navLinksEl.getBoundingClientRect();
    var linkRect = link.getBoundingClientRect();
    if (linkRect.left < containerRect.left) {
      navLinksEl.scrollLeft -= (containerRect.left - linkRect.left) + 16;
    } else if (linkRect.right > containerRect.right) {
      navLinksEl.scrollLeft += (linkRect.right - containerRect.right) + 16;
    }
  }

  function updateActiveSection() {
    spyTicking = false;
    if (!sections.length) return;
    var activeId = sections[0].id;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top - navHeightPx <= 1) {
        activeId = sections[i].id;
      }
    }
    navLinks.forEach(function (a) {
      var isActive = a.getAttribute('href') === '#' + activeId;
      var wasActive = a.classList.contains('is-active');
      a.classList.toggle('is-active', isActive);
      if (isActive && !wasActive) {
        scrollNavLinkIntoView(a);
      }
    });
  }

  window.addEventListener('scroll', function () {
    onScrollHeader();
    if (!spyTicking) {
      spyTicking = true;
      window.requestAnimationFrame(updateActiveSection);
    }
  }, { passive: true });

  /* ---------------- Process carousel ---------------- */
  // One swipe moves at most one panel. The panel follows the finger once the
  // gesture is clearly horizontal; mostly-vertical gestures are left to page scroll.
  var current = 0;
  var SWIPE_AXIS_PX = 10;      // movement before deciding horizontal vs vertical
  var SWIPE_THRESHOLD_PX = 60; // drag distance needed to change panel

  function syncProcessHeight() {
    if (track && panels[current]) track.style.height = panels[current].offsetHeight + 'px';
  }

  function goTo(index) {
    if (!track) return;
    current = Math.max(0, Math.min(panelCount - 1, index));
    track.style.transform = 'translateX(-' + current * 100 + '%)';
    tabs.forEach(function (tab, i) {
      tab.classList.toggle('is-active', i === current);
      tab.setAttribute('aria-selected', i === current ? 'true' : 'false');
    });
    syncProcessHeight();
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { goTo(i); });
  });
  if (prevBtn) prevBtn.addEventListener('click', function () { goTo(current - 1); });
  if (nextBtn) nextBtn.addEventListener('click', function () { goTo(current + 1); });

  if (track) {
    var drag = null;

    track.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, axis: null };
    });

    track.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      if (!drag.axis) {
        if (Math.abs(dx) < SWIPE_AXIS_PX && Math.abs(dy) < SWIPE_AXIS_PX) return;
        drag.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
        if (drag.axis === 'x') {
          track.classList.add('is-dragging');
          track.setPointerCapture(e.pointerId);
        }
      }
      if (drag.axis !== 'x') return;
      var atEdge = (current === 0 && dx > 0) || (current === panelCount - 1 && dx < 0);
      drag.dx = atEdge ? dx / 3 : dx;
      track.style.transform = 'translateX(calc(-' + current * 100 + '% + ' + drag.dx + 'px))';
    });

    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var wasHorizontal = drag.axis === 'x';
      var dx = drag.dx;
      drag = null;
      if (!wasHorizontal) return;
      track.classList.remove('is-dragging');
      var step = 0;
      if (e.type === 'pointerup' && Math.abs(dx) >= SWIPE_THRESHOLD_PX) step = dx < 0 ? 1 : -1;
      goTo(current + step);
    }
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);

    // Panel heights change with viewport width, language and web-font loading.
    if ('ResizeObserver' in window) {
      var panelObserver = new ResizeObserver(syncProcessHeight);
      panels.forEach(function (panel) { panelObserver.observe(panel); });
    } else {
      window.addEventListener('resize', syncProcessHeight);
    }
  }

  /* ---------------- Share / News ---------------- */
  var newsContainer = document.getElementById('news-cards');
  var newsTabs = Array.prototype.slice.call(document.querySelectorAll('.news-channel-tab'));
  var newsData = null;
  var activeNewsChannel = 'fda';

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderNewsChannel() {
    if (!newsContainer || !newsData) return;
    var isEn = root.getAttribute('data-lang') === 'en';
    var items = newsData[activeNewsChannel] || [];
    if (!items.length) {
      newsContainer.innerHTML = '<p class="news-empty">' + (isEn ? 'No updates yet.' : '尚無更新內容。') + '</p>';
      return;
    }
    newsContainer.innerHTML = items.map(function (item) {
      var tag = isEn ? item.tag_en : item.tag_zh;
      var summary = isEn ? item.summary_en : item.summary_zh;
      var linkLabel = isEn ? 'Read original →' : '查看原文 →';
      return '' +
        '<article class="news-card">' +
          '<span class="news-card-tag">' + escapeHtml(tag) + '</span>' +
          '<h3 class="news-card-title">' + escapeHtml(item.title) + '</h3>' +
          '<p class="news-card-meta">' + escapeHtml(item.source) + ' · ' + escapeHtml(item.date) + '</p>' +
          '<p class="news-card-summary">' + escapeHtml(summary) + '</p>' +
          '<a class="news-card-link" href="' + escapeHtml(item.link) + '" target="_blank" rel="noopener">' + linkLabel + '</a>' +
        '</article>';
    }).join('');
  }

  newsTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      activeNewsChannel = tab.getAttribute('data-channel');
      newsTabs.forEach(function (t) {
        var isActive = t === tab;
        t.classList.toggle('is-active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      renderNewsChannel();
    });
  });

  function loadNewsData() {
    fetch('data/news.json')
      .then(function (res) { if (!res.ok) throw new Error('fetch failed'); return res.json(); })
      .then(function (data) { newsData = data; renderNewsChannel(); })
      .catch(function () {
        // file:// preview (or offline) can't fetch local JSON — fall back to the embedded copy.
        var fallbackEl = document.getElementById('news-data-fallback');
        if (fallbackEl) {
          try {
            newsData = JSON.parse(fallbackEl.textContent);
            renderNewsChannel();
          } catch (e) { /* malformed fallback — leave loading state */ }
        }
      });
  }

  /* ---------------- Init ---------------- */
  if (langToggle) {
    langToggle.addEventListener('click', function () {
      var current = root.getAttribute('data-lang') === 'en' ? 'en' : 'zh';
      var next = current === 'en' ? 'zh' : 'en';
      applyLang(next);
      saveLang(next);
    });
  }

  applyLang(getSavedLang() || 'zh');
  onScrollHeader();
  updateActiveSection();
  goTo(0);
  loadNewsData();
})();
