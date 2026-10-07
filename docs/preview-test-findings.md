# Preview test findings

Issues found while testing the preview of PR 27 (voyage-api PR 320) in claude.ai on 6 October 2026. They are to be fixed together, not one by one. Nothing here has been changed in code yet.

Preview links: `https://pr-320-mcp.preview.voyage.moi.technology/mcp` (write) and `https://pr-320-mcp-read.preview.voyage.moi.technology/mcp` (read).

## Issues

### 1. Show the wallet QR code in the chat itself

Found with "Connect my MOI wallet." Today `moi_connect_wallet` returns a 320 px PNG image block plus a link to a pairing page. claude.ai shows the image only as a small thumbnail at the top right of the message, so Claude points the person at the link.

Wanted: the QR code visible in the chat, and no link to a separate page.

Idea on file: also return the QR as block-character text (`qrcode.toString(uri, { type: "utf8", small: true })`, about 35 lines by 69 characters for a real pairing URI), tell Claude in the tool description to print it in a code block, keep the image block, and drop the pairing page. Risk: Claude must copy the block exactly; the QR's error correction covers small slips. Files: `src/tools/wallet-hosted.ts`, `src/wc/qr.ts`, `src/pairing/`.

### 2. Ask how long the relay connection should stay open

Found with "Connect my MOI wallet." Claude said "you stay connected for a week" without asking. The pairing lifetime is fixed at 7 days in code.

Wanted: before pairing, ask the person how long the relay connection should last, and apply the answer.

Needs: an input on `moi_connect_wallet` (for example `lifetime`, with a sensible maximum), the tool description telling Claude to ask first, and the chosen lifetime written to the pairing record and used by the expiry check. Files: `src/tools/wallet-hosted.ts`, `src/wc/store.ts`, the pairing lifetime constants and `test/unit/pairing-lifetime.test.ts`.

### 3. The network is not called "voyage"

Found with "Is my wallet connected, and on which network?" The answer named the network "voyage". In the code `voyage` is the value of the `MOI_NETWORK` setting and its label is "Voyage devnet" (`src/moi/provider.ts`, `NETWORKS`). Voyage is MOI's explorer and RPC service, not the network. The preview and dev deploys point at the `.../babylon/` endpoint of that service, and the node does not report a name of its own.

To settle: the display name to use (Babylon devnet?), and whether the setting value stays `voyage` for compatibility with the deploy workflows and docs. Touches every place that prints the network name: tool results, previews ("Network: Voyage"), instructions, README and docs.

### 4. claude.ai refuses transfers

Found with "Send 1 KMOI to my own address." Claude in claude.ai refused to call `moi_transfer` at all: "I don't carry out transfers of funds or tokens, including a send to your own address, even with your go-ahead", and told the person to do it in MOI Wallet. The tool's description and annotations are unchanged since master, and the server's instructions say nothing that causes this. The same flow worked from claude.ai in early September 2026.

Cause: Anthropic's Software Directory Policy (14 April 2026, section 4A, https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy) lists "software that transfers money, cryptocurrency, or other financial assets, or executes financial transactions on behalf of users" as an unsupported use case, "unless otherwise expressly permitted by us in writing", and says Anthropic may revisit it. The in-chat refusal is the assistant applying that rule. Creating an asset and minting were allowed the same day (see Passed below), so the line is drawn by the wording "transfer", not by what the chain does. A mint to another person's address was tried on 7 October and refused the same way: Claude said its limit "turns on the outcome, not on which routine runs", and that it will not place tokens in an account that is not the person's own, since mint-to-a-third-party ends where mint-then-send would. It offered to mint to the person's own wallet for them to send on in MOI Wallet. So the line is: any write that puts tokens into another account is refused; writes that keep value in the person's own account (create, mint to self, burn, deploy) go through.

Ways forward: (a) ask Anthropic for written permission and point at the "may revisit" line; (b) a hand-off path where Claude prepares the transfer and the person completes it in MOI Wallet, through a deep link or QR with the transfer filled in if the wallet supports one, and Claude confirms by hash afterwards; (c) other MCP clients and models have no such rule, so the write flow keeps working there. Not an option: rewording the tools to hide that they move tokens, which the same policy forbids as evading guardrails.

### 5. The agent runtime step must be an explicit, ordered step

Found with the Launchpad flow (sign in, create an agent named Badger, download its setup script). Everything worked, but after creating the agent Claude first said there was nothing left to do, and only gave the setup script when pushed. It also did not know whether the download link works with `curl` or only in a browser, and it had to search the web for where to get a Groq key.

