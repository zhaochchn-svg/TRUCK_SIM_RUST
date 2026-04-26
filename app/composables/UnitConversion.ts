export const useUnitConversion = () => {
    const { activeSettings } = useSettings();

    const roundDisplayValue = (value: number) => {
        if (!Number.isFinite(value)) return 0;
        if (Math.abs(value) >= 10) return Math.round(value);
        return Math.round(value * 10) / 10;
    };

    const kmToUserUnits = (value: number | null | undefined) => {
        if (value == null) return 0;
        const converted =
            activeSettings.value.units === "metric" ? value : value * 0.621371;
        return roundDisplayValue(converted);
    };

    const speedToUserUnits = (value: number | null | undefined) => {
        if (value == null) return 0;
        const converted =
            activeSettings.value.units === "metric" ? value : value * 0.621371;
        return Math.round(converted);
    };

    const literToUserUnits = (value: number | null | undefined) => {
        if (value == null) return 0;
        const converted =
            activeSettings.value.units === "metric" ? value : value * 0.264172;
        return Math.round(converted);
    };

    const speedUnit = computed(() =>
        activeSettings.value.units === "metric" ? "km/h" : "mph",
    );

    const distanceUnit = computed(() =>
        activeSettings.value.units === "metric" ? "km" : "mi",
    );

    const fuelUnit = computed(() =>
        activeSettings.value.units === "metric" ? "L" : "gal",
    );

    return {
        kmToUserUnits,
        speedToUserUnits,
        literToUserUnits,
        speedUnit,
        distanceUnit,
        fuelUnit,
    };
};
