#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cassert>
#include <chrono>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <string>

#include "scssdk_telemetry.h"
#include "amtrucks/scssdk_ats.h"
#include "amtrucks/scssdk_telemetry_ats.h"
#include "common/scssdk_telemetry_common_channels.h"
#include "common/scssdk_telemetry_common_configs.h"
#include "common/scssdk_telemetry_trailer_common_channels.h"
#include "common/scssdk_telemetry_truck_common_channels.h"
#include "eurotrucks2/scssdk_eut2.h"
#include "eurotrucks2/scssdk_telemetry_eut2.h"

namespace {

constexpr const char *kBridgeHost = "127.0.0.1";
constexpr int kBridgePort = 30002;
constexpr int kSendIntervalMs = 100;

scs_log_t game_log = nullptr;
int udp_socket_fd = -1;
sockaddr_in bridge_address {};
auto last_send = std::chrono::steady_clock::time_point {};

struct TruckConfig {
    float fuel_capacity = 0.0f;
    std::string brand;
    std::string name;
};

struct JobConfig {
    bool active = false;
    bool cargo_loaded = false;
    bool special_job = false;
    std::string job_market;
    std::string cargo_name;
    float cargo_mass = 0.0f;
    float cargo_damage = 0.0f;
    std::string destination_city_id;
    std::string destination_city;
    std::string destination_company_id;
    std::string destination_company;
    std::string source_city_id;
    std::string source_city;
    std::string source_company_id;
    std::string source_company;
    scs_u64_t income = 0;
    scs_u32_t delivery_time = 0;
};

struct TrailerState {
    bool attached = false;
    float cargo_damage = 0.0f;
    float body_wear = 0.0f;
    float chassis_wear = 0.0f;
    float wheels_wear = 0.0f;
    scs_value_dplacement_t placement {};
};

struct TelemetryState {
    bool paused = true;
    std::string game = "unknown";
    std::string game_version = "0.0";
    float map_scale = 0.0f;
    scs_u32_t game_time = 0;
    scs_s32_t next_rest_stop = 0;

    TruckConfig truck_config;
    scs_value_dplacement_t truck_placement {};
    float truck_speed = 0.0f;
    float truck_rpm = 0.0f;
    scs_s32_t truck_gear = 0;
    bool parking_brake = false;
    float fuel = 0.0f;
    float fuel_average_consumption = 0.0f;
    float fuel_range = 0.0f;
    bool fuel_warning = false;
    float odometer = 0.0f;
    bool light_parking = false;
    bool light_low_beam = false;
    bool light_high_beam = false;
    float wear_engine = 0.0f;
    float wear_transmission = 0.0f;
    float wear_cabin = 0.0f;
    float wear_chassis = 0.0f;
    float wear_wheels = 0.0f;

    float navigation_distance = 0.0f;
    float navigation_time = 0.0f;
    float navigation_speed_limit = 0.0f;

    TrailerState trailer;
    JobConfig job;
};

TelemetryState telemetry;

void log_message(const scs_log_type_t type, const std::string &message) {
    if (game_log) {
        game_log(type, message.c_str());
    }
}

std::string escape_json(const std::string &value) {
    std::ostringstream out;
    for (const char ch : value) {
        switch (ch) {
            case '"':
                out << "\\\"";
                break;
            case '\\':
                out << "\\\\";
                break;
            case '\b':
                out << "\\b";
                break;
            case '\f':
                out << "\\f";
                break;
            case '\n':
                out << "\\n";
                break;
            case '\r':
                out << "\\r";
                break;
            case '\t':
                out << "\\t";
                break;
            default:
                if (static_cast<unsigned char>(ch) < 0x20) {
                    out << "\\u" << std::hex << std::setw(4)
                        << std::setfill('0')
                        << static_cast<int>(static_cast<unsigned char>(ch));
                } else {
                    out << ch;
                }
        }
    }
    return out.str();
}

std::string iso_from_game_minutes(const scs_u32_t minutes) {
    const std::time_t seconds = static_cast<std::time_t>(minutes) * 60;
    std::tm utc {};
    gmtime_r(&seconds, &utc);

    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &utc);
    return buffer;
}

float mps_to_kph(const float speed) {
    return speed * 3.6f;
}

float mps_to_mph(const float speed) {
    return speed * 2.23693629f;
}

