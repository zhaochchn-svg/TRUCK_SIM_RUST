<script lang="ts" setup>
import type { DirectionStep } from "~/assets/utils/routing/directions";
import type { ActiveRouteGuidance } from "~/composables/RouteController";

const { activeSettings } = useSettings();
type DisplayTurn = Pick<DirectionStep, "id" | "type" | "exitCount">;

const props = defineProps<{
    guidance: ActiveRouteGuidance | null;
}>();

const primaryTurn = computed<DisplayTurn>(() => {
    const guidance = props.guidance;
    if (!guidance?.current) {
        return { id: -1, type: "straight" as const };
    }

    if (guidance.phase === "cruise" && guidance.current.type !== "destination") {
        return { id: -1, type: "straight" as const };
    }

    return guidance.current;
});

const nextTurn = computed<DisplayTurn | null>(() => {
    const guidance = props.guidance;
    if (!guidance?.current) return null;
    if (guidance.phase === "cruise" && guidance.current.type !== "destination") {
        return guidance.current;
    }
    return guidance.following;
});

const { kmToUserUnits, distanceUnit } = useUnitConversion();

const routeDistanceConverted = computed(() =>
    kmToUserUnits(props.guidance?.distanceKm ?? 0),
);

const currentInstruction = computed(() => {
    return props.guidance?.instruction ?? "沿路线行驶";
});
</script>

<template>
    <div class="card">
        <div class="primary-turn">
            <DirectionIcon
                :type="primaryTurn.type"
                :exit-count="
                    primaryTurn.type === 'roundabout'
                        ? primaryTurn.exitCount
                        : undefined
                "
                active
                :active-color="activeSettings.routeColor"
            />
        </div>
        <div class="turn-info">
            <p class="distance">{{ routeDistanceConverted }} <span>{{ distanceUnit }}</span></p>
            <p class="instruction">{{ currentInstruction }}</p>
        </div>
        <div v-if="nextTurn" class="next-turn">
            <span>随后</span>
            <DirectionIcon
                :type="nextTurn.type"
                :exit-count="
                    nextTurn.type === 'roundabout' ? nextTurn.exitCount : undefined
                "
                :active-color="activeSettings.routeColor"
            />
        </div>
    </div>
</template>

<style scoped src="~/assets/scss/scoped/navigation/maneuverCard.scss"></style>
