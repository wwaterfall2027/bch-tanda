// WizardConnect wallet session: pair by QR, derive the wallet's addresses from its
// xpubs, find its coins, and ask it to sign. The wallet never shares a private key.
import { initiateDappRelay, DisconnectReason } from 'https://esm.sh/@wizardconnect/core@0.2.10';
import { DappConnectionManager } from 'https://esm.sh/@wizardconnect/dapp@0.2.6?deps=@wizardconnect/core@0.2.10';
import { placeholderP2PKHUnlocker } from 'https://esm.sh/cashscript@0.14.0';
import { hash160, encodeCashAddress, stringify } from 'https://esm.sh/@bitauth/libauth@3.0.0';

const RECEIVE = 0, CHANGE = 1;
const PATH_NAME = { [RECEIVE]: 'receive', [CHANGE]: 'change' };
const SCAN = 10; // addresses checked per path

export class WcWallet extends EventTarget {
  constructor(net, dappName = 'Tanda', dappIcon = new URL('../app/icon.svg', import.meta.url).href) {
    super();
    this.net = net;
    // One stored session per network, so a chipnet pairing never shows up on mainnet.
    this.mgr = new DappConnectionManager(dappName, dappIcon, { session: { key: `tanda-wc-session-${net.name}` } });
    this.relay = null;
    this.ready = false;
    this.offline = false; // a stored session the wallet has not answered yet, or that stopped answering
    this.offlineTimer = null;
    this.mgr.on('walletready', (msg) => {
      clearTimeout(this.offlineTimer);
      this.ready = true; this.offline = false; this.walletName = msg.wallet_name;
      this.emit('ready');
    });
    // The wallet stopped answering pings: closed app, lost network, or a session ended on the phone.
    this.mgr.on('reconnecting', () => this.markOffline());
    // The wallet ended the session: forget it here too, so a reload does not bring it back.
    this.mgr.on('disconnect', (reason) => this.ended(reason));
  }

  markOffline() {
    if (!this.ready || this.offline) return;
    this.offline = true;
    this.emit('offline');
  }

  ended(reason) {
    clearTimeout(this.offlineTimer);
    const was = this.ready || this.offline;
    this.ready = false; this.offline = false;
    this.mgr.clearStoredSession();
    this.relay?.cleanup?.();
    if (was) this.emit('disconnect', reason);
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // Resume a stored session if there is one. Returns true if it did.
  resume() {
    const s = this.mgr.loadStoredSession();
    if (!s?.walletPublicKey) return false;
    try {
      this.relay = initiateDappRelay((p) => this.onStatus(p), {
        existingCredentials: { privateKey: s.privateKey, secret: s.secret, walletPublicKey: s.walletPublicKey },
      });
      this.mgr.attachRelay(this.relay);
      if (this.mgr.getSessionPaths().length) { this.ready = true; this.walletName = this.mgr.walletName; }
      // A stored session only proves the wallet was here before. If it does not answer
      // soon (for example the session was ended on the phone), say so instead of
      // showing the wallet as connected.
      this.offlineTimer = setTimeout(() => this.markOffline(), 20000);
      return true;
    } catch { this.mgr.clearStoredSession(); return false; }
  }

  // Start a new pairing; returns the URI to show as a QR code.
  pair() {
    this.relay?.cleanup?.();
    this.relay = initiateDappRelay((p) => this.onStatus(p));
    this.mgr.attachRelay(this.relay);
    return this.relay.uri;
  }

  onStatus(p) {
    this.relayStatus = p.status?.status;
    this.mgr.updateConnection(p.client, p.status);
    this.emit('status', this.relayStatus);
    if (this.relayStatus === 'session_deleted') this.ended('session_deleted');
  }

  // After a page reload the relay needs a moment to reconnect before it can carry requests.
  async whenConnected(timeoutMs = 30000) {
    const t0 = Date.now();
    while (this.relayStatus !== 'connected') {
      if (Date.now() - t0 > timeoutMs) throw new Error('Could not reach the wallet relay. Check your connection and try again.');
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async disconnect() {
    clearTimeout(this.offlineTimer);
    this.offline = false;
    this.mgr.clearStoredSession();
    try { await this.mgr.sendDisconnect('user disconnected'); } catch {}
    this.relay?.cleanup?.();
    this.ready = false;
  }

  addressAt(child, index) {
    const pub = this.mgr.getPubkey(child, BigInt(index));
    if (!pub) return null;
    return encodeCashAddress({ prefix: this.net.prefix, type: 'p2pkh', payload: hash160(pub) }).address;
  }

  // The wallet's first receive address: what it shares as its tanda member address.
  get address() { return this.addressAt(RECEIVE, 0); }

  // All coins on the first SCAN receive and change addresses, tagged with their path.
  async coins(provider) {
    const jobs = [];
    for (const child of [RECEIVE, CHANGE]) for (let i = 0; i < SCAN; i++) {
      const address = this.addressAt(child, i);
      if (address) jobs.push(provider.getUtxos(address).then((us) => us.map((u) => ({ ...u, address, path: [PATH_NAME[child], i] }))));
    }
    return (await Promise.all(jobs)).flat().filter((u) => !u.token);
  }

  unlockerFor(coin) { return placeholderP2PKHUnlocker(coin.address); }

  // Ask the wallet to sign a TransactionBuilder whose wallet inputs used unlockerFor().
  // walletInputs: [{ index, coin }]. Returns the signed transaction hex.
  async sign(tb, walletInputs, userPrompt) {
    // Same encoding as BCH WalletConnect: libauth's extended JSON (bigint and Uint8Array as tagged strings).
    const transaction = JSON.parse(stringify(tb.generateWcTransactionObject({ broadcast: false, userPrompt })));
    const inputPaths = walletInputs.map(({ index, coin }) => [index, coin.path[0], coin.path[1]]);
    await this.whenConnected();
    let res;
    for (let attempt = 0; ; attempt++) {
      try { res = await this.mgr.signTransaction({ transaction, inputPaths }); break; }
      catch (e) {
        if (!/Not connected/i.test(e.message) || attempt >= 20) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (res.error) throw new Error(res.error);
    return res.signedTransaction;
  }
}

export { DisconnectReason };