std::string build_payload() {
    std::ostringstream json;
    json << std::fixed << std::setprecision(6);

    json << "{";
    json << "\"paused\":" << (telemetry.paused ? "true" : "false") << ",";
    json << "\"game\":\"" << escape_json(telemetry.game) << "\",";
    json << "\"gameVersion\":\"" << escape_json(telemetry.game_version)
         << "\",";
    json << "\"telemetryVersion\":\"scs-sdk-1.01\",";

    json << "\"common\":{";
    json << "\"mapScale\":" << telemetry.map_scale << ",";
    json << "\"gameTime\":\""
         << escape_json(iso_from_game_minutes(telemetry.game_time)) << "\",";
    json << "\"nextRestStopMinutes\":" << telemetry.next_rest_stop;
    json << "},";

    json << "\"truck\":{";
    json << "\"constants\":{";
    json << "\"fuelCapacity\":" << telemetry.truck_config.fuel_capacity << ",";
    json << "\"brand\":\"" << escape_json(telemetry.truck_config.brand)
         << "\",";
    json << "\"name\":\"" << escape_json(telemetry.truck_config.name) << "\"";
    json << "},";
    json << "\"current\":{";
    json << "\"dashboard\":{";
    json << "\"fuelAmount\":" << telemetry.fuel << ",";
    json << "\"averageConsumption\":" << telemetry.fuel_average_consumption
         << ",";
    json << "\"fuelRange\":" << telemetry.fuel_range << ",";
    json << "\"fuelWarning\":" << (telemetry.fuel_warning ? "true" : "false")
         << ",";
    json << "\"currentGear\":" << telemetry.truck_gear << ",";
    json << "\"speedKph\":" << mps_to_kph(telemetry.truck_speed) << ",";
    json << "\"speedMph\":" << mps_to_mph(telemetry.truck_speed) << ",";
    json << "\"cruiseControlSpeedKph\":0,";
    json << "\"cruiseControlSpeedMph\":0,";
    json << "\"cruiseControlActive\":false,";
    json << "\"rpm\":" << telemetry.truck_rpm << ",";
    json << "\"odometer\":" << telemetry.odometer;
    json << "},";
    json << "\"lights\":{";
    json << "\"parking\":" << (telemetry.light_parking ? "true" : "false")
         << ",";
    json << "\"beamLow\":" << (telemetry.light_low_beam ? "true" : "false")
         << ",";
    json << "\"beamHigh\":" << (telemetry.light_high_beam ? "true" : "false");
    json << "},";
    json << "\"damage\":{";
    json << "\"engine\":" << telemetry.wear_engine << ",";
    json << "\"transmission\":" << telemetry.wear_transmission << ",";
    json << "\"cabin\":" << telemetry.wear_cabin << ",";
    json << "\"chassis\":" << telemetry.wear_chassis << ",";
    json << "\"wheels\":" << telemetry.wear_wheels;
    json << "},";
    json << "\"position\":{";
    json << "\"x\":" << telemetry.truck_placement.position.x << ",";
    json << "\"y\":" << telemetry.truck_placement.position.y << ",";
    json << "\"z\":" << telemetry.truck_placement.position.z;
    json << "},";
    json << "\"heading\":" << telemetry.truck_placement.orientation.heading
         << ",";
    json << "\"parkingBrake\":"
         << (telemetry.parking_brake ? "true" : "false");
    json << "},";
    json << "\"positioning\":{}";
    json << "},";

    json << "\"trailers\":[{";
    json << "\"attached\":" << (telemetry.trailer.attached ? "true" : "false")
         << ",";
    json << "\"damage\":{";
    json << "\"cargo\":" << telemetry.trailer.cargo_damage << ",";
    json << "\"wheels\":" << telemetry.trailer.wheels_wear << ",";
    json << "\"chassis\":" << telemetry.trailer.chassis_wear;
    json << "},";
    json << "\"position\":{";
    json << "\"x\":" << telemetry.trailer.placement.position.x << ",";
    json << "\"y\":" << telemetry.trailer.placement.position.y << ",";
    json << "\"z\":" << telemetry.trailer.placement.position.z;
    json << "},";
    json << "\"heading\":" << telemetry.trailer.placement.orientation.heading
         << ",";
    json << "\"brand\":\"\",";
    json << "\"name\":\"\"";
    json << "}],";

    json << "\"job\":{";
    json << "\"remainingDeliveryTime\":\""
         << escape_json(iso_from_game_minutes(telemetry.job.delivery_time))
         << "\",";
    json << "\"cargoLoaded\":"
         << (telemetry.job.cargo_loaded ? "true" : "false") << ",";
    json << "\"specialJob\":"
         << (telemetry.job.special_job ? "true" : "false") << ",";
    json << "\"jobType\":\"" << escape_json(telemetry.job.job_market)
         << "\",";
    json << "\"cargo\":{";
    json << "\"mass\":" << telemetry.job.cargo_mass << ",";
    json << "\"name\":\"" << escape_json(telemetry.job.cargo_name) << "\",";
    json << "\"cargoDamage\":" << telemetry.job.cargo_damage;
    json << "},";
    json << "\"cityDestinationId\":\""
         << escape_json(telemetry.job.destination_city_id) << "\",";
    json << "\"cityDestination\":\""
         << escape_json(telemetry.job.destination_city) << "\",";
    json << "\"companyDestinationId\":\""
         << escape_json(telemetry.job.destination_company_id) << "\",";
    json << "\"companyDestination\":\""
         << escape_json(telemetry.job.destination_company) << "\",";
    json << "\"citySourceId\":\"" << escape_json(telemetry.job.source_city_id)
         << "\",";
    json << "\"citySource\":\"" << escape_json(telemetry.job.source_city)
         << "\",";
    json << "\"companySourceId\":\""
         << escape_json(telemetry.job.source_company_id) << "\",";
    json << "\"companySource\":\""
         << escape_json(telemetry.job.source_company) << "\",";
    json << "\"income\":" << telemetry.job.income;
    json << "},";

    json << "\"navigation\":{";
    json << "\"distance\":" << telemetry.navigation_distance << ",";
    json << "\"time\":" << telemetry.navigation_time << ",";
    json << "\"speedLimitKph\":"
         << mps_to_kph(telemetry.navigation_speed_limit) << ",";
    json << "\"speedLimitMph\":"
         << mps_to_mph(telemetry.navigation_speed_limit);
    json << "},";

    json << "\"specialEvents\":{";
    json << "\"onJob\":" << (telemetry.job.active ? "true" : "false")
         << ",";
    json << "\"jobCancelled\":false,";
    json << "\"jobDelivered\":false,";
    json << "\"fined\":false,";
    json << "\"tollgate\":false,";
    json << "\"ferry\":false,";
    json << "\"train\":false";
    json << "},";

    json << "\"gamePlayEvents\":{";
    json << "\"ferryData\":{\"payAmount\":0,\"sourceName\":\"\",\"targetName\":\"\"},";
    json << "\"finedData\":{\"payAmount\":0,\"offence\":\"\"},";
    json << "\"jobCancelledPenalty\":0,";
    json << "\"jobDelivered\":{\"autoLoaded\":false,\"autoParker\":false,\"cargoDamage\":0,\"deliveryTime\":\"1970-01-01T00:00:00Z\",\"distanceKm\":0,\"earnedXp\":0,\"revenue\":0},";
    json << "\"tollgatePayment\":0,";
    json << "\"trainData\":{\"payAmount\":0,\"sourceName\":\"\",\"targetName\":\"\"}";
    json << "}";
    json << "}";

    return json.str();
}

