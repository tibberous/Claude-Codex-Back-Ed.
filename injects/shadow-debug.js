(function(){
  var LOG = 'http://127.0.0.1:57836';
  function log(m){ try{fetch(LOG,{method:'POST',mode:'no-cors',body:'[shadow] '+String(m)});}catch(e){} }

  setTimeout(function() {
    // Check for chat-related elements
    var checks = {
      'submit btn':    document.querySelectorAll('button[type="submit"]').length,
      'contenteditable': document.querySelectorAll('[contenteditable]').length,
      'textarea':      document.querySelectorAll('textarea').length,
      'role=textbox':  document.querySelectorAll('[role="textbox"]').length,
      'data-testid':   document.querySelectorAll('[data-testid]').length,
      'all divs':      document.querySelectorAll('div').length,
      'all buttons':   document.querySelectorAll('button').length,
      'iframes':       document.querySelectorAll('iframe').length,
    };
    log('counts: ' + JSON.stringify(checks));

    // Log first 10 button titles
    var btns = document.querySelectorAll('button');
    var titles = Array.from(btns).slice(0,10).map(function(b){ return (b.title||b.textContent||'').slice(0,20).trim(); });
    log('btn titles: ' + titles.join(' | '));

    // Log document title and URL
    log('doc.title=' + document.title + ' url=' + location.href.slice(0,80));
  }, 2000);
})();
