(function () {

    function buildModal() {
        var modal = document.createElement('div');
        modal.className = 'preview-modal';

        var dialog = document.createElement('div');
        dialog.className = 'preview-dialog';

        var header = document.createElement('div');
        header.className = 'preview-header';

        var title = document.createElement('span');
        title.className = 'preview-title';

        var actions = document.createElement('div');
        actions.className = 'preview-actions';

        var save = document.createElement('button');
        save.type = 'button';
        save.className = 'preview-save';
        save.textContent = 'Save';

        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'preview-close';
        closeBtn.textContent = '✕';

        actions.appendChild(save);
        actions.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(actions);

        var body = document.createElement('div');
        body.className = 'preview-body';

        var textWrap = document.createElement('div');
        textWrap.className = 'preview-text-wrap';
        var text = document.createElement('pre');
        text.className = 'preview-text';
        textWrap.appendChild(text);

        var image = document.createElement('img');
        image.className = 'preview-img';

        body.appendChild(textWrap);
        body.appendChild(image);

        var status = document.createElement('div');
        status.className = 'preview-status';

        dialog.appendChild(header);
        dialog.appendChild(body);
        dialog.appendChild(status);
        modal.appendChild(dialog);

        return {
            modal: modal, dialog: dialog, title: title, save: save,
            closeBtn: closeBtn, body: body, textWrap: textWrap,
            text: text, image: image, status: status
        };
    }

    function TextEditor(options) {
        var el = buildModal();
        var modal = el.modal;
        var title = el.title;
        var textWrap = el.textWrap;
        var text = el.text;
        var image = el.image;
        var dialog = el.dialog;
        var body = el.body;
        var save = el.save;
        var status = el.status;
        var closeBtn = el.closeBtn;
        var path = '';
        var cwd = '';
        var originalContent = '';
        var dirty = false;
        var normalizing = false;
        var isWritable = false;
        function updateTitle() {
            title.textContent = dirty ? path + ' (modified)' : path;
        }
        var indentUnit = '    ';
        var maxUndoLevels = 10;
        var editGroupTimeout = 1000;
        var history = [];
        var historyIndex = 0;
        var pendingInput = null;
        var lastEdit = null;

        function detachModal() {
            if (modal.parentNode && modal.parentNode !== document.body) {
                modal.parentNode.removeChild(modal);
            }
            modal.classList.remove('in-pane');
            document.body.appendChild(modal);
        }

        function closePreview() {
            if (image.src.indexOf('blob:') === 0) URL.revokeObjectURL(image.src);
            image.removeAttribute('src');
            save.classList.remove('blink');
            modal.classList.remove('open');
            detachModal();
            if (options.onClose) options.onClose();
        }

        function languageFor(name) {
            var names = {
                'Makefile': 'makefile', 'Dockerfile': 'dockerfile',
                '.bashrc': 'bash', '.bash_profile': 'bash', '.profile': 'bash',
                '.zshrc': 'bash', '.tmux.conf': 'bash',
                '.gitconfig': 'ini', '.npmrc': 'ini'
            };
            var extensions = {
                'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
                'py': 'python', 'rb': 'ruby', 'go': 'go', 'rs': 'rust',
                'c': 'c', 'h': 'c', 'cpp': 'cpp', 'hpp': 'cpp', 'java': 'java',
                'php': 'php', 'lua': 'lua', 'sql': 'sql',
                'sh': 'bash', 'bash': 'bash', 'zsh': 'bash', 'fish': 'bash',
                'json': 'json', 'yaml': 'yaml', 'yml': 'yaml',
                'xml': 'xml', 'html': 'xml', 'css': 'css', 'md': 'markdown',
                'diff': 'diff', 'patch': 'diff',
                'ini': 'ini', 'cfg': 'ini', 'conf': 'ini', 'toml': 'ini',
                'env': 'ini', 'properties': 'ini', 'editorconfig': 'ini'
            };
            if (names[name]) return names[name];
            var dot = name.lastIndexOf('.');
            return dot < 0 ? null : extensions[name.slice(dot + 1).toLowerCase()] || null;
        }

        function renderedContent() {
            var lines = text.querySelectorAll('.preview-line code');
            var content = [];
            for (var index = 0; index < lines.length; index++) {
                content.push(lines[index].textContent);
            }
            return content.join('\n');
        }

        function editorContent() {
            return dirty ? renderedContent() : originalContent;
        }

        function detectIndent(content) {
            var lines = content.split('\n');
            var smallestSpaceIndent = 0;
            var tabIndentedLines = 0;
            for (var index = 0; index < lines.length; index++) {
                if (!lines[index].trim()) continue;
                if (/^\t/.test(lines[index])) {
                    tabIndentedLines++;
                    continue;
                }
                var spaces = (lines[index].match(/^ +/) || [''])[0].length;
                if (spaces && (!smallestSpaceIndent || spaces < smallestSpaceIndent)) {
                    smallestSpaceIndent = spaces;
                }
            }
            if (tabIndentedLines && !smallestSpaceIndent) {
                indentUnit = '\t';
                status.textContent = 'Tabs';
            } else {
                indentUnit = new Array((smallestSpaceIndent || 4) + 1).join(' ');
                status.textContent = 'Spaces: ' + indentUnit.length;
            }
        }

        function lineForNode(node) {
            while (node && node !== text) {
                if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('preview-line')) return node;
                node = node.parentNode;
            }
            return null;
        }

        function pointOffset(node, offset, content) {
            var line = lineForNode(node);
            if (!line) return content.length;
            var code = line.querySelector('code');
            var range = document.createRange();
            range.selectNodeContents(code);
            try {
                range.setEnd(node, offset);
            } catch (exception) {
                range.setEnd(code, code.childNodes.length);
            }
            var lines = Array.prototype.slice.call(text.querySelectorAll('.preview-line'));
            var lineIndex = lines.indexOf(line);
            var before = 0;
            for (var index = 0; index < lineIndex; index++) {
                before += lines[index].querySelector('code').textContent.length + 1;
            }
            return Math.min(content.length, before + range.toString().length);
        }

        function selectionOffsets(content) {
            var selection = window.getSelection();
            if (!selection.rangeCount || !text.contains(selection.anchorNode)) return { start: content.length, end: content.length };
            return {
                start: pointOffset(selection.anchorNode, selection.anchorOffset, content),
                end: pointOffset(selection.focusNode, selection.focusOffset, content)
            };
        }

        function pointAtOffset(content, offset) {
            var lines = Array.prototype.slice.call(text.querySelectorAll('.preview-line'));
            var remaining = Math.max(0, Math.min(offset, content.length));
            for (var index = 0; index < lines.length; index++) {
                var code = lines[index].querySelector('code');
                var length = code.textContent.length;
                if (remaining <= length || index === lines.length - 1) {
                    return textPointAt(code, Math.min(remaining, length));
                }
                remaining -= length + 1;
            }
            return { node: text, offset: text.childNodes.length };
        }

        function textPointAt(element, offset) {
            var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            var remaining = offset;
            var node;
            while ((node = walker.nextNode())) {
                if (remaining <= node.length) return { node: node, offset: remaining };
                remaining -= node.length;
            }
            return { node: element, offset: element.childNodes.length };
        }

        function restoreSelection(content, start, end) {
            try {
                text.focus({ preventScroll: true });
            } catch (exception) {
                text.focus();
            }
            var selection = window.getSelection();
            var startPoint = pointAtOffset(content, start);
            var endPoint = pointAtOffset(content, end);
            selection.removeAllRanges();
            selection.collapse(startPoint.node, startPoint.offset);
            if (start !== end) selection.extend(endPoint.node, endPoint.offset);
        }

        function scrollLineIntoView(lineIndex) {
            var line = text.querySelectorAll('.preview-line')[lineIndex];
            if (!line) return;
            var lineBounds = line.getBoundingClientRect();
            var bodyBounds = body.getBoundingClientRect();
            if (lineBounds.top < bodyBounds.top) {
                body.scrollTop += lineBounds.top - bodyBounds.top;
            } else if (lineBounds.bottom > bodyBounds.bottom) {
                body.scrollTop += lineBounds.bottom - bodyBounds.bottom;
            }
        }

        function render(content, selection) {
            var scrollTop = body.scrollTop;
            var scrollLeft = body.scrollLeft;
            var lines = content.split('\n');
            var lang = content && window.hljs ? languageFor(path) : null;
            detectIndent(content);
            text.className = 'preview-text' + (lang && hljs.getLanguage(lang) ? ' hljs' : '');
            text.replaceChildren();
            text.style.setProperty('--preview-line-number-width', String(lines.length).length + 'ch');
            for (var lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                var line = document.createElement('span');
                var code = document.createElement('code');
                line.className = 'preview-line';
                if (lang && hljs.getLanguage(lang)) {
                    code.innerHTML = hljs.highlight(lines[lineIndex], { language: lang }).value;
                } else {
                    code.textContent = lines[lineIndex];
                }
                if (!code.firstChild) code.appendChild(document.createTextNode(''));
                line.appendChild(code);
                text.appendChild(line);
            }
            body.scrollTop = scrollTop;
            body.scrollLeft = scrollLeft;
            if (selection) restoreSelection(content, selection.start, selection.end);
        }

        function lineIndexAt(content, offset) {
            return content.slice(0, offset).split('\n').length - 1;
        }

        function lineStart(content, offset) {
            return content.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        }

        function historyState(content, selection) {
            return { content: content, start: selection.start, end: selection.end };
        }

        function currentState() {
            var content = editorContent();
            return historyState(content, selectionOffsets(content));
        }

        function resetHistory(content) {
            history = [historyState(content, { start: content.length, end: content.length })];
            historyIndex = 0;
            pendingInput = null;
            lastEdit = null;
        }

        function breakEditGroup() {
            lastEdit = null;
        }

        function isGroupableInput(inputType) {
            return inputType === 'insertText' || inputType === 'deleteContentBackward' ||
                inputType === 'deleteContentForward';
        }

        function recordChange(before, after, inputType, groupable) {
            if (before.content === after.content) return;

            var now = Date.now();
            var collapsed = before.start === before.end && after.start === after.end;
            var adjacent = lastEdit && lastEdit.end === before.start;
            var canGroup = groupable && collapsed && adjacent && lastEdit.inputType === inputType &&
                lastEdit.historyIndex === historyIndex && now - lastEdit.time <= editGroupTimeout &&
                history[historyIndex].content === before.content;

            history[historyIndex] = before;
            if (canGroup) {
                history[historyIndex] = after;
            } else {
                history = history.slice(0, historyIndex + 1);
                history.push(after);
                historyIndex++;
                if (history.length > maxUndoLevels + 1) {
                    history.shift();
                    historyIndex--;
                }
            }

            lastEdit = groupable && collapsed ? {
                inputType: inputType,
                end: after.end,
                historyIndex: historyIndex,
                time: now
            } : null;
        }

        function applyHistory(state) {
            normalizing = true;
            render(state.content, { start: state.start, end: state.end });
            normalizing = false;
            dirty = state.content !== originalContent;
            updateTitle();
        }

        function undo() {
            pendingInput = null;
            breakEditGroup();
            if (historyIndex === 0) return;
            historyIndex--;
            applyHistory(history[historyIndex]);
        }

        function redo() {
            pendingInput = null;
            breakEditGroup();
            if (historyIndex >= history.length - 1) return;
            historyIndex++;
            applyHistory(history[historyIndex]);
        }

        function changeContent(content, start, end, inputType) {
            var before = currentState();
            var after = historyState(content, { start: start, end: end });
            recordChange(before, after, inputType, false);
            dirty = content !== originalContent;
            updateTitle();
            normalizing = true;
            render(content, { start: start, end: end });
            normalizing = false;
        }

        function indentSelection(outdent) {
            var content = editorContent();
            var selection = selectionOffsets(content);
            var start = Math.min(selection.start, selection.end);
            var end = Math.max(selection.start, selection.end);
            var firstLine = lineIndexAt(content, start);
            var lastLine = lineIndexAt(content, end > start && content[end - 1] === '\n' ? end - 1 : end);
            var lines = content.split('\n');
            var changes = [];

            for (var index = firstLine; index <= lastLine; index++) {
                var change = 0;
                if (outdent) {
                    var whitespace = lines[index].match(/^\s*/)[0];
                    change = Math.min(indentUnit.length, whitespace.length);
                    lines[index] = lines[index].slice(change);
                    change = -change;
                } else {
                    lines[index] = indentUnit + lines[index];
                    change = indentUnit.length;
                }
                changes[index] = change;
            }

            function updatedOffset(offset) {
                var lineIndex = lineIndexAt(content, offset);
                var column = offset - lineStart(content, offset);
                var updated = offset;
                for (var changedLine = firstLine; changedLine < lineIndex; changedLine++) {
                    updated += changes[changedLine];
                }
                if (changes[lineIndex]) {
                    updated += changes[lineIndex] > 0 ? changes[lineIndex] : Math.max(changes[lineIndex], -column);
                }
                return Math.max(0, updated);
            }

            var updatedStart = updatedOffset(start);
            var updatedEnd = updatedOffset(end);
            if (start === end) updatedEnd = updatedStart;
            changeContent(lines.join('\n'), updatedStart, updatedEnd, outdent ? 'outdent' : 'indent');
        }

        function insertNewline() {
            var content = editorContent();
            var selection = selectionOffsets(content);
            var start = Math.min(selection.start, selection.end);
            var end = Math.max(selection.start, selection.end);
            var lineBeginning = lineStart(content, start);
            var before = content.slice(lineBeginning, start);
            var lineEnd = content.indexOf('\n', end);
            var after = content.slice(end, lineEnd === -1 ? content.length : lineEnd);
            var baseIndent = (before.match(/^\s*/) || [''])[0];
            var indent = baseIndent;
            if (/[{[(]\s*$/.test(before)) indent += indentUnit;
            var insertion = '\n' + indent;
            if (/^\s*[})\]]/.test(after)) insertion += '\n' + baseIndent;
            var updated = content.slice(0, start) + insertion + content.slice(end);
            var cursor = start + 1 + indent.length;
            changeContent(updated, cursor, cursor, 'newline');
        }

        function outdentBeforeCursor() {
            var content = editorContent();
            var selection = selectionOffsets(content);
            if (selection.start !== selection.end) return false;
            var start = selection.start;
            var prefix = content.slice(lineStart(content, start), start);
            if (!/^\s+$/.test(prefix)) return false;
            var remove = Math.min(indentUnit.length, prefix.length);
            var updated = content.slice(0, start - remove) + content.slice(start);
            changeContent(updated, start - remove, start - remove, 'outdent');
            return true;
        }

        function moveCaretVertically(direction, shiftKey) {
            var content = editorContent();
            var selection = selectionOffsets(content);
            var lines = content.split('\n');
            var currentLine = lineIndexAt(content, selection.end);
            var lineStartOffset = lineStart(content, selection.end);
            var column = selection.end - lineStartOffset;
            var targetLine = currentLine + direction;
            if (targetLine < 0 || targetLine >= lines.length) return false;
            var targetColumn = Math.min(column, lines[targetLine].length);
            var targetOffset = 0;
            for (var i = 0; i < targetLine; i++) targetOffset += lines[i].length + 1;
            targetOffset += targetColumn;
            if (shiftKey) {
                restoreSelection(content, selection.start, targetOffset);
            } else {
                restoreSelection(content, targetOffset, targetOffset);
            }
            scrollLineIntoView(targetLine);
            return true;
        }

        function firstFullyVisibleLine() {
            var lines = text.querySelectorAll('.preview-line');
            var bodyBounds = body.getBoundingClientRect();
            for (var index = 0; index < lines.length; index++) {
                var lineBounds = lines[index].getBoundingClientRect();
                if (lineBounds.top >= bodyBounds.top && lineBounds.bottom <= bodyBounds.bottom) return index;
            }
            return 0;
        }

        function lastFullyVisibleLine() {
            var lines = text.querySelectorAll('.preview-line');
            var bodyBounds = body.getBoundingClientRect();
            for (var index = lines.length - 1; index >= 0; index--) {
                var lineBounds = lines[index].getBoundingClientRect();
                if (lineBounds.top >= bodyBounds.top && lineBounds.bottom <= bodyBounds.bottom) return index;
            }
            return lines.length - 1;
        }

        function moveCaretToLine(lineIndex, shiftKey) {
            var content = editorContent();
            var selection = selectionOffsets(content);
            var lines = content.split('\n');
            var column = selection.end - lineStart(content, selection.end);
            var targetOffset = 0;
            for (var index = 0; index < lineIndex; index++) targetOffset += lines[index].length + 1;
            targetOffset += Math.min(column, lines[lineIndex].length);
            restoreSelection(content, shiftKey ? selection.start : targetOffset, targetOffset);
        }

        function pageUp(shiftKey) {
            var content = editorContent();
            var selection = selectionOffsets(content);
            var visibleLine = firstFullyVisibleLine();
            if (lineIndexAt(content, selection.end) === visibleLine && body.scrollTop > 0) {
                body.scrollTop = Math.max(0, body.scrollTop - body.clientHeight);
                visibleLine = firstFullyVisibleLine();
            }
            moveCaretToLine(visibleLine, shiftKey);
        }

        function pageDown(shiftKey) {
            var content = editorContent();
            var selection = selectionOffsets(content);
            var visibleLine = lastFullyVisibleLine();
            var maxScrollTop = body.scrollHeight - body.clientHeight;
            if (lineIndexAt(content, selection.end) === visibleLine && body.scrollTop < maxScrollTop) {
                body.scrollTop = Math.min(maxScrollTop, body.scrollTop + body.clientHeight);
                visibleLine = lastFullyVisibleLine();
            }
            moveCaretToLine(visibleLine, shiftKey);
        }

        function moveCaretHorizontally(direction, shiftKey) {
            var content = editorContent();
            var selection = selectionOffsets(content);
            var targetOffset;
            if (shiftKey) {
                targetOffset = Math.max(0, Math.min(content.length, selection.end + direction));
                restoreSelection(content, selection.start, targetOffset);
                return;
            }
            if (selection.start !== selection.end) {
                targetOffset = direction < 0 ? Math.min(selection.start, selection.end) : Math.max(selection.start, selection.end);
            } else {
                targetOffset = Math.max(0, Math.min(content.length, selection.end + direction));
            }
            restoreSelection(content, targetOffset, targetOffset);
        }

        function handleEditorKeydown(event) {
            if (!text.isContentEditable || (!text.contains(event.target) && document.activeElement !== text)) return;
            var key = event.key.toLowerCase();
            if ((event.ctrlKey || event.metaKey) && key === 'z') {
                event.preventDefault();
                if (event.shiftKey) redo();
                else undo();
            } else if (event.ctrlKey && key === 'r') {
                event.preventDefault();
                redo();
            } else if (event.key === 'Tab') {
                event.preventDefault();
                indentSelection(event.shiftKey);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                insertNewline();
            } else if (event.key === 'Backspace' && outdentBeforeCursor()) {
                event.preventDefault();
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                breakEditGroup();
                moveCaretVertically(-1, event.shiftKey);
            } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                breakEditGroup();
                moveCaretVertically(1, event.shiftKey);
            } else if (event.key === 'ArrowLeft' && !event.ctrlKey && !event.metaKey && !event.altKey) {
                event.preventDefault();
                breakEditGroup();
                moveCaretHorizontally(-1, event.shiftKey);
            } else if (event.key === 'ArrowRight' && !event.ctrlKey && !event.metaKey && !event.altKey) {
                event.preventDefault();
                breakEditGroup();
                moveCaretHorizontally(1, event.shiftKey);
            } else if (event.key === 'PageUp') {
                event.preventDefault();
                breakEditGroup();
                pageUp(event.shiftKey);
            } else if (event.key === 'PageDown') {
                event.preventDefault();
                breakEditGroup();
                pageDown(event.shiftKey);
            } else if (['Home', 'End'].indexOf(event.key) !== -1) {
                breakEditGroup();
            }
        }

        function requestHeaders() {
            var auth = options.getAuth() || { nonce: '', sig: '' };
            return { 'X-Webtermd-Nonce': auth.nonce, 'X-Webtermd-Signature': auth.sig };
        }

        function saveContent() {
            var content = editorContent();
            if (languageFor(path) === 'json') {
                try {
                    JSON.parse(content);
                } catch (exception) {
                    options.showError('Save: ' + (exception.message || 'Invalid JSON'));
                    return;
                }
            }
            if (isWritable) {
                save.disabled = true;
                var headers = requestHeaders();
                headers['Content-Type'] = 'application/json';
                fetch(options.basePath + '/files/' + encodeURIComponent(path) + '?path=' + encodeURIComponent(cwd), {
                    method: 'PUT', headers: headers,
                    body: JSON.stringify({ content: content })
                }).then(function (response) {
                    if (response.ok) return response.json();
                    return response.json().then(function (result) {
                        return Promise.reject(new Error(result.error || 'save failed'));
                    });
                }).then(function () {
                    originalContent = content;
                    dirty = false;
                    updateTitle();
                    save.textContent = 'Saved';
                    options.onSaved();
                }).catch(function (exception) {
                    options.showError('Save: ' + exception.message);
                }).finally(function () {
                    save.disabled = false;
                    setTimeout(function () { save.textContent = 'Save'; }, 1200);
                });
            } else {
                // Sudo save — open the sudo terminal popover.
                save.disabled = true;
                options.onSudoSave(path, cwd, content);
                save.disabled = false;
            }
        }

        function blinkSave() {
            save.classList.remove('blink');
            void save.offsetWidth;
            save.classList.add('blink');
        }

        document.addEventListener('keydown', handleEditorKeydown, true);
        text.addEventListener('pointerdown', breakEditGroup);
        text.addEventListener('paste', function (event) {
            if (!text.isContentEditable) return;
            event.preventDefault();
            pendingInput = null;
            var pasted = (event.clipboardData || window.clipboardData).getData('text/plain');
            if (!pasted) return;
            var content = editorContent();
            var selection = selectionOffsets(content);
            var start = Math.min(selection.start, selection.end);
            var end = Math.max(selection.start, selection.end);
            var updated = content.slice(0, start) + pasted + content.slice(end);
            var cursor = start + pasted.length;
            changeContent(updated, cursor, cursor, 'insertFromPaste');
        });
        text.addEventListener('beforeinput', function (event) {
            if (normalizing) return;
            pendingInput = {
                state: currentState(),
                inputType: event.inputType || 'input'
            };
        });
        text.addEventListener('input', function (event) {
            if (normalizing) return;
            var content = renderedContent();
            var selection = selectionOffsets(content);
            var before = pendingInput ? pendingInput.state : history[historyIndex];
            var inputType = pendingInput ? pendingInput.inputType : event.inputType || 'input';
            pendingInput = null;
            recordChange(before, historyState(content, selection), inputType, isGroupableInput(inputType));
            dirty = content !== originalContent;
            updateTitle();
            normalizing = true;
            render(content, selection);
            normalizing = false;
        });
        closeBtn.addEventListener('click', closePreview);
        save.addEventListener('click', saveContent);
        modal.addEventListener('click', function (event) {
            if (event.target === modal) {
                if (dirty) blinkSave();
                else closePreview();
            }
        });
        this.open = function (name, data, currentCwd) {
            // Steal focus from the terminal so keystrokes don't reach the shell
            // while the preview is open.
            if (document.activeElement && document.activeElement.blur) {
                try { document.activeElement.blur(); } catch (e) { }
            }
            if (image.src.indexOf('blob:') === 0) URL.revokeObjectURL(image.src);
            image.removeAttribute('src');
            title.textContent = name;
            save.classList.remove('blink');
            textWrap.style.display = 'none';
            image.style.display = 'none';
            text.contentEditable = 'false';
            save.style.display = 'none';
            status.style.display = 'none';
            if (data && data.type === 'image') {
                path = '';
                cwd = '';
                dialog.className = 'preview-dialog image-preview';
                image.src = data.url;
                image.style.display = 'block';
            } else {
                path = name;
                cwd = currentCwd || '';
                dialog.className = 'preview-dialog text-preview';
                originalContent = data && data.content || '';
                dirty = false;
                updateTitle();
                resetHistory(originalContent);
                render(originalContent);
                textWrap.style.display = 'grid';
                status.style.display = 'block';
                text.contentEditable = 'true';
                save.style.display = '';
                isWritable = !!(data && data.writable);
                if (isWritable) {
                    save.textContent = 'Save';
                    save.classList.remove('sudo');
                } else {
                    save.textContent = 'Save (sudo)';
                    save.classList.add('sudo');
                }
            }
            // Fill the active terminal pane when available, else fall back to full-screen.
            var host = options && options.getContainer ? options.getContainer() : null;
            if (host && host.nodeType === 1) {
                modal.classList.add('in-pane');
                if (modal.parentNode !== host) host.appendChild(modal);
            } else {
                detachModal();
            }
            modal.classList.add('open');
        };

        this.close = closePreview;
        this.isOpen = function () {
            return modal.classList.contains('open');
        };
        this.modal = modal;
    }

    window.WebtermdTextEditor = TextEditor;
}());