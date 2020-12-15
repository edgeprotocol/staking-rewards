const fs = require('fs');
const path = require('path');

const { trace, info, error, warning, arg } = require('../utils/logger');

const BATCH_SIZE = 5000;
const ETH_RESERVE_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const MKR_RESERVE_ADDRESS = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2';

const getLiquidityTask = async (env) => {
    const getPosition = async (id, blockNumber) => {
        const position = await contracts.LiquidityProtectionStore.methods.protectedLiquidity(id).call({}, blockNumber);

        return {
            provider: position[0],
            poolToken: position[1],
            reserveToken: position[2],
            poolAmount: position[3],
            reserveAmount: position[4],
            reserveRateN: position[5],
            reserveRateD: position[6],
            timestamp: position[7]
        };
    };

    const getReserveTokenInfo = async (reserveToken) => {
        let name;
        let symbol;
        if (reserveToken === ETH_RESERVE_ADDRESS) {
            name = 'Ethereum Reserve';
            symbol = 'ETH';
        } else if (reserveToken === MKR_RESERVE_ADDRESS) {
            name = 'MakerDAO';
            symbol = 'MKR';
        } else {
            const ReserveToken = new Contract(settings.externalContracts.ERC20.abi, reserveToken);
            name = await ReserveToken.methods.name().call();
            symbol = await ReserveToken.methods.symbol().call();
        }

        return { name, symbol };
    };

    const addSnapshot = (snapshots, timestamp, blockNumber, reserveAmount) => {
        const snapshot = {
            timestamp,
            blockNumber,
            reserveAmount
        };
        const existing = snapshots.findIndex(
            (i) => new BN(i.timestamp).eq(new BN(timestamp)) && new BN(i.blockNumber).eq(new BN(blockNumber))
        );
        if (existing !== -1) {
            snapshots[existing] = snapshot;
        } else {
            snapshots.push(snapshot);
        }
    };

    const getProtectionLiquidityChanges = async (liquidity, fromBlock, toBlock) => {
        let eventCount = 0;
        for (let i = fromBlock; i < toBlock; i += BATCH_SIZE) {
            const endBlock = Math.min(i + BATCH_SIZE - 1, toBlock);

            info(
                'Querying all protection change events from',
                arg('startBlock', i),
                'to',
                arg('endBlock', endBlock),
                'in batches of',
                arg('batchSize', BATCH_SIZE),
                'blocks'
            );

            const events = await contracts.LiquidityProtectionStore.getPastEvents('allEvents', {
                fromBlock: i,
                toBlock: endBlock
            });

            for (const event of events) {
                const { blockNumber, returnValues, transactionHash } = event;
                const block = await web3.eth.getBlock(blockNumber);
                const { timestamp } = block;

                switch (event.event) {
                    case 'ProtectionAdded': {
                        const provider = returnValues._provider;
                        const poolToken = returnValues._poolToken;
                        const reserveToken = returnValues._reserveToken;
                        const reserveAmount = returnValues._reserveAmount;

                        trace(
                            'Found ProtectionAdded event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('reserveAmount', reserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        if (!liquidity[poolToken]) {
                            const PoolToken = new Contract(settings.externalContracts.ERC20.abi, poolToken);
                            const name = await PoolToken.methods.name().call();
                            const symbol = await PoolToken.methods.symbol().call();
                            liquidity[poolToken] = { name, symbol };
                        }

                        const poolTokenRecord = liquidity[poolToken];
                        if (!poolTokenRecord.reserveTokens) {
                            poolTokenRecord.reserveTokens = {};
                        }

                        if (!poolTokenRecord.reserveTokens[reserveToken]) {
                            const { name, symbol } = await getReserveTokenInfo(reserveToken);
                            poolTokenRecord.reserveTokens[reserveToken] = {
                                name,
                                symbol,
                                reserveAmount: 0,
                                snapshots: [
                                    {
                                        timestamp,
                                        blockNumber,
                                        reserveAmount: new BN(reserveAmount).toString()
                                    }
                                ]
                            };
                        }

                        const reserveTokenRecord = poolTokenRecord.reserveTokens[reserveToken];
                        reserveTokenRecord.reserveAmount = new BN(reserveTokenRecord.reserveAmount)
                            .add(new BN(reserveAmount))
                            .toString();

                        addSnapshot(
                            reserveTokenRecord.snapshots,
                            timestamp,
                            blockNumber,
                            reserveTokenRecord.reserveAmount
                        );

                        eventCount++;

                        break;
                    }

                    case 'ProtectionUpdated': {
                        const provider = returnValues._provider;
                        const prevReserveAmount = returnValues._prevReserveAmount;
                        const newReserveAmount = returnValues._newReserveAmount;
                        const prevPoolAmount = returnValues._prevPoolAmount;
                        const newPoolAmount = returnValues._newPoolAmount;

                        trace(
                            'Found ProtectionUpdated event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('prevPoolAmount', prevPoolAmount),
                            arg('newPoolAmount', newPoolAmount),
                            arg('prevReserveAmount', prevReserveAmount),
                            arg('newReserveAmount', newReserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        // Try to find the pool and reserves tokens by matching the position in a previous block.
                        // Please note that we are assuming that a single position wasn't added and removed in the
                        // same block.
                        const matches = [];
                        const prevBlock = blockNumber - 1;
                        const ids = await contracts.LiquidityProtectionStore.methods
                            .protectedLiquidityIds(provider)
                            .call({}, prevBlock);
                        for (const id of ids) {
                            const position = await getPosition(id, prevBlock);
                            if (
                                new BN(position.reserveAmount).eq(new BN(new BN(prevReserveAmount))) &&
                                new BN(position.poolAmount).eq(new BN(new BN(prevPoolAmount)))
                            ) {
                                matches.push({
                                    poolToken: position.poolToken,
                                    reserveToken: position.reserveToken
                                });
                            }
                        }

                        if (matches.length !== 1) {
                            error(
                                'Failed to fully match pool and reserve tokens. Expected to find a single match, but found',
                                arg('matches', matches.length)
                            );
                        }

                        const { poolToken, reserveToken } = matches[0];
                        const poolTokenRecord = liquidity[poolToken];
                        const reserveTokenRecord = poolTokenRecord.reserveTokens[reserveToken];

                        if (new BN(reserveTokenRecord.reserveAmount).lt(new BN(newReserveAmount))) {
                            error(
                                'Update liquidity can only decrease the reserve token amount for',
                                arg('poolToken', poolToken),
                                arg('reserveToken', reserveToken),
                                '[',
                                arg('expected', reserveTokenRecord.reserveAmount),
                                'to be less than',
                                arg('actual', newReserveAmount),
                                ']'
                            );
                        }

                        reserveTokenRecord.reserveAmount = new BN(reserveTokenRecord.reserveAmount)
                            .add(new BN(newReserveAmount))
                            .sub(new BN(prevReserveAmount))
                            .toString();

                        addSnapshot(
                            reserveTokenRecord.snapshots,
                            timestamp,
                            blockNumber,
                            reserveTokenRecord.reserveAmount
                        );

                        eventCount++;

                        break;
                    }

                    case 'ProtectionRemoved': {
                        const provider = returnValues._provider;
                        const poolToken = returnValues._poolToken;
                        const reserveToken = returnValues._reserveToken;
                        const poolAmount = returnValues._poolAmount;
                        const reserveAmount = returnValues._reserveAmount;

                        trace(
                            'Found ProtectionRemoved event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('poolAmount', poolAmount),
                            arg('reserveAmount', reserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        const poolTokenRecord = liquidity[poolToken];
                        const reserveTokenRecord = poolTokenRecord.reserveTokens[reserveToken];

                        if (new BN(reserveTokenRecord.reserveAmount).lt(new BN(reserveAmount))) {
                            error(
                                'Remove liquidity can only decrease the reserve token amount for',
                                arg('poolToken', poolToken),
                                arg('reserveToken', reserveToken),
                                '[',
                                arg('expected', reserveTokenRecord.reserveAmount),
                                'to be less than',
                                arg('actual', reserveAmount),
                                ']'
                            );
                        }

                        reserveTokenRecord.reserveAmount = new BN(reserveTokenRecord.reserveAmount)
                            .sub(new BN(reserveAmount))
                            .toString();

                        addSnapshot(
                            reserveTokenRecord.snapshots,
                            timestamp,
                            blockNumber,
                            reserveTokenRecord.reserveAmount
                        );

                        eventCount++;

                        break;
                    }
                }
            }
        }

        info('Finished processing all new protection change events', arg('count', eventCount));
    };

    const verifyProtectionLiquidity = async (liquidity, toBlock) => {
        info('Verifying all reserve amounts at', arg('blockNumber', toBlock));

        for (const [poolToken, poolTokenData] of Object.entries(liquidity)) {
            for (const [reserveToken, data] of Object.entries(poolTokenData.reserveTokens)) {
                trace('Verifying', arg('poolToken', poolToken), arg('reserveToken', reserveToken));

                const { reserveAmount } = data;

                const actualAmount = await contracts.LiquidityProtectionStore.methods
                    .totalProtectedReserveAmount(poolToken, reserveToken)
                    .call({}, toBlock);
                if (!new BN(reserveAmount).eq(new BN(actualAmount))) {
                    error(
                        'Wrong liquidity',
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken),
                        '[',
                        arg('expected', reserveAmount),
                        arg('actual', actualAmount),
                        ']'
                    );
                }

                const { snapshots } = data;

                for (const snapshot of snapshots) {
                    const { blockNumber, timestamp, reserveAmount } = snapshot;

                    // Verify snapshot values.
                    const actualSnapshotAmount = await contracts.LiquidityProtectionStore.methods
                        .totalProtectedReserveAmount(poolToken, reserveToken)
                        .call({}, blockNumber);
                    if (!new BN(actualSnapshotAmount).eq(new BN(reserveAmount))) {
                        console.log(data);
                        error(
                            'Wrong snapshot liquidity',
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('blockNumber', blockNumber),
                            arg('timestamp', reserveToken),
                            '[',
                            arg('expected', reserveAmount),
                            arg('actual', actualSnapshotAmount),
                            ']'
                        );
                    }

                    // Verify snapshot timestamps.
                    const block = await web3.eth.getBlock(blockNumber);
                    const { timestamp: blockTimeStamp } = block;
                    if (!new BN(timestamp).eq(new BN(blockTimeStamp))) {
                        error(
                            'Wrong snapshot timestamp',
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('blockNumber', blockNumber),
                            arg('timestamp', reserveToken),
                            '[',
                            arg('expected', timestamp),
                            arg('actual', blockTimeStamp),
                            ']'
                        );
                    }
                }

                // Verify that the snapshots array is sorted in an ascending order.
                for (let i = 0; i + 1 < snapshots.length - 1; ++i) {
                    const snapshot1 = snapshots[i];
                    const snapshot2 = snapshots[i + 1];
                    if (new BN(snapshot1.timestamp).gt(new BN(snapshot2.timestamp))) {
                        error(
                            'Wrong snapshots order',
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('snapshot1', snapshot1),
                            arg('snapshot2', snapshot2)
                        );
                    }
                }
            }
        }
    };

    const getProtectedLiquidity = async (data, fromBlock, toBlock) => {
        if (!data.liquidity) {
            data.liquidity = {};
        }

        await getProtectionLiquidityChanges(data.liquidity, fromBlock, toBlock);
        await verifyProtectionLiquidity(data.liquidity, toBlock);

        data.lastBlockNumber = toBlock;
    };

    const { settings, reorgOffset, web3, contracts, BN, Contract } = env;

    const dbDir = path.resolve(__dirname, '../data');
    const dbPath = path.join(dbDir, 'liquidity.json');
    let data = {};
    if (fs.existsSync(dbPath)) {
        const rawData = fs.readFileSync(dbPath);
        data = JSON.parse(rawData);
    }

    let fromBlock;
    if (!data.lastBlockNumber) {
        warning('DB last block number is missing. Starting from the beginning');
        fromBlock = settings.genesisBlock;
    } else {
        fromBlock = data.lastBlockNumber + 1;
    }

    const latestBlock = await web3.eth.getBlockNumber();
    if (latestBlock === 0) {
        error('Node is out of sync. Please try again later');
    }

    const toBlock = latestBlock - reorgOffset;
    if (toBlock - fromBlock < reorgOffset) {
        error(
            'Unable to satisfy the reorg window. Please wait for additional',
            arg('blocks', reorgOffset - (toBlock - fromBlock + 1)),
            'to pass'
        );
    }

    info('Getting protected liquidity from', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));

    await getProtectedLiquidity(data, fromBlock, toBlock);

    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

module.exports = getLiquidityTask;
