/**
 * drive.js — Google Drive integration (OAuth via Google Identity Services
 * + Picker + Drive v3 REST). No API key required when using OAuth tokens.
 *
 * Usage:
 *   QDDrive.configure()            // reads saved client id (localStorage)
 *   QDDrive.pickFolder()           // -> [{ id, name, mimeType, size }, ...] image files
 *   QDDrive.addFolderLink(url)     // list files of a folder id extracted from a link
 *   QDDrive.downloadFile(id)       // -> Blob
 */
(function (root) {
  'use strict';

  var SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
  var LS_CLIENTID = 'quadrat.clientId';
  var LS_APIKEY = 'quadrat.apiKey';

  var tokenInfo = { token: null, expiresAt: 0, pickerReady: false };
  window.__qd_token = null;

  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[src="' + src + '"]')) return res();
      var s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  function getClientId() { return localStorage.getItem(LS_CLIENTID) || ''; }
  function getApiKey() { return localStorage.getItem(LS_APIKEY) || ''; }
  function setConfig(clientId, apiKey) {
    if (clientId != null) localStorage.setItem(LS_CLIENTID, clientId.trim());
    if (apiKey != null) localStorage.setItem(LS_APIKEY, apiKey.trim());
  }
  function hasConfig() { return !!getClientId(); }

  /** Ensure a fresh OAuth access token (token flow, opens consent if needed). */
  function ensureToken() {
    var clientId = getClientId();
    if (!clientId) {
      return Promise.reject(new Error('No OAuth client id configured. Open ⚙ settings and paste your Google Cloud OAuth Client ID.'));
    }
    return new Promise(function (resolve, reject) {
      function ask() {
        if (!window.google || !google.accounts || !google.accounts.oauth2) {
          reject(new Error('Google Identity Services failed to load (offline? blocked?).'));
          return;
        }
        var tc = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE,
          callback: function (resp) {
            if (resp && resp.access_token) {
              tokenInfo.token = resp.access_token;
              tokenInfo.expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 900;
              window.__qd_token = resp.access_token;
              resolve(resp.access_token);
            } else {
              reject(new Error('OAuth token request rejected'));
            }
          },
          error_callback: function (err) { reject(new Error(err && err.message || 'OAuth error')); }
        });
        tc.requestAccessToken();
      }
      if (tokenInfo.token && Date.now() < tokenInfo.expiresAt) { resolve(tokenInfo.token); return; }
      loadScript('https://accounts.google.com/gsi/client').then(ask, reject);
    });
  }

  /** Load the Picker API (after we hold a token). */
  function loadPicker() {
    if (tokenInfo.pickerReady) return Promise.resolve();
    return loadScript('https://apis.google.com/js/api.js').then(function () {
      return new Promise(function (res) { gapi.load('picker', res); });
    });
  }

  var IMAGE_RE = /image\/(jpeg|jpg|png|tiff)/;

  /** Open the Google Drive Picker; resolve with information about what was picked. */
  function pickFolder() {
    return ensureToken().then(loadPicker).then(function () {
      return new Promise(function (resolve, reject) {
        var apiKey = getApiKey() || undefined;
        var b = new google.picker.PickerBuilder()
          .addView(new google.picker.DocsView(google.picker.ViewId.DOCS)
            .setIncludeFolders(true)
            .setSelectFolderEnabled(true)
            .setMimeTypes('image/jpeg,image/png,image/tiff'))
          .addView(google.picker.ViewId.DOCS)
          .setOAuthToken(tokenInfo.token)
          .setCallback(function (data) {
            if (data.action === google.picker.Action.CANCELLED) { resolve(null); return; }
            if (data.action !== google.picker.Action.PICKED) return;
            if (!apiKey) {
              // token-only flow: pick what was chosen and handle per type
              var pick = data.docs && data.docs[0];
              resolve({ picked: pick || null });
              return;
            }
            resolve({ picked: data.docs && data.docs[0] || null });
          });
        if (apiKey) b.setDeveloperKey(apiKey);
        var picker = b.build();
        picker.setVisible(true);
      });
    });
  }

  function gfetch(url, opts) {
    return ensureToken().then(function (t) {
      return fetch(url, Object.assign({
        headers: { Authorization: 'Bearer ' + t }
      }, opts || {}));
    });
  }

  /** List all files of a Drive folder (images + csv), paginated. */
  function listFolder(folderId) {
    var files = [], pageToken = '';
    function onePage(q) {
      var u = new URL('https://www.googleapis.com/drive/v3/files');
      u.searchParams.set('q', "'" + folderId + "' in parents and trashed = false");
      u.searchParams.set('fields', 'nextPageToken, files(id,name,mimeType,size)');
      u.searchParams.set('pageSize', '1000');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      return gfetch(u).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error('Drive list failed: ' + r.status + ' ' + t.slice(0, 200)); });
        return r.json();
      });
    }
    return onePage().then(function next(j) {
      (j.files || []).forEach(function (f) { files.push(f); });
      if (j.nextPageToken) { pageToken = j.nextPageToken; return onePage().then(next); }
      return files;
    });
  }

  /** Download a Drive file as a Blob. */
  function downloadFile(fileId) {
    return gfetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media')
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error('Drive download failed: ' + r.status + ' ' + t.slice(0, 200)); });
        return r.blob();
      });
  }

  /** Download a text file (CSV). */
  function downloadText(fileId) {
    return downloadFile(fileId).then(function (b) { return b.text(); });
  }

  /**
   * Anonymous download of a single publicly-shared file — NO sign-in needed.
   * Primary: Google's image CDN (lh3.googleusercontent.com/d/<id>=s0), which
   * serves the full-resolution image with access-control-allow-origin: *
   * (note: the drive.usercontent.google.com endpoint sends CORS headers too,
   * but 403s any cross-site browser request's Sec-Fetch headers, so it only
   * works server-side; lh3 is the one that works from a web page).
   */
  function downloadPublic(fileId) {
    var urls = [
      'https://lh3.googleusercontent.com/d/' + fileId + '=s0',
      'https://drive.usercontent.google.com/download?id=' + fileId + '&export=download&confirm=t'
    ];
    var i = 0;
  function attempt () {
      return fetch(urls[i]).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (b) {
        // error/consent pages come back as text/html — treat as not public
        if (b.type && /html|text\/plain/.test(b.type)) throw new Error('not-public');
        return b;
      });
    }
    function retry(e) {
      i++;
      if (i >= urls.length) throw e;
      return attempt();
    }
    return attempt().catch(retry);
  }

  /** Extract a Drive folder/file id from a pasted URL. */
  function extractId(url) {
    var m = /folders\/([A-Za-z0-9_-]{10,})/.exec(url) ||
            /\/d\/([A-Za-z0-9_-]{10,})/.exec(url) ||
            /[?&]id=([A-Za-z0-9_-]{10,})/.exec(url);
    return m ? m[1] : null;
  }

  /** Full "ingest folder" helper: lists files, downloads images, parses CSVs. */
  function ingestFolder(folderId, cbProgress) {
    return ensureToken()
      .then(function () { return listFolder(folderId); })
      .then(function (files) {
        var images = files.filter(function (f) { return IMAGE_RE.test(f.mimeType); });
        var csvs = files.filter(function (f) { return /csv|text\/plain/.test(f.mimeType) || /\.csv$/i.test(f.name); });
        cbProgress && cbProgress('Found ' + images.length + ' images, ' + csvs.length + ' CSV(s)');
        return Promise.all(csvs.map(function (c) {
          return downloadText(c.id).then(function (t) {
            var p = root.QDMeta.parseCSV(t);
            p.name = c.name;
            return p;
          }).catch(function () { return null; });
        })).then(function (csvData) {
          return { images: images, csvs: csvData };
        });
      })
      .then(function (dec) {
        var done = 0, out = [];
        function next(i) {
          if (i >= dec.images.length) return out;
          var f = dec.images[i];
          return downloadFile(f.id).then(function (blob) {
            out.push({ blob: blob, name: f.name, driveId: f.id, mimeType: f.mimeType });
            done++;
            cbProgress && cbProgress('Downloading ' + done + '/' + dec.images.length);
            return next(i + 1);
          });
        }
        return next(0).then(function () {
          return { items: out, csvs: dec.csvs };
        });
      });
  }

  root.QDDrive = {
    SCOPE: SCOPE,
    setConfig: setConfig, getClientId: getClientId, getApiKey: getApiKey,
    hasConfig: hasConfig, ensureToken: ensureToken,
    pickFolder: pickFolder, listFolder: listFolder,
    downloadFile: downloadFile, extractId: extractId, ingestFolder: ingestFolder,
    downloadPublic: downloadPublic
  };
})(typeof self !== 'undefined' ? self : this);
