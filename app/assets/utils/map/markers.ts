import { darkenColor, lightenColor } from "~/assets/utils/shared/colors";

export const generateTruckIcon = (
    baseColor: string,
): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
        // High quality colors
        const strokeColor = "#FFFFFF";
        const fillColor = baseColor;

        const scale = 3;
        const size = 64;

        // Modern Navigation Arrow Design (Google/Apple style)
        // Includes a subtle shadow and a crisp white outline
        const svgString = `
            <svg width="${size * scale}" height="${size * scale}" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                        <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.4"/>
                    </filter>
                </defs>
                <g filter="url(#shadow)">
                    <!-- Outer White Stroke -->
                    <path d="M32 8 L54 52 L32 44 L10 52 Z" fill="${strokeColor}" />
                    <!-- Inner Color Fill -->
                    <path d="M32 13 L49 47 L32 40 L15 47 Z" fill="${fillColor}" />
                </g>
            </svg>
        `;

        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src =
            "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgString);
    });
};

export const generateDestinationIcon = (): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
        const scale = 3;
        const width = 28;
        const height = 40;

        // Classic Google Maps Red Pin
        const svgString = `
        <svg width="${width * scale}" height="${height * scale}" viewBox="-4 -4 36 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <filter id="pin-shadow" x="-30%" y="-30%" width="160%" height="160%">
                    <feDropShadow dx="0" dy="4" stdDeviation="3" flood-color="#000000" flood-opacity="0.25"/>
                </filter>
            </defs>
            <g filter="url(#pin-shadow)">
                <!-- Google Maps Red -->
                <path d="M14 0 C6.268 0 0 6.268 0 14 C0 24.5 14 40 14 40 C14 40 28 24.5 28 14 C28 6.268 21.732 0 14 0 Z" fill="#EA4335" />
                <!-- Inner White Circle -->
                <circle cx="14" cy="14" r="5" fill="#FFFFFF" />
            </g>
        </svg>`;

        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src =
            "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgString);
    });
};
