# node-red-contrib-octopus-intelligent

A Node-RED node for integrating **Octopus Energy Intelligent Octopus** tariff data into your home automation system. Automatically fetches smart charging schedules, vehicle preferences, and planned dispatch slots with native **Home Assistant MQTT Auto-Discovery** support.

---

## What Is This?

This Node-RED module connects to the **Octopus Energy GraphQL API** to retrieve real-time information about your **Intelligent Octopus** smart charging schedule. It provides:

- **Next charging slot** start time and duration
- **Total planned energy** for upcoming charging sessions
- **Vehicle charging preferences** (target charge level and ready time)
- **Charge source** information (smart charge, bump charge, etc.)
- **Native Home Assistant integration** via MQTT auto-discovery

---

## What Is Octopus Intelligent?

[Octopus Intelligent](https://octopus.energy/intelligent/) is a smart EV charging tariff from Octopus Energy (UK) that:

- Charges your EV during off-peak hours (typically 6 hours between 11:30pm-7:30am)
- Provides electricity at **~7-10p/kWh** during smart charging windows
- Automatically schedules charging based on your departure time and desired charge level
- Can add "bump charges" if you need emergency top-ups
- Works with compatible EVs and home chargers

This node lets you access that schedule data to:
- **Automate home devices** during cheap rate periods
- **Monitor charging status** without opening the Octopus app
- **Trigger flows** based on upcoming charge windows
- **Integrate with Home Assistant** for dashboards and automations

---

## Features

✅ **GraphQL API Integration** - Uses Octopus Energy's official GraphQL endpoint
✅ **Automatic Token Management** - Handles authentication transparently
✅ **Home Assistant Auto-Discovery** - Creates sensors automatically via MQTT
✅ **Configurable Refresh Rate** - Poll every 5 minutes (default) or customize
✅ **Manual Trigger Support** - Send any input message to force an immediate update
✅ **Rich Data Output** - Exposes all key metrics for flow automation
✅ **Error Handling** - Visual status indicators and error reporting

---

## Installation

### Option 1: Local Development

```bash
# Clone or download this repository
cd node-red-contrib-octopus-intelligent

# Install dependencies
npm install

# Link to Node-RED
npm link

# In your Node-RED directory
cd ~/.node-red
npm link node-red-contrib-octopus-intelligent

# Restart Node-RED
```

### Option 2: Direct Install (Future NPM Release)

```bash
cd ~/.node-red
npm install node-red-contrib-octopus-intelligent
```

### Option 3: Node-RED Palette Manager

1. Open Node-RED
2. Go to **Menu → Manage Palette**
3. Search for `node-red-contrib-octopus-intelligent`
4. Click **Install**

---

## Configuration

### Required Settings

| Field | Description | Example |
|-------|-------------|---------|
| **Account Number** | Your Octopus account number (found in your account dashboard) | `A-12345678` |
| **API Key** | Your Octopus API key (generate at octopus.energy/dashboard/developer) | `sk_live_abc123...` |

### Optional Settings

| Field | Description | Default |
|-------|-------------|---------|
| **Refresh Interval** | How often to poll the API (minutes) | `5` |
| **Enable HA Discovery** | Publish sensors to Home Assistant via MQTT | `true` |
| **MQTT Broker** | Select your configured MQTT broker node | *(none)* |

### Getting Your API Key

1. Log in to your Octopus Energy account
2. Go to [https://octopus.energy/dashboard/developer/](https://octopus.energy/dashboard/developer/)
3. Click **Generate API Key**
4. Copy the key (starts with `sk_live_`)

---

## How It Works

### Architecture

```
┌─────────────────────┐
│   Node-RED Node     │
└──────────┬──────────┘
           │
           ├─► 1. Authenticate (GraphQL Mutation)
           │   https://api.octopus.energy/v1/graphql/
           │   → obtainKrakenToken(APIKey) → JWT Token
           │
           ├─► 2. Fetch Data (GraphQL Query)
           │   → plannedDispatches(accountNumber)
           │   → vehicleChargingPreferences(accountNumber)
           │
           ├─► 3. Process & Transform
           │   → Calculate next slot, totals, etc.
           │
           ├─► 4. Output to Node-RED Flow
           │   → msg.payload = { next_start, total_energy, ... }
           │
           └─► 5. Publish to MQTT (if enabled)
               → homeassistant/sensor/.../config (auto-discovery)
               → nodered_octopus/.../status (state updates)
```

### Data Flow

1. **Authentication**: The node uses your API key to obtain a short-lived JWT token
2. **Query**: Makes a single GraphQL request fetching:
   - `plannedDispatches` - All upcoming smart charging slots
   - `vehicleChargingPreferences` - Your configured target SOC and ready time
3. **Transform**: Processes raw data into actionable metrics:
   - Finds the next active charging slot
   - Calculates total energy across all planned slots
   - Extracts source metadata (smart charge vs bump charge)
4. **Publish**: Sends data to both Node-RED flows and MQTT (for Home Assistant)

### Output Payload

```json
{
  "next_start": "2025-11-26T01:30:00Z",
  "total_energy": 42.5,
  "next_kwh": "15.20",
  "next_source": "smart-charge",
  "confirmed_limit": 80,
  "confirmed_time": "07:00"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `next_start` | ISO 8601 String | Start time of next charging slot |
| `total_energy` | Number | Total kWh planned across all slots |
| `next_kwh` | String | Energy (kWh) in the next slot |
| `next_source` | String | Source type (`smart-charge`, `bump-charge`, etc.) |
| `confirmed_limit` | Number | Your configured charge limit (%) |
| `confirmed_time` | String | Your configured ready-by time |

---

## Home Assistant Integration

When **HA Discovery** is enabled and an MQTT broker is configured, the node automatically creates 6 sensors in Home Assistant:

### Auto-Discovered Sensors

| Entity ID | Friendly Name | Device Class | Unit |
|-----------|---------------|--------------|------|
| `sensor.octopus_next_charge_time` | Next Charge Time | `timestamp` | - |
| `sensor.octopus_total_planned_energy` | Total Planned Energy | `energy` | kWh |
| `sensor.octopus_next_slot_energy` | Next Slot Energy | `energy` | kWh |
| `sensor.octopus_charge_source` | Charge Source | - | - |
| `sensor.octopus_confirmed_charge_limit` | Confirmed Charge Limit | - | % |
| `sensor.octopus_confirmed_ready_time` | Confirmed Ready Time | - | - |

### Example Home Assistant Dashboard

```yaml
type: entities
title: Octopus Intelligent
entities:
  - entity: sensor.octopus_next_charge_time
    name: Next Charging Slot
  - entity: sensor.octopus_next_slot_energy
    name: Next Slot Energy
  - entity: sensor.octopus_total_planned_energy
    name: Total Planned Energy
  - entity: sensor.octopus_confirmed_charge_limit
    name: Target Charge Level
  - entity: sensor.octopus_confirmed_ready_time
    name: Ready By Time
```

### Home Assistant Automation Example

**Turn on dishwasher during cheap charging window:**

```yaml
automation:
  - alias: "Run Dishwasher During Cheap Rate"
    trigger:
      - platform: state
        entity_id: sensor.octopus_next_charge_time
    condition:
      - condition: template
        value_template: >
          {% set next_charge = as_timestamp(states('sensor.octopus_next_charge_time')) %}
          {% set now = as_timestamp(now()) %}
          {{ (next_charge - now) < 300 }}  # Within 5 minutes of start
    action:
      - service: switch.turn_on
        target:
          entity_id: switch.dishwasher_plug
```

---

## Node-RED Flow Examples

### Example 1: Simple Monitor

**Flow**: Display next charging time on Dashboard

```
[Octopus Node] ──► [Function] ──► [Dashboard Text]
```

**Function Node**:
```javascript
const nextCharge = new Date(msg.payload.next_start);
msg.payload = `Next charge: ${nextCharge.toLocaleTimeString()}`;
return msg;
```

---

### Example 2: Cheap Rate Window Detector

**Use Case**: Turn on high-power devices during charging windows

```
[Octopus Node] ──► [Function: Check if NOW is in slot] ──► [Switch Node]
                                                               ├─► [True] ──► [Turn On Devices]
                                                               └─► [False] ──► [Turn Off Devices]
```

**Function Node**:
```javascript
const now = new Date();
const nextStart = new Date(msg.payload.next_start);
const slotDuration = parseFloat(msg.payload.next_kwh) * 1000 * 60 * 60 / 7.4; // Rough calc

// Check if we're currently in a charging window
msg.inCheapWindow = (now >= nextStart && now <= new Date(nextStart.getTime() + slotDuration));
return msg;
```

---

### Example 3: Energy Dashboard Logger

**Flow**: Log all charging data to InfluxDB

```
[Octopus Node] ──► [Function: Format] ──► [InfluxDB Out]
```

**Function Node**:
```javascript
msg.payload = {
    measurement: "octopus_charging",
    fields: {
        total_energy: msg.payload.total_energy,
        next_kwh: parseFloat(msg.payload.next_kwh),
        confirmed_limit: msg.payload.confirmed_limit
    },
    tags: {
        source: msg.payload.next_source
    },
    timestamp: new Date()
};
return msg;
```

---

### Example 4: Preemptive Home Heating

**Use Case**: Pre-heat house using cheap rate electricity 30 minutes before you wake up

```
[Inject: Every 5 min] ──► [Octopus Node] ──► [Function: Check time] ──► [Switch]
                                                                          ├─► [True] ──► [MQTT: Turn on heating]
                                                                          └─► [False]
```

**Function Node**:
```javascript
const readyTime = msg.payload.confirmed_time; // e.g., "07:00"
const [hours, minutes] = readyTime.split(':').map(Number);
const readyDate = new Date();
readyDate.setHours(hours, minutes, 0, 0);

const preHeatTime = new Date(readyDate.getTime() - 30 * 60 * 1000); // 30 mins before
const now = new Date();

// If we're in the pre-heat window
if (now >= preHeatTime && now < readyDate) {
    msg.payload = { heating: "on" };
    return [msg, null];
} else {
    msg.payload = { heating: "off" };
    return [null, msg];
}
```

---

### Example 5: Bump Charge Alert

**Use Case**: Get notified when Octopus schedules an emergency "bump charge"

```
[Octopus Node] ──► [Switch: Check source] ──► [Function: Format message] ──► [Pushover/Telegram]
                          └─► (if source == "bump-charge")
```

**Switch Node**: Check if `msg.payload.next_source === "bump-charge"`

**Function Node**:
```javascript
msg.payload = {
    message: `⚡ Bump charge detected! ${msg.payload.next_kwh} kWh at ${new Date(msg.payload.next_start).toLocaleString()}`,
    priority: 1
};
return msg;
```

---

### Example 6: Smart Charger Override

**Use Case**: Pause EV charging if home battery is low during a charging window

```
[Octopus Node] ──► [Function: Check battery] ──► [Switch]
                          │                        ├─► [Battery OK] ──► [MQTT: Allow EV charging]
                          │                        └─► [Battery Low] ──► [MQTT: Pause EV charging]
                          └─► [Get battery SOC via API]
```

---

### Example 7: Cost Calculator

**Use Case**: Calculate how much you're saving vs standard rate

```
[Octopus Node] ──► [Function: Calculate savings] ──► [Dashboard Gauge]
```

**Function Node**:
```javascript
const cheapRate = 0.075; // 7.5p per kWh
const standardRate = 0.25; // 25p per kWh
const totalEnergy = msg.payload.total_energy;

const cheapCost = totalEnergy * cheapRate;
const standardCost = totalEnergy * standardRate;
const savings = standardCost - cheapCost;

msg.payload = {
    value: savings.toFixed(2),
    label: `Saving £${savings.toFixed(2)} on next charge`
};
return msg;
```

---

## Advanced Use Cases

### 1. **Multi-Zone Heating Automation**
Use the charging schedule to pre-heat different rooms based on occupancy patterns during cheap rate windows.

### 2. **Battery Storage Arbitrage**
If you have a home battery, charge it during Intelligent slots and discharge during peak hours.

### 3. **Predictive Load Scheduling**
Schedule washing machine, tumble dryer, dishwasher to run during confirmed charging windows.

### 4. **Solar Diverter Integration**
Pause solar diversion to EV charger during Intelligent slots (let Octopus pay for it instead).

### 5. **Dynamic Tariff Comparison**
Compare Intelligent rates vs Agile/Go rates in real-time to optimize savings.

### 6. **Vehicle-to-Grid (V2G) Prep**
When V2G becomes available, use this data to schedule discharge periods.

---

## Troubleshooting

### "Missing Config" Error

- Verify your **Account Number** starts with `A-` (e.g., `A-12345678`)
- Check your **API Key** is valid (generate new one if needed)

### "API Error" Status

- Ensure you have an **active Intelligent Octopus tariff**
- Check your API key has not expired
- Verify network connectivity to `api.octopus.energy`

### No Home Assistant Sensors

- Confirm **Enable HA Discovery** is checked
- Verify **MQTT Broker** is selected and connected
- Check MQTT broker logs for connection issues
- Ensure Home Assistant is subscribed to `homeassistant/sensor/#`

### Data Not Updating

- Check the **Refresh Interval** is set correctly
- Send a manual input message to the node to force update
- Review Node-RED debug logs for errors

---

## API Details

### GraphQL Endpoints Used

**Authentication:**
```graphql
mutation obtainToken($input: ObtainJSONWebTokenInput!) {
  obtainKrakenToken(input: $input) {
    token
  }
}
```

**Data Query:**
```graphql
query getData($account: String!) {
  plannedDispatches(accountNumber: $account) {
    startDt
    endDt
    deltaKwh
    meta { source }
  }
  vehicleChargingPreferences(accountNumber: $account) {
    weekdayTargetSoc
    weekdayTargetTime
  }
}
```

### Rate Limits

Octopus Energy does not publish official rate limits for their GraphQL API, but reasonable polling (5-15 minutes) is recommended to avoid throttling.

---

## Contributing

Contributions welcome! Please open an issue or PR on GitHub.

### Development Setup

```bash
git clone <your-fork>
cd node-red-contrib-octopus-intelligent
npm install
npm link
# Make changes and test in Node-RED
```

---

## License

ISC

---

## Disclaimer

This is an unofficial integration. Not affiliated with Octopus Energy Ltd.

Use of this software requires a valid Octopus Energy account and API key. Please review Octopus Energy's [Terms of Service](https://octopus.energy/terms/) and [API documentation](https://developer.octopus.energy/docs/api/).

---

## Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/node-red-contrib-octopus-intelligent/issues)
- **Octopus API Docs**: [developer.octopus.energy](https://developer.octopus.energy/)
- **Node-RED Forum**: [discourse.nodered.org](https://discourse.nodered.org/)

---

## Changelog

### v1.0.0 (2025-11-25)
- Initial release
- GraphQL API integration
- Home Assistant MQTT auto-discovery
- Configurable refresh intervals
- Manual trigger support
