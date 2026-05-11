/* chat-logger.js — capture user messages + Claude responses to chat.log
 * via CBE log server POST /chat (port 57836).
 *
 * Body format:  ROLE\tMESSAGE   where ROLE ∈ {USER, CLAUDE, SYSTEM}
 *
 * Capture strategy:
 *  - USER:   listen for Enter key on the contenteditable, OR click on the send button.
 *            Read .messageInput_cKsPxg text right before submission.
 *  - CLAUDE: MutationObserver on the messages container; when a new assistant message
 *            node is added (or its text content stabilizes), POST it.
 *
 * Dedupe by hashed (role + text) to avoid double-posting on DOM churn.
 */
(function(){
  if (window.__cbChatLoggerLoaded) return;
  window.__cbChatLoggerLoaded = true;

  var LOG_URL = 'http://127.0.0.1:57836/chat';
  var seen = new Set();

  function post(role, text) {
    if (!text || !text.trim()) return;
    var key = role + ':' + text.slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    /* trim the dedupe set so it can't grow forever */
    if (seen.size > 2000) seen = new Set(Array.from(seen).slice(-1000));
    try {
      fetch(LOG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: role + '\t' + text,
      }).catch(function(){});
    } catch (e) {}
  }
  window.__cbChatLog = post;

  /* ── USER capture ── */
  function attachUserCapture() {
    var inputs = document.querySelectorAll('[class*="messageInput"],[class*="MessageInput"]');
    inputs.forEach(function(inp) {
      if (inp.__cbChatHooked) return;
      inp.__cbChatHooked = true;
      inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          var text = (inp.innerText || inp.textContent || '').trim();
          if (text) post('USER', text);
        }
      }, true);
    });
    /* also catch send-button clicks */
    document.querySelectorAll('button[type="submit"],button[aria-label*="Send" i]').forEach(function(btn) {
      if (btn.__cbChatHooked) return;
      btn.__cbChatHooked = true;
      btn.addEventListener('click', function() {
        var inp = document.querySelector('[class*="messageInput"],[class*="MessageInput"]');
        if (inp) {
          var text = (inp.innerText || inp.textContent || '').trim();
          if (text) post('USER', text);
        }
      }, true);
    });
  }

  /* ── CLAUDE capture ──
     Look for nodes with class hints: message, assistant, claude.
     Stabilize: wait 800ms after last text change before logging. */
  var pending = new Map();
  function scheduleLog(node) {
    if (pending.has(node)) clearTimeout(pending.get(node));
    pending.set(node, setTimeout(function() {
      pending.delete(node);
      var text = (node.innerText || node.textContent || '').trim();
      if (text) post('CLAUDE', text);
    }, 800));
  }

  function maybeAssistant(node) {
    if (!(node instanceof HTMLElement)) return false;
    var cls = (node.className || '') + '';
    return /assistant|claude|markdown|message/i.test(cls) &&
           !/user|input|composer|inputContainer/i.test(cls);
  }

  function walkAndWatch(root) {
    if (!root || !(root instanceof HTMLElement)) return;
    if (maybeAssistant(root)) scheduleLog(root);
    /* nodes will mutate as Claude streams — observe children for character data */
    if (!root.__cbChatObs) {
      var obs = new MutationObserver(function(muts) {
        muts.forEach(function(m) {
          if (m.type === 'characterData' || m.type === 'childList') {
            scheduleLog(root);
          }
        });
      });
      obs.observe(root, { childList: true, subtree: true, characterData: true });
      root.__cbChatObs = obs;
    }
  }

  function scanForAssistantMessages() {
    var container = document.querySelector('[class*="messagesContainer"]');
    if (!container) return;
    container.querySelectorAll('[class*="message"],[class*="assistant"],[class*="markdown"]').forEach(walkAndWatch);
  }

  /* boot + re-scan on DOM changes */
  attachUserCapture();
  scanForAssistantMessages();

  if (window.__cbChatRootObs) window.__cbChatRootObs.disconnect();
  window.__cbChatRootObs = new MutationObserver(function() {
    attachUserCapture();
    scanForAssistantMessages();
  });
  window.__cbChatRootObs.observe(document.body, { childList: true, subtree: true });
})();
