(function() {
  var RAW = JSON.parse(document.getElementById('data').textContent);
  var items = RAW.items;
  var errors = RAW.errors || [];
  var targets = RAW.targets || [];
  var excludePatterns = RAW.exclude_patterns || [];

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

  // 表示順をフォルダ優先 + 名前昇順で正規化。
  // scan_target 内の sort と整合させ、合成ルート下や複数ルートでも一貫した並びにする。
  function sortItemIds(ids) {
    ids.sort(function(a, b) {
      var ia = items[a], ib = items[b];
      var fa = (ia.t === 0 && !ia.sl) ? 0 : 1;
      var fb = (ib.t === 0 && !ib.sl) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      var na = ia.n.toLowerCase();
      var nb = ib.n.toLowerCase();
      return na < nb ? -1 : (na > nb ? 1 : 0);
    });
  }
  sortItemIds(rootIds);
  for (var _p in childrenOf) sortItemIds(childrenOf[_p]);

  // 深さを事前計算。合成ルートが末尾に追加されるケース等、親 id が子 id より大きい
  // 可能性があるため、メモ化再帰で順序非依存に計算する。
  var depthOf = new Array(items.length);
  function _computeDepth(id) {
    if (depthOf[id] !== undefined) return depthOf[id];
    var p = items[id].p;
    if (p === null || p === undefined) {
      depthOf[id] = 0;
    } else {
      depthOf[id] = _computeDepth(p) + 1;
    }
    return depthOf[id];
  }
  for (var di = 0; di < items.length; di++) _computeDepth(di);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  // ===== 共通ヘルパ: アイテム種別ラベル =====
  function getTypeLabel(it, longSymlink) {
    if (it.ex) return '除外';
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

  (function renderMetaInfo() {
    var box = document.getElementById('metaInfo');
    var parts = [];
    if (targets.length) {
      parts.push('対象: ' + targets.length + ' 件 ' +
                 '<button type="button" class="link-btn" id="showTargetsBtn" ' +
                 'title="対象パス一覧をモーダルで表示">パスを表示</button>');
    }
    if (excludePatterns.length) {
      parts.push('除外: ' + excludePatterns.length + ' 件 ' +
                 '<button type="button" class="link-btn" id="showExcludesBtn" ' +
                 'title="除外パターン一覧をモーダルで表示">パターンを表示</button>');
    }
    var dedup = RAW.dedup_skipped || 0;
    if (dedup > 0) {
      parts.push('<span class="dedup-note" title="重なるターゲット同士でマージされた件数">' +
                 '重複により ' + dedup + ' 件統合</span>');
    }
    box.innerHTML = parts.join(' ・ ');
  })();

  // ===== 共通の list modal =====
  var listModalEl = document.getElementById('listModal');
  function showListModal(title, html) {
    document.getElementById('listModalTitle').textContent = title;
    document.getElementById('listModalBody').innerHTML = html;
    if (typeof listModalEl.showModal === 'function') {
      if (!listModalEl.open) listModalEl.showModal();
    } else {
      listModalEl.setAttribute('open', '');
    }
  }
  function closeListModal() {
    if (typeof listModalEl.close === 'function' && listModalEl.open) listModalEl.close();
    else listModalEl.removeAttribute('open');
  }
  listModalEl.addEventListener('click', function(e) {
    if (e.target.closest('.modal-close') || e.target === listModalEl) closeListModal();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && listModalEl.open) {
      e.preventDefault();
      closeListModal();
    }
  });

  function sortByPathInsensitive(list) {
    return list.slice().sort(function(a, b) {
      var pa = (a.path || '').toLowerCase();
      var pb = (b.path || '').toLowerCase();
      return pa < pb ? -1 : (pa > pb ? 1 : 0);
    });
  }

  // 対象パス一覧ボタン
  var targetsBtn = document.getElementById('showTargetsBtn');
  if (targetsBtn) {
    targetsBtn.addEventListener('click', function() {
      var sorted = sortByPathInsensitive(targets);
      var lis = sorted.map(function(t) {
        var depth = (t.max_depth === null || t.max_depth === undefined) ? '全階層' : '深さ ' + t.max_depth;
        return '<li><code>' + escapeHtml(t.path) + '</code>' +
               '<span class="item-meta">(' + depth + ')</span></li>';
      }).join('');
      showListModal('対象パス (' + targets.length + ')', lis);
    });
  }

  // 除外パターン一覧ボタン
  var excludesBtn = document.getElementById('showExcludesBtn');
  if (excludesBtn) {
    excludesBtn.addEventListener('click', function() {
      // フォルダ単位の除外は items に残るので動的に集計、
      // ファイル / symlink 単位の除外は payload (excluded_file_counts) を使う。
      var folderHits = {};
      for (var ei = 0; ei < items.length; ei++) {
        var ex = items[ei];
        if (ex.ex && ex.exp) {
          folderHits[ex.exp] = (folderHits[ex.exp] || 0) + 1;
        }
      }
      var fileHits = RAW.excluded_file_counts || {};
      var sorted = excludePatterns.slice().sort(function(a, b) {
        var la = a.toLowerCase(), lb = b.toLowerCase();
        return la < lb ? -1 : (la > lb ? 1 : 0);
      });
      var lis = sorted.map(function(p) {
        var fh = folderHits[p] || 0;
        var fl = fileHits[p] || 0;
        var total = fh + fl;
        var hitLabel;
        if (total === 0) {
          hitLabel = 'ヒット 0 件';
        } else if (fh > 0 && fl > 0) {
          hitLabel = total + ' 件にヒット (フォルダ ' + fh + ' / ファイル ' + fl + ')';
        } else if (fh > 0) {
          hitLabel = fh + ' 件にヒット (フォルダ)';
        } else {
          hitLabel = fl + ' 件にヒット (ファイル)';
        }
        return '<li><code>' + escapeHtml(p) + '</code>' +
               '<span class="item-meta">(' + hitLabel + ')</span></li>';
      }).join('');
      showListModal('除外パターン (' + excludePatterns.length + ')', lis);
    });
  }

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
  // tableRows[] は廃止 (案 4 仮想スクロール対応)。可視範囲だけ実体化するので
  // id → tr の永続マップは不要。詳細モーダル等は tr.dataset.id 経由でアクセスする。

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
    if (item.ex) {
      var exBlock = document.createElement('div');
      exBlock.className = 'excluded-note';
      exBlock.textContent = '除外パターン "' + (item.exp || '') + '" により配下のフォルダ・ファイルは走査されていません';
      addRow('走査状態', exBlock);
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
    if (it.kv) li.classList.add('li-keep-visible');
    if (it.ex) {
      li.classList.add('li-excluded');
      name.title = it.n + '\n除外パターン "' + it.exp + '" により配下は走査されません';
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
    if (it.ex) {
      var exNote = document.createElement('span');
      exNote.className = 'truncated-note';
      exNote.textContent = ' · 除外: ' + it.exp;
      exNote.title = '除外パターン "' + it.exp + '" により配下は走査されません';
      info.appendChild(exNote);
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

  function buildTableRow(i) {
    var it = items[i];
    var tr = document.createElement('tr');
    tr.dataset.id = i;

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
    if (it.kv) tr.classList.add('row-keep-visible');
    if (it.ex) {
      tr.classList.add('row-excluded');
      tdName.title = it.n + '\n除外パターン "' + it.exp + '" により配下は走査されません';
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
    // 操作ボタンは hover で遅延生成 (80k 行 × 3 ボタンの初期生成コストを回避)。
    // ensureRowActions() で実体化する。
    tr.appendChild(tdActions);
    return tr;
  }

  // 行ホバー時に操作ボタン群を実体化する (初回のみ、以降は no-op)
  function ensureRowActions(tr) {
    if (!tr || tr.dataset.actionsBuilt === '1') return;
    var it = items[+tr.dataset.id];
    if (!it) return;
    var tdActions = tr.lastElementChild;
    if (!tdActions) return;
    appendActionsTo(tdActions, it);
    tr.dataset.actionsBuilt = '1';
  }

  // ===== 仮想スクロール対応のテーブル描画 (案 4) =====
  // 80k+ 行を扱うため、画面外の行は DOM に置かない。
  // - displayedIds[] : 表示対象 id (フィルタ・ソート後の順序)
  // - 可視範囲 + バッファだけ <tr> を実体化、上下を空 <tr> の高さでスペースを稼ぐ
  // - スクロール毎に窓を再描画 (高々 ~80 行の差分なので軽い)
  var ROW_HEIGHT = 28;       // <tr> の想定高さ (CSS の padding 4 + line-height 20 ≈ 28px)
  var BUFFER_ROWS = 10;      // 可視範囲の上下に確保する余白行数

  var displayedIds = [];
  for (var _vi = 0; _vi < items.length; _vi++) displayedIds.push(_vi);

  var vtTbody = null;
  var vtScrollContainer = null;
  var vtInitialized = false;
  var vtRafPending = false;
  var vtRenderedStart = -1;
  var vtRenderedEnd = -1;

  function vt_render() {
    vtRafPending = false;
    if (!vtTbody || !vtScrollContainer) return;
    var n = displayedIds.length;
    var clientHeight = vtScrollContainer.clientHeight;
    var scrollTop = vtScrollContainer.scrollTop;
    var visibleCount = Math.ceil(clientHeight / ROW_HEIGHT);
    var startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
    var endIdx = Math.min(n, startIdx + visibleCount + 2 * BUFFER_ROWS);
    if (startIdx === vtRenderedStart && endIdx === vtRenderedEnd) return;
    vtRenderedStart = startIdx;
    vtRenderedEnd = endIdx;

    vtTbody.innerHTML = '';
    if (startIdx > 0) {
      var top = document.createElement('tr');
      top.className = 'vt-spacer';
      top.style.height = (startIdx * ROW_HEIGHT) + 'px';
      vtTbody.appendChild(top);
    }
    var frag = document.createDocumentFragment();
    for (var i = startIdx; i < endIdx; i++) {
      frag.appendChild(buildTableRow(displayedIds[i]));
    }
    vtTbody.appendChild(frag);
    if (endIdx < n) {
      var bot = document.createElement('tr');
      bot.className = 'vt-spacer';
      bot.style.height = ((n - endIdx) * ROW_HEIGHT) + 'px';
      vtTbody.appendChild(bot);
    }
  }

  function vt_scheduleRender() {
    if (vtRafPending) return;
    vtRafPending = true;
    requestAnimationFrame(vt_render);
  }

  function vt_resetWindow() {
    // フィルタ・ソート変更時: 強制再描画のため rendered 範囲をリセット
    vtRenderedStart = -1;
    vtRenderedEnd = -1;
  }

  function ensureTableBuilt(callback) {
    if (!vtInitialized) {
      vtTbody = document.getElementById('tableBody');
      vtScrollContainer = document.querySelector('.table-wrap');
      if (vtTbody && vtScrollContainer) {
        vtScrollContainer.addEventListener('scroll', vt_scheduleRender, { passive: true });
        window.addEventListener('resize', vt_scheduleRender);
        vtInitialized = true;
        // 表示準備中の旧 progress 要素は廃止 (即時表示)
        var progress = document.getElementById('tableBuildProgress');
        if (progress) progress.style.display = 'none';
        vt_render();
      }
    }
    if (callback) callback(true);
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
    // 注: アクセス不可フォルダの非表示は body.hide-errored の CSS で実現しているため、
    // ここでは「inclusion フィルタ (検索 / 拡張子 / 種別)」だけ判定する。
    // これにより hideErrored だけが ON のときに全アイテムを「マッチ」扱いして
    // 祖先パスを大量に実体化する重い処理を避ける。
    var active = !!(q || ext || type);

    syncHash();

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

    // フィルタ中: マッチした要素の祖先パスのみ実体化（巨大ツリーの初回フィルタ高速化）。
    if (active) {
      for (var ri = 0; ri < N; ri++) {
        if (matches[ri]) ensurePathRendered(ri);
      }
    }

    var visible = 0;
    var visibleFolders = 0;
    var visibleFiles = 0;
    var newDisplayedIds = [];
    for (var k2 = 0; k2 < N; k2++) {
      var it2 = items[k2];
      var visTree = !active || matches[k2] || hasMD[k2];
      var visTable = !active || matches[k2];
      var tn = treeNodes[k2];
      if (tn) {
        tn.classList.toggle('hidden', !visTree);
        if (active && hasMD[k2] && it2.t === 0) tn.classList.remove('collapsed');
      }
      // 仮想スクロールでは tr 一覧をクラスで隠すのではなく、displayedIds から除外する
      if (visTable) newDisplayedIds.push(k2);
      if (matches[k2]) {
        visible++;
        if (it2.t === 0) visibleFolders++;
        else visibleFiles++;
      }
    }
    displayedIds = newDisplayedIds;
    // 現在のソート状態を新しい displayedIds に再適用
    if (sortState.col) sortDisplayedIds(sortState.col, sortState.dir);
    if (vtInitialized) {
      vtScrollContainer.scrollTop = 0;
      vt_resetWindow();
      vt_render();
    }

    renderFilterCount(active, visible, visibleFolders, visibleFiles);
  }

  // フィルタ件数を表示。未適用時は全件の内訳、適用時はマッチ件数を強調表示する。
  function renderFilterCount(active, visible, visibleFolders, visibleFiles) {
    var box = document.getElementById('filterCount');
    if (!box) return;
    var total = items.length;
    var totalFolders = 0, totalFiles = 0;
    if (!renderFilterCount._totalsCached) {
      for (var i = 0; i < total; i++) {
        if (items[i].t === 0) totalFolders++;
        else totalFiles++;
      }
      renderFilterCount._totalFolders = totalFolders;
      renderFilterCount._totalFiles = totalFiles;
      renderFilterCount._totalsCached = true;
    } else {
      totalFolders = renderFilterCount._totalFolders;
      totalFiles = renderFilterCount._totalFiles;
    }
    if (active) {
      box.classList.add('active');
      box.innerHTML = '一致 ' + visible + ' / ' + total + ' 件' +
        '<span class="fc-breakdown">フォルダ ' + visibleFolders +
        ' / ファイル ' + visibleFiles + '</span>';
    } else {
      box.classList.remove('active');
      box.innerHTML = '全 ' + total + ' 件' +
        '<span class="fc-breakdown">フォルダ ' + totalFolders +
        ' / ファイル ' + totalFiles + '</span>';
    }
  }

  document.querySelectorAll('.view-toggle button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.view-toggle button').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var v = btn.dataset.view;
      document.querySelectorAll('.view').forEach(function(el) { el.classList.remove('active'); });
      document.getElementById(v + 'View').classList.add('active');
      // テーブルビュー初表示時に行を構築 (遅延・チャンク)
      if (v === 'table') ensureTableBuilt();
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

  // displayedIds[] を col 列でソートする。仮想スクロールでは DOM 要素を直接並べ替え
  // ず、id 配列を並べ替えてから vt_render() で再描画する。
  function sortDisplayedIds(col, dir) {
    var keyFn = {
      name: function(id) { return items[id].n.toLowerCase(); },
      type: function(id) { return items[id].t; },
      ext:  function(id) { return items[id].e || ''; },
      size: function(id) { return parseSizeNum(items[id].s); },
      count: function(id) { return items[id].c || 0; },
      mtime: function(id) { return items[id].m; },
      path: function(id) { return items[id].cp.toLowerCase(); }
    }[col];
    if (!keyFn) return;
    // Schwartzian transform: id 毎にキーを一度だけ計算
    var keyed = new Array(displayedIds.length);
    for (var ki = 0; ki < displayedIds.length; ki++) {
      keyed[ki] = [keyFn(displayedIds[ki]), displayedIds[ki]];
    }
    keyed.sort(function(a, b) {
      if (a[0] < b[0]) return -dir;
      if (a[0] > b[0]) return dir;
      return 0;
    });
    for (var i = 0; i < keyed.length; i++) displayedIds[i] = keyed[i][1];
  }

  function sortTable(col, dir) {
    sortDisplayedIds(col, dir);
    if (vtInitialized) {
      vtScrollContainer.scrollTop = 0;
      vt_resetWindow();
      vt_render();
    }
  }

  if (errors.length > 0) {
    var banner = document.getElementById('errorBanner');
    document.getElementById('errorBannerCount').textContent = errors.length;
    banner.classList.add('show');
    // 詳細はモーダルで表示 (画面下部の常駐セクションは廃止)
    document.getElementById('errorBannerLink').addEventListener('click', function() {
      var sorted = sortByPathInsensitive(errors);
      var lis = sorted.map(function(e) {
        return '<li><code>' + escapeHtml(e.path) + '</code>' +
               '<div class="err-msg">' + escapeHtml(e.error) + '</div></li>';
      }).join('');
      showListModal('アクセスできなかった項目 (' + errors.length + ')', lis);
    });
  }

  if (items.length > 20000) {
    document.getElementById('perfCount').textContent = items.length.toLocaleString();
    document.getElementById('perfWarn').style.display = 'block';
  }

  buildTree();
  // 初期表示: フィルタ未適用状態で「全 N 件 / フォルダ X / ファイル Y」を出す
  renderFilterCount(false, 0, 0, 0);
  // テーブルは初期表示時に構築せず、初めてテーブルビューに切り替えたとき、
  // または CSV エクスポート時にチャンク描画で実体化する。
  // 22万件規模でも初期描画でブラウザがブロックしない設計。

  // ext / type はドロップダウン (操作 1 回 = 1 イベント) なので即時適用 OK。
  ['extFilter', 'typeFilter'].forEach(function(id) {
    document.getElementById(id).addEventListener('input', scheduleFilter);
  });

  // 検索ボックスは大量データで重いため、リアルタイム適用をやめ明示トリガー方式に。
  // - 検索ボタンクリックで applyFilter
  // - Enter キーで applyFilter
  // - 内蔵の × クリアボタンも 'search' イベントで applyFilter
  var searchInput = document.getElementById('search');
  document.getElementById('searchBtn').addEventListener('click', applyFilter);
  searchInput.addEventListener('search', applyFilter);
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyFilter();
    }
  });

  // 「不可も表示」「除外も表示」は body の class を toggle するだけ (CSS で表示制御)。
  // JS の反復処理が無いため、何万件あっても瞬時。
  function applyHideErroredClass() {
    var hide = !document.getElementById('showErrored').checked;
    document.body.classList.toggle('hide-errored', hide);
  }
  function applyHideExcludedClass() {
    var hide = !document.getElementById('showExcluded').checked;
    document.body.classList.toggle('hide-excluded', hide);
  }
  document.getElementById('showErrored').addEventListener('change', function() {
    applyHideErroredClass();
    syncHash();
  });
  document.getElementById('showExcluded').addEventListener('change', function() {
    applyHideExcludedClass();
    syncHash();
  });

  document.getElementById('tableBody').addEventListener('click', function(e) {
    if (e.target.closest('button')) return;
    if (window.getSelection && window.getSelection().toString()) return;
    var tr = e.target.closest('tr');
    if (!tr || !tr.dataset.id) return;
    var it = items[+tr.dataset.id];
    if (it) showDetail(it);
  });

  // 行ホバー時に操作ボタン群を遅延生成。pointerover は delegate しやすく、
  // 80k 行 × 3 ボタンを初期に作らずに済む (実際に hover した行だけ生成)。
  document.getElementById('tableBody').addEventListener('pointerover', function(e) {
    var tr = e.target.closest('tr');
    if (tr && tr.dataset.id) ensureRowActions(tr);
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
    // 仮想スクロールでは displayedIds[] が現在のフィルタ・ソート結果を保持しているので
    // tableRows[] や DOM を参照せず、id 配列を直接走査する。
    var headers = ['名前', '種別', '拡張子', 'サイズ', 'アイテム数', '更新日時',
                   'パス', '親フォルダパス', 'リンク先', 'エラー'];
    var lines = [headers.map(csvEscape).join(',')];
    for (var i = 0; i < displayedIds.length; i++) {
      var it = items[displayedIds[i]];
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
    if (s.excluded === '1') document.getElementById('showExcluded').checked = true;
    if (s.view === 'table' || s.view === 'tree') {
      var btn = document.querySelector('.view-toggle button[data-view="' + s.view + '"]');
      if (btn) btn.click();   // table の場合は内部で ensureTableBuilt() が呼ばれる
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
    // hideErrored / hideExcluded は body の class なので checkbox の状態を CSS に反映
    applyHideErroredClass();
    applyHideExcludedClass();
    // 検索 / 拡張子 / 種別フィルタが含まれていれば applyFilter (重い処理)
    if (s.search || s.ext || s.type) applyFilter();
  }

  function syncHash() {
    if (syncing) return;
    var parts = [];
    var s = document.getElementById('search').value;
    var e = document.getElementById('extFilter').value;
    var t = document.getElementById('typeFilter').value;
    var showErr = document.getElementById('showErrored').checked;
    var showEx = document.getElementById('showExcluded').checked;
    var v = document.querySelector('.view-toggle button.active');
    if (s) parts.push('search=' + encodeURIComponent(s));
    if (e) parts.push('ext=' + encodeURIComponent(e));
    if (t) parts.push('type=' + encodeURIComponent(t));
    if (showErr) parts.push('errors=1');
    if (showEx) parts.push('excluded=1');
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

  // 初期表示: アクセス不可・除外フォルダは body の class でまとめて隠す (CSS 一発)
  applyHideErroredClass();
  applyHideExcludedClass();

  // URL ハッシュがあれば状態復元 (filter / view / cols 等)
  if (location.hash) applyHashState();
})();
