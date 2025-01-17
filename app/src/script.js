import '@babel/polyfill'
import { first, map, publishReplay } from 'rxjs/operators'
import { of } from 'rxjs'
import AragonApi from '@aragon/api'

import {
  ETHER_TOKEN_FAKE_ADDRESS,
  isTokenVerified,
  tokenDataFallback,
  getTokenSymbol,
  getTokenName,
} from './lib/token-utils'
import { addressesEqual } from './lib/web3-utils'
import tokenDecimalsAbi from './abi/token-decimals.json'
import tokenNameAbi from './abi/token-name.json'
import tokenSymbolAbi from './abi/token-symbol.json'
import tokenSupplyAbi from './abi/token-totalSupply.json'
import vaultBalanceAbi from './abi/vault-balance.json'
import vaultGetInitializationBlockAbi from './abi/vault-getinitializationblock.json'
import vaultEventAbi from './abi/vault-events.json'

// import tokenManagerTokenAbi from './abi/tokenManager-token.json'
// import tokenManagerBalanceAbi from './abi/tokenManager-spendableBalanceOf.json'
// const tokenManagerAbi = [].concat(tokenManagerTokenAbi, tokenManagerBalanceAbi)

const tokenAbi = [].concat(
  tokenDecimalsAbi,
  tokenNameAbi,
  tokenSymbolAbi,
  tokenSupplyAbi
)
const vaultAbi = [].concat(
  vaultBalanceAbi,
  vaultGetInitializationBlockAbi,
  vaultEventAbi
)

const INITIALIZATION_TRIGGER = Symbol('INITIALIZATION_TRIGGER')
const ACCOUNTS_TRIGGER = Symbol('ACCOUNTS_TRIGGER')

const tokenContracts = new Map() // Addr -> External contract
const tokenDecimals = new Map() // External contract -> decimals
const tokenNames = new Map() // External contract -> name
const tokenSymbols = new Map() // External contract -> symbol

const ETH_CONTRACT = Symbol('ETH_CONTRACT')

const api = new AragonApi()

api.identify('Redemptions')

init()

async function init() {
  try {
    const vaultAddress = await api.call('vault').toPromise()
    initialize(vaultAddress, ETHER_TOKEN_FAKE_ADDRESS)
  } catch (err) {
    console.error(
      'Could not start background script execution due to the contract not loading vault or tokenManager',
      err
    )
    retry()
  }
}

async function initialize(vaultAddress, ethAddress) {
  const vaultContract = api.external(vaultAddress, vaultAbi)

  const redeemableTokenAddress = await api
    .call('getRedeemableToken')
    .toPromise()
  const redeemableTokenContract = api.external(redeemableTokenAddress, tokenAbi)

  const network = await api
    .network()
    .pipe(first())
    .toPromise()

  // Set up ETH placeholders
  tokenContracts.set(ethAddress, ETH_CONTRACT)
  tokenDecimals.set(ETH_CONTRACT, '18')
  tokenNames.set(ETH_CONTRACT, 'Ether')
  tokenSymbols.set(ETH_CONTRACT, 'ETH')

  return createStore({
    network,
    ethToken: {
      address: ethAddress,
    },
    vault: {
      address: vaultAddress,
      contract: vaultContract,
    },
    redeemableToken: {
      address: redeemableTokenAddress,
      contract: redeemableTokenContract,
    },
  })
}

async function createStore(settings) {
  let vaultInitializationBlock

  try {
    vaultInitializationBlock = await settings.vault.contract
      .getInitializationBlock()
      .toPromise()
  } catch (err) {
    console.error("Could not get attached vault's initialization block:", err)
  }

  // Hot observable which emits an web3.js event-like object with an account string of the current active account.
  const accounts$ = api.accounts().pipe(
    map(accounts => {
      return {
        event: ACCOUNTS_TRIGGER,
        account: accounts[0],
      }
    }),
    publishReplay(1)
  )

  accounts$.connect()

  return api.store(
    async (state, event) => {
      const { vault } = settings
      const { address: eventAddress, event: eventName, account } = event
      let nextState = {
        ...state,
      }

      console.log('evento', event)

      if (eventName === INITIALIZATION_TRIGGER) {
        nextState = await initializeState(nextState, settings)
      } else if (eventName === ACCOUNTS_TRIGGER) {
        nextState = await updateConnectedAccount(nextState, account)
      } else if (addressesEqual(eventAddress, vault.address)) {
        // Vault event
        // nextState = await getVaultToken(nextState, event)
      } else {
        // Redemptions event
        nextState = await updateOnRedemption(nextState, settings)
      }
      return nextState
    },
    [
      // Always initialize the store with our own home-made event
      of({ event: INITIALIZATION_TRIGGER }),
      accounts$,
      // Handle Vault events
      settings.vault.contract.events(vaultInitializationBlock),
    ]
  )
}

