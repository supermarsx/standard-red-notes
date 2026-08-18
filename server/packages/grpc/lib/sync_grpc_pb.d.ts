// package: sync
// file: sync.proto

/* tslint:disable */
/* eslint-disable */

import * as grpc from "@grpc/grpc-js";
import * as sync_pb from "./sync_pb";

interface ISyncingService extends grpc.ServiceDefinition<grpc.UntypedServiceImplementation> {
    syncItems: ISyncingService_IsyncItems;
    getSyncCommandStatus: ISyncingService_IgetSyncCommandStatus;
}

interface ISyncingService_IsyncItems extends grpc.MethodDefinition<sync_pb.SyncRequest, sync_pb.SyncResponse> {
    path: "/sync.Syncing/syncItems";
    requestStream: false;
    responseStream: false;
    requestSerialize: grpc.serialize<sync_pb.SyncRequest>;
    requestDeserialize: grpc.deserialize<sync_pb.SyncRequest>;
    responseSerialize: grpc.serialize<sync_pb.SyncResponse>;
    responseDeserialize: grpc.deserialize<sync_pb.SyncResponse>;
}
interface ISyncingService_IgetSyncCommandStatus extends grpc.MethodDefinition<sync_pb.SyncCommandStatusRequest, sync_pb.SyncCommandStatusResponse> {
    path: "/sync.Syncing/getSyncCommandStatus";
    requestStream: false;
    responseStream: false;
    requestSerialize: grpc.serialize<sync_pb.SyncCommandStatusRequest>;
    requestDeserialize: grpc.deserialize<sync_pb.SyncCommandStatusRequest>;
    responseSerialize: grpc.serialize<sync_pb.SyncCommandStatusResponse>;
    responseDeserialize: grpc.deserialize<sync_pb.SyncCommandStatusResponse>;
}

export const SyncingService: ISyncingService;

export interface ISyncingServer extends grpc.UntypedServiceImplementation {
    syncItems: grpc.handleUnaryCall<sync_pb.SyncRequest, sync_pb.SyncResponse>;
    getSyncCommandStatus: grpc.handleUnaryCall<sync_pb.SyncCommandStatusRequest, sync_pb.SyncCommandStatusResponse>;
}

export interface ISyncingClient {
    syncItems(request: sync_pb.SyncRequest, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncResponse) => void): grpc.ClientUnaryCall;
    syncItems(request: sync_pb.SyncRequest, metadata: grpc.Metadata, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncResponse) => void): grpc.ClientUnaryCall;
    syncItems(request: sync_pb.SyncRequest, metadata: grpc.Metadata, options: Partial<grpc.CallOptions>, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncResponse) => void): grpc.ClientUnaryCall;
    getSyncCommandStatus(request: sync_pb.SyncCommandStatusRequest, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncCommandStatusResponse) => void): grpc.ClientUnaryCall;
    getSyncCommandStatus(request: sync_pb.SyncCommandStatusRequest, metadata: grpc.Metadata, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncCommandStatusResponse) => void): grpc.ClientUnaryCall;
    getSyncCommandStatus(request: sync_pb.SyncCommandStatusRequest, metadata: grpc.Metadata, options: Partial<grpc.CallOptions>, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncCommandStatusResponse) => void): grpc.ClientUnaryCall;
}

export class SyncingClient extends grpc.Client implements ISyncingClient {
    constructor(address: string, credentials: grpc.ChannelCredentials, options?: Partial<grpc.ClientOptions>);
    public syncItems(request: sync_pb.SyncRequest, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncResponse) => void): grpc.ClientUnaryCall;
    public syncItems(request: sync_pb.SyncRequest, metadata: grpc.Metadata, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncResponse) => void): grpc.ClientUnaryCall;
    public syncItems(request: sync_pb.SyncRequest, metadata: grpc.Metadata, options: Partial<grpc.CallOptions>, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncResponse) => void): grpc.ClientUnaryCall;
    public getSyncCommandStatus(request: sync_pb.SyncCommandStatusRequest, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncCommandStatusResponse) => void): grpc.ClientUnaryCall;
    public getSyncCommandStatus(request: sync_pb.SyncCommandStatusRequest, metadata: grpc.Metadata, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncCommandStatusResponse) => void): grpc.ClientUnaryCall;
    public getSyncCommandStatus(request: sync_pb.SyncCommandStatusRequest, metadata: grpc.Metadata, options: Partial<grpc.CallOptions>, callback: (error: grpc.ServiceError | null, response: sync_pb.SyncCommandStatusResponse) => void): grpc.ClientUnaryCall;
}
