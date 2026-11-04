/**
 * 站点脚本（原生 JS，不依赖任何框架）。
 *
 * 干四件事：
 *   1. **状态与倒计时按访问时刻算** —— 站点可能是昨天构建的，但状态永远是「现在」的状态。
 *   2. **首页分组跟着状态走** —— 构建时是「即将开始」的活动，访问时可能已经开始了。
 *      ⚠️ 分组重排是**签名驱动**的：卡片的状态/日期串没变就一行 DOM 都不动。
 *      它跟倒计时共用一个 60 秒的 timer，但那只是为了有个兜底节奏，
 *      真正决定要不要动 DOM 的是签名。
 *   3. **行前清单存在本机浏览器** —— 按活动分开存，不跨设备同步（也不假装同步）。
 *   4. **深浅色切换** —— 默认跟随系统，可以手动改。
 *
 * ⚠️ 页面不可见时整个 tick 直接 return——常驻标签页开着不该一直耗电。
 */
(function () {
  'use strict';

  var STATUS_LABEL = {
    upcoming: '即将开始',
    ongoing: '进行中',
    ended: '已结束',
    unknown: '日期待定',
  };

  var GROUP_OF = {
    upcoming: 'group-active',
    ongoing: 'group-active',
    unknown: 'group-unknown',
    ended: 'group-ended',
  };

  var CHECK_PREFIX = 'eventprep:checklist:';
  // 读者自己写的笔记：跟行前清单一样是**本机个人数据**——
  // 不上传、不同步、不会被清理（换设备就是换一份，没有「同步」这回事）。
  var NOTE_PREFIX = 'eventprep:notes:';
  var THEME_KEY = 'eventprep:theme';
  // 读到哪儿了：也是**本机个人数据**（跟行前清单、笔记同一类）。
  // 记的是「哪个章节 + 章节内偏移」，不是纯像素——内容一改，像素就指错地方了。
  var SCROLL_PREFIX = 'eventprep:scroll:';

  /* ---------- 小工具 ---------- */

  function readJson(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || '{}');
    } catch (err) {
      return null;
    }
  }

  /* ---------- 状态与倒计时（与服务端同一套口径） ---------- */

  function statusOf(ev, now) {
    if (!ev || !ev.startISO) return 'unknown';
    var start = Date.parse(ev.startISO);
    if (isNaN(start)) return 'unknown';
    if (now < start) return 'upcoming';
    if (ev.endISO) {
      var end = Date.parse(ev.endISO);
      if (!isNaN(end) && now >= end) return 'ended';
    }
    return 'ongoing';
  }

  /** 活动所在时区的「今天」。 */
  function localDateIn(ev, now) {
    var tz = ev.timezone || 'UTC';
    var parts;
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now);
    } catch (err) {
      return ev.start || '';
    }
    var map = {};
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i].type !== 'literal') map[parts[i].type] = parts[i].value;
    }
    return map.year + '-' + map.month + '-' + map.day;
  }

  /** 两个日期相差几天（end - start）。与服务端同名函数口径一致。 */
  function calendarDaysBetween(a, b) {
    var pa = a.split('-');
    var pb = b.split('-');
    var ta = Date.UTC(+pa[0], +pa[1] - 1, +pa[2]);
    var tb = Date.UTC(+pb[0], +pb[1] - 1, +pb[2]);
    return Math.round((tb - ta) / 86400000);
  }

  function countdown(ev, now) {
    var st = statusOf(ev, now);
    if (st === 'unknown') return '日期待定';
    if (st === 'ended') return '已结束';

    var start = Date.parse(ev.startISO);
    if (st === 'upcoming') {
      var diff = start - now;
      var days = Math.floor(diff / 86400000);
      var hours = Math.floor((diff % 86400000) / 3600000);
      var minutes = Math.floor((diff % 3600000) / 60000);
      // 整日/整时不补「0 小时」「0 分钟」（与服务端 countdownText 同一口径）
      if (days > 0) return hours > 0 ? '还有 ' + days + ' 天 ' + hours + ' 小时' : '还有 ' + days + ' 天';
      if (hours > 0) return minutes > 0 ? '还有 ' + hours + ' 小时 ' + minutes + ' 分钟' : '还有 ' + hours + ' 小时';
      if (minutes > 0) return '还有 ' + minutes + ' 分钟';
      return '马上开始';
    }

    // 进行中
    var total = ev.days || 1;
    var today = localDateIn(ev, now);
    var idx = calendarDaysBetween(ev.start, today) + 1;
    if (idx < 1) idx = 1;
    if (idx > total) idx = total;
    if (total > 1) return '进行中 · 第 ' + idx + ' / ' + total + ' 天';
    var end = ev.endISO ? Date.parse(ev.endISO) : start;
    var left = Math.max(0, end - now);
    var h = Math.floor(left / 3600000);
    var m = Math.floor((left % 3600000) / 60000);
    if (h > 0) return m > 0 ? '进行中 · 还剩 ' + h + ' 小时 ' + m + ' 分钟' : '进行中 · 还剩 ' + h + ' 小时';
    return '进行中 · 还剩 ' + m + ' 分钟';
  }

  /* ---------- 主题 ---------- */

  function initTheme() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next;
      if (!cur) {
        var prefersDark =
          window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        next = prefersDark ? 'light' : 'dark';
      } else {
        next = cur === 'dark' ? 'light' : 'dark';
      }
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (err) {
        /* 无痕模式等场景写不进去，忽略 */
      }
      btn.setAttribute('aria-label', next === 'dark' ? '切换到浅色' : '切换到深色');
    });
  }

  /* ---------- 行前清单（本机存储，按活动分开） ---------- */

  function checklistKey(slug) {
    return CHECK_PREFIX + slug;
  }

  function loadChecks(slug) {
    try {
      var raw = localStorage.getItem(checklistKey(slug));
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function saveChecks(slug, list) {
    try {
      localStorage.setItem(checklistKey(slug), JSON.stringify(list));
    } catch (err) {
      /* 忽略 */
    }
  }

  function initChecklist() {
    var container = document.querySelector('[data-event-slug]');
    if (!container) return;
    var slug = container.getAttribute('data-event-slug');
    var boxes = container.querySelectorAll('input[type="checkbox"][data-check-id]');
    if (!boxes.length) return;

    var saved = loadChecks(slug);
    var set = {};
    for (var i = 0; i < saved.length; i += 1) set[saved[i]] = true;

    function updateProgress() {
      var total = boxes.length;
      var checkedCount = 0;
      for (var b = 0; b < total; b += 1) {
        if (boxes[b].checked) checkedCount += 1;
      }
      var countEl = container.querySelector('[data-checklist-count]');
      var fillEl = container.querySelector('[data-checklist-fill]');
      if (countEl) countEl.textContent = '已完成 ' + checkedCount + ' / ' + total + ' 项';
      if (fillEl) fillEl.style.width = Math.round((checkedCount / total) * 100) + '%';
    }

    if (typeof document.createElement === 'function' && boxes[0] && boxes[0].closest) {
      var listEl = boxes[0].closest('ul');
      if (listEl && listEl.parentNode && !container.querySelector('[data-checklist-progress]')) {
        var prog = document.createElement('div');
        prog.className = 'checklist-progress';
        prog.setAttribute('data-checklist-progress', '');
        prog.innerHTML =
          '<div class="progress-info">' +
          '<span class="progress-title">行前准备进度</span>' +
          '<span class="progress-count" data-checklist-count>已完成 0 / ' + boxes.length + ' 项</span>' +
          '</div>' +
          '<div class="progress-track">' +
          '<div class="progress-fill" data-checklist-fill style="width: 0%"></div>' +
          '</div>';
        listEl.parentNode.insertBefore(prog, listEl);
      }
    }

    var current = {};
    Array.prototype.forEach.call(boxes, function (box) {
      var id = box.getAttribute('data-check-id');
      current[id] = !!box.checked;
      if (set[id]) box.checked = true;
      box.addEventListener('change', function () {
        current[id] = box.checked;
        var list = Object.keys(current).filter(function (k) {
          return current[k];
        });
        saveChecks(slug, list);
        updateProgress();
      });
    });

    updateProgress();
  }

  /* ---------- 状态刷新 + 首页分组 ---------- */

  function initSite() {
    var data = readJson('site-data');
    if (!data || !Array.isArray(data.events) || !data.events.length) return;

    var bySlug = {};
    for (var i = 0; i < data.events.length; i += 1) bySlug[data.events[i].slug] = data.events[i];

    var containers = document.querySelectorAll('[data-event-slug]');
    var cards = [];
    Array.prototype.forEach.call(document.querySelectorAll('.event-card[data-event-slug]'), function (el) {
      cards.push(el);
    });

    /* ---- 快：徽章 + 倒计时文案 ---- */

    function applyCountdown(now) {
      Array.prototype.forEach.call(containers, function (el) {
        var ev = bySlug[el.getAttribute('data-event-slug')];
        if (!ev) return;
        var st = statusOf(ev, now);
        var badge = el.querySelector('[data-status-badge]');
        if (badge) {
          badge.textContent = STATUS_LABEL[st];
          badge.className = 'badge badge-' + st;
        }
        var cd = el.querySelector('[data-countdown]');
        if (cd) {
          // 只有「即将开始 / 进行中」才值得显示倒计时；
          // 「已结束」「日期待定」徽章已经说清楚了，再写一遍是重复
          cd.textContent = st === 'upcoming' || st === 'ongoing' ? countdown(ev, now) : '';
        }
      });
    }

    /* ---- 慢：首页分组重排 ---- */

    /**
     * 把卡片搬到对应分组。
     *
     * ⚠️ **只在签名变化时才动 DOM**。以前这一步和倒计时共用一个 1 秒定时器，
     *    于是「搬卡片 + 数卡片 + 显示/隐藏分组」每秒白跑一遍——而这些 DOM 操作
     *    只在活动真正跨状态的那一刻才需要（开始、结束、跨时区日界，通常几小时一次）。
     *    常驻标签页开着的话，老写法等于一直空转。
     */
    var lastSignatures = {};

    function regroup(force) {
      var groups = {};
      var names = ['group-active', 'group-unknown', 'group-ended'];
      for (var g = 0; g < names.length; g += 1) {
        var section = document.getElementById(names[g]);
        if (section) groups[names[g]] = section;
      }
      if (!groups['group-active']) return;

      var changed = false;
      var now = Date.now();
      for (var c = 0; c < cards.length; c += 1) {
        var slug = cards[c].getAttribute('data-event-slug');
        var ev = bySlug[slug];
        if (!ev) continue;
        // 一次 statusOf 既做签名又定分组——两张牌用同一个值，
        // 免得在「状态刚好翻页」的那一刻两处算出不一样的结果。
        var st = statusOf(ev, now);
        var sig = st + '|' + (ev.startISO || '') + '|' + (ev.endISO || '') + '|' + (ev.days || 1);
        if (!force && lastSignatures[slug] === sig) continue;
        lastSignatures[slug] = sig;
        changed = true;
        var target = groups[GROUP_OF[st]];
        if (!target) continue;
        var list = target.querySelector('[data-cards]');
        if (list && cards[c].parentNode !== list) list.appendChild(cards[c]);
      }
      if (!changed && !force) return;

      for (var n = 0; n < names.length; n += 1) {
        var sec = groups[names[n]];
        if (!sec) continue;
        var items = sec.querySelectorAll('[data-cards] > li');
        var count = sec.querySelector('[data-group-count]');
        if (count) count.textContent = String(items.length);
        // 空分组藏起来——页面上不留「已结束 0」这种空壳
        if (items.length === 0) sec.setAttribute('hidden', '');
        else sec.removeAttribute('hidden');
      }
    }

    applyCountdown(new Date());
    if (cards.length) regroup(true);

    /* ---- 一个节奏 ---- */

    // 文案是分钟级显示，60 秒足够（老写法每秒跑，改的只是文案里那几个字）。
    // 分组重排搭同一班车：它自己有签名判断，没变就立刻返回，不会白动 DOM。
    var TICK_MS = 60 * 1000;

    /**
     * 页面不可见时什么都不做。
     * 常驻标签页是最常见的耗电场景——老写法在后台照样每秒跑。
     */
    function tick() {
      if (document.hidden) return;
      applyCountdown(new Date());
      regroup(false);
    }

    if (document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        // 从后台切回来：立刻补齐，别让用户看见一个过期几分钟的倒计时
        if (!document.hidden) {
          applyCountdown(new Date());
          regroup(false);
        }
      });
    }

    setInterval(tick, TICK_MS);
  }

  /**
   * 目录侧栏：标出「现在读到哪一节」。
   *
   * 侧栏目录的日常习惯——不标当前节，读者滚动到一半不知道自己读到哪了，
   * 目录就只是一列字。
   *
   * ⚠️ 判据用**标题顶端的位置**，不用滚动百分比：页面下半部分的章节本来就短，
   *    按百分比会永远标不到。
   * ⚠️ 高亮落在收起的子列表里时把它展开——不然标了也看不见。
   */
  function initTocSpy() {
    var toc = document.querySelector('.toc');
    if (!toc) return;
    var links = toc.querySelectorAll('a[href^="#"]');
    if (!links.length) return;

    var items = [];
    for (var i = 0; i < links.length; i += 1) {
      var href = links[i].getAttribute('href') || '';
      if (href.length < 2) continue;
      var target = null;
      try {
        target = document.getElementById(decodeURIComponent(href.slice(1)));
      } catch (e) {
        target = null;
      }
      if (target) items.push({ link: links[i], el: target });
    }
    if (!items.length) return;

    var list = toc.querySelector('.toc-list');
    var current = null;

    function reveal(link) {
      // 子项在收起的折叠块里 → 展开它，标了也要看得见
      var sub = link.parentNode ? link.parentNode.closest('.toc-sub') : null;
      if (sub) sub.open = true;
      // 目录自己能滚时，把当前项滚进视野（只动目录的滚动条，不动页面）
      var scroller = link.closest
        ? link.closest('.toc-drawer-body') || list
        : list;
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
      var lr = link.getBoundingClientRect();
      var tr = scroller.getBoundingClientRect();
      if (lr.top < tr.top) scroller.scrollTop -= tr.top - lr.top;
      else if (lr.bottom > tr.bottom) scroller.scrollTop += lr.bottom - tr.bottom;
    }

    function mark(entry) {
      if (current === entry) return;
      if (current) current.link.removeAttribute('aria-current');
      current = entry;
      if (!current) return;
      current.link.setAttribute('aria-current', 'location');
      reveal(current.link);
    }

    function update() {
      var header = document.querySelector('.site-header');
      var offset = (header ? header.getBoundingClientRect().height : 58) + 24;
      var found = items[0];
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].el.getBoundingClientRect().top <= offset) found = items[i];
        else break;
      }
      mark(found);
    }

    var pending = false;
    function schedule() {
      if (pending) return;
      pending = true;
      (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
        pending = false;
        update();
      });
    }

    if (window.addEventListener) {
      window.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule);
    }
    update();
  }

  /* ---------- 目录抽屉（顶栏按钮点开） ---------- */

  function initTocDrawer() {
    var open = document.getElementById('toc-open');
    var drawer = document.getElementById('toc-drawer');
    if (!open || !drawer) return;
    // 老浏览器没有 <dialog>：宁可不打开，也不要点一下没反应
    if (!drawer.showModal) return;

    open.addEventListener('click', function () {
      if (!drawer.open) drawer.showModal();
    });

    var close = drawer.querySelector('.toc-drawer-close');
    if (close) {
      close.addEventListener('click', function () {
        drawer.close();
      });
    }
    // 点背景（对话框本体）关掉：点在抽屉里的内容上不关
    drawer.addEventListener('click', function (e) {
      if (e.target === drawer) drawer.close();
    });
    // 点目录里的条目 → 跳过去，顺手把抽屉收起来
    drawer.addEventListener('click', function (e) {
      var link = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (link) drawer.close();
    });
  }

  /* ---------- 读者自己的笔记（本机存储，不会清理） ---------- */

  function notesKey(slug) {
    return NOTE_PREFIX + slug;
  }

  function loadNotes(slug) {
    try {
      var raw = localStorage.getItem(notesKey(slug));
      var parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function saveNotes(slug, map) {
    try {
      localStorage.setItem(notesKey(slug), JSON.stringify(map));
    } catch (err) {
      /* 无痕模式等场景写不进去，忽略 */
    }
  }

  function initNotes() {
    var container = document.querySelector('[data-event-slug]');
    if (!container) return;
    var slug = container.getAttribute('data-event-slug');
    var buttons = container.querySelectorAll('.agenda-note-btn');
    if (!buttons.length) return;

    var notes = loadNotes(slug);
    var dirty = false;

    Array.prototype.forEach.call(buttons, function (btn) {
      var key = btn.getAttribute('data-note-key');
      if (!key) return;
      var block = btn.closest ? btn.closest('.agenda-note') : null;
      var input = block ? block.querySelector('.agenda-note-input') : null;
      if (!block || !input) return;

      var text = notes[key] || '';
      if (text) {
        input.value = text;
        block.classList.add('has-note');
      }

      btn.addEventListener('click', function () {
        var isOpen = block.classList.toggle('is-open');
        btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen && input.focus) {
          try {
            input.focus();
          } catch (err) {
            /* 忽略 */
          }
        }
      });

      var save = function () {
        var value = input.value;
        if (value.trim()) {
          notes[key] = value;
          block.classList.add('has-note');
        } else {
          delete notes[key];
          block.classList.remove('has-note');
        }
        saveNotes(slug, notes);
        dirty = false;
      };

      // 输入时存一次（防抖），失焦再存一次。
      // ⚠️ 这些是**读者自己的数据**：存在本机浏览器里，不同步、不会被清理。
      var timer = null;
      input.addEventListener('input', function () {
        dirty = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(save, 250);
      });
      input.addEventListener('blur', function () {
        if (timer) clearTimeout(timer);
        save();
      });
    });

    // 切走或关页面前把还没落盘的存掉——正在输入的内容不该丢
    var flush = function () {
      if (!dirty) return;
      Array.prototype.forEach.call(container.querySelectorAll('.agenda-note-input'), function (input) {
        var block = input.closest ? input.closest('.agenda-note') : null;
        var btn = block ? block.querySelector('.agenda-note-btn') : null;
        var key = btn ? btn.getAttribute('data-note-key') : null;
        if (!key) return;
        if (input.value.trim()) notes[key] = input.value;
        else delete notes[key];
      });
      saveNotes(slug, notes);
      dirty = false;
    };
    if (window.addEventListener) {
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flush();
      });
    }
  }

  /* ---------- 活动页头部信息（窄屏收成一行） ---------- */

  function initEventMeta() {
    var wrap = document.querySelector('[data-event-meta]');
    if (!wrap) return;
    var wide = window.matchMedia('(min-width: 720px)');
    var apply = function () {
      // 宽屏直接摊开（摘要本来就隐藏了）；窄屏收成一行，点一下才展开
      wrap.open = wide.matches;
    };
    apply();
    if (wide.addEventListener) {
      wide.addEventListener('change', apply);
    } else if (wide.addListener) {
      wide.addListener(apply);
    }
  }

  /* ---------- 回到顶部浮动按钮 ---------- */

  function initBackToTop() {
    if (typeof document === 'undefined' || !document.createElement || !document.body) return;
    if (document.getElementById('back-to-top')) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'back-to-top';
    btn.className = 'back-to-top';
    btn.setAttribute('aria-label', '回到顶部');
    btn.setAttribute('title', '回到顶部');
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="18 15 12 9 6 15"></polyline>' +
      '</svg>' +
      '<span class="back-to-top-label">顶部</span>';

    btn.addEventListener('click', function () {
      // ⚠️ 尊重「减少动态效果」：显式写 behavior:'smooth' 会盖掉 CSS 里的设置，
      //    前庭功能敏感的人点了会难受。
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (typeof window.scrollTo === 'function') {
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      } else {
        document.body.scrollTop = 0;
        document.documentElement.scrollTop = 0;
      }
      // 焦点跟着回顶部：否则键盘用户还停在页面底部那个按钮上，
      // 再按 Tab 只会继续往下走。
      var top = document.getElementById('main');
      if (top) {
        if (!top.hasAttribute('tabindex')) top.setAttribute('tabindex', '-1');
        top.focus({ preventScroll: true });
      }
    });

    document.body.appendChild(btn);

    var toggling = false;
    function checkScroll() {
      if (toggling) return;
      toggling = true;
      (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
        var scrolled = (window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0) > 300;
        if (scrolled) {
          btn.className = 'back-to-top visible';
        } else {
          btn.className = 'back-to-top';
        }
        toggling = false;
      });
    }

    if (window.addEventListener) {
      window.addEventListener('scroll', checkScroll, { passive: true });
    }
  }

  /**
   * 头像点开放大。
   *
   * 用原生 <dialog>：Esc 能关、点背景能关、焦点自己管，
   * 不用自己写一套焦点陷阱与滚动锁定。
   */
  function initAvatarViewer() {
    var dialog = document.getElementById('avatar-viewer');
    var img = document.getElementById('avatar-viewer-img');
    if (!dialog || !img || typeof dialog.showModal !== 'function') return;

    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.agenda-avatar-btn') : null;
      if (!btn) return;
      var src = btn.getAttribute('data-avatar');
      if (!src) return;
      img.setAttribute('src', src);
      img.setAttribute('alt', btn.getAttribute('data-avatar-alt') || '');
      if (typeof dialog.showModal === 'function') dialog.showModal();
    });

    // 点对话框外的遮罩 = 关闭
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) dialog.close();
    });
  }

  /* ---------- 记住读到哪儿了（本机存储，按活动分开） ---------- */

  /**
   * 记住「上次读到哪儿」，下次打开直接回到那节。
   *
   * 为什么记「章节 + 节内偏移」而不是纯像素：
   *   纯像素只在页面一个字没变时才对。内容一改（加一场、改摘要），
   *   同一个像素就指到别的内容上了——读者以为回到原处，其实已经错位。
   *   记章节就稳得多：内容改了，那一节还在，回到的还是那一节。
   *
   * ⚠️ 这是**本机个人数据**：不上传、不同步、不会被清理。
   *    换设备就是换一份，没有「同步」这回事——页面上别暗示有同步。
   */
  function scrollKey(slug) {
    return SCROLL_PREFIX + slug;
  }

  /**
   * 当前读者正在读的那一节。
   *
   * ⚠️ 判据是「**第一个还在视口下沿之下**的标题」——不是最后一个过了上沿的。
   *    读者停在一节的中部时，那一节的标题恰好落在视口**上方** 80px 处
   *    （实测 headTop=80），而上一节的标题早就翻上去了：
   *    - 用「最后一个过了上沿的」→ 退到上一节，记下的位置就错了；
   *    - 用「第一个还在下面的」→ 正是读者眼前这一节，对的。
   */
  function currentSection() {
    var heads = document.querySelectorAll('.content h2[id], .content h3[id]');
    for (var i = 0; i < heads.length; i += 1) {
      if (heads[i].getBoundingClientRect().top > 0) return heads[i];
    }
    // 全都过了上沿 = 已经读到最后一节了
    return heads.length ? heads[heads.length - 1] : null;
  }

  function loadScroll(slug) {
    try {
      var raw = localStorage.getItem(scrollKey(slug));
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function saveScroll(slug, data) {
    try {
      localStorage.setItem(scrollKey(slug), JSON.stringify(data));
    } catch (err) {
      /* 无痕模式等场景写不进去，忽略 */
    }
  }

  function initScrollMemory() {
    // ⚠️ 只认活动页的容器（`.event[data-event-slug]`）：
    //    首页的活动**卡片**也带 data-event-slug，用宽泛选择器会拿到第一张卡片，
    //    把首页的滚动位置记到某个活动名下——下次打开那个活动莫名其妙停在中间。
    var container = document.querySelector('.event[data-event-slug]');
    if (!container) return;
    var slug = container.getAttribute('data-event-slug');
    if (!slug) return;

    // ⚠️ 锚点跳转（点目录里的某一项）优先于「记住的位置」：
    //    读者明确说了要去哪一节，就别把他拽回上次读的地方。
    var hasHash = !!(window.location && window.location.hash);
    var saved = hasHash ? null : loadScroll(slug);

    var pending = null;
    var remember = function () {
      if (pending) return;
      pending = setTimeout(function () {
        pending = null;
        var y = window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0;
        if (y < 40) {
          // 回到顶部了 = 这次读完了，清掉记录
          try {
            localStorage.removeItem(scrollKey(slug));
          } catch (err) {
            /* 忽略 */
          }
          return;
        }
        var head = currentSection();
        var data = { y: Math.round(y) };
        if (head) {
          data.id = head.id;
          data.offset = Math.round(head.getBoundingClientRect().top);
        }
        saveScroll(slug, data);
      }, 400);
    };

    // 滚动时记（防抖）；切走或关页面前也记一次——
    // ⚠️ `pagehide` 比 `beforeunload` 可靠（后者在移动端经常不触发）。
    if (window.addEventListener) {
      window.addEventListener('scroll', remember, { passive: true });
      window.addEventListener('pagehide', function () {
        if (pending) {
          clearTimeout(pending);
          pending = null;
        }
        remember();
      });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') remember();
      });
    }

    // 恢复位置
    if (!saved) return;
    var restore = function () {
      var target = saved.y;
      if (saved.id) {
        var head = document.getElementById(saved.id);
        // 那一节还在，就回到它在原来的位置
        if (head) target = Math.round(head.getBoundingClientRect().top + window.pageYOffset - (saved.offset || 0));
      }
      if (typeof target !== 'number' || isNaN(target) || target < 0) return;
      // 别滚过头：页面可能比上次短了
      var max = Math.max(0, (document.documentElement.scrollHeight || 0) - (window.innerHeight || 0));
      target = Math.min(target, max);
      if (target < 40) return;
      // ⚠️ 必须是**瞬时**跳转，不能让它滑过去：
      //    正文有 `scroll-behavior: smooth`，滑过去的话读者会看着页面
      //    从顶部一路滚到上次的位置——那不是「回到原处」，是「重播一遍」。
      try {
        window.scrollTo({ top: target, behavior: 'instant' });
      } catch (err) {
        // 老浏览器不认 'instant'：临时把平滑关掉再滚
        var root = document.documentElement;
        var prev = root.style.scrollBehavior;
        root.style.scrollBehavior = 'auto';
        window.scrollTo(0, target);
        root.style.scrollBehavior = prev;
      }
    };

    // ⚠️ 等内容排完再恢复：图片没加载完时页面高度不对，
    //    这时候恢复会停在偏上的地方。
    if (document.readyState === 'complete') {
      restore();
    } else {
      window.addEventListener('load', restore);
    }
  }

  function boot() {
    initTheme();
    initChecklist();
    initSite();
    initTocDrawer();
    initTocSpy();
    initNotes();
    initEventMeta();
    initBackToTop();
    initAvatarViewer();
    initScrollMemory();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 供测试用（只暴露测试真正用到的那两个）
  window.__eventPrep = { statusOf: statusOf, countdown: countdown };
})();
