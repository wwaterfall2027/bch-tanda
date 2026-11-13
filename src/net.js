// Network selection: mainnet by default, chipnet with ?net=chipnet.
import { ElectrumNetworkProvider } from 'https://esm.sh/cashscript@0.14.0';

const NETS = {
  mainnet: {
    name: 'mainnet', prefix: 'bitcoincash', unit: 'BCH',
    tx: (id) => `https://explorer.selene.cash/tx/${id}`,
    addr: (a) => `https://explorer.selene.cash/address/${a}`,
  },
  chipnet: {
    name: 'chipnet', prefix: 'bchtest', unit: 'tBCH',
    tx: (id) => `https://explorer.selene.cash/tx/${id}?network=chipnet`,
    addr: (a) => `https://explorer.selene.cash/address/${a}?network=chipnet`,
  },
};

export function currentNet(search = location.search) {
  const want = new URLSearchParams(search).get('net');
  return NETS[want === 'chipnet' ? 'chipnet' : 'mainnet'];
}

let providers = {};
export function providerFor(net) {
  return (providers[net.name] ??= new ElectrumNetworkProvider(net.name));
}

export const SATS = 100_000_000n;
export function fmtBch(sats, unit = 'BCH') {
  const s = BigInt(sats);
  const whole = s / SATS, frac = (s % SATS).toString().padStart(8, '0').replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} ${unit}`;
}
export function parseBch(text) {
  const m = String(text).trim().match(/^(\d+)(?:\.(\d{0,8}))?$/);
  if (!m) throw new Error('enter an amount like 0.001');
  return BigInt(m[1]) * SATS + BigInt((m[2] || '').padEnd(8, '0'));
}
