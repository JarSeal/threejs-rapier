// /// <reference lib="webworker" />

// import { LoopState } from '../core/MainLoop';
// import {
//   EngineAPIType,
//   PhysicsState,
//   PhysicsProtocolType,
//   PhysicsUpProtocol,
//   WorldAPI,
// } from '../core/Physics/PhysicsAPITypes';
// import { initPhysicsEngine } from '../core/Physics/PhysicsUtils';
// import { physicsSwitchColl } from './physics/physicsSwitchColl';
// import { physicsSwitchRigid } from './physics/physicsSwitchRigid';
// import { physicsSwitchWorld } from './physics/physicsSwitchWorld';

// const STATUS_READY_STRING = 'INIT_READY';
// let engAPI: EngineAPIType;
// let physicsWorldAPI: WorldAPI;

// self.addEventListener('message', async (event: MessageEvent<PhysicsUpProtocol>) => {
//   const data = event.data;
//   const type = data.type;

//   // @CHORE: implement stepping
//   // if (type === PhysicsProtocolType.STEP) {
//   //
//   // }

//   try {
//     const subType = getSubType(type);
//     if (subType) {
//       switch (subType) {
//         case 'WORLD':
//           // WORLD
//           return await physicsSwitchWorld(data, physicsWorldAPI, sendMessage);
//         case 'RIGID':
//           // RIGID BODY
//           return physicsSwitchRigid(data, physicsWorldAPI, engAPI, sendMessage);
//         case 'COLL':
//           // COLLIDER
//           return physicsSwitchColl(data, physicsWorldAPI, engAPI, sendMessage);
//         default:
//           sendMessage(
//             {
//               type: PhysicsProtocolType.ERROR,
//               message: `Unknown physics worker (up) protocol sub type: ${subType} (type: ${type})`,
//             },
//             data,
//             true
//           );
//       }
//     }

//     switch (type) {
//       // EngineAPI
//       case PhysicsProtocolType.TAKE_SNAPSHOT:
//         // TAKE_SNAPSHOT
//         const snapshot = engAPI.takeSnapshot();
//         return sendMessage({ snapshot }, data);
//       case PhysicsProtocolType.RESTORE_SNAPSHOT:
//         // RESTORE_SNAPSHOT
//         physicsWorldAPI = engAPI.restoreSnapshot(data.snapshot);
//         return sendMessage({ worldCreated: true }, data);
//       case PhysicsProtocolType.CREATE_WORLD:
//         // CREATE_WORLD
//         physicsWorldAPI = engAPI.createWorld(data.gravity, data.opts);
//         return sendMessage({ worldCreated: true }, data);
//       case PhysicsProtocolType.DELETE_WORLD:
//         // DELETE_WORLD
//         const createdStatus = engAPI.deleteWorld();
//         return sendMessage(createdStatus, data);
//       case PhysicsProtocolType.INIT_PHYSICS:
//         // INIT_PHYSICS
//         const response = await initPhysics(
//           data.physicsState,
//           data.isDebugEnvironment,
//           data.loopState,
//           data.doNotCreateWorld
//         );
//         if (response) physicsWorldAPI = response;
//         return sendMessage(
//           {
//             type,
//             worldCreated: !Boolean(data.doNotCreateWorld) && Boolean(response),
//           },
//           data
//         );

//       // ERROR
//       default:
//         sendMessage(
//           {
//             type: PhysicsProtocolType.ERROR,
//             message: `Unknown physics worker (up) protocol type: ${type}`,
//           },
//           data
//         );
//     }
//   } catch (err) {
//     let message: string | undefined = undefined;
//     if (typeof err === 'string') {
//       message = err.toUpperCase();
//     } else if (err instanceof Error) {
//       message = err.message;
//     } else {
//       const e = err as { message: string };
//       message = e?.message ? String(e.message) : undefined;
//     }
//     if (!message) {
//       message = `Unknown physics worker error. Protocol type: ${type}, request id: ${data.requestId}.`;
//     }
//     sendMessage(
//       {
//         type: PhysicsProtocolType.ERROR,
//         message,
//         requestId: data.requestId,
//       },
//       data
//     );
//   }
// });

// // eslint-disable-next-line @typescript-eslint/no-explicit-any
// const sendMessage = (message: any, data: PhysicsUpProtocol, isError?: boolean) => {
//   // If the up message has 'isOneWay: true', don't reply
//   if (data.isOneWay && isError) return;
//   const requestId = data.requestId;
//   if (!requestId) return sendMessageSimple(message);
//   return self.postMessage({ ...message, requestId });
// };

// // eslint-disable-next-line @typescript-eslint/no-explicit-any
// const sendMessageSimple = (message: any) => self.postMessage(message);

// const initPhysics = async (
//   physicsState: PhysicsState,
//   isDebugEnvironment: boolean,
//   loopState: LoopState,
//   doNotCreateWorld?: boolean
// ): Promise<WorldAPI | undefined> => {
//   const curEngineKey = physicsState.physicsEngine;
//   const { engineAPI } = await initPhysicsEngine(curEngineKey);
//   engAPI = engineAPI as EngineAPIType;
//   return engAPI.init(physicsState, isDebugEnvironment, loopState, doNotCreateWorld);
// };

// const getSubType = (type: PhysicsProtocolType) => {
//   const numberOfType = Number(type);
//   if (numberOfType >= 200 && numberOfType < 400) {
//     return 'WORLD';
//   }
//   if (numberOfType >= 400 && numberOfType < 600) {
//     return 'RIGID';
//   }
//   if (numberOfType >= 600 && numberOfType < 800) {
//     return 'COLL';
//   }
//   return null;
// };

// // Automatically send STATUS_READY_STRING when this file is executed (handshake)
// self.postMessage({ status: STATUS_READY_STRING });
