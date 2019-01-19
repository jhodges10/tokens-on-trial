import * as mime from 'mime-types'

import { all, call, select, takeLatest } from 'redux-saga/effects'

import { lessduxSaga } from '../utils/saga'
import {
  arbitrableTokenList,
  arbitrator,
  archon,
  web3
} from '../bootstrap/dapp-api'
import { contractStatusToClientStatus, hasPendingRequest } from '../utils/token'
import * as tokenActions from '../actions/token'
import * as tokenSelectors from '../reducers/token'
import * as walletSelectors from '../reducers/wallet'
import * as tokenConstants from '../constants/token'
import * as arbitrableTokenListSelectors from '../reducers/arbitrable-token-list'
import * as errorConstants from '../constants/error'

import storeApi from './api/store'

// Converts token string data to correct js types.
const convertFromString = token => {
  const { latestRequest } = token
  latestRequest.submissionTime = Number(latestRequest.submissionTime) * 1000
  latestRequest.challengerDepositTime =
    Number(latestRequest.challengerDepositTime) * 1000
  latestRequest.numberOfRounds = Number(latestRequest.numberOfRounds)

  const { latestRound } = latestRequest
  latestRound.ruling = Number(latestRound.ruling)
  latestRound.paidFees[0] = Number(latestRound.paidFees[0])
  latestRound.paidFees[1] = Number(latestRound.paidFees[1])
  latestRound.paidFees[2] = Number(latestRound.paidFees[2])
  latestRound.requiredForSide[0] = Number(latestRound.requiredForSide[0])
  latestRound.requiredForSide[1] = Number(latestRound.requiredForSide[1])
  latestRound.requiredForSide[2] = Number(latestRound.paidFees[2])
  token.latestRound = latestRound
  return token
}

/**
 * Fetches a paginatable list of tokens.
 * @param {{ type: string, payload: ?object, meta: ?object }} action - The action object.
 * @returns {object[]} - The fetched tokens.
 */
function* fetchTokens({
  payload: { cursor, count, filterValue, sortValue, requestedPage }
}) {
  const totalCount = yield call(arbitrableTokenList.methods.tokenCount().call, {
    from: yield select(walletSelectors.getAccount)
  })

  if (requestedPage * count > totalCount) {
    // Page does not exist. Set to closest.
    requestedPage =
      totalCount % 2 === 0 ? totalCount / count : totalCount / count + 1
    requestedPage = Math.trunc(requestedPage)
  }

  if (requestedPage > 1)
    cursor = yield call(
      arbitrableTokenList.methods.tokensList(requestedPage - 1).call,
      {
        from: yield select(walletSelectors.getAccount)
      }
    )

  const data = yield call(
    arbitrableTokenList.methods.queryTokens(
      cursor,
      count,
      filterValue,
      sortValue
    ).call,
    { from: yield select(walletSelectors.getAccount) }
  )

  const tokens = [
    ...(cursor === '0x00'
      ? []
      : (yield select(tokenSelectors.getTokens)) || []),
    ...(yield all(
      data.values
        .filter(
          ID =>
            ID !==
            '0x0000000000000000000000000000000000000000000000000000000000000000'
        )
        .map(ID => call(fetchToken, { payload: { ID } }))
    ))
  ]
  tokens.hasMore = data.hasMore
  tokens.totalCount = Number(totalCount)
  return tokens
}

/**
 * Fetches a token from the list.
 * @param {{ type: string, payload: ?object, meta: ?object }} action - The action object.
 * @returns {object} - The fetched token.
 */
export function* fetchToken({ payload: { ID } }) {
  let token = yield call(arbitrableTokenList.methods.getTokenInfo(ID).call)

  if (Number(token.numberOfRequests > 0)) {
    token.latestRequest = yield call(
      arbitrableTokenList.methods.getRequestInfo(
        ID,
        Number(token.numberOfRequests) - 1
      ).call
    )

    if (token.latestRequest.disputed) {
      // Fetch dispute data.
      token.latestRequest.dispute = yield call(
        arbitrator.methods.disputes(token.latestRequest.disputeID).call
      )

      // Fetch appeal period and cost if in appeal period.
      if (
        token.latestRequest.dispute.status ===
          tokenConstants.DISPUTE_STATUS.Appealable.toString() &&
        !token.latestRequest.appealed
      ) {
        token.latestRequest.appealPeriod = yield call(
          arbitrator.methods.appealPeriod(token.latestRequest.disputeID).call
        )
        token.latestRequest.appealCost = yield call(
          arbitrator.methods.appealCost(token.latestRequest.disputeID, '0x0')
            .call
        )
      }
    }

    token.latestRequest.latestRound = yield call(
      arbitrableTokenList.methods.getRoundInfo(
        ID,
        Number(token.numberOfRequests) - 1,
        Number(token.latestRequest.numberOfRounds) - 1
      ).call
    )

    token = convertFromString(token)
  } else
    token.latestRequest = {
      disputed: false,
      disputeID: 0,
      dispute: null,
      submissionTime: 0,
      challengeRewardBalance: 0,
      challengerDepositTime: 0,
      feeRewards: 0,
      pot: [],
      resolved: false,
      parties: [],
      latestRound: {
        appealed: false,
        paidFees: [],
        requiredForSide: []
      }
    }

  return {
    ...token,
    ID,
    status: Number(token.status),
    clientStatus: contractStatusToClientStatus(
      token.status,
      token.latestRequest.disputed,
      token.latestRequest.resolved
    )
  }
}

