import {
  IPricePusher,
  PriceInfo,
  ChainPriceListener,
  PriceItem,
} from "../interface";
import { addLeading0x, DurationInSeconds } from "../utils";
import { PythAbi } from "./pyth-abi";
import { Logger } from "pino";
import { isWsEndpoint } from "../utils";
import {
  PriceServiceConnection,
  HexString,
  UnixTimestamp,
} from "@pythnetwork/price-service-client";
import { CustomGasStation } from "./custom-gas-station";
import { PushAttempt } from "../common";
import {
  Chain,
  PublicClient,
  Transport,
  WalletClient,
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  webSocket,
  Address,
  GetContractReturnType,
  WatchContractEventOnLogsParameter,
  TransactionExecutionError,
  Account,
  defineChain,
} from "viem";

import { mnemonicToAccount } from "viem/accounts";
import chains from "viem/chains";

type PythContract = GetContractReturnType<
  typeof PythAbi,
  PublicClient | WalletClient
>;

export class EvmPriceListener extends ChainPriceListener {
  private pythContractFactory: PythContractFactory;
  private pythContract: PythContract;
  private logger: Logger;

  constructor(
    pythContractFactory: PythContractFactory,
    priceItems: PriceItem[],
    logger: Logger,
    config: {
      pollingFrequency: DurationInSeconds;
    }
  ) {
    super(config.pollingFrequency, priceItems);

    this.pythContractFactory = pythContractFactory;
    this.pythContract = this.pythContractFactory.createPythContract();
    this.logger = logger;
  }

  // This method should be awaited on and once it finishes it has the latest value
  // for the given price feeds (if they exist).
  async start() {
    // It is possible to watch the events in the non-ws endpoints, either by getFilter
    // or by getLogs, but it is very expensive and our polling mechanism does it
    // in a more efficient way.
    if (this.pythContractFactory.hasWebsocketProvider()) {
      this.logger.info("Watching target network pyth contract events...");
      this.startWatching();
    } else {
      this.logger.info(
        "The target network RPC endpoint is not Websocket. " +
          "Listening for updates only via polling...."
      );
    }

    // base class for polling
    await super.start();
  }

  private async startWatching() {
    this.pythContract.watchEvent.PriceFeedUpdate(
      { id: this.priceItems.map((item) => addLeading0x(item.id)) },
      { onLogs: this.onPriceFeedUpdate.bind(this) }
    );
  }

  private onPriceFeedUpdate(
    logs: WatchContractEventOnLogsParameter<typeof PythAbi, "PriceFeedUpdate">
  ) {
    for (const log of logs) {
      console.log(log);

      // const priceId = removeLeading0x(log.returnValues.id);
      // this.logger.debug(
      //   `Received a new Evm PriceFeedUpdate event for price feed ${this.priceIdToAlias.get(
      //     priceId
      //   )} (${priceId}).`
      // );
      //
      // const priceInfo: PriceInfo = {
      //   conf: log.returnValues.conf,
      //   price: log.returnValues.price,
      //   publishTime: Number(log.returnValues.publishTime),
      // };
      //
      // this.updateLatestPriceInfo(priceId, priceInfo);
    }
  }

  async getOnChainPriceInfo(
    priceId: HexString
  ): Promise<PriceInfo | undefined> {
    let priceRaw: any;
    try {
      priceRaw = await this.pythContract.read.getPriceUnsafe([
        addLeading0x(priceId),
      ]);
    } catch (err) {
      this.logger.error(err, `Polling on-chain price for ${priceId} failed.`);
      return undefined;
    }

    this.logger.debug(
      `Polled an EVM on chain price for feed ${this.priceIdToAlias.get(
        priceId
      )} (${priceId}).`
    );

    return {
      conf: priceRaw.conf,
      price: priceRaw.price,
      publishTime: Number(priceRaw.publishTime),
    };
  }
}

export class EvmPricePusher implements IPricePusher {
  private customGasStation?: CustomGasStation;
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private pythContract: PythContract;
  private pusherAddress: `0x${string}` | undefined;
  private lastPushAttempt: PushAttempt | undefined;

  constructor(
    private connection: PriceServiceConnection,
    pythContractFactory: PythContractFactory,
    private logger: Logger,
    private overrideGasPriceMultiplier: number,
    private overrideGasPriceMultiplierCap: number,
    private updateFeeMultiplier: number,
    private gasLimit?: number,
    customGasStation?: CustomGasStation
  ) {
    this.customGasStation = customGasStation;
    this.pythContract = pythContractFactory.createPythContractWithWallet();
    this.publicClient = pythContractFactory.createPublicClient();
    this.walletClient = pythContractFactory.createWalletClient();
  }

