import {ContextLogger, Level} from '@troubkit/log';
import Web3 from 'web3';
import {BalanceMonitor} from './lib/balance-monitor';
import YAML from 'yaml';
import * as fs from 'fs';
import path from 'path';
import Web3Core from 'web3-core';

const config = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'config.yml'), {encoding: 'utf-8'}))['eth-collect'];

const logger = new ContextLogger('eth-collect', Level.INFO);

const web3 = new Web3(config['endpoint']);

const targetAddress = config['targetAddress'];
const collectAccounts: Web3Core.Account[] = [];
for (const privKey of config['collectPrivateKeys']) {
    collectAccounts.push(web3.eth.accounts.privateKeyToAccount(privKey));
}

const monitor = new BalanceMonitor(web3, [
    ...collectAccounts.map(acc => acc.address),
]);

logger.info('Starting...');

monitor.start().then(() => {
    logger.info('Balance monitor started');
});

// if currentBalance - gas * gasPrice > balance Line, then withdraw the ETH to faucet Account
const withdraw = async (currentBalance: bigint, balanceLine: bigint, account: Web3Core.Account) => {
    const gas = 21000;
    const gasPrice = await web3.eth.getGasPrice();
    const amount = currentBalance - BigInt(gas) * BigInt(gasPrice) - balanceLine;
    if (amount <= 0) {
        return;
    }
    const signedTx = await account.signTransaction({
        from: account.address,
        to: targetAddress,
        value: amount.toString(10),
        gas: gas,
        gasPrice: gasPrice,
    });
    if (!signedTx.rawTransaction) {
        logger.error('Failed to sign transaction', {
            from: account.address,
            to: targetAddress,
            value: amount.toString(10),
        });
        return;
    }
    web3.eth.sendSignedTransaction(signedTx.rawTransaction)
        .on('transactionHash', txHash => {
            logger.info('Withdraw transaction submitted', {
                from: account.address,
                value: amount.toString(10),
                txHash: txHash,
            });
        })
        .on('receipt', receipt => {
            logger.info('Withdraw transaction executed', {
                from: account.address,
                value: amount.toString(10),
                txHash: receipt.transactionHash,
            });
        })
        .on('error', err => {
            logger.error('Withdraw transaction failed', {
                from: account.address,
                value: amount.toString(10),
                error: err.message,
            });
        });
};
monitor.on('newBlock', async block => {
    logger.debug('New block', {
        number: block.number,
        hash: block.hash,
    });

    for (const acc of collectAccounts) {
        const address = acc.address;
        const balance = BigInt(await web3.eth.getBalance(address));
        // transfer ETH out to target account
        await withdraw(balance, BigInt(0), acc);
    }
});
monitor.on('balanceChange', async (address, balanceBefore, balanceAfter) => {
    logger.info('Address balance change', {
        addr: address,
        before: balanceBefore.toString(10),
        after: balanceAfter.toString(10),
    });
});

const cleanup = () => {
    monitor.shutdown().then(() => {
        logger.info('Balance monitor stopped');
    });
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
