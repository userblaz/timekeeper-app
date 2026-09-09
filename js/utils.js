// Small, dependency-free helper functions used across the app.
function uid(){ return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function daysBetween(d1, d2){
  const a = new Date(d1 + 'T00:00:00');
  const b = new Date(d2 + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

function fmtRate(r){
  const sign = r > 0 ? '+' : '';
  return sign + r.toFixed(1);
}

function todayStr(){
  const d = trueNow();
  return d.toISOString().slice(0,10);
}


function formatShortDate(dateStr){
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', {month:'short', day:'numeric'});
}


function escapeHtml(s){
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function pad2(n){ return String(n).padStart(2,'0'); }
