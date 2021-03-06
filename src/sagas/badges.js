import { put, takeLatest, call, all } from 'redux-saga/effects'

import {
  FETCH_BADGES_CACHE,
  cacheBadges,
  fetchBadgesFailed
} from '../actions/badges'
import {
  contractStatusToClientStatus,
  instantiateEnvObjects
} from '../utils/tcr'
import { APP_VERSION } from '../bootstrap/dapp-api'
import * as tcrConstants from '../constants/tcr'

import { fetchAppealable } from './utils'

const fetchEvents = async ({ eventName, fromBlock, contract }) =>
  contract.getPastEvents(eventName, { fromBlock })

/**
 * Fetches the all items in a TCR.
 * @param {object} tcr - The TCR object.
 * @returns {object} - The items on the tcr.
 */
function* fetchItems({
  arbitrableAddressListView,
  blockNumber: tcrBlockNumber,
  badges,
  arbitratorView,
  ARBITRATOR_BLOCK
}) {
  // Get the lastest status change for every badge.

  let statusBlockNumber = tcrBlockNumber
  const latestStatusChanges = {}
  const statusChanges = yield call(fetchEvents, {
    eventName: 'AddressStatusChange',
    fromBlock:
      badges.statusBlockNumber === tcrBlockNumber
        ? tcrBlockNumber
        : badges.statusBlockNumber,
    contract: arbitrableAddressListView
  })

  statusChanges.forEach(event => {
    const { returnValues } = event
    const { _address } = returnValues
    if (event.blockNumber > statusBlockNumber)
      statusBlockNumber = event.blockNumber

    if (!latestStatusChanges[_address]) {
      latestStatusChanges[_address] = event
      return
    }
    if (event.blockNumber > latestStatusChanges[_address].blockNumber)
      latestStatusChanges[_address] = event
  })

  const statusEvents = Object.keys(latestStatusChanges).map(
    address => latestStatusChanges[address]
  )

  const cachedBadges = {
    ...badges,
    statusBlockNumber
  }

  statusEvents.forEach(event => {
    const { returnValues, blockNumber } = event
    const {
      _address,
      _status,
      _disputed,
      _requester,
      _challenger
    } = returnValues
    cachedBadges.items[_address] = {
      address: _address,
      badgeContractAddr: arbitrableAddressListView.options.address,
      blockNumber,
      status: {
        status: Number(_status),
        disputed: _disputed,
        requester: _requester,
        challenger: _challenger
      }
    }
  })

  Object.keys(cachedBadges.items).forEach(address => {
    cachedBadges.items[address].clientStatus = contractStatusToClientStatus(
      cachedBadges.items[address].status.status,
      cachedBadges.items[address].status.disputed
    )
  })

  // Mark items in appeal period.
  // Fetch badge disputes in appeal period.
  const disputesInAppealPeriod = yield call(
    fetchAppealable,
    arbitratorView,
    ARBITRATOR_BLOCK,
    arbitrableAddressListView
  )

  // The appeal period can also be over if the arbitrators gave
  // a decisive ruling (did not refuse or failed to rule) and the
  // loser of the previous round did not get fully funded in within
  // the first half of the appeal period.
  // Remove items that fall under that category.
  const addressesInAppealPeriod = {}
  for (const disputeID of Object.keys(disputesInAppealPeriod)) {
    // To do this we must:
    // 1- Find out which side lost the previous round.
    // 2- Find out if the loser received enough arbitration fees.

    // 1- Find out which party lost the previous round.
    const currentRuling = Number(
      yield call(arbitratorView.methods.currentRuling(disputeID).call)
    )
    const address = yield call(
      arbitrableAddressListView.methods.arbitratorDisputeIDToAddress(
        arbitratorView._address,
        disputeID
      ).call
    )

    // If there was no decisive ruling, there is no loser and the rule does not apply.
    if (currentRuling === tcrConstants.RULING_OPTIONS.None) {
      addressesInAppealPeriod[address] = true
      continue
    }

    const loser =
      currentRuling === tcrConstants.RULING_OPTIONS.Accept
        ? tcrConstants.SIDE.Challenger
        : tcrConstants.SIDE.Requester

    // 2- We start by fetching information on the latest round.
    const numberOfRequests = Number(
      (yield call(
        arbitrableAddressListView.methods.getAddressInfo(address).call
      )).numberOfRequests
    )
    const numberOfRounds = Number(
      (yield call(
        arbitrableAddressListView.methods.getRequestInfo(
          address,
          numberOfRequests - 1
        ).call
      )).numberOfRounds
    )
    const latestRound = yield call(
      arbitrableAddressListView.methods.getRoundInfo(
        address,
        numberOfRequests - 1,
        numberOfRounds - 1
      ).call
    )
    const loserPaid = latestRound.hasPaid[loser]
    const appealPeriodStart = disputesInAppealPeriod[disputeID][0]
    const appealPeriodEnd = disputesInAppealPeriod[disputeID][1]
    const endOfHalf =
      appealPeriodStart + (appealPeriodEnd - appealPeriodStart) / 2

    addressesInAppealPeriod[address] =
      endOfHalf * 1000 > Date.now() ||
      (loserPaid && Date.now() < appealPeriodEnd * 1000)
  }

  // Update appealPeriod state of each item.
  for (const address of Object.keys(cachedBadges.items))
    cachedBadges.items[address].inAppealPeriod = !!addressesInAppealPeriod[
      address
    ]

  return cachedBadges
}

