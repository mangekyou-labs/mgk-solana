# Solana Perpetuals

## Introduction

Solana Perpetuals protocol is an open-source implementation of a non-custodial decentralized exchange that supports leveraged trading in a variety of assets.
npx ts-node src/cli.ts -k <ADMIN_WALLET> get-pools
npx ts-node src/cli.ts -k <ADMIN_WALLET> get-custodies <POOL_NAME>
```

### 🌙 Darkpool Features

The darkpool integration provides privacy-preserving trading with the following capabilities:

#### How It Works
1. **Order Submission**: Traders encrypt orders locally before sending to darkpool
2. **MPC Processing**: Arcium network matches orders in encrypted environment
3. **Settlement**: Only final trade results published to perpetuals program
4. **Privacy Preserved**: Individual order details never exposed on-chain

#### Usage Example
```typescript
// Submit encrypted order
const darkOrder = {
  side: 0, // long
  sizeUsd: new BN(1000_000000), // $1000
  maxPrice: new BN(50000_000000), // $50k
  leverage: new BN(5), // 5x
  // ... other params
};

await darkpoolClient.submitDarkOrder(trader, darkOrder, arciumPubKey);
```

📖 **[See DARKPOOL_README.md for complete implementation details](./DARKPOOL_README.md)**

## Quick start

### Setup Environment

1. Clone the repository from <https://github.com/solana-labs/perpetuals.git>.
2. Install the latest Solana tools from <https://docs.solana.com/cli/install-solana-cli-tools>. If you already have Solana tools, run `solana-install update` to get the latest compatible version.
3. Install the latest Rust stable from <https://rustup.rs/>. If you already have Rust, run `rustup update` to get the latest version.
4. Install the latest Anchor framework from <https://www.anchor-lang.com/docs/installation>. If you already have Anchor, run `avm update` to get the latest version.

Rustfmt is used to format the code. It requires `nightly` features to be activated:

5. Install `nightly` rust toolchain. <https://rust-lang.github.io/rustup/installation/index.html#installing-nightly>
6. Execute `git config core.hooksPath .githooks` to activate pre-commit hooks.

#### [Optional] Vscode setup

1. Install `rust-analyzer` extension
2. If formatting doesn't work, make sure that `rust-analyzer.rustfmt.extraArgs` is set to `+nightly`

### Build

First, generate a new key for the program address with `solana-keygen new -o <PROG_ID_JSON>`. Then replace the existing program ID with the newly generated address in `Anchor.toml` and `programs/perpetuals/src/lib.rs`.

Also, ensure the path to your wallet in `Anchor.toml` is correct. Alternatively, when running Anchor deploy or test commands, you can specify your wallet with `--provider.wallet` argument. The wallet's pubkey will be set as an upgrade authority upon initial deployment of the program. It is strongly recommended to make upgrade authority a multisig when deploying to the mainnet.

To build the program run `anchor build` command from the `perpetuals` directory:

```sh
cd perpetuals
anchor build
```

### 🌙 Build Darkpool (Optional)

To build with darkpool privacy features:

```sh
# Build main perpetuals program
anchor build

# Build darkpool with Arcium integration
cd encrypted-perp
npm install
anchor build

# Initialize darkpool (after deployment)
npm run demo:init
```

### Test

Integration and unit tests (Rust) can be started as follows:

```sh
cargo test-bpf -- --nocapture
```

Integration tests (Typescript) can be started as follows:

```sh
npm install
anchor test -- --features test
```

By default, integration tests are executed on a local validator, so it won't cost you any SOL.

### 🌙 Darkpool Testing

Test the privacy features:

```sh
# Test encrypted instructions
cd encrypted-perp/encrypted-ixs
cargo test

# Test darkpool program
cd encrypted-perp
anchor test

# Run darkpool demos
cd app
npm run demo:submit  # Submit encrypted order
npm run demo:match   # Trigger order matching
npm run demo:monitor # View darkpool stats
```

### Deploy

To deploy the program to the devnet and upload the IDL use the following commands:

```sh
anchor deploy --provider.cluster devnet --program-keypair <PROG_ID_JSON>
anchor idl init --provider.cluster devnet --filepath ./target/idl/perpetuals.json <PROGRAM ID>
```

### 🌙 Deploy Darkpool

Deploy privacy-enabled darkpool:

```sh
# Deploy darkpool program
cd encrypted-perp
anchor deploy --provider.cluster devnet

# Initialize darkpool configuration
npm run demo:init

# Set up MPC computation definitions
npm run setup:comp-defs
```

### Initialize

A small CLI Typescript client is included to help you initialize and manage the program. By default script uses devnet cluster. Add `-u https://api.mainnet-beta.solana.com` to all of the commands if you plan to execute them on mainnet.

To initialize deployed program, run the following commands:

```sh
cd app
npm install
npm install -g npx
npx ts-node src/cli.ts -k <ADMIN_WALLET> init --min-signatures <int> <ADMIN_PUBKEY1> <ADMIN_PUBKEY2> ...
```

