import { OpenTelemetryTracerInterface } from './OpenTelemetryTracerInterface';
export declare class OpenTelemetryTracer implements OpenTelemetryTracerInterface {
    private parentSpan;
    private internalSpan;
    startSpan(parentSpanName: string, internalSpanName: string): void;
    stopSpan(): void;
    stopSpanWithError(error: Error): void;
}
