/** draco3dgltf ships no typings: the two factories gltf-transform's `draco()` needs. */
declare module 'draco3dgltf' {
  const draco3d: {
    createDecoderModule: (opts?: object) => Promise<unknown>;
    createEncoderModule: (opts?: object) => Promise<unknown>;
  };
  export default draco3d;
}
