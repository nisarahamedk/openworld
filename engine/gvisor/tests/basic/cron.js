const t0 = performance.now(), d0 = Date.now(); let n = 0, maxLate = 0;
const iv = setInterval(() => { n++; const el = performance.now() - t0; maxLate = Math.max(maxLate, el - n*3600e3);
  if (n === 720) { clearInterval(iv); console.log(`node ticks=${n} day=${(el/86400e3).toFixed(4)} maxLate=${maxLate.toFixed(3)}ms dateDrift=${(Date.now()-d0-el).toFixed(1)}ms`); } }, 3600e3);
setTimeout(() => console.log(`node 17-day timeout at day ${((performance.now()-t0)/86400e3).toFixed(4)}`), 17*86400e3);
