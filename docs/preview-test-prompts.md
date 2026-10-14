# Preview test prompts for voyage-api PR 320

Connector: https://pr-320-mcp.preview.voyage.moi.technology/mcp
Read-only connector for part 6: https://pr-320-mcp-read.preview.voyage.moi.technology/mcp

Type each prompt into claude.ai with the connector on. Report the number and what happened for anything that differs from "Expect".

## 0. Setup

S1  Connect my MOI wallet.
    Expect: Claude first asks how long the connection should stay open (once, a day or a week). Answer a week. Then a QR code printed in a code block in the chat. Scan it from the screen with MOI Wallet and approve. If it will not scan, say so. Report light and dark theme separately.
S2  Is my wallet connected, and on which network?
    Expect: your address, network voyage.
S3  What can you do with MOI through this connector?
    Expect: a short list of what it can read and write, and that writes are previewed first and then confirmed on your phone.

## 1. The write flow

P1  Send 1 KMOI to my own address.
    Expect: a preview with amount and fuel, and a question. Answer "Yes, go ahead". The phone asks. Approve. Result: sent, with a hash and an explorer link. Keep the hash.
P2  Send 1 KMOI to my own address.
    Expect: preview, confirm, then REJECT on the phone. Result: rejected, reason user_rejected.
P3  Send 1 KMOI to my own address.
    Expect: preview, confirm, then IGNORE the phone. After about 4 minutes: rejected, reason timeout.
P4  Send 2 KMOI to my own address.   (then, after the preview:)   Make it 3 KMOI instead, go ahead.
    Expect: a fresh preview for 3 KMOI and nothing sent until you confirm that one.
P5  Look up interaction <hash from P1>.
    Expect: its status, operations and explorer link.

## 2. Asset rules

A1  Create a new asset with symbol TESTA and supply 1000.
    Expect: preview shows a storage fund of 10 KMOI (7 KMOI if your balance is under 10.001). Confirm, approve. Sent. Keep the asset id.
A2  Create a MAS1 asset with symbol NFTA.
    Expect: a preview that says one unit, identified by token id, with no supply and no decimals, the id the asset will get and a storage fund of 10 KMOI (a MAS1 create is refused with the balance when the account cannot carry 10 KMOI plus the fuel). Confirm, approve. Sent, with created yes and the asset id. Keep the id.
A2b Create a MAS2 asset with symbol GOLD, supply 1000 and 2 decimals.
    Expect: a preview that says fungible units under token ids, with the supply and the decimals, and a storage fund of 10 KMOI. Confirm, approve. Sent, with created yes and the asset id.
A2c Create a MASX asset with symbol TAX and supply 1000000 from test/fixtures/assets/taxtoken-masx.json (the manifest object inside "manifest"), with treasury_addr set to your own address, bps 300 and initial_supply 1000000.
    Expect: a preview that lists 2 routines, 541 bytes, the SHA-256 aae74411..., the deploy routine Init and its inputs, and a storage fund of 10 KMOI. Confirm, approve. Sent, with created yes and the asset id.
A2d Create a MAS1 asset with symbol NFTB and supply 5.
    Expect: refused before the phone, saying a MAS1 asset takes no supply and why. Nothing sent.
A3  Create an asset with symbol TINY, supply 10, and a storage fund of 1 KMOI.
    Expect: refused at the dry run, naming the floor of about 6.1 KMOI. Nothing sent.
A4  Mint 100 more TESTA (asset <id from A1>).
    Expect: preview, confirm, approve. Sent.
A5  Send 10 TESTA to my own address.
    Expect: preview, confirm, approve. Sent.
A6  Mint 5 KMOI.
    Expect: refused before the phone. KMOI is the native asset.
A7  Show asset <id from A1>.
    Expect: symbol TESTA, standard MAS0, supply 1100.

## 3. Asset tools

T1  What routines does asset <id from A1> support?
    Expect: about 20 routines, each marked read or write.
T2  Burn 5 TESTA through its Burn routine.
    Expect: preview naming the routine and its argument. Confirm, approve. Sent.
T3  What routines does KMOI support?
    Expect: 15 routines, and no Mint or Burn.

## 4. New write tools (use a throwaway account for W1 and W2)

W1  Show my account keys.   (then:)   Add this public key to my account: <0x02... or 0x03... compressed key from another wallet>
    Expect: moi_configure_account is not offered, because MOI_ACCOUNT_KEY_TOOLS is off by default. With it set to on: preview shows the keys before and after, the new key at weight 1000. Confirm, approve. Sent.