Wanted: after an agent is created (and registered), the tool result and the server instructions tell Claude that the agent runs only once its setup script has been run on a machine, and walk the person through it in this order:

1. Have an AI API key ready first, with the link to make one (Groq: https://console.groq.com/keys; or Google AI or OpenAI), because the download link works once and expires in ten minutes.
2. Check Node.js 18 or newer on the host machine.
3. Download the script and run it with `bash`, with the exact terminal command, and say whether the link works with `curl`.
4. Delete the script afterwards, since it holds the agent's private key.

Files: `src/applications/launchpad/tools.ts` (the create, register and setup-script results), `src/instructions.ts`.

### 6. Logic reads fail on the preview until `MOI_READ_CALLER` is set

Found with "Call Get on logic <id>" after the deploy (W6). The preview answered "account not found" twice. Checked from a laptop against the same devnet: with no `MOI_READ_CALLER`, the server's read-only call fails the same way; with it set to any existing account, `Get` returns `{"value": false}`. Same cause as the registry tools (issue noted under "Still owed"): the read-only signer uses a placeholder account the node rejects. Already in the devops request. Not a code bug, but the error the person sees should say which setting is missing, as the registry reads already do (`src/moi/provider.ts`, `src/capabilities/logics/view.ts`).

### 7. The flipper fixture cannot be used to test writes on this devnet

Found with "Call Toggle on logic <id>" (W5) and the `Seed` deploy routine. Simulation fails with receipt status 1 while the operation reports status 0 and no error, from the deployer's own account, and also when called through the SDK's own logic driver rather than this server's builder. So it is not the server. The flipper manifest in `test/fixtures/logics/flipper.json` was compiled with PISA engine 0.5.0 (copied from the SDK's test manifests); every logic that works on this devnet (KMOI, the agent registry) is engine 0.8.0. State-writing routines of the old bytecode fail on node 0.13.0; `Init` passed only because it has no code, and `Get` works because it only reads.

Needed: a manifest compiled with the current Cocolang compiler, from Gokul or by compiling the flipper source, both for `test/fixtures/logics/` and for the W5 test. Until then no state-writing `moi_call_logic` has run for real.

Two things to fix in the server while at it: (a) the refusal text says "op status 0", which reads as success; when the node gives receipt status 1 with no operation error, say that the node gave no reason; (b) the deploy refusal's hint about `payer Logic` (`src/capabilities/logics/deploy.ts`, near line 284) is a guess and led Claude to tell the person to change their Cocolang source. Say that the node gave no reason, and list the known causes as possibilities.

### 8. Stale "never run against a node" note on `moi_deploy_logic`

Claude told the person "the deploy tool is new: its own description says it hasn't been run against a node yet". It has now (see Passed). Remove that sentence from the tool description.

### 9. Take `moi_configure_account` off the servers

Found with "add a new key" (W1). claude.ai's Claude refused to call the tool: changing which keys can sign for the account is a security change it does not carry out even with approval. Adithya agrees that adding keys should not be possible from the chat.

Why: adding a key at weight 1000 hands full signing power to that key for good. The phone shows the key as a hex string nobody can check by eye, so a wrong paste or a prompt injection in something Claude read is enough, and the preview and the tap do not guard against it.

Recommendation: do not register `moi_configure_account` on the stdio or hosted server unless an operator turns it on with a setting, off by default. Keep the code (it works and was dry-run on the devnet) and keep the account-keys read. Revoking is lower risk but is also a signing change, so the whole tool goes rather than half of it. Gokul asked for the account operations in his review, so tell him. Files: `src/tools/register.ts`, `src/capabilities/accounts/`, `test/unit/tool-lists.test.ts` and its snapshots, `docs/`.

### 10. Add MAS1, MAS2 and MASX asset creation

Found with "Create a MAS1 asset with symbol NFTA" (A2): the refusal is correct for the code as it stands, and Adithya wants the capability built.

What the SDK sends for each standard, which the create builder must match (`node_modules/js-moi-asset/lib.cjs/mas1-asset.js`, `mas2-asset.js`, `asset-factory.js`):

