// Tanda core: compile, instantiate and drive the Tanda covenant.
// Runs in the browser; no build step. Libraries are pinned ES modules.
import { compileString } from 'https://esm.sh/cashc@0.14.0';
import { Contract, TransactionBuilder } from 'https://esm.sh/cashscript@0.14.0';
import {
  hexToBin, binToHex, cashAddressToLockingBytecode, decodeCashAddress, encodeCashAddress,
} from 'https://esm.sh/@bitauth/libauth@3.0.0';

export const STATE_SATS = 1000n; // value kept on the state NFT UTXO

// Most sats a payout may spend on miner fees. A payout spends the state UTXO plus one
// UTXO per contribution (~300 bytes each) at 1 sat/byte, with room for a few extra
// pot UTXOs (people who paid ahead or in parts).
export const defaultMaxFee = (n) => 400n * (BigInt(n) + 4n) + 600n;

let artifactCache;
export async function loadArtifact(base = new URL('..', import.meta.url)) {
  if (artifactCache) return artifactCache;
  const src = await (await fetch(new URL('contract/tanda.cash', base))).text();
  artifactCache = compileString(src);
  return artifactCache;
}

// The 20-byte public-key hash behind a P2PKH cash address.
export function pkhOf(address) {
  const d = decodeCashAddress(address);
  if (typeof d === 'string') throw new Error(`bad address ${address}: ${d}`);
  if (!/^p2pkh/.test(d.type)) throw new Error(`${address} is not a P2PKH address`);
  return d.payload;
}

export function addressOfPkh(pkh, prefix = 'bitcoincash') {
  return encodeCashAddress({ prefix, type: 'p2pkh', payload: pkh }).address;
}

export function encodeMembers(addresses) {
  const out = new Uint8Array(addresses.length * 20);
  addresses.forEach((a, i) => out.set(pkhOf(a), i * 20));
  return out;
}

// Token category as shown by wallets/explorers (display order) -> contract argument (internal order).
export const categoryArg = (categoryHex) => hexToBin(categoryHex).reverse();

/**
 * @param {object} p
 * @param {string[]} p.members  member cash addresses in payout order
 * @param {bigint} p.contribution sats per member per round
 * @param {string} p.category   state NFT category (display hex)
 * @param {bigint} [p.maxFee]   defaults to defaultMaxFee(members.length)
 */
export async function tandaContract({ members, contribution, category, maxFee }, provider) {
  maxFee ??= defaultMaxFee(members.length);
  const artifact = await loadArtifact();
  const args = [encodeMembers(members), BigInt(members.length), BigInt(contribution), BigInt(maxFee), categoryArg(category)];
  return new Contract(artifact, args, { provider, addressType: 'p2sh32' });
}

const isState = (u, category) => u.token?.category === category && u.token?.nft;

// Current state of a tanda read from the chain (or mock).
export async function readTanda(params, contract) {
  const utxos = await contract.getUtxos();
  const state = utxos.find((u) => isState(u, params.category));
  const pot = utxos.filter((u) => !u.token);
  const potSats = pot.reduce((s, u) => s + u.satoshis, 0n);
  const n = BigInt(params.members.length);
  const round = state ? decodeRound(state.token.nft.commitment) : null;
  const need = n * BigInt(params.contribution);
  return {
    state, pot, potSats, round, n, need,
    finished: round !== null && round >= n,
    ready: round !== null && round < n && potSats >= need,
    turn: round !== null && round < n ? params.members[Number(round)] : null,
  };
}

// Script number (minimal little-endian, sign bit) -> bigint. Empty = 0.
export function decodeRound(commitmentHex) {
  const b = hexToBin(commitmentHex || '');
  if (b.length === 0) return 0n;
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(i === b.length - 1 ? b[i] & 0x7f : b[i]);
  return b[b.length - 1] & 0x80 ? -v : v;
}

export function encodeRound(round) {
  let v = BigInt(round);
  if (v === 0n) return '';
  const out = [];
  while (v > 0n) { out.push(Number(v & 0xffn)); v >>= 8n; }
  if (out[out.length - 1] & 0x80) out.push(0);
  return binToHex(Uint8Array.from(out));
}

/**
 * Build (not send) the payout transaction for the current round.
 * Uses every plain pot UTXO; whatever exceeds this round's pot stays in the contract
 * (or, in the last round, goes to the last member).
 */
