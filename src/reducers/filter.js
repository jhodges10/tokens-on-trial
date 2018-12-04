import PropTypes from 'prop-types'
import createReducer from 'lessdux'

import * as filterActions from '../actions/filter'
import * as filterConstants from '../constants/filter'
import { defaultFilter } from '../utils/filter'
import { arbitrableTokenList } from '../bootstrap/dapp-api'

// Shapes
const oldestFirstShape = PropTypes.oneOf(
  filterConstants.SORT_OPTIONS_ENUM.indexes
)
const filtersShape = PropTypes.shapeOf({
  Registered: PropTypes.bool.isRequired,
  'Registration Requests': PropTypes.bool.isRequired,
  'Challenged Registration Requests': PropTypes.bool.isRequired,
  Cleared: PropTypes.bool.isRequired,
  'Clearing Requests': PropTypes.bool.isRequired,
  'Challenged Clearing Requests': PropTypes.bool.isRequired,
  'My Submissions': PropTypes.bool.isRequired,
  'My Challenges': PropTypes.bool.isRequired
}).isRequired
export { oldestFirstShape, filtersShape }

// Reducer
const cachedFilters = localStorage.getItem(
  arbitrableTokenList.options.address + 'filter'
)
const parsedFilters =
  cachedFilters && cachedFilters !== 'undefined'
    ? JSON.parse(cachedFilters)
    : undefined

export default createReducer(
  {
    oldestFirst: parsedFilters ? parsedFilters.oldestFirst : 0,
    filters: parsedFilters ? parsedFilters.filters : defaultFilter()
  },
  {
    [filterActions.SET_OLDEST_FIRST]: (
      state,
      { payload: { oldestFirst } }
    ) => ({
      ...state,
      oldestFirst
    }),
    [filterActions.TOGGLE_FILTER]: (state, { payload: { key } }) => ({
      ...state,
      filters: {
        ...state.filters,
        [key]: !state.filters[key]
      }
    })
  }
)