W2  Revoke key 0 on my account.
    Expect: moi_configure_account is not offered, because MOI_ACCOUNT_KEY_TOOLS is off by default. With it set to on: refused before the phone. It is the key your wallet signs with.
W3  Deploy this logic manifest and run its Seed routine with initial true: <paste the manifest object, the value of the "manifest" key, from test/fixtures/logics/flipper-payer.json>
    Expect: preview shows the deploy and a 10 KMOI funding transfer. Confirm, approve. Sent, with the new logic id within about 30 seconds. Keep the id.
    The older test/fixtures/logics/flipper.json stays a deploy-only fixture: its Set and Toggle write state without payer Logic, so they can never be called.
W4  Show logic <id from W3>.
    Expect: the routines of the manifest with their kinds: Init and Seed as deploy routines, and Get, Set and Toggle.
W5  Call Toggle on logic <id from W3>.
    Expect: preview, confirm, approve. Sent.
W6  Call Get on logic <id from W3>.
    Expect: the value false (Seed set it to true and Toggle flipped it), with no phone involved.

## 5. Dapps and the Launchpad

D1  Sign in to https://launchpad.moi.technology with my wallet.
    Expect: the phone asks you to sign a message. Approve. Signed in, with an expiry within one day.
    If it says the message "is for a different site": write that down, it is a known open check.
D2  Sign in to https://localhost:3000 with my wallet.
    Expect: refused. Not a public host. Nothing on the phone.
D3  Sign in to https://192.168.1.10 with my wallet.
    Expect: refused. Private address. Nothing on the phone.
D4  Which dapps am I signed in to?
    Expect: the Launchpad, with its expiry.
D5  What API operations does the Launchpad offer?
    Expect: a list of operations.
D6  What is my Launchpad status?
    Expect: your Launchpad account state.
D7  Show the Launchpad agent templates.
    Expect: a list of templates.
D8  Create an agent on the Launchpad from the first template, named Preview Test Agent.
    Expect: a preview first, because it is not a read. Confirm. Created. The result names the four steps in order, and says registering does not start the agent.
D9  Register that agent on chain.
    Expect: one tap on the phone. Sent. The agent id may be missing from the answer on this preview (MOI_READ_CALLER is not set). The result names the four steps in order, and says the agent is registered but not running yet.
D10 Give me the Telegram link for that agent.
    Expect: a link that works for 15 minutes.
D11 Give me the setup script for that agent.
    Expect: a download link that works once, for 10 minutes, and the steps in order: AI API key, Node.js 18, the curl command, delete the script.
D12 Sign out of the Launchpad.   (then:)   Which dapps am I signed in to?
    Expect: signed out, then none.

## 6. Reads (switch to the read-only connector, or stay on the write one)

R1  Show my account with all its holdings.
    Expect: balances with token ids, and the assets you created.
R2  Show my last 10 transactions.
    Expect: up to 10 heights, newest first, with explorer links.
R3  Show my last 50 transactions.
    Expect: capped at 20, and it says so.
R4  Use the raw node method to get my account keys.
    Expect: the node's own answer (moi_rpc_account_keys).
R5  What is the storage pricing on the node right now?
    Expect: storage_price_per_byte and the other two fields.
R6  What is in the interaction pool?
    Expect: pending and queued counts.
R7  Resolve agent agent_157.
    Expect on this preview: an error naming MOI_READ_CALLER. Expected until devops sets it.

## 7. Edge cases

E1  Send 1 KMOI to 0x1234.
    Expect: refused before the phone. Not a valid address.
E2  Send 1000000 KMOI to my own address.
    Expect: refused at the dry run. Not enough balance. Nothing on the phone.
E3  Disconnect my wallet.   (then:)   Send 1 KMOI to my own address.
    Expect: wallet_disconnected. Then S1 again to re-pair.

## Not testable on this preview
- moi_faucet is off (its two settings are not set).
- moi_list_agents and moi_resolve_agent fail until MOI_READ_CALLER is set (R7 shows this).
- Encryption at rest moved to the later PR.
- MAS1, MAS2 and MASX assets: none exist on the devnet until prompts A2 to A2c are run.

## After P1
Ask devops for the signed-check log line of pm2 app moi-mcp-write-pr-320. It says whether what the phone signed matched the preview, and it is what decides when MOI_SIGNED_CHECK can move from warn to enforce.
