(function () {

    function TextEditor(options) {
        var modal = document.getElementById('preview-modal');
        var title = document.getElementById('preview-title');
        var textWrap = document.getElementById('preview-text-wrap');
        var text = document.getElementById('preview-text');
        var image = document.getElementById('preview-img');
        var dialog = document.getElementById('preview-dialog');
        var body = document.getElementById('preview-body');
        var save = document.getElementById('preview-save');
        var status = document.getElementById('preview-status');
        var path = '';
        var cwd = '';
        var originalContent = '';
        var dirty = false;
        var normalizing = false;
        var indentUnit = '    ';

        function closePreview() {
            if (image.src.indexOf('blob:') === 0) URL.revokeObjectURL(image.src);
            image.removeAttribute('src');
            modal.classList.remove('open');
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
                status.textContent = 'Indent: tabs';
            } else {
                indentUnit = new Array((smallestSpaceIndent || 4) + 1).join(' ');
                status.textContent = 'Indent: spaces: ' + indentUnit.length;
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
            var range = document.createRange();
            var startPoint = pointAtOffset(content, start);
            var endPoint = pointAtOffset(content, end);
            range.setStart(startPoint.node, startPoint.offset);
            range.setEnd(endPoint.node, endPoint.offset);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        function render(content, selection) {
            var scrollTop = body.scrollTop;
            var scrollLeft = body.scrollLeft;
            var lines = content.split('\n');
            var lang = content && window.hljs ? languageFor(path) : null;
            detectIndent(content);
            text.className = lang && hljs.getLanguage(lang) ? 'hljs' : '';
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

        function changeContent(content, start, end) {
            dirty = true;
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
            changeContent(lines.join('\n'), updatedStart, updatedEnd);
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
            changeContent(updated, cursor, cursor);
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
            changeContent(updated, start - remove, start - remove);
            return true;
        }

        function handleEditorKeydown(event) {
            if (!text.isContentEditable || (!text.contains(event.target) && document.activeElement !== text)) return;
            if (event.key === 'Tab') {
                event.preventDefault();
                indentSelection(event.shiftKey);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                insertNewline();
            } else if (event.key === 'Backspace' && outdentBeforeCursor()) {
                event.preventDefault();
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
                save.textContent = 'Saved';
                options.onSaved();
            }).catch(function (exception) {
                options.showError('Save: ' + exception.message);
            }).finally(function () {
                save.disabled = false;
                setTimeout(function () { save.textContent = 'Save'; }, 1200);
            });
        }

        document.addEventListener('keydown', handleEditorKeydown, true);
        text.addEventListener('input', function () {
            if (normalizing) return;
            dirty = true;
            var content = renderedContent();
            var selection = selectionOffsets(content);
            normalizing = true;
            render(content, selection);
            normalizing = false;
        });
        document.getElementById('preview-close').addEventListener('click', closePreview);
        save.addEventListener('click', saveContent);
        modal.addEventListener('click', function (event) {
            if (event.target === modal) closePreview();
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && modal.classList.contains('open')) closePreview();
        });

        this.open = function (name, data, currentCwd) {
            if (image.src.indexOf('blob:') === 0) URL.revokeObjectURL(image.src);
            image.removeAttribute('src');
            title.textContent = name;
            textWrap.style.display = 'none';
            image.style.display = 'none';
            text.contentEditable = 'false';
            save.style.display = 'none';
            status.style.display = 'none';
            if (data && data.type === 'image') {
                path = '';
                cwd = '';
                dialog.className = 'image-preview';
                image.src = data.url;
                image.style.display = 'block';
            } else {
                path = name;
                cwd = currentCwd || '';
                dialog.className = 'text-preview';
                originalContent = data && data.content || '';
                dirty = false;
                render(originalContent);
                textWrap.style.display = 'grid';
                status.style.display = 'block';
                if (data && data.writable) {
                    text.contentEditable = 'true';
                    save.style.display = '';
                }
            }
            modal.classList.add('open');
        };
    }

    window.WebtermdTextEditor = TextEditor;
}());