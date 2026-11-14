import qrcode from 'https://esm.sh/qrcode-generator@1.4.4';
import { decodeTransaction, hexToBin, hash160, decodeCashAddress, encodeCashAddress } from 'https://esm.sh/@bitauth/libauth@3.0.0';
import { currentNet, providerFor, fmtBch, parseBch } from '../src/net.js';
import { tandaContract, readTanda, buildPayout, buildGenesis, buildFromWallet, buildConsolidate } from '../src/tanda.js';
import { tandaLink, tandaFromHash } from '../src/share.js';

const $ = (s) => document.querySelector(s);
const net = currentNet();
const provider = providerFor(net);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => { const s = a.split(':').pop(); return `${s.slice(0, 6)}…${s.slice(-5)}`; };
const txLink = (id) => `<a href="${net.tx(id)}" target="_blank" rel="noopener">${id.slice(0, 10)}…</a>`;
const qrSvg = (text) => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
function status(el, msg, kind = '') { el.className = `status ${kind}`; el.innerHTML = msg; }

let wallet = null;

/* ---------- network chrome ---------- */
$('#net').textContent = net.name;
$('#net').classList.toggle('chip', net.name === 'chipnet');
document.querySelectorAll('.unit').forEach((e) => { e.textContent = net.unit; });
$('#netSwitch').textContent = net.name === 'chipnet' ? 'Switch to mainnet' : 'Try it on chipnet (test coins)';
$('#netSwitch').href = net.name === 'chipnet' ? './' : './?net=chipnet';
$('#home').href = net.name === 'chipnet' ? './?net=chipnet' : './';

/* ---------- wallet ---------- */
async function connectWc() {
  const { WcWallet } = await import('../src/wc.js');
  const w = new WcWallet(net);
  w.addEventListener('ready', () => { wallet = w; $('#wcDialog').close(); renderWallet(); refreshTanda(); });
  w.addEventListener('disconnect', () => { if (wallet === w) { wallet = null; renderWallet(); refreshTanda(); } });
  w.addEventListener('offline', () => { if (wallet === w) renderWallet(); });
  return w;
}

async function resumeWallet() {
  if (net.name === 'chipnet' && localStorage.getItem('tanda-test-wallet') === '1') {
    const { burnerWallet } = await import('../src/burner.js');
    wallet = burnerWallet('me');
    return;
  }
  try {
    const w = await connectWc();
    if (w.resume() && w.ready && w.address) wallet = w;
  } catch (e) { console.warn('WizardConnect resume failed', e); }
}

async function renderWallet() {
  const bar = $('#walletbar');
  if (!wallet) {
    bar.innerHTML = '<button class="primary" id="connect">Connect wallet</button>';
    $('#connect').onclick = openConnect;
  } else {
    bar.innerHTML = `<span class="small"><b>${esc(wallet.walletName || 'Wallet')}</b> <span class="addr" title="${esc(wallet.address)}">${short(wallet.address)}</span> · <span id="bal">…</span>${wallet.offline ? ' · <b class="offline" style="color:#c2410c" title="The wallet is not answering. Open it to reconnect, or disconnect here.">wallet offline: open it to reconnect</b>' : ''}</span><button id="disconnect">Disconnect</button>`;
    $('#disconnect').onclick = async () => { await wallet.disconnect(); localStorage.removeItem('tanda-test-wallet'); wallet = null; renderWallet(); refreshTanda(); };
    wallet.coins(provider).then((cs) => { const b = $('#bal'); if (b) b.textContent = fmtBch(cs.reduce((s, c) => s + c.satoshis, 0n), net.unit); })
      .catch(() => { const b = $('#bal'); if (b) b.textContent = 'balance unavailable'; });
  }
  $('#addMe').disabled = !wallet;
  validateForm();
}

let pending = null;
async function openConnect() {
  const d = $('#wcDialog');
  $('#testWalletBox').classList.toggle('hidden', net.name !== 'chipnet');
  status($('#wcStatus'), 'Preparing a secure connection…');
  $('#qr').innerHTML = '';
  d.showModal();
  try {
    pending = await connectWc();
    const uri = pending.pair();
    $('#qr').innerHTML = qrSvg(uri);
    $('#qr').dataset.uri = uri;
    $('#copyUri').onclick = () => navigator.clipboard.writeText(uri).then(() => status($('#wcStatus'), 'Copied.', 'ok'));
    status($('#wcStatus'), 'Waiting for your wallet…');
  } catch (e) { status($('#wcStatus'), `Could not start WizardConnect: ${esc(e.message)}`, 'err'); }
}
$('#connect').onclick = openConnect;
$('#closeDialog').onclick = () => $('#wcDialog').close();
$('#useTest').onclick = async () => {
  const { burnerWallet } = await import('../src/burner.js');
  wallet = burnerWallet('me');
  localStorage.setItem('tanda-test-wallet', '1');
  $('#wcDialog').close();
  renderWallet(); refreshTanda();
  status($('#wcStatus'), '');
};