export async function buildPayout(params, contract, provider) {
  const t = await readTanda(params, contract);
  if (!t.state) throw new Error('state NFT not found');
  if (t.finished) throw new Error('this tanda has finished');
  if (!t.ready) throw new Error(`pot incomplete: ${t.potSats} of ${t.need} sats`);
  const maxFee = params.maxFee ?? defaultMaxFee(params.members.length);
  const last = t.round + 1n === t.n;
  let keep = last ? 0n : t.potSats - t.need;
  if (keep < 1000n) keep = 0n; // below dust: it simply goes to this round's member

  // Size the fee from a draft of the same transaction (amounts don't change its size).
  const make = (fee) => {
    const tb = new TransactionBuilder({ provider });
    tb.addInput(t.state, contract.unlock.payout());
    for (const u of t.pot) tb.addInput(u, contract.unlock.payout());
    tb.addOutput({ to: t.turn, amount: t.potSats - keep - fee });
    tb.addOutput({
      to: contract.tokenAddress, amount: t.state.satoshis,
      token: { category: params.category, amount: 0n, nft: { capability: 'mutable', commitment: encodeRound(t.round + 1n) } },
    });
    if (keep > 0n) tb.addOutput({ to: contract.address, amount: keep });
    return tb;
  };
  const size = make(maxFee).getTransactionSize(); // counts signatures still to be added
  const fee = size + 10n; // just over 1 sat/byte
  if (fee > maxFee) throw new Error(`payout needs a ${fee}-sat fee, above this tanda's ${maxFee}-sat cap`);
  return { tb: make(fee), round: t.round, to: t.turn, amount: t.potSats - keep - fee, fee };
}

/**
 * Pay `outputs` from a wallet. `wallet` is anything with { address, unlockerFor(coin) };
 * `coins` are its plain UTXOs. `first` (optional) must be input 0.
 * Returns { tb, walletInputs: [{ index, coin }] } with the fee sized at ~1 sat/byte.
 */
export function buildFromWallet({ provider, wallet, coins, outputs, first }) {
  const want = outputs.reduce((s, o) => s + o.amount, 0n);
  const pool = [...coins].sort((a, b) => Number(b.satoshis - a.satoshis));
  const make = (fee) => {
    const tb = new TransactionBuilder({ provider });
    const walletInputs = [];
    let inSum = 0n;
    const add = (coin) => { walletInputs.push({ index: walletInputs.length, coin }); tb.addInput(coin, wallet.unlockerFor(coin)); inSum += coin.satoshis; };
    if (first) add(first);
    for (const c of pool) {
      if (inSum >= want + fee + 1000n) break;
      if (c !== first) add(c);
    }
    if (inSum < want + fee) throw new Error(`not enough funds: need ${want + fee} sats, wallet has ${pool.reduce((s, c) => s + c.satoshis, 0n)}`);
    tb.addOutputs(outputs);
    const change = inSum - want - fee;
    if (change >= 1000n) tb.addOutput({ to: wallet.address, amount: change });
    return { tb, walletInputs };
  };
  const draft = make(5000n);
  const size = draft.tb.getTransactionSize(); // counts signatures the wallet will add
  return make(size + 10n);
}

/**
 * Create a tanda: mint its state NFT straight into the contract.
 * A token category is the txid of the outpoint spent as input 0, which must have vout 0.
 * @param {object} p   { members, contribution, maxFee? } (no category yet)
 * @returns {{ tb, walletInputs, params, contract }}
 */
export async function buildGenesis(p, { provider, wallet, coins }) {
  const first = [...coins].filter((u) => u.vout === 0).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
  if (!first) throw new Error('NEED_VOUT0');
  const params = { ...p, category: first.txid };
  const contract = await tandaContract(params, provider);
  const { tb, walletInputs } = buildFromWallet({
    provider, wallet, coins, first,
    outputs: [{
      to: contract.tokenAddress, amount: STATE_SATS,
      token: { category: params.category, amount: 0n, nft: { capability: 'mutable', commitment: '' } },
    }],
  });
  return { tb, walletInputs, params, contract };
}

// When a wallet has no coin at output index 0: send its balance to itself in one output.
export function buildConsolidate({ provider, wallet, coins }) {
  const total = coins.reduce((s, c) => s + c.satoshis, 0n);
  const make = (fee) => {
    const tb = new TransactionBuilder({ provider });
    const walletInputs = coins.map((coin, index) => { tb.addInput(coin, wallet.unlockerFor(coin)); return { index, coin }; });
    tb.addOutput({ to: wallet.address, amount: total - fee });
    return { tb, walletInputs };
  };
  const size = make(5000n).tb.getTransactionSize();
  return make(size + 10n);
}

export { hexToBin, binToHex, cashAddressToLockingBytecode };
