import { loadApiModel, type ApiChildProcessReply } from './extract';

/**
 * The API model's conversion in a process of its own (p553 §2.5), forked by the dev plugin
 * through `extractApiModelInChildProcess`: TypeDoc blocks its thread for seconds at a time and
 * keeps hundreds of MB, which the dev server shouldn't. It writes the cache file and sends back
 * its hash (null when the conversion failed) and TypeDoc's messages.
 */

if (!process.send) throw new Error('The dev plugin forks this (extractApiModelInChildProcess)');

void loadApiModel().then(({ model, ...result }) => {
  const reply: ApiChildProcessReply = { ...result, hash: model?.hash ?? null };
  process.send!(reply, () => process.exit(0));
});