// Sign with whichever wallet is connected, then broadcast. Returns the txid.
async function signAndSend({ tb, walletInputs }, prompt, statusEl) {
  status(statusEl, wallet.kind === 'test' ? 'Signing…' : 'Approve the transaction in your wallet…');
  const hex = await wallet.sign(tb, walletInputs, prompt);
  status(statusEl, 'Broadcasting…');
  return provider.sendRawTransaction(hex);
}

/* ---------- create ---------- */
let rows = [{ name: '', address: '' }, { name: '', address: '' }, { name: '', address: '' }];

function normAddress(a) {
  a = a.trim();
  if (!a) return null;
  if (!a.includes(':')) a = `${net.prefix}:${a}`;
  const d = decodeCashAddress(a);
  if (typeof d === 'string' || !/^p2pkh/.test(d.type) || d.prefix !== net.prefix) return null;
  return encodeCashAddress({ prefix: net.prefix, type: 'p2pkh', payload: d.payload }).address;
}

function renderRows() {
  $('#memberRows').innerHTML = rows.map((r, i) => `
    <div class="member">
      <span class="n">${i + 1}</span>
      <input aria-label="Name of member ${i + 1}" placeholder="Name" value="${esc(r.name)}" data-i="${i}" data-k="name" maxlength="24">
      <input class="a addr" aria-label="BCH address of member ${i + 1}" placeholder="${net.prefix}:q…" value="${esc(r.address)}" data-i="${i}" data-k="address">
      <button title="Remove member ${i + 1}" aria-label="Remove member ${i + 1}" data-rm="${i}" ${rows.length <= 2 ? 'disabled' : ''}>✕</button>
    </div>`).join('');
  $('#memberRows').querySelectorAll('input').forEach((el) => { el.oninput = () => { rows[el.dataset.i][el.dataset.k] = el.value; validateForm(); }; });
  $('#memberRows').querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { rows.splice(+b.dataset.rm, 1); renderRows(); validateForm(); }; });
}

function readForm() {
  const problems = [];
  let contribution = 0n;
  try { contribution = parseBch($('#tAmount').value); } catch { problems.push('Enter the amount per round, like 0.0001.'); }
  if (contribution > 0n && contribution < 10_000n) problems.push('Use at least 0.0001 BCH per round, so fees stay small next to the pot.');
  const members = rows.map((r) => normAddress(r.address));
  rows.forEach((r, i) => { if (!members[i]) problems.push(`Member ${i + 1}: enter a valid ${net.name} BCH address (${net.prefix}:q…).`); });
  if (rows.length < 2 || rows.length > 10) problems.push('A tanda needs 2 to 10 members.');
  const names = rows.map((r, i) => r.name.trim() || `Member ${i + 1}`);
  return { problems, contribution, members, names, name: $('#tName').value.trim() || 'Tanda' };
}

function validateForm() {
  const f = readForm();
  const ok = f.problems.length === 0;
  $('#create').disabled = !ok || !wallet;
  $('#summary').innerHTML = ok
    ? `${rows.length} members × ${fmtBch(f.contribution, net.unit)} = a pot of <b>${fmtBch(f.contribution * BigInt(rows.length), net.unit)}</b> each round, for ${rows.length} rounds.${wallet ? '' : ' Connect a wallet to create it (you pay the small setup fee).'}`
    : `<span class="muted">${esc(f.problems[0])}</span>`;
}

$('#addMember').onclick = () => { if (rows.length < 10) { rows.push({ name: '', address: '' }); renderRows(); validateForm(); } };
$('#addMe').onclick = () => {
  if (!wallet) return;
  const empty = rows.findIndex((r) => !r.address.trim());
  const i = empty >= 0 ? empty : (rows.push({ name: '', address: '' }), rows.length - 1);
  rows[i] = { name: rows[i].name || 'Me', address: wallet.address };
  renderRows(); validateForm();
};
$('#tAmount').oninput = validateForm;

