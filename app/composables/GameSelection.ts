export const useGameSelection = () => {
    const { settings, updateGlobal } = useSettings();

    // Use a computed property directly tied to settings to ensure consistency
    const selectedGame = computed({
        get: () => settings.value.selectedGame,
        set: (val) => updateGlobal("selectedGame", val)
    });

    const selectGame = (game: "ats" | "ets2" | null) => {
        selectedGame.value = game;
    };

    const commitSelection = () => {
        // Selection is now committed immediately via the setter
        // This method is kept for backward compatibility with chooseGame.vue
    };

    return { selectedGame, selectGame, commitSelection };
};
