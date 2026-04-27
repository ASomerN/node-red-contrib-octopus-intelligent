# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-04-26

### Added
- **Smart Charging Toggle** — suspend or unsuspend Octopus intelligent charging from Node-RED or Home Assistant
  - `msg.payload = { set_smart_charging: true }` — enable (unsuspend)
  - `msg.payload = { set_smart_charging: false }` — disable (suspend)
- **HA MQTT Switch** — "Smart Charging" switch entity in Home Assistant (auto-discovered)
- **`smart_charging` payload field** — `true` = active, `false` = suspended, `null` = unknown (startup fetch pending or failed)
- **Device ID startup fetch** — `krakenflexDeviceId` fetched once at startup via `registeredKrakenflexDevice` query; cached permanently

### Technical
- Mirrors `setPreferences` pattern: auth → mutation → optimistic update → exponential backoff verification (15s/30s/60s/120s)
- Verification re-fetches `registeredKrakenflexDevice.suspended` to confirm state change
- Zero new npm dependencies

---

## [1.1.1] - 2026-04-26

### Security
- **Removed `axios` dependency** — replaced with Node.js built-in `https` module; eliminates 13 transitive packages and all associated supply chain risk
- **Removed test/mock files from npm package** — `__tests__/` and `test-mocks.js` no longer published; removes 139 kB of dev artefacts from end-user installs
- **Removed images from npm package** — 364 kB of images no longer bundled; README images now reference GitHub raw URLs and render correctly on npmjs.com

### Changed
- Package size reduced from 369 kB → 27 kB (93% reduction)
- Zero production dependencies (was: `axios ^1.6.0`)

---

## [1.1.0] - 2026-04-24

### Added
- **Locale Timestamps** — new `*_locale` fields in every payload, always in server auto-detected timezone
  - `slot1_start_locale`, `slot1_end_locale`, `slot2_start_locale`, `slot2_end_locale`
  - `slot3_start_locale`, `slot3_end_locale`, `window_start_locale`, `window_end_locale`
  - `next_start_locale`
- **Timezone Metadata** — `timezone_detected` (server auto-detect) and `timezone_applied` (active TZ for display fields)
- **HA Timezone Select Entity** — `select.octopus_timezone` with 15 curated IANA timezones covering all Octopus operating countries (UK, AU, DE, ES, NZ, US)
  - Selection persists across Node-RED restarts via node context storage
  - State republished to HA on Node-RED startup
- **`set_timezone` Input Command** — `msg.payload = { set_timezone: "Europe/London" }`, same pattern as `set_limit`/`set_time`
- **`timezoneOverride` Node Config Field** — optional IANA timezone in node editor, leave blank for auto-detect
- **Timezone Diagnostic Sensors** — `sensor.octopus_timezone_detected` and `sensor.octopus_timezone_applied`

### Changed
- **Display timestamp fields now output resolved timezone** instead of raw UTC
  - Affected fields: `slot1_start`, `slot1_end`, `slot2_start`, `slot2_end`, `slot3_start`, `slot3_end`, `window_start`, `window_end`, `next_start`
  - Resolution order: HA-persisted selection → `timezoneOverride` config → server auto-detected
  - **Raw fields (`*_raw`) remain unchanged** — always exact UTC strings from the API

### Technical
- Zero new npm dependencies — native `Intl.DateTimeFormat` API (Node 14 compatible)
- `convertToTimezone(dateStr, tz)` — handles DST correctly, falls back to original string on error
- `resolveTimezone(node)` — reads node context storage, config field, or server auto-detect

## [1.0.5] - 2025-12-31

### Fixed
- **README Documentation** - Removed misleading "Octopus Energy branded device cards" claim
  - Changed to accurate description: "Clean Organization" and "Professional Layout"
  - No actual Octopus Energy branding exists in Home Assistant device cards
  - Avoids potential trademark/copyright concerns

## [1.0.4] - 2025-12-11

### Added
- **Manual Refresh Button (MQTT)** - "Octopus Refresh API" button in Home Assistant
  - Hardcoded 30-second rate limiting to prevent API spam
  - Shows warning in Node-RED when rate limited
  - Publishes refresh cooldown state to MQTT