$('#create').onclick = async () => {
  const st = $('#createStatus');
  const f = readForm();
  if (f.problems.length || !wallet) return;
  $('#create').disabled = true;
  try {
    let coins = await wallet.coins(provider);
    if (!coins.length) throw new Error(`Your wallet has no ${net.unit} to pay the setup fee.`);
    let built;
    try {
      built = await buildGenesis({ members: f.members, contribution: f.contribution }, { provider, wallet, coins });
    } catch (e) {
      if (e.message !== 'NEED_VOUT0') throw e;
      status(st, 'One preparation step first: your wallet sends its balance to itself, so the tanda token can be minted.');
      const txid = await signAndSend(buildConsolidate({ provider, wallet, coins }), 'Tanda: prepare a coin to mint the tanda token', st);
      status(st, 'Prepared. Waiting for the network to see it…');
      for (let i = 0; i < 40; i++) {
        coins = (await wallet.coins(provider)).filter((c) => c.txid === txid);
        if (coins.length) break;
        await new Promise((r) => setTimeout(r, 750));
      }
      built = await buildGenesis({ members: f.members, contribution: f.contribution }, { provider, wallet, coins });
    }
    const txid = await signAndSend(built, `Create tanda "${f.name}" (${f.members.length} members)`, st);
    const link = tandaLink({ name: f.name, members: f.members, names: f.names, contribution: f.contribution, category: built.params.category, net: net.name });
    status(st, `Created in ${txLink(txid)}. Opening your tanda…`, 'ok');
    location.href = link;
  } catch (e) {
    status(st, esc(e.message || String(e)), 'err');
    $('#create').disabled = false;
  }
};

/* ---------- one tanda ---------- */
let current = null; // { t, contract }

