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

  // 深さを事前計算（id は親が先に来る順なので 1 パスで埋まる）。
  var depthOf = new Array(items.length);
  for (var di = 0; di < items.length; di++) {
    var dpi = items[di];
    depthOf[di] = (dpi.p === null || dpi.p === undefined) ? 0 : depthOf[dpi.p] + 1;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  // ===== 共通ヘルパ: アイテム種別ラベル =====
  function getTypeLabel(it, longSymlink) {
    if (it.sl) return longSymlink ? 'シンボリックリンク' : 'リンク';
    return it.t === 0 ? 'フォルダ' : 'ファイル';
  }

  function getTypeIcon(it) {
    if (it.sl) return '\u{1F517}';
    return it.t === 0 ? '\u{1F4C1}' : '\u{1F4C4}';
  }

  // ===== 共通ヘルパ: アクションボタン群を container に append =====
  function appendActionsTo(container, it) {
    if (it.t === 1) {
      container.appendChild(makeCopyBtn(it.pcp, '親'));
    }
    container.appendChild(makeCopyBtn(it.cp, 'パス'));
    container.appendChild(makeDetailBtn(it));
  }

  (function renderTargets() {
    if (!targets.length) return;
    var box = document.getElementById('targetsList');
    var items = [];
    for (var k = 0; k < targets.length; k++) {
      var t = targets[k];
      var depth = (t.max_depth === null || t.max_depth === undefined) ? '全階層' : ('深さ ' + t.max_depth);
      items.push('<div class="target-item"><code>' + escapeHtml(t.path) +
                 '</code> <span class="muted">(' + depth + ')</span></div>');
    }
    var dedupHtml = '';
    var dedup = RAW.dedup_skipped || 0;
    if (dedup > 0) {
      dedupHtml = ' ・ <span class="dedup-note" title="重なるターゲット同士でマージされた件数">' +
                  '重複により ' + dedup + ' 件統合</span>';
    }
    // 既定では折りたたみ。クリックで展開して個別パスを確認できる。
    box.innerHTML =
      '対象: <span class="target-count">' + targets.length + ' 件</span>' +
      ' <details class="targets-detail"><summary>パスを表示</summary>' +
      '<div class="targets-detail-body">' + items.join('') + '</div>' +
      '</details>' +
      dedupHtml;
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
  function quoteForCopy(text) {
    // 半角スペースを含むパスのみダブルクォートで包む（シェル・アドレスバー貼付の安全策）。
    // スペース無しのパスは bare のままにして、Excel/Word への貼付で余計な " が出ないようにする。
    // 内側の " は \" でエスケープ。
    var s = String(text);
    if (s.indexOf(' ') === -1) return s;
    return '"' + s.replace(/"/g, '\\"') + '"';
  }
  function copyText(text, btn) {
    var quoted = quoteForCopy(text);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(quoted).then(function() { setCopied(btn); }, function() { fallbackCopy(quoted, btn); });
    } else {
      fallbackCopy(quoted, btn);
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
    badge.textContent = getTypeLabel(item);
    modalTitle.appendChild(badge);
    var nameSpan = document.createElement('span');
    nameSpan.textContent = item.n;
    modalTitle.appendChild(nameSpan);

    modalBody.innerHTML = '';
    addRow('種別', getTypeLabel(item, true));
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
    icon.textContent = getTypeIcon(it);
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
    appendActionsTo(actions, it);
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

  function ensurePathRendered(id) {
    // 指定 item の祖先パスを必要最小限だけ実体化（フィルタ時のスマート展開用）。
    // stack を浅→深の順に消化することで、各 pop 時には親が必ず実体化済みになる。
    if (treeNodes[id]) return;
    var stack = [];
    var cur = id;
    while (cur !== null && cur !== undefined && !treeNodes[cur]) {
      stack.push(cur);
      cur = items[cur].p;
    }
    while (stack.length > 0) {
      var childId = stack.pop();
      var parentId = items[childId].p;
      ensureChildrenRendered(treeNodes[parentId], parentId);
    }
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
      tdType.textContent = getTypeLabel(it);
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
      appendActionsTo(tdActions, it);
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
    var showErrored = document.getElementById('showErrored').checked;
    // 「不可も表示」が外れていればアクセス不可フォルダを非表示扱いにする
    var hideErrored = !showErrored;
    var active = !!(q || ext || type || hideErrored);

    syncHash();

    var N = items.length;
    var matches = new Uint8Array(N);
    var hasMD = new Uint8Array(N);

    for (var i = 0; i < N; i++) {
      var it = items[i];
      var m = 1;
      if (m && hideErrored && it.err) m = 0;
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

    // フィルタ中: マッチした要素の祖先パスのみ実体化（巨大ツリーの初回フィルタ高速化）。
    if (active) {
      for (var ri = 0; ri < N; ri++) {
        if (matches[ri]) ensurePathRendered(ri);
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

  document.getElementById('depthExpand').addEventListener('change', function(e) {
    var v = e.target.value;
    if (!v) return;
    if (v === 'all') {
      ensureAllRendered();
      for (var i = 0; i < items.length; i++) {
        var tn = treeNodes[i];
        if (tn) tn.classList.remove('collapsed');
      }
    } else {
      var maxD = parseInt(v, 10);
      // 指定深さに到達する全 item の祖先パスを実体化
      for (var i2 = 0; i2 < items.length; i2++) {
        if (depthOf[i2] <= maxD) ensurePathRendered(i2);
      }
      for (var i3 = 0; i3 < items.length; i3++) {
        var tn3 = treeNodes[i3];
        if (!tn3) continue;
        if (depthOf[i3] < maxD) tn3.classList.remove('collapsed');
        else if (!items[i3].r) tn3.classList.add('collapsed');
      }
    }
    e.target.value = '';  // select をリセットして再選択を可能に
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
    // Schwartzian transform: 比較中に毎回 keyFn を呼ばないよう、行毎にキーを一度だけ計算。
    var keyed = new Array(rows.length);
    for (var ki = 0; ki < rows.length; ki++) keyed[ki] = [keyFn(rows[ki]), rows[ki]];
    keyed.sort(function(a, b) {
      if (a[0] < b[0]) return -dir;
      if (a[0] > b[0]) return dir;
      return 0;
    });
    var frag = document.createDocumentFragment();
    for (var i = 0; i < keyed.length; i++) frag.appendChild(keyed[i][1]);
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
  document.getElementById('showErrored').addEventListener('change', scheduleFilter);

  document.getElementById('tableBody').addEventListener('click', function(e) {
    if (e.target.closest('button')) return;
    if (window.getSelection && window.getSelection().toString()) return;
    var tr = e.target.closest('tr');
    if (!tr || !tr.dataset.id) return;
    var it = items[+tr.dataset.id];
    if (it) showDetail(it);
  });

  // ===== 表示列のトグル (N6 / N15) =====
  var COL_KEYS = ['type', 'ext', 'size', 'count', 'mtime', 'path'];
  var colPanel = document.getElementById('columnPanel');
  function getColCheckbox(col) {
    return colPanel.querySelector('input[data-col="' + col + '"]');
  }
  document.getElementById('columnSettings').addEventListener('click', function(e) {
    e.stopPropagation();
    colPanel.hidden = !colPanel.hidden;
  });
  document.addEventListener('click', function(e) {
    // パネル外クリックで閉じる
    if (!colPanel.hidden && !colPanel.contains(e.target)
        && e.target.id !== 'columnSettings') {
      colPanel.hidden = true;
    }
  });
  function applyColumnState() {
    var table = document.querySelector('#tableView table');
    if (!table) return;
    COL_KEYS.forEach(function(c) {
      var cb = getColCheckbox(c);
      table.classList.toggle('col-' + c + '-hidden', cb && !cb.checked);
    });
  }
  colPanel.addEventListener('change', function(e) {
    if (e.target.dataset && e.target.dataset.col) {
      applyColumnState();
      syncHash();
    }
  });

  // ===== CSV エクスポート (24) =====
  function csvEscape(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  function exportCsv() {
    var headers = ['名前', '種別', '拡張子', 'サイズ', 'アイテム数', '更新日時',
                   'パス', '親フォルダパス', 'リンク先', 'エラー'];
    var lines = [headers.map(csvEscape).join(',')];
    for (var i = 0; i < items.length; i++) {
      var tr = tableRows[i];
      if (tr && tr.classList.contains('hidden')) continue;  // 現在のフィルタ結果のみ
      var it = items[i];
      var typeLabel = getTypeLabel(it);
      // truncated folder は count を計測していない (走査未実施)。エラーフォルダは count=null。
      // 両方とも CSV 上は空欄にする。
      var count = '';
      if (it.t === 0 && !it.tr && it.c !== null) count = it.c;
      lines.push([
        it.n, typeLabel, it.e ? '.' + it.e : '', it.s || '', count,
        it.m, it.cp, it.pcp || '', it.slt || '', it.err || ''
      ].map(csvEscape).join(','));
    }
    // Excel が UTF-8 を認識できるよう BOM 付与
    var blob = new Blob(['﻿' + lines.join('\r\n')], {type: 'text/csv;charset=utf-8'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    var d = new Date();
    var ts = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
           + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    a.href = url;
    a.download = 'filelist-' + ts + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  }
  document.getElementById('csvExport').addEventListener('click', exportCsv);

  // ===== URL ハッシュで状態保持 (13) =====
  var syncing = false;

  function readHashState() {
    var hash = location.hash.slice(1);
    if (!hash) return {};
    var out = {};
    hash.split('&').forEach(function(p) {
      var eq = p.indexOf('=');
      if (eq < 0) return;
      out[decodeURIComponent(p.slice(0, eq))] = decodeURIComponent(p.slice(eq + 1));
    });
    return out;
  }

  function applyHashState() {
    var s = readHashState();
    syncing = true;
    if (s.search !== undefined) document.getElementById('search').value = s.search;
    if (s.ext !== undefined) document.getElementById('extFilter').value = s.ext;
    if (s.type !== undefined) document.getElementById('typeFilter').value = s.type;
    if (s.errors === '1') document.getElementById('showErrored').checked = true;
    if (s.view === 'table' || s.view === 'tree') {
      var btn = document.querySelector('.view-toggle button[data-view="' + s.view + '"]');
      if (btn) btn.click();
    }
    if (s.cols !== undefined) {
      // cols は「非表示列」のカンマ区切り。空または未指定 = 全表示。
      var hidden = s.cols ? s.cols.split(',') : [];
      COL_KEYS.forEach(function(c) {
        var cb = getColCheckbox(c);
        if (cb) cb.checked = hidden.indexOf(c) === -1;
      });
      applyColumnState();
    }
    syncing = false;
    applyFilter();
  }

  function syncHash() {
    if (syncing) return;
    var parts = [];
    var s = document.getElementById('search').value;
    var e = document.getElementById('extFilter').value;
    var t = document.getElementById('typeFilter').value;
    var showErr = document.getElementById('showErrored').checked;
    var v = document.querySelector('.view-toggle button.active');
    if (s) parts.push('search=' + encodeURIComponent(s));
    if (e) parts.push('ext=' + encodeURIComponent(e));
    if (t) parts.push('type=' + encodeURIComponent(t));
    if (showErr) parts.push('errors=1');
    if (v && v.dataset.view !== 'tree') parts.push('view=' + v.dataset.view);
    var hiddenCols = COL_KEYS.filter(function(c) {
      var cb = getColCheckbox(c);
      return cb && !cb.checked;
    });
    if (hiddenCols.length > 0) parts.push('cols=' + hiddenCols.join(','));
    var newHash = parts.length ? '#' + parts.join('&') : '';
    if (location.hash !== newHash) {
      history.replaceState(null, '', location.pathname + location.search + newHash);
    }
  }

  document.querySelectorAll('.view-toggle button').forEach(function(btn) {
    btn.addEventListener('click', syncHash);
  });
  window.addEventListener('hashchange', applyHashState);

  // 初期読込時の hash 反映 (なければ既定フィルタ＝アクセス不可フォルダ非表示 を適用)
  if (location.hash) applyHashState();
  else applyFilter();
})();
