# node-red-contrib-octopus-intelligent

> Node-RED integration for **Octopus Energy Intelligent Octopus Go** with automatic Home Assistant MQTT discovery

Monitor your EV charging slots, control charge limits, and manage ready times directly from Home Assistant - all automatically configured via MQTT discovery.

[![npm version](https://badge.fury.io/js/node-red-contrib-octopus-intelligent.svg)](https://www.npmjs.com/package/node-red-contrib-octopus-intelligent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## ✨ Features

### 🎮 Smart Controls
- **Target Charge Slider** (50-100%) - Set your desired battery level
- **Ready Time Dropdown** (04:00-11:00) - When your car needs to be ready
- **Apply Changes Button** - Prevents API spam while adjusting settings
- **Confirmed Values** - See your current API-validated settings

### ⚡ Real-Time Charging Data
- **Next Charge Time** - When your next slot starts
- **Total Planned Energy** - Total kWh across all upcoming slots
- **Individual Slot Times** - Up to 3 slots with start/end times
- **Charging Window** - Overall window from first to last slot
- **Charge Source** - Smart-charge vs bump-charge indicator

### 🔧 Advanced Features
- **Raw Timestamps** - Exact API responses in Diagnostics section
- **Exponential Backoff** - Smart retry prevents sensor unavailability
- **Comprehensive Debugging** - Full API call tracking in msg.debug
- **Active Slot Detection** - Shows currently running sessions
- **Entity Categories** - Organized Controls, Sensors, and Diagnostics

### 🏠 Home Assistant Integration
- **Zero Configuration** - MQTT auto-discovery sets everything up
- **Professional UI** - Octopus Energy branded device cards
- **Organized Entities** - Controls, main sensors, and diagnostics neatly grouped
- **Suggested Area** - Auto-suggests "Energy" area

---

## 📋 Requirements

- **Node-RED** v2.0+
- **Octopus Energy Account** with [Intelligent Octopus Go](https://octopus.energy/intelligent/) tariff
- **API Key** - [Generate here](https://octopus.energy/dashboard/new/accounts/personal-details/api-access)
- **MQTT Broker** (optional, for Home Assistant integration)
- **Home Assistant** (optional, for MQTT features)

---

## 🚀 Quick Start

### 1. Install via Node-RED Palette

1. Open Node-RED → **Menu** → **Manage Palette**
2. **Install** tab → Search `node-red-contrib-octopus-intelligent`
3. Click **Install**

### 2. Get Your Credentials

**Account Number** (format: `A-XXXXXXXX`):
- Found at https://octopus.energy/dashboard/

**API Key** (format: `sk_live_...`):
- Get from https://octopus.energy/dashboard/new/accounts/personal-details/api-access
- Click "Generate API Key"

### 3. Configure the Node

1. Drag **Octopus Intelligent** into your flow
2. Double-click to configure:
   - Account Number
   - API Key (stored securely)
   - Refresh Interval (default: 5 min)
   - Enable MQTT if using Home Assistant
3. **Deploy**

### 4. Home Assistant (Optional)

If MQTT enabled:
1. Wait ~5 seconds after deploy
2. **Settings** → **Devices & Services** → **MQTT**
3. Find "Octopus Intelligent" device
4. All entities created automatically!

---

## 📊 Home Assistant Entities

### Controls
```
number.octopus_target_charge       Battery charge limit (50-100%)
select.octopus_ready_time          Ready by time (04:00-11:00)
button.octopus_apply_changes       Submit changes to API
```

### Main Sensors
```
sensor.octopus_confirmed_charge_limit     API-confirmed charge limit
sensor.octopus_confirmed_ready_time       API-confirmed ready time
sensor.octopus_next_charge_time          Next charging slot start
sensor.octopus_total_planned_energy      Total kWh planned
sensor.octopus_next_slot_energy          Energy in next slot
sensor.octopus_charge_source             smart-charge/bump-charge
sensor.octopus_slot_[1-3]_start          Individual slot starts
sensor.octopus_slot_[1-3]_end            Individual slot ends
sensor.octopus_overall_window_start      First slot start
sensor.octopus_overall_window_end        Last slot end
```

### Diagnostics (Raw Timestamps)
```
sensor.octopus_next_charge_time_raw      Exact API timestamp
sensor.octopus_slot_[1-3]_start_raw      Raw slot start times
sensor.octopus_slot_[1-3]_end_raw        Raw slot end times
sensor.octopus_overall_window_start_raw  Raw window start
sensor.octopus_overall_window_end_raw    Raw window end
```

---

## 💡 Node-RED Usage

### Basic Monitoring

```
[Inject: Every 5 min] → [Octopus Intelligent] → [Debug]
```

### Set Preferences from Flow

```javascript
msg.payload = {
    set_limit: 85,        // 85% charge
    set_time: "07:30"     // Ready by 07:30
};
return msg;
```

### Output Format

```json
{
  "payload": {
    "next_start": "2025-11-29T01:30:00Z",
    "total_energy": 42.5,
    "next_kwh": "15.20",
    "next_source": "smart-charge",
    "confirmed_limit": 80,
    "confirmed_time": "07:00",
    "slot1_start": "2025-11-29T01:30:00Z",
    "slot1_end": "2025-11-29T05:30:00Z"
  },
  "debug": {
    "success": true,
    "step": "complete",
    "apiCalls": [...]
  }
}
```

---

## 🏡 Home Assistant Automation Examples

### Notify When Charging Starts

```yaml
automation:
  - alias: "EV Charging Starting"
    trigger:
      platform: state
      entity_id: sensor.octopus_next_charge_time
    condition:
      condition: template
      value_template: "{{ trigger.to_state.state != 'None' }}"
    action:
      service: notify.mobile_app
      data:
        message: "EV charging at {{ states('sensor.octopus_next_charge_time') }}"
```

### Run Dishwasher During Cheap Rate

```yaml
automation:
  - alias: "Dishwasher During Cheap Window"
    trigger:
      platform: time_pattern
      minutes: "/5"
    condition:
      - condition: template
        value_template: >
          {% set start = as_timestamp(states('sensor.octopus_slot1_start')) %}
          {% set end = as_timestamp(states('sensor.octopus_slot1_end')) %}
          {% set now = as_timestamp(now()) %}
          {{ start <= now <= end }}
    action:
      service: switch.turn_on
      target:
        entity_id: switch.dishwasher
```

---

## 🔍 Troubleshooting

### No Data (All Sensors Null/0)

**Check `msg.debug` output** in a Debug node:

Common issues:
- ❌ Account format must include `A-` prefix
- ❌ Invalid API key - regenerate at Octopus dashboard
- ❌ Not on Intelligent Octopus tariff
- ❌ Car not plugged in (no slots scheduled)

### Authentication Failing

Check `msg.debug.apiCalls[0].errors` for details.

**Solution:** Regenerate API key and update node configuration.

### Sensors Unavailable in Home Assistant

1. Verify MQTT broker is running
2. Check Node-RED can connect to MQTT
3. Deploy the flow to trigger discovery
4. Confirm Home Assistant MQTT integration is enabled

### Raw Sensors Not in Diagnostics

If entities existed before v1.0:
1. Delete "Octopus Intelligent" device in Home Assistant
2. Redeploy Node-RED flow
3. Entities will be rediscovered with proper categories

### Changes Not Applying

**Working as designed!** Use the **Apply Changes** button to submit.

This prevents API spam when making multiple adjustments.

---

## 🛠️ How It Works

### Authentication Flow

1. **Get JWT Token** - Exchange API key for token
2. **Fetch Data** - Query planned dispatches & preferences
3. **Process** - Filter active/future slots, calculate totals
4. **Publish** - Send to Node-RED + MQTT

### Exponential Backoff

When changing preferences:

```
Mutation sent → Wait 15s → Validate
             ↓ If not confirmed
             → Wait 30s → Validate
             ↓ If not confirmed
             → Wait 60s → Validate
             ↓ If not confirmed
             → Wait 120s → Final check
             ↓ Then normal interval resumes
```

This prevents sensors becoming "unavailable" during updates.

### Debug Information

Every message includes `msg.debug`:

```json
{
  "timestamp": "2025-11-29T10:30:00Z",
  "success": true,
  "step": "complete",
  "apiCalls": [
    {"name": "authentication", "tokenObtained": true},
    {"name": "data_query", "slotsFound": 3}
  ]
}
```

---

## 🤝 Support This Project

Found this useful? Support continued development:

### ⭐ GitHub
Star the repository to show your support!

### 💖 Sponsor
[Become a sponsor on GitHub](https://github.com/sponsors/ASomerN)

Your sponsorship helps with:
- Bug fixes and maintenance
- New feature development
- Documentation improvements
- Community support

---

## 📝 License

MIT License - Copyright (c) 2025 Andrew Somerharju Neale

See [LICENSE](LICENSE) file for full details.

---

## ⚠️ Disclaimer

This is an **unofficial integration** and is not affiliated with, endorsed by, or connected to Octopus Energy Ltd.

Use at your own risk. The Octopus Energy name and logo are trademarks of Octopus Energy Ltd.

---

## 🔗 Links

- **npm**: https://www.npmjs.com/package/node-red-contrib-octopus-intelligent
- **GitHub**: https://github.com/ASomerN/node-red-contrib-octopus-intelligent
- **Issues**: https://github.com/ASomerN/node-red-contrib-octopus-intelligent/issues
- **Octopus Intelligent**: https://octopus.energy/intelligent/
- **API Docs**: https://developer.octopus.energy/docs/api/

---

## 📜 Changelog

### v1.0.0 (2025-11-29)

- ✅ Octopus Energy GraphQL API integration
- ✅ Home Assistant MQTT auto-discovery
- ✅ Submit button for preference changes
- ✅ Raw timestamp sensors in diagnostics
- ✅ Active charging slot detection
- ✅ Exponential backoff validation
- ✅ Comprehensive debug output
- ✅ Entity category organization
- ✅ Octopus Energy branding

---

**Made with ⚡ for the Octopus Energy & Home Assistant communities**