function ringSvg(n, round, finished) {
  const R = 86, cx = 110, cy = 110, gap = n > 1 ? 0.06 : 0;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI - Math.PI / 2 + gap / 2, a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2 - gap / 2;
    const p = (a) => `${cx + R * Math.cos(a)},${cy + R * Math.sin(a)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const color = i < round ? 'var(--ok)' : i === round && !finished ? 'var(--accent)' : 'var(--line)';
    parts.push(`<path d="M${p(a0)} A${R},${R} 0 ${large} 1 ${p(a1)}" stroke="${color}" stroke-width="22" fill="none" stroke-linecap="butt"><title>Round ${i + 1}</title></path>`);
    const am = (a0 + a1) / 2;
    parts.push(`<text x="${cx + (R + 0) * Math.cos(am)}" y="${cy + R * Math.sin(am) + 4}" text-anchor="middle" font-size="11" font-weight="700" style="fill:${i <= round ? '#fff' : 'var(--muted)'}">${i + 1}</text>`);
  }
  const center = finished ? 'Done' : `${round + 1}/${n}`;
  return `<svg viewBox="0 0 220 220" role="img" aria-label="Round ${Math.min(round + 1, n)} of ${n}">${parts.join('')}
    <text x="110" y="108" text-anchor="middle" font-size="30" font-weight="800">${center}</text>
    <text x="110" y="130" text-anchor="middle" font-size="12" style="fill:var(--muted)">${finished ? 'all paid out' : 'round'}</text></svg>`;
}

// Who sent each pot coin: the public key in input 0 of the funding transaction.
const senderCache = new Map();
async function senderOf(txid) {
  if (senderCache.has(txid)) return senderCache.get(txid);
  let who = null;
  try {
    const tx = decodeTransaction(hexToBin(await provider.getRawTransaction(txid)));
    const ub = tx.inputs[0].unlockingBytecode;
    if (ub.length >= 34 && ub[ub.length - 34] === 0x21) {
      who = encodeCashAddress({ prefix: net.prefix, type: 'p2pkh', payload: hash160(ub.slice(-33)) }).address;
    }
  } catch {}
  senderCache.set(txid, who);
  return who;
}

async function refreshTanda() {
  const t = tandaFromHash();
  $('#createView').classList.toggle('hidden', !!t);
  $('#tandaView').classList.toggle('hidden', !t);
  if (!t) return;
  if (t.net !== net.name) { location.search = t.net === 'chipnet' ? '?net=chipnet' : ''; return; }
  const st = $('#tandaStatus');
  try {
    const contract = await tandaContract(t, provider);
    current = { t, contract };
    $('#tTitle').textContent = t.name;
    document.title = `${t.name} · Tanda`;
    $('#contractLink').textContent = contract.address;
    $('#contractLink').href = net.addr(contract.address);
    $('#payExact').textContent = fmtBch(t.contribution, net.unit);
    $('#shareQr').innerHTML = qrSvg(location.href);
    $('#copyLink').onclick = () => navigator.clipboard.writeText(location.href).then(() => status(st, 'Link copied.', 'ok'));

    const s = await readTanda(t, contract);
    if (!s.state) { status(st, 'Waiting for the creation transaction to reach the network… press Refresh in a moment.'); return; }
    const n = Number(s.n), round = Number(s.round);
    $('#ringSvg').innerHTML = ringSvg(n, round, s.finished);
    $('#roundLabel').textContent = s.finished ? `All ${n} rounds paid out` : `Round ${round + 1} of ${n} · whose turn:`;
    $('#turnLabel').textContent = s.finished ? 'This tanda is complete' : t.names[round];
    const pct = s.finished ? 100 : Math.min(100, Number((s.potSats * 100n) / s.need));
    $('#potBar').style.width = `${pct}%`;
    $('#potLabel').innerHTML = s.finished ? `Each member received ${fmtBch(s.need, net.unit)} minus a small network fee.`
      : `Pot: <b>${fmtBch(s.potSats, net.unit)}</b> of ${fmtBch(s.need, net.unit)}${s.ready ? ' — full, ready to release.' : ''}`;

    const paid = new Map();
    for (const u of s.pot) { const who = await senderOf(u.txid); if (who) paid.set(who, (paid.get(who) || 0n) + u.satoshis); }
    $('#memberTable').innerHTML = '<tr><th>#</th><th>Member</th><th>Address</th><th>This round</th><th>Pot</th></tr>' + t.members.map((m, i) => {
      const thisRound = s.finished ? '—' : (paid.get(m) ?? 0n) >= t.contribution ? '<span class="pill ok">paid</span>' : '<span class="pill wait">not yet</span>';
      const pot = i < round ? '<span class="pill ok">received</span>' : i === round && !s.finished ? '<span class="pill turn">this round</span>' : `<span class="muted small">round ${i + 1}</span>`;
      const me = wallet && wallet.address === m ? ' <span class="pill">you</span>' : '';
      return `<tr><td>${i + 1}</td><td>${esc(t.names[i])}${me}</td><td class="addr"><a href="${net.addr(m)}" target="_blank" rel="noopener">${short(m)}</a></td><td>${thisRound}</td><td>${pot}</td></tr>`;
    }).join('');

    const isMember = wallet && t.members.includes(wallet.address);
    $('#payShare').textContent = isMember ? `Pay my share (${fmtBch(t.contribution, net.unit)})` : `Pay a share (${fmtBch(t.contribution, net.unit)})`;
    $('#payShare').disabled = !wallet || s.finished;
    $('#release').disabled = !s.ready;
    if (!st.classList.contains('ok') && !st.classList.contains('err')) {
      status(st, s.ready ? 'The pot is full. Anyone can release it; it can only go to ' + esc(t.names[round]) + '.'
        : s.finished ? '' : wallet ? '' : 'Connect a wallet to pay in. Releasing a full pot needs no wallet.');
    }
  } catch (e) {
    status(st, `Could not read this tanda: ${esc(e.message || String(e))}`, 'err');
  }
}

$('#refresh').onclick = () => { status($('#tandaStatus'), ''); refreshTanda(); };
$('#payShare').onclick = async () => {
  const st = $('#tandaStatus');
  if (!wallet || !current) return;
  $('#payShare').disabled = true;
  try {
    const coins = await wallet.coins(provider);
    const built = buildFromWallet({ provider, wallet, coins, outputs: [{ to: current.contract.address, amount: current.t.contribution }] });
    const txid = await signAndSend(built, `Tanda "${current.t.name}": pay ${fmtBch(current.t.contribution, net.unit)}`, st);
    status(st, `Paid in ${txLink(txid)}.`, 'ok');
  } catch (e) { status(st, esc(e.message || String(e)), 'err'); }
  setTimeout(refreshTanda, 1500);
};
$('#release').onclick = async () => {
  const st = $('#tandaStatus');
  if (!current) return;
  $('#release').disabled = true;
  try {
    status(st, 'Releasing…');
    const p = await buildPayout(current.t, current.contract, provider);
    const tx = await p.tb.send();
    const who = current.t.names[current.t.members.indexOf(p.to)];
    status(st, `Released ${fmtBch(p.amount, net.unit)} to ${esc(who)} in ${txLink(tx.txid)}. No signature was needed: the contract checked everything.`, 'ok');
  } catch (e) { status(st, esc(e.message || String(e)), 'err'); }
  setTimeout(refreshTanda, 1500);
};

/* ---------- demo link ---------- */
(async () => {
  try {
    const run = await (await fetch('../run/run.json')).json();
    const demo = tandaLink({
      name: 'Demo tanda (chipnet)', members: Object.values(run.members), names: ['Ana', 'Beto', 'Carla'],
      contribution: BigInt(run.contribution_sats), category: run.category, net: 'chipnet',
    }, new URL('./', location.href).href);
    $('#demoLink').innerHTML = `Just looking? <a href="${demo}">Open a finished 3-member tanda on chipnet</a>: 3 rounds, 14 real transactions.`;
  } catch {}
})();

/* ---------- boot ---------- */
window.addEventListener('hashchange', refreshTanda);
renderRows();
await resumeWallet();
renderWallet();
refreshTanda();
document.body.dataset.ready = '1';