/**
 * Requests status change.
 * @param {{ type: string, payload: ?object, meta: ?object }} action - The action object.
 * @returns {object} - The `lessdux` collection mod object for updating the list of tokens.
 */
function* requestStatusChange({ payload: { token, file, fileData } }) {
  if (isInvalid(token.addr))
    throw new Error('Missing address on token submit', token)

  const tokenToSubmit = {
    name: token.name,
    ticker: token.ticker,
    addr: web3.utils.toChecksumAddress(token.addr),
    symbolMultihash: token.symbolMultihash,
    networkID: 'ETH'
  }

  if (file && fileData) {
    /* eslint-disable unicorn/number-literal-case */
    const fileMultihash = archon.utils.multihashFile(fileData, 0x1b) // keccak-256
    const fileTypeExtension = file.name.split('.')[1]
    const mimeType = mime.lookup(fileTypeExtension)
    yield call(storeApi.postEncodedFile, fileData, fileMultihash, mimeType)
    tokenToSubmit.symbolMultihash = fileMultihash
  }

  const { name, ticker, addr, networkID, symbolMultihash } = tokenToSubmit

  if (isInvalid(name) || isInvalid(ticker) || isInvalid(symbolMultihash))
    throw new Error('Missing data on token submit', tokenToSubmit)

  const ID = web3.utils.soliditySha3(
    name,
    ticker,
    addr,
    symbolMultihash,
    networkID
  )

  const recentToken = yield call(fetchToken, { payload: { ID } })

  if (
    recentToken.status ===
      tokenConstants.IN_CONTRACT_STATUS_ENUM.RegistrationRequested ||
    recentToken.status ===
      tokenConstants.IN_CONTRACT_STATUS_ENUM.ClearingRequested
  )
    throw new Error(errorConstants.TOKEN_IN_WRONG_STATE)

  yield call(
    arbitrableTokenList.methods.requestStatusChange(
      tokenToSubmit.name,
      tokenToSubmit.ticker,
      tokenToSubmit.addr,
      tokenToSubmit.symbolMultihash,
      tokenToSubmit.networkID
    ).send,
    {
      from: yield select(walletSelectors.getAccount),
      value: yield select(arbitrableTokenListSelectors.getSubmitCost)
    }
  )

  return yield call(fetchToken, { payload: { ID } })
}

/**
 * Challenge request.
 * @param {{ type: string, payload: ?object, meta: ?object }} action - The action object.
 * @returns {object} - The `lessdux` collection mod object for updating the list of tokens.
 */
function* challengeRequest({ payload: { ID, value } }) {
  // Add to contract if absent
  const token = yield call(fetchToken, { payload: { ID } })
  if (!hasPendingRequest(token))
    throw new Error(errorConstants.NO_PENDING_REQUEST)

  yield call(arbitrableTokenList.methods.challengeRequest(ID).send, {
    from: yield select(walletSelectors.getAccount),
    value
  })

  return yield call(fetchToken, { payload: { ID } })
}

/**
 * Fund a side of a dispute.
 * @param {{ type: string, payload: ?object, meta: ?object }} action - The action object.
 * @returns {object} - The `lessdux` collection mod object for updating the list of tokens.
 */
function* fundDispute({ payload: { ID, value, side } }) {
  // Add to contract if absent
  const token = yield call(fetchToken, { payload: { ID } })
  if (!hasPendingRequest(token))
    throw new Error(errorConstants.NO_PENDING_REQUEST)

  yield call(arbitrableTokenList.methods.fundLatestRound(ID, side).send, {
    from: yield select(walletSelectors.getAccount),
    value
  })

  return yield call(fetchToken, { payload: { ID } })
}

