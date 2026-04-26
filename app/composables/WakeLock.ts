import { ref, onMounted, onUnmounted } from 'vue';
import NoSleep from 'nosleep.js';

export function useWakeLock() {
    // We use any to bypass potential missing type definitions
    const noSleep = ref<any>(null);

    const requestWakeLock = async () => {
        if (!noSleep.value) {
            noSleep.value = new NoSleep();
        }

        try {
            if (!noSleep.value.isEnabled) {
                // NoSleep.js automatically handles using the modern WakeLock API if available,
                // and gracefully falls back to an invisible looping MP4 video for older browsers
                // or restrictive environments like iOS Safari on local HTTP networks.
                await noSleep.value.enable();
                console.log('Wake Lock enabled (Screen will stay awake)');
            }
        } catch (err: any) {
            console.error(`Wake Lock failed: ${err.message}`);
        }
    };

    onMounted(() => {
        // Listeners for visibility changes are handled internally by NoSleep
    });

    onUnmounted(() => {
        if (import.meta.client && noSleep.value) {
            noSleep.value.disable();
            noSleep.value = null;
        }
    });

    return {
        requestWakeLock,
    };
}