void open_udp_socket() {
    if (udp_socket_fd >= 0) return;

    udp_socket_fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (udp_socket_fd < 0) {
        log_message(SCS_LOG_TYPE_error, "TruckNav: failed to open UDP socket");
        return;
    }

    bridge_address.sin_family = AF_INET;
    bridge_address.sin_port = htons(kBridgePort);
    inet_pton(AF_INET, kBridgeHost, &bridge_address.sin_addr);
}

void close_udp_socket() {
    if (udp_socket_fd >= 0) {
        close(udp_socket_fd);
        udp_socket_fd = -1;
    }
}

void send_payload(const bool force = false) {
    const auto now = std::chrono::steady_clock::now();
    if (!force && last_send.time_since_epoch().count() != 0) {
        const auto elapsed =
            std::chrono::duration_cast<std::chrono::milliseconds>(
                now - last_send
            );
        if (elapsed.count() < kSendIntervalMs) return;
    }

    open_udp_socket();
    if (udp_socket_fd < 0) return;

    const std::string payload = build_payload();
    sendto(
        udp_socket_fd,
        payload.c_str(),
        payload.size(),
        0,
        reinterpret_cast<sockaddr *>(&bridge_address),
        sizeof(bridge_address)
    );
    last_send = now;
}

const scs_named_value_t *find_attribute(
    const scs_telemetry_configuration_t &configuration,
    const char *name,
    const scs_value_type_t type
) {
    for (const scs_named_value_t *current = configuration.attributes;
         current && current->name;
         ++current) {
        if (current->index != SCS_U32_NIL) continue;
        if (std::string(current->name) != name) continue;
        if (current->value.type == type) return current;
        return nullptr;
    }
    return nullptr;
}