  // The pubTimes are passed here to use the values that triggered the push.
  // This is an optimization to avoid getting a newer value (as an update comes)
  // and will help multiple price pushers to have consistent behaviour.
  // To ensure that we transactions are landing and we are not pushing the prices twice
  // we will re-use the same nonce (with a higher gas price) if the previous transaction
  // is not landed yet.
  async updatePriceFeed(
    priceIds: string[],
    pubTimesToPush: UnixTimestamp[]
  ): Promise<void> {
    if (priceIds.length === 0) {
      return;
    }

    if (priceIds.length !== pubTimesToPush.length)
      throw new Error("Invalid arguments");

    const priceIdsWith0x = priceIds.map((priceId) => addLeading0x(priceId));

    const priceFeedUpdateData = (await this.getPriceFeedsUpdateData(
      priceIdsWith0x
    )) as `0x${string}`[];

    let updateFee;

    try {
      updateFee = await this.pythContract.read.getUpdateFee([
        priceFeedUpdateData,
      ]);
      updateFee = BigInt(
        Math.round(Number(updateFee) * (this.updateFeeMultiplier || 1))
      );
      this.logger.debug(`Update fee: ${updateFee}`);
    } catch (e: any) {
      this.logger.error(
        e,
        "An unidentified error has occured when getting the update fee."
      );
      throw e;
    }

    let gasPrice =
      Number(await this.customGasStation?.getCustomGasPrice()) ||
      Number(await this.publicClient.getGasPrice());

    // Try to re-use the same nonce and increase the gas if the last tx is not landed yet.
    if (this.pusherAddress === undefined) {
      this.pusherAddress = this.walletClient.account!.address;
    }

    console.log(this.pusherAddress);

    const lastExecutedNonce =
      (await this.publicClient.getTransactionCount({
        address: this.pusherAddress,
      })) - 1;

    let gasPriceToOverride = undefined;

    if (this.lastPushAttempt !== undefined) {
      if (this.lastPushAttempt.nonce <= lastExecutedNonce) {
        this.lastPushAttempt = undefined;
      } else {
        gasPriceToOverride =
          this.lastPushAttempt.gasPrice * this.overrideGasPriceMultiplier;
      }
    }

    if (
      gasPriceToOverride !== undefined &&
      gasPriceToOverride > Number(gasPrice)
    ) {
      gasPrice = Math.min(
        gasPriceToOverride,
        gasPrice * this.overrideGasPriceMultiplierCap
      );
    }

    const txNonce = lastExecutedNonce + 1;

    this.logger.debug(`Using gas price: ${gasPrice} and nonce: ${txNonce}`);

    try {
      const pubTimesToPushParam = pubTimesToPush.map((pubTime) =>
        BigInt(pubTime)
      );

      const result = this.pythContract.simulate.updatePriceFeedsIfNecessary(
        [priceFeedUpdateData, priceIdsWith0x, pubTimesToPushParam],
        {
          account: this.walletClient.account?.address,
          value: updateFee,
          gasPrice: BigInt(Math.round(gasPrice)),
          nonce: txNonce,
          gas:
            this.gasLimit !== undefined
              ? BigInt(Math.round(this.gasLimit))
              : undefined,
        }
      );

      const hash = await this.pythContract.write.updatePriceFeedsIfNecessary(
        [priceFeedUpdateData, priceIdsWith0x, pubTimesToPushParam],
        {
          account: this.walletClient.account!,
          chain: this.walletClient.chain,
          value: updateFee,
          gasPrice: BigInt(Math.round(gasPrice)),
          nonce: txNonce,
          gas:
            this.gasLimit !== undefined
              ? BigInt(Math.round(this.gasLimit))
              : undefined,
        }
      );

      this.logger.info({ hash }, "Price update successful");
    } catch (err: any) {
      if (err instanceof TransactionExecutionError) {
        if (err.shortMessage.includes("exceeds the balance of the account")) {
          this.logger.error({ err }, "Wallet doesn't have enough balance");

          throw err;
        }

        this.logger.error(
          { err },
          "The transaction failed with error: " + err.shortMessage
        );
      } else if (err instanceof Error) {
        if (err.message.includes("revert")) {
          // Since we are using custom error structs on solidity the rejection
          // doesn't return any information why the call has reverted. Assuming that
          // the update data is valid there is no possible rejection cause other than
          // the target chain price being already updated.
          this.logger.info(
            { err },
            "Execution reverted. With high probability, the target chain price " +
              "has already updated, Skipping this push."
          );
          return;
        }

        if (
          err.message.includes("the tx doesn't have the correct nonce.") ||
          err.message.includes("nonce too low") ||
          err.message.includes("invalid nonce")
        ) {
          this.logger.info(
            { err },
            "The nonce is incorrect (are multiple users using this account?). Skipping this push."
          );
          return;
        }

        if (err.message.includes("max fee per gas less than block base fee")) {
          // We just have to handle this error and return.
          // LastPushAttempt was stored with the class
          // Next time the update will be executing, it will check the last attempt
          // and increase the gas price accordingly.
          this.logger.info(
            { err },
            "The transaction failed with error: max fee per gas less than block base fee "
          );
          return;
        }

        if (
          err.message.includes("sender doesn't have enough funds to send tx.")
        ) {
          this.logger.error(
            { err },
            "Payer is out of balance, please top it up."
          );
          throw err;
        }

        if (err.message.includes("transaction underpriced")) {
          this.logger.error(
            { err },
            "The gas price of the transaction is too low. Skipping this push. " +
              "You might want to use a custom gas station or increase the override gas price " +
              "multiplier to increase the likelihood of the transaction landing on-chain."
          );
          return;
        }

        if (err.message.includes("could not replace existing tx")) {
          this.logger.error(
            { err },
            "A transaction with the same nonce has been mined and this one is no longer needed."
          );
          return;
        }

        this.logger.error({ err }, "An unidentified error has occured.");
        throw err;
      }
    }

    // Update lastAttempt
    this.lastPushAttempt = {
      nonce: txNonce,
      gasPrice: gasPrice,
    };
  }

