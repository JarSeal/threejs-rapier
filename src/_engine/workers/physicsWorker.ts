/// <reference lib="webworker" />

export type PhysicsMessageUpEvent = { type: string };
export type PhysicsMessageDownEvent = { type: string };

// Automatically send 'INIT_READY' when this file is executed
self.postMessage({ status: 'INIT_READY' });

self.addEventListener('message', (event: MessageEvent<PhysicsMessageUpEvent>) => {
  console.log('Worker received:', event.data);

  const result = `Processed: ${event.data.type}`;

  self.postMessage(result);
});
