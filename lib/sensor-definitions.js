'use strict';

// Sensor Definitions (Read-Only)
// category: undefined = main, 'config' = Configuration, 'diagnostic' = Diagnostics
//
// NOTE: entries here must never carry category: 'config' — that HA entity_category
// means "user-configurable setting", and every sensor below is a read-only value
// reported from the Kraken API. Writable command entities (timezone select,
// smart-charging switch) are defined separately in octopus-intelligent.js, not here.
// Getting this wrong sticks the entity at "unavailable" on some HA Core versions and
// outright blocks registration on newer ones. Fixed for tariff codes in v1.3.0, for
// Octoplus binary sensors shortly after, and for the day/night/EV rate-band sensors
// below in v1.6.1.
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
    // --- Electricity (main) ---
    { id: 'electricity_unit_rate',          name: 'Electricity Unit Rate',        unit: 'p/kWh', icon: 'mdi:flash',                    val: 'electricity_unit_rate' },
    { id: 'electricity_day_rate',         name: 'Electricity Day Rate',         unit: 'p/kWh', icon: 'mdi:weather-sunny',        val: 'electricity_day_rate' },
    { id: 'electricity_night_rate',       name: 'Electricity Night Rate',       unit: 'p/kWh', icon: 'mdi:weather-night',        val: 'electricity_night_rate' },
    { id: 'electricity_ev_peak_rate',     name: 'Electricity EV Peak Rate',     unit: 'p/kWh', icon: 'mdi:car-electric-outline', val: 'electricity_ev_peak_rate' },
    { id: 'electricity_ev_off_peak_rate', name: 'Electricity EV Off-Peak Rate', unit: 'p/kWh', icon: 'mdi:car-electric',         val: 'electricity_ev_off_peak_rate' },
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
    // --- Electricity Export (main) ---
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
    { id: 'electricity_export_rate_prev_gbp',    name: 'Electricity Export Rate Prev (GBP)', unit: 'GBP/kWh', icon: 'mdi:cash-clock', val: 'electricity_export_rate_prev_gbp', stateClass: 'measurement', category: 'diagnostic' },
    { id: 'electricity_export_rate_next_gbp',    name: 'Electricity Export Rate Next (GBP)', unit: 'GBP/kWh', icon: 'mdi:cash-clock', val: 'electricity_export_rate_next_gbp', stateClass: 'measurement', category: 'diagnostic' },
    { id: 'electricity_export_rate_error',       name: 'Electricity Export Rate Error',       icon: 'mdi:alert-circle', val: 'electricity_export_rate_error', category: 'diagnostic' },

    // --- Gas (main) ---
    { id: 'gas_standing_charge',    name: 'Gas Standing Charge',  unit: 'p/day', icon: 'mdi:cash',              val: 'gas_standing_charge' },
    { id: 'gas_consumption_kwh',    name: 'Gas Consumption',      unit: 'kWh',   class: 'energy',               val: 'gas_consumption_kwh' },
    // --- Gas (main) ---
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
    { id: 'applicable_rates_prev_pence',         name: 'Applicable Rate Prev',        unit: 'p/kWh',    icon: 'mdi:cash-clock',     val: 'applicable_rates_prev_pence',         category: 'diagnostic' },
    { id: 'applicable_rates_prev_gbp',           name: 'Applicable Rate Prev (GBP)',  unit: 'GBP/kWh',  icon: 'mdi:cash-clock',     val: 'applicable_rates_prev_gbp', stateClass: 'measurement', category: 'diagnostic' },
    { id: 'applicable_rates_prev_to',            name: 'Applicable Rate Prev Ends',   class: 'timestamp', icon: 'mdi:calendar-clock', val: 'applicable_rates_prev_to',           category: 'diagnostic' },
    { id: 'applicable_rates_next_pence',         name: 'Applicable Rate Next',        unit: 'p/kWh',    icon: 'mdi:cash-clock',     val: 'applicable_rates_next_pence',         category: 'diagnostic' },
    { id: 'applicable_rates_next_gbp',           name: 'Applicable Rate Next (GBP)',  unit: 'GBP/kWh',  icon: 'mdi:cash-clock',     val: 'applicable_rates_next_gbp', stateClass: 'measurement', category: 'diagnostic' },
    { id: 'applicable_rates_next_from',          name: 'Applicable Rate Next From',   class: 'timestamp', icon: 'mdi:calendar-clock', val: 'applicable_rates_next_from',         category: 'diagnostic' },
    // Applicable rates — 24h schedule stats (v1.5)
    { id: 'applicable_rates_min_pence',           name: 'Applicable Rates Min',     unit: 'p/kWh', icon: 'mdi:arrow-down',         val: 'applicable_rates_min_pence',    category: 'diagnostic' },
    { id: 'applicable_rates_max_pence',           name: 'Applicable Rates Max',     unit: 'p/kWh', icon: 'mdi:arrow-up',           val: 'applicable_rates_max_pence',    category: 'diagnostic' },
    { id: 'applicable_rates_median_pence',        name: 'Applicable Rates Median',  unit: 'p/kWh', icon: 'mdi:approximately-equal', val: 'applicable_rates_median_pence', category: 'diagnostic' },
    { id: 'applicable_rates_avg_pence',           name: 'Applicable Rates Avg',     unit: 'p/kWh', icon: 'mdi:chart-line',         val: 'applicable_rates_avg_pence',    category: 'diagnostic' },
    { id: 'electricity_export_rate_min_pence',    name: 'Electricity Export Rate Min',    unit: 'p/kWh', icon: 'mdi:arrow-down',         val: 'electricity_export_rate_min_pence',    category: 'diagnostic' },
    { id: 'electricity_export_rate_max_pence',    name: 'Electricity Export Rate Max',    unit: 'p/kWh', icon: 'mdi:arrow-up',           val: 'electricity_export_rate_max_pence',    category: 'diagnostic' },
    { id: 'electricity_export_rate_median_pence', name: 'Electricity Export Rate Median', unit: 'p/kWh', icon: 'mdi:approximately-equal', val: 'electricity_export_rate_median_pence', category: 'diagnostic' },
    { id: 'electricity_export_rate_avg_pence',    name: 'Electricity Export Rate Avg',    unit: 'p/kWh', icon: 'mdi:chart-line',         val: 'electricity_export_rate_avg_pence',    category: 'diagnostic' },

    // --- Account (main) ---
    { id: 'account_balance_pounds', name: 'Account Balance',        unit: '£',  icon: 'mdi:cash-multiple', val: 'account_balance_pounds' },
    // --- Account (diagnostic) ---
    { id: 'account_balance_pence',  name: 'Account Balance (Pence)', unit: 'p', icon: 'mdi:cash',          val: 'account_balance_pence',  category: 'diagnostic' },
    { id: 'account_error',          name: 'Account Error',                      icon: 'mdi:alert-circle',  val: 'account_error',          category: 'diagnostic' },

    // --- Octoplus (main) ---
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
    // --- Saving Sessions (main) ---
    { id: 'saving_session_start', name: 'Saving Session Start', class: 'timestamp', icon: 'mdi:calendar-clock', val: 'saving_session_start' },
    { id: 'saving_session_end',   name: 'Saving Session End',   class: 'timestamp', icon: 'mdi:calendar-clock', val: 'saving_session_end' },
    // --- Saving Sessions (diagnostic) ---
    { id: 'saving_sessions_error', name: 'Saving Sessions Error', icon: 'mdi:alert-circle', val: 'saving_sessions_error', category: 'diagnostic' },

    // --- Free Electricity (main) ---
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

    // v1.5 — update check (the MQTT update entity is published in announceControls())
    { id: 'installed_version',  name: 'Installed Version',  icon: 'mdi:package-variant',             val: 'installed_version',  category: 'diagnostic' },
    { id: 'latest_version',     name: 'Latest Version',     icon: 'mdi:package-variant-closed-plus', val: 'latest_version',     category: 'diagnostic' },
    { id: 'update_check_at',    name: 'Update Check At',    class: 'timestamp', icon: 'mdi:clock-check-outline', val: 'update_check_at',    category: 'diagnostic' },
    { id: 'update_check_error', name: 'Update Check Error', icon: 'mdi:alert-circle',                val: 'update_check_error', category: 'diagnostic' },
];