std::string get_string_attribute(
    const scs_telemetry_configuration_t &configuration,
    const char *name
) {
    const scs_named_value_t *attribute =
        find_attribute(configuration, name, SCS_VALUE_TYPE_string);
    if (!attribute || !attribute->value.value_string.value) return "";
    return attribute->value.value_string.value;
}

float get_float_attribute(
    const scs_telemetry_configuration_t &configuration,
    const char *name
) {
    const scs_named_value_t *attribute =
        find_attribute(configuration, name, SCS_VALUE_TYPE_float);
    return attribute ? attribute->value.value_float.value : 0.0f;
}

bool get_bool_attribute(
    const scs_telemetry_configuration_t &configuration,
    const char *name
) {
    const scs_named_value_t *attribute =
        find_attribute(configuration, name, SCS_VALUE_TYPE_bool);
    return attribute ? attribute->value.value_bool.value : false;
}

scs_u32_t get_u32_attribute(
    const scs_telemetry_configuration_t &configuration,
    const char *name
) {
    const scs_named_value_t *attribute =
        find_attribute(configuration, name, SCS_VALUE_TYPE_u32);
    return attribute ? attribute->value.value_u32.value : 0;
}

scs_u64_t get_u64_attribute(
    const scs_telemetry_configuration_t &configuration,
    const char *name
) {
    const scs_named_value_t *attribute =
        find_attribute(configuration, name, SCS_VALUE_TYPE_u64);
    return attribute ? attribute->value.value_u64.value : 0;
}

SCSAPI_VOID telemetry_frame_end(
    const scs_event_t,
    const void *,
    const scs_context_t
) {
    send_payload(false);
}

SCSAPI_VOID telemetry_pause(
    const scs_event_t event,
    const void *,
    const scs_context_t
) {
    telemetry.paused = event == SCS_TELEMETRY_EVENT_paused;
    send_payload(true);
}

SCSAPI_VOID telemetry_configuration(
    const scs_event_t,
    const void *event_info,
    const scs_context_t
) {
    const auto *info =
        static_cast<const scs_telemetry_configuration_t *>(event_info);
    if (!info || !info->id) return;

    if (std::string(info->id) == SCS_TELEMETRY_CONFIG_truck) {
        telemetry.truck_config.fuel_capacity =
            get_float_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_fuel_capacity);
        telemetry.truck_config.brand =
            get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand);
        telemetry.truck_config.name =
            get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_name);
    }

    if (std::string(info->id) == SCS_TELEMETRY_CONFIG_job) {
        telemetry.job = JobConfig {};
        telemetry.job.active = info->attributes && info->attributes->name;
        if (telemetry.job.active) {
            telemetry.job.cargo_loaded =
                get_bool_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_is_cargo_loaded);
            telemetry.job.special_job =
                get_bool_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_special_job);
            telemetry.job.job_market =
                get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_job_market);
            telemetry.job.cargo_name =
                get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo);
            telemetry.job.cargo_mass =
                get_float_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_mass);
            telemetry.job.destination_city_id =
                get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city_id);
            telemetry.job.destination_city =
                get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city);
            telemetry.job.destination_company_id =
                get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_company_id);
            telemetry.job.destination_company =
                get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_company);
            telemetry.job.source_city_id =
                get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_city_id);
            telemetry.job.source_city =
                get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_city);
            telemetry.job.source_company_id =
                get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_company_id);
            telemetry.job.source_company =
                get_string_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_company);
            telemetry.job.income =
                get_u64_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_income);
            telemetry.job.delivery_time =
                get_u32_attribute(*info, SCS_TELEMETRY_CONFIG_ATTRIBUTE_delivery_time);
        }
    }

    send_payload(true);
}

