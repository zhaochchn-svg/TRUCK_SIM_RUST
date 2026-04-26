<script setup lang="ts">
const { requestWakeLock } = useWakeLock();

onMounted(async () => {
    const { initSettings } = useSettings();
    initSettings();

    if (import.meta.client) {
        // Web Browser Wake Lock (iOS/Chrome)
        // We REMOVE the immediate requestWakeLock() call here because it causes the error
        // 'play() failed because the user didn't interact with the document first'.
        
        const interactionEvents = ['click', 'touchstart', 'scroll'];
        const handleInteraction = async () => {
            try {
                await requestWakeLock();
                // Once acquired via gesture, we can stop listening
                interactionEvents.forEach(event => {
                    document.removeEventListener(event, handleInteraction);
                });
            } catch (e) {
                // Silently handle or log
            }
        };
        
        interactionEvents.forEach(event => {
            document.addEventListener(event, handleInteraction, { once: true, passive: true });
        });
    }
});
</script>

<template>
    <UApp>
        <NuxtLayout>
            <NuxtPage />
        </NuxtLayout>
    </UApp>
</template>

<style lang="scss">
@use "~/assets/scss/global/global";
</style>