// v1.5 — derived binary_sensors for the unified <category>_error fields.
// OFF when the underlying field is null/empty (healthy), ON when populated.
// The string sensors stay; these are additional indicators.
const errorSensors = [
    { id: 'intelligent_error_state',             name: 'Intelligent Error State',             val: 'intelligent_error' },
    { id: 'electricity_rates_error_state',       name: 'Electricity Rates Error State',       val: 'electricity_rates_error' },
    { id: 'electricity_consumption_error_state', name: 'Electricity Consumption Error State', val: 'electricity_consumption_error' },
    { id: 'electricity_export_rate_error_state', name: 'Electricity Export Rate Error State', val: 'electricity_export_rate_error' },
    { id: 'gas_rates_error_state',               name: 'Gas Rates Error State',               val: 'gas_rates_error' },
    { id: 'gas_consumption_error_state',         name: 'Gas Consumption Error State',         val: 'gas_consumption_error' },
    { id: 'applicable_rates_error_state',        name: 'Applicable Rates Error State',        val: 'applicable_rates_error' },
    { id: 'account_error_state',                 name: 'Account Error State',                 val: 'account_error' },
    { id: 'octoplus_error_state',                name: 'Octoplus Error State',                val: 'octoplus_error' },
    { id: 'wheel_of_fortune_error_state',        name: 'Wheel of Fortune Error State',        val: 'wheel_of_fortune_error' },
    { id: 'home_mini_error_state',               name: 'Home Mini Error State',               val: 'home_mini_error' },
    { id: 'saving_sessions_error_state',         name: 'Saving Sessions Error State',         val: 'saving_sessions_error' },
    { id: 'free_electricity_error_state',        name: 'Free Electricity Error State',        val: 'free_electricity_error' },
    { id: 'completed_dispatches_error_state',    name: 'Completed Dispatches Error State',    val: 'completed_dispatches_error' },
    { id: 'flex_planned_dispatches_error_state', name: 'Flex Planned Dispatches Error State', val: 'flex_planned_dispatches_error' },
];