- **Refresh Available At Sensor** - Diagnostic timestamp sensor
  - Shows ISO timestamp when manual refresh becomes available
  - Displays as countdown in Home Assistant ("in 25 seconds")
  - Automatically clears to `null` after 30 seconds
  - Leverages Home Assistant's native timestamp handling
- **Next Poll Time Sensors** - Shows when next automatic poll will occur
  - `sensor.octopus_next_poll_time` - Main sensor (timestamp class)
  - `sensor.octopus_next_poll_time_raw` - Diagnostic raw timestamp
  - Updates after each successful poll
- **API Complexity Tracking** - Monitor API usage against 50,000 hourly limit
  - `sensor.octopus_api_requests_hour` - Count of requests (last 60 min)
  - `sensor.octopus_api_complexity_hour` - Total complexity used
  - `sensor.octopus_api_complexity_usage` - Percentage of limit used
  - Estimated complexity: Regular poll (300), Mutation (250), Pre-validation (200)
  - All API complexity sensors in Diagnostics section
- **Enhanced Debug Output** - `msg.debug` now includes:
  - `responseHeaders` - Full HTTP response headers from API
  - `extensions` - GraphQL extensions field (if present)
  - `api_usage` - Comprehensive API usage metrics per request
- **Comprehensive Test Coverage** - Added 5 new tests
  - Tests for MQTT refresh button rate limiting
  - Tests for countdown expiry behavior
  - Validates countdown doesn't go negative
  - Tests timer cleanup and MQTT message structure

### Changed
- **Rate Limiting Strategy** - Different behavior for MQTT vs Node-RED
  - MQTT Button: Hardcoded 30-second cooldown (enforced)
  - Node-RED Input: No rate limiting (programmers control this)
  - Timestamp-based cooldown (not seconds counter)
- **State Output** - Node-RED now outputs state on every poll
  - Previously only output on changes
  - Now outputs full `statusPayload` every poll cycle
  - Better for automations and monitoring
- **Global Setter** - Updated `NodeRed_Global_Setter.js` with new fields:
  - `octopus_next_poll`
  - `octopus_refresh_available_at`
  - `octopus_api_requests_hour`
  - `octopus_api_complexity_hour`
  - `octopus_api_complexity_percent`

### Fixed
- **Cooldown Timer Expiry** - Properly publishes `null` at 30 seconds
  - Prevents countdown showing negative values in Home Assistant
  - Timer cleanup prevents memory leaks
  - Exactly 2 MQTT messages per refresh (start + expiry)

### Technical Details
- **API Complexity Estimation** - Since Octopus API doesn't provide actual complexity:
  - Uses estimated values based on query types
  - Tracks rolling 60-minute window
  - If actual complexity becomes available, will use it automatically
- **Timestamp-Based Cooldown** - Uses ISO timestamps instead of seconds
  - Home Assistant handles countdown display automatically
  - Zero MQTT spam during countdown
  - Clean `null` state when ready

## [1.0.3] - 2025-12-04

### Added
- **State reconciliation loop** for charging detection (every 10 seconds)
  - Automatically detects charging state based on cached slot timestamps
  - No API calls - uses local data only
  - Handles imminent/immediate slots when car is plugged in
  - Self-healing: corrects state if timers miss edge cases
- **Flow Library scorecard compliance**
  - Added `version` field to `node-red` section in package.json (>=2.0.0)
  - Added `examples/` folder with 3 demonstration flows
  - Satisfies Node-RED Flow Library requirements

### Fixed
- **Home Assistant sensors going "unknown"** when adjusting controls
  - Sensors now maintain last known values while editing pending preferences
  - Only update when fresh data arrives from API
  - Added `lastKnownState` cache and state merging in `publishCurrentState()`
- **Charging state not updating** for imminent/immediate slots
  - Fixed edge case where slots starting <30s after poll were not detected
  - Reconciliation loop catches these within 10 seconds
  - Ensures accurate "Charging Now" sensor in Home Assistant

### Changed
- Improved charging state management with redundant detection methods
- Enhanced MQTT state publishing to preserve sensor data during control updates

## [1.0.2] - 2025-11-30

### Changed
- Updated flow example description in Node-RED help panel for better clarity
- Improved explanation of default behavior: reads by default, manually refreshable, and accepts commands

## [1.0.1] - 2025-11-30

### Added
- **Node.js and Node-RED version requirements** in package.json engines field
  - Minimum Node.js: >=14.0.0
  - Minimum Node-RED: >=2.0.0
  - Addresses Flow Library scorecard requirements
