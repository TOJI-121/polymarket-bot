import { ethers } from 'ethers';
import { Config } from './types';
import { getLogger } from './utils';

export class WalletManager {
  private config: Config;
  private logger: ReturnType<typeof getLogger>;
  private provider: ethers.Provider | null = null;
  private wallet: ethers.Wallet | null = null;

  constructor(config: Config) {
    this.config = config;
    this.logger = getLogger(config);

    if (config.simulation) return;

    try {
      this.provider = new ethers.JsonRpcProvider(config.polygonRpc);
    } catch (err) {
      this.logger.warn('Failed to initialize provider');
      return;
    }
  }

  getWallet(): ethers.Wallet | undefined {
    return this.wallet || undefined;
  }

  getAddress(): string | null {
    return this.wallet?.address || null;
  }

  isReady(): boolean {
    return this.wallet !== null && this.provider !== null;
  }

  anyReady(): boolean {
    return this.wallet !== null;
  }

  async getUsdcBalance(): Promise<number> {
    if (!this.wallet || !this.provider) return 0;

    const usdcContract = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const abi = ['function balanceOf(address) view returns (uint256)'];

    try {
      const contract = new ethers.Contract(usdcContract, abi, this.provider);
      const balance: bigint = await contract.balanceOf(this.wallet.address);
      return parseFloat(ethers.formatUnits(balance, 6));
    } catch {
      return 0;
    }
  }

  async signMessage(message: string): Promise<string | null> {
    if (!this.wallet) return null;
    try {
      return await this.wallet.signMessage(message);
    } catch {
      return null;
    }
  }
}
