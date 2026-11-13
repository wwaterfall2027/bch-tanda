# Tanda: the savings circle nobody can run off with

A **tanda** (also called susu, chit fund, tontine, hui or ROSCA) is how hundreds of millions of people save without a bank: every round each member chips in, and one member takes the whole pot, in turns. Its weak spot has always been trust. Everybody knows the story of the organizer who disappeared with the pot.

**Tanda** puts the pot in a Bitcoin Cash covenant that can **only** pay the member whose turn it is. Not even the organizer can take it.

**Live app:** https://wwaterfall2027.github.io/bch-tanda/app/ (mainnet) · [chipnet version](https://wwaterfall2027.github.io/bch-tanda/app/?net=chipnet)

Built for BCH BLAZE 2026 (Mainnet and Media tracks): [presentation](https://wwaterfall2027.github.io/bch-tanda/slides/) ([PDF](slides/tanda-slides.pdf)) · [74-second video](https://wwaterfall2027.github.io/bch-tanda/video/).

## How it works

1. **Create.** The organizer lists the members in payout order and the amount per round. One transaction mints a small mutable NFT straight into the contract. Its commitment is the round counter.
2. **Pay in.** Each round, every member sends their share to the contract address, from the app over **WizardConnect** or from any BCH wallet.
3. **Release.** When the pot is full, **anyone** presses Release. No key is needed. The covenant checks that the pot goes to the member whose turn it is, and moves the round forward by one.

The share link *is* the tanda: it carries the members, the amount and the NFT category. There is no server and no database. The app reads everything from the chain.

## What the contract guarantees

[`contract/tanda.cash`](contract/tanda.cash) (CashScript 0.14, about 200 bytes):

- The pot can only go to `members[round]`, through a P2PKH output with no tokens.
- It can only be paid once it is complete: `n × contribution`, minus a capped fee.
- The state NFT must go back to the same contract with `round + 1`, and its value can't change.
- Pot coins can't be spent without the state NFT at input 0.
- Money paid ahead stays in the contract (output 2, back to the contract). After the last round, nothing may stay behind: it all goes to the last member.
- The miner fee is capped (`maxFee`), so nobody can burn the pot in fees. The contract sums every input and output to check this.

What it can't do: force a member to keep paying after their turn. That part stays social, as it always was. The difference is that everyone can see on the chain who has paid this round: the app reads the payer of every coin in the pot.

## Wallet connection: WizardConnect

The app pairs with HD wallets such as Paytaca over [WizardConnect](https://wizardconnect-456f57.gitlab.io). The wallet scans a QR code and shares only its xpubs. The app derives the wallet's addresses, finds its coins and sends sign requests built with CashScript's `generateWcTransactionObject()` plus `inputPaths`. The user approves each one in the wallet. Keys never leave the wallet.

Releasing a full pot needs no wallet at all.

## Tests

Open `tests/index.html` from any static server (for example `npx serve .`) to run them in the browser.

**13/13 passing.** They run against CashScript's `MockNetworkProvider`, which evaluates every transaction in the BCH VM. Every negative test asserts that the **contract** rejected the transaction (a failed `require`), not fee policy:

- a full 3-member cycle pays each member in order, then stops;
- the pot can't go to the wrong member or an outsider;
- an incomplete pot can't be paid out;
- the pot can't be burned as miner fee;
- money paid ahead stays in the contract and can't be diverted;
- the state NFT must stay in the contract and advance by exactly one;
- pot coins can't be spent without the state NFT;
- in the last round nothing may be left behind;
- a 10-member tanda pays out within its fee cap;
- anyone can trigger a payout without a signature.

### End to end on chipnet

[`run/run.json`](run/run.json) records a complete 3-member, 3-round tanda on chipnet: 14 transactions, from funding through minting, 9 contributions and 3 payouts. Open it in the app: [demo tanda](https://wwaterfall2027.github.io/bch-tanda/app/?net=chipnet), via the "Open a finished 3-member tanda" link.

The WizardConnect flow was tested end to end on chipnet, through the public relay, with a test HD wallet built on the official `@wizardconnect/wallet` package ([`tests/wizwallet.html`](tests/wizwallet.html)): pairing, address derivation, the coin-preparation step, minting a tanda, paying a share and releasing the pot.

## Project layout

| Path | What |
|---|---|
| `contract/tanda.cash` | The covenant |
| `src/tanda.js` | Compile, read state, build genesis, contribution and payout transactions |
| `src/wc.js` | WizardConnect session, HD address scan, sign requests |
| `src/share.js` | The tanda link format |
| `app/` | The web app (static, no build step) |
| `tests/` | Contract tests and the test WizardConnect wallet |
| `run/` | The chipnet run and its record |
| `slides/` | The BLAZE presentation (HTML and PDF) |
| `video/` | The Media-track short and the code that renders it (canvas + WebCodecs, no editor) |

Everything runs in the browser from pinned ES modules: `cashc` and `cashscript` 0.14.0, `@bitauth/libauth` 3.0.0, `@wizardconnect/dapp` 0.2.6 and `@wizardconnect/core` 0.2.10.

## License

MIT

Built with AI assistance (Claude Code).
