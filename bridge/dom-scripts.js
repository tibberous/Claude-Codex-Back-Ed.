/* Page-side JS templates injected via CDP Runtime.evaluate.
 *
 * Selector lists are copied/distilled from SuperGrok (C:/SuperGrok/supergrok_bridge/app.py)
 * which has the battle-tested versions. Update here when grok.com or chatgpt.com
 * changes their DOM.
 *
 * Every template returns a JSON-serializable result. Page-side throws are caught
 * by CDP and surfaced as exceptions on the Node side.
 */

/* Editor selectors (where the user types the prompt). Order matters — first hit wins. */
const EDITOR_SELECTORS = [
    '#prompt-textarea',
    'textarea#prompt-textarea',
    'div#prompt-textarea[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="Ask"]',
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
];

/* Send-button selectors. Order matters. */
const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send"]',
    'button[type="submit"]',
    'form button:last-of-type',
];

/** Build the inject-prompt-and-submit script. */
function buildSendScript(target, text) {
    const json = JSON.stringify(text);
    const sels = JSON.stringify(EDITOR_SELECTORS);
    const sends = JSON.stringify(SEND_SELECTORS);
    return `(() => {
        const T = ${JSON.stringify(target)};
        const TEXT = ${json};
        const EDITORS = ${sels};
        const SENDS = ${sends};
        function findEditor() {
            for (const sel of EDITORS) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    if (!el || el.disabled || el.readOnly) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < 20 || r.height < 12) continue;
                    return el;
                }
            }
            return null;
        }
        const editor = findEditor();
        if (!editor) return { ok: false, error: 'editor not found' };
        const tag = editor.tagName.toLowerCase();
        editor.focus();
        if (tag === 'textarea' || tag === 'input') {
            const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value') &&
                           Object.getOwnPropertyDescriptor(proto, 'value').set;
            if (setter) setter.call(editor, TEXT);
            else editor.value = TEXT;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (editor.isContentEditable) {
            /* Clear existing content then insert. execCommand is deprecated but works
               on both grok.com and chatgpt.com's React/ProseMirror editors. */
            const range = document.createRange();
            range.selectNodeContents(editor);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            try { document.execCommand('insertText', false, TEXT); }
            catch (e) {
                editor.textContent = TEXT;
                editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: TEXT, inputType: 'insertText' }));
            }
        } else {
            return { ok: false, error: 'editor unsupported tag: ' + tag };
        }
        /* Find an enabled send button; click it. Fall back to Enter keydown. */
        let btn = null;
        for (const sel of SENDS) {
            const cand = document.querySelectorAll(sel);
            for (const b of cand) {
                if (!b.disabled && b.offsetParent !== null) { btn = b; break; }
            }
            if (btn) break;
        }
        if (btn) {
            btn.click();
            return { ok: true, via: 'click', tag };
        }
        /* Enter-key fallback */
        const ev = new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true,
        });
        editor.dispatchEvent(ev);
        return { ok: true, via: 'enter', tag };
    })();`;
}

/** Build the read-latest-assistant-reply script. Returns { text, done, authBlocked }. */
function buildReadScript(target) {
    return `(() => {
        const T = ${JSON.stringify(target)};
        const url = String(location.href || '').toLowerCase();
        const bodyText = (document.body && document.body.innerText || '').toLowerCase();
        const isAuth = /\\/(login|signin|auth|oauth|captcha)([/?#]|$)/.test(url) ||
            /accounts\\.google\\.com|auth\\.openai\\.com|accounts\\.x\\.ai/.test(url);
        if (isAuth) return { text: '', done: false, authBlocked: true, where: 'url' };
        /* Some pages render a tiny "Sign in to continue" body without redirecting */
        if (bodyText.length < 400 &&
            /(sign in to continue|log in to continue|please sign in|continue with google|captcha)/.test(bodyText)) {
            return { text: '', done: false, authBlocked: true, where: 'body' };
        }

        let nodes;
        if (T === 'chatgpt') {
            nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
        } else {
            /* Grok — best-effort. Their DOM mutates often; falling back to the last
               .message-bubble / role=assistant / data-testid pattern. */
            const candidates = [
                '[data-testid*="message"][data-testid*="assistant"]',
                '[data-message-author-role="assistant"]',
                '.message-bubble.assistant',
                '.message-bubble:not(.user)',
                'article[data-message-author-role]',
            ];
            for (const sel of candidates) {
                const got = document.querySelectorAll(sel);
                if (got.length) { nodes = got; break; }
            }
        }
        if (!nodes || !nodes.length) return { text: '', done: false };
        const last = nodes[nodes.length - 1];
        let text = (last.innerText || '').trim();

        /* Strip the leading speaker tag chat UIs sometimes inject. */
        text = text.replace(/^(ChatGPT|Grok|Claude)\\s+said:\\s*/i, '');
        /* Strip footer disclaimers. */
        text = text.replace(/\\n(ChatGPT|Grok) can make mistakes[\\s\\S]*$/i, '').trim();

        /* "Done" = no stop-generating button is visible. Both ChatGPT and Grok
           toggle the send button to a stop button while streaming. */
        const stopBtn = document.querySelector(
            'button[aria-label*="Stop"], button[aria-label*="stop generating"], button[data-testid="stop-button"]'
        );
        const sendBtn = document.querySelector(
            'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Send"]'
        );
        const done = !stopBtn && !!sendBtn;
        return { text, done, authBlocked: false, count: nodes.length };
    })();`;
}

/** Script that just reports the URL + a brief auth probe. Used by openWebLogin. */
function buildPingScript() {
    return `(() => {
        const url = String(location.href || '');
        const lower = url.toLowerCase();
        const isAuth = /\\/(login|signin|auth|oauth|captcha)([/?#]|$)/.test(lower) ||
            /accounts\\.google\\.com|auth\\.openai\\.com|accounts\\.x\\.ai/.test(lower);
        return { url, authVisible: isAuth, ready: document.readyState };
    })();`;
}

module.exports = { buildSendScript, buildReadScript, buildPingScript };
