/**
 * grid.js — thumbnail grid rendering + confidence highlighting.
 */
(function (root) {
  'use strict';

  var hooks = { onThumb: null };

  function init(h) { hooks = Object.assign(hooks, h); }

  /** Tier (color class) for an item. */
  function tierOf(item) {
    if (item.excluded) return 'excluded';
    if (item.status === 'processing') return 'processing';
    if (item.status === 'failed') return 'failed';
    // hand-cropped in the editor → its own (blue) tier, not the red "manual"
    // one, which means "still needs manual corners"
    if (item.source === 'manual' && item.cropBlob) return 'adjusted';
    if (item.cornerOverride && item.source !== 'auto') return 'manual';
    if (item.source === 'manual') return 'manual';
    if (!item.ok) return 'failed';
    var c = item.conf;
    if (c >= 0.8) return 'ok';
    if (c >= 0.55) return 'review';
    return 'manual';
  }

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function render(item) {
    var card = el('article', 'card');
    card.dataset.tier = tierOf(item);
    card.dataset.id = item.id;

    // exclude / include toggle: excluded photos never go into the zip
    // (they stay listed in manifest.csv as "excluded") — click again to undo
    if (item.status !== 'queued' && item.status !== 'processing') {
      var xb = el('button', 'excl');
      xb.type = 'button';
      xb.textContent = item.excluded ? '↺' : '✕';
      xb.title = item.excluded ? 'Include this photo again' : 'Exclude this photo from the ZIP';
      xb.setAttribute('aria-label', xb.title);
      xb.addEventListener('click', function (e) {
        e.stopPropagation();
        hooks.onExclude && hooks.onExclude(item);
      });
      card.appendChild(xb);
    }

    var tw = el('div', 'thumb-wrap');
    if (item.thumbURL) {
      var img = el('img', 'thumb');
      img.src = item.thumbURL;
      img.alt = (item.ok ? 'crop ' : 'source ') + item.name;
      tw.appendChild(img);
    } else {
      tw.appendChild(el('div', 'thumb placeholder'));
    }
    tw.title = item.ok ? 'Click to view the full photo with corners / edit'
      : item.status === 'failed' ? 'No frame found — click to fix corners manually'
      : 'Click to inspect / edit corners';
    tw.addEventListener('click', function () { hooks.onThumb && hooks.onThumb(item); });
    card.appendChild(tw);

    if (item.excluded) {
      var bx = el('div', 'badge excluded');
      bx.textContent = 'excluded';
      card.appendChild(bx);
    } else if (item.ok) {
      var t = tierOf(item);
      var badge = el('div', 'badge' + (t === 'adjusted' ? ' adjusted' : t === 'manual' ? ' manual' : ''));
      badge.textContent = item.cornerOverride || item.source === 'manual'
        ? 'manual'
        : Math.round(item.conf * 100) + '%';
      card.appendChild(badge);
    } else if (item.status !== 'processing') {
      var b2 = el('div', 'badge manual');
      b2.textContent = item.status === 'failed' ? 'no frame' : '…';
      card.appendChild(b2);
    }

    var meta = el('div', 'meta');
    var name = el('span', 'name');
    name.textContent = item.name;
    name.title = item.name;
    meta.appendChild(name);
    var st = el('span', 'mini');
    st.textContent = item.status === 'processing' ? '…'
      : item.cropBlob ? humanSize(item.cropBlob.size) : '';
    meta.appendChild(st);
    card.appendChild(meta);

    var warn = item.flags && item.flags.length ? item.flags[0]
      : item.status === 'failed' && item.reason ? item.reason : null;
    if (warn) {
      var fx = el('div', 'flags');
      fx.textContent = '⚠ ' + warn;
      fx.title = item.flags && item.flags.length ? item.flags.join('\n') : item.reason;
      card.appendChild(fx);
    }
    return card;
  }

  function humanSize(n) {
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n > 1024) return Math.round(n / 1024) + ' kB';
    return n + ' B';
  }

  function updateCard(item) {
    var old = document.querySelector('.card[data-id="' + CSS.escape(item.id) + '"]');
    if (!old) return;
    old.replaceWith(render(item));
  }

  function updateStats(items) {
    // `adjusted` = crops the user already fixed by hand. They share the
    // 'manual' colour tier with low-confidence detections, but they must not
    // be counted under "need manual corners" — that count would never go
    // down as the user works through the batch.
    var n = { total: items.length, auto: 0, review: 0, manual: 0, failed: 0, adjusted: 0, excluded: 0 };
    items.forEach(function (it) {
      if (it.excluded) { n.excluded++; return; }
      if (it.source === 'manual' && it.cropBlob) { n.adjusted++; return; }
      var t = tierOf(it);
      if (t === 'ok') n.auto++;
      else if (t === 'review' || t === 'manual') n[t === 'review' ? 'review' : 'manual']++;
      else if (t === 'failed') n.failed++;
    });
    return n;
  }

  root.QDGrid = { init: init, render: render, updateCard: updateCard, tierOf: tierOf, updateStats: updateStats };
})(typeof self !== 'undefined' ? self : this);