/**
 * Fetches the block number of a deployed TCR contract.
 * @param {object} tcr - The TCR object.
 * @returns {object} - An object with the TCR address and its deployment block number.
 */
function* fetchBlockNumber(tcr) {
  // Fetch the contract deployment block number. We use the first meta evidence
  // events emitted when the constructor is run.
  const metaEvidenceEvents = (yield call(fetchEvents, {
    eventName: 'MetaEvidence',
    contract: tcr,
    fromBlock: 0
  })).sort((a, b) => a.blockNumber - b.blockNumber)

  return {
    address: tcr.options.address,
    blockNumber: metaEvidenceEvents[0].blockNumber
  }
}

/**
 * Fetches all items from all badge TCRs.
 * @param {{ type: string, payload: ?object, meta: ?object }} action - The action object.
 */
function* fetchBadges() {
  const {
    badgeViewContracts,
    arbitrableTokenListView: {
      options: { address: t2crAddr }
    },
    arbitratorView,
    ARBITRATOR_BLOCK
  } = yield call(instantiateEnvObjects)

  const blockNumbers = (yield all(
    Object.keys(badgeViewContracts).map(address =>
      call(fetchBlockNumber, badgeViewContracts[address])
    )
  )).reduce((acc, curr) => {
    acc[curr.address] = curr.blockNumber
    return acc
  }, {})

  const cachedBadges = localStorage.getItem(`${t2crAddr}badges@${APP_VERSION}`)
  if (cachedBadges)
    // Load current cache while loading newer data.
    yield put(cacheBadges(JSON.parse(cachedBadges)))

  try {
    const badges = (yield all(
      Object.keys(badgeViewContracts).map(address =>
        call(fetchItems, {
          arbitrableAddressListView: badgeViewContracts[address],
          blockNumber: blockNumbers[address],
          badges:
            cachedBadges && cachedBadges[address]
              ? cachedBadges[address]
              : {
                  badgeContractAddr: address,
                  statusBlockNumber: blockNumbers[address], // Use contract block number by default
                  items: {}
                },
          arbitratorView,
          ARBITRATOR_BLOCK
        })
      )
    )).reduce((acc, curr) => {
      acc[curr.badgeContractAddr] = curr
      return acc
    }, {})

    localStorage.setItem(
      `${t2crAddr}badges@${APP_VERSION}`,
      JSON.stringify(badges)
    )

    yield put(cacheBadges(badges))
  } catch (err) {
    if (err.message === 'Returned error: request failed or timed out')
      // This is a web3js bug. https://github.com/ethereum/web3.js/issues/2311
      // We can't upgrade to version 37 as suggested because we hit bug https://github.com/ethereum/web3.js/issues/1802.
      // Work around it by just trying again.
      yield put({ type: FETCH_BADGES_CACHE })
    else {
      console.error('Error fetching badges ', err)
      yield put(fetchBadgesFailed())
    }
  }
}

/**
 * The root of the badges saga.
 */
export default function* actionWatcher() {
  yield takeLatest(FETCH_BADGES_CACHE, fetchBadges)
}