SCSAPI_VOID store_float(
    const scs_string_t,
    const scs_u32_t,
    const scs_value_t *value,
    const scs_context_t context
) {
    if (!value || value->type != SCS_VALUE_TYPE_float || !context) return;
    *static_cast<float *>(context) = value->value_float.value;
}

SCSAPI_VOID store_bool(
    const scs_string_t,
    const scs_u32_t,
    const scs_value_t *value,
    const scs_context_t context
) {
    if (!value || value->type != SCS_VALUE_TYPE_bool || !context) return;
    *static_cast<bool *>(context) = value->value_bool.value;
}

SCSAPI_VOID store_s32(
    const scs_string_t,
    const scs_u32_t,
    const scs_value_t *value,
    const scs_context_t context
) {
    if (!value || value->type != SCS_VALUE_TYPE_s32 || !context) return;
    *static_cast<scs_s32_t *>(context) = value->value_s32.value;
}

SCSAPI_VOID store_u32(
    const scs_string_t,
    const scs_u32_t,
    const scs_value_t *value,
    const scs_context_t context
) {
    if (!value || value->type != SCS_VALUE_TYPE_u32 || !context) return;
    *static_cast<scs_u32_t *>(context) = value->value_u32.value;
}

SCSAPI_VOID store_dplacement(
    const scs_string_t,
    const scs_u32_t,
    const scs_value_t *value,
    const scs_context_t context
) {
    if (!value || value->type != SCS_VALUE_TYPE_dplacement || !context) return;
    *static_cast<scs_value_dplacement_t *>(context) =
        value->value_dplacement;
}

void register_float(
    const scs_telemetry_init_params_v101_t *params,
    const char *channel,
    float *target,
    const scs_u32_t flags = SCS_TELEMETRY_CHANNEL_FLAG_none
) {
    params->register_for_channel(
        channel,
        SCS_U32_NIL,
        SCS_VALUE_TYPE_float,
        flags,
        store_float,
        target
    );
}

void register_bool(
    const scs_telemetry_init_params_v101_t *params,
    const char *channel,
    bool *target
) {
    params->register_for_channel(
        channel,
        SCS_U32_NIL,
        SCS_VALUE_TYPE_bool,
        SCS_TELEMETRY_CHANNEL_FLAG_none,
        store_bool,
        target
    );
}

void register_s32(
    const scs_telemetry_init_params_v101_t *params,
    const char *channel,
    scs_s32_t *target
) {
    params->register_for_channel(
        channel,
        SCS_U32_NIL,
        SCS_VALUE_TYPE_s32,
        SCS_TELEMETRY_CHANNEL_FLAG_none,
        store_s32,
        target
    );
}

void register_u32(
    const scs_telemetry_init_params_v101_t *params,
    const char *channel,
    scs_u32_t *target
) {
    params->register_for_channel(
        channel,
        SCS_U32_NIL,
        SCS_VALUE_TYPE_u32,
        SCS_TELEMETRY_CHANNEL_FLAG_none,
        store_u32,
        target
    );
}

void register_dplacement(
    const scs_telemetry_init_params_v101_t *params,
    const char *channel,
    scs_value_dplacement_t *target,
    const scs_u32_t flags = SCS_TELEMETRY_CHANNEL_FLAG_none
) {
    params->register_for_channel(
        channel,
        SCS_U32_NIL,
        SCS_VALUE_TYPE_dplacement,
        flags,
        store_dplacement,
        target
    );
}

} // namespace

