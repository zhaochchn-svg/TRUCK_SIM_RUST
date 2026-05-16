import { ref, watch } from 'vue';

type VoiceState = "idle" | "speaking";
type AnnouncementThreshold = "2km" | "500m" | "action";
type VoicePriority = 0 | 1 | 2 | 3;

interface SpeakOptions {
    priority?: VoicePriority;
    interrupt?: boolean;
    dedupeKey?: string;
    dedupeWindowMs?: number;
    queueGroup?: string;
}

interface QueuedSpeech {
    text: string;
    options: Required<SpeakOptions>;
}

export function useVoiceNavigation() {
    const { activeSettings } = useSettings();
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    const voiceState = ref<VoiceState>("idle");
    const lastAnnouncedManeuverId = ref<number>(-1);
    const lastAnnouncedThreshold = ref<AnnouncementThreshold | null>(null);
    const queuedSpeech = ref<QueuedSpeech | null>(null);

    const availableVoices = ref<SpeechSynthesisVoice[]>([]);
    const recentSpeechTimes = new Map<string, number>();
    let activeSpeechToken = 0;
    let currentSpeechKey: string | null = null;
    let currentSpeechPriority: VoicePriority = 0;

    // Load voices
    const loadVoices = () => {
        if (!synth) return;
        const voices = synth.getVoices();
        if (!voices || voices.length === 0) {
            // In some browsers, voices are loaded asynchronously.
            // If empty, we wait for the onvoiceschanged event.
            return;
        }
        // Filter for Chinese voices, priority to high-quality ones (Microsoft, Google)
        const chineseVoices = voices.filter((v) => v.lang.includes("zh-CN") || v.lang.includes("zh-HK") || v.lang.includes("zh-TW"));
        
        // Sort to put 'Neural' or high quality voices first
        chineseVoices.sort((a, b) => {
            if (a.name.includes("Neural") || a.name.includes("Online")) return -1;
            if (b.name.includes("Neural") || b.name.includes("Online")) return 1;
            return 0;
        });

        availableVoices.value = chineseVoices.length > 0 ? chineseVoices : [voices[0]!];
    };

    if (synth) {
        synth.onvoiceschanged = loadVoices;
        loadVoices();
    }

    const getSelectedVoice = () => {
        if (!synth) return null;
        const voices = synth.getVoices();
        const persona = activeSettings.value.voicePersona || "standard";

        // Strategy: 
        // 1. Try to find the user's previously manually selected voice (if still valid)
        if (activeSettings.value.voiceURI) {
            const preferred = voices.find(v => v.voiceURI === activeSettings.value.voiceURI);
            if (preferred) return preferred;
        }

        // 2. Auto-map based on persona gender/style
        const isMalePersona = ["shenteng", "zhoushen"].includes(persona);
        const isFemalePersona = ["liushishi", "yangzi", "lily_mature", "lily_flirty", "lily_gentle", "lily_strict", "lily_midnight", "lily_sweet"].includes(persona);

        let candidates = voices.filter(v => v.lang.includes("zh-CN") || v.lang.includes("zh-HK") || v.lang.includes("zh-TW"));

        if (isMalePersona) {
            const maleVoices = candidates.filter(v => v.name.includes("Yunxi") || v.name.includes("Kangkang") || v.name.includes("Male") || v.name.includes("Danny"));
            if (maleVoices.length > 0) return maleVoices[0]!;
        } else if (isFemalePersona) {
            const femaleVoices = candidates.filter(v => v.name.includes("Xiaoxiao") || v.name.includes("Xiaoyi") || v.name.includes("Female") || v.name.includes("Ting-Ting"));
            if (femaleVoices.length > 0) return femaleVoices[0]!;
        }

        // 3. Last resort: high quality Chinese voice
        return candidates.sort((a, b) => (a.name.includes("Neural") ? -1 : 1))[0] || voices[0] || null;
    };

    const transformInstruction = (text: string, type: "prep" | "action" | "start" | "arrive") => {
        const persona = activeSettings.value.voicePersona || "standard";
        
        if (persona === "standard") {
            if (type === "prep") return `前方准备 ${text}`;
            if (type === "start") return "准备出发，全程路线已为您规划完成。";
            if (type === "arrive") return "您已到达目的地附近，导航结束。";
            return text;
        }

        if (persona === "shenteng") {
            if (type === "prep") return `哎呀我说，前面准备 ${text} 了啊，咱慢点开，别开沟里去！`;
            if (type === "action") return `就这儿，${text}！别跑偏了，稳着点！`;
            if (type === "start") return "咱这路都给你找好了，妥妥的。出发吧您嘞，别让货等急了！";
            if (type === "arrive") return "哎玛呀终于到了，这一路可把我累够呛。到家了啊，歇会儿吧。";
        }

        if (persona === "liushishi") {
            if (type === "prep") return `亲爱的驾驶员，前方准备 ${text}。我会一直在这里陪伴着你。`;
            if (type === "action") return `现在，请 ${text}。保持这份宁静，我们继续前行。`;
            if (type === "start") return "旅途即将开始，整理好心情，我们一起出发吧。";
            if (type === "arrive") return "我们已经安全到达了。辛苦了，请早点休息，做个好梦。";
        }

        if (persona === "yangzi") {
            if (type === "prep") return `嘿！小猴子提醒你，前方要准备 ${text} 啦，打起精神来！`;
            if (type === "action") return `就是现在，${text}！你是最棒的，加油！`;
            if (type === "start") return "我是领航员杨紫，路都为你算好了，咱们出发去探险吧，出发！";
            if (type === "arrive") return "耶！安全抵达目的地！为你点个大大的赞，快去犒劳下自己！";
        }

        if (persona === "zhoushen") {
            if (type === "prep") return `风吹过的路口，请准备 ${text}。`;
            if (type === "action") return `在这个转角，请 ${text}。`;
            if (type === "start") return "我是周深，很高兴能陪你走这段路。旋律已经响起，让我们出发吧。";
            if (type === "arrive") return "旅程的终点到了。愿这段路上的风景，能成为你心中温暖的力量。";
        }

        if (persona === "lily_mature") {
            if (type === "prep") return `喂，前面该准备 ${text} 了。别光盯着路看，听到了吗？`;
            if (type === "action") return `就是现在，${text}。注意力集中一点，别让我操心。`;
            if (type === "start") return "我是莉莉，路线已经锁定了。别在那磨蹭，现在就踩油门出发。";
            if (type === "arrive") return "目的地到了。表现得还算及格，准时是司机的基本修养。";
        }

        if (persona === "lily_flirty") {
            if (type === "prep") return `亲爱的，前面准备 ${text} 咯。别看我，看路，我会一直陪着你的。`;
            if (type === "action") return `就是现在，${text}。真棒，这种默契我好喜欢，继续保持哦。`;
            if (type === "start") return "我是莉莉，今天就让我陪你在这公路上浪漫一会儿吧。我们，出发咯。";
            if (type === "arrive") return "唔，终于到了呢。这一路有你陪着，人家一点都不觉得累呢。";
        }

        if (persona === "lily_gentle") {
            if (type === "prep") return `前方路口准备 ${text}。路途漫漫，如果累了，记得靠边歇一歇。`;
            if (type === "action") return `请温柔地 ${text}。`;
            if (type === "start") return "我是莉莉，很高兴能为您导航。愿这段旅程不仅是送货，更是享受。";
            if (type === "arrive") return "目的地已平安到达。辛苦了，祝您今后的每一段路都平平安安。";
        }

        if (persona === "lily_strict") {
            if (type === "prep") return `警告：前方 ${text}。严禁超速，时刻保持安全车距！`;
            if (type === "action") return `立即执行：${text}。`;
            if (type === "start") return "莉莉导航任务已确认。请严格遵守交通法规，严禁疲劳驾驶，出发！";
            if (type === "arrive") return "任务达成，抵达目的地。请检查货物完整性，任务结束。";
        }

        if (persona === "lily_midnight") {
            if (type === "prep") return `夜深了，只有路灯陪着我们。前面准备 ${text}，慢一点也没关系的。`;
            if (type === "action") return `${text}。我就在这里，别怕。`;
            if (type === "start") return "我是莉莉。夜晚的路很长，我会一直轻声陪着你，直到终点。";
            if (type === "arrive") return "终于到了，夜色很美。快去休息吧，晚安，做个好梦。";
        }

        if (persona === "lily_sweet") {
            if (type === "prep") return `呜哇！前面要 ${text} 啦，快看快看，那个路口就在那！`;
            if (type === "action") return `就是这里，${text}！嘿嘿，你开车的手法也太帅了吧！`;
            if (type === "start") return "我是莉莉！好开心呀，又能和你一起出去玩啦！抓紧时间出发吧！";
            if (type === "arrive") return "哇！我们到啦！太棒了，你是全世界最厉害的司机，么么哒！";
        }

        return text;
    };

    const playSpeech = (speech: QueuedSpeech) => {
        if (!synth || !activeSettings.value.voiceNavigationEnabled) return;
        const { text, options } = speech;
        const dedupeKey = options.dedupeKey;

        activeSpeechToken += 1;
        const speechToken = activeSpeechToken;
        currentSpeechKey = dedupeKey;
        currentSpeechPriority = options.priority;

        const utterance = new SpeechSynthesisUtterance(text);
        const voice = getSelectedVoice();
        if (voice) utterance.voice = voice;
        
        utterance.volume = activeSettings.value.voiceVolume;
        utterance.rate = 1.05;

        utterance.onstart = () => { voiceState.value = "speaking"; };
        utterance.onend = () => {
            if (speechToken !== activeSpeechToken) return;
            voiceState.value = "idle";
            recentSpeechTimes.set(dedupeKey, Date.now());
            currentSpeechKey = null;
            currentSpeechPriority = 0;

            const nextSpeech = queuedSpeech.value;
            queuedSpeech.value = null;
            if (nextSpeech) {
                playSpeech(nextSpeech);
            }
        };
        utterance.onerror = () => {
            if (speechToken !== activeSpeechToken) return;
            voiceState.value = "idle";
            currentSpeechKey = null;
            currentSpeechPriority = 0;
            queuedSpeech.value = null;
        };

        try {
            synth.speak(utterance);
        } catch (e) {
            console.warn("Speech synthesis failed:", e);
        }
    };

    const speak = (text: string, options: SpeakOptions = {}) => {
        if (!synth || !activeSettings.value.voiceNavigationEnabled) return;

        const normalizedOptions: Required<SpeakOptions> = {
            priority: options.priority ?? 1,
            interrupt: options.interrupt ?? false,
            dedupeKey: options.dedupeKey ?? text,
            dedupeWindowMs: options.dedupeWindowMs ?? 4500,
            queueGroup: options.queueGroup ?? options.dedupeKey ?? text,
        };

        const now = Date.now();
        const lastSpokenAt = recentSpeechTimes.get(normalizedOptions.dedupeKey);
        if (
            lastSpokenAt !== undefined &&
            now - lastSpokenAt < normalizedOptions.dedupeWindowMs
        ) {
            return;
        }

        if (currentSpeechKey === normalizedOptions.dedupeKey) return;
        if (
            queuedSpeech.value &&
            queuedSpeech.value.options.dedupeKey === normalizedOptions.dedupeKey
        ) {
            return;
        }

        const speech: QueuedSpeech = { text, options: normalizedOptions };

        if (voiceState.value === "speaking" || synth.speaking) {
            if (
                normalizedOptions.interrupt &&
                normalizedOptions.priority > currentSpeechPriority
            ) {
                queuedSpeech.value = null;
                try {
                    synth.cancel();
                } catch (e) {}
                playSpeech(speech);
                return;
            }

            if (
                !queuedSpeech.value ||
                queuedSpeech.value.options.queueGroup ===
                    normalizedOptions.queueGroup ||
                normalizedOptions.priority >= queuedSpeech.value.options.priority
            ) {
                queuedSpeech.value = speech;
            }
            return;
        }

        playSpeech(speech);
    };

    const resetVoiceState = () => {
        lastAnnouncedManeuverId.value = -1;
        lastAnnouncedThreshold.value = null;
        if (synth && synth.speaking) {
            try {
                synth.cancel();
            } catch (e) {}
        }
        queuedSpeech.value = null;
        currentSpeechKey = null;
        currentSpeechPriority = 0;
    };

    const clamp = (value: number, min: number, max: number) =>
        Math.min(max, Math.max(min, value));

    const processNavigationUpdate = (
        distanceToTurnKm: number,
        maneuverId: number,
        instructionText: string,
        isDestination: boolean = false,
        speedKph: number = 80,
    ) => {
        if (!activeSettings.value.voiceNavigationEnabled) return;

        const mode = activeSettings.value.voiceMode || "standard";
        const safeSpeedKph = Number.isFinite(speedKph) && speedKph > 5 ? speedKph : 80;
        const actionThresholdKm = clamp((safeSpeedKph * 4) / 3600, 0.045, 0.16);
        const closeThresholdKm = 0.5;
        const farThresholdKm = 2.0;

        // If we moved to a new maneuver, reset the threshold state
        if (lastAnnouncedManeuverId.value !== maneuverId) {
            lastAnnouncedManeuverId.value = maneuverId;
            lastAnnouncedThreshold.value = null;
        }

        if (distanceToTurnKm <= actionThresholdKm && lastAnnouncedThreshold.value !== "action") {
            speak(transformInstruction(instructionText, isDestination ? "arrive" : "action"), {
                priority: 3,
                interrupt: true,
                dedupeKey: `maneuver:${maneuverId}:action`,
                dedupeWindowMs: 6000,
                queueGroup: `maneuver:${maneuverId}`,
            });
            lastAnnouncedThreshold.value = "action";
        } 
        else if (isDestination) {
            return;
        }
        else if (distanceToTurnKm <= closeThresholdKm && distanceToTurnKm > actionThresholdKm && lastAnnouncedThreshold.value !== "500m" && lastAnnouncedThreshold.value !== "action") {
            if (mode === "standard") {
                speak(transformInstruction(`500米后${instructionText}`, "prep"), {
                    priority: 2,
                    dedupeKey: `maneuver:${maneuverId}:500m`,
                    dedupeWindowMs: 8000,
                    queueGroup: `maneuver:${maneuverId}`,
                });
                lastAnnouncedThreshold.value = "500m";
            }
        }
        else if (distanceToTurnKm <= farThresholdKm && distanceToTurnKm > closeThresholdKm && lastAnnouncedThreshold.value !== "2km" && lastAnnouncedThreshold.value !== "500m" && lastAnnouncedThreshold.value !== "action") {
            if (mode === "standard") {
                speak(transformInstruction(`2公里后${instructionText}`, "prep"), {
                    priority: 1,
                    dedupeKey: `maneuver:${maneuverId}:2km`,
                    dedupeWindowMs: 15000,
                    queueGroup: `maneuver:${maneuverId}`,
                });
                lastAnnouncedThreshold.value = "2km";
            }
        }
    };

    const announceStart = () => {
        if (activeSettings.value.voiceNavigationEnabled) {
            speak(transformInstruction("", "start"), {
                priority: 2,
                dedupeKey: "navigation:start",
                dedupeWindowMs: 5000,
                queueGroup: "navigation-lifecycle",
            });
        }
    };

    const announceReroute = () => {
        if (!activeSettings.value.voiceNavigationEnabled) return;
        
        const persona = activeSettings.value.voicePersona || "standard";
        
        let text = "您已偏离路线，正在为您重新规划。";
        
        if (persona === "shenteng") {
            text = "哎呀我说，跑偏了跑偏了啊！正给你找新道儿呢，稳着点！";
        } else if (persona === "liushishi") {
            text = "不小心走错路了呢，别担心，我正在重新为您规划路线。";
        } else if (persona === "yangzi") {
            text = "嘿！跑错路啦！没关系，看我的，重新规划路线中！";
        } else if (persona === "zhoushen") {
            text = "路线已偏离。请稍候，正在为您重新生成路径。";
        } else if (persona === "lily_mature") {
            text = "跑偏了。在原地等一下，我重新给你指路。";
        } else if (persona === "lily_flirty") {
            text = "哎呀，是不是看我看入迷走错路了？我重新给你找条路吧。";
        } else if (persona === "lily_sweet") {
            text = "唔哇，走错路啦！别急别急，莉莉马上给你找条新路！";
        }
        
        speak(text, {
            priority: 3,
            interrupt: true,
            dedupeKey: "navigation:reroute",
            dedupeWindowMs: 8000,
            queueGroup: "navigation-lifecycle",
        });
    };

    const announceOverSpeed = () => {
        if (!activeSettings.value.voiceNavigationEnabled) return;
        speak("您已超速，请注意减速。", {
            priority: 2,
            dedupeKey: "warning:overspeed",
            dedupeWindowMs: 18000,
            queueGroup: "safety",
        });
    };

    return {
        processNavigationUpdate,
        resetVoiceState,
        announceStart,
        announceReroute,
        announceOverSpeed,
        availableVoices,
        speak
    };
}
