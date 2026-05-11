(function(){
  var LOG = 'http://127.0.0.1:57836';
  function log(m){ fetch(LOG,{method:'POST',mode:'no-cors',body:'[click-trace] '+String(m)}); }

  document.addEventListener('click', function(e){
    var t = e.target;
    var info = t.tagName + ' id=' + (t.id||'none') + ' title=' + (t.title||'none') + ' type=' + (t.type||'none');
    log(info);
  }, true); // capture phase — catches everything

  log('click tracer installed');
})();
