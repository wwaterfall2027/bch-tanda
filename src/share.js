// A tanda is fully described by its parameters, so the share link IS the tanda:
// no server, no database. Anyone with the link can read its state from the chain.
const enc = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dec = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

export function encodeTanda({ name, members, names, contribution, category, maxFee, net }) {
  return enc(JSON.stringify({
    v: 1, name, net, members, names, c: contribution.toString(), cat: category, f: maxFee?.toString(),
  }));
}

export function decodeTanda(code) {
  const o = JSON.parse(dec(code));
  if (o.v !== 1 || !Array.isArray(o.members) || !/^[0-9a-f]{64}$/.test(o.cat)) throw new Error('not a tanda link');
  return {
    name: o.name || 'Tanda', net: o.net || 'mainnet', members: o.members,
    names: o.names || o.members.map((_, i) => `Member ${i + 1}`),
    contribution: BigInt(o.c), category: o.cat, maxFee: o.f ? BigInt(o.f) : undefined,
  };
}

export function tandaLink(t, base = location.href) {
  const u = new URL(base);
  u.search = t.net === 'chipnet' ? '?net=chipnet' : '';
  u.hash = 't=' + encodeTanda(t);
  return u.toString();
}

export function tandaFromHash(hash = location.hash) {
  const m = hash.match(/t=([A-Za-z0-9_-]+)/);
  return m ? decodeTanda(m[1]) : null;
}
