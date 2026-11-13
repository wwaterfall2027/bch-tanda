// Tanda covenant tests against CashScript's MockNetworkProvider, which runs every
// transaction through the BCH virtual machine and keeps a UTXO set.
import { MockNetworkProvider, TransactionBuilder, randomUtxo, FailedTransactionError } from 'https://esm.sh/cashscript@0.14.0';
import { compileString } from 'https://esm.sh/cashc@0.14.0';
import { encodeCashAddress } from 'https://esm.sh/@bitauth/libauth@3.0.0';
import {
  tandaContract, readTanda, buildPayout, addressOfPkh, encodeRound, decodeRound, loadArtifact, STATE_SATS,
} from '../src/tanda.js';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e?.message || String(e) }); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
// The transaction must be rejected BY THE CONTRACT (a failed require in the VM),
// not by fee policy or anything else, or the test proves nothing.
export const rejections = [];
async function rejects(p, m) {
  try { await p; } catch (e) {
    const byContract = e instanceof FailedTransactionError || /require|evaluat/i.test(e?.message || '');
    const byBuilder = /pot incomplete|finished/.test(e?.message || '');
    rejections.push({ case: m, error: (e?.constructor?.name || '') + ': ' + (e?.message || '').split('\n')[0].slice(0, 160) });
    if (byContract || byBuilder) return;
    throw new Error(`${m}: rejected for the wrong reason: ${e?.message}`);
  }
  throw new Error(`expected rejection: ${m}`);
}

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const C = 100_000n; // contribution per round
const FEE = 2000n;  // fee used by hand-built payouts (>= 1 sat/byte, <= maxFee of a 2-3 member tanda)

// A fresh tanda with n members on a fresh mock chain.
async function setup(n = 3, contribution = C) {
  const provider = new MockNetworkProvider();
  const members = Array.from({ length: n }, () => addressOfPkh(rand(20), 'bchtest'));
  const params = { members, contribution, category: hex(rand(32)) };
  const contract = await tandaContract(params, provider);
  provider.addUtxo(contract.tokenAddress, {
    txid: hex(rand(32)), vout: 0, satoshis: STATE_SATS,
    token: { category: params.category, amount: 0n, nft: { capability: 'mutable', commitment: '' } },
  });
  const pay = (sats = contribution) => provider.addUtxo(contract.address, { ...randomUtxo(), satoshis: sats });
  const balance = async (addr) => (await provider.getUtxos(addr)).reduce((s, u) => s + u.satoshis, 0n);
  return { provider, members, params, contract, pay, balance };
}

// Hand-built payout so tests can tamper with any part of it.
async function manual(env, { to, amount, stateTo, commitment, extra = [], inputs } = {}) {
  const { provider, contract, params } = env;
  const t = await readTanda(params, contract);
  const tb = new TransactionBuilder({ provider });
  for (const u of inputs ?? [t.state, ...t.pot]) tb.addInput(u, contract.unlock.payout());
  tb.addOutput({ to: to ?? t.turn, amount: amount ?? t.need - FEE });
  tb.addOutput({
    to: stateTo ?? contract.tokenAddress, amount: t.state.satoshis,
    token: { category: params.category, amount: 0n, nft: { capability: 'mutable', commitment: commitment ?? encodeRound(t.round + 1n) } },
  });
  for (const o of extra) tb.addOutput(o);
  return tb.send();
}

