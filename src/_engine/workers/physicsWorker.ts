/// <reference lib="webworker" />

export type PhysicsMessageUpEvent = string;
export type PhysicsMessageDownEvent = string;

self.onmessage = (event: MessageEvent<PhysicsMessageUpEvent>) => {
  console.log('Worker received:', event.data);

  const result = `Processed: ${event.data}`;

  self.postMessage(result);
};