// v1.7.0 — SmartFlex vehicle / charge point sensors. Kept out of `sensors` because they are
// only announced when product discovery finds a vehicle or charge point; otherwise their
// discovery topics are cleared. Names are frozen into HA entity_ids at first discovery:
// never rename these. The last-session problem flag is a boolean, so it is a binary_sensor
// in octopus-intelligent.js.
// nullUnavailable: a text sensor whose null value should read Unavailable in Home Assistant,
// not the text "None" (review L1). Error text sensors keep "None" for healthy, as before.
const vehicleSensors = [
    // state_class total: last_reset is the session end (octopus-intelligent.js), so each new
    // finished session adds its kWh to the long-term statistics once (review L2).
    { id: 'last_session_kwh',        name: 'Last Charge Session Energy',       unit: 'kWh', class: 'energy',  stateClass: 'total', icon: 'mdi:ev-station', val: 'last_session_kwh' },
    // No device_class (review L5): battery would feed low-battery alerts and the device's
    // battery display with a value that is only the charge at the end of the last session.
    { id: 'last_session_soc_final',  name: 'Last Charge Session Final Charge', unit: '%',   stateClass: 'measurement', icon: 'mdi:battery-charging', val: 'last_session_soc_final' },
    { id: 'vehicle_make',            name: 'Vehicle Make',                                  icon: 'mdi:car-info',      val: 'vehicle_make',            category: 'diagnostic', nullUnavailable: true },
    { id: 'vehicle_model',           name: 'Vehicle Model',                                 icon: 'mdi:car-info',      val: 'vehicle_model',           category: 'diagnostic', nullUnavailable: true },
    { id: 'vehicle_battery_kwh',     name: 'Vehicle Battery Size',             unit: 'kWh', class: 'energy_storage', icon: 'mdi:car-battery', val: 'vehicle_battery_kwh', category: 'diagnostic' },
    { id: 'charger_power_kw',        name: 'Charger Power',                    unit: 'kW',  class: 'power', icon: 'mdi:ev-plug-type2', val: 'charger_power_kw', category: 'diagnostic' },
    { id: 'vehicle_device_state',    name: 'Vehicle Device State',                          icon: 'mdi:car-connected', val: 'device_state',            category: 'diagnostic', nullUnavailable: true },
    { id: 'smartflex_vehicle_error', name: 'SmartFlex Vehicle Error',                       icon: 'mdi:alert-circle',  val: 'smartflex_vehicle_error', category: 'diagnostic' },
];

