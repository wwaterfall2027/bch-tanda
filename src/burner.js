// Chipnet-only burner wallets for testing and demos. Keys live in this browser's
// localStorage and hold worthless test coins. Never use these for mainnet funds.
import { SignatureTemplate, TransactionBuilder } from 'https://esm.sh/cashscript@0.14.0';
import {
  secp256k1, hash160, encodeCashAddress, binToHex, hexToBin, generatePrivateKey,
} from 'https://esm.sh/@bitauth/libauth@3.0.0';

const KEY = 'tanda-burners-chipnet';

export function burner(name) {
  const all = JSON.parse(localStorage.getItem(KEY) || '{}');
  if (!all[name]) {
    all[name] = binToHex(generatePrivateKey());
    localStorage.setItem(KEY, JSON.stringify(all));
  }
  const priv = hexToBin(all[name]);
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === 'string') throw new Error(pub);
  const pkh = hash160(pub);
  return {
    name, priv, pkh,
    address: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address,
    tokenAddress: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address,
    sig: new SignatureTemplate(priv),
  };
}

export async function balance(provider, w) {
  return (await provider.getUtxos(w.address)).reduce((s, u) => s + u.satoshis, 0n);
}

// Send `outputs` [{to, amount}] from wallet w, spending its plain UTXOs, change back to w.
export async function send(provider, w, outputs, { feePerByte = 1n } = {}) {
  const utxos = (await provider.getUtxos(w.address)).filter((u) => !u.token);
  const want = outputs.reduce((s, o) => s + o.amount, 0n);
  const make = (fee) => {
    const tb = new TransactionBuilder({ provider });
    let inSum = 0n;
    for (const u of utxos) { tb.addInput(u, w.sig.unlockP2PKH()); inSum += u.satoshis; if (inSum >= want + fee + 1000n) break; }
    if (inSum < want + fee) throw new Error(`${w.name} has ${inSum} sats, needs ${want + fee}`);
    tb.addOutputs(outputs);
    if (inSum - want - fee >= 1000n) tb.addOutput({ to: w.address, amount: inSum - want - fee });
    return tb;
  };
  const size = make(5000n).getTransactionSize();
  return make(size * feePerByte + 10n).send();
}

// Same interface as WcWallet, for chipnet testing without a phone.
export function burnerWallet(name = 'me') {
  const w = burner(name);
  return {
    kind: 'test', walletName: 'Test wallet (chipnet)', ready: true, address: w.address,
    async coins(provider) {
      return (await provider.getUtxos(w.address)).filter((u) => !u.token).map((u) => ({ ...u, address: w.address }));
    },
    unlockerFor: () => w.sig.unlockP2PKH(),
    async sign(tb) { return tb.build(); },
    async disconnect() {},
  };
}

export { binToHex };
