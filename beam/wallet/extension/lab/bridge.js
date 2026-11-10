// The Bridge lab: the switch worked on alone (two cards, their amounts, the networks' dots between them); made-up
// figures, nothing is sent. It moves into the wallet's Bridge tab once it is right.
(() => {
  const $ = (id) => document.getElementById(id);
  const sep = (x) => x.replace(/,/g, '\u2060\u2009\u2060');
  const num = (x) => sep(x.toLocaleString('en-US', { maximumFractionDigits: 8 }));
  const FEE = { toEth: 22.82, fromEth: 0.02 };          // made up: what the relayer takes each way
  let dir = 'toEth';
  const wd = BB.dropdown($('walletDd'), () => {}); wd.options([{ v: 'p', label: 'Personal' }], 'p');
  function calc() {
    const t = $('bxAmt').value.trim().replace(',', '.'), s = /^\d*\.?\d*$/.test(t) && t && t !== '.' ? Number(t) : 0;
    const get = Math.max(0, s - FEE[dir]);
    $('bxGet').textContent = get > 0 ? num(get) : '0';
    $('bxGet').classList.toggle('dim', !(get > 0));
  }
  $('bxAmt').oninput = calc;
  $('bxSwap').onclick = () => { dir = dir === 'toEth' ? 'fromEth' : 'toEth'; $('bxSwap').classList.toggle('back', dir !== 'toEth'); $('bxAmt').value = ''; calc(); };
  calc();
})();
