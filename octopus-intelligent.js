'use strict';
const { graphqlPost } = require('./lib/graphql');
const { convertToTimezone, resolveTimezone } = require('./lib/timezone');
const { createApiMetrics } = require('./lib/api-metrics');
const intelligentCategory = require('./lib/categories/intelligent');
const { buildDefaultPayload } = require('./lib/payload');
const { createScheduler } = require('./lib/scheduler');
const { discoverProducts } = require('./lib/discovery');
const { mergePayload } = require('./lib/payload');
const electricityCategory = require('./lib/categories/electricity');
const gasCategory = require('./lib/categories/gas');
const wheelOfFortuneCategory = require('./lib/categories/wheel-of-fortune');
const homeMiniCategory = require('./lib/categories/home-mini');
const completedDispatchesCategory = require('./lib/categories/completed-dispatches');
const accountCategory = require('./lib/categories/account');
const octoplusCategory = require('./lib/categories/octoplus');
const flexPlannedDispatchesCategory = require('./lib/categories/flex-planned-dispatches');
const applicableRatesCategory = require('./lib/categories/applicable-rates');
const savingSessionsCategory = require('./lib/categories/saving-sessions');
const freeElectricityCategory = require('./lib/categories/free-electricity');

module.exports = function (RED) {
    function OctopusIntelligentNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        // 1. Configuration
        const account = config.accountNumber ? config.accountNumber.trim() : "";
        const apiKey = this.credentials.apiKey ? this.credentials.apiKey.trim() : "";
        const refreshRate = (config.refreshInterval || 5) * 60 * 1000;
        const enableMqtt = config.enableMqtt;
        node.timezoneOverride = config.timezoneOverride || "";

        // MQTT Topics
        this.broker = RED.nodes.getNode(config.broker);
        const mqttPrefix = `homeassistant`;
        const uniqueIdPrefix = `nodered_${account}`;
        const stateTopic = `nodered_octopus/${account}/status`;

        // Command Topics (For listening)
        const cmdTopicLimit = `nodered_octopus/${account}/set_limit`;
        const cmdTopicTime = `nodered_octopus/${account}/set_time`;
        const cmdTopicSubmit = `nodered_octopus/${account}/submit_changes`;
        const cmdTopicRefresh = `nodered_octopus/${account}/refresh`;
        const cmdTopicTimezone = `nodered_octopus/${account}/set_timezone`;
        const cmdTopicSmartCharging = `nodered_octopus/${account}/set_smart_charging`;

        // 2. Constants & Validation
        const TIME_OPTIONS = [
            "04:00", "04:30", "05:00", "05:30", 
            "06:00", "06:30", "07:00", "07:30", 
            "08:00", "08:30", "09:00", "09:30", 
            "10:00", "10:30", "11:00"
        ];

        // 3. Sensor Definitions (Read-Only)
        // category: undefined = main, 'config' = Configuration, 'diagnostic' = Diagnostics
        const sensors = [
            // --- EV Charging (main) ---
            { id: 'next_charge',   name: 'Next Charge Time',       class: 'timestamp', icon: 'mdi:timer',              val: 'next_start' },
            { id: 'total_energy',  name: 'Total Planned Energy',   unit: 'kWh',        class: 'energy',                val: 'total_energy' },
            { id: 'next_kwh',      name: 'Next Slot Energy',       unit: 'kWh',        class: 'energy',                val: 'next_kwh' },
            { id: 'source',        name: 'Charge Source',          icon: 'mdi:help-circle',                            val: 'next_source' },
            { id: 'slot1_start',   name: 'Slot 1 Start',           class: 'timestamp', icon: 'mdi:timer-outline',      val: 'slot1_start' },
            { id: 'slot1_end',     name: 'Slot 1 End',             class: 'timestamp', icon: 'mdi:timer-outline',      val: 'slot1_end' },
            { id: 'slot2_start',   name: 'Slot 2 Start',           class: 'timestamp', icon: 'mdi:timer-outline',      val: 'slot2_start' },
            { id: 'slot2_end',     name: 'Slot 2 End',             class: 'timestamp', icon: 'mdi:timer-outline',      val: 'slot2_end' },
            { id: 'slot3_start',   name: 'Slot 3 Start',           class: 'timestamp', icon: 'mdi:timer-outline',      val: 'slot3_start' },
            { id: 'slot3_end',     name: 'Slot 3 End',             class: 'timestamp', icon: 'mdi:timer-outline',      val: 'slot3_end' },
            { id: 'window_start',  name: 'Overall Window Start',   class: 'timestamp', icon: 'mdi:timer-play',         val: 'window_start' },
            { id: 'window_end',    name: 'Overall Window End',     class: 'timestamp', icon: 'mdi:timer-stop',         val: 'window_end' },

            // --- EV Charging (diagnostic) ---
            { id: 'next_poll',            name: 'Next Poll Time',          class: 'timestamp', icon: 'mdi:clock-outline', val: 'next_poll',            category: 'diagnostic' },
            { id: 'refresh_available_at', name: 'Refresh Available At',    class: 'timestamp', icon: 'mdi:timer-sand',    val: 'refresh_available_at', category: 'diagnostic' },
            { id: 'api_requests_hour',    name: 'API Requests (Last Hour)',                    icon: 'mdi:api',           val: 'api_requests_hour',    category: 'diagnostic' },
            { id: 'api_complexity_hour',  name: 'API Complexity (Last Hour)',                  icon: 'mdi:chart-line',    val: 'api_complexity_hour',  category: 'diagnostic' },
            { id: 'api_complexity_percent', name: 'API Complexity Usage',  unit: '%',          icon: 'mdi:percent',       val: 'api_complexity_percent', category: 'diagnostic' },

            // --- Raw timestamps (diagnostic) ---
            { id: 'next_charge_raw',     name: 'Next Charge Time (Raw)',        icon: 'mdi:timer',          val: 'next_start_raw',      category: 'diagnostic' },
            { id: 'next_poll_raw',       name: 'Next Poll Time (Raw)',          icon: 'mdi:clock-outline',  val: 'next_poll_raw',       category: 'diagnostic' },
            { id: 'slot1_start_raw',     name: 'Slot 1 Start (Raw)',            icon: 'mdi:timer-outline',  val: 'slot1_start_raw',     category: 'diagnostic' },
            { id: 'slot1_end_raw',       name: 'Slot 1 End (Raw)',              icon: 'mdi:timer-outline',  val: 'slot1_end_raw',       category: 'diagnostic' },
            { id: 'slot2_start_raw',     name: 'Slot 2 Start (Raw)',            icon: 'mdi:timer-outline',  val: 'slot2_start_raw',     category: 'diagnostic' },
            { id: 'slot2_end_raw',       name: 'Slot 2 End (Raw)',              icon: 'mdi:timer-outline',  val: 'slot2_end_raw',       category: 'diagnostic' },
            { id: 'slot3_start_raw',     name: 'Slot 3 Start (Raw)',            icon: 'mdi:timer-outline',  val: 'slot3_start_raw',     category: 'diagnostic' },
            { id: 'slot3_end_raw',       name: 'Slot 3 End (Raw)',              icon: 'mdi:timer-outline',  val: 'slot3_end_raw',       category: 'diagnostic' },
            { id: 'window_start_raw',    name: 'Overall Window Start (Raw)',    icon: 'mdi:timer-play',     val: 'window_start_raw',    category: 'diagnostic' },
            { id: 'window_end_raw',      name: 'Overall Window End (Raw)',      icon: 'mdi:timer-stop',     val: 'window_end_raw',      category: 'diagnostic' },

            // --- Locale timestamps (diagnostic) ---
            { id: 'next_charge_locale',  name: 'Next Charge Time (Locale)',     icon: 'mdi:timer',          val: 'next_start_locale',   category: 'diagnostic' },
            { id: 'slot1_start_locale',  name: 'Slot 1 Start (Locale)',         icon: 'mdi:timer-outline',  val: 'slot1_start_locale',  category: 'diagnostic' },
            { id: 'slot1_end_locale',    name: 'Slot 1 End (Locale)',           icon: 'mdi:timer-outline',  val: 'slot1_end_locale',    category: 'diagnostic' },
            { id: 'slot2_start_locale',  name: 'Slot 2 Start (Locale)',         icon: 'mdi:timer-outline',  val: 'slot2_start_locale',  category: 'diagnostic' },
            { id: 'slot2_end_locale',    name: 'Slot 2 End (Locale)',           icon: 'mdi:timer-outline',  val: 'slot2_end_locale',    category: 'diagnostic' },
            { id: 'slot3_start_locale',  name: 'Slot 3 Start (Locale)',         icon: 'mdi:timer-outline',  val: 'slot3_start_locale',  category: 'diagnostic' },
            { id: 'slot3_end_locale',    name: 'Slot 3 End (Locale)',           icon: 'mdi:timer-outline',  val: 'slot3_end_locale',    category: 'diagnostic' },
            { id: 'window_start_locale', name: 'Overall Window Start (Locale)', icon: 'mdi:timer-play',     val: 'window_start_locale', category: 'diagnostic' },
            { id: 'window_end_locale',   name: 'Overall Window End (Locale)',   icon: 'mdi:timer-stop',     val: 'window_end_locale',   category: 'diagnostic' },
            { id: 'timezone_detected',   name: 'Timezone Detected',             icon: 'mdi:earth',          val: 'timezone_detected',   category: 'diagnostic' },
            { id: 'timezone_applied',    name: 'Timezone Applied',              icon: 'mdi:earth-plus',     val: 'timezone_applied',    category: 'diagnostic' },
            // --- Electricity (main) ---
            { id: 'electricity_standing_charge',   name: 'Electricity Standing Charge', unit: 'p/day', icon: 'mdi:cash',                     val: 'electricity_standing_charge' },
            { id: 'electricity_consumption_kwh',   name: 'Electricity Consumption',     unit: 'kWh',   class: 'energy',                      val: 'electricity_consumption_kwh' },
            // --- Electricity (config) ---
            { id: 'electricity_unit_rate',          name: 'Electricity Unit Rate',        unit: 'p/kWh', icon: 'mdi:flash',                    val: 'electricity_unit_rate' },
            { id: 'electricity_tariff_code',        name: 'Electricity Tariff Code',                     icon: 'mdi:tag',                      val: 'electricity_tariff_code' },
            { id: 'electricity_valid_from',         name: 'Electricity Tariff Valid From', class: 'timestamp', icon: 'mdi:calendar-start',     val: 'electricity_valid_from' },
            { id: 'electricity_valid_to',           name: 'Electricity Tariff Valid To',   class: 'timestamp', icon: 'mdi:calendar-end',       val: 'electricity_valid_to' },
            // --- Electricity (diagnostic) ---
            { id: 'electricity_consumption_from',   name: 'Electricity Consumption From', class: 'timestamp', icon: 'mdi:calendar-clock',     val: 'electricity_consumption_from',  category: 'diagnostic' },
            { id: 'electricity_consumption_to',     name: 'Electricity Consumption To',   class: 'timestamp', icon: 'mdi:calendar-clock',     val: 'electricity_consumption_to',    category: 'diagnostic' },
            { id: 'electricity_rates_error',        name: 'Electricity Rates Error',                     icon: 'mdi:alert-circle',             val: 'electricity_rates_error',       category: 'diagnostic' },
            { id: 'electricity_consumption_error',  name: 'Electricity Consumption Error',               icon: 'mdi:alert-circle',             val: 'electricity_consumption_error', category: 'diagnostic' },

            // --- Electricity Export (main) ---
            { id: 'electricity_export_consumption_kwh', name: 'Electricity Export Consumption', unit: 'kWh',   class: 'energy',                       val: 'electricity_export_consumption_kwh' },
            { id: 'electricity_export_rate_current_pence', name: 'Current Electricity Export Rate',       unit: 'p/kWh',   icon: 'mdi:cash-clock',  val: 'electricity_export_rate_current_pence' },
            { id: 'electricity_export_rate_current_gbp',   name: 'Electricity Export Rate',               unit: 'GBP/kWh', icon: 'mdi:cash-clock', stateClass: 'measurement', val: 'electricity_export_rate_current_gbp' },
            // --- Electricity Export (config) ---
            // Solar/export users have a second agreement with productCode containing "OUTGOING".
            // unit_rate is null for half-hourly export tariffs (e.g. Agile Outgoing) — current
            // half-hourly export rate comes from electricity_export_rate_current_pence.
            { id: 'electricity_export_unit_rate',      name: 'Electricity Export Unit Rate',      unit: 'p/kWh', icon: 'mdi:transmission-tower-export', val: 'electricity_export_unit_rate' },
            { id: 'electricity_export_standing_charge',name: 'Electricity Export Standing Charge',unit: 'p/day', icon: 'mdi:cash',                      val: 'electricity_export_standing_charge' },
            { id: 'electricity_export_tariff_code',    name: 'Electricity Export Tariff Code',                   icon: 'mdi:tag',                       val: 'electricity_export_tariff_code' },
            { id: 'electricity_export_valid_from',     name: 'Electricity Export Tariff Valid From', class: 'timestamp', icon: 'mdi:calendar-start',   val: 'electricity_export_valid_from' },
            { id: 'electricity_export_valid_to',       name: 'Electricity Export Tariff Valid To',   class: 'timestamp', icon: 'mdi:calendar-end',     val: 'electricity_export_valid_to' },
            // --- Electricity Export (diagnostic) ---
            { id: 'electricity_export_consumption_from', name: 'Electricity Export Consumption From', class: 'timestamp', icon: 'mdi:calendar-clock', val: 'electricity_export_consumption_from', category: 'diagnostic' },
            { id: 'electricity_export_consumption_to',   name: 'Electricity Export Consumption To',   class: 'timestamp', icon: 'mdi:calendar-clock', val: 'electricity_export_consumption_to',   category: 'diagnostic' },
            { id: 'electricity_export_rate_count',       name: 'Electricity Export Rate Slots',       icon: 'mdi:format-list-numbered', val: 'electricity_export_rate_count', category: 'diagnostic' },
            { id: 'electricity_export_rate_prev_pence',  name: 'Electricity Export Rate Prev',        unit: 'p/kWh', icon: 'mdi:cash-clock',          val: 'electricity_export_rate_prev_pence',  category: 'diagnostic' },
            { id: 'electricity_export_rate_prev_to',     name: 'Electricity Export Rate Prev Ends',   class: 'timestamp', icon: 'mdi:calendar-clock', val: 'electricity_export_rate_prev_to',    category: 'diagnostic' },
            { id: 'electricity_export_rate_next_pence',  name: 'Electricity Export Rate Next',        unit: 'p/kWh', icon: 'mdi:cash-clock',          val: 'electricity_export_rate_next_pence',  category: 'diagnostic' },
            { id: 'electricity_export_rate_next_from',   name: 'Electricity Export Rate Next From',   class: 'timestamp', icon: 'mdi:calendar-clock', val: 'electricity_export_rate_next_from',  category: 'diagnostic' },
            { id: 'electricity_export_rate_error',       name: 'Electricity Export Rate Error',       icon: 'mdi:alert-circle', val: 'electricity_export_rate_error', category: 'diagnostic' },

            // --- Gas (main) ---
            { id: 'gas_standing_charge',    name: 'Gas Standing Charge',  unit: 'p/day', icon: 'mdi:cash',              val: 'gas_standing_charge' },
            { id: 'gas_consumption_kwh',    name: 'Gas Consumption',      unit: 'kWh',   class: 'energy',               val: 'gas_consumption_kwh' },
            // --- Gas (config) ---
            { id: 'gas_unit_rate',          name: 'Gas Unit Rate',         unit: 'p/kWh', icon: 'mdi:fire',              val: 'gas_unit_rate' },
            { id: 'gas_tariff_code',        name: 'Gas Tariff Code',                      icon: 'mdi:tag',               val: 'gas_tariff_code' },
            { id: 'gas_valid_from',         name: 'Gas Tariff Valid From', class: 'timestamp', icon: 'mdi:calendar-start', val: 'gas_valid_from' },
            { id: 'gas_valid_to',           name: 'Gas Tariff Valid To',   class: 'timestamp', icon: 'mdi:calendar-end',   val: 'gas_valid_to' },
            // --- Gas (diagnostic) ---
            { id: 'gas_consumption_from',   name: 'Gas Consumption From',  class: 'timestamp', icon: 'mdi:calendar-clock', val: 'gas_consumption_from',  category: 'diagnostic' },
            { id: 'gas_consumption_to',     name: 'Gas Consumption To',    class: 'timestamp', icon: 'mdi:calendar-clock', val: 'gas_consumption_to',    category: 'diagnostic' },
            { id: 'gas_rates_error',        name: 'Gas Rates Error',                       icon: 'mdi:alert-circle',      val: 'gas_rates_error',        category: 'diagnostic' },
            { id: 'gas_consumption_error',  name: 'Gas Consumption Error',                 icon: 'mdi:alert-circle',      val: 'gas_consumption_error',  category: 'diagnostic' },

            // --- Applicable Rates (main) ---
            { id: 'applicable_rates_current_pence', name: 'Current Electricity Rate',       unit: 'p/kWh',    icon: 'mdi:cash-clock', val: 'applicable_rates_current_pence' },
            { id: 'applicable_rates_current_gbp',   name: 'Electricity Rate',               unit: 'GBP/kWh',  icon: 'mdi:cash-clock', stateClass: 'measurement', val: 'applicable_rates_current_gbp' },
            // --- Applicable Rates (diagnostic) ---
            { id: 'applicable_rates_count', name: 'Applicable Rates Slots', icon: 'mdi:format-list-numbered', val: 'applicable_rates_count', category: 'diagnostic' },
            { id: 'applicable_rates_error', name: 'Applicable Rates Error', icon: 'mdi:alert-circle',          val: 'applicable_rates_error', category: 'diagnostic' },

            // --- Account (main) ---
            { id: 'account_balance_pounds', name: 'Account Balance',        unit: '£',  icon: 'mdi:cash-multiple', val: 'account_balance_pounds' },
            // --- Account (diagnostic) ---
            { id: 'account_balance_pence',  name: 'Account Balance (Pence)', unit: 'p', icon: 'mdi:cash',          val: 'account_balance_pence',  category: 'diagnostic' },
            { id: 'account_error',          name: 'Account Error',                      icon: 'mdi:alert-circle',  val: 'account_error',          category: 'diagnostic' },

            // --- Octoplus (config) ---
            // octoplus_enrolled and octoplus_loyalty_points_user are booleans — published as
            // binary_sensor entities further down. Leaving them out of this array.
            { id: 'octoplus_enrollment_status',   name: 'Octoplus Status',         icon: 'mdi:star-circle-outline', val: 'octoplus_enrollment_status' },
            // --- Octoplus (diagnostic) ---
            { id: 'octoplus_error', name: 'Octoplus Error', icon: 'mdi:alert-circle', val: 'octoplus_error', category: 'diagnostic' },

            // --- Wheel of Fortune (main) ---
            { id: 'wheel_of_fortune_electricity_spins', name: 'WoF Electricity Spins', icon: 'mdi:star-circle', val: 'wheel_of_fortune_electricity_spins' },
            { id: 'wheel_of_fortune_gas_spins',         name: 'WoF Gas Spins',         icon: 'mdi:star-circle', val: 'wheel_of_fortune_gas_spins' },
            // --- Wheel of Fortune (diagnostic) ---
            { id: 'wheel_of_fortune_electricity_max',   name: 'WoF Electricity Max',   icon: 'mdi:star-outline', val: 'wheel_of_fortune_electricity_max',  category: 'diagnostic' },
            { id: 'wheel_of_fortune_electricity_used',  name: 'WoF Electricity Used',  icon: 'mdi:star-outline', val: 'wheel_of_fortune_electricity_used', category: 'diagnostic' },
            { id: 'wheel_of_fortune_gas_max',           name: 'WoF Gas Max',           icon: 'mdi:star-outline', val: 'wheel_of_fortune_gas_max',          category: 'diagnostic' },
            { id: 'wheel_of_fortune_gas_used',          name: 'WoF Gas Used',          icon: 'mdi:star-outline', val: 'wheel_of_fortune_gas_used',         category: 'diagnostic' },
            { id: 'wheel_of_fortune_error',             name: 'WoF Error',             icon: 'mdi:alert-circle', val: 'wheel_of_fortune_error',            category: 'diagnostic' },

            // --- Home Mini (main) ---
            { id: 'mini_demand_kw',             name: 'Home Mini Demand',             unit: 'kW',  class: 'power',  icon: 'mdi:home-lightning-bolt', val: 'mini_demand_kw' },
            { id: 'mini_consumption_delta_kwh', name: 'Home Mini Period Consumption', unit: 'kWh', class: 'energy', icon: 'mdi:home-lightning-bolt', val: 'mini_consumption_delta_kwh' },
            // --- Home Mini (diagnostic) ---
            { id: 'mini_read_at',    name: 'Home Mini Reading Time', class: 'timestamp', icon: 'mdi:clock-outline', val: 'mini_read_at',    category: 'diagnostic' },
            { id: 'home_mini_error', name: 'Home Mini Error',                            icon: 'mdi:alert-circle',  val: 'home_mini_error', category: 'diagnostic' },

            // --- Saving Sessions (main) ---
            { id: 'saving_session_points', name: 'Octopus Points',        icon: 'mdi:star',                  val: 'saving_session_points' },
            // --- Saving Sessions (config) ---
            { id: 'saving_session_start', name: 'Saving Session Start', class: 'timestamp', icon: 'mdi:calendar-clock', val: 'saving_session_start' },
            { id: 'saving_session_end',   name: 'Saving Session End',   class: 'timestamp', icon: 'mdi:calendar-clock', val: 'saving_session_end' },
            // --- Saving Sessions (diagnostic) ---
            { id: 'saving_sessions_error', name: 'Saving Sessions Error', icon: 'mdi:alert-circle', val: 'saving_sessions_error', category: 'diagnostic' },

            // --- Free Electricity (config) ---
            { id: 'free_electricity_start', name: 'Free Electricity Start', class: 'timestamp', icon: 'mdi:flash-circle', val: 'free_electricity_start' },
            { id: 'free_electricity_end',   name: 'Free Electricity End',   class: 'timestamp', icon: 'mdi:flash-circle', val: 'free_electricity_end' },
            // --- Free Electricity (diagnostic) ---
            { id: 'free_electricity_error', name: 'Free Electricity Error', icon: 'mdi:alert-circle', val: 'free_electricity_error', category: 'diagnostic' },

            // --- Dispatches (main) ---
            { id: 'completed_dispatches_count',    name: 'Completed Dispatches',    icon: 'mdi:history',               val: 'completed_dispatches_count' },
            { id: 'flex_planned_dispatches_count', name: 'Flex Planned Dispatches', icon: 'mdi:lightning-bolt-circle', val: 'flex_planned_dispatches_count' },
            // --- Dispatches (diagnostic) ---
            { id: 'completed_dispatches_error',    name: 'Completed Dispatches Error',    icon: 'mdi:alert-circle', val: 'completed_dispatches_error',    category: 'diagnostic' },
            { id: 'flex_planned_dispatches_error', name: 'Flex Planned Dispatches Error', icon: 'mdi:alert-circle', val: 'flex_planned_dispatches_error', category: 'diagnostic' },
            { id: 'intelligent_error',             name: 'Intelligent Error',             icon: 'mdi:alert-circle', val: 'intelligent_error',             category: 'diagnostic' },
        ];

        // 4. Helper: Announce Controls (Write-Enabled)
        function announceControls() {
            if (!enableMqtt || !node.broker) return;

            // Single device definition with branding
            const device = {
                identifiers: [`nodered_octopus_${account}`],
                name: "Octopus Intelligent",
                manufacturer: "Octopus Energy",
                model: "Intelligent Octopus Go",
                sw_version: "2.0.0",
                suggested_area: "Energy",
                configuration_url: "https://octopus.energy/intelligent/"
            };

            // A. The Slider (Number) - now shows pending value
            const limitConfig = {
                name: "Octopus Target Charge",
                unique_id: `${uniqueIdPrefix}_target_limit`,
                state_topic: stateTopic,
                command_topic: cmdTopicLimit,
                value_template: "{{ value_json.pending_limit }}",
                min: 50, max: 100, step: 5,
                unit_of_measurement: "%",
                icon: "mdi:battery-charging-high",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/number/${uniqueIdPrefix}_limit/config`, JSON.stringify(limitConfig), { retain: true });

            // B. The Dropdown (Select) - now shows pending value
            const timeConfig = {
                name: "Octopus Ready Time",
                unique_id: `${uniqueIdPrefix}_target_time`,
                state_topic: stateTopic,
                command_topic: cmdTopicTime,
                value_template: "{{ value_json.pending_time }}",
                options: TIME_OPTIONS,
                icon: "mdi:clock-time-four-outline",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/select/${uniqueIdPrefix}_time/config`, JSON.stringify(timeConfig), { retain: true });

            // C. Submit Button
            const buttonConfig = {
                name: "Octopus Apply Changes",
                unique_id: `${uniqueIdPrefix}_submit_button`,
                command_topic: cmdTopicSubmit,
                payload_press: "SUBMIT",
                icon: "mdi:check-circle",
                device_class: "update",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/button/${uniqueIdPrefix}_submit/config`, JSON.stringify(buttonConfig), { retain: true });

            // D. Refresh Button
            const refreshButtonConfig = {
                name: "Octopus Refresh API",
                unique_id: `${uniqueIdPrefix}_refresh_button`,
                command_topic: cmdTopicRefresh,
                payload_press: "REFRESH",
                icon: "mdi:refresh",
                device_class: "restart",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/button/${uniqueIdPrefix}_refresh/config`, JSON.stringify(refreshButtonConfig), { retain: true });

            // E. Add sensors for confirmed values (read-only display)
            const confirmedLimitSensor = {
                name: "Octopus Confirmed Charge Limit",
                unique_id: `${uniqueIdPrefix}_confirmed_limit`,
                state_topic: stateTopic,
                value_template: "{{ value_json.confirmed_limit }}",
                unit_of_measurement: "%",
                icon: "mdi:battery-check",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/sensor/${uniqueIdPrefix}_confirmed_limit/config`, JSON.stringify(confirmedLimitSensor), { retain: true });

            const confirmedTimeSensor = {
                name: "Octopus Confirmed Ready Time",
                unique_id: `${uniqueIdPrefix}_confirmed_time`,
                state_topic: stateTopic,
                value_template: "{{ value_json.confirmed_time }}",
                icon: "mdi:clock-check",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/sensor/${uniqueIdPrefix}_confirmed_time/config`, JSON.stringify(confirmedTimeSensor), { retain: true });

            // G. Charging Now Binary Sensor (main sensor for automations)
            const chargingNowBinarySensor = {
                name: "Octopus Charging Now",
                unique_id: `${uniqueIdPrefix}_charging_now`,
                state_topic: `${stateTopic}/charging_now`,
                device_class: "battery_charging",
                payload_on: "ON",
                payload_off: "OFF",
                icon: "mdi:ev-station",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_charging_now/config`, JSON.stringify(chargingNowBinarySensor), { retain: true });

            // G2. Saving Session Available Binary Sensor
            const savingSessionBinarySensor = {
                name: "Octopus Saving Session Available",
                unique_id: `${uniqueIdPrefix}_saving_session_available`,
                state_topic: stateTopic,
                value_template: "{{ value_json.saving_session_available }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:lightning-bolt-circle",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_saving_session_available/config`, JSON.stringify(savingSessionBinarySensor), { retain: true });

            // G2a. Saving Session Window Active Binary Sensor (v1.3.3)
            const savingSessionWindowActiveSensor = {
                name: "Octopus Saving Session Window Active",
                unique_id: `${uniqueIdPrefix}_saving_session_window_active`,
                state_topic: stateTopic,
                value_template: "{{ value_json.saving_session_window_active }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:clock-check-outline",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_saving_session_window_active/config`, JSON.stringify(savingSessionWindowActiveSensor), { retain: true });

            // G2b. Saving Session Active Binary Sensor (v1.3.3) — joined AND in window
            const savingSessionActiveSensor = {
                name: "Octopus Saving Session Active",
                unique_id: `${uniqueIdPrefix}_saving_session_active`,
                state_topic: stateTopic,
                value_template: "{{ value_json.saving_session_active }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:home-export-outline",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_saving_session_active/config`, JSON.stringify(savingSessionActiveSensor), { retain: true });

            // G2c. v1.3.3 migration: delete the deprecated sensor.saving_session_joined
            // entity. HA's sensor domain doesn't render booleans cleanly. Empty
            // payload on the discovery topic with retain tells HA the entity no
            // longer exists. Safe to keep across releases.
            node.broker.client.publish(`${mqttPrefix}/sensor/${uniqueIdPrefix}_saving_session_joined/config`, "", { retain: true });

            // G2d. Saving Session Joined Binary Sensor (v1.3.3 migration)
            const savingSessionJoinedSensor = {
                name: "Octopus Saving Session Joined",
                unique_id: `${uniqueIdPrefix}_saving_session_joined`,
                state_topic: stateTopic,
                value_template: "{{ value_json.saving_session_joined }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:account-check",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_saving_session_joined/config`, JSON.stringify(savingSessionJoinedSensor), { retain: true });

            // G3. Free Electricity Active Binary Sensor
            const freeElectricityActiveSensor = {
                name: "Octopus Free Electricity Active",
                unique_id: `${uniqueIdPrefix}_free_electricity_active`,
                state_topic: stateTopic,
                value_template: "{{ value_json.free_electricity_active }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:flash-circle",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_free_electricity_active/config`, JSON.stringify(freeElectricityActiveSensor), { retain: true });

            // G4. Free Electricity Available Binary Sensor
            const freeElectricityAvailableSensor = {
                name: "Octopus Free Electricity Available",
                unique_id: `${uniqueIdPrefix}_free_electricity_available`,
                state_topic: stateTopic,
                value_template: "{{ value_json.free_electricity_available }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:flash-circle-outline",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_free_electricity_available/config`, JSON.stringify(freeElectricityAvailableSensor), { retain: true });

            // G5. Octoplus Enrolled Binary Sensor
            // Published as binary_sensor (not sensor) because the value is a boolean —
            // HA's sensor domain rejects booleans without a device_class, leaving the
            // entity unregistered. No entity_category: 'config' on a read-only sensor
            // makes its state stick at "unavailable" on some HA installs (same fix as
            // the v1.3.0 tariff-sensor cleanup — see CHANGELOG).
            const octoplusEnrolledBinarySensor = {
                name: "Octopus Octoplus Enrolled",
                unique_id: `${uniqueIdPrefix}_octoplus_enrolled`,
                state_topic: stateTopic,
                value_template: "{{ value_json.octoplus_enrolled }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:star-circle",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_octoplus_enrolled/config`, JSON.stringify(octoplusEnrolledBinarySensor), { retain: true });

            // G6. Octoplus Loyalty Points (boolean) Binary Sensor
            // No entity_category — see G5.
            const octoplusLoyaltyBinarySensor = {
                name: "Octopus Octoplus Loyalty Points",
                unique_id: `${uniqueIdPrefix}_octoplus_loyalty_points_user`,
                state_topic: stateTopic,
                value_template: "{{ value_json.octoplus_loyalty_points_user }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:star",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_octoplus_loyalty_points_user/config`, JSON.stringify(octoplusLoyaltyBinarySensor), { retain: true });

            // H. Announce Read-Only Sensors
            sensors.forEach(sensor => {
                const payload = {
                    name: `Octopus ${sensor.name}`,
                    unique_id: `${uniqueIdPrefix}_${sensor.id}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.${sensor.val} }}`,
                    device: device
                };
                if (sensor.class) payload.device_class = sensor.class;
                if (sensor.unit) payload.unit_of_measurement = sensor.unit;
                if (sensor.stateClass) payload.state_class = sensor.stateClass;
                if (sensor.icon) payload.icon = sensor.icon;

                if (sensor.category) {
                    payload.entity_category = sensor.category;
                }

                node.broker.client.publish(`${mqttPrefix}/sensor/${uniqueIdPrefix}_${sensor.id}/config`, JSON.stringify(payload), { retain: true });
            });

            // I. Timezone Select Entity
            const TIMEZONE_OPTIONS = [
                "Europe/London", "Europe/Berlin", "Europe/Madrid",
                "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
                "Australia/Perth", "Australia/Adelaide", "Pacific/Auckland",
                "America/New_York", "America/Chicago", "America/Denver",
                "America/Los_Angeles", "Asia/Tokyo", "UTC"
            ];
            node.broker.client.publish(
                `${mqttPrefix}/select/${uniqueIdPrefix}_timezone/config`,
                JSON.stringify({
                    name: "Timezone",
                    unique_id: `${uniqueIdPrefix}_timezone`,
                    options: TIMEZONE_OPTIONS,
                    command_topic: cmdTopicTimezone,
                    state_topic: `${stateTopic}/timezone`,
                    icon: "mdi:earth",
                    entity_category: "config",
                    device: device
                }),
                { retain: true }
            );

            // J. Smart Charging Switch
            node.broker.client.publish(
                `${mqttPrefix}/switch/${uniqueIdPrefix}_smart_charging/config`,
                JSON.stringify({
                    name: "Smart Charging",
                    unique_id: `${uniqueIdPrefix}_smart_charging`,
                    command_topic: cmdTopicSmartCharging,
                    state_topic: `${stateTopic}/smart_charging`,
                    payload_on: "ON",
                    payload_off: "OFF",
                    icon: "mdi:lightning-bolt",
                    entity_category: "config",
                    device: device
                }),
                { retain: true }
            );

            // Subscribe to Commands
            node.broker.client.subscribe(cmdTopicLimit);
            node.broker.client.subscribe(cmdTopicTime);
            node.broker.client.subscribe(cmdTopicSubmit);
            node.broker.client.subscribe(cmdTopicRefresh);
            node.broker.client.subscribe(cmdTopicTimezone);
            node.broker.client.subscribe(cmdTopicSmartCharging);
        }

        // 5. Helper: Set Preferences (The Mutation)
        let retryTimeouts = []; // Track pending retry timeouts
        let expectedLimit = null;
        let expectedTime = null;

        // Pending vs Confirmed state
        let pendingLimit = 80;
        let pendingTime = "08:00";
        let confirmedLimit = 80;
        let confirmedTime = "08:00";

        // Charging Now feature - timer-based state management
        let chargingNow = false;
        let preValidationTimer = null;  // Fires 30s before slot start
        let slotStartTimer = null;       // Fires at exact slot start
        let slotEndTimer = null;         // Fires at exact slot end
        let cachedSlots = [];            // Fresh slot data from pre-validation
        let stateCheckInterval = null;   // Reconciliation loop (every 10s)
        let lastSentChargingState = null;  // Track last sent state to avoid duplicates

        // Manual refresh rate limiting (only for MQTT button, not Node-RED input)
        let lastManualRefresh = 0;       // Timestamp of last manual refresh
        const MANUAL_REFRESH_COOLDOWN = 30000;  // 30 seconds in milliseconds
        let cooldownExpiryTimer = null;  // Timer to clear cooldown state at expiry

        // Polling metrics
        let nextPollTime = null;         // ISO timestamp of next scheduled poll
        let pollIntervalHandle = null;   // Reference to setInterval handle
        const metrics = createApiMetrics();

        // API Complexity Tracking
        // Octopus Energy API does not return actual complexity values in headers or extensions,
        // so we use estimated complexity based on query types:
        // - Regular poll (auth + data query): ~300
        // - Mutation (auth + setPreferences): ~250
        // - Pre-validation (auth + flexPlannedDispatches only): ~200

        // Smart charging state (fetched once at startup)
        let krakenflexDeviceId = null;
        let smartChargingSuspended = null; // null=unknown, true=suspended(off), false=active(on)
        let smartChargingRetryTimeouts = [];

        // Last known full state - prevents sensors going unknown when controls change
        let lastKnownState = buildDefaultPayload({ confirmedLimit, confirmedTime, pendingLimit, pendingTime, chargingNow, smartChargingSuspended });

        // V2 category registry — populated after discovery
        let categories = [];

        async function initCategories(discovered) {
            categories = [];

            const electricityEnabled = config.electricityEnabled !== false;
            const gasEnabled = config.gasEnabled !== false;

            if (discovered.hasElectricity && electricityEnabled) {
                const ratesMs = (config.electricityRatesInterval || 60) * 60 * 1000;
                const consumptionMs = (config.electricityConsumptionInterval || 60) * 60 * 1000;
                categories.push({
                    id: 'electricity_rates',
                    enabled: true,
                    intervalMs: ratesMs,
                    lastPolled: 0,
                    queryFn: () => electricityCategory.buildRatesQuery(account),
                    parseFn: d => electricityCategory.parseRatesResponse(d)
                });
                categories.push({
                    id: 'electricity_consumption',
                    enabled: true,
                    intervalMs: consumptionMs,
                    lastPolled: 0,
                    queryFn: () => electricityCategory.buildConsumptionQuery(account, config.timezoneOverride || 'UTC'),
                    parseFn: d => electricityCategory.parseConsumptionResponse(d, discovered.electricityMpan, discovered.electricityExportMpan)
                });
            }

            if (discovered.hasGas && gasEnabled) {
                const ratesMs = (config.gasRatesInterval || 60) * 60 * 1000;
                const consumptionMs = (config.gasConsumptionInterval || 60) * 60 * 1000;
                categories.push({
                    id: 'gas_rates',
                    enabled: true,
                    intervalMs: ratesMs,
                    lastPolled: 0,
                    queryFn: () => gasCategory.buildRatesQuery(account),
                    parseFn: d => gasCategory.parseRatesResponse(d)
                });
                categories.push({
                    id: 'gas_consumption',
                    enabled: true,
                    intervalMs: consumptionMs,
                    lastPolled: 0,
                    queryFn: () => gasCategory.buildConsumptionQuery(account, config.timezoneOverride || 'UTC'),
                    parseFn: d => gasCategory.parseConsumptionResponse(d)
                });
            }

            categories.push({
                id: 'wheel_of_fortune',
                enabled: config.enableWheelOfFortune || false,
                intervalMs: (config.wheelOfFortuneInterval || 60) * 60 * 1000,
                lastPolled: 0,
                queryFn: () => wheelOfFortuneCategory.buildQuery(account),
                parseFn: d => wheelOfFortuneCategory.parseResponse(d)
            });
            if (discovered.smartMeterDeviceId) {
                categories.push({
                    id: 'home_mini',
                    enabled: config.enableHomeMini || false,
                    intervalMs: (config.homeMiniInterval || 1) * 60 * 1000,
                    lastPolled: 0,
                    queryFn: () => homeMiniCategory.buildQuery(discovered.smartMeterDeviceId),
                    parseFn: d => homeMiniCategory.parseResponse(d)
                });
            }
            categories.push({
                id: 'saving_sessions',
                enabled: true,
                intervalMs: (config.savingSessionsInterval || 60) * 60 * 1000,
                lastPolled: 0,
                queryFn: () => savingSessionsCategory.buildQuery(account),
                parseFn: d => savingSessionsCategory.parseResponse(d)
            });

            if (discovered.hasIntelligent) {
                categories.push({
                    id: 'completed_dispatches',
                    enabled: true,
                    intervalMs: 60 * 60 * 1000,
                    lastPolled: 0,
                    queryFn: () => completedDispatchesCategory.buildQuery(account),
                    parseFn: d => completedDispatchesCategory.parseResponse(d)
                });
                if (discovered.deviceId) {
                    categories.push({
                        id: 'flex_planned_dispatches',
                        enabled: true,
                        intervalMs: (config.refreshInterval || 5) * 60 * 1000,
                        lastPolled: 0,
                        queryFn: () => flexPlannedDispatchesCategory.buildQuery(discovered.deviceId),
                        parseFn: d => flexPlannedDispatchesCategory.parseResponse(d)
                    });
                }
            }

            if (discovered.hasElectricity && discovered.electricityMpan) {
                categories.push({
                    id: 'applicable_rates',
                    enabled: true,
                    intervalMs: (config.electricityRatesInterval || 60) * 60 * 1000,
                    lastPolled: 0,
                    queryFn: () => applicableRatesCategory.buildQuery(account, discovered.electricityMpan),
                    parseFn: d => applicableRatesCategory.parseResponse(d)
                });
            }

            // Export applicable rates — second query with the export MPAN. Same parser,
            // different field prefix so the output keys don't collide with import.
            if (discovered.hasElectricity && discovered.electricityExportMpan) {
                categories.push({
                    id: 'applicable_rates_export',
                    enabled: true,
                    intervalMs: (config.electricityRatesInterval || 60) * 60 * 1000,
                    lastPolled: 0,
                    queryFn: () => applicableRatesCategory.buildQuery(account, discovered.electricityExportMpan),
                    parseFn: d => applicableRatesCategory.parseResponse(d, { fieldPrefix: 'electricity_export_rate' })
                });
            }

            if (discovered.hasElectricity && discovered.electricityMpan) {
                categories.push({
                    id: 'free_electricity',
                    enabled: true,
                    intervalMs: 30 * 60 * 1000,  // 30 minutes
                    lastPolled: 0,
                    queryFn: () => freeElectricityCategory.buildQuery(account, discovered.electricityMpan),
                    parseFn: d => freeElectricityCategory.parseResponse(d)
                });
            }

            categories.push({
                id: 'account',
                enabled: true,
                intervalMs: 60 * 60 * 1000,
                lastPolled: 0,
                queryFn: () => accountCategory.buildQuery(account),
                parseFn: d => accountCategory.parseResponse(d)
            });

            categories.push({
                id: 'octoplus',
                enabled: true,
                intervalMs: 60 * 60 * 1000,
                lastPolled: 0,
                queryFn: () => octoplusCategory.buildQuery(account),
                parseFn: d => octoplusCategory.parseResponse(d)
            });
        }

        async function pollDueCategories() {
            const { isDue } = require('./lib/scheduler');
            const due = categories.filter(c => c.enabled && isDue(c));
            if (due.length === 0) return;

            let token;
            try {
                const response = await graphqlPost({
                    query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                    variables: { input: { APIKey: apiKey } }
                });
                if (!response.data.data || !response.data.data.obtainKrakenToken) {
                    throw new Error('Auth response missing token');
                }
                token = response.data.data.obtainKrakenToken.token;
            } catch (e) {
                node.warn(`V2 category poll: auth failed: ${e.message}`);
                return;
            }

            for (const cat of due) {
                try {
                    const { query, variables, hostname } = cat.queryFn();
                    const response = await graphqlPost({ query, variables }, token, hostname);
                    if (response.data.errors) throw new Error(JSON.stringify(response.data.errors));
                    if (!response.data.data) throw new Error('Response missing data');
                    const parsed = cat.parseFn(response.data.data);
                    lastKnownState = mergePayload(lastKnownState, parsed);
                    cat.lastPolled = Date.now();
                } catch (e) {
                    cat.enabled = false;
                    node.warn(`V2 category ${cat.id} failed (disabled until redeploy): ${e.message}`);
                }
            }

            if (enableMqtt && node.broker && node.broker.client) {
                node.broker.client.publish(stateTopic, JSON.stringify(lastKnownState), { retain: true });
            }
            node.send({ payload: lastKnownState });
        }

        async function setPreferences(newLimit, newTime) {
            // Validation
            let limit = parseInt(newLimit);
            let time = newTime;

            // Enforce Limits
            if (isNaN(limit) || limit < 50) limit = 50;
            if (limit > 100) limit = 100;
            // Round to nearest 5
            limit = Math.round(limit / 5) * 5;

            // Validate Time
            if (!TIME_OPTIONS.includes(time)) {
                node.warn(`Invalid time '${time}' requested. Defaulting to 08:00`);
                time = "08:00";
            }

            // Cancel any pending retry attempts from previous changes
            retryTimeouts.forEach(timeout => clearTimeout(timeout));
            retryTimeouts = [];

            try {
                node.status({ fill: "blue", shape: "dot", text: "Updating Settings..." });

                // A. Get Token
                const authResponse = await graphqlPost({
                    query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                    variables: { input: { APIKey: apiKey } }
                });

                if (authResponse.data.errors) {
                    throw new Error(`Auth failed: ${JSON.stringify(authResponse.data.errors)}`);
                }
                if (!authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                    throw new Error(`Auth response missing token data`);
                }

                const token = authResponse.data.data.obtainKrakenToken.token;

                // B. Send Mutation
                if (!krakenflexDeviceId) {
                    throw new Error('Device ID not available — cannot set preferences');
                }

                const mutation = `
                mutation setPreferences($input: SmartFlexDevicePreferencesInput!) {
                    setDevicePreferences(input: $input) { __typename }
                }`;

                const DAYS = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'];
                function buildDevicePreferencesInput(deviceId, socLimit, readyTime) {
                    return {
                        deviceId,
                        mode: 'CHARGE',
                        unit: 'PERCENTAGE',
                        schedules: DAYS.map(dayOfWeek => ({
                            dayOfWeek,
                            time: readyTime + ':00',
                            min: 0,
                            max: socLimit
                        }))
                    };
                }

                const variables = {
                    input: buildDevicePreferencesInput(krakenflexDeviceId, limit, time)
                };

                const mutationResponse = await graphqlPost({
                    query: mutation,
                    variables: variables
                }, token);

                if (mutationResponse.data.errors) {
                    throw new Error(`Mutation failed: ${JSON.stringify(mutationResponse.data.errors)}`);
                }

                // Record mutation API usage (auth + mutation = ~250 complexity)
                const ESTIMATED_MUTATION_COMPLEXITY = 250;
                metrics.recordPoll(ESTIMATED_MUTATION_COMPLEXITY);

                // C. Start exponential backoff validation
                expectedLimit = limit;
                expectedTime = time;
                node.status({ fill: "blue", shape: "ring", text: "Verifying changes..." });

                // Schedule retries with exponential backoff: 15s, 30s, 60s, 120s
                const retryIntervals = [15000, 30000, 60000, 120000];
                scheduleRetries(retryIntervals, 0);

            } catch (err) {
                node.error("Failed to set preferences: " + err.message);
                if (err.response) {
                    node.error(`Response: ${JSON.stringify(err.response.data)}`);
                }
                node.status({ fill: "red", shape: "ring", text: "Update Failed" });
                expectedLimit = null;
                expectedTime = null;
            }
        }

        function scheduleRetries(intervals, index) {
            if (index >= intervals.length) {
                // All retries exhausted, let normal interval take over
                node.status({ fill: "yellow", shape: "dot", text: "Waiting for normal sync..." });
                expectedLimit = null;
                expectedTime = null;
                return;
            }

            const timeout = setTimeout(async () => {
                await fetchDataWithValidation(intervals, index);
            }, intervals[index]);

            retryTimeouts.push(timeout);
        }

        async function fetchDataWithValidation(intervals, currentIndex) {
            try {
                const result = await fetchData(true); // Pass flag to indicate validation mode

                // Check if the data matches our expected values
                if (result && result.validated) {
                    // Success! Changes confirmed
                    node.status({ fill: "green", shape: "dot", text: `Confirmed: ${result.confirmedLimit}% @ ${result.confirmedTime}` });
                    expectedLimit = null;
                    expectedTime = null;
                    // Clear remaining timeouts
                    retryTimeouts.forEach(timeout => clearTimeout(timeout));
                    retryTimeouts = [];
                } else {
                    // Not yet updated, schedule next retry
                    const attempt = currentIndex + 1;
                    const totalAttempts = intervals.length;
                    node.status({ fill: "blue", shape: "ring", text: `Retry ${attempt}/${totalAttempts}...` });
                    scheduleRetries(intervals, currentIndex + 1);
                }
            } catch (error) {
                // Error during fetch, schedule next retry
                node.warn(`Retry ${currentIndex + 1} failed: ${error.message}`);
                scheduleRetries(intervals, currentIndex + 1);
            }
        }

        // Helper: Toggle smart charging on/off
        async function setSmartCharging(enable) {
            if (!krakenflexDeviceId) {
                node.warn("Device ID not available — cannot toggle smart charging");
                return;
            }

            // Cancel any pending verification retries
            smartChargingRetryTimeouts.forEach(t => clearTimeout(t));
            smartChargingRetryTimeouts = [];

            const previousSuspended = smartChargingSuspended;

            try {
                node.status({ fill: "blue", shape: "dot", text: enable ? "Enabling smart charging..." : "Suspending smart charging..." });

                const authResponse = await graphqlPost({
                    query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                    variables: { input: { APIKey: apiKey } }
                });
                if (authResponse.data.errors || !authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                    throw new Error(`Auth failed: ${JSON.stringify(authResponse.data.errors)}`);
                }
                const token = authResponse.data.data.obtainKrakenToken.token;

                const action = enable ? "UNSUSPEND" : "SUSPEND";
                const mutationResponse = await graphqlPost({
                    query: `mutation UpdateSmartControl($deviceId: ID!, $action: SmartControlAction!) { updateDeviceSmartControl(input: { deviceId: $deviceId, action: $action }) { id } }`,
                    variables: { deviceId: krakenflexDeviceId, action: action }
                }, token);

                if (mutationResponse.data.errors) {
                    throw new Error(`Smart charging mutation failed: ${JSON.stringify(mutationResponse.data.errors)}`);
                }

                // Record mutation API usage (auth + mutation = ~250 complexity)
                const ESTIMATED_MUTATION_COMPLEXITY = 250;
                metrics.recordPoll(ESTIMATED_MUTATION_COMPLEXITY);

                // Optimistically update cached state
                const expectedSuspended = !enable;
                smartChargingSuspended = expectedSuspended;

                // Publish new state to HA switch topic immediately
                if (enableMqtt && node.broker && node.broker.client) {
                    node.broker.client.publish(`${stateTopic}/smart_charging`, enable ? "ON" : "OFF", { retain: true });
                }

                // Schedule verification: 15s / 30s / 60s / 120s
                scheduleSmartChargingVerification(expectedSuspended, [15000, 30000, 60000, 120000], 0);

            } catch (e) {
                node.error(`Failed to toggle smart charging: ${e.message}`);
                // Revert optimistic update to pre-mutation state
                smartChargingSuspended = previousSuspended;
                node.status({ fill: "red", shape: "ring", text: "Smart charging update failed" });
                // Republish previous state so HA switch UI re-syncs
                if (enableMqtt && node.broker && node.broker.client && previousSuspended !== null) {
                    node.broker.client.publish(
                        `${stateTopic}/smart_charging`,
                        previousSuspended ? "OFF" : "ON",
                        { retain: true }
                    );
                }
            }
        }

        function scheduleSmartChargingVerification(expectedSuspended, intervals, index) {
            if (index >= intervals.length) {
                node.warn("Smart charging state could not be confirmed after all retries");
                node.status({ fill: "red", shape: "ring", text: "Smart charging: update unconfirmed" });
                return;
            }
            const timeout = setTimeout(async () => {
                try {
                    const authResponse = await graphqlPost({
                        query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                        variables: { input: { APIKey: apiKey } }
                    });
                    if (authResponse.data.errors || !authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                        scheduleSmartChargingVerification(expectedSuspended, intervals, index + 1);
                        return;
                    }
                    const token = authResponse.data.data.obtainKrakenToken.token;

                    const deviceResponse = await graphqlPost({
                        query: `query getDevices($accountNumber: String!) { devices(accountNumber: $accountNumber) { id deviceType status { isSuspended } } }`,
                        variables: { accountNumber: account }
                    }, token);

                    if (deviceResponse.data.errors || !deviceResponse.data.data) {
                        scheduleSmartChargingVerification(expectedSuspended, intervals, index + 1);
                        return;
                    }

                    const evDevice = (deviceResponse.data.data.devices || []).find(d => d.deviceType === 'ELECTRIC_VEHICLES');
                    if (!evDevice) {
                        scheduleSmartChargingVerification(expectedSuspended, intervals, index + 1);
                        return;
                    }

                    // Record verification API usage (auth + device query = ~200 complexity)
                    const ESTIMATED_VERIFICATION_COMPLEXITY = 200;
                    metrics.recordPoll(ESTIMATED_VERIFICATION_COMPLEXITY);

                    const actualSuspended = evDevice.status.isSuspended;
                    if (actualSuspended === expectedSuspended) {
                        // Confirmed — clear remaining retries
                        smartChargingSuspended = actualSuspended;
                        smartChargingRetryTimeouts.forEach(t => clearTimeout(t));
                        smartChargingRetryTimeouts = [];
                        node.log(`Smart charging confirmed: suspended=${actualSuspended}`);
                        node.status({ fill: "green", shape: "dot", text: actualSuspended ? "Smart charging suspended" : "Smart charging enabled" });
                    } else {
                        scheduleSmartChargingVerification(expectedSuspended, intervals, index + 1);
                    }
                } catch (e) {
                    node.warn(`Smart charging verification attempt ${index + 1} failed: ${e.message}`);
                    scheduleSmartChargingVerification(expectedSuspended, intervals, index + 1);
                }
            }, intervals[index]);
            smartChargingRetryTimeouts.push(timeout);
        }

        // 6. Logic: Fetch Data (Read)
        async function fetchData(validationMode = false) {
            // Estimated complexity per poll:
            // - Auth mutation: ~100 complexity
            // - Data query (devices + flexPlannedDispatches — two sequential calls): ~400 complexity
            // - Total: ~300 complexity per poll
            const ESTIMATED_POLL_COMPLEXITY = 300;

            // Debug object to track API calls
            const debugInfo = {
                timestamp: new Date().toISOString(),
                step: null,
                success: false,
                error: null,
                apiCalls: [],
                validationMode: validationMode
            };

            if (!apiKey || !account) {
                debugInfo.error = "Missing configuration: apiKey or account number not provided";
                debugInfo.step = "validation";
                node.status({ fill: "red", shape: "ring", text: "Config Missing" });
                node.send({
                    payload: getDefaultPayload(),
                    debug: debugInfo
                });
                return { validated: false };
            }

            try {
                // STEP 1: Get Token
                debugInfo.step = "authentication";
                node.status({ fill: "yellow", shape: "ring", text: "Authenticating..." });

                const authRequest = {
                    url: "https://api.octopus.energy/v1/graphql/",
                    query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                    variables: { input: { APIKey: apiKey } }
                };

                const authResponse = await graphqlPost({
                    query: authRequest.query,
                    variables: authRequest.variables
                });

                debugInfo.apiCalls.push({
                    step: 1,
                    name: "authentication",
                    url: authRequest.url,
                    statusCode: authResponse.status,
                    hasErrors: !!(authResponse.data.errors),
                    errors: authResponse.data.errors || null
                });

                // Validate auth response
                if (authResponse.data.errors) {
                    throw new Error(`Auth failed: ${JSON.stringify(authResponse.data.errors)}`);
                }
                if (!authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                    throw new Error(`Auth response missing token data. Response: ${JSON.stringify(authResponse.data)}`);
                }

                const token = authResponse.data.data.obtainKrakenToken.token;
                debugInfo.apiCalls[0].tokenObtained = !!token;
                debugInfo.apiCalls[0].tokenPrefix = token ? token.substring(0, 20) + "..." : null;

                // STEP 2a: Fetch devices (preferences + device ID)
                debugInfo.step = "fetching_devices";
                node.status({ fill: "yellow", shape: "ring", text: "Fetching data..." });

                const { query: devicesQuery, variables: devicesVars } = intelligentCategory.buildDevicesQuery(account);
                const devicesResponse = await graphqlPost({ query: devicesQuery, variables: devicesVars }, token);

                debugInfo.apiCalls.push({
                    step: 2,
                    name: "devices_query",
                    url: "https://api.octopus.energy/v1/graphql/",
                    accountNumber: account,
                    statusCode: devicesResponse.status,
                    hasErrors: !!(devicesResponse.data.errors),
                    errors: devicesResponse.data.errors || null,
                    hasData: !!(devicesResponse.data.data),
                    responseHeaders: devicesResponse.headers || {}
                });

                if (devicesResponse.data.errors) {
                    throw new Error(`Devices query failed: ${JSON.stringify(devicesResponse.data.errors)}`);
                }
                if (!devicesResponse.data.data) {
                    throw new Error(`Devices response missing data. Response: ${JSON.stringify(devicesResponse.data)}`);
                }

                const devicesData = devicesResponse.data.data;
                const evDevice = intelligentCategory.extractEvDevice(devicesData.devices);
                if (!evDevice) {
                    throw new Error('No ELECTRIC_VEHICLES device found on account');
                }
                krakenflexDeviceId = evDevice.id;

                // STEP 2b: Fetch planned dispatches using device ID
                debugInfo.step = "fetching_dispatches";
                const { query: dispatchQuery, variables: dispatchVars } = intelligentCategory.buildDispatchQuery(evDevice.id);
                const dispatchResponse = await graphqlPost({ query: dispatchQuery, variables: dispatchVars }, token);

                debugInfo.apiCalls.push({
                    step: 3,
                    name: "dispatches_query",
                    url: "https://api.octopus.energy/v1/graphql/",
                    deviceId: evDevice.id,
                    statusCode: dispatchResponse.status,
                    hasErrors: !!(dispatchResponse.data.errors),
                    errors: dispatchResponse.data.errors || null,
                    hasData: !!(dispatchResponse.data.data),
                    responseHeaders: dispatchResponse.headers || {}
                });

                if (dispatchResponse.data.errors) {
                    throw new Error(`Dispatches query failed: ${JSON.stringify(dispatchResponse.data.errors)}`);
                }
                if (!dispatchResponse.data.data) {
                    throw new Error(`Dispatches response missing data. Response: ${JSON.stringify(dispatchResponse.data)}`);
                }

                // STEP 3: Extract and Process
                debugInfo.step = "processing";
                const data = {
                    devices: devicesData.devices,
                    flexPlannedDispatches: dispatchResponse.data.data.flexPlannedDispatches || []
                };
                const slots = data.flexPlannedDispatches;

                // Check for GraphQL extensions on the dispatches response
                let actualComplexity = null;
                if (dispatchResponse.data.extensions) {
                    debugInfo.apiCalls[2].extensions = dispatchResponse.data.extensions;
                    actualComplexity = dispatchResponse.data.extensions.complexity ||
                                      dispatchResponse.data.extensions.cost ||
                                      null;
                }

                // Record poll with estimated or actual complexity
                metrics.recordPoll(actualComplexity || ESTIMATED_POLL_COMPLEXITY);

                debugInfo.apiCalls[2].slotsFound = slots.length;
                debugInfo.apiCalls[2].slotDetails = slots.map(s => ({
                    start: s.start,
                    end: s.end,
                    kwh: s.energyAddedKwh,
                    type: s.type
                }));

                // Parse response via intelligent category module
                const appliedTz = resolveTimezone(node);
                const serverTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch(e) { return 'UTC'; } })();
                const catResult = intelligentCategory.parseResponse(data, { tz: appliedTz, serverTz });
                const { _activeSlots, ...catPublic } = catResult;

                // Update Confirmed State (from catResult)
                confirmedLimit = catResult.confirmed_limit ?? confirmedLimit;
                confirmedTime = catResult.confirmed_time || confirmedTime;

                // On successful fetch, sync pending to confirmed if not in validation mode
                if (!validationMode) {
                    pendingLimit = confirmedLimit;
                    pendingTime = confirmedTime;
                }

                debugInfo.apiCalls[1].activeAndFutureSlots = _activeSlots.length;
                debugInfo.processingTime = new Date().toISOString();

                // Setup charging timers (always update charging state)
                setupChargingTimers(_activeSlots);

                // Start reconciliation loop on first successful data fetch (only in non-validation mode)
                if (!validationMode && !stateCheckInterval) {
                    startStateReconciliation();
                }

                // Update next poll time after successful fetch
                updateNextPollTime();

                // Get API metrics for inclusion in payload
                const apiMetrics = metrics.getMetrics();

                // Build Payload — merge catResult into lastKnownState, then add orchestrator-owned fields
                const statusPayload = Object.assign({}, lastKnownState, catPublic, {
                    // Orchestrator-owned state fields (not in intelligentCategory)
                    pending_limit: pendingLimit,
                    pending_time: pendingTime,
                    charging_now: chargingNow,
                    next_poll: nextPollTime,
                    next_poll_raw: nextPollTime,
                    refresh_available_at: getRefreshAvailableAt(),
                    api_requests_hour: apiMetrics.requests_last_hour,
                    api_complexity_hour: apiMetrics.complexity_last_hour,
                    api_complexity_percent: parseFloat(apiMetrics.complexity_percent),
                    timezone_detected: serverTz,
                    timezone_applied: appliedTz,
                    smart_charging: smartChargingSuspended === null ? null : !smartChargingSuspended
                });

                // Success!
                debugInfo.success = true;
                debugInfo.step = "complete";

                // Check if we're validating a preference change
                let isValidated = false;
                if (validationMode && expectedLimit !== null && expectedTime !== null) {
                    // Check if the returned values match what we set
                    isValidated = (confirmedLimit === expectedLimit && confirmedTime === expectedTime);
                    debugInfo.expectedLimit = expectedLimit;
                    debugInfo.expectedTime = expectedTime;
                    debugInfo.receivedLimit = confirmedLimit;
                    debugInfo.receivedTime = confirmedTime;
                    debugInfo.validated = isValidated;
                }

                // Add API usage metrics to debug info (already fetched above)
                debugInfo.api_usage = {
                    requests_last_hour: apiMetrics.requests_last_hour,
                    complexity_last_hour: apiMetrics.complexity_last_hour,
                    complexity_percent_used: apiMetrics.complexity_percent,
                    api_limit_hourly: 50000,
                    request_complexity: actualComplexity || ESTIMATED_POLL_COMPLEXITY,
                    complexity_source: actualComplexity ? "api" : "estimated"
                };

                // Store this as the last known full state
                lastKnownState = statusPayload;

                // ALWAYS publish data to prevent sensors becoming unavailable
                node.send({
                    payload: statusPayload,
                    debug: debugInfo
                });

                // Update last sent charging state to prevent duplicate messages
                lastSentChargingState = chargingNow;

                if (enableMqtt && node.broker) {
                    node.broker.client.publish(stateTopic, JSON.stringify(statusPayload), { retain: true });
                    // Also publish charging_now state to binary sensor topic
                    const chargingPayload = chargingNow ? "ON" : "OFF";
                    node.broker.client.publish(`${stateTopic}/charging_now`, chargingPayload, { retain: true });
                }

                // Update status (validation mode will override this in fetchDataWithValidation)
                if (!validationMode) {
                    node.status({ fill: "green", shape: "dot", text: `Confirmed: ${confirmedLimit}% @ ${confirmedTime}` });
                }

                // Return validation result
                return { validated: isValidated || !validationMode, confirmedLimit, confirmedTime };

            } catch (error) {
                debugInfo.success = false;
                debugInfo.error = {
                    message: error.message,
                    stack: error.stack,
                    response: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : null
                };

                // Log to Node-RED (only if not in validation mode to avoid spam)
                if (!validationMode) {
                    node.error(`Octopus API Error at ${debugInfo.step}: ${error.message}`);
                    if (error.response) {
                        node.error(`Response: ${JSON.stringify(error.response.data)}`);
                    }

                    // Update status
                    node.status({
                        fill: "red",
                        shape: "ring",
                        text: `Error: ${debugInfo.step}`
                    });

                    // Send default payload with debug info
                    node.send({
                        payload: getDefaultPayload(),
                        debug: debugInfo
                    });
                }

                // Return failure for validation
                return { validated: false };
            }
        }

        // Helper: Build default payload when errors occur — delegates to lib/payload.js
        function getDefaultPayload() {
            return buildDefaultPayload({ confirmedLimit, confirmedTime, pendingLimit, pendingTime, chargingNow, smartChargingSuspended });
        }

        // Helper: Fetch device ID and initial smart charging state (called once at startup)
        async function fetchDeviceId() {
            try {
                const authResponse = await graphqlPost({
                    query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                    variables: { input: { APIKey: apiKey } }
                });
                if (authResponse.data.errors || !authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                    throw new Error(`Auth failed: ${JSON.stringify(authResponse.data.errors)}`);
                }
                const token = authResponse.data.data.obtainKrakenToken.token;

                const deviceResponse = await graphqlPost({
                    query: `query getDevices($accountNumber: String!) { devices(accountNumber: $accountNumber) { id deviceType status { isSuspended } } }`,
                    variables: { accountNumber: account }
                }, token);

                if (deviceResponse.data.errors || !deviceResponse.data.data) {
                    throw new Error(`Device fetch failed: ${JSON.stringify(deviceResponse.data.errors)}`);
                }

                function extractEvDevice(devices) {
                    return (devices || []).find(d => d.deviceType === 'ELECTRIC_VEHICLES') || null;
                }

                const evDevice = extractEvDevice(deviceResponse.data.data.devices);
                if (!evDevice) {
                    throw new Error('No ELECTRIC_VEHICLES device found on account');
                }

                krakenflexDeviceId = evDevice.id;
                smartChargingSuspended = evDevice.status.isSuspended;
                node.log(`Device ID cached: ${krakenflexDeviceId}, suspended: ${smartChargingSuspended}`);
            } catch (e) {
                node.warn(`Failed to fetch device ID at startup: ${e.message}. Smart charging toggle unavailable.`);
                krakenflexDeviceId = null;
                smartChargingSuspended = null;
            }
        }

        // 6a. Charging Now - Timer Management Functions

        // State reconciliation - checks every 10s if charging state matches reality
        function reconcileChargingState() {
            if (!cachedSlots || cachedSlots.length === 0) return;

            const now = new Date();

            // Check if we should be charging RIGHT NOW based on cached slots
            const shouldBeCharging = cachedSlots.some(slot => {
                const start = new Date(slot.start);
                const end = new Date(slot.end);
                return start <= now && end > now;
            });

            // Update state if it doesn't match reality
            if (shouldBeCharging !== chargingNow) {
                node.warn(`State reconciliation: Correcting chargingNow from ${chargingNow} to ${shouldBeCharging}`);
                publishChargingState(shouldBeCharging);
            }
        }

        // Start state reconciliation loop (every 10 seconds)
        function startStateReconciliation() {
            // Clear existing interval
            if (stateCheckInterval) {
                clearInterval(stateCheckInterval);
            }

            // Check state every 10 seconds
            stateCheckInterval = setInterval(() => {
                reconcileChargingState();
            }, 10000);

            node.log("State reconciliation loop started (every 10s)");
        }

        // Clear all charging timers
        function clearChargingTimers() {
            if (preValidationTimer) {
                clearTimeout(preValidationTimer);
                preValidationTimer = null;
            }
            if (slotStartTimer) {
                clearTimeout(slotStartTimer);
                slotStartTimer = null;
            }
            if (slotEndTimer) {
                clearTimeout(slotEndTimer);
                slotEndTimer = null;
            }
            if (stateCheckInterval) {
                clearInterval(stateCheckInterval);
                stateCheckInterval = null;
            }
        }

        // Manual refresh rate limiting helpers
        function canManualRefresh() {
            const now = Date.now();
            const timeSinceLastRefresh = now - lastManualRefresh;
            return lastManualRefresh === 0 || timeSinceLastRefresh >= MANUAL_REFRESH_COOLDOWN;
        }

        function getSecondsUntilNextRefresh() {
            const now = Date.now();
            const timeSinceLastRefresh = now - lastManualRefresh;
            const timeRemaining = MANUAL_REFRESH_COOLDOWN - timeSinceLastRefresh;
            return Math.max(0, Math.ceil(timeRemaining / 1000));
        }

        function getRefreshAvailableAt() {
            const now = Date.now();
            const timeSinceLastRefresh = now - lastManualRefresh;

            // If never refreshed OR cooldown expired, ready now
            if (lastManualRefresh === 0 || timeSinceLastRefresh >= MANUAL_REFRESH_COOLDOWN) {
                return null;  // Ready - no cooldown
            }

            // Cooldown active - return timestamp when it expires
            return new Date(lastManualRefresh + MANUAL_REFRESH_COOLDOWN).toISOString();
        }

        function publishRefreshCooldownState() {
            if (enableMqtt && node.broker) {
                const fullState = {
                    ...lastKnownState,
                    refresh_available_at: getRefreshAvailableAt()
                };
                node.broker.client.publish(stateTopic, JSON.stringify(fullState), { retain: true });
            }
        }

        // Polling metrics helpers
        function updateNextPollTime() {
            nextPollTime = new Date(Date.now() + refreshRate).toISOString();
        }

        // Publish charging state to MQTT and Node-RED
        function publishChargingState(state) {
            chargingNow = state;

            // Update MQTT
            if (enableMqtt && node.broker) {
                const payload = state ? "ON" : "OFF";
                node.broker.client.publish(`${stateTopic}/charging_now`, payload, { retain: true });
            }

            // Output message to Node-RED flow if state actually changed
            if (lastSentChargingState !== state) {
                lastSentChargingState = state;

                // Merge updated charging_now into last known full state
                const outputPayload = {
                    ...lastKnownState,
                    charging_now: state
                };

                node.send({
                    payload: outputPayload,
                    debug: {
                        timestamp: new Date().toISOString(),
                        trigger: 'charging_state_change',
                        success: true,
                        previous_state: !state,
                        new_state: state
                    }
                });

                node.log(`Charging state changed: ${!state} → ${state}, message sent`);
            }
        }

        // Setup pre-validation timer (30s before slot starts)
        function setupPreValidationTimer(nextSlot) {
            const now = new Date();
            const slotStart = new Date(nextSlot.start);
            const preValidationTime = slotStart.getTime() - 30000; // 30s before
            const msUntilPreValidation = preValidationTime - now.getTime();

            if (msUntilPreValidation > 0 && msUntilPreValidation < 24 * 60 * 60 * 1000) { // Within 24 hours
                preValidationTimer = setTimeout(async () => {
                    node.warn("Pre-validating slot data (30s before start)");
                    try {
                        if (!krakenflexDeviceId) {
                            throw new Error("Device ID not available for pre-validation");
                        }

                        const authResponse = await graphqlPost({
                            query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                            variables: { input: { APIKey: apiKey } }
                        });

                        if (!authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                            throw new Error("Pre-validation auth failed");
                        }

                        const token = authResponse.data.data.obtainKrakenToken.token;

                        const { query: dq, variables: dv } = intelligentCategory.buildDispatchQuery(krakenflexDeviceId);
                        const dataResponse = await graphqlPost({ query: dq, variables: dv }, token);

                        if (dataResponse.data.data && dataResponse.data.data.flexPlannedDispatches) {
                            cachedSlots = dataResponse.data.data.flexPlannedDispatches;

                            // Record pre-validation API usage (auth + simple query = ~200 complexity)
                            const ESTIMATED_PREVALIDATION_COMPLEXITY = 200;
                            metrics.recordPoll(ESTIMATED_PREVALIDATION_COMPLEXITY);

                            // Check if slot still exists (within 1 minute tolerance)
                            const stillExists = cachedSlots.find(s =>
                                Math.abs(new Date(s.start).getTime() - slotStart.getTime()) < 60000
                            );

                            if (stillExists) {
                                node.warn(`Slot confirmed at ${stillExists.start}`);
                                setupSlotStartTimer(stillExists);
                            } else {
                                node.warn("Slot was cancelled or modified - not setting start timer");
                            }
                        }
                    } catch (error) {
                        node.warn(`Pre-validation failed: ${error.message}, using cached slot`);
                        // Fallback: use original slot data
                        setupSlotStartTimer(nextSlot);
                    }
                }, msUntilPreValidation);

                const minutesUntil = Math.round(msUntilPreValidation / 60000);
                node.log(`Pre-validation timer set for ${minutesUntil} min before slot start`);
            }
        }

        // Setup slot start timer (exact start time)
        function setupSlotStartTimer(slot) {
            const now = new Date();
            const slotStart = new Date(slot.start);
            const msUntilStart = slotStart.getTime() - now.getTime();

            if (msUntilStart > 0 && msUntilStart < 24 * 60 * 60 * 1000) { // Within 24 hours
                slotStartTimer = setTimeout(() => {
                    publishChargingState(true);
                    node.warn(`Charging slot started at ${slot.start}`);
                    setupSlotEndTimer(slot);
                }, msUntilStart);

                const secondsUntil = Math.round(msUntilStart / 1000);
                node.log(`Slot start timer set for ${secondsUntil}s (${slot.start})`);
            } else if (msUntilStart <= 0) {
                // Slot already started, check if it's still active
                const slotEnd = new Date(slot.end);
                if (slotEnd > now) {
                    publishChargingState(true);
                    setupSlotEndTimer(slot);
                }
            }
        }

        // Setup slot end timer (exact end time)
        function setupSlotEndTimer(slot) {
            const now = new Date();
            const slotEnd = new Date(slot.end);
            const msUntilEnd = slotEnd.getTime() - now.getTime();

            if (msUntilEnd > 0 && msUntilEnd < 24 * 60 * 60 * 1000) { // Within 24 hours
                slotEndTimer = setTimeout(() => {
                    node.warn(`Charging slot ended at ${slot.end}`);

                    // Check if another slot starts immediately (within cached data)
                    const now = new Date();
                    const immediateNextSlot = cachedSlots.find(s => {
                        const start = new Date(s.start);
                        const end = new Date(s.end);
                        return start <= now && end > now;
                    });

                    if (immediateNextSlot) {
                        node.warn("Next slot starting immediately");
                        publishChargingState(true);
                        setupSlotEndTimer(immediateNextSlot);
                    } else {
                        publishChargingState(false);
                    }
                }, msUntilEnd);

                const minutesUntil = Math.round(msUntilEnd / 60000);
                node.log(`Slot end timer set for ${minutesUntil} min (${slot.end})`);
            }
        }

        // Main timer setup - called on each poll
        function setupChargingTimers(slots) {
            // Clear existing timers
            clearChargingTimers();

            // Cache slots for later use
            cachedSlots = slots;

            const now = new Date();

            // Check if currently in a charging slot
            const activeSlot = slots.find(s => {
                const start = new Date(s.start);
                const end = new Date(s.end);
                return start <= now && end > now;
            });

            if (activeSlot) {
                // Currently charging
                const newState = true;
                if (chargingNow !== newState) {
                    publishChargingState(newState);
                }
                setupSlotEndTimer(activeSlot);
                node.log("Currently charging - end timer set");
            } else {
                // Not currently charging
                const newState = false;
                if (chargingNow !== newState) {
                    publishChargingState(newState);
                }

                // Find next future slot
                const nextSlot = slots.find(s => new Date(s.start) > now);

                if (nextSlot) {
                    setupPreValidationTimer(nextSlot);
                    node.log(`Next slot at ${nextSlot.start}`);
                }
            }
        }

        // 7. Event Listeners

        // Helper: Publish current state (both pending and confirmed)
        // This merges pending values into last known full state to prevent sensors going unknown
        function publishCurrentState() {
            if (enableMqtt && node.broker) {
                // Merge pending values into last known state
                const fullState = {
                    ...lastKnownState,
                    pending_limit: pendingLimit,
                    pending_time: pendingTime,
                    confirmed_limit: confirmedLimit,
                    confirmed_time: confirmedTime
                };
                node.broker.client.publish(stateTopic, JSON.stringify(fullState), { retain: false });
            }
        }

        // A. Handle Node-RED Input Messages (NO rate limiting - programmers control this)
        node.on('input', function (msg) {
            // Check for control commands (preference updates)
            if (msg.payload && typeof msg.payload === 'object') {
                if (msg.payload.set_limit || msg.payload.set_time) {
                    // Use new values if present, otherwise keep existing
                    const targetLimit = msg.payload.set_limit || confirmedLimit;
                    const targetTime = msg.payload.set_time || confirmedTime;
                    setPreferences(targetLimit, targetTime);
                    return; // Don't run standard fetch if setting
                }
                if (msg.payload.set_timezone !== undefined) {
                    const tz = msg.payload.set_timezone;
                    if (typeof tz === 'string' && tz.trim().length > 0) {
                        node.context().set('timezone', tz.trim());
                        node.log(`Timezone set to: ${tz.trim()}`);
                    }
                    return;
                }
                if (msg.payload.set_smart_charging !== undefined) {
                    const val = msg.payload.set_smart_charging;
                    if (typeof val === 'boolean') {
                        setSmartCharging(val);
                    }
                    // silently ignore non-boolean (consistent with other handlers)
                    return;
                }
            }

            // Manual refresh request from Node-RED - NO rate limiting
            // (Programmers can control rate limiting in their flows if needed)
            // Update timestamp so HA sees cooldown, but don't block the refresh
            lastManualRefresh = Date.now();
            node.status({ fill: "yellow", shape: "ring", text: "Manual refresh..." });
            fetchData();
        });

        // B. Handle MQTT Commands (Home Assistant)
        if (enableMqtt && node.broker) {
            node.broker.register(this);

            // Slider changed - update pending value only
            node.broker.subscribe(cmdTopicLimit, 0, (topic, payload) => {
                const val = parseInt(payload.toString());
                pendingLimit = val;
                publishCurrentState(); // Update display immediately
                node.status({ fill: "yellow", shape: "dot", text: `Pending: ${pendingLimit}% @ ${pendingTime}` });
            });

            // Dropdown changed - update pending value only
            node.broker.subscribe(cmdTopicTime, 0, (topic, payload) => {
                const val = payload.toString();
                pendingTime = val;
                publishCurrentState(); // Update display immediately
                node.status({ fill: "yellow", shape: "dot", text: `Pending: ${pendingLimit}% @ ${pendingTime}` });
            });

            // Button pressed - submit changes to API
            node.broker.subscribe(cmdTopicSubmit, 0, (topic, payload) => {
                setPreferences(pendingLimit, pendingTime);
            });

            // Refresh button pressed - MQTT has hardcoded 30s rate limiting
            node.broker.subscribe(cmdTopicRefresh, 0, (topic, payload) => {
                // Check rate limit (only for MQTT button)
                if (!canManualRefresh()) {
                    const secondsRemaining = getSecondsUntilNextRefresh();
                    node.status({
                        fill: "red",
                        shape: "dot",
                        text: `Cooldown: ${secondsRemaining}s`
                    });
                    node.warn(`MQTT refresh blocked. Please wait ${secondsRemaining} seconds.`);
                    return;  // Block the refresh
                }

                // Refresh allowed - set cooldown timestamp
                lastManualRefresh = Date.now();

                // Publish immediate update with countdown timestamp
                publishRefreshCooldownState();

                // Schedule cleanup at exactly 30 seconds to clear countdown
                if (cooldownExpiryTimer) clearTimeout(cooldownExpiryTimer);
                cooldownExpiryTimer = setTimeout(() => {
                    // Cooldown expired - publish null to clear countdown in HA
                    publishRefreshCooldownState();
                    cooldownExpiryTimer = null;
                }, MANUAL_REFRESH_COOLDOWN);

                // Trigger the actual refresh
                node.status({ fill: "yellow", shape: "ring", text: "Manual refresh..." });
                fetchData();
            });

            // Timezone select changed in Home Assistant
            node.broker.subscribe(cmdTopicTimezone, 0, (topic, payload) => {
                const tz = payload.toString().trim();
                if (tz.length > 0) {
                    node.context().set('timezone', tz);
                    node.log(`Timezone set via MQTT to: ${tz}`);
                    node.broker.client.publish(`${stateTopic}/timezone`, tz, { retain: true });
                }
            });

            // Smart charging switch toggled in Home Assistant
            node.broker.subscribe(cmdTopicSmartCharging, 0, (topic, payload) => {
                const val = payload.toString().trim();
                if (val === "ON") setSmartCharging(true);
                else if (val === "OFF") setSmartCharging(false);
            });

            setTimeout(announceControls, 2000);

            // Republish persisted timezone to HA select on startup
            setTimeout(() => {
                try {
                    const persistedTz = node.context().get('timezone');
                    if (persistedTz && node.broker) {
                        node.broker.client.publish(`${stateTopic}/timezone`, persistedTz, { retain: true });
                    }
                } catch (e) { node.warn('Failed to republish timezone on startup: ' + e.message); }
            }, 2500);

            // Republish smart charging state to HA switch on startup (after fetchDeviceId runs at 1500ms)
            setTimeout(() => {
                try {
                    if (smartChargingSuspended !== null && node.broker && node.broker.client) {
                        const stateVal = smartChargingSuspended ? "OFF" : "ON";
                        node.broker.client.publish(`${stateTopic}/smart_charging`, stateVal, { retain: true });
                    }
                } catch (e) { node.warn('Failed to republish smart charging state on startup: ' + e.message); }
            }, 3000);
        }

        // Init
        pollIntervalHandle = setInterval(fetchData, refreshRate);
        updateNextPollTime();  // Set initial next poll time
        setTimeout(fetchData, 1000);
        setTimeout(fetchDeviceId, 1500);

        // V2 category discovery and scheduler
        setTimeout(async () => {
            try {
                const discovered = await discoverProducts(apiKey, account);
                if (discovered.deviceSuspended !== null && discovered.deviceSuspended !== undefined) {
                    smartChargingSuspended = discovered.deviceSuspended;
                    lastKnownState = mergePayload(lastKnownState, { smart_charging: !discovered.deviceSuspended });
                }
                await initCategories(discovered);
                node.log(`V2 discovery: electricity=${discovered.hasElectricity}, gas=${discovered.hasGas}, intelligent=${discovered.hasIntelligent}, suspended=${discovered.deviceSuspended}`);
                const v2Scheduler = createScheduler(pollDueCategories);
                v2Scheduler.start();
                node._v2Scheduler = v2Scheduler;
            } catch (e) {
                node.warn(`V2 discovery failed: ${e.message}. New categories unavailable.`);
            }
        }, 2000);

        node.on('close', () => {
            clearInterval(pollIntervalHandle);
            // Clear any pending retry timeouts
            retryTimeouts.forEach(timeout => clearTimeout(timeout));
            retryTimeouts = [];
            // Clear smart charging retry timeouts
            smartChargingRetryTimeouts.forEach(t => clearTimeout(t));
            smartChargingRetryTimeouts = [];
            // Clear charging timers
            clearChargingTimers();
            // Clear cooldown expiry timer
            if (cooldownExpiryTimer) {
                clearTimeout(cooldownExpiryTimer);
                cooldownExpiryTimer = null;
            }
            if (node._v2Scheduler) node._v2Scheduler.stop();
            if (node.broker) node.broker.unsubscribe(cmdTopicLimit, cmdTopicTime, cmdTopicSubmit, cmdTopicRefresh, cmdTopicTimezone, cmdTopicSmartCharging);
        });
    }

    RED.nodes.registerType("octopus-intelligent", OctopusIntelligentNode, {
        credentials: { apiKey: { type: "password" } }
    });
};