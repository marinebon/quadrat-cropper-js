/**
 * grid.js — thumbnail grid rendering + confidence highlighting.
 */
(function (root) {
  'use strict';

  var hooks = { onThumb: null };

  function init(h) { hooks = Object.assign(hooks, h); }

  /** Tier (color class) for an item. */
  function tierOf(item) {
    if (item.status === 'processing') return 'processing';
    if (item.status === 'failed') return 'failed';
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

    if (item.ok) {
      var badge = el('div', 'badge' + (tierOf(item) === 'manual' ? ' manual' : ''));
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
    var n = { total: items.length, auto: 0, review: 0, manual: 0, failed: 0 };
    items.forEach(function (it) {
      var t = tierOf(it);
      if (t === 'ok') n.auto++;
      else if (t === 'review' || t === 'manual') n[t === 'review' ? 'review' : 'manual']++;
      else if (t === 'failed') n.failed++;
    });
    return n;
  }

  root.QDGrid = { init: init, render: render, updateCard: updateCard, tierOf: tierOf, updateStats: updateStats };
})(typeof self !== 'undefined' ? self : this);