/**
 * Fund a side of a dispute
 * @param {{ type: string, payload: ?object, meta: ?object }} action - The action object.
 * @returns {object} - The `lessdux` collection mod object for updating the list of tokens.
 */
function* fundAppeal({ payload: { ID, side, value } }) {
  yield call(arbitrableTokenList.methods.fundLatestRound(ID, side).send, {
    from: yield select(walletSelectors.getAccount),
    value
  })

  return yield call(fetchToken, { payload: { ID } })
}

/**
 * Execute a request for a token.
 * @param {{ type: string, payload: ?object, meta: ?object }} action - The action object.
 * @returns {object} - The `lessdux` collection mod object for updating the list of tokens.
 */
function* timeout({ payload: { ID } }) {
  const status = Number((yield call(fetchToken, { payload: { ID } })).status)
  if (
    status !== tokenConstants.IN_CONTRACT_STATUS_ENUM.RegistrationRequested &&
    status !== tokenConstants.IN_CONTRACT_STATUS_ENUM.ClearingRequested
  )
    throw new Error(errorConstants.TOKEN_IN_WRONG_STATE)

  yield call(arbitrableTokenList.methods.timeout(ID).send, {
    from: yield select(walletSelectors.getAccount)
  })

  return yield call(fetchToken, { payload: { ID } })
}

/**
 * Timeout challenger.
 * @param {{ type: string, payload: ?object, meta: ?object }} action - The action object.
 * @returns {object} - The `lessdux` collection mod object for updating the list of tokens.
 */
function* feeTimeout({ payload: { token } }) {
  yield call(arbitrableTokenList.methods.timeout(token.ID).send, {
    from: yield select(walletSelectors.getAccount)
  })

  return yield call(fetchToken, { payload: { ID: token.ID } })
}

/**
 * Check if a string is undefined, not a string or empty.
 * @param {string} str input string.
 * @returns {bool} Weather it passes the test.
 */
function isInvalid(str) {
  return !str || typeof str !== 'string' || str.trim().length === 0
}

// Update collection mod flows
const updateTokensCollectionModFlow = {
  flow: 'update',
  collection: tokenActions.tokens.self,
  updating: ({ payload: { ID } }) => ID,
  find: ({ payload: { ID } }) => d => d.ID === ID
}

/**
 * The root of the token saga.
 */
export default function* tokenSaga() {
  // Tokens
  yield takeLatest(
    tokenActions.tokens.FETCH,
    lessduxSaga,
    'fetch',
    tokenActions.tokens,
    fetchTokens
  )

  // Token
  yield takeLatest(
    tokenActions.token.FETCH,
    lessduxSaga,
    'fetch',
    tokenActions.token,
    fetchToken
  )
  yield takeLatest(
    tokenActions.token.CREATE,
    lessduxSaga,
    {
      flow: 'create',
      collection: tokenActions.tokens.self
    },
    tokenActions.token,
    requestStatusChange
  )
  yield takeLatest(
    tokenActions.token.STATUS_CHANGE,
    lessduxSaga,
    updateTokensCollectionModFlow,
    tokenActions.token,
    requestStatusChange
  )
  yield takeLatest(
    tokenActions.token.RESUBMIT,
    lessduxSaga,
    updateTokensCollectionModFlow,
    tokenActions.token,
    requestStatusChange
  )
  yield takeLatest(
    tokenActions.token.CLEAR,
    lessduxSaga,
    updateTokensCollectionModFlow,
    tokenActions.token,
    requestStatusChange
  )
  yield takeLatest(
    tokenActions.token.EXECUTE,
    lessduxSaga,
    updateTokensCollectionModFlow,
    tokenActions.token,
    timeout
  )
  yield takeLatest(
    tokenActions.token.FUND_DISPUTE,
    lessduxSaga,
    updateTokensCollectionModFlow,
    tokenActions.token,
    fundDispute
  )
  yield takeLatest(
    tokenActions.token.FEES_TIMEOUT,
    lessduxSaga,
    updateTokensCollectionModFlow,
    tokenActions.token,
    feeTimeout
  )
  yield takeLatest(
    tokenActions.token.FUND_APPEAL,
    lessduxSaga,
    updateTokensCollectionModFlow,
    tokenActions.token,
    fundAppeal
  )
  yield takeLatest(
    tokenActions.token.CHALLENGE_REQUEST,
    lessduxSaga,
    updateTokensCollectionModFlow,
    tokenActions.token,
    challengeRequest
  )
}
