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

Cause: Anthropic's Software Directory Policy (14 April 2026, section 4A, https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy) lists "software that transfers money, cryptocurrency, or other financial assets, or executes financial transactions on behalf of users" as an unsupported use case, "unless otherwise expressly permitted by us in writing", and says Anthropic may revisit it. The in-chat refusal is the assistant applying that rule. Creating an asset and minting were allowed the same day (see Passed below), so the line is drawn by the wording "transfer", not by what the chain does. A mint to another person's address has not been tried and may be treated as a transfer.

Ways forward: (a) ask Anthropic for written permission and point at the "may revisit" line; (b) a hand-off path where Claude prepares the transfer and the person completes it in MOI Wallet, through a deep link or QR with the transfer filled in if the wallet supports one, and Claude confirms by hash afterwards; (c) other MCP clients and models have no such rule, so the write flow keeps working there. Not an option: rewording the tools to hide that they move tokens, which the same policy forbids as evading guardrails.

### 5. The agent runtime step must be an explicit, ordered step

Found with the Launchpad flow (sign in, create an agent named Badger, download its setup script). Everything worked, but after creating the agent Claude first said there was nothing left to do, and only gave the setup script when pushed. It also did not know whether the download link works with `curl` or only in a browser, and it had to search the web for where to get a Groq key.

Wanted: after an agent is created (and registered), the tool result and the server instructions tell Claude that the agent runs only once its setup script has been run on a machine, and walk the person through it in this order:

1. Have an AI API key ready first, with the link to make one (Groq: https://console.groq.com/keys; or Google AI or OpenAI), because the download link works once and expires in ten minutes.
2. Check Node.js 18 or newer on the host machine.
3. Download the script and run it with `bash`, with the exact terminal command, and say whether the link works with `curl`.
4. Delete the script afterwards, since it holds the agent's private key.

Files: `src/applications/launchpad/tools.ts` (the create, register and setup-script results), `src/instructions.ts`.

## Passed on 6 October 2026

| Test | Result |
|---|---|
| Connector sign-in | Worked after removing and re-adding the connector. The first attempt failed because the preview was still answering 502 when it was added, and claude.ai kept that failed discovery for a few minutes. |
| Wallet pairing | Worked (with issues 1 and 2 above). |
| Create asset | Preview (10 KMOI fund, MAS0, decimals 0), confirm, phone, sent. A name change before confirm gave a fresh preview. Asset bobtoken `0x1003000090487ec2e20295bf9dacbc8ee80bcc39294f7664cfb20d1600000000`, interaction `0x1aa5c7ad80d5ed77469dd1cf8a62cb21d3755cd3f175253cf807d46ac6ab3985`. |
| Mint | Preview, confirm, phone, sent; balance 100 bobtoken. Interaction `0x8f719e5f34944b32a080fe96aa4d841ff5c2137eb2ea57b21cf4493205d15a83`. Run twice; the phone prompted both times. |
| Launchpad | Sign-in, agent creation and the setup-script download worked (see issue 5). |

## Not yet run

Deploy a logic (W3), call a routine (W5), configure account keys (W1, W2), the dapp refusals for localhost and private addresses (D2, D3), the reads on the read link (R1 to R7), the edge cases (E1 to E3), and a mint to another person's address (to learn whether claude.ai treats it as a transfer). The full prompt list is in `docs/preview-test-prompts.md`.

## Still owed from before

- Ask devops for the signed-check log line of pm2 app `moi-mcp-write-pr-320` for the first write. It shows whether what the phone signed matched the preview, and decides when `MOI_SIGNED_CHECK` can move from `warn` to `enforce`.
- `MOI_READ_CALLER` is not set on the preview, so `moi_list_agents` and `moi_resolve_agent` return an error there.
- The encryption at rest (`MOI_SESSION_KEY`) waits on devops; it is the local branch `feat/encryption-at-rest`, which reverts commit `8365c2d`.
