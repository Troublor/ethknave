import Web3 from 'web3';
import {Service} from './service';
import {EventEmitter} from '@troubkit/tools';
import Web3CoreSub from 'web3-core-subscriptions';
import Web3Eth from 'web3-eth';

type BalanceMonitorEvents = {
    balanceChange: [string, bigint, bigint]; // address, balanceBefore, balanceAfter
    newBlock: [Web3Eth.BlockHeader];
    error: [Error];
}

export class BalanceMonitor extends EventEmitter<BalanceMonitorEvents> implements Service {
    private subscription: Web3CoreSub.Subscription<Web3Eth.BlockHeader> | undefined;

    constructor(
        public readonly web3: Web3,
        public readonly watchAddressList: string[],
    ) {
        super();
    }

    async start(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const bootstrap = () => {
                this.subscription = this.web3.eth.subscribe('newBlockHeaders');
                this.subscription.on('connected', () => {
                    resolve();
                });
                this.subscription.on('data', (blockHeader) => {
                    this.emit('newBlock', blockHeader);
                    this.checkBlock(blockHeader);
                });
                this.subscription.on('error', error => {
                    reject(error);
                });
            };
            this.subscription ? this.shutdown().then(bootstrap).catch(err => {
                reject(err);
            }) : bootstrap();
        });

    }

    shutdown(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.subscription ? this.subscription.unsubscribe((error, result) => {
                if (error) {
                    reject(error);
                }
                if (!result) {
                    reject('unsubscribe failed');
                }
                this.subscription = undefined;
                resolve();
            }) : resolve();
        });
    }

    private async checkBlock(blockHeader: Web3Eth.BlockHeader) {
        for (const addr of this.watchAddressList) {
            const balance0 = await this.web3.eth.getBalance(addr, blockHeader.number - 1);
            const balance1 = await this.web3.eth.getBalance(addr, blockHeader.number);
            if (balance0 !== balance1) {
                this.emit('balanceChange', addr, BigInt(balance0), BigInt(balance1));
            }
        }
    }
}
