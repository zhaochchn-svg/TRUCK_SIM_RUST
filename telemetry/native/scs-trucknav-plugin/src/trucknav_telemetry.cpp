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
#include "common/scssdk_telemetry_common_gameplay_events.h"
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

struct TransportEventState {
    scs_s64_t pay_amount = 0;
    std::string source_name;
    std::string target_name;
};

struct FinedEventState {
    scs_s64_t pay_amount = 0;
    std::string offence;
};

struct DeliveredEventState {
    bool auto_loaded = false;
    bool auto_parked = false;
    float cargo_damage = 0.0f;
    scs_u32_t delivery_time = 0;
    float distance_km = 0.0f;
    scs_s32_t earned_xp = 0;
    scs_s64_t revenue = 0;
};

struct GameplayEventState {
    scs_u64_t serial = 0;
    bool job_cancelled = false;
    bool job_delivered = false;
    bool fined = false;
    bool tollgate = false;
    bool ferry = false;
    bool train = false;
    scs_s64_t job_cancelled_penalty = 0;
    scs_s64_t tollgate_payment = 0;
    TransportEventState ferry_data;
    TransportEventState train_data;
    FinedEventState fined_data;
    DeliveredEventState job_delivered_data;
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
    GameplayEventState gameplay;
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

    const auto &gameplay = telemetry.gameplay;

    json << "\"specialEvents\":{";
    json << "\"onJob\":" << (telemetry.job.active ? "true" : "false")
         << ",";
    json << "\"jobCancelled\":"
         << (gameplay.job_cancelled ? "true" : "false") << ",";
    json << "\"jobDelivered\":"
         << (gameplay.job_delivered ? "true" : "false") << ",";
    json << "\"fined\":" << (gameplay.fined ? "true" : "false") << ",";
    json << "\"tollgate\":" << (gameplay.tollgate ? "true" : "false")
         << ",";
    json << "\"ferry\":" << (gameplay.ferry ? "true" : "false") << ",";
    json << "\"train\":" << (gameplay.train ? "true" : "false");
    json << "},";

