(function(){
  /* IDs of buttons we injected — never remove these */
  var OWN_IDS = ['__cb_readaloud_btn', '__cb_stt_mic', '__cb_monitor_btn', '__cb_black_edition_label'];

  function killUnwanted() {
    document.querySelectorAll('button, [role="button"]').forEach(function(el) {
      if (OWN_IDS.indexOf(el.id) !== -1) return; // never touch our own buttons

      var txt   = (el.innerText || el.textContent || '').toLowerCase().trim();
      var label = (el.getAttribute('aria-label') || '').toLowerCase();
      var title = (el.getAttribute('title') || '').toLowerCase();

      // Kill bypass permissions button
      if (txt.includes('bypass')) { el.remove(); return; }

      // Kill native Claude Code TTS/audio buttons
      if (label.includes('audio') || label.includes('sound') || label.includes('speak') ||
          label.includes('tts')   || label.includes('read aloud')) { el.remove(); return; }

      // Kill old claude-voice speech bubble / mic buttons (not our injected ones)
      if (el.id === '__cv_mic_btn' || el.id === '__cv_voice_btn') { el.remove(); return; }
      if (title.includes('voice input') || title.includes('start recording') ||
          label.includes('voice input') || label.includes('start recording')) { el.remove(); return; }

      // Kill chat-bubble emoji buttons injected by old claude-voice
      if ((txt === '💬' || txt === '🔴' || txt === '❌') && el.id !== '__cb_readaloud_btn') {
        el.remove(); return;
      }
    });
  }
  killUnwanted();
  if (window.__cbBypassObs) window.__cbBypassObs.disconnect();
  window.__cbBypassObs = new MutationObserver(killUnwanted);
  window.__cbBypassObs.observe(document.body, { childList: true, subtree: true });
})();
