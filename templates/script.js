(function() {
  var RAW = JSON.parse(document.getElementById('data').textContent);
  var items = RAW.items;
  var errors = RAW.errors || [];
  var targets = RAW.targets || [];

  var childrenOf = {};
  var rootIds = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.r === 1) {
      rootIds.push(it.i);
    } else if (it.p !== null && it.p !== undefined) {
      (childrenOf[it.p] = childrenOf[it.p] || []).push(it.i);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  (function renderTargets() {
    if (!targets.length) return;
    var box = document.getElementById('targetsList');
    var parts = [];
    for (var k = 0; k < targets.length; k++) {
      var t = targets[k];
      var depth = (t.max_depth === null || t.max_depth === undefined) ? '全階層' : ('深さ ' + t.max_depth);
      parts.push('<code>' + escapeHtml(t.path) + '</code> (' + depth + ')');
    }
    var html = '対象: ' + parts.join(' / ');
    var dedup = RAW.dedup_skipped | 0;
    if (dedup > 0) {
      html += ' ・ <span class="dedup-note" title="重なるターゲット同士でマージされた件数">' +
              '重複により ' + dedup + ' 件統合</span>';
    }
    box.innerHTML = html;
  })();

  var extSet = {};
  for (var i2 = 0; i2 < items.length; i2++) {
    if (items[i2].t === 1 && items[i2].e) extSet[items[i2].e] = true;
  }
  var extList = Object.keys(extSet).sort();
  var extSel = document.getElementById('extFilter');
  for (var k = 0; k < extList.length; k++) {
    var opt = document.createElement('option');
    opt.value = extList[k];
    opt.textContent = '.' + extList[k];
    extSel.appendChild(opt);
  }

  var treeNodes = new Array(items.length);
  var tableRows = new Array(items.length);

  function setCopied(btn) {
    btn.classList.add('copied');
    if (!btn.dataset.orig) btn.dataset.orig = btn.textContent;
    btn.textContent = 'OK';
    setTimeout(function() {
      btn.classList.remove('copied');
      btn.textContent = btn.dataset.orig;
    }, 1200);
  }
  function copyText(text, btn) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function() { setCopied(btn); }, function() { fallbackCopy(text, btn); });
    } else {
      fallbackCopy(text, btn);
    }
  }
  function fallbackCopy(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); setCopied(btn); } catch (e) {}
    document.body.removeChild(ta);
  }
  function makeCopyBtn(text, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy-btn';
    b.textContent = label;
    b.title = text;
    b.addEventListener('click', function(e) {
      e.stopPropagation();
      copyText(text, b);
    });
    return b;
  }

  var modalEl = document.getElementById('modal');
  var modalTitle = document.getElementById('modalTitle');
  var modalBody = document.getElementById('modalBody');

  function addRow(dt, dd) {
    var dtEl = document.createElement('dt'); dtEl.textContent = dt;
    var ddEl = document.createElement('dd');
    if (typeof dd === 'string') ddEl.textContent = dd;
    else ddEl.appendChild(dd);
    modalBody.appendChild(dtEl);
    modalBody.appendChild(ddEl);
  }

  function makePathBlock(path) {
    var wrap = document.createElement('div');
    var box = document.createElement('div');
    box.className = 'path-value';
    box.textContent = path;
    wrap.appendChild(box);
    var actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(makeCopyBtn(path, 'このパスをコピー'));
    wrap.appendChild(actions);
    return wrap;
  }

  function showDetail(item) {
    modalTitle.innerHTML = '';
    var badge = document.createElement('span');
    badge.className = 'badge' + (item.sl ? ' badge-link' : '');
    badge.textContent = item.sl ? 'リンク' : (item.t === 0 ? 'フォルダ' : 'ファイル');
    modalTitle.appendChild(badge);
    var nameSpan = document.createElement('span');
    nameSpan.textContent = item.n;
    modalTitle.appendChild(nameSpan);

    modalBody.innerHTML = '';
    var typeLabel = item.sl ? 'シンボリックリンク' : (item.t === 0 ? 'フォルダ' : 'ファイル');
    addRow('種別', typeLabel);
    addRow('名前', item.n);
    if (item.sl) {
      addRow('リンク先', item.slt || '(不明)');
    } else if (item.t === 1) {
      addRow('拡張子', item.e ? '.' + item.e : '（なし）');
      addRow('サイズ', item.s || '-');
    } else {
      addRow('アイテム数', item.c === null ? '? (アクセスエラー)' : String(item.c));
    }
    addRow('更新日時', item.m || '-');
    addRow(item.t === 1 ? 'ファイルパス' : 'フォルダパス', makePathBlock(item.cp));
    if (item.t === 1 && item.pcp) {
      addRow('親フォルダパス', makePathBlock(item.pcp));
    }
    if (item.err) {
      var errBlock = document.createElement('div');
      errBlock.className = 'error-block';
      errBlock.textContent = '⚠ アクセスエラー: ' + item.err;
      addRow('エラー', errBlock);
    }
    if (item.tr) {
      var trBlock = document.createElement('div');
      trBlock.className = 'truncated-note';
      trBlock.textContent = 'max_depth に達したため配下のフォルダ・ファイルは走査されていません';
      addRow('走査状態', trBlock);
    }

    if (typeof modalEl.showModal === 'function') {
      if (!modalEl.open) modalEl.showModal();
    } else {
      modalEl.setAttribute('open', '');
    }
  }

  function closeDetail() {
    if (typeof modalEl.close === 'function' && modalEl.open) {
      modalEl.close();
    } else {
      modalEl.removeAttribute('open');
    }
  }

  modalEl.addEventListener('click', function(e) {
    if (e.target.closest('.modal-close')) {
      closeDetail();
      return;
    }
    if (e.target === modalEl) {
      closeDetail();
    }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && modalEl.open) {
      e.preventDefault();
      closeDetail();
    }
  });

  function makeDetailBtn(item) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy-btn detail-btn';
    b.textContent = '詳細';
    b.title = '詳細を表示';
    b.addEventListener('click', function(e) {
      e.stopPropagation();
      showDetail(item);
    });
    return b;
  }

  function ensureChildrenRendered(li, id) {
    if (li.dataset.childrenRendered === '1') return;
    var kids = childrenOf[id];
    if (!kids || kids.length === 0) return;
    var ul = li.querySelector(':scope > ul');
    if (!ul) {
      ul = document.createElement('ul');
      li.appendChild(ul);
    }
    var frag = document.createDocumentFragment();
    for (var x = 0; x < kids.length; x++) {
      frag.appendChild(buildTreeNode(kids[x]));
    }
    ul.appendChild(frag);
    li.dataset.childrenRendered = '1';
  }

  function buildTreeNode(id) {
    var it = items[id];
    var li = document.createElement('li');
    li.dataset.id = id;
    if (it.r) li.dataset.root = '1';
    treeNodes[id] = li;

    var kids = childrenOf[id];
    var hasKids = kids && kids.length > 0;
    if (!hasKids) li.classList.add('leaf');
    if (!it.r) li.classList.add('collapsed');

    var itemEl = document.createElement('div');
    itemEl.className = 'item';

    var toggle = document.createElement('span');
    toggle.className = 'toggle';
    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      if (!hasKids) return;
      if (li.classList.contains('collapsed')) {
        ensureChildrenRendered(li, id);
      }
      li.classList.toggle('collapsed');
    });
    itemEl.appendChild(toggle);

    var icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = it.sl ? '\u{1F517}' : (it.t === 0 ? '\u{1F4C1}' : '\u{1F4C4}');
    itemEl.appendChild(icon);

    var name = document.createElement('span');
    var nameClasses = 'name ' + (it.t === 0 ? 'folder' : 'file');
    if (it.sl) nameClasses += ' symlink';
    if (it.tr) nameClasses += ' truncated';
    name.className = nameClasses;
    name.textContent = it.n;
    var nameTooltip = it.n;
    if (it.sl) nameTooltip += '\nシンボリックリンク → ' + (it.slt || '(不明)');
    if (it.tr) nameTooltip += '\nmax_depth により配下は未走査';
    name.title = nameTooltip;
    itemEl.appendChild(name);

    if (it.err) {
      li.classList.add('li-error');
      var warn = document.createElement('span');
      warn.className = 'item-error';
      warn.textContent = '⚠';
      warn.title = 'アクセスエラー: ' + it.err;
      itemEl.appendChild(warn);
    }

    var info = document.createElement('span');
    info.className = 'info';
    if (it.sl) {
      info.textContent = '→ ' + (it.slt || '(不明)') + ' · ' + it.m;
    } else if (it.t === 1) {
      info.textContent = (it.s || '') + ' · ' + it.m;
    } else {
      var countDisplay = it.c === null ? '?' : (it.c + ' items');
      info.textContent = countDisplay + ' · ' + it.m;
    }
    if (it.tr) {
      var note = document.createElement('span');
      note.className = 'truncated-note';
      note.textContent = ' · 未走査';
      note.title = 'max_depth により配下は走査されていません';
      info.appendChild(note);
    }
    itemEl.appendChild(info);

    var actions = document.createElement('span');
    actions.className = 'actions';
    if (it.t === 1) {
      actions.appendChild(makeCopyBtn(it.pcp, '親'));
      actions.appendChild(makeCopyBtn(it.cp, 'パス'));
    } else {
      actions.appendChild(makeCopyBtn(it.cp, 'パス'));
    }
    actions.appendChild(makeDetailBtn(it));
    itemEl.appendChild(actions);

    li.appendChild(itemEl);

    // 子は遅延生成。展開時に ensureChildrenRendered で実体化する。
    // ただしルートノードは初期表示で展開済みなので即座に生成しておく。
    if (hasKids && it.r) {
      ensureChildrenRendered(li, id);
    }
    return li;
  }

  function buildTree() {
    var container = document.getElementById('treeView');
    var ul = document.createElement('ul');
    ul.className = 'tree';
    for (var r = 0; r < rootIds.length; r++) ul.appendChild(buildTreeNode(rootIds[r]));
    container.appendChild(ul);
  }

  function ensureAllRendered() {
    // 遅延展開ノードを全て実体化する（フィルタや全展開時に呼ばれる）。
    var stack = [];
    for (var i = 0; i < items.length; i++) {
      if (treeNodes[i] && treeNodes[i].dataset.childrenRendered !== '1') {
        stack.push(i);
      }
    }
    while (stack.length > 0) {
      var id = stack.pop();
      var li = treeNodes[id];
      if (!li || li.dataset.childrenRendered === '1') continue;
      ensureChildrenRendered(li, id);
      var kids = childrenOf[id] || [];
      for (var k = 0; k < kids.length; k++) stack.push(kids[k]);
    }
  }

  function buildTable() {
    var tbody = document.getElementById('tableBody');
    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var tr = document.createElement('tr');
      tr.dataset.id = i;
      tableRows[i] = tr;

      var tdName = document.createElement('td');
      tdName.className = 'name';
      tdName.textContent = it.n;
      tdName.title = it.n;
      if (it.t === 0) tdName.style.fontWeight = '500';
      if (it.err) {
        tr.classList.add('row-error');
        var warn = document.createElement('span');
        warn.className = 'item-error';
        warn.textContent = ' ⚠';
        warn.title = 'アクセスエラー: ' + it.err;
        tdName.appendChild(warn);
      }
      tr.appendChild(tdName);

      var tdType = document.createElement('td');
      tdType.textContent = it.sl ? 'リンク' : (it.t === 0 ? 'フォルダ' : 'ファイル');
      if (it.sl) tdType.title = '→ ' + (it.slt || '(不明)');
      tr.appendChild(tdType);

      var tdExt = document.createElement('td');
      tdExt.textContent = it.e ? '.' + it.e : '';
      tr.appendChild(tdExt);

      var tdSize = document.createElement('td');
      tdSize.className = 'num';
      tdSize.textContent = it.s || '';
      tr.appendChild(tdSize);

      var tdCount = document.createElement('td');
      tdCount.className = 'num';
      if (it.t === 0) {
        if (it.tr) {
          tdCount.textContent = '…';
          tdCount.classList.add('truncated');
          tdCount.title = 'max_depth により配下は未走査';
        } else {
          tdCount.textContent = it.c === null ? '?' : it.c;
        }
      }
      tr.appendChild(tdCount);

      var tdMtime = document.createElement('td');
      tdMtime.textContent = it.m;
      tr.appendChild(tdMtime);

      var tdPath = document.createElement('td');
      tdPath.className = 'path';
      tdPath.textContent = it.cp;
      tdPath.title = it.cp;
      tr.appendChild(tdPath);

      var tdActions = document.createElement('td');
      tdActions.className = 'actions';
      if (it.t === 1) {
        tdActions.appendChild(makeCopyBtn(it.pcp, '親'));
        tdActions.appendChild(makeCopyBtn(it.cp, 'パス'));
      } else {
        tdActions.appendChild(makeCopyBtn(it.cp, 'パス'));
      }
      tdActions.appendChild(makeDetailBtn(it));
      tr.appendChild(tdActions);

      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
  }

  var filterTimer = null;
  function scheduleFilter() {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilter, 120);
  }
  function applyFilter() {
    var q = document.getElementById('search').value.trim().toLowerCase();
    var ext = document.getElementById('extFilter').value;
    var type = document.getElementById('typeFilter').value;
    var active = !!(q || ext || type);

    // フィルタはツリー全体の可視性を扱うため、遅延展開された節を全部実体化する。
    if (active) ensureAllRendered();

    var N = items.length;
    var matches = new Uint8Array(N);
    var hasMD = new Uint8Array(N);

    for (var i = 0; i < N; i++) {
      var it = items[i];
      var m = 1;
      if (q && it.n.toLowerCase().indexOf(q) === -1 && it.cp.toLowerCase().indexOf(q) === -1) m = 0;
      if (m && ext && it.e !== ext) m = 0;
      if (m && type) {
        if (type === 'symlink') {
          if (!it.sl) m = 0;
        } else if (type === 'folder') {
          if (it.t !== 0) m = 0;
        } else if (type === 'file') {
          // 通常ファイル (symlink 除外、フォルダ除外)
          if (it.t !== 1 || it.sl) m = 0;
        }
      }
      matches[i] = m;
    }

    for (var j = N - 1; j >= 0; j--) {
      if (matches[j] || hasMD[j]) {
        var pp = items[j].p;
        if (pp !== null && pp !== undefined) hasMD[pp] = 1;
      }
    }

    var visible = 0;
    for (var k2 = 0; k2 < N; k2++) {
      var it2 = items[k2];
      var visTree = !active || matches[k2] || hasMD[k2];
      var visTable = !active || matches[k2];
      var tn = treeNodes[k2];
      if (tn) {
        tn.classList.toggle('hidden', !visTree);
        if (active && hasMD[k2] && it2.t === 0) tn.classList.remove('collapsed');
      }
      var tr2 = tableRows[k2];
      if (tr2) tr2.classList.toggle('hidden', !visTable);
      if (matches[k2]) visible++;
    }

    var status = document.getElementById('visibleStatus');
    status.textContent = active ? ' · フィルタ結果: ' + visible + ' 件' : '';
  }

  document.querySelectorAll('.view-toggle button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.view-toggle button').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var v = btn.dataset.view;
      document.querySelectorAll('.view').forEach(function(el) { el.classList.remove('active'); });
      document.getElementById(v + 'View').classList.add('active');
    });
  });

  document.getElementById('expandAll').addEventListener('click', function() {
    ensureAllRendered();
    for (var i = 0; i < items.length; i++) {
      var tn = treeNodes[i];
      if (tn) tn.classList.remove('collapsed');
    }
  });
  document.getElementById('collapseAll').addEventListener('click', function() {
    for (var i = 0; i < items.length; i++) {
      var tn = treeNodes[i];
      if (tn && !items[i].r) tn.classList.add('collapsed');
    }
  });

  var sortState = { col: null, dir: 1 };
  document.querySelectorAll('th[data-sort]').forEach(function(th) {
    th.addEventListener('click', function() {
      var col = th.dataset.sort;
      if (sortState.col === col) sortState.dir *= -1;
      else { sortState.col = col; sortState.dir = 1; }
      document.querySelectorAll('th[data-sort]').forEach(function(x) {
        x.classList.remove('sort-asc');
        x.classList.remove('sort-desc');
      });
      th.classList.add(sortState.dir === 1 ? 'sort-asc' : 'sort-desc');
      sortTable(col, sortState.dir);
    });
  });

  function parseSizeNum(s) {
    if (!s) return -1;
    var m = s.match(/^([\d.]+)\s*(\w+)$/);
    if (!m) return 0;
    var mul = { B:1, KB:1024, MB:1048576, GB:1073741824, TB:1099511627776, PB:1125899906842624 };
    return parseFloat(m[1]) * (mul[m[2].toUpperCase()] || 1);
  }

  function sortTable(col, dir) {
    var tbody = document.getElementById('tableBody');
    var rows = Array.prototype.slice.call(tbody.children);
    var keyFn = {
      name: function(r) { return items[+r.dataset.id].n.toLowerCase(); },
      type: function(r) { return items[+r.dataset.id].t; },
      ext:  function(r) { return items[+r.dataset.id].e || ''; },
      size: function(r) { return parseSizeNum(items[+r.dataset.id].s); },
      count: function(r) { return items[+r.dataset.id].c || 0; },
      mtime: function(r) { return items[+r.dataset.id].m; },
      path: function(r) { return items[+r.dataset.id].cp.toLowerCase(); }
    }[col];
    rows.sort(function(a, b) {
      var ka = keyFn(a), kb = keyFn(b);
      if (ka < kb) return -dir;
      if (ka > kb) return dir;
      return 0;
    });
    var frag = document.createDocumentFragment();
    for (var i = 0; i < rows.length; i++) frag.appendChild(rows[i]);
    tbody.appendChild(frag);
  }

  if (errors.length > 0) {
    var box = document.getElementById('errorBox');
    var div = document.createElement('div');
    div.id = 'errorListSection';
    div.className = 'errors';
    var h2 = document.createElement('h2');
    h2.textContent = 'アクセスできなかった項目 (' + errors.length + ')';
    div.appendChild(h2);
    var ul = document.createElement('ul');
    for (var ei = 0; ei < errors.length; ei++) {
      var li = document.createElement('li');
      li.textContent = errors[ei].path + ' — ' + errors[ei].error;
      ul.appendChild(li);
    }
    div.appendChild(ul);
    box.appendChild(div);

    var banner = document.getElementById('errorBanner');
    document.getElementById('errorBannerCount').textContent = errors.length;
    banner.classList.add('show');
    document.getElementById('errorBannerLink').addEventListener('click', function() {
      document.getElementById('errorListSection').scrollIntoView({behavior: 'smooth', block: 'start'});
    });
  }

  if (items.length > 20000) {
    document.getElementById('perfCount').textContent = items.length.toLocaleString();
    document.getElementById('perfWarn').style.display = 'block';
  }

  buildTree();
  buildTable();

  ['search', 'extFilter', 'typeFilter'].forEach(function(id) {
    document.getElementById(id).addEventListener('input', scheduleFilter);
  });

  document.getElementById('tableBody').addEventListener('click', function(e) {
    if (e.target.closest('button')) return;
    if (window.getSelection && window.getSelection().toString()) return;
    var tr = e.target.closest('tr');
    if (!tr || !tr.dataset.id) return;
    var it = items[+tr.dataset.id];
    if (it) showDetail(it);
  });
})();