const vehicleErrorSensors = [
    { id: 'smartflex_vehicle_error_state', name: 'SmartFlex Vehicle Error State', val: 'smartflex_vehicle_error' },
];

// v1.7.0 — SmartFlex inverter sensors, EXPERIMENTAL (not yet verified on a real inverter).
// Kept out of `sensors` because they are only announced when the editor option
// enableSmartflexInverter is ticked AND discovery finds an inverter; otherwise their
// discovery topics are cleared.
// inverter_online is a boolean, so it is a binary_sensor in octopus-intelligent.js.
const inverterSensors = [
    { id: 'solar_power_kw',             name: 'Solar Power',                unit: 'kW', class: 'power',   stateClass: 'measurement', icon: 'mdi:solar-power',               val: 'solar_power_kw' },
    { id: 'home_battery_power_kw',      name: 'Home Battery Power',         unit: 'kW', class: 'power',   stateClass: 'measurement', icon: 'mdi:home-battery',              val: 'home_battery_power_kw' },
    { id: 'home_battery_soc',           name: 'Home Battery Charge',        unit: '%',  class: 'battery', stateClass: 'measurement',                                    val: 'home_battery_soc' },
    { id: 'grid_power_kw',              name: 'Grid Power',                 unit: 'kW', class: 'power',   stateClass: 'measurement', icon: 'mdi:transmission-tower',        val: 'grid_power_kw' },
    { id: 'site_consumption_kw',        name: 'Site Consumption',           unit: 'kW', class: 'power',   stateClass: 'measurement', icon: 'mdi:home-lightning-bolt',       val: 'site_consumption_kw' },
    { id: 'site_export_kw',             name: 'Site Export',                unit: 'kW', class: 'power',   stateClass: 'measurement', icon: 'mdi:transmission-tower-export', val: 'site_export_kw' },
    { id: 'inverter_power_kw',          name: 'Inverter Power',             unit: 'kW', class: 'power',   stateClass: 'measurement', icon: 'mdi:solar-power-variant',       val: 'inverter_power_kw' },
    { id: 'inverter_make',              name: 'Inverter Make',                                                                   icon: 'mdi:information-outline',       val: 'inverter_make',              category: 'diagnostic', nullUnavailable: true },
    { id: 'inverter_model',             name: 'Inverter Model',                                                                  icon: 'mdi:information-outline',       val: 'inverter_model',             category: 'diagnostic', nullUnavailable: true },
    { id: 'solar_peak_kw',              name: 'Solar Peak Power',           unit: 'kW', class: 'power',                              icon: 'mdi:solar-panel-large',         val: 'solar_peak_kw',              category: 'diagnostic' },
    { id: 'inverter_connection_status', name: 'Inverter Connection Status',                                                      icon: 'mdi:lan-connect',               val: 'inverter_connection_status', category: 'diagnostic', nullUnavailable: true },
    { id: 'smartflex_inverter_error',   name: 'SmartFlex Inverter Error',                                                        icon: 'mdi:alert-circle',              val: 'smartflex_inverter_error',   category: 'diagnostic' },
];

const inverterErrorSensors = [
    { id: 'smartflex_inverter_error_state', name: 'SmartFlex Inverter Error State', val: 'smartflex_inverter_error' },
];

module.exports = { sensors, errorSensors, vehicleSensors, vehicleErrorSensors, inverterSensors, inverterErrorSensors };
