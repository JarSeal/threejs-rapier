/// <reference lib="webworker" />

import {
  EngineAPIType,
  PhysicsState,
  PhysicsProtocolType,
  PhysicsUpProtocol,
  WorldAPI,
} from '../core/Physics/PhysicsAPITypes';
import { initPhysicsEngine } from '../core/Physics/PhysicsUtils';

const STATUS_READY_STRING = 'INIT_READY';
let engAPI: EngineAPIType;
let physicsWorldAPI: WorldAPI;

self.addEventListener('message', async (event: MessageEvent<PhysicsUpProtocol>) => {
  const data = event.data;
  const type = data.type;

  switch (type) {
    // @CHORE: type === 'STEP' should be first

    // EngineAPI
    case PhysicsProtocolType.TAKE_SNAPSHOT:
      const snapshot = engAPI.takeSnapshot();
      return sendMessageWithId({ snapshot }, data);
    case PhysicsProtocolType.CREATE_WORLD:
      // CREATE_WORLD ---------------------------
      physicsWorldAPI = engAPI.createWorld(data.gravity, data.opts);
      return sendMessageWithId({ worldCreated: true }, data);
    case PhysicsProtocolType.DELETE_WORLD:
      // DELETE_WORLD
      const createdStatus = engAPI.deleteWorld();
      return sendMessageWithId(createdStatus, data);

    // WorldAPI ---------------------------
    case PhysicsProtocolType.WORLD_GRAVITY:
      // WORLD_GRAVITY
      const gravity = await physicsWorldAPI.gravity(data.gravity);
      return sendMessageWithId({ type, gravity }, data);
    case PhysicsProtocolType.WORLD_FREE:
      // WORLD_FREE
      return physicsWorldAPI.free();

    // All the rest.. ---------------------------
    case PhysicsProtocolType.INIT_PHYSICS:
      // INIT_PHYSICS
      const response = await initPhysics(data.physicsState, data.doNotCreateWorld);
      if (response) physicsWorldAPI = response;
      return sendMessageWithId(
        {
          type,
          worldCreated: !Boolean(data.doNotCreateWorld) && Boolean(response),
        },
        data
      );
    default:
      // ERROR
      sendMessageWithId(
        {
          type: PhysicsProtocolType.ERROR,
          message: `Unknown physics worker (up) protocol type: ${type}`,
        },
        data
      );
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendMessageWithId = (message: any, data: PhysicsUpProtocol) =>
  self.postMessage({ ...message, requestId: data.requestId });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendMessage = (message: any) => self.postMessage(message);

const initPhysics = async (
  physicsState: PhysicsState,
  doNotCreateWorld?: boolean
): Promise<WorldAPI | undefined> => {
  const curEngineKey = physicsState.physicsEngine;
  const { engineAPI } = await initPhysicsEngine(curEngineKey);
  engAPI = engineAPI as EngineAPIType;
  return engAPI.init(physicsState, doNotCreateWorld);
};

// Automatically send STATUS_READY_STRING when this file is executed (handshake)
self.postMessage({ status: STATUS_READY_STRING });