- **Comprehensive example flows** in Node-RED help panel
  - Basic monitoring flow (inject every 5 min)
  - Set preferences from flow (JSON payload with set_limit/set_time)
  - Home Assistant MQTT integration example
- **Visual documentation** with screenshots
  - Node-RED flow examples showing monitoring, preferences, and preset buttons
  - MQTT integration flow example
  - Home Assistant device page with all entities
- **Visual Examples section** in Node-RED help panel with embedded GitHub-hosted images
- **Screenshots section** in README.md showing real-world usage

### Changed
- Updated README.md with Screenshots section after Features
- Updated .npmignore to exclude images/ folder (keeps npm package lightweight)
- Updated .gitignore to exclude local documentation files

### Fixed
- Flow Library scorecard now shows supported Node-RED and Node.js versions
- Flow Library scorecard "Nodes have examples" requirement now satisfied

## [1.0.0] - 2025-11-30

### Added
- Initial public release
- **Octopus Energy GraphQL API integration**
  - Authentication via API key
  - Fetch planned charging dispatches (smart-charge and bump-charge slots)
  - Query vehicle charging preferences (target SOC and ready time)
  - Update charging preferences via GraphQL mutations
- **Home Assistant MQTT auto-discovery**
  - Number entity: Target charge limit (50-100%)
  - Select entity: Ready time (04:00-11:00)
  - Button entity: Apply changes
  - Sensor entities: Confirmed settings, next charge time, total energy, slot times
  - Binary sensor: Charging now (ON/OFF)
  - Organized into Controls, Sensors, and Diagnostics categories
- **Real-time charging slot detection**
  - Detects currently active charging slots
  - Calculates next charging start time
  - Provides individual slot start/end times (up to 3 slots)
  - Calculates overall charging window
  - Shows charge source (smart-charge vs bump-charge)
- **Exponential backoff validation**
  - Smart retry mechanism when updating preferences
  - Prevents sensors from becoming "unavailable" during API updates
  - Validates changes at 15s, 30s, 60s, 120s intervals
- **Comprehensive debugging**
  - Full API call tracking in msg.debug
  - Success/failure status for each operation
  - Detailed error messages
- **Node-RED flow control**
  - Accept input messages to set preferences programmatically
  - Output payload with all charging data
  - 5-minute default refresh interval (configurable)
- **Octopus Energy branding**
  - Professional pink theme (#E8146F)
  - Device branded as "Octopus Intelligent" in Home Assistant
  - Suggested "Energy" area in Home Assistant
- **Unit test coverage**
  - Data processing tests (10 tests)
  - Timer management tests (10 tests)
  - Mock API responses for consistent testing

### Security
- API key stored securely as Node-RED credential (not exposed in flows)
- Account numbers sanitized in MQTT topics and entity IDs

### Documentation
- Comprehensive README.md with:
  - Feature list and capabilities
  - Installation instructions (npm and palette manager)
  - Configuration guide
  - Home Assistant setup instructions
  - Node-RED usage examples
  - Home Assistant automation examples
  - Troubleshooting section
  - Support options (GitHub Star, Sponsor, PayPal donate)
- MIT License
- GitHub repository with issue tracking

## Release Notes

### Version Numbering
This project follows [Semantic Versioning](https://semver.org/):
- **MAJOR** version (X.0.0): Breaking changes
- **MINOR** version (1.X.0): New features (backwards compatible)
- **PATCH** version (1.0.X): Bug fixes (backwards compatible)

### Links
- [npm Package](https://www.npmjs.com/package/node-red-contrib-octopus-intelligent)
- [GitHub Repository](https://github.com/ASomerN/node-red-contrib-octopus-intelligent)
- [Node-RED Flow Library](https://flows.nodered.org/node/node-red-contrib-octopus-intelligent)
- [Issues & Bug Reports](https://github.com/ASomerN/node-red-contrib-octopus-intelligent/issues)

### Support
- ⭐ [Star on GitHub](https://github.com/ASomerN/node-red-contrib-octopus-intelligent)
- 💖 [Become a Sponsor](https://github.com/sponsors/ASomerN)
- ☕ [Donate via PayPal](https://www.paypal.com/donate?hosted_button_id=A2B8ZFEJBE2S6)