export async function run() {
  await test('artifact compiles from contract/tanda.cash', async () => {
    const a = await loadArtifact();
    assert(a.contractName === 'Tanda' && a.abi[0].name === 'payout');
  });

  await test('round number encoding round-trips', async () => {
    for (const r of [0n, 1n, 2n, 127n, 128n, 255n, 256n, 1000n]) assert(decodeRound(encodeRound(r)) === r, `round ${r}`);
  });

  await test('full 3-member cycle pays each member in order, then stops', async () => {
    const env = await setup(3);
    for (let r = 0; r < 3; r++) {
      for (let k = 0; k < 3; k++) env.pay();
      const { tb, to, amount } = await buildPayout(env.params, env.contract, env.provider);
      assert(to === env.members[r], `round ${r} goes to member ${r}`);
      await tb.send();
      assert(await env.balance(env.members[r]) === amount, `member ${r} got the pot`);
      const t = await readTanda(env.params, env.contract);
      assert(t.round === BigInt(r + 1), 'round advanced');
    }
    const t = await readTanda(env.params, env.contract);
    assert(t.finished && t.potSats === 0n, 'finished and empty');
    env.pay();
    await rejects(manual(env, { to: env.members[0], amount: C - FEE, commitment: encodeRound(4n) }), 'payout after the last round');
  });

  await test('cannot pay the pot to someone whose turn it is not', async () => {
    const env = await setup(3);
    for (let k = 0; k < 3; k++) env.pay();
    await rejects(manual(env, { to: env.members[1] }), 'member 1 in round 0');
    await rejects(manual(env, { to: addressOfPkh(rand(20), 'bchtest') }), 'outsider');
  });

  await test('cannot pay out an incomplete pot', async () => {
    const env = await setup(3);
    env.pay(); env.pay();
    await rejects(buildPayout(env.params, env.contract, env.provider), 'builder refuses');
    await rejects(manual(env, { amount: 2n * C - FEE }), 'contract refuses');
  });

  await test('cannot burn the pot as miner fee', async () => {
    const env = await setup(3);
    for (let k = 0; k < 3; k++) env.pay();
    env.pay(5n * C); // money paid ahead
    await rejects(manual(env, { amount: 3n * C - 1000n }), 'ahead-money silently burned');
    const env2 = await setup(3);
    for (let k = 0; k < 3; k++) env2.pay();
    await rejects(manual(env2, { amount: 3n * C - 4000n }), 'fee above maxFee');
  });

  await test('money paid ahead stays in the contract for later rounds', async () => {
    const env = await setup(3);
    for (let k = 0; k < 4; k++) env.pay();
    await (await buildPayout(env.params, env.contract, env.provider)).tb.send();
    const t = await readTanda(env.params, env.contract);
    assert(t.round === 1n && t.potSats === C, `kept ${t.potSats}`);
  });

  await test('ahead-money cannot be diverted to anyone else', async () => {
    const env = await setup(3);
    for (let k = 0; k < 4; k++) env.pay();
    await rejects(manual(env, { extra: [{ to: addressOfPkh(rand(20), 'bchtest'), amount: C }] }), 'thief output');
  });

  await test('state NFT must stay in the contract and advance by exactly one', async () => {
    const env = await setup(3);
    for (let k = 0; k < 3; k++) env.pay();
    const thief = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: rand(20) }).address;
    await rejects(manual(env, { stateTo: thief }), 'state stolen');
    await rejects(manual(env, { commitment: '' }), 'round not advanced');
    await rejects(manual(env, { commitment: encodeRound(2n) }), 'round skipped');
  });

  await test('pot UTXOs cannot be spent without the state NFT', async () => {
    const env = await setup(3);
    for (let k = 0; k < 3; k++) env.pay();
    const t = await readTanda(env.params, env.contract);
    const tb = new TransactionBuilder({ provider: env.provider });
    for (const u of t.pot) tb.addInput(u, env.contract.unlock.payout());
    tb.addOutput({ to: t.turn, amount: 3n * C - FEE });
    await rejects(tb.send(), 'no state input');
  });

  await test('last round: nothing may be left behind in the contract', async () => {
    const env = await setup(2);
    for (let k = 0; k < 2; k++) env.pay();
    await (await buildPayout(env.params, env.contract, env.provider)).tb.send();
    for (let k = 0; k < 3; k++) env.pay();
    await rejects(manual(env, { amount: 2n * C - FEE, extra: [{ to: env.contract.address, amount: C }] }), 'leftover kept after last round');
    const last = await buildPayout(env.params, env.contract, env.provider);
    await last.tb.send();
    assert(last.amount === 3n * C - last.fee, 'last payout takes the whole pot');
    assert(await env.balance(env.members[1]) === last.amount, 'last member gets everything');
    assert((await readTanda(env.params, env.contract)).potSats === 0n, 'contract empty');
  });

  await test('a 10-member tanda pays out within its fee cap, even with 2 extra pot UTXOs', async () => {
    const env = await setup(10, 50_000n);
    for (let k = 0; k < 10; k++) env.pay(50_000n);
    env.pay(20_000n); env.pay(30_000n); // someone paid ahead in two parts
    const p = await buildPayout(env.params, env.contract, env.provider);
    await p.tb.send();
    assert(await env.balance(env.members[0]) === p.amount && p.amount === 500_000n - p.fee, 'member 0 paid');
    assert((await readTanda(env.params, env.contract)).potSats === 50_000n, 'ahead-money kept');
  });

  await test('anyone can trigger the payout (no signature needed)', async () => {
    const env = await setup(2);
    env.pay(); env.pay();
    await manual(env, {}); // no key involved at all
    assert(await env.balance(env.members[0]) === 2n * C - FEE);
  });

  return results;
}
