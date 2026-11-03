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

  var IMAGE_RE = /image\/(jpeg|jpg|pjpeg|png|tiff)/i;
  var IMAGE_EXT = /\.(jpe?g|png|tiff?)$/i;
  var SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
  /** Image by MIME type OR by extension: Drive sometimes stores camera JPEGs
   * as application/octet-stream or with odd casing ("image/JPEG"). */
  function isImage(f) { return IMAGE_RE.test(f.mimeType || '') || IMAGE_EXT.test(f.name || ''); }

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
          // Shared drives: a separate tab + the SUPPORT_DRIVES feature, or
          // folders in an organisation drive cannot be picked at all
          .addView(new google.picker.DocsView(google.picker.ViewId.DOCS)
            .setEnableDrives(true)
            .setIncludeFolders(true)
            .setSelectFolderEnabled(true))
          .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
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

  var FOLDER_MIME = 'application/vnd.google-apps.folder';
  var MAX_DEPTH = 4; // locality / site / strata / … is plenty

  /**
   * List all files under a Drive folder, descending into subfolders.
   * P2P data is usually organised locality/site/strata/, so a non-recursive
   * listing of a locality or site folder found 0 images (which then crashed
   * ingestFolder, see below). Each file gets `path` = "sub/dir/name".
   */
  function listFolder(folderId, prefix, depth) {
    prefix = prefix || '';
    depth = depth || 0;
    return listChildren(folderId).then(function (children) {
      var files = [], subs = [];
      children.forEach(function (f) {
        // follow Drive shortcuts to their target (folder or file)
        if (f.mimeType === SHORTCUT_MIME && f.shortcutDetails) {
          f = { id: f.shortcutDetails.targetId, name: f.name,
                mimeType: f.shortcutDetails.targetMimeType };
        }
        if (f.mimeType === FOLDER_MIME) subs.push(f);
        else { f.path = prefix + f.name; files.push(f); }
      });
      if (depth >= MAX_DEPTH || !subs.length) return files;
      // sequential: keeps request rate polite and order deterministic
      return subs.reduce(function (p, s) {
        return p.then(function () {
          return listFolder(s.id, prefix + s.name + '/', depth + 1).then(function (sub) {
            files = files.concat(sub);
          });
        });
      }, Promise.resolve()).then(function () { return files; });
    });
  }

  /** List the direct children of one Drive folder, paginated. */
  function listChildren(folderId) {
    var files = [], pageToken = '';
    function onePage(q) {
      var u = new URL('https://www.googleapis.com/drive/v3/files');
      u.searchParams.set('q', "'" + folderId + "' in parents and trashed = false");
      u.searchParams.set('fields', 'nextPageToken, files(id,name,mimeType,size,shortcutDetails)');
      // Without these two flags files.list returns NOTHING for folders that
      // live in a Shared drive (e.g. an organisation's MBON drive).
      u.searchParams.set('supportsAllDrives', 'true');
      u.searchParams.set('includeItemsFromAllDrives', 'true');
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
    return gfetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&supportsAllDrives=true')
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
        var images = files.filter(isImage);
        var csvs = files.filter(function (f) { return /csv|text\/plain/.test(f.mimeType) || /\.csv$/i.test(f.name); });
        cbProgress && cbProgress('Found ' + images.length + ' images, ' + csvs.length + ' CSV(s)');
        return Promise.all(csvs.map(function (c) {
          return downloadText(c.id).then(function (t) {
            var p = root.QDMeta.parseCSV(t);
            p.name = c.name;
            return p;
          }).catch(function () { return null; });
        })).then(function (csvData) {
          return { images: images, csvs: csvData, all: files };
        });
      })
      .then(function (dec) {
        if (!dec.images.length) {
          // say what WAS there, so the next report is diagnosable
          var types = {};
          var files = dec.all || [];
          files.forEach(function (f) { types[f.mimeType] = (types[f.mimeType] || 0) + 1; });
          var summary = Object.keys(types).map(function (t) { return types[t] + ' × ' + t; }).join('\n');
          throw new Error('No JPEG/PNG/TIFF images found in this Drive folder (subfolders included).\n\n'
            + (files.length ? 'Found ' + files.length + ' other file(s):\n' + summary
                            : 'The folder listing came back empty — check that this account can open the folder.'));
        }
        var done = 0, out = [], failed = [];
        // Always return a Promise: the old version returned the plain `out`
        // array when there was nothing (left) to download, so
        // `next(0).then(...)` threw "next(...).then is not a function" on any
        // folder without images directly inside it (e.g. only subfolders).
        function next(i) {
          if (i >= dec.images.length) return Promise.resolve(out);
          var f = dec.images[i];
          return downloadFile(f.id).then(function (blob) {
            out.push({ blob: blob, name: f.name, path: f.path, driveId: f.id, mimeType: f.mimeType });
          }, function (err) {
            // one bad file must not discard everything already downloaded
            failed.push(f.path || f.name);
            console.warn('Drive download failed', f.name, err);
          }).then(function () {
            done++;
            cbProgress && cbProgress('Downloading ' + done + '/' + dec.images.length);
            return next(i + 1);
          });
        }
        return next(0).then(function () {
          return { items: out, csvs: dec.csvs, failed: failed };
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