/***********************
 *                     *
 *   Event Handlers    *
 *                     *
 ***********************/

async function initializeState(state, settings) {
  let nextState = {
    ...state,
    redeemableToken: await getRedeemableTokenData(settings),
    tokens: await updateTokens(settings),
  }

  return nextState
}

async function updateConnectedAccount(state, account) {
  return {
    ...state,
    redeemableToken: {
      ...state.redeemableToken,
      accountBalance: await api.call('spendableBalanceOf', account).toPromise(),
    },
  }
}

async function updateOnRedemption(state, settings) {
  const newSupply = await settings.redeemableToken.contract.totalSupply()
  return {
    ...state,
    redeemableToken: {
      ...state.redeemableToken,
      totalSupply: newSupply,
    },
    tokens: await updateTokens(settings),
  }
}

async function updateTokens(settings) {
  const tokens = await api.call('getTokens').toPromise()
  return await getVaultBalances(tokens, settings)
}

/***********************
 *                     *
 *       Helpers       *
 *                     *
 ***********************/

async function getRedeemableTokenData({ redeemableToken: { contract } }) {
  const [symbol, decimals, totalSupply] = await Promise.all([
    contract.symbol().toPromise(),
    contract.decimals().toPromise(),
    contract.totalSupply().toPromise(),
  ])
  return {
    symbol,
    decimals,
    totalSupply,
  }
}

/** returns `tokens` balances from vault */
async function getVaultBalances(tokens = [], settings) {
  let balances = []
  for (let tokenAddress of tokens) {
    const tokenContract = tokenContracts.has(tokenAddress)
      ? tokenContracts.get(tokenAddress)
      : api.external(tokenAddress, tokenAbi)
    tokenContracts.set(tokenAddress, tokenContract)
    balances = [
      ...balances,
      await newBalanceEntry(tokenContract, tokenAddress, settings),
    ]
  }
  return balances
}

async function newBalanceEntry(tokenContract, tokenAddress, settings) {
  const [balance, decimals, name, symbol] = await Promise.all([
    loadTokenBalance(tokenAddress, settings),
    loadTokenDecimals(tokenContract, tokenAddress, settings),
    loadTokenName(tokenContract, tokenAddress, settings),
    loadTokenSymbol(tokenContract, tokenAddress, settings),
  ])

  return {
    decimals,
    name,
    symbol,
    address: tokenAddress,
    amount: balance,
    verified:
      isTokenVerified(tokenAddress, settings.network.type) ||
      addressesEqual(tokenAddress, settings.ethToken.address),
  }
}

function loadTokenBalance(tokenAddress, { vault }) {
  return vault.contract.balance(tokenAddress).toPromise()
}

async function loadTokenDecimals(tokenContract, tokenAddress, { network }) {
  if (tokenDecimals.has(tokenContract)) {
    return tokenDecimals.get(tokenContract)
  }

  const fallback =
    tokenDataFallback(tokenAddress, 'decimals', network.type) || '0'

  let decimals
  try {
    decimals = (await tokenContract.decimals().toPromise()) || fallback
    tokenDecimals.set(tokenContract, decimals)
  } catch (err) {
    // decimals is optional
    decimals = fallback
  }
  return decimals
}

async function loadTokenName(tokenContract, tokenAddress, { network }) {
  if (tokenNames.has(tokenContract)) {
    return tokenNames.get(tokenContract)
  }
  const fallback = tokenDataFallback(tokenAddress, 'name', network.type) || ''

  let name
  try {
    name = (await getTokenName(api, tokenAddress)) || fallback
    tokenNames.set(tokenContract, name)
  } catch (err) {
    // name is optional
    name = fallback
  }
  return name
}

async function loadTokenSymbol(tokenContract, tokenAddress, { network }) {
  if (tokenSymbols.has(tokenContract)) {
    return tokenSymbols.get(tokenContract)
  }
  const fallback = tokenDataFallback(tokenAddress, 'symbol', network.type) || ''

  let symbol
  try {
    symbol = (await getTokenSymbol(api, tokenAddress)) || fallback
    tokenSymbols.set(tokenContract, symbol)
  } catch (err) {
    // symbol is optional
    symbol = fallback
  }
  return symbol
}
