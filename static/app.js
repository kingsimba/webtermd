(function () {
    // --- DOM refs ---
    var status = document.getElementById('status');
    var sidebar = document.getElementById('sidebar');
    var toggleBtn = document.getElementById('toggle-sidebar');
    var cwdPath = document.getElementById('cwd-path');
    var cwdInline = document.getElementById('cwd-inline');
    var terminalContainer = document.getElementById('terminal-container');

    function showError(msg) {
        status.textContent = msg;
        status.style.display = 'block';
        setTimeout(function () { status.style.display = 'none'; }, 5000);
    }

    // --- sidebar toggle ---
    var sidebarVisible = true;
    toggleBtn.addEventListener('click', function () {
        sidebarVisible = !sidebarVisible;
        if (sidebarVisible) {
            sidebar.classList.remove('collapsed');
            refreshFileList();
        } else {
            sidebar.classList.add('collapsed');
        }
        setTimeout(function () { fitFocusedPane(); }, 250);
    });

    var clearUploadsBtn = document.getElementById('clear-uploads');
    if (clearUploadsBtn) {
        clearUploadsBtn.addEventListener('click', function () {
            if (uploadManager) uploadManager.clearHistory();
        });
    }

    // --- global state ---
    var wsCmd = null;
    var uploadManager = null;
    var basePath = location.pathname.replace(/\/[^/]*$/, '');
    var sigNonce = '';

    function getPathEntry() {
        try {
            var raw = localStorage.getItem('webtermd');
            if (raw) {
                var map = JSON.parse(raw);
                return map[basePath] || null;
            }
        } catch (e) { }
        return null;
    }

    function savePathEntry(entry) {
        try {
            var raw = localStorage.getItem('webtermd');
            var map = raw ? JSON.parse(raw) : {};
            map[basePath] = entry;
            localStorage.setItem('webtermd', JSON.stringify(map));
        } catch (e) { }
    }

    function clearPathEntry() {
        try {
            var raw = localStorage.getItem('webtermd');
            if (raw) {
                var map = JSON.parse(raw);
                delete map[basePath];
                if (Object.keys(map).length === 0) {
                    localStorage.removeItem('webtermd');
                } else {
                    localStorage.setItem('webtermd', JSON.stringify(map));
                }
            }
        } catch (e) { }
    }

    function getAuth() {
        var entry = getPathEntry();
        if (entry && entry.nonce && entry.sig) return entry;
        return null;
    }

    function setAuth(nonce, sig) {
        var entry = getPathEntry() || {};
        entry.nonce = nonce;
        entry.sig = sig;
        savePathEntry(entry);
    }

    function clearAuth() {
        var entry = getPathEntry();
        if (entry) {
            delete entry.nonce;
            delete entry.sig;
            if (Object.keys(entry).length === 0) {
                clearPathEntry();
            } else {
                savePathEntry(entry);
            }
        }
    }

    // --- multi-pane state ---
    var layoutTree = null;   // recursive {type:'split'|'pane', ...} tree
    var focusedPaneId = null;
    var panes = {};           // id -> pane runtime object

    // --- pane helpers ---
    function createPaneId() {
        return 'p' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
    }

    function getFocusedPane() {
        return panes[focusedPaneId] || null;
    }

    function getAllPaneIds(node) {
        if (!node) node = layoutTree;
        if (node.type === 'pane') return [node.id];
        var ids = [];
        for (var i = 0; i < node.children.length; i++) {
            ids = ids.concat(getAllPaneIds(node.children[i]));
        }
        return ids;
    }

    function createPane(restoreCwd) {
        var id = createPaneId();
        var pane = {
            id: id,
            term: null,
            fitAddon: null,
            ws: null,
            termDataDisposable: null,
            termResizeDisposable: null,
            cwd: null,
            hostname: null,
            isAtShell: true,
            files: [],
            lastListedCWD: '',
            pendingCwdRestore: restoreCwd || '',
            sigOpenFired: false,
            everConnected: false,
            container: null,
            terminalEl: null
        };
        panes[id] = pane;
        return pane;
    }

    function destroyPane(id) {
        var p = panes[id];
        if (!p) return;
        if (p.ws) {
            try { p.ws.close(); } catch (e) { }
        }
        if (p.term) {
            try { p.term.dispose(); } catch (e) { }
        }
        delete panes[id];
    }

    function fitPane(pane) {
        if (!pane || !pane.fitAddon) return;
        try { pane.fitAddon.fit(); } catch (e) { }
    }

    function fitFocusedPane() {
        fitPane(getFocusedPane());
    }

    window.addEventListener('resize', function () {
        var ids = getAllPaneIds();
        for (var i = 0; i < ids.length; i++) {
            fitPane(panes[ids[i]]);
        }
    });

    // --- init pane terminal + WS ---
    function initPaneTerminal(pane) {
        pane.term = new Terminal({
            cursorBlink: false,
            fontSize: 14,
            fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
            theme: {
                background: '#1e1e1e',
                foreground: '#d4d4d4',
                cursor: '#d4d4d4',
                selectionBackground: '#264f78'
            }
        });

        pane.fitAddon = new FitAddon.FitAddon();
        pane.term.loadAddon(pane.fitAddon);
        pane.term.open(pane.terminalEl);
        WebtermdUtils.installClipboard(pane.term, pane.terminalEl);

        // Fit after a short delay to let the DOM settle.
        setTimeout(function () { fitPane(pane); }, 100);

        // Connect terminal WebSocket.
        connectPaneWS(pane);
    }

    function connectPaneWS(pane) {
        pane.sigOpenFired = false;
        var nonce = sigNonce;
        var stored = getAuth();

        if (!nonce && stored && stored.nonce) nonce = stored.nonce;
        var sig = stored ? stored.sig : '';

        if (!nonce) {
            // Need a fresh challenge first.
            fetch(basePath + '/api/challenge')
                .then(function (r) {
                    if (!r.ok) throw new Error('challenge failed: ' + r.status);
                    return r.json();
                })
                .then(function (data) {
                    sigNonce = data.nonce;
                    openPaneWS(pane, data.nonce, sig);
                })
                .catch(function () {
                    setTimeout(function () { connectPaneWS(pane); }, 3000);
                });
            return;
        }
        openPaneWS(pane, nonce, sig);
    }

    function openPaneWS(pane, nonce, sig) {
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        var url = proto + '//' + location.host + basePath +
            '/ws?nonce=' + encodeURIComponent(nonce) + '&signature=' + encodeURIComponent(sig);
        pane.ws = new WebSocket(url);
        pane.ws.binaryType = 'arraybuffer';

        pane.ws.onopen = function () {
            pane.sigOpenFired = true;
            pane.everConnected = true;

            if (pane.termDataDisposable) pane.termDataDisposable.dispose();
            pane.termDataDisposable = pane.term.onData(function (data) {
                if (pane.ws && pane.ws.readyState === WebSocket.OPEN) {
                    pane.ws.send(data);
                }
            });

            if (pane.termResizeDisposable) pane.termResizeDisposable.dispose();
            pane.termResizeDisposable = pane.term.onResize(function (_a) {
                if (pane.ws && pane.ws.readyState === WebSocket.OPEN) {
                    pane.ws.send(JSON.stringify({ type: 'resize', rows: _a.rows, cols: _a.cols }));
                }
            });

            // Send current terminal size immediately.
            pane.ws.send(JSON.stringify({ type: 'resize', rows: pane.term.rows, cols: pane.term.cols }));

            pane.pendingCwdRestore = pane.cwd || '';

            fitPane(pane);

            // Focus the newly connected pane.
            if (!focusedPaneId || focusedPaneId === pane.id) {
                focusPane(pane.id);
            }
        };

        pane.ws.onmessage = function (ev) { paneWSHandler(pane, ev); };

        pane.ws.onclose = function () {
            if (!pane.everConnected && !pane.sigOpenFired && pane.id === focusedPaneId) {
                // Auth failed — show dialog.
                if (!sig) {
                    showSigDialog();
                    return;
                }
                clearAuth();
                document.getElementById('sig-error').style.display = 'block';
                document.getElementById('sig-error').textContent = 'Authentication failed. Check your signature or refresh the nonce.';
                document.getElementById('sig-overlay').classList.add('open');
                return;
            }
            pane.term.write('\r\n\x1b[31m[disconnected]\x1b[0m\r\n');
            setTimeout(function () { connectPaneWS(pane); }, 2000);
        };

        pane.ws.onerror = function () {
            if (pane.sigOpenFired) {
                showError('WebSocket connection failed');
            }
        };
    }

    // --- per-pane WS message handler ---
    function paneWSHandler(pane, ev) {
        if (typeof ev.data === 'string') {
            try {
                var msg = JSON.parse(ev.data);
                switch (msg.type) {
                    case 'session':
                        if (msg.hostname) {
                            pane.hostname = msg.hostname;
                            document.title = msg.hostname;
                            if (pane.id === focusedPaneId) {
                                updateToolbar();
                            }
                        }
                        break;

                    case 'cwd':
                        var cwdChanged = pane.cwd !== msg.path;
                        pane.cwd = msg.path;
                        if (pane.id === focusedPaneId) {
                            if (cwdChanged) fileFilter.value = '';
                            setCWD(msg.path);
                        }
                        if (pane.pendingCwdRestore && pane.pendingCwdRestore !== '-' &&
                            msg.path !== pane.pendingCwdRestore && pane.ws) {
                            pane.ws.send(JSON.stringify({ type: 'restore-cwd', path: pane.pendingCwdRestore }));
                        }
                        pane.pendingCwdRestore = '';
                        if (pane.id === focusedPaneId) refreshFileList();
                        break;

                    case 'foreground':
                        var shells = ['bash', 'zsh', 'fish', 'sh', 'dash', 'ash'];
                        var newAtShell = shells.indexOf(msg.proc) !== -1;
                        if (newAtShell !== pane.isAtShell) {
                            pane.isAtShell = newAtShell;
                            if (pane.id === focusedPaneId) renderFiltered();
                        }
                        break;

                    case 'file-list':
                        pane.lastListedCWD = msg.dir;
                        pane.files = msg.files || [];
                        if (pane.id === focusedPaneId) {
                            renderFiltered();
                        }
                        break;

                    case 'file-list-error':
                        if (pane.id === focusedPaneId) {
                            fileItems.innerHTML = '<div class="empty-hint" style="color:#d32f2f">' + msg.message + '</div>';
                        }
                        break;

                    case 'download-ready':
                        triggerDownload(basePath + msg.url);
                        break;

                    case 'download-error':
                        showError('Download: ' + msg.message);
                        break;

                }
            } catch (e) { }
        } else {
            // Binary = PTY output.
            pane.term.write(new Uint8Array(ev.data));
        }
    }

    // --- focus management ---
    function focusPane(id) {
        if (focusedPaneId === id) return;

        // Unfocus previous — disable cursor blink.
        var old = panes[focusedPaneId];
        if (old) {
            if (old.container) old.container.classList.remove('focused');
            if (old.term) old.term.options.cursorBlink = false;
        }

        focusedPaneId = id;
        var p = panes[id];
        if (!p) return;

        if (p.container) p.container.classList.add('focused');
        if (p.term) p.term.options.cursorBlink = true;

        // Update toolbar and sidebar to show this pane's cached data.
        updateToolbar();
        if (p.cwd) setCWD(p.cwd);
        if (p.files.length > 0) {
            renderFileList(p.lastListedCWD || p.cwd, p.files);
        } else {
            fileItems.innerHTML = '<div class="empty-hint">Click "List Files" to browse</div>';
        }

        try { p.term.focus(); } catch (e) { }
    }

    // --- split / close / resize ---
    function splitPane(direction) {
        if (!focusedPaneId) return;
        var fp = getFocusedPane();
        if (!fp) return;
        var sourceCwd = fp.cwd || '';

        // Find the parent split node that contains the focused pane, or the root.
        var parentSplit = findParentSplit(layoutTree, focusedPaneId);
        if (!parentSplit) {
            // Single pane case — wrap in a split.
            var newPane = createPane(sourceCwd);
            var oldId = focusedPaneId;

            // Reparent: old pane + new pane become children of a new split.
            layoutTree = {
                type: 'split',
                direction: direction,
                ratio: 0.5,
                children: [
                    { type: 'pane', id: oldId },
                    { type: 'pane', id: newPane.id }
                ]
            };

            renderLayout(terminalContainer, layoutTree);

            // Init terminal for new pane.
            initPaneTerminal(newPane);
            focusPane(oldId);
            return;
        }

        // Multi-pane case — wrap the focused pane's leaf in a new split.
        var childIdx = -1;
        for (var i = 0; i < parentSplit.children.length; i++) {
            if (containsPane(parentSplit.children[i], focusedPaneId)) {
                childIdx = i;
                break;
            }
        }
        if (childIdx < 0) return;

        var newPane = createPane(sourceCwd);

        var existingChild = parentSplit.children[childIdx];

        // Always nest: wrap the existing child in a new binary split.
        // This keeps the tree strictly binary (2 children per split),
        // which matches the renderLayout assumption.
        parentSplit.children[childIdx] = {
            type: 'split',
            direction: direction,
            ratio: 0.5,
            children: [existingChild, { type: 'pane', id: newPane.id }]
        };

        renderLayout(terminalContainer, layoutTree);
        initPaneTerminal(newPane);
        focusPane(newPane.id);
    }

    function containsPane(node, id) {
        if (node.type === 'pane') return node.id === id;
        for (var i = 0; i < node.children.length; i++) {
            if (containsPane(node.children[i], id)) return true;
        }
        return false;
    }

    function findParentSplit(node, id) {
        if (node.type === 'pane') return null;
        for (var i = 0; i < node.children.length; i++) {
            if (containsPane(node.children[i], id)) {
                // If the child itself is a split, recurse to find the innermost parent.
                if (node.children[i].type === 'split') {
                    var deeper = findParentSplit(node.children[i], id);
                    if (deeper) return deeper;
                }
                return node;
            }
        }
        return null;
    }

    function closePane(id) {
        var ids = getAllPaneIds();
        if (ids.length <= 1) {
            // Last pane — kill it and open a fresh one after a 1s delay.
            destroyPane(id);
            setTimeout(function () {
                layoutTree = createDefaultLayout();
                renderLayout(terminalContainer, layoutTree);
                var newId = layoutTree.id;
                var newPane = panes[newId];
                if (newPane) {
                    initPaneTerminal(newPane);
                    focusPane(newId);
                }
            }, 500);
            return;
        }

        // Remove pane from tree and clean up.
        removePaneFromTree(layoutTree, id);

        // Pick a new focus.
        var remaining = getAllPaneIds();
        var newFocus = remaining[0];

        // If the closed pane was focused, find the closest remaining.
        if (focusedPaneId === id) {
            var idx = ids.indexOf(id);
            if (idx >= 0) {
                // Prefer the next pane, fall back to previous.
                if (idx < ids.length - 1) {
                    for (var i = idx + 1; i < ids.length; i++) {
                        if (panes[ids[i]]) { newFocus = ids[i]; break; }
                    }
                } else {
                    for (var i = idx - 1; i >= 0; i--) {
                        if (panes[ids[i]]) { newFocus = ids[i]; break; }
                    }
                }
            }
        } else {
            newFocus = focusedPaneId;
        }

        // Collapse: if root is a split with only one child, use that child.
        while (layoutTree.type === 'split' && layoutTree.children.length === 1) {
            layoutTree = layoutTree.children[0];
        }
        // If root is a split with no children (shouldn't happen), create a fresh pane.
        if (layoutTree.type === 'split' && layoutTree.children.length === 0) {
            var fallback = createPane(null);
            layoutTree = { type: 'pane', id: fallback.id };
            renderLayout(terminalContainer, layoutTree);
            initPaneTerminal(fallback);
            focusPane(fallback.id);
            destroyPane(id);
            return;
        }

        destroyPane(id);
        renderLayout(terminalContainer, layoutTree);

        // Re-init any pane that lost its DOM (unlikely but safe).
        var afterIds = getAllPaneIds();
        for (var j = 0; j < afterIds.length; j++) {
            var pid = afterIds[j];
            var p = panes[pid];
            if (p && !p.term) {
                initPaneTerminal(p);
            }
        }

        focusPane(newFocus);
    }

    function removePaneFromTree(node, id) {
        if (node.type === 'pane') return false;
        for (var i = node.children.length - 1; i >= 0; i--) {
            var child = node.children[i];
            if (child.type === 'pane' && child.id === id) {
                node.children.splice(i, 1);
                return true;
            }
            if (child.type === 'split' && removePaneFromTree(child, id)) {
                // Collapse single-child splits.
                if (child.children.length === 1) {
                    node.children[i] = child.children[0];
                } else if (child.children.length === 0) {
                    node.children.splice(i, 1);
                }
                return true;
            }
        }
        return false;
    }

    function moveFocus(direction) {
        var ids = getAllPaneIds();
        if (ids.length <= 1) return;
        var idx = ids.indexOf(focusedPaneId);
        if (idx < 0) return;
        var nextIdx;
        if (direction === 'right' || direction === 'down') {
            nextIdx = (idx + 1) % ids.length;
        } else {
            nextIdx = (idx - 1 + ids.length) % ids.length;
        }
        focusPane(ids[nextIdx]);
    }

    function resizeFocused(direction, amount) {
        if (!focusedPaneId) return;
        // Find the nearest ancestor split and adjust its ratio.
        var split = findNearestSplit(layoutTree, focusedPaneId, direction);
        if (!split) return;
        var delta = (direction === 'right' || direction === 'down') ? amount : -amount;
        var newRatio = split.ratio + delta;
        split.ratio = Math.max(0.1, Math.min(0.9, newRatio));

        // Update DOM directly (avoid full re-render).
        var pane = getFocusedPane();
        if (!pane || !pane.container) return;
        var splitEl = findSplitDOM(terminalContainer, split);
        if (!splitEl) { renderLayout(terminalContainer, layoutTree); return; }
        var children = splitEl.querySelectorAll(':scope > .split-child');
        if (children.length >= 2) {
            children[0].style.flex = split.ratio;
            children[1].style.flex = 1 - split.ratio;
        }
        // Sync terminal sizes to backend after DOM resize.
        var ids = getAllPaneIds();
        for (var i = 0; i < ids.length; i++) {
            fitPane(panes[ids[i]]);
        }
    }

    function findSplitDOM(container, targetSplit) {
        // Walk DOM matching the layout tree to find the split element.
        function walk(domParent, treeNode) {
            if (treeNode === targetSplit) {
                var splitEls = domParent.querySelectorAll(':scope > .split-container');
                if (splitEls.length > 0) return splitEls[0];
                return domParent;
            }
            if (treeNode.type !== 'split') return null;
            var splitEl = domParent.querySelector(':scope > .split-container');
            if (!splitEl) return null;
            var children = splitEl.querySelectorAll(':scope > .split-child');
            if (children.length < 2) return null;
            var leftResult = walk(children[0], treeNode.children[0]);
            if (leftResult) return leftResult;
            return walk(children[1], treeNode.children[1]);
        }
        if (layoutTree === targetSplit) {
            var s = container.querySelector(':scope > .split-container');
            return s || container;
        }
        return walk(container, layoutTree);
    }

    function findNearestSplit(node, id, direction) {
        if (node.type === 'pane') return null;
        var isCol = (direction === 'left' || direction === 'right');
        var wantDir = isCol ? 'horizontal' : 'vertical';
        if (node.direction === wantDir) return node;
        for (var i = 0; i < node.children.length; i++) {
            var result = findNearestSplit(node.children[i], id, direction);
            if (result) return result;
        }
        return null;
    }

    // --- layout rendering ---
    function renderLayout(container, node) {
        container.innerHTML = '';

        if (node.type === 'pane') {
            var pane = panes[node.id];
            if (!pane) {
                pane = createPane(node.cwd || null);
                node.id = pane.id;
            }

            pane.container = document.createElement('div');
            pane.container.className = 'pane-container';
            pane.container.setAttribute('data-pane-id', pane.id);

            pane.terminalEl = document.createElement('div');
            pane.terminalEl.className = 'pane-terminal';
            pane.container.appendChild(pane.terminalEl);

            // Action buttons (visible on hover near top-right corner).
            var actions = document.createElement('div');
            actions.className = 'pane-actions';

            var splitDownBtn = document.createElement('button');
            splitDownBtn.className = 'pane-split-down';
            splitDownBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none">' +
                '<rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" stroke-width="1.3"/>' +
                '<rect x="1.5" y="8.3" width="13" height="6.2" rx="0.5" fill="currentColor" opacity="0.45"/>' +
                '<line x1="1.5" y1="8.3" x2="14.5" y2="8.3" stroke="currentColor" stroke-width="1.3"/>' +
                '</svg>';
            splitDownBtn.title = 'Split down (Alt+Shift+-)';
            splitDownBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                focusPane(pane.id);
                splitPane('vertical');
            });
            actions.appendChild(splitDownBtn);

            var splitRightBtn = document.createElement('button');
            splitRightBtn.className = 'pane-split-right';
            splitRightBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none">' +
                '<rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" stroke-width="1.3"/>' +
                '<rect x="8.3" y="1.5" width="6.2" height="13" rx="0.5" fill="currentColor" opacity="0.45"/>' +
                '<line x1="8.3" y1="1.5" x2="8.3" y2="14.5" stroke="currentColor" stroke-width="1.3"/>' +
                '</svg>';
            splitRightBtn.title = 'Split right (Alt+Shift+D)';
            splitRightBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                focusPane(pane.id);
                splitPane('horizontal');
            });
            actions.appendChild(splitRightBtn);

            var closeBtn = document.createElement('button');
            closeBtn.className = 'pane-close';
            closeBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none">' +
                '<line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
                '<line x1="12.5" y1="3.5" x2="3.5" y2="12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
                '</svg>';
            closeBtn.title = 'Close pane';
            closeBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                closePane(pane.id);
            });
            actions.appendChild(closeBtn);

            pane.container.appendChild(actions);

            container.appendChild(pane.container);

            // Click to focus.
            pane.container.addEventListener('mousedown', function () {
                focusPane(pane.id);
            });

            // If this pane already has a terminal, re-attach it.
            if (pane.term && pane.term.element) {
                pane.terminalEl.appendChild(pane.term.element);
                setTimeout(function () { fitPane(pane); }, 50);
            }

            // Focus indicator.
            if (pane.id === focusedPaneId) {
                pane.container.classList.add('focused');
            }

            return;
        }

        // Split node.
        var splitEl = document.createElement('div');
        splitEl.className = 'split-container';
        splitEl.style.flexDirection = node.direction === 'horizontal' ? 'row' : 'column';

        var leftEl = document.createElement('div');
        leftEl.className = 'split-child';
        leftEl.style.flex = node.ratio;

        var handle = document.createElement('div');
        handle.className = 'split-handle';
        handle.setAttribute('data-direction', node.direction === 'horizontal' ? 'col' : 'row');

        var rightEl = document.createElement('div');
        rightEl.className = 'split-child';
        rightEl.style.flex = 1 - node.ratio;

        splitEl.appendChild(leftEl);
        splitEl.appendChild(handle);
        splitEl.appendChild(rightEl);
        container.appendChild(splitEl);

        renderLayout(leftEl, node.children[0]);
        renderLayout(rightEl, node.children[1]);

        initResizeHandle(handle, node, leftEl, rightEl);
    }

    function initResizeHandle(handle, splitNode, leftChild, rightChild) {
        handle.addEventListener('mousedown', function (e) {
            e.preventDefault();
            var isCol = splitNode.direction === 'horizontal';
            var startPos = isCol ? e.clientX : e.clientY;
            var startRatio = splitNode.ratio;
            var parentEl = handle.parentElement;
            var totalSize = isCol ? parentEl.offsetWidth : parentEl.offsetHeight;
            if (!totalSize) return;

            handle.classList.add('active');

            function onMove(ev) {
                var currentPos = isCol ? ev.clientX : ev.clientY;
                var delta = currentPos - startPos;
                var newRatio = startRatio + delta / totalSize;
                newRatio = Math.max(0.1, Math.min(0.9, newRatio));
                splitNode.ratio = newRatio;
                leftChild.style.flex = newRatio;
                rightChild.style.flex = 1 - newRatio;
            }

            function onUp() {
                handle.classList.remove('active');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    // --- layout ---
    function createDefaultLayout() {
        // Always start with a single pane.
        var p = createPane(null);
        return { type: 'pane', id: p.id };
    }

    // --- global hotkey handler (capture phase) ---
    terminalContainer.addEventListener('keydown', function (e) {
        // Alt+Shift+D → split horizontal (side by side)
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'd' || e.key === 'D')) {
            e.preventDefault();
            e.stopImmediatePropagation();
            splitPane('horizontal');
            return;
        }
        // Alt+Shift+- → split vertical (stacked)
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === '-' || e.key === '_')) {
            e.preventDefault();
            e.stopImmediatePropagation();
            splitPane('vertical');
            return;
        }
        // Alt+Shift+Arrow → resize
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
            var rdir = null;
            if (e.key === 'ArrowLeft') rdir = 'left';
            else if (e.key === 'ArrowRight') rdir = 'right';
            else if (e.key === 'ArrowUp') rdir = 'up';
            else if (e.key === 'ArrowDown') rdir = 'down';
            if (rdir) {
                e.preventDefault();
                e.stopImmediatePropagation();
                resizeFocused(rdir, 0.05);
                return;
            }
        }
        // Alt+Arrow → move focus
        if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            var mdir = null;
            if (e.key === 'ArrowLeft') mdir = 'left';
            else if (e.key === 'ArrowRight') mdir = 'right';
            else if (e.key === 'ArrowUp') mdir = 'up';
            else if (e.key === 'ArrowDown') mdir = 'down';
            if (mdir) {
                e.preventDefault();
                e.stopImmediatePropagation();
                moveFocus(mdir);
                return;
            }
        }
        // Ctrl+Shift+W or Ctrl+Q → close focused pane (only when multiple panes exist)
        if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'w' || e.key === 'W') && e.shiftKey) {
            if (getAllPaneIds().length > 1) {
                e.preventDefault();
                e.stopImmediatePropagation();
                closePane(focusedPaneId);
                return;
            }
        }
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'q' || e.key === 'Q')) {
            if (getAllPaneIds().length > 1) {
                e.preventDefault();
                e.stopImmediatePropagation();
                closePane(focusedPaneId);
                return;
            }
        }

    }, true);

    // --- toolbar display ---
    var hostnameInline = document.getElementById('hostname-inline');

    function updateToolbar() {
        var fp = getFocusedPane();
        if (fp) {
            hostnameInline.textContent = fp.hostname ? fp.hostname + ':' : '';
            if (fp.cwd) {
                cwdInline.textContent = fp.cwd;
                cwdInline.title = fp.cwd;
            }
        }
    }

    function setCWD(path) {
        buildClickablePath(cwdPath, path);
        cwdInline.textContent = path;
        cwdInline.title = path;
        updateToolbar();
    }

    function buildClickablePath(container, path) {
        container.innerHTML = '';
        if (!path || path === '-') {
            container.textContent = path || '-';
            return;
        }
        // Split into segments: "/" "home/" "simba/" ...
        var parts = path.split('/');
        if (parts[0] === '') {
            // Absolute path — first segment is the root.
            parts.shift();
            var rootSpan = document.createElement('span');
            rootSpan.className = 'cwd-seg';
            rootSpan.textContent = '/';
            rootSpan.addEventListener('click', function () {
                cdTo('/');
            });
            container.appendChild(rootSpan);
        }
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] === '') continue;
            var seg = document.createElement('span');
            seg.className = 'cwd-seg';
            seg.textContent = parts[i] + '/';
            seg.addEventListener('click', (function (segments, idx) {
                return function () {
                    var target = '/' + segments.slice(0, idx + 1).join('/');
                    cdTo(target);
                };
            })(parts, i));
            container.appendChild(seg);
        }
    }

    function cdTo(dir) {
        var fp = getFocusedPane();
        if (fp && fp.ws && fp.ws.readyState === WebSocket.OPEN) {
            fp.ws.send('cd ' + dir + '\n');
        }
    }

    // --- file list (per-pane, follows focus) ---
    var filesList = document.getElementById('sidebar-files');
    var fileItems = document.getElementById('file-items');
    var fileFilter = document.getElementById('file-filter');
    var hideHidden = document.getElementById('hide-hidden');
    var lastFiles = [];
    var lastListedCWD = '';

    function refreshFileList() {
        var fp = getFocusedPane();
        if (!fp || !fp.ws || fp.ws.readyState !== WebSocket.OPEN) return;
        var cwd = cwdPath.textContent;
        if (cwd !== '-' && cwd !== fp.lastListedCWD) {
            fp.lastListedCWD = cwd;
            fp.ws.send(JSON.stringify({ type: 'list-files' }));
        }
    }

    fileFilter.addEventListener('input', function () {
        renderFiltered();
    });
    hideHidden.addEventListener('change', function () {
        renderFiltered();
    });
    document.getElementById('refresh-files').addEventListener('click', function () {
        var fp = getFocusedPane();
        if (fp && fp.ws && fp.ws.readyState === WebSocket.OPEN) {
            fp.lastListedCWD = '';
            fp.ws.send(JSON.stringify({ type: 'list-files' }));
        }
    });

    function renderFiltered() {
        var query = fileFilter.value.toLowerCase();
        var fp = getFocusedPane();
        var files = fp ? fp.files : [];
        var filtered = files;
        if (!hideHidden.checked) {
            filtered = filtered.filter(function (f) { return f.name[0] !== '.'; });
        }
        if (query) {
            filtered = filtered.filter(function (f) { return f.name.toLowerCase().indexOf(query) !== -1; });
        }
        fileItems.innerHTML = '';

        var cwd = fp ? fp.lastListedCWD || fp.cwd : '';
        var showDotDot = cwd && cwd !== '/' && cwd !== '-';
        if (showDotDot) {
            var dotDot = document.createElement('div');
            dotDot.className = 'file-item';
            var ddName = document.createElement('span');
            var isShell = fp ? fp.isAtShell : true;
            ddName.className = 'name is-dir';
            dotDot.appendChild(ddName);
            var ddText = document.createElement('span');
            ddText.className = 'name-text' + (isShell ? ' clickable' : '');
            ddText.textContent = '../';
            ddText.title = '..';
            ddName.appendChild(ddText);
            if (isShell) {
                WebtermdUtils.makeDragSafeClick(ddText, function () {
                    var f = getFocusedPane();
                    if (f && f.ws && f.ws.readyState === WebSocket.OPEN) {
                        f.ws.send('cd ..\n');
                    }
                });
            }
            fileItems.appendChild(dotDot);
        }

        if (filtered.length === 0) {
            if (!showDotDot) {
                fileItems.innerHTML = '<div class="empty-hint">' + (query ? 'No matches' : 'Directory is empty') + '</div>';
            }
            return;
        }
        var uploadPaths = uploadManager.getUploadListPaths();
        var fcwd = cwd.replace(/\/$/, '');
        filtered.forEach(function (f) {
            var item = document.createElement('div');
            item.className = 'file-item';
            if (!f.isDir && uploadPaths[fcwd + '/' + f.name]) {
                item.classList.add('in-upload');
            }

            var name = document.createElement('span');
            name.className = 'name' + (f.isDir ? ' is-dir' : '') + (f.isSymlink ? ' is-symlink' : '');
            var nameText = document.createElement('span');
            var fp2 = getFocusedPane();
            var clickable = f.isDir && fp2 && fp2.isAtShell;
            var previewable = !f.isDir && isPreviewable(f.name);
            nameText.className = 'name-text' + (clickable ? ' clickable' : '') + (previewable ? ' preview-link' : '');
            nameText.textContent = f.name + (f.isDir ? '/' : '');
            nameText.title = f.name;
            name.appendChild(nameText);
            item.appendChild(name);

            if (clickable) {
                WebtermdUtils.makeDragSafeClick(nameText, function () {
                    var f2 = getFocusedPane();
                    if (f2 && f2.ws && f2.ws.readyState === WebSocket.OPEN) {
                        f2.ws.send('cd ' + f.name + '\n');
                    }
                });
            }

            if (!f.isDir) {
                var size = document.createElement('span');
                size.className = 'size';
                size.textContent = WebtermdUtils.formatSize(f.size);
                item.appendChild(size);

                // Context menu to delete file
                item.addEventListener('contextmenu', function (e) {
                    e.preventDefault();
                    var fpc = getFocusedPane();
                    var fileCwd = fpc ? fpc.lastListedCWD || fpc.cwd : '';
                    if (!fileCwd) return;
                    var absPath = fileCwd.replace(/\/$/, '') + '/' + f.name;
                    showFileContextMenu(e.clientX, e.clientY, f.name, absPath, item);
                });

                if (previewable) {
                    nameText.title = 'Preview ' + f.name;
                    WebtermdUtils.makeDragSafeClick(nameText, function (e) {
                        e.stopPropagation();
                        var f3 = getFocusedPane();
                        var auth = getAuth() || { nonce: '', sig: '' };
                        var previewCwd = f3 && (f3.lastListedCWD || f3.cwd);
                        if (!f3 || !previewCwd) {
                            showError('Not connected');
                            return;
                        }
                        var previewURL = basePath + '/files/' + encodeURIComponent(f.name) + '?path=' + encodeURIComponent(previewCwd);
                        fetch(previewURL, {
                            headers: {
                                'X-Webtermd-Nonce': auth.nonce,
                                'X-Webtermd-Signature': auth.sig
                            }
                        }).then(function (response) {
                            if (!response.ok) {
                                return response.json().catch(function () { return {}; }).then(function (result) {
                                    return Promise.reject(new Error(result.error || 'preview failed'));
                                });
                            }
                            if (response.headers.get('Content-Type').indexOf('image/') === 0) {
                                return response.blob().then(function (image) {
                                    textEditor.open(f.name, { type: 'image', url: URL.createObjectURL(image) }, previewCwd);
                                });
                            }
                            return response.text().then(function (content) {
                                var metaURL = basePath + '/files/' + encodeURIComponent(f.name) + '/meta?path=' + encodeURIComponent(previewCwd);
                                return fetch(metaURL, {
                                    headers: {
                                        'X-Webtermd-Nonce': auth.nonce,
                                        'X-Webtermd-Signature': auth.sig
                                    }
                                }).then(function (metaResp) {
                                    if (!metaResp.ok) return { writable: false };
                                    return metaResp.json();
                                }).catch(function () {
                                    return { writable: false };
                                }).then(function (meta) {
                                    textEditor.open(f.name, { type: 'text', content: content, writable: meta.writable }, previewCwd);
                                });
                            });
                        }).catch(function (exception) {
                            showError('Preview: ' + exception.message);
                        });
                    });
                }

            }

            fileItems.appendChild(item);
        });
    }

    function renderFileList(dir, files) {
        var fp = getFocusedPane();
        if (fp) {
            fp.lastListedCWD = dir;
            fp.files = files;
        }
        lastListedCWD = dir;
        lastFiles = files;
        renderFiltered();
    }

    function triggerDownload(url) {
        var iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = url;
        document.body.appendChild(iframe);
        setTimeout(function () { document.body.removeChild(iframe); }, 5000);
    }

    function showFileContextMenu(x, y, name, path, itemEl) {
        var cm = uploadManager.getCtxMenu();
        cm.style.display = 'block';
        cm.style.left = x + 'px';
        cm.style.top = y + 'px';
        cm.innerHTML = '<div class="ctx-item" data-action="download-file">Download</div>' +
            '<div class="ctx-item ctx-danger" data-action="delete-file">Delete</div>';

        if (itemEl) {
            var prev = document.querySelector('.ctx-highlight');
            if (prev) prev.classList.remove('ctx-highlight');
            itemEl.classList.add('ctx-highlight');
        }

        var items = cm.querySelectorAll('.ctx-item');
        for (var i = 0; i < items.length; i++) {
            items[i].onclick = function () {
                var action = this.getAttribute('data-action');
                cm.style.display = 'none';
                if (itemEl) itemEl.classList.remove('ctx-highlight');
                if (action === 'download-file') {
                    var fp = getFocusedPane();
                    if (fp && fp.ws && fp.ws.readyState === WebSocket.OPEN) {
                        fp.ws.send(JSON.stringify({ type: 'download', path: name }));
                    }
                } else if (action === 'delete-file' && wsCmd && wsCmd.readyState === WebSocket.OPEN) {
                    wsCmd.send(JSON.stringify({ type: 'delete-file', path: path }));
                    setTimeout(function () {
                        var fpp = getFocusedPane();
                        if (fpp && fpp.ws && fpp.ws.readyState === WebSocket.OPEN) {
                            fpp.lastListedCWD = '';
                            fpp.ws.send(JSON.stringify({ type: 'list-files' }));
                        }
                    }, 300);
                }
            };
        }
    }

    // --- preview ---
    var nonPreviewExts = {
        'o':   true, 'so':  true, 'a':   true, 'ko': true,
        'exe': true, 'dll': true, 'bin': true,
        'zip': true, 'tar': true, 'gz':  true, 'bz2': true, 'xz':  true, '7z': true, 'rar': true,
        'pdf': true, 'doc': true, 'docx':true, 'xls': true, 'xlsx':true, 'ppt': true, 'pptx':true,
        'mp3': true, 'mp4': true, 'avi': true, 'mov': true, 'mkv': true, 'wav': true, 'flac':true,
        'ttf': true, 'otf': true, 'woff':true, 'woff2':true,
        'pyc': true, 'pyo': true, 'class':true,
        'iso': true, 'img': true, 'dmg': true,
        'ps':  true, 'eps': true,
    };
    function isPreviewable(name) {
        var dot = name.lastIndexOf('.');
        if (dot < 0) return true;
        return !nonPreviewExts[name.slice(dot + 1).toLowerCase()];
    }

    var textEditor = new WebtermdTextEditor({
        basePath: basePath,
        getAuth: getAuth,
        showError: showError,
        onSaved: function () {
            var pane = getFocusedPane();
            if (pane && pane.ws && pane.ws.readyState === WebSocket.OPEN) {
                pane.lastListedCWD = '';
                pane.ws.send(JSON.stringify({ type: 'list-files' }));
            }
        },
        onSudoSave: function (path, cwd, content) {
            var absPath = cwd ? cwd.replace(/\/$/, '') + '/' + path : path;
            openSudoTerminal(absPath, content);
        }
    });

    // --- sudo terminal popover ---
    var sudoModal = document.getElementById('sudo-modal');
    var sudoTitle = document.getElementById('sudo-title');
    var sudoClose = document.getElementById('sudo-close');
    var sudoTerminalEl = document.getElementById('sudo-terminal');
    var sudoTerm = null;
    var sudoFitAddon = null;
    var sudoWS = null;
    var sudoClipboardCleanup = null;
    var savedSudoPassword = '';
    var sudoUseSavedPassword = document.getElementById('sudo-use-saved-password');

    function isSudoPasswordPrompt(output) {
        // sudo's prompt may be customized, but English prompts conventionally end in a colon.
        var plainOutput = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        return /(?:\[sudo\]\s*)?(?:password|passphrase)(?:\s+for\s+[^:\r\n]+)?\s*:\s*$/i.test(plainOutput);
    }

    function openSudoTerminal(path, content) {
        sudoTitle.textContent = 'Saving ' + path + ' (sudo)';
        sudoModal.classList.add('open');
        sudoUseSavedPassword.hidden = true;

        // Ensure terminal element is clean.
        sudoTerminalEl.innerHTML = '';

        sudoTerm = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
            theme: {
                background: '#1e1e1e',
                foreground: '#d4d4d4',
                cursor: '#d4d4d4',
                selectionBackground: '#264f78'
            },
            allowProposedApi: true
        });

        sudoFitAddon = new FitAddon.FitAddon();
        sudoTerm.loadAddon(sudoFitAddon);
        sudoTerm.open(sudoTerminalEl);
        sudoTerm.focus();
        sudoClipboardCleanup = WebtermdUtils.installClipboard(sudoTerm, sudoTerminalEl);
        setTimeout(function () {
            try { sudoFitAddon.fit(); } catch (e) { }
            if (sudoTerm) sudoTerm.focus();
        }, 100);

        // Connect WebSocket.
        var auth = getAuth() || { nonce: '', sig: '' };
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        var url = proto + '//' + location.host + basePath +
            '/ws/sudo?path=' + encodeURIComponent(path) +
            '&nonce=' + encodeURIComponent(auth.nonce) +
            '&signature=' + encodeURIComponent(auth.sig);
        sudoWS = new WebSocket(url);
        sudoWS.binaryType = 'arraybuffer';

        var closed = false;
        var terminalOutput = '';
        var typedPassword = '';
        var capturingPassword = false;

        function sendSavedPassword() {
            if (!savedSudoPassword || !sudoWS || sudoWS.readyState !== WebSocket.OPEN) return;
            sudoWS.send(savedSudoPassword + '\r');
            capturingPassword = false;
            sudoUseSavedPassword.hidden = true;
            sudoTerm.focus();
        }

        function capturePasswordInput(data) {
            if (!capturingPassword) return;
            for (var index = 0; index < data.length; index++) {
                var character = data.charAt(index);
                if (character === '\r') {
                    if (typedPassword) savedSudoPassword = typedPassword;
                    typedPassword = '';
                    capturingPassword = false;
                    return;
                }
                if (character === '\x7f' || character === '\b') {
                    typedPassword = typedPassword.slice(0, -1);
                } else if (character === '\x15') { // Ctrl+U
                    typedPassword = '';
                } else if (character >= ' ') {
                    typedPassword += character;
                }
            }
        }

        function cleanup() {
            if (closed) return;
            closed = true;
            if (sudoWS) { try { sudoWS.close(); } catch (e) { } }
            if (sudoTerm) { try { sudoTerm.dispose(); } catch (e) { } }
            if (sudoClipboardCleanup) sudoClipboardCleanup();
            sudoTerm = null; sudoFitAddon = null; sudoWS = null; sudoClipboardCleanup = null;
            sudoUseSavedPassword.hidden = true;
            sudoModal.classList.remove('open');
            sudoTerminalEl.innerHTML = '';
        }

        sudoWS.onopen = function () {
            // Send content immediately.
            sudoWS.send(JSON.stringify({ type: 'sudo-save', content: content }));

            // Forward keystrokes to WS.
            sudoTerm.onData(function (data) {
                if (sudoWS && sudoWS.readyState === WebSocket.OPEN) {
                    capturePasswordInput(data);
                    sudoWS.send(data);
                }
            });

            // Send resize events.
            sudoTerm.onResize(function (_a) {
                if (sudoWS && sudoWS.readyState === WebSocket.OPEN) {
                    sudoWS.send(JSON.stringify({ type: 'resize', rows: _a.rows, cols: _a.cols }));
                }
            });

            // Send current terminal size.
            sudoWS.send(JSON.stringify({ type: 'resize', rows: sudoTerm.rows, cols: sudoTerm.cols }));

            try { sudoFitAddon.fit(); } catch (e) { }
        };

        sudoWS.onmessage = function (ev) {
            if (typeof ev.data === 'string') {
                try {
                    var msg = JSON.parse(ev.data);
                    if (msg.type === 'sudo-exit') {
                        if (msg.code === 0) {
                            // Success: close automatically after a brief delay.
                            sudoTerm.write('\r\n\x1b[32m[saved successfully]\x1b[0m\r\n');
                            setTimeout(cleanup, 800);
                            // Refresh file list in the main pane.
                            var pane = getFocusedPane();
                            if (pane && pane.ws && pane.ws.readyState === WebSocket.OPEN) {
                                pane.lastListedCWD = '';
                                pane.ws.send(JSON.stringify({ type: 'list-files' }));
                            }
                        } else {
                            // Failure: keep open so user can read the error.
                            sudoTitle.textContent = 'Saving ' + path + ' (failed, code ' + msg.code + ')';
                            sudoTitle.style.color = '#d32f2f';
                        }
                    } else if (msg.type === 'sudo-error') {
                        sudoTerm.write('\r\n\x1b[31m' + msg.message + '\x1b[0m\r\n');
                    }
                } catch (e) { }
            } else {
                // Binary = PTY output.
                var output = new TextDecoder().decode(new Uint8Array(ev.data));
                sudoTerm.write(output);
                terminalOutput = (terminalOutput + output).slice(-2048);
                if (!capturingPassword && isSudoPasswordPrompt(terminalOutput)) {
                    typedPassword = '';
                    capturingPassword = true;
                    sudoUseSavedPassword.hidden = !savedSudoPassword;
                }
            }
        };

        sudoWS.onclose = function () {
            if (!closed) {
                sudoTerm.write('\r\n\x1b[33m[connection closed]\x1b[0m\r\n');
            }
        };

        sudoWS.onerror = function () {
            sudoTerm.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');
        };

        // Close button kills the process.
        sudoClose.onclick = function () { cleanup(); };
        sudoUseSavedPassword.onpointerdown = function (event) { event.preventDefault(); };
        sudoUseSavedPassword.onclick = sendSavedPassword;

        // Click outside to cancel.
        sudoModal.onclick = function (e) {
            if (e.target === sudoModal) cleanup();
        };

        // Escape to cancel.
        function onKey(e) {
            if (e.key === 'Escape' && sudoModal.classList.contains('open')) {
                cleanup();
            }
        }
        document.addEventListener('keydown', onKey);
        // Clean up the listener when modal closes.
        var origCleanup = cleanup;
        cleanup = function () {
            document.removeEventListener('keydown', onKey);
            origCleanup();
        };
    }

    // --- help popover ---
    var helpOverlay = document.getElementById('help-overlay');
    var helpLink = document.getElementById('help-link');
    var helpClose = document.getElementById('help-close');

    helpLink.addEventListener('click', function (e) {
        e.preventDefault();
        helpOverlay.classList.add('open');
    });

    helpClose.addEventListener('click', function () {
        helpOverlay.classList.remove('open');
    });

    helpOverlay.addEventListener('click', function (e) {
        if (e.target === helpOverlay) helpOverlay.classList.remove('open');
    });

    // --- command channel WebSocket ---
    function connectCmd(nonce, sig) {
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        var url = proto + '//' + location.host + basePath + '/ws/cmd?nonce=' + encodeURIComponent(nonce) + '&signature=' + encodeURIComponent(sig);
        wsCmd = new WebSocket(url);

        wsCmd.onopen = function () { };

        wsCmd.onmessage = function (ev) {
            var msg = JSON.parse(ev.data);
            switch (msg.type) {
                case 'session':
                    uploadManager.setWsCmd(wsCmd);
                    uploadManager.setSession(msg.upload_token, msg.upload_prefix);
                    uploadManager.initFromCmd();
                    break;

                case 'upload-init':
                case 'upload-error':
                case 'upload-done':
                case 'upload-status':
                    uploadManager.handleCmdMessage(msg);
                    break;
            }
        };

        wsCmd.onclose = function () {
            setTimeout(function () {
                var stored = getAuth();
                if (stored && stored.nonce && stored.sig) connectCmd(stored.nonce, stored.sig);
            }, 2000);
        };
    }

    // --- auth dialog ---
    function showSigDialog() {
        var cmd = "printf '%s' '" + sigNonce + "' | openssl dgst -sha256 -sign ~/.ssh/id_rsa | base64 -w0";
        document.getElementById('sig-cmd').textContent = cmd;
        document.getElementById('sig-input').value = '';
        document.getElementById('sig-error').style.display = 'none';
        document.getElementById('sig-overlay').classList.add('open');
        document.getElementById('sig-input').focus();
    }

    document.getElementById('sig-connect').addEventListener('click', function () {
        var sig = document.getElementById('sig-input').value.trim();
        if (!sig) return;
        document.getElementById('sig-overlay').classList.remove('open');
        // Reconnect focused pane with new signature.
        setAuth(sigNonce, sig);
        var fp = getFocusedPane();
        if (fp) {
            if (fp.ws) try { fp.ws.close(); } catch (e) { }
            connectPaneWS(fp);
        }
        if (wsCmd) try { wsCmd.close(); } catch (e) { }
        connectCmd(sigNonce, sig);
    });

    document.getElementById('sig-refresh').addEventListener('click', function () {
        document.getElementById('sig-overlay').classList.remove('open');
        // Reconnect all.
        startAll();
    });

    document.getElementById('sig-input').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            document.getElementById('sig-connect').click();
        }
    });

    // --- startup ---
    function startAll() {
        var savedAuth = getAuth();

        if (savedAuth && savedAuth.nonce && savedAuth.sig) {
            sigNonce = savedAuth.nonce;
        } else {
            // Fetch a fresh challenge.
            fetch(basePath + '/api/challenge')
                .then(function (r) {
                    if (!r.ok) throw new Error('challenge failed: ' + r.status);
                    return r.json();
                })
                .then(function (data) {
                    sigNonce = data.nonce;
                    bootLayout();
                })
                .catch(function (err) {
                    showError('Connection error: ' + err.message);
                    setTimeout(startAll, 3000);
                });
            return;
        }
        bootLayout();
    }

    function bootLayout() {
        layoutTree = createDefaultLayout();

        // Ensure all pane IDs in the tree have runtime objects.
        function ensurePanes(node) {
            if (node.type === 'pane') {
                if (!panes[node.id]) {
                    var p = createPane(node.cwd || null);
                    node.id = p.id;
                }
                return;
            }
            for (var i = 0; i < node.children.length; i++) {
                ensurePanes(node.children[i]);
            }
        }
        ensurePanes(layoutTree);

        // Render layout.
        renderLayout(terminalContainer, layoutTree);

        // Init terminals for all panes.
        var ids = getAllPaneIds();
        for (var i = 0; i < ids.length; i++) {
            var p = panes[ids[i]];
            if (p && !p.term) {
                initPaneTerminal(p);
            }
        }

        // Focus first pane.
        focusPane(ids[0]);

        // Create upload manager (once).
        if (!uploadManager) {
            uploadManager = WebtermdUpload.create({
                uploadsList: document.getElementById('sidebar-uploads'),
                emptyHint: (document.getElementById('sidebar-uploads') || {}).querySelector ? document.getElementById('sidebar-uploads').querySelector('.empty-hint') : null,
                dropZone: document.getElementById('drop-zone'),
                chunkSize: 1 << 20,
                basePath: basePath,
                getPathEntry: getPathEntry,
                savePathEntry: savePathEntry,
                getAuth: getAuth,
                getFocusedPane: getFocusedPane,
                cwdPath: cwdPath,
                showError: showError,
                onHistoryChanged: refreshFileList
            });
        }

        // Connect command channel.
        var stored = getAuth();
        if (stored && stored.nonce && stored.sig) {
            connectCmd(stored.nonce, stored.sig);
        } else {
            connectCmd(sigNonce, '');
        }
    }

    startAll();
})();
