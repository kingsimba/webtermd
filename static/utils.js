// utils.js — shared utility functions for webtermd
(function () {
    var utils = {};

    // --- clipboard support ---
    var hasClipboardAPI = !!(navigator.clipboard && navigator.clipboard.readText);

    var clipSink = document.createElement('textarea');
    clipSink.style.position = 'fixed';
    clipSink.style.top = '0';
    clipSink.style.left = '-9999px';
    clipSink.style.width = '1px';
    clipSink.style.height = '1px';
    clipSink.style.opacity = '0';
    clipSink.setAttribute('tabindex', '-1');
    clipSink.setAttribute('autocomplete', 'off');
    clipSink.setAttribute('autocorrect', 'off');
    clipSink.setAttribute('autocapitalize', 'off');
    clipSink.setAttribute('spellcheck', 'false');
    document.body.appendChild(clipSink);

    var clipboardTarget = null;
    clipSink.addEventListener('paste', function (ev) {
        var data = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
        ev.preventDefault();
        if (clipboardTarget) {
            clipboardTarget.focus();
            if (data) clipboardTarget.paste(data);
        }
    });

    // Install Ctrl+C/V clipboard handling on an xterm.js terminal.
    // Returns a cleanup function.
    utils.installClipboard = function (term, host) {
        function handleKeydown(e) {
            if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

            // Ctrl+C: copy selection, or fall through to SIGINT.
            if (e.key === 'c' || e.key === 'C') {
                var selection = term.getSelection();
                if (selection) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    term.clearSelection();
                    if (hasClipboardAPI) {
                        navigator.clipboard.writeText(selection).catch(function () { });
                    } else {
                        clipSink.value = selection;
                        clipSink.select();
                        clipSink.focus();
                        try { document.execCommand('copy'); } catch (err) { }
                        setTimeout(function () { term.focus(); }, 0);
                    }
                }
                return;
            }

            // Ctrl+V: paste from clipboard.
            if (e.key === 'v' || e.key === 'V') {
                e.stopImmediatePropagation();
                if (hasClipboardAPI) {
                    e.preventDefault();
                    navigator.clipboard.readText().then(function (text) {
                        if (text) term.paste(text);
                    }).catch(function () { });
                } else {
                    clipboardTarget = term;
                    clipSink.value = '';
                    clipSink.focus();
                    setTimeout(function () {
                        if (document.activeElement === clipSink) term.focus();
                        clipboardTarget = null;
                    }, 0);
                }
            }
        }

        host.addEventListener('keydown', handleKeydown, true);
        return function () {
            host.removeEventListener('keydown', handleKeydown, true);
        };
    };

    // --- DOM helpers ---

    // Attach a click handler that ignores drag-select (pointer moved > 3 px).
    utils.makeDragSafeClick = function (el, fn) {
        var downX = 0, downY = 0, hadDown = false;
        el.addEventListener('pointerdown', function (e) {
            downX = e.clientX;
            downY = e.clientY;
            hadDown = true;
        });
        // Fallback for click simulations that omit pointer events.
        el.addEventListener('mousedown', function (e) {
            downX = e.clientX;
            downY = e.clientY;
            hadDown = true;
        });
        el.addEventListener('click', function (e) {
            if (hadDown) {
                var dx = e.clientX - downX;
                var dy = e.clientY - downY;
                if (dx * dx + dy * dy > 9) return;
            }
            fn(e);
        });
    };

    // --- string / formatting ---

    utils.escapeHtml = function (str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    };

    utils.formatSize = function (bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    };

    window.WebtermdUtils = utils;
})();
