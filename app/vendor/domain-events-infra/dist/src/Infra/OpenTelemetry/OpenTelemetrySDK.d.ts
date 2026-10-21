import { OpenTelemetrySDKInterface } from './OpenTelemetrySDKInterface';
export declare class OpenTelemetrySDK implements OpenTelemetrySDKInterface {
    private options;
    private sdk;
    constructor(options: {
        serviceName: string;
        spanRatio?: number;
        metricExportIntervalMillis?: number;
    });
    build(): void;
    start(): void;
    shutdown(): Promise<void>;
}