  private async getPriceFeedsUpdateData(
    priceIds: HexString[]
  ): Promise<string[]> {
    const latestVaas = await this.connection.getLatestVaas(priceIds);
    return latestVaas.map(
      (vaa) => "0x" + Buffer.from(vaa, "base64").toString("hex")
    );
  }
}

export class PythContractFactory {
  private endpoint: string;
  private mnemonic: string;
  private pythContractAddress: Address;
  private chainId: number;

  private constructor(
    endpoint: string,
    mnemonic: string,
    pythContractAddress: Address,
    chainId: number
  ) {
    this.endpoint = endpoint;
    this.mnemonic = mnemonic;
    this.pythContractAddress = pythContractAddress;
    this.chainId = chainId;
  }

  static async create(
    endpoint: string,
    mnemonic: string,
    pythContractAddress: Address
  ): Promise<PythContractFactory> {
    const chainId = await createPublicClient({
      transport: PythContractFactory.getTransport(endpoint),
    }).getChainId();
    return new PythContractFactory(
      endpoint,
      mnemonic,
      pythContractAddress,
      chainId
    );
  }

  /**
   * This method creates a web3 Pyth contract with payer (based on HDWalletProvider). As this
   * provider is an HDWalletProvider it does not support subscriptions even if the
   * endpoint is a websocket endpoint.
   *
   * @returns Pyth contract
   */
  createPythContractWithWallet(): PythContract {
    return getContract({
      address: this.pythContractAddress,
      abi: PythAbi,
      client: {
        public: this.createPublicClient(),
        wallet: this.createWalletClient(),
      },
    });
  }

  /**
   * This method creates a web3 Pyth contract with the given endpoint as its provider. If
   * the endpoint is a websocket endpoint the contract will support subscriptions.
   *
   * @returns Pyth contract
   */
  createPythContract(): PythContract {
    return getContract({
      address: this.pythContractAddress,
      abi: PythAbi,
      client: this.createPublicClient(),
    });
  }

  hasWebsocketProvider(): boolean {
    return isWsEndpoint(this.endpoint);
  }

  createPublicClient(): PublicClient {
    return createPublicClient({
      transport: PythContractFactory.getTransport(this.endpoint),
      chain: this.getChain(),
    });
  }

  getAccount(): Account {
    return mnemonicToAccount(this.mnemonic);
  }

  createWalletClient(): WalletClient {
    return createWalletClient({
      transport: PythContractFactory.getTransport(this.endpoint),
      account: mnemonicToAccount(this.mnemonic),
      chain: this.getChain(),
    });
  }

  private static getTransport(endpoint: string): Transport {
    if (isWsEndpoint(endpoint)) {
      return webSocket(endpoint);
    } else {
      return http(endpoint);
    }
  }

  private getChain(): Chain {
    for (const chain of Object.values(chains)) {
      if (chain.id === this.chainId) {
        console.log(chain.id);
        console.log(chain);
        return chain;
      }
    }
    return defineChain({
      id: this.chainId,
      name: "Unknown",
      nativeCurrency: {
        name: "Unknown",
        symbol: "Unknown",
        decimals: 18,
      },
      rpcUrls: {
        default: {
          http: [],
        },
      },
    });
  }
}
