# node-red-contrib-octopus-intelligent

> Node-RED integration for **Octopus Energy Intelligent Octopus Go** with automatic Home Assistant MQTT discovery

Monitor your EV charging slots, control charge limits, and manage ready times directly from Home Assistant - all automatically configured via MQTT discovery.

[![npm version](https://badge.fury.io/js/node-red-contrib-octopus-intelligent.svg)](https://www.npmjs.com/package/node-red-contrib-octopus-intelligent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🤝 Support This Project

Found this useful? Support continued development:

<table>
<tr>
<td width="33%" align="center">

### ⭐ GitHub Star
Star the repository to show your support!

[⭐ Star on GitHub](https://github.com/ASomerN/node-red-contrib-octopus-intelligent)

</td>
<td width="33%" align="center">

### 💖 Sponsor
Support ongoing development and maintenance

[Become a Sponsor](https://github.com/sponsors/ASomerN)

</td>
<td width="33%" align="center">

### ☕ Buy Me a Coffee
If this project has helped you!

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_LG.gif)](https://www.paypal.com/donate?hosted_button_id=A2B8ZFEJBE2S6)

</td>
</tr>
</table>

**Your support helps with:** Bug fixes and maintenance • New feature development • Documentation improvements • Community support • Feeding my children

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

## 📸 Screenshots

### Node-RED Flow Examples

#### Basic Monitoring & Control
![Node-RED Flow Examples](images/examples/basic-monitoring-flow.png)

This example flow demonstrates three key usage patterns:

1. **Basic Monitoring** 
   - The Octopus Intelligent Node automaticaly refreshes every 5 minutes
   - Octopus Intelligent node fetches latest charging data
   - Debug node displays all charging slots and settings

2. **Setting Preferences** 
   - Inject node with JSON payload: `{"set_limit": 85, "set_time": "07:30"}` ommit a key:value if you don't want to change it
   - Sends charge limit +/ ready time to the node
   - Debug shows confirmed values from API

**How to use:** Import any of these flows, configure your Account Number and API Key in the Octopus Intelligent node, and deploy!

#### MQTT Integration with Home Assistant
![MQTT Integration Flow](images/examples/mqtt-integration-flow.png)

This flow shows the complete MQTT setup:

- **MQTT Broker Configuration**: Connected to Home Assistant (localhost:1883)
- **Enable MQTT toggle**: Activated in node settings
- **Auto-Discovery**: Node automatically creates all entities in Home Assistant on first run
- **Real-time Updates**: Every 5 minutes, charging data is published to MQTT and updates HA sensors

**What you get in Home Assistant:** All controls and sensors appear automatically - no manual YAML configuration needed!

### Home Assistant Auto-Configured Entities

![Home Assistant Device](images/examples/homeassistant-device.png)

After enabling MQTT in the Node-RED node, Home Assistant automatically creates:

#### Controls (Top Section)
- **Target Charge** - Number slider (50-100%) to set desired battery level
- **Ready Time** - Dropdown selector (04:00-11:00) for when car needs to be ready
- **Apply Changes** - Button to submit new settings (prevents API spam while adjusting)

#### Sensors (Main Section)
- **Confirmed Charge Limit** - Current API-validated charge limit
- **Confirmed Ready Time** - Current API-validated ready time
- **Next Charge Time** - When your next charging slot starts (formatted for your timezone)
- **Total Planned Energy** - Total kWh across all upcoming slots
- **Slot 1, 2, 3 Start/End** - Individual charging slot times
- **Overall Window Start/End** - First slot start to last slot end
- **Charging Now** - Binary sensor (ON/OFF) showing if actively charging

#### Diagnostics (Includes the same information but in a raw output)
- Raw timestamp sensors with exact API responses
- Useful for debugging and advanced automations

**All entities are automatically organized under a single "Octopus Intelligent" device!**

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

1. **Get Token** - Exchange API key for token
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

See [CHANGELOG.md](CHANGELOG.md) for detailed version history and release notes.

### Latest Release: v1.0.1 (2025-11-30)
- Added Node.js and Node-RED version requirements
- Added comprehensive example flows and visual documentation
- Flow Library scorecard improvements

### Previous Release: v1.0.0 (2025-11-30)
- Initial public release with full Octopus Energy API integration
- Home Assistant MQTT auto-discovery
- Real-time charging slot detection
- Exponential backoff validation

---

**Made with ⚡ for the Octopus Energy & Home Assistant communities**