    json << "\"gamePlayEvents\":{";
    json << "\"eventSerial\":" << gameplay.serial << ",";
    json << "\"ferryData\":{";
    json << "\"payAmount\":" << gameplay.ferry_data.pay_amount << ",";
    json << "\"sourceName\":\""
         << escape_json(gameplay.ferry_data.source_name) << "\",";
    json << "\"targetName\":\""
         << escape_json(gameplay.ferry_data.target_name) << "\"";
    json << "},";
    json << "\"finedData\":{";
    json << "\"payAmount\":" << gameplay.fined_data.pay_amount << ",";
    json << "\"offence\":\"" << escape_json(gameplay.fined_data.offence)
         << "\"";
    json << "},";
    json << "\"jobCancelledPenalty\":"
         << gameplay.job_cancelled_penalty << ",";
    json << "\"jobDelivered\":{";
    json << "\"autoLoaded\":"
         << (gameplay.job_delivered_data.auto_loaded ? "true" : "false")
         << ",";
    json << "\"autoParker\":"
         << (gameplay.job_delivered_data.auto_parked ? "true" : "false")
         << ",";
    json << "\"cargoDamage\":"
         << gameplay.job_delivered_data.cargo_damage << ",";
    json << "\"deliveryTime\":\""
         << escape_json(iso_from_game_minutes(gameplay.job_delivered_data.delivery_time))
         << "\",";
    json << "\"distanceKm\":" << gameplay.job_delivered_data.distance_km
         << ",";
    json << "\"earnedXp\":" << gameplay.job_delivered_data.earned_xp << ",";
    json << "\"revenue\":" << gameplay.job_delivered_data.revenue;
    json << "},";
    json << "\"tollgatePayment\":" << gameplay.tollgate_payment << ",";
    json << "\"trainData\":{";
    json << "\"payAmount\":" << gameplay.train_data.pay_amount << ",";
    json << "\"sourceName\":\""
         << escape_json(gameplay.train_data.source_name) << "\",";
    json << "\"targetName\":\""
         << escape_json(gameplay.train_data.target_name) << "\"";
    json << "}";
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

const scs_named_value_t *find_named_value(
    const scs_named_value_t *attributes,
    const char *name,
    const scs_value_type_t type
) {
    for (const scs_named_value_t *current = attributes;
         current && current->name;
         ++current) {
        if (current->index != SCS_U32_NIL) continue;
        if (std::string(current->name) != name) continue;
        if (current->value.type == type) return current;
        return nullptr;
    }
    return nullptr;
}

const scs_named_value_t *find_attribute(
    const scs_telemetry_configuration_t &configuration,
    const char *name,
    const scs_value_type_t type
) {
    return find_named_value(configuration.attributes, name, type);
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

std::string get_string_named_value(
    const scs_named_value_t *attributes,
    const char *name
) {
    const scs_named_value_t *attribute =
        find_named_value(attributes, name, SCS_VALUE_TYPE_string);
    if (!attribute || !attribute->value.value_string.value) return "";
    return attribute->value.value_string.value;
}

float get_float_named_value(
    const scs_named_value_t *attributes,
    const char *name
) {
    const scs_named_value_t *attribute =
        find_named_value(attributes, name, SCS_VALUE_TYPE_float);
    return attribute ? attribute->value.value_float.value : 0.0f;
}

bool get_bool_named_value(
    const scs_named_value_t *attributes,
    const char *name
) {
    const scs_named_value_t *attribute =
        find_named_value(attributes, name, SCS_VALUE_TYPE_bool);
    return attribute ? attribute->value.value_bool.value : false;
}

scs_s32_t get_s32_named_value(
    const scs_named_value_t *attributes,
    const char *name
) {
    const scs_named_value_t *attribute =
        find_named_value(attributes, name, SCS_VALUE_TYPE_s32);
    return attribute ? attribute->value.value_s32.value : 0;
}

scs_u32_t get_u32_named_value(
    const scs_named_value_t *attributes,
    const char *name
) {
    const scs_named_value_t *attribute =
        find_named_value(attributes, name, SCS_VALUE_TYPE_u32);
    return attribute ? attribute->value.value_u32.value : 0;
}

scs_s64_t get_s64_named_value(
    const scs_named_value_t *attributes,
    const char *name
) {
    const scs_named_value_t *attribute =
        find_named_value(attributes, name, SCS_VALUE_TYPE_s64);
    return attribute ? attribute->value.value_s64.value : 0;
}

void clear_gameplay_event_details(GameplayEventState &gameplay) {
    gameplay.job_cancelled = false;
    gameplay.job_delivered = false;
    gameplay.fined = false;
    gameplay.tollgate = false;
    gameplay.ferry = false;
    gameplay.train = false;
    gameplay.job_cancelled_penalty = 0;
    gameplay.tollgate_payment = 0;
    gameplay.ferry_data = TransportEventState {};
    gameplay.train_data = TransportEventState {};
    gameplay.fined_data = FinedEventState {};
    gameplay.job_delivered_data = DeliveredEventState {};
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

SCSAPI_VOID telemetry_gameplay_event(
    const scs_event_t,
    const void *event_info,
    const scs_context_t
) {
    const auto *info =
        static_cast<const scs_telemetry_gameplay_event_t *>(event_info);
    if (!info || !info->id) return;

    const std::string event_id(info->id);
    auto &gameplay = telemetry.gameplay;
    clear_gameplay_event_details(gameplay);

    bool handled = true;
    if (event_id == SCS_TELEMETRY_GAMEPLAY_EVENT_job_cancelled) {
        gameplay.job_cancelled = true;
        gameplay.job_cancelled_penalty = get_s64_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_cancel_penalty
        );
    } else if (event_id == SCS_TELEMETRY_GAMEPLAY_EVENT_job_delivered) {
        gameplay.job_delivered = true;
        gameplay.job_delivered_data.revenue = get_s64_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_revenue
        );
        gameplay.job_delivered_data.earned_xp = get_s32_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_earned_xp
        );
        gameplay.job_delivered_data.cargo_damage = get_float_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_cargo_damage
        );
        gameplay.job_delivered_data.distance_km = get_float_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_distance_km
        );
        gameplay.job_delivered_data.delivery_time = get_u32_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_delivery_time
        );
        gameplay.job_delivered_data.auto_parked = get_bool_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_auto_park_used
        );
        gameplay.job_delivered_data.auto_loaded = get_bool_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_auto_load_used
        );
    } else if (event_id == SCS_TELEMETRY_GAMEPLAY_EVENT_player_fined) {
        gameplay.fined = true;
        gameplay.fined_data.pay_amount = get_s64_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_fine_amount
        );
        gameplay.fined_data.offence = get_string_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_fine_offence
        );
    } else if (event_id == SCS_TELEMETRY_GAMEPLAY_EVENT_player_tollgate_paid) {
        gameplay.tollgate = true;
        gameplay.tollgate_payment = get_s64_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_pay_amount
        );
    } else if (event_id == SCS_TELEMETRY_GAMEPLAY_EVENT_player_use_ferry) {
        gameplay.ferry = true;
        gameplay.ferry_data.pay_amount = get_s64_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_pay_amount
        );
        gameplay.ferry_data.source_name = get_string_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_source_name
        );
        gameplay.ferry_data.target_name = get_string_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_target_name
        );
    } else if (event_id == SCS_TELEMETRY_GAMEPLAY_EVENT_player_use_train) {
        gameplay.train = true;
        gameplay.train_data.pay_amount = get_s64_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_pay_amount
        );
        gameplay.train_data.source_name = get_string_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_source_name
        );
        gameplay.train_data.target_name = get_string_named_value(
            info->attributes,
            SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_target_name
        );
    } else {
        handled = false;
    }

    if (!handled) return;

    ++gameplay.serial;
    send_payload(true);
    clear_gameplay_event_details(gameplay);
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
        ) == SCS_RESULT_ok &&
        version_params->register_for_event(
            SCS_TELEMETRY_EVENT_gameplay,
            telemetry_gameplay_event,
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