SCSAPI_RESULT scs_telemetry_init(
    const scs_u32_t version,
    const scs_telemetry_init_params_t *const params
) {
    if (version != SCS_TELEMETRY_VERSION_1_01) {
        return SCS_RESULT_unsupported;
    }

    const auto *version_params =
        static_cast<const scs_telemetry_init_params_v101_t *>(params);
    game_log = version_params->common.log;

    telemetry = TelemetryState {};
    if (std::string(version_params->common.game_id) == SCS_GAME_ID_EUT2) {
        telemetry.game = "ets2";
    } else if (std::string(version_params->common.game_id) == SCS_GAME_ID_ATS) {
        telemetry.game = "ats";
    } else {
        telemetry.game = version_params->common.game_id;
    }

    telemetry.game_version =
        std::to_string(SCS_GET_MAJOR_VERSION(version_params->common.game_version)) +
        "." +
        std::to_string(SCS_GET_MINOR_VERSION(version_params->common.game_version));

    const bool events_registered =
        version_params->register_for_event(
            SCS_TELEMETRY_EVENT_frame_end,
            telemetry_frame_end,
            nullptr
        ) == SCS_RESULT_ok &&
        version_params->register_for_event(
            SCS_TELEMETRY_EVENT_paused,
            telemetry_pause,
            nullptr
        ) == SCS_RESULT_ok &&
        version_params->register_for_event(
            SCS_TELEMETRY_EVENT_started,
            telemetry_pause,
            nullptr
        ) == SCS_RESULT_ok &&
        version_params->register_for_event(
            SCS_TELEMETRY_EVENT_configuration,
            telemetry_configuration,
            nullptr
        ) == SCS_RESULT_ok;

    if (!events_registered) {
        log_message(SCS_LOG_TYPE_error, "TruckNav: event registration failed");
        return SCS_RESULT_generic_error;
    }

    register_float(version_params, SCS_TELEMETRY_CHANNEL_local_scale, &telemetry.map_scale);
    register_u32(version_params, SCS_TELEMETRY_CHANNEL_game_time, &telemetry.game_time);
    register_s32(version_params, SCS_TELEMETRY_CHANNEL_next_rest_stop, &telemetry.next_rest_stop);

    register_dplacement(
        version_params,
        SCS_TELEMETRY_TRUCK_CHANNEL_world_placement,
        &telemetry.truck_placement,
        SCS_TELEMETRY_CHANNEL_FLAG_each_frame
    );
    register_float(
        version_params,
        SCS_TELEMETRY_TRUCK_CHANNEL_speed,
        &telemetry.truck_speed,
        SCS_TELEMETRY_CHANNEL_FLAG_each_frame
    );
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_engine_rpm, &telemetry.truck_rpm);
    register_s32(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_engine_gear, &telemetry.truck_gear);
    register_bool(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_parking_brake, &telemetry.parking_brake);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_fuel, &telemetry.fuel);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_fuel_average_consumption, &telemetry.fuel_average_consumption);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_fuel_range, &telemetry.fuel_range);
    register_bool(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_fuel_warning, &telemetry.fuel_warning);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_odometer, &telemetry.odometer);
    register_bool(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_light_parking, &telemetry.light_parking);
    register_bool(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_light_low_beam, &telemetry.light_low_beam);
    register_bool(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_light_high_beam, &telemetry.light_high_beam);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_wear_engine, &telemetry.wear_engine);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_wear_transmission, &telemetry.wear_transmission);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_wear_cabin, &telemetry.wear_cabin);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_wear_chassis, &telemetry.wear_chassis);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_wear_wheels, &telemetry.wear_wheels);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_navigation_distance, &telemetry.navigation_distance);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_navigation_time, &telemetry.navigation_time);
    register_float(version_params, SCS_TELEMETRY_TRUCK_CHANNEL_navigation_speed_limit, &telemetry.navigation_speed_limit);

    register_bool(version_params, SCS_TELEMETRY_TRAILER_CHANNEL_connected, &telemetry.trailer.attached);
    register_float(version_params, SCS_TELEMETRY_TRAILER_CHANNEL_cargo_damage, &telemetry.trailer.cargo_damage);
    register_float(version_params, SCS_TELEMETRY_TRAILER_CHANNEL_wear_body, &telemetry.trailer.body_wear);
    register_float(version_params, SCS_TELEMETRY_TRAILER_CHANNEL_wear_chassis, &telemetry.trailer.chassis_wear);
    register_float(version_params, SCS_TELEMETRY_TRAILER_CHANNEL_wear_wheels, &telemetry.trailer.wheels_wear);
    register_dplacement(version_params, SCS_TELEMETRY_TRAILER_CHANNEL_world_placement, &telemetry.trailer.placement);

    open_udp_socket();
    log_message(SCS_LOG_TYPE_message, "TruckNav telemetry plugin initialized");
    send_payload(true);
    return SCS_RESULT_ok;
}

SCSAPI_VOID scs_telemetry_shutdown(void) {
    send_payload(true);
    close_udp_socket();
    game_log = nullptr;
}

void __attribute__((destructor)) unload(void) {
    close_udp_socket();
}
