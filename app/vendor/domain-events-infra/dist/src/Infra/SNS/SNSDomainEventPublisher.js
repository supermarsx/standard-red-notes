"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SNSDomainEventPublisher = void 0;
const zlib = require("zlib");
const client_sns_1 = require("@aws-sdk/client-sns");
class SNSDomainEventPublisher {
    snsClient;
    topicArn;
    constructor(snsClient, topicArn) {
        this.snsClient = snsClient;
        this.topicArn = topicArn;
    }
    async publish(event) {
        const message = {
            TopicArn: this.topicArn,
            MessageAttributes: {
                event: {
                    DataType: 'String',
                    StringValue: event.type,
                },
                compression: {
                    DataType: 'String',
                    StringValue: 'true',
                },
                origin: {
                    DataType: 'String',
                    StringValue: event.meta.origin,
                },
            },
            Message: zlib.deflateSync(JSON.stringify(event)).toString('base64'),
        };
        if (event.meta.target !== undefined) {
            ;
            message.MessageAttributes.target = {
                DataType: 'String',
                StringValue: event.meta.target,
            };
        }
        const command = new client_sns_1.PublishCommand(message);
        await this.snsClient.send(command);
    }
}
exports.SNSDomainEventPublisher = SNSDomainEventPublisher;
