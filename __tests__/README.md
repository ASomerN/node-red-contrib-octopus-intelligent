# Test Suite Documentation

This directory contains unit tests for the Octopus Intelligent Node-RED node.

## Test Structure

```
__tests__/
├── bugs.test.js                 # Bug regression tests
├── charging-timers.test.js      # Timer management tests
├── data-processing.test.js      # Data processing and payload construction tests
└── README.md                    # This file
```

## Running Tests

### Run All Tests
```bash
npm test
```

### Run Tests in Watch Mode
```bash
npm run test:watch
```

### Run Tests with Coverage
```bash
npm run test:coverage
```

### Run Specific Test File
```bash
npm test bugs.test.js
npm test charging-timers.test.js
npm test data-processing.test.js
```

### Run Specific Test Suite
```bash
npm test -- -t "Bug #1"
npm test -- -t "setupChargingTimers"
```

## Test Coverage

### Bug Regression Tests (`bugs.test.js`)

Tests that prevent previously fixed bugs from reoccurring:

**Bug #1: Charging Now Initialization State**
- ✅ Active slot at initialization
- ✅ No active slot at initialization
- ✅ Slot ending during initialization
- ✅ No premature state publish from announceControls()

**Bug #2: Charging Now State Synchronization**
- ✅ Slot cancelled between polls
- ✅ New active slot added between polls
- ✅ Regular polling during active slot
- ✅ State published on every fetchData call

### Charging Timer Tests (`charging-timers.test.js`)

Tests for timer management and charging state detection:

**publishChargingState()**
- ✅ Set chargingNow to true and publish ON
- ✅ Set chargingNow to false and publish OFF
- ✅ Handle MQTT disabled
- ✅ Handle missing broker gracefully

**clearChargingTimers()**
- ✅ Clear all active timers
- ✅ Handle clearing when no timers set
- ✅ Clear only active timers

**setupChargingTimers()**
- ✅ Currently charging (active slot)
- ✅ Future slot (not charging)
- ✅ No slots (car not plugged in)
- ✅ Multiple slots with first active
- ✅ Slot just ended
- ✅ Timer cleanup on re-run

**Slot Filtering Logic**
- ✅ Filter out past slots
- ✅ Calculate total energy correctly
- ✅ Calculate charging window correctly

### Data Processing Tests (`data-processing.test.js`)

Tests for API response processing and payload construction:

**buildDefaultPayload()**
- ✅ Create default payload with current state
- ✅ Preserve confirmed and pending state

**Payload Construction from API**
- ✅ Two future slots
- ✅ Active slot (charging now)
- ✅ No slots
- ✅ Three slots
- ✅ Past slots filtered out
- ✅ Mixed past and future slots
- ✅ Preferences extraction
- ✅ Bump charge source detection

## Test Data

Test mocks are defined in `/test-mocks.js`:

- **mockAuthSuccess** - Successful authentication response
- **mockDataWithSlots** - API response with 2 future slots
- **mockDataWithActiveSlot** - API response with 1 active slot
- **mockDataNoSlots** - API response with no slots
- **mockDataWithThreeSlots** - API response with 3 slots
- **expectedPayloadTwoSlots** - Expected Node-RED payload format
- **expectedPayloadActiveSlot** - Expected payload with active slot
- **expectedPayloadNoSlots** - Expected payload with no slots

## Test Utilities

Helper functions for creating mocks:

- `createMockAxios(responses)` - Mock axios HTTP client
- `createMockBroker()` - Mock MQTT broker
- `createMockNode()` - Mock Node-RED node

## Coverage Goals

- **Branches:** 80%+
- **Functions:** 80%+
- **Lines:** 80%+
- **Statements:** 80%+

## Current Coverage Status

Run `npm run test:coverage` to see current coverage metrics.

## Pending Tests

The following tests are documented but not yet implemented (waiting for additional API response examples):

- Authentication flow tests
- Preference mutation tests
- Error handling tests (invalid API key, rate limiting, etc.)
- setPreferences() validation tests
- Exponential backoff retry tests

See `unit_test.md` for full test specifications.

## Test Principles

1. **Isolation** - Each test is independent and doesn't rely on others
2. **Determinism** - Tests use fake timers and mocked dates for consistency
3. **Clarity** - Test names clearly describe what is being tested
4. **Documentation** - JSDoc comments explain scenario, given, and expected
5. **Regression Prevention** - All fixed bugs have corresponding tests

## Debugging Tests

### View Test Output
```bash
npm test -- --verbose
```

### Run Single Test
```bash
npm test -- -t "should initialize with chargingNow=true when slot is active"
```

### Debug with Node Inspector
```bash
node --inspect-brk node_modules/.bin/jest --runInBand
```

Then open `chrome://inspect` in Chrome.

## Contributing

When adding new features or fixing bugs:

1. Write a failing test first (TDD)
2. Implement the fix/feature
3. Verify the test passes
4. Update documentation if needed
5. Run full test suite before committing

## References

- Jest Documentation: https://jestjs.io/
- Test Mocks: `/test-mocks.js`
- Bug Tracking: `/bugs.md`
- Unit Test Plan: `/unit_test.md`
