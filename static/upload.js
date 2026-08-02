// upload.js — chunked file upload manager for webtermd
(function () {

    function createUploadManager(opts) {
        var uploadsList = opts.uploadsList;
        var emptyHint = opts.emptyHint;
        var dropZone = opts.dropZone;
        var CHUNK_SIZE = opts.chunkSize || (1 << 20);
        var basePath = opts.basePath;
        var getAuth = opts.getAuth;
        var getFocusedPane = opts.getFocusedPane;
        var cwdPath = opts.cwdPath;
        var showError = opts.showError;
        var onHistoryChanged = opts.onHistoryChanged;

        // --- internal state ---
        var wsCmd = null;
        var uploadToken = '';
        var uploadPrefix = '';
        var uploads = {};        // id -> { el, filename, received, total, file, xhr, offset, paused }
        var pendingUploads = {};  // filename -> File object (waiting for upload-init ack)
        var MAX_HISTORY = 99;
        var ctxMenu = null;

        // --- localStorage history (reads/writes entry.uploads via shared helpers) ---
        function getHistory() {
            var entry = opts.getPathEntry();
            return (entry && entry.uploads) ? entry.uploads : [];
        }

        function setHistory(history) {
            var entry = opts.getPathEntry() || {};
            entry.uploads = history;
            opts.savePathEntry(entry);
        }

        function deleteHistory(id) {
            var history = getHistory();
            history = history.filter(function (h) { return h.id !== id; });
            setHistory(history);
        }

        function clearHistoryStore() {
            var entry = opts.getPathEntry();
            if (entry) {
                delete entry.uploads;
                opts.savePathEntry(entry);
                // Clean up empty entries
                if (Object.keys(entry).length === 0) {
                    try {
                        var raw = localStorage.getItem('webtermd');
                        if (raw) {
                            var map = JSON.parse(raw);
                            delete map[opts.basePath || basePath];
                            if (Object.keys(map).length === 0) {
                                localStorage.removeItem('webtermd');
                            } else {
                                localStorage.setItem('webtermd', JSON.stringify(map));
                            }
                        }
                    } catch (e) { }
                }
            }
        }

        // --- context menu (shared with file-list for showFileContextMenu) ---
        function ensureCtxMenu() {
            if (ctxMenu) return;
            ctxMenu = document.createElement('div');
            ctxMenu.id = 'upload-ctx-menu';
            ctxMenu.style.display = 'none';
            document.body.appendChild(ctxMenu);
            document.addEventListener('click', function () {
                if (ctxMenu) ctxMenu.style.display = 'none';
                var hl = document.querySelector('.ctx-highlight');
                if (hl) hl.classList.remove('ctx-highlight');
            });
        }

        function showUploadContextMenu(x, y, id, filename, path) {
            ensureCtxMenu();
            ctxMenu.style.display = 'block';
            ctxMenu.style.left = x + 'px';
            ctxMenu.style.top = y + 'px';
            ctxMenu.innerHTML =
                '<div class="ctx-item" data-action="remove">Remove from history</div>' +
                (path ? '<div class="ctx-item ctx-danger" data-action="delete">Delete file</div>' : '');

            var items = ctxMenu.querySelectorAll('.ctx-item');
            for (var i = 0; i < items.length; i++) {
                items[i].onclick = function () {
                    var action = this.getAttribute('data-action');
                    ctxMenu.style.display = 'none';
                    if (action === 'remove') {
                        removeUploadFromUI(id);
                    } else if (action === 'delete' && wsCmd && wsCmd.readyState === WebSocket.OPEN) {
                        wsCmd.send(JSON.stringify({ type: 'delete-file', path: path }));
                        removeUploadFromUI(id);
                    }
                };
            }
        }

        function removeUploadFromUI(id) {
            deleteHistory(id);
            var u = uploads[id];
            if (u && u.el && u.el.parentNode) {
                u.el.parentNode.removeChild(u.el);
            }
            delete uploads[id];
            showEmptyHint();
        }

        // --- upload progress UI ---
        function hideEmptyHint() {
            if (emptyHint) { emptyHint.style.display = 'none'; }
        }

        function showEmptyHint() {
            var hasItems = uploadsList.querySelector('.item');
            if (emptyHint) { emptyHint.style.display = hasItems ? 'none' : ''; }
        }

        function getUploadEl(id) {
            if (!uploads[id]) {
                var el = document.createElement('div');
                el.className = 'item';
                el.innerHTML = '<span class="name"></span>' +
                    '<div class="bar"><div class="bar-fill"></div></div>' +
                    '<span class="status-text"></span>' +
                    '<div class="actions">' +
                    '<button class="btn-pause">⏸ Pause</button>' +
                    '<button class="btn-cancel">✕ Cancel</button>' +
                    '</div>';
                uploadsList.appendChild(el);

                uploads[id] = { el: el, offset: 0, paused: false };

                el.querySelector('.btn-pause').addEventListener('click', function () {
                    togglePause(id);
                });
                el.querySelector('.btn-cancel').addEventListener('click', function () {
                    cancelUpload(id);
                });

                hideEmptyHint();
            }
            return uploads[id];
        }

        function updateUpload(id, filename, received, total, done, error) {
            var u = getUploadEl(id);
            u.filename = filename;
            u.received = received;
            u.total = total;
            var pct = total > 0 ? Math.round(received / total * 100) : 0;
            u.el.querySelector('.name').textContent = filename;
            u.el.querySelector('.bar-fill').style.width = pct + '%';

            var statusEl = u.el.querySelector('.status-text');
            var pauseBtn = u.el.querySelector('.btn-pause');

            if (done) {
                u.el.classList.add('done');
                u.el.classList.remove('error', 'paused');
                statusEl.textContent = 'Done — ' + WebtermdUtils.formatSize(received);
                u.el.querySelector('.actions').innerHTML = '';
                u.el.addEventListener('contextmenu', function (e) {
                    e.preventDefault();
                    showUploadContextMenu(e.clientX, e.clientY, id, u.filename, u.path);
                });
                saveHistory({
                    id: id,
                    filename: u.filename,
                    size: u.total,
                    time: new Date().toLocaleString(),
                    path: u.path
                });
            } else if (error) {
                u.el.classList.add('error');
                u.el.classList.remove('done', 'paused');
                statusEl.textContent = 'Failed — will retry';
                if (pauseBtn) pauseBtn.textContent = '▶ Resume';
            } else if (u.paused) {
                u.el.classList.add('paused');
                u.el.classList.remove('done', 'error');
                statusEl.textContent = 'Paused — ' + WebtermdUtils.formatSize(received) + ' / ' + WebtermdUtils.formatSize(total);
                if (pauseBtn) pauseBtn.textContent = '▶ Resume';
            } else {
                u.el.classList.remove('done', 'error', 'paused');
                statusEl.textContent = WebtermdUtils.formatSize(received) + ' / ' + WebtermdUtils.formatSize(total);
                if (pauseBtn) pauseBtn.textContent = '⏸ Pause';
            }
        }

        function togglePause(id) {
            var u = uploads[id];
            if (!u || !u.file) return;
            u.paused = !u.paused;
            if (u.paused) {
                if (u.xhr) { u.xhr.abort(); u.xhr = null; }
                updateUpload(id, u.filename, u.received, u.total);
            } else {
                updateUpload(id, u.filename, u.received, u.total);
                sendChunk(id);
            }
        }

        function cancelUpload(id) {
            var u = uploads[id];
            if (!u) return;
            if (u.xhr) { u.xhr.abort(); u.xhr = null; }
            if (wsCmd && wsCmd.readyState === WebSocket.OPEN) {
                wsCmd.send(JSON.stringify({ type: 'upload-cancel', id: id }));
            }
            try { localStorage.removeItem('ax-upload-' + id); } catch (e) { }
            if (u.el && u.el.parentNode) u.el.parentNode.removeChild(u.el);
            delete uploads[id];
            showEmptyHint();
        }

        // --- upload history ---
        function loadHistory() {
            var history = getHistory();
            for (var i = 0; i < history.length; i++) {
                renderHistoryItem(history[i]);
            }
        }

        function saveHistory(entry) {
            var history = getHistory();
            history.unshift(entry);
            if (history.length > MAX_HISTORY) {
                history = history.slice(0, MAX_HISTORY);
            }
            setHistory(history);
        }

        function renderHistoryItem(entry) {
            if (uploads[entry.id]) return; // skip if already rendered
            hideEmptyHint();
            var el = document.createElement('div');
            el.className = 'item history';
            el.innerHTML =
                '<span class="name">' + WebtermdUtils.escapeHtml(entry.filename) + '</span>' +
                '<div class="bar"><div class="bar-fill"></div></div>' +
                '<span class="status-text">' + WebtermdUtils.formatSize(entry.size) + ' — ' + entry.time + '</span>' +
                '<div class="actions"></div>';
            uploadsList.appendChild(el);

            var u = { el: el, filename: entry.filename, received: entry.size, total: entry.size, path: entry.path };
            uploads[entry.id] = u;

            el.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                showUploadContextMenu(e.clientX, e.clientY, entry.id, entry.filename, entry.path);
            });
        }

        // --- chunk upload engine ---
        function sendChunk(id) {
            var u = uploads[id];
            if (!u || u.paused) return;
            if (u.offset >= u.total) {
                if (wsCmd && wsCmd.readyState === WebSocket.OPEN) {
                    wsCmd.send(JSON.stringify({ type: 'upload-commit', id: id }));
                }
                return;
            }

            var end = Math.min(u.offset + CHUNK_SIZE, u.total);
            var blob = u.file.slice(u.offset, end);

            var xhr = new XMLHttpRequest();
            u.xhr = xhr;
            var url = uploadPrefix + id + '?utoken=' + encodeURIComponent(uploadToken) + '&offset=' + u.offset;
            xhr.open('POST', url);
            xhr.onload = function () {
                if (!uploads[id]) return;
                if (xhr.status >= 200 && xhr.status < 300) {
                    var resp = JSON.parse(xhr.responseText);
                    u.offset += resp.bytes_written;
                    u.xhr = null;
                    updateUpload(id, u.filename, resp.received, resp.total);
                    sendChunk(id);
                } else {
                    u.paused = true;
                    u.xhr = null;
                    updateUpload(id, u.filename, u.offset, u.total, false, true);
                    showError('Upload chunk failed: ' + xhr.status);
                }
            };
            xhr.onerror = function () {
                if (!uploads[id]) return;
                u.paused = true;
                u.xhr = null;
                updateUpload(id, u.filename, u.offset, u.total, false, true);
                showError('Upload interrupted — will resume on reconnect');
                try {
                    localStorage.setItem('ax-upload-' + id, JSON.stringify({
                        filename: u.filename, size: u.total, offset: u.offset
                    }));
                } catch (e) { }
            };
            xhr.ontimeout = function () {
                if (!uploads[id]) return;
                u.paused = true;
                u.xhr = null;
            };
            xhr.timeout = 30000;
            xhr.send(blob);
        }

        function startChunkedUpload(id, file) {
            var u = uploads[id];
            u.file = file;
            u.total = file.size;
            u.offset = 0;
            u.paused = false;
            sendChunk(id);
        }

        // --- drag and drop ---
        dropZone.addEventListener('dragover', function (e) {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('drag-over');
        });
        dropZone.addEventListener('dragleave', function (e) {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');
        });
        dropZone.addEventListener('drop', function (e) {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');
            var files = e.dataTransfer.files;
            for (var i = 0; i < files.length; i++) {
                uploadFile(files[i]);
            }
        });
        dropZone.addEventListener('click', function () {
            var input = document.createElement('input');
            input.type = 'file';
            input.onchange = function () {
                for (var i = 0; i < input.files.length; i++) {
                    uploadFile(input.files[i]);
                }
            };
            input.click();
        });

        function uploadFile(file) {
            if (!wsCmd || wsCmd.readyState !== WebSocket.OPEN) {
                showError('Command channel not connected');
                return;
            }
            pendingUploads[file.name] = file;
            var fp = getFocusedPane();
            var dir = fp && fp.cwd ? fp.cwd : (cwdPath.textContent !== '-' ? cwdPath.textContent : '/tmp');
            wsCmd.send(JSON.stringify({
                type: 'upload-init',
                filename: file.name,
                size: file.size,
                dir: dir
            }));
        }

        // --- public API ---
        return {
            // Called by connectCmd when wsCmd is established/reconnected.
            setWsCmd: function (cmd) { wsCmd = cmd; },

            // Called by connectCmd to set upload session info.
            setSession: function (token, prefix) {
                uploadToken = token;
                uploadPrefix = basePath + prefix;
            },

            // Called by connectCmd to restore pending uploads and load history.
            initFromCmd: function () {
                loadHistory();
                for (var i = 0; i < localStorage.length; i++) {
                    var key = localStorage.key(i);
                    if (key.indexOf('ax-upload-') === 0) {
                        try {
                            var info = JSON.parse(localStorage.getItem(key));
                            if (wsCmd && wsCmd.readyState === WebSocket.OPEN) {
                                wsCmd.send(JSON.stringify({ type: 'upload-status', id: info.id }));
                            }
                        } catch (e) { }
                    }
                }
            },

            // Called by connectCmd to dispatch upload-* messages.
            handleCmdMessage: function (msg) {
                switch (msg.type) {
                    case 'upload-init':
                        var f = pendingUploads[msg.filename];
                        var total = f ? f.size : 0;
                        updateUpload(msg.id, msg.filename || '', 0, total);
                        var u = uploads[msg.id];
                        if (u) u.dir = msg.dir;
                        if (f) {
                            delete pendingUploads[msg.filename];
                            startChunkedUpload(msg.id, f);
                        }
                        break;

                    case 'upload-error':
                        showError('Upload: ' + msg.message);
                        break;

                    case 'upload-done':
                        var du = uploads[msg.id];
                        var dtotal = du ? du.total : 0;
                        if (du) du.path = msg.path;
                        updateUpload(msg.id, msg.filename, dtotal, dtotal, true);
                        try { localStorage.removeItem('ax-upload-' + msg.id); } catch (e) { }
                        break;

                    case 'upload-status':
                        if (msg.exists) {
                            updateUpload(msg.id, msg.filename, msg.received, msg.total);
                        } else {
                            try { localStorage.removeItem('ax-upload-' + msg.id); } catch (e) { }
                        }
                        break;
                }
            },

            // Called by the clear-uploads button.
            clearHistory: function () {
                clearHistoryStore();
                var items = uploadsList.querySelectorAll('.history');
                for (var i = 0; i < items.length; i++) {
                    items[i].parentNode.removeChild(items[i]);
                }
                for (var id in uploads) {
                    var u = uploads[id];
                    if (u.el && u.el.classList.contains('done')) {
                        if (u.el.parentNode) u.el.parentNode.removeChild(u.el);
                        delete uploads[id];
                    }
                }
                showEmptyHint();
                if (onHistoryChanged) onHistoryChanged();
            },

            // Called by the file list to show "in-upload" badges.
            getUploadListPaths: function () {
                var paths = {};
                for (var id in uploads) {
                    var u = uploads[id];
                    if (u.el && (u.el.classList.contains('done') || u.el.classList.contains('history'))) continue;
                    if (u.filename && u.dir) {
                        paths[u.dir.replace(/\/$/, '') + '/' + u.filename] = true;
                    }
                }
                try {
                    var history = getHistory();
                    for (var i = 0; i < history.length; i++) {
                        if (history[i].path) paths[history[i].path] = true;
                    }
                } catch (e) { }
                return paths;
            },

            // Shared context menu element for showFileContextMenu in app.js.
            getCtxMenu: function () {
                ensureCtxMenu();
                return ctxMenu;
            }
        };
    }

    window.WebtermdUpload = { create: createUploadManager };
})();