Where `<ADMIN_WALLET>` is the file path to the wallet that was set as the upgrade authority of the program upon deployment. `<ADMIN_PUBKEY1>`, `<ADMIN_PUBKEY2>` etc., will be set as protocol admins, and `min-signatures` will be required to execute privileged instructions. To provide multiple signatures, just execute exactly the same command multiple times specifying different `<ADMIN_WALLET>` with `-k` option. The intermediate state is recorded on-chain so that commands can be executed on different computers.

To change program authority, run:

```sh
solana program set-upgrade-authority <PROGRAM_ADDRESS> --new-upgrade-authority <NEW_UPGRADE_AUTHORITY>
```

To change program authority back, run:

```sh
solana program set-upgrade-authority <PROGRAM_ADDRESS> --new-upgrade-authority <NEW_UPGRADE_AUTHORITY> -k <CURRENT_AUTHORITY_KEYPAIR>
```

To change protocol admins or minimum required signatures, run:

```sh
npx ts-node src/cli.ts -k <ADMIN_WALLET> set-authority --min-signatures <int> <ADMIN_PUBKEY1> <ADMIN_PUBKEY2> ...
```

To validate initialized program:

```sh
npx ts-node src/cli.ts -k <ADMIN_WALLET> get-multisig
npx ts-node src/cli.ts -k <ADMIN_WALLET> get-perpetuals
```

Before the program can accept any liquidity or open a trade, you need to create a token pool and add one or more token custodies to it:

```sh
npx ts-node src/cli.ts -k <ADMIN_WALLET> add-pool <POOL_NAME>
npx ts-node src/cli.ts -k <ADMIN_WALLET> add-custody [-s] [-v] [-t] <POOL_NAME> <TOKEN_MINT> <TOKEN_ORACLE>
```

Where `<POOL_NAME>` is a random name you want to assign to the pool, `<TOKEN_MINT>` is the mint address of the token, and `<TOKEN_ORACLE>` is the corresponding Pyth price account that can be found on [this page](https://pyth.network/price-feeds?cluster=devnet). `-s` flag specifies whether the custody is for a stablecoin. `-v` flag is used to create a virtual/synthetic custody. More information on the latter can be found [here](SYNTHETICS.md). `-t` flag specifies the type of the oracle to be used for the custody: `custom`, `pyth` or `none`.

For example:

```sh
npx ts-node src/cli.ts -k <ADMIN_WALLET> add-pool TestPool1
npx ts-node src/cli.ts -k <ADMIN_WALLET> add-custody TestPool1 So11111111111111111111111111111111111111112 J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix
```

To validate added pools and custodies, run:

```sh
npx ts-node src/cli.ts -k <ADMIN_WALLET> get-pool <POOL_NAME>
npx ts-node src/cli.ts -k <ADMIN_WALLET> get-custody <POOL_NAME> <TOKEN_MINT>
```

or

```sh
npx ts-node src/cli.ts -k <ADMIN_WALLET> get-pools
npx ts-node src/cli.ts -k <ADMIN_WALLET> get-custodies <POOL_NAME>
```

To add liquidity, run:

```sh
npx ts-node src/cli.ts -k <WALLET> add-liquidity <POOL_NAME> <TOKEN_MINT> --amount-in <AMOUNT_IN> --min-amount-out <MIN_AMOUNT_OUT>
```

For it to work, make sure the wallet's LM token ATA is initialized and the wallet hold enough tokens to provide as liquidity.

To initialize wallet's token ATA, run:

```sh
npx ts-node src/cli.ts -k <ADMIN_WALLET> get-lp-token-mint <POOL_NAME>

spl-token create-account <LM_TOKEN_MINT> --owner <WALLET> --fee-payer <PAYER_WALLET>
```

CLI offers other useful commands. You can get the list of all of them by running the following:

```sh
npx ts-node src/cli.ts --help
```

## UI (Deprecated)

### UI doesn't support the latest version of the on-chain program. The code is still available but for the reference only. Latest supported commit is 34f9bbb.

We have implemented a coressponding UI for the smartcontract, written in Typescript/Tailwind/Next. To quickly spin up a UI linked to the contract, first follow the previous directions to build the contract, and to init the exchange.

In the main directory, run `./migrations/migrate-target.sh` to copy over the target build directory to the ui.

Now, you can use the following CLI commands to quickly spin-up a `TestPool1` consisting of the three following tokens.

Sol Token: `J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix`

Test Token oracle: `BLArYBCUYhdWiY8PCUTpvFE21iaJq85dvxLk9bYMobcU`

USDC oracle: `5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7`

```
cd app

npx ts-node src/cli.ts -k <ADMIN_WALLET> add-pool TestPool1

npx ts-node src/cli.ts -k <ADMIN_WALLET> add-custody TestPool1 So11111111111111111111111111111111111111112 J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix

npx ts-node src/cli.ts -k <ADMIN_WALLET> add-custody TestPool1 6QGdQbaZEgpXqqbGwXJZXwbZ9xJnthfyYNZ92ARzTdAX BLArYBCUYhdWiY8PCUTpvFE21iaJq85dvxLk9bYMobcU

npx ts-node src/cli.ts -k <ADMIN_WALLET> add-custody TestPool1 Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr 5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7 true
```

Now, use the following commands to build and run the UI, (navigate to localhost:3000 to use the UI):

```
cd ../ui
yarn install
yarn dev
```