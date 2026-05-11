(function(){
  // Kill only intervals that were created before our injects loaded.
  // Strategy: capture the current max interval ID, then clear everything
  // below a safe threshold EXCEPT our own known intervals.
  var keep = [
    window.__cbBlackEditionInterval,
    window.__cbRedStopInterval,
    window.__cbMicOverrideInterval,
    window.__cbCanvasInterval,
    window.__cbMicBtnInterval,
    window.__cbSkinLoaderInterval,
  ];

  // Create a throwaway interval to get the current high-water ID
  var probe = setInterval(function(){}, 99999);
  clearInterval(probe);

  // Only kill intervals that are well below the probe ID (old ones)
  // and not in our keep list. Leave injector bootstrap interval alone.
  var threshold = probe - 200; // anything older than 200 IDs ago
  for (var i = 1; i < threshold; i++) {
    if (keep.indexOf(i) === -1) clearInterval(i);
  }

  console.error('[kill-old-poll] cleared stale intervals below id=' + threshold);
})();