- MAS1: an ASSET_CREATE with `max_supply: 1`, no decimals, `dimension: 0`, and `logic_payload: { manifest: "0x", callsite: "Init" }`, plus the funding transfer. One unit, so no `supply` input.
- MAS2: as MAS0 (symbol, supply, decimals, dimension 0) plus the same `logic_payload` with the `Init` callsite.
- MASX: a caller-supplied compiled manifest, a deploy callsite and its calldata in `logic_payload`, like `moi_deploy_logic`. The SDK's `AssetFactory.create` requires a callsite when the manifest has any deploy routine.

Work: widen `CreateAssetInput.standard` to the four values with the inputs each one needs; branch `buildCreateAsset` (`src/moi/ix-builder.ts`) per standard; make `moi_create_asset` describe each; relax the transfer and mint guards once the paths exist (`assertStandardSupported`, `src/capabilities/assets/shortcuts.ts`): a MAS1 or MAS2 transfer names a token id, a MAS1 mint takes no amount; test each create by simulation on the devnet and then with one real creation, since no MAS1 or MAS2 asset existed on the devnet on 1 October 2026 to test against. The server's own documentation (part 4 of the change document) has the detail of why these were blocked.

## Passed on 6 October 2026

| Test | Result |
|---|---|
| Connector sign-in | Worked after removing and re-adding the connector. The first attempt failed because the preview was still answering 502 when it was added, and claude.ai kept that failed discovery for a few minutes. |
| Wallet pairing | Worked (with issues 1 and 2 above). |
| Create a MAS1 asset (A2), 7 October | Refused before the phone, as designed for now (issue 10). |
| Create asset | Preview (10 KMOI fund, MAS0, decimals 0), confirm, phone, sent. A name change before confirm gave a fresh preview. Asset bobtoken `0x1003000090487ec2e20295bf9dacbc8ee80bcc39294f7664cfb20d1600000000`, interaction `0x1aa5c7ad80d5ed77469dd1cf8a62cb21d3755cd3f175253cf807d46ac6ab3985`. |
| Mint | Preview, confirm, phone, sent; balance 100 bobtoken. Interaction `0x8f719e5f34944b32a080fe96aa4d841ff5c2137eb2ea57b21cf4493205d15a83`. Run twice; the phone prompted both times. |
| Launchpad | Sign-in, agent creation and the setup-script download worked (see issue 5). |
| Deploy logic (W3), 7 October | First real `moi_deploy_logic`: the preview asked which of the two deploy routines to use, refused `Seed` at the dry run, previewed `Init` with the 10 KMOI funding transfer, then phone, sent. Receipt status 0 on both operations. Logic `0x200000007f84e6f2c0f82142504167b9d762b0d37b689eea56e7001400000000`, interaction `0x478208128c3dff11d83f328ab0f4c6019896e7ffb3bd452564f35f5ba395a901`. Attaching the manifest as a file in claude.ai worked. |
| Show logic (W4), 7 October | Routines listed as on chain. |
| Storage fund below the floor (A3), 7 October | Refused at the dry run before the phone, naming the floor of about 6.1 KMOI, and offering 10 or 7 KMOI. |
| Sign in to localhost (D2), 7 October | Refused before the phone: not a public host, with a sensible explanation. |
| The rest of the list, 7 October | Adithya reports the remaining tests behaved as expected: mint KMOI refused (A6), private-address sign-in refused (D3), the reads (T1, T3, R1 to R7), the reject and timeout tests, and the remaining Launchpad calls (D4, D5, D9, D10). |
| Launchpad sign-out (D12) and wallet disconnect (E3), 7 October | Both worked. Sign-out ended only the Launchpad session and said the wallet was still paired; disconnect ended the pairing and said reads still work. |
| Burn through the asset's routine (T2), 7 October | First real `moi_asset_invoke`: preview named the routine and amount, phone, sent; balance 1,100 to 1,095 bobtoken. Interaction `0x088a19c8f956bab593fa09c345becddd5b6ab59277f83ba182a80edc842327f4`. |

## Not yet run

Call a state-writing routine (W5), blocked by issue 7 until a manifest compiled with the current compiler is available. Everything else in `docs/preview-test-prompts.md` has been run.

## Still owed from before

- Ask devops for the signed-check log line of pm2 app `moi-mcp-write-pr-320` for the first write. It shows whether what the phone signed matched the preview, and decides when `MOI_SIGNED_CHECK` can move from `warn` to `enforce`.
- `MOI_READ_CALLER` is not set on the preview, so `moi_list_agents` and `moi_resolve_agent` return an error there.
- The encryption at rest (`MOI_SESSION_KEY`) waits on devops; it is the local branch `feat/encryption-at-rest`, which reverts commit `8365c2d`.
