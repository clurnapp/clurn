# Security

Clurn receives recovery phrases, so security reports get priority.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. Describe what you found and how to reproduce it. Please don't open a public issue for a vulnerability, and give us time to ship a fix before disclosing it.

**Never send a recovery phrase, a private key or a screenshot that shows one**, not even your own test wallet. Use a new devnet phrase for any example.

## What we will never do

- Ask for your recovery phrase or private keys.
- Send you a direct message first, on X, Telegram or anywhere else.
- Send a download link by message. The app comes only from [clurn.app](https://clurn.app) or this repository's Releases, with its SHA-256.

Anyone doing any of these in Clurn's name is a scammer.

## In scope

- Anything that could expose a phrase or key (logs, files, network, crash messages).
- Anything that makes the app sign with the main wallet, send funds somewhere other than the confirmed destination, or burn a token without confirmation.
- Bypassing the update signature check (`src/app/atualizacao.ts`).
