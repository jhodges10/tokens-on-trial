import createEnum from '../utils/create-enum'

// Token
export const IN_CONTRACT_STATUS_ENUM = createEnum([
  'Absent', // The item has never been submitted.
  'Registered', // The item has been submitted and the dispute resolution process determined it should be added or the submission was never contested.
  'RegistrationRequested', // The item has been submitted.
  'ClearingRequested' // The item is registered, but someone has requested to remove it.
])

export const RULING_OPTIONS = createEnum(['Other', 'Accept', 'Reject'])
export const SIDE = createEnum(['None', 'Requester', 'Challenger'])
export const STATUS_ENUM = createEnum([
  'Pending',
  'Challenged',
  'Registered',
  'Absent'
])

export const STATUS_ICON_ENUM = createEnum([
  'hourglass-half',
  'gavel',
  'check',
  'times-circle'
])

export const STATUS_COLOR_ENUM = createEnum([
  '#0A72BD',
  '#FB7413',
  '#11BABD',
  '#EF0101'
])

// Gallery Settings
export const FILTER_OPTIONS_ENUM = createEnum([
  'Registered',
  'Registration Requests',
  'Challenged Registration Requests',
  'Cleared',
  'Clearing Requests',
  'Challenged Clearing Requests',
  'My Submissions',
  'My Challenges'
])
export const SORT_OPTIONS_ENUM = createEnum(['Newest', 'Oldest'])

// helloThere => Hello There
export const camelCaseAddSpaces = str =>
  str.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())
