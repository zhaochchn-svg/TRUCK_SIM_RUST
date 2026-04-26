<script lang="ts" setup>
import type { DirectionStep } from "~/assets/utils/routing/directions";

const { activeSettings } = useSettings();

const props = defineProps<{
    upcomingTurns: DirectionStep[];
    distanceToNextTurn: number;
    nextInstruction: string;
    active?: boolean;
    exit?: number | undefined;
}>();

const displayTurns = computed(() => {
    // If we have at least one upcoming maneuver
    if (props.upcomingTurns.length > 1) {
        const nextTurn = props.upcomingTurns[1];
        // If the turn is far away, we show a 'straight' icon as current action
        if (props.distanceToNextTurn > activeSettings.value.maneuverDistance) {
            return [
                { id: -1, type: 'straight' as const }, // Current: Straight
                nextTurn // Next: The actual turn
            ];
        }
        // If close, show the actual turn as primary and the one after as secondary
        return props.upcomingTurns.slice(1, 3);
    }
    return props.upcomingTurns;
});

const { kmToUserUnits, distanceUnit } = useUnitConversion();

const routeDistanceConverted = computed(() =>
    kmToUserUnits(props.distanceToNextTurn),
);

const currentInstruction = computed(() => {
    if (props.upcomingTurns.length === 0) return "沿路线行驶";
    
    // If we only have one step left and it's the destination
    if (props.upcomingTurns.length === 1) {
        return props.upcomingTurns[0].text;
    }
    
    const nextTurn = props.upcomingTurns[1];
    if (props.distanceToNextTurn > activeSettings.value.maneuverDistance) {
        return "请直行";
    }
    return nextTurn.text;
});
</script>

<template>
    <div class="card">
        <div class="turn-directions">
            <DirectionIcon
                v-for="(turn, index) in displayTurns"
                :key="turn.id"
                :type="turn.type"
                :exit-count="
                    turn.type === 'roundabout' ? turn.exitCount : undefined
                "
                :active="index === 0"
                :active-color="activeSettings.routeColor"
            />
        </div>
        <div class="turn-info">
            <p>{{ routeDistanceConverted }} {{ distanceUnit }}</p>
            <p>{{ currentInstruction }}</p>
        </div>
    </div>
</template>

<style scoped src="~/assets/scss/scoped/navigation/maneuverCard.scss"></style>
