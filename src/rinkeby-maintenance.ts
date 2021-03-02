import {ContextLogger, Level} from '@troubkit/log';
import Web3 from 'web3';
import {BalanceMonitor} from './lib/balance-monitor';
import YAML from 'yaml';
import * as fs from 'fs';
import path from 'path';
import Web3Core from 'web3-core';
import {sleep} from '@troubkit/tools';

const config = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'config.yml'), {encoding: 'utf-8'}))['rinkeby-maintenance'];

const logger = new ContextLogger('eth-knave', Level.INFO);

const web3 = new Web3(config['endpoint']);

const faucetAccount: Web3Core.Account = web3.eth.accounts.privateKeyToAccount(config['faucetAccountPrivateKey']);
const maintainAccounts: Web3Core.Account[] = [];
for (const privKey of config['maintainPrivateKeys']) {
    maintainAccounts.push(web3.eth.accounts.privateKeyToAccount(privKey));
}
const withdrawAccounts: Web3Core.Account[] = [];
for (const privKey of config['withdrawPrivateKeys']) {
    withdrawAccounts.push(web3.eth.accounts.privateKeyToAccount(privKey));
}

const monitor = new BalanceMonitor(web3, [
    ...maintainAccounts.map(acc => acc.address),
    ...withdrawAccounts.map(acc => acc.address),
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
        to: faucetAccount.address,
        value: amount.toString(10),
        gas: gas,
        gasPrice: gasPrice,
    });
    if (!signedTx.rawTransaction) {
        logger.error('Failed to sign transaction', {
            from: account.address,
            to: faucetAccount.address,
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
    try {
        for (const acc of maintainAccounts) {
            const address = acc.address;
            const balance = BigInt(await web3.eth.getBalance(address));

            const range = [
                BigInt(config['balanceRange']['lower']),
                BigInt(config['balanceRange']['higher']),
            ];

            if (balance < range[0]) {
                // should open faucet
                const amount = range[1] - balance;
                const gas = 21000;
                const gasPrice = await web3.eth.getGasPrice();
                const signedTx = await faucetAccount.signTransaction({
                    from: faucetAccount.address,
                    to: address,
                    value: amount.toString(10),
                    gas: gas,
                    gasPrice: gasPrice,
                });
                if (!signedTx.rawTransaction) {
                    logger.error('Failed to sign transaction', {
                        from: faucetAccount.address,
                        to: address,
                        value: amount.toString(10),
                    });
                    return;
                }
                web3.eth.sendSignedTransaction(signedTx.rawTransaction)
                    .on('transactionHash', txHash => {
                        logger.info('Faucet transaction submitted', {
                            to: address,
                            value: amount.toString(10),
                            txHash: txHash,
                        });
                    })
                    .on('receipt', receipt => {
                        logger.info('Faucet transaction executed', {
                            to: address,
                            value: amount.toString(10),
                            txHash: receipt.transactionHash,
                        });
                    })
                    .on('error', err => {
                        logger.error('Faucet transaction failed', {
                            to: address,
                            value: amount.toString(10),
                            error: err.message,
                        });
                    });
            } else if (balance > range[1]) {
                // transfer ETH out to faucet account
                await withdraw(balance, range[1], acc);
            }
        }
    } catch (e) {
        monitor.emit('error', e);
    }
});
monitor.on('balanceChange', async (address, balanceBefore, balanceAfter) => {
    logger.info('Address balance change', {
        addr: address,
        before: balanceBefore.toString(10),
        after: balanceAfter.toString(10),
    });
    try {
        const account = withdrawAccounts.find(acc => acc.address === address);
        if (!account) return;
        await withdraw(balanceAfter, BigInt(0), account);
    } catch (e) {
        monitor.emit('error', e);
    }
});
monitor.on('error', async (error: Error | undefined) => {
    while (error) {
        logger.error(error.toString());
        logger.warn('error encountered, restarting in 5 seconds...');
        await sleep(5000);
        try {
            await monitor.start();
            logger.info('Balance monitor started');
            error = undefined;
        } catch (e){
            error = e;
        }
    }
});

const cleanup = () => {
    monitor.shutdown().then(() => {
        logger.info('Balance monitor stopped');
    });
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
