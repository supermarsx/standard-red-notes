"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenTelemetryTracer = void 0;
const OpenTelemetryApi = require("@opentelemetry/api");
class OpenTelemetryTracer {
    parentSpan;
    internalSpan;
    startSpan(parentSpanName, internalSpanName) {
        const tracer = OpenTelemetryApi.trace.getTracer(`${parentSpanName}-handler`);
        this.parentSpan = tracer.startSpan(parentSpanName, { kind: OpenTelemetryApi.SpanKind.CONSUMER });
        const ctx = OpenTelemetryApi.trace.setSpan(OpenTelemetryApi.context.active(), this.parentSpan);
        this.internalSpan = tracer.startSpan(internalSpanName, { kind: OpenTelemetryApi.SpanKind.INTERNAL }, ctx);
    }
    stopSpan() {
        if (this.internalSpan) {
            this.internalSpan.end();
            this.internalSpan = undefined;
        }
        if (this.parentSpan) {
            this.parentSpan.end();
            this.parentSpan = undefined;
        }
    }
    stopSpanWithError(error) {
        if (this.internalSpan) {
            this.internalSpan.recordException(error);
            this.internalSpan.end();
            this.internalSpan = undefined;
        }
        if (this.parentSpan) {
            this.parentSpan.end();
            this.parentSpan = undefined;
        }
    }
}
exports.OpenTelemetryTracer = OpenTelemetryTracer;
