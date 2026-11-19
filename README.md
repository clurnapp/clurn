# Clurn

**English** · [Português](README.pt-BR.md)

**Recovers what was left behind in the burner wallets used to launch coins on Pump.fun.**

You paste your recovery phrases (up to 10, from Solflare or Phantom). Clurn finds every burner wallet of each phrase, shows how much can be recovered and does nothing until you confirm. Then it closes the empty accounts, burns the junk, claims the creator fees and sends everything to **one** destination wallet you choose.

Official download: [clurn.app](https://clurn.app) · Official account: [@clurnapp](https://x.com/clurnapp)

## What it does

| Found in the burners | What happens |
| --- | --- |
| Loose SOL | Sent to the destination |
| Empty token account | Closed; the rent (~0.002 SOL per account) goes to the destination |
| Pump.fun creator fees and cashback | Claimed and sent to the destination |
| Creator fees on Meteora DBC and Raydium LaunchLab (SOL pairs) | Claimed and sent to the destination |
| Worthless memecoin | Burned and closed, only after you confirm |
| Token with market value | **You choose:** send to the destination, burn or keep |
| Token with no known price | Shown as "unknown value", never as zero, and kept by default |
| NFT | Only listed. Never burned |
| Balances on Ethereum, Base, BSC, Arbitrum and Polygon from the same phrase | Shown read-only |

The screen has four steps: **phrases and destination → preparing → confirm → sending**. The final receipt lists the totals, every failure with its reason and a Solscan link for each transaction.

## Security

The app receives the phrase of your main wallet, so it is built to keep it on your computer:

- **The phrase lives only in memory.** It never goes to a server, a file, a log or browser storage. The app runs on `127.0.0.1`, accepts connections only from your own computer and uses a new access code every time it opens. Closing the window wipes the keys.
- **The main wallet never signs anything.** Only the burners get keys:
  - Solflare "Temporary wallet": path `m/44'/501'/(N+10000)'/0'/0'`.
  - Phantom: the phrase's accounts, with Account 1 treated as the main wallet and left out.
- **Every transaction is simulated first.** If the result differs from the plan, the app stops and tells you why.
- **The destination is checked.** You paste it yourself; the app never fills it in. The plan is only built for a valid address of a wallet that already exists and is not one of the burners.
- **One failing account doesn't stop the rest.** Frozen accounts and restricted Token-2022 tokens show up in the receipt with the reason.
- **No npm packages in the app.** The code in `src/` uses only Node itself (`node:crypto` for BIP39, SLIP-0010 and ed25519). Electron is used only for the desktop window.

**Everything the app sends over the network:** queries and already-signed transactions to a Solana RPC, token prices to Jupiter, balance queries to public RPCs of other chains, and a check for a new signed version on this repository's Releases. Never the phrase or the keys.

### Updates

From version 1.0, the Windows app updates itself. When a new version is published here, the app shows "Update now". It installs only after your click, and only if the version file is signed with the Clurn update key (Ed25519). Before installing, the app checks the installer's size, SHA-256 and signature; anything that doesn't match is deleted. The public keys are in [`src/app/atualizacao.ts`](src/app/atualizacao.ts).

## Fee

Clurn charges **11% of the SOL recovered**, in the same transaction that delivers it: 89% to your destination, 11% to the app wallet `BniYdnbtcqxTfbGgAq3tCxCN2sHJGeiZKMLsX1jbL6GL`. There is no fee on tokens or NFTs you send, or on SOL you deposit to pay network fees. The fee is shown in the summary, the simulation and the receipt.

## Download and check

Download `Clurn-Setup-<version>.exe` only from [clurn.app](https://clurn.app) or this repository's [Releases](https://github.com/clurnapp/clurn/releases), and check its SHA-256 against the one published there. The installer isn't code-signed yet, so Windows SmartScreen shows "Windows protected your PC" the first time; "More info" → "Run anyway" opens it. It installs for your user only, with no admin rights.

**Start with a low-value phrase** to see how it works.

## From the source code

You need [Node.js 24](https://nodejs.org/) or newer.

```bash
git clone https://github.com/clurnapp/clurn.git
cd clurn
npm start          # opens the app in your browser (no npm install needed)
npm test           # tests
```

Windows desktop app:

```bash
npm install        # Electron and the packager (development only, pinned versions)
npm run desktop    # opens the desktop window
npm run empacotar  # builds the installer dist/Clurn-Setup-<version>.exe and its SHA-256 (needs Inno Setup 6)
```

By default the app uses the public Solana RPC. To use your own, set `SOLANA_RPC_URL` before opening it.

Code comments, terminal commands and design notes are in Portuguese.

## Project structure

```text
src/core/      core, no UI: phrases and derivation, Solana transactions, scan, plan, execution, fee
src/app/       local app: server on 127.0.0.1, UI (ui/index.html), receipt, updates
desktop/       desktop window (Electron)
src/cli/       terminal commands
test/          tests (node:test)
scripts/       packaging, installer, update signing, devnet and screen tests
proxy/         optional RPC proxy (Cloudflare Worker): forwards queries, never receives a phrase
```

## License and security

Source-available: you can read and audit all of it. See [LICENCA.md](LICENCA.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).
