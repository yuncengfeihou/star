// ui/iframes.js - HTML 代码块的 iframe 渲染
//
// 独立成叶子模块的原因：收藏面板（ui/main.js）与预览模式（ui/preview.js）都要用它，
// 而二者互相依赖（面板能进预览、预览能开面板）。此前 preview.js 用 `await import('./main.js')`
// 绕过循环依赖，现在双方改为静态导入本模块，循环依赖随之消失。
//
// 行为：把消息正文中的 <pre>（HTML 代码块）替换为自适应高度的 iframe，
// 并在 iframe 内注入桥接脚本，让代码块里的 window.parent 能力可用。

import Logger from '../Logger.js';

/**
 * 渲染容器内所有 HTML 代码块为 iframe。
 * @param {JQuery} $container
 */
export function renderIframesInElement($container) {
    if (!$container || !$container.length) return;

    $container.find('pre').each(function() {
        const $pre = $(this);
        let codeContent = $pre.text();

        if (codeContent.includes('<body') && codeContent.includes('</body>')) {
            const bridgeScript = `
            <script>
                (function() {
                    try {
                        const functionsToBridge = [
                            'getChatMessages', 'setChatMessages', 'createChatMessages', 'deleteChatMessages',
                            'getContext', 'toastr', 'log', 'jQuery', '$', '_'
                        ];
                        functionsToBridge.forEach(function(funcName) {
                            if (window.parent && typeof window.parent[funcName] !== 'undefined') {
                                window[funcName] = window.parent[funcName];
                            }
                        });
                    } catch (e) {
                        console.error('Tavern Star Plugin Bridge Script Error:', e);
                    }
                })();
            <\/script>`;   // eslint-disable-line no-useless-escape -- 保留 \/ ：模板会作为 iframe 的 HTML 内容解析，未转义的 </script> 可能提前结束脚本标签

            const headTagMatch = codeContent.match(/<head\s*>/i);
            if (headTagMatch) {
                const injectionPoint = headTagMatch.index + headTagMatch[0].length;
                codeContent = codeContent.slice(0, injectionPoint) + bridgeScript + codeContent.slice(injectionPoint);
            } else {
                codeContent = bridgeScript + codeContent;
            }

            const $iframe = $('<iframe>');
            $iframe.css({ 'width': '100%', 'border': 'none', 'margin': '5px 0', 'display': 'block', 'overflow': 'hidden' });
            $iframe.attr('srcdoc', codeContent);
            $iframe.on('load', function() {
                const iframe = this;
                try {
                    const contentWindow = iframe.contentWindow;
                    if (!contentWindow) return;
                    const style = contentWindow.document.createElement('style');
                    style.innerHTML = 'body { margin: 0; overflow: hidden; }';
                    if (contentWindow.document.head) contentWindow.document.head.appendChild(style);
                    const body = contentWindow.document.body;
                    if (!body) return;
                    const updateHeight = () => { $(iframe).css('height', body.scrollHeight + 'px'); };
                    const observer = new ResizeObserver(updateHeight);
                    observer.observe(body);
                    updateHeight();
                } catch (e) {
                    Logger.error("Error setting up iframe resizer:", e);
                    setTimeout(() => {
                        if (iframe.contentWindow && iframe.contentWindow.document.body) {
                            $(iframe).css('height', iframe.contentWindow.document.body.scrollHeight + 'px');
                        }
                    }, 200);
                }
            });
            $pre.replaceWith($iframe);
        }
    });
}
