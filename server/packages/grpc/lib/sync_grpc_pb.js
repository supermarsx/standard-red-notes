// GENERATED CODE -- DO NOT EDIT!

'use strict';
var grpc = require('@grpc/grpc-js');
var sync_pb = require('./sync_pb.js');

function serialize_sync_SyncCommandStatusRequest(arg) {
  if (!(arg instanceof sync_pb.SyncCommandStatusRequest)) {
    throw new Error('Expected argument of type sync.SyncCommandStatusRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_sync_SyncCommandStatusRequest(buffer_arg) {
  return sync_pb.SyncCommandStatusRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_sync_SyncCommandStatusResponse(arg) {
  if (!(arg instanceof sync_pb.SyncCommandStatusResponse)) {
    throw new Error('Expected argument of type sync.SyncCommandStatusResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_sync_SyncCommandStatusResponse(buffer_arg) {
  return sync_pb.SyncCommandStatusResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_sync_SyncRequest(arg) {
  if (!(arg instanceof sync_pb.SyncRequest)) {
    throw new Error('Expected argument of type sync.SyncRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_sync_SyncRequest(buffer_arg) {
  return sync_pb.SyncRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_sync_SyncResponse(arg) {
  if (!(arg instanceof sync_pb.SyncResponse)) {
    throw new Error('Expected argument of type sync.SyncResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_sync_SyncResponse(buffer_arg) {
  return sync_pb.SyncResponse.deserializeBinary(new Uint8Array(buffer_arg));
}


var SyncingService = exports.SyncingService = {
  syncItems: {
    path: '/sync.Syncing/syncItems',
    requestStream: false,
    responseStream: false,
    requestType: sync_pb.SyncRequest,
    responseType: sync_pb.SyncResponse,
    requestSerialize: serialize_sync_SyncRequest,
    requestDeserialize: deserialize_sync_SyncRequest,
    responseSerialize: serialize_sync_SyncResponse,
    responseDeserialize: deserialize_sync_SyncResponse,
  },
  getSyncCommandStatus: {
    path: '/sync.Syncing/getSyncCommandStatus',
    requestStream: false,
    responseStream: false,
    requestType: sync_pb.SyncCommandStatusRequest,
    responseType: sync_pb.SyncCommandStatusResponse,
    requestSerialize: serialize_sync_SyncCommandStatusRequest,
    requestDeserialize: deserialize_sync_SyncCommandStatusRequest,
    responseSerialize: serialize_sync_SyncCommandStatusResponse,
    responseDeserialize: deserialize_sync_SyncCommandStatusResponse,
  },
};

exports.SyncingClient = grpc.makeGenericClientConstructor(SyncingService, 'Syncing');
