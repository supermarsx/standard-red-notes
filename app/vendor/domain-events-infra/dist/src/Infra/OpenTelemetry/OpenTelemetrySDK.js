"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenTelemetrySDK = void 0;
const OpenTelemetrySDKNode = require("@opentelemetry/sdk-node");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
const exporter_trace_otlp_grpc_1 = require("@opentelemetry/exporter-trace-otlp-grpc");
const id_generator_aws_xray_1 = require("@opentelemetry/id-generator-aws-xray");
const AwsResourceDetectors = require("@opentelemetry/resource-detector-aws");
const opentelemetry_instrumentation_typeorm_1 = require("opentelemetry-instrumentation-typeorm");
const propagator_aws_xray_1 = require("@opentelemetry/propagator-aws-xray");
const instrumentation_http_1 = require("@opentelemetry/instrumentation-http");
const instrumentation_aws_sdk_1 = require("@opentelemetry/instrumentation-aws-sdk");
const exporter_metrics_otlp_proto_1 = require("@opentelemetry/exporter-metrics-otlp-proto");
const instrumentation_winston_1 = require("@opentelemetry/instrumentation-winston");
const instrumentation_ioredis_1 = require("@opentelemetry/instrumentation-ioredis");
const instrumentation_express_1 = require("@opentelemetry/instrumentation-express");
const instrumentation_grpc_1 = require("@opentelemetry/instrumentation-grpc");
class OpenTelemetrySDK {
    options;
    constructor(options) {
        this.options = options;
        this.build();
    }
    build() {
        const otResource = OpenTelemetrySDKNode.resources.Resource.default().merge(new OpenTelemetrySDKNode.resources.Resource({
            [semantic_conventions_1.SemanticResourceAttributes.SERVICE_NAME]: this.options.serviceName,
        }));
        const traceExporter = new exporter_trace_otlp_grpc_1.OTLPTraceExporter();
        const spanProcessor = new OpenTelemetrySDKNode.tracing.BatchSpanProcessor(traceExporter);
        const metricExportIntervalMillis = this.options.metricExportIntervalMillis ?? 300_000;
        const metricReader = new OpenTelemetrySDKNode.metrics.PeriodicExportingMetricReader({
            exportIntervalMillis: metricExportIntervalMillis,
            exporter: new exporter_metrics_otlp_proto_1.OTLPMetricExporter(),
        });
        const serviceName = this.options.serviceName;
        const winstonInstrumentation = new instrumentation_winston_1.WinstonInstrumentation({
            logHook: (_span, record) => {
                record['resource.service.name'] = serviceName;
            },
        });
        const ratio = this.options.spanRatio ?? 0.1;
        this.sdk = new OpenTelemetrySDKNode.NodeSDK({
            sampler: new OpenTelemetrySDKNode.tracing.TraceIdRatioBasedSampler(ratio),
            textMapPropagator: new propagator_aws_xray_1.AWSXRayPropagator(),
            instrumentations: [
                new instrumentation_http_1.HttpInstrumentation({
                    ignoreIncomingRequestHook: (request) => {
                        const isHealthCheckUrl = !!request.url?.match(/\/healthcheck/);
                        return isHealthCheckUrl;
                    },
                    startIncomingSpanHook: (_request) => {
                        return {
                            [semantic_conventions_1.SemanticAttributes.HTTP_CLIENT_IP]: undefined,
                        };
                    },
                }),
                new instrumentation_express_1.ExpressInstrumentation(),
                new instrumentation_aws_sdk_1.AwsInstrumentation({
                    suppressInternalInstrumentation: true,
                    sqsExtractContextPropagationFromPayload: true,
                }),
                new opentelemetry_instrumentation_typeorm_1.TypeormInstrumentation({
                    collectParameters: false,
                    suppressInternalInstrumentation: true,
                }),
                winstonInstrumentation,
                new instrumentation_ioredis_1.IORedisInstrumentation(),
                new instrumentation_grpc_1.GrpcInstrumentation(),
            ],
            metricReader: metricReader,
            resource: otResource,
            spanProcessor: spanProcessor,
            traceExporter: traceExporter,
            idGenerator: new id_generator_aws_xray_1.AWSXRayIdGenerator(),
            autoDetectResources: true,
            resourceDetectors: [AwsResourceDetectors.awsEcsDetector],
        });
    }
    start() {
        this.sdk.start();
    }
    async shutdown() {
        await this.sdk.shutdown();
    }
}
exports.OpenTelemetrySDK = OpenTelemetrySDK;
