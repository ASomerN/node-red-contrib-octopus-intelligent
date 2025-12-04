# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
